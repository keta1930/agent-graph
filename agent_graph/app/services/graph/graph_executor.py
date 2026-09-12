import logging
import asyncio
from contextlib import aclosing, asynccontextmanager
from anyio import move_on_after
from fastapi import HTTPException
from agent_graph.app.services.conversation.execution_guard import get_execution_conversation
from agent_graph.app.utils.sse_helper import SSEHelper
from agent_graph.app.services.graph.message_creator import MessageCreator
from agent_graph.app.services.tool_execution import ToolExecutor
from agent_graph.app.services.graph.node_executor_core import NodeExecutorCore

logger = logging.getLogger(__name__)


class GraphExecutor:
    """流式与后台共用的顺序执行、恢复和 handoffs 驱动器。"""

    def __init__(self, conversation_manager, mcp_service):
        self.prepare_config = None
        self.conversation_manager = conversation_manager
        self.message_creator = MessageCreator(conversation_manager)
        self.tool_executor = ToolExecutor(mcp_service)
        self.node_executor_core = NodeExecutorCore(conversation_manager, self.tool_executor, self.message_creator)

    @asynccontextmanager
    async def execution(self, conversation_id, *, reserved=False):
        """会话清理先于交还写入权，断开时尽力保存 checkpoint。"""
        manager = self.conversation_manager
        async with manager.runtime.execution(conversation_id, reserved=reserved):
            conversation = await manager.get_conversation(conversation_id)
            if not conversation:
                raise RuntimeError("会话不存在")
            conversation.update(completed=False, execution_status="running", execution_error=None)
            try:
                yield
            except (asyncio.CancelledError, GeneratorExit):
                conversation.update(completed=False, execution_status="interrupted")
                raise
            except Exception as exc:
                conversation.update(completed=False, execution_status="failed", execution_error=str(exc))
                raise
            finally:
                with move_on_after(3, shield=True) as cleanup:
                    saved = await manager.update_conversation_file(conversation_id)
                    if saved:
                        manager.release_conversation(conversation_id)
                    else:
                        logger.error("图执行退出时保存会话失败: %s", conversation_id)
                if cleanup.cancel_called:
                    logger.error("图执行退出清理超时: %s", conversation_id)

    async def execute_graph_stream(self, graph_name, flattened_config, input_text, model_service=None, user_id="default_user"):
        """创建会话并以既有 SSE 协议返回执行结果。"""
        self.conversation_manager.runtime.ensure_open()
        conversation_id = await self.conversation_manager.create_conversation_with_config(graph_name, flattened_config, user_id)
        try:
            async with self.execution(conversation_id):
                yield SSEHelper.send_json({"type": "conversation_created", "conversation_id": conversation_id})
                yield SSEHelper.send_node_start("start", 0)
                await self.message_creator.record_user_input(conversation_id, input_text)
                yield SSEHelper.send_node_end("start")
                async with aclosing(self._execute_graph_by_level_sequential_stream(conversation_id, model_service, user_id)) as stream:
                    async for chunk in stream:
                        yield chunk
                result = await self.finish(conversation_id)
            yield SSEHelper.send_graph_complete(result["final_output"], result["execution_chain"])
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("执行图失败: %s", conversation_id)
            yield SSEHelper.send_error(str(exc))

    async def continue_conversation_stream(self, conversation_id, input_text=None, model_service=None, continue_from_checkpoint=False, *, user_id):
        """授权后继续会话，成功终态仅在全部节点完成后发送。"""
        await get_execution_conversation(conversation_id, user_id, "graph")
        try:
            async with self.execution(conversation_id):
                async with aclosing(self.run_conversation(conversation_id, input_text, continue_from_checkpoint, user_id, yield_sse=True, model_service=model_service)) as stream:
                    async for chunk in stream:
                        yield chunk
                result = await self.finish(conversation_id)
            yield SSEHelper.send_graph_complete(result["final_output"], result["execution_chain"])
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("继续图会话失败: %s", conversation_id)
            yield SSEHelper.send_error(str(exc))

    async def run_conversation(self, conversation_id, input_text, checkpoint, user_id, *, yield_sse, model_service=None):
        """准备新一轮或恢复游标，两种传输方式消费同一驱动器。"""
        conversation = await self.conversation_manager.get_conversation(conversation_id)
        if not conversation:
            raise RuntimeError("会话不存在")
        if input_text and not checkpoint:
            if self.prepare_config is not None:
                conversation["graph_config"] = await self.prepare_config(conversation.get("graph_config", {}), user_id)
            rounds = [r for r in conversation.get("rounds", []) if r.get("node_name") == "start"]
            conversation.update(rounds=rounds, _current_round=len(rounds), execution_chain=[], handoffs_status={})
            await self.message_creator.record_user_input(conversation_id, input_text)
            plan = {"action": "start"}
        else:
            plan = await self.conversation_manager.check_execution_resumption_point(conversation_id)
        action = plan["action"]
        if action == "error":
            raise RuntimeError(plan["message"])
        if action == "start":
            iterator = self._execute_graph_by_level_sequential_stream(conversation_id, model_service, user_id) if yield_sse else self.run_nodes(conversation_id, user_id, yield_sse=False)
        elif action == "continue":
            if yield_sse and not plan.get("next_node"):
                iterator = self._continue_graph_by_level_sequential_stream(conversation_id, plan["from_level"], None, model_service, user_id)
            else:
                iterator = self.run_nodes(conversation_id, user_id, yield_sse=yield_sse, start_level=plan["from_level"], next_node=plan.get("next_node"))
        elif action in {"handoffs_continue", "handoffs_wait"}:
            target = plan.get("target_node") or plan.get("current_node")
            iterator = self.run_nodes(conversation_id, user_id, yield_sse=yield_sse, restart_node=target)
        else:
            raise RuntimeError(f"未知恢复动作: {action}")
        async with aclosing(iterator) as stream:
            async for chunk in stream:
                yield chunk

    async def run_nodes(self, conversation_id, user_id, *, yield_sse, start_level=0, next_node=None, restart_node=None):
        """顺序推进层内节点，handoffs 使用游标跳转避免递归堆积。"""
        conversation = await self.conversation_manager.get_conversation(conversation_id)
        config = conversation["graph_config"]
        nodes = sorted(config.get("nodes", []), key=lambda node: node.get("level", 0))
        positions = {node["name"]: index for index, node in enumerate(nodes)}
        cursor = next((i for i, node in enumerate(nodes) if node.get("level", 0) >= start_level), len(nodes))
        jump = restart_node is not None
        target = restart_node or next_node
        if target:
            if target not in positions:
                raise RuntimeError(f"找不到目标节点: {target}")
            cursor = positions[target]
        while cursor < len(nodes):
            node = nodes[cursor]
            if yield_sse:
                yield SSEHelper.send_node_start(node["name"], node.get("level", 0))
            result = None
            async with aclosing(self.node_executor_core.execute_node(node, conversation_id, yield_sse=yield_sse, user_id=user_id)) as stream:
                async for item in stream:
                    if isinstance(item, str):
                        if yield_sse:
                            yield item
                    else:
                        result = item
            if result is None or not result.get("success"):
                raise RuntimeError(f"节点 '{node['name']}' 未完成")
            if yield_sse:
                yield SSEHelper.send_node_end(node["name"])
            selected = result.get("selected_node") if result.get("has_handoffs") else None
            if selected:
                if selected not in positions:
                    raise RuntimeError(f"找不到handoffs目标节点: {selected}")
                cursor = positions[selected]
                jump = True
            elif jump:
                # handoffs 选中节点完成后沿用下一层语义，普通恢复保留同层后继。
                level = node.get("level", 0)
                cursor = next((i for i in range(cursor + 1, len(nodes)) if nodes[i].get("level", 0) > level), len(nodes))
                jump = False
            else:
                cursor += 1

    async def _execute_graph_by_level_sequential_stream(self, conversation_id, model_service=None, user_id="default_user"):
        async with aclosing(self.run_nodes(conversation_id, user_id, yield_sse=True)) as stream:
            async for item in stream:
                yield item

    async def _continue_graph_by_level_sequential_stream(self, conversation_id, start_level, restart_node, model_service=None, user_id="default_user"):
        async with aclosing(self.run_nodes(conversation_id, user_id, yield_sse=True, start_level=start_level, restart_node=restart_node)) as stream:
            async for item in stream:
                yield item

    async def finish(self, conversation_id):
        """必要状态保存成功后才构造完成结果。"""
        conversation = await self.conversation_manager.get_conversation(conversation_id)
        output = await self.conversation_manager._get_final_output(conversation)
        conversation.update(completed=True, execution_status="completed", execution_error=None)
        if not await self.conversation_manager.update_conversation_file(conversation_id):
            raise RuntimeError("保存图执行结果失败")
        return {"final_output": output, "execution_chain": conversation.get("execution_chain", [])}
