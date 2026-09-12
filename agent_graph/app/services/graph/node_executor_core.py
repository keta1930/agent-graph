"""节点准备、Agent 调用与执行结果持久化。"""
import copy
from contextlib import aclosing

from agent_graph.app.services.agent.agent_stream_executor import AgentStreamExecutor
from agent_graph.app.services.graph.handoffs_manager import HandoffsManager
from agent_graph.app.services.graph.execution_chain_manager import ExecutionChainManager
from agent_graph.app.infrastructure.database.mongodb import mongodb_client


class NodeExecutorCore:
    """流式与后台共享节点业务逻辑，异常交给执行边界处理。"""

    def __init__(self, conversation_manager, tool_executor, message_creator):
        self.conversation_manager = conversation_manager
        self.tool_executor = tool_executor
        self.message_creator = message_creator
        self.agent_stream_executor = AgentStreamExecutor()

    async def execute_node(self, node, conversation_id, yield_sse=False, user_id="default_user"):
        """准备有效配置、消费 Agent 流、保存成功节点并返回跳转信息。"""
        conversation = await self.conversation_manager.get_conversation(conversation_id)
        if not conversation:
            raise RuntimeError(f"找不到会话 '{conversation_id}'")
        config, messages, tools = await self._prepare_node(node, conversation_id, conversation, user_id)
        result = None
        async with aclosing(self.agent_stream_executor.run_agent_loop(
            agent_name=config["agent_name"], model_name=config["model_name"], messages=messages,
            tools=tools, mcp_servers=config["mcp_servers"], max_iterations=config["max_iterations"],
            user_id=user_id, conversation_id=conversation_id, task_id=None, is_graph_node=True,
        )) as stream:
            async for item in stream:
                if isinstance(item, str):
                    if yield_sse:
                        yield item
                else:
                    result = item
        if result is None:
            raise RuntimeError(f"节点 '{node['name']}' 未返回执行结果")
        messages = result.get("round_messages", [])
        output = self._node_output(messages, node.get("output_enabled", True))
        selected = self._selected_node(messages, node)
        await self._save_result(node, conversation_id, conversation, config, tools, result, output, selected)
        yield {"success": True, "has_handoffs": selected is not None, "selected_node": selected, "final_output": output}

    async def _prepare_node(self, node, conversation_id, conversation, user_id):
        """在模板渲染前应用 Agent 配置，避免系统指令在对象间丢失。"""
        config = await self.agent_stream_executor._load_effective_config(
            agent_name=node.get("agent_name"), user_id=user_id, model_name=node.get("model_name"),
            system_prompt=node.get("system_prompt"), mcp_servers=node.get("mcp_servers"),
            system_tools=node.get("system_tools"), max_iterations=node.get("max_iterations"),
        )
        if not config:
            raise RuntimeError(f"无法加载节点 '{node['name']}' 的有效配置")
        prepared = copy.deepcopy(node)
        prepared.update(system_prompt=config["system_prompt"], _conversation_id=conversation_id)
        messages = await self.message_creator.create_agent_messages(prepared)
        tools = await self._prepare_handoffs_tools(node, conversation_id, conversation)
        tools += await self._prepare_mcp_tools(config["mcp_servers"])
        if config["system_tools"]:
            from agent_graph.app.services.system_tools import get_system_tools_by_names
            tools += get_system_tools_by_names(config["system_tools"])
        return config, messages, tools

    @staticmethod
    def _node_output(messages, output_enabled):
        """选择最后一个 assistant 输出，或按顺序汇集普通工具结果。"""
        if output_enabled:
            return next((message.get("content", "") for message in reversed(messages) if message.get("role") == "assistant"), "")
        contents = []
        for message in messages:
            content = message.get("content", "")
            if message.get("role") == "tool" and content and not content.startswith("已选择节点:"):
                contents.append(content)
        return "\n".join(contents)

    @staticmethod
    def _selected_node(messages, node):
        """只接受启用 handoffs 且在输出边集合中的模型选择。"""
        if node.get("handoffs") is None:
            return None
        for message in messages:
            for call in message.get("tool_calls", []) if message.get("role") == "assistant" else []:
                name = call.get("function", {}).get("name", "")
                if name.startswith("transfer_to_"):
                    target = name[len("transfer_to_"):]
                    if target in node.get("output_nodes", []):
                        return target
        return None

    async def _save_result(self, node, conversation_id, conversation, config, tools, result, output, selected):
        """持久化节点 checkpoint 后同步输出和执行链，失败不得报告完成。"""
        usage = result.get("round_token_usage", {})
        round_data = {
            "round": len(conversation["rounds"]) + 1, "node_name": node["name"],
            "agent_name": config["agent_name"], "level": node.get("level", 0),
            "output_enabled": node.get("output_enabled", True), "messages": result.get("round_messages", []),
            "model": config["model_name"], "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        }
        if config["mcp_servers"]:
            round_data["mcp_servers"] = config["mcp_servers"]
        if not await mongodb_client.add_round_to_graph_run(conversation_id=conversation_id, round_data=round_data, tools_schema=tools):
            raise RuntimeError("保存节点执行记录失败")
        conversation["rounds"].append(round_data)
        conversation["_current_round"] = round_data["round"]
        if selected:
            state = await self.conversation_manager.get_handoffs_status(conversation_id, node["name"])
            await self.conversation_manager.update_handoffs_status(conversation_id, node["name"], node["handoffs"], state.get("used_count", 0) + 1, selected)
        if usage.get("total_tokens", 0) > 0:
            await mongodb_client.conversation_repository.update_conversation_token_usage(
                conversation_id=conversation_id, prompt_tokens=usage.get("prompt_tokens", 0), completion_tokens=usage.get("completion_tokens", 0),
            )
        if output:
            await self.conversation_manager._add_global_output(conversation_id, node["name"], output)
        await ExecutionChainManager.update_execution_chain(conversation)
        if not await self.conversation_manager.update_conversation_file(conversation_id):
            raise RuntimeError("保存节点状态失败")

    async def _prepare_handoffs_tools(self, node, conversation_id, conversation):
        """按当前已用次数生成 handoffs 工具。"""
        limit = node.get("handoffs")
        state = await self.conversation_manager.get_handoffs_status(conversation_id, node["name"])
        if limit is not None and state.get("used_count", 0) < limit:
            return HandoffsManager.create_handoffs_tools(node, conversation["graph_config"])
        return []

    async def _prepare_mcp_tools(self, servers):
        """读取本节点需要的 MCP 工具定义。"""
        if not servers:
            return []
        from agent_graph.app.services.mcp.mcp_service import mcp_service
        return await mcp_service.prepare_chat_tools(servers)
