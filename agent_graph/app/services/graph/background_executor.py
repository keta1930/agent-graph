import logging
from contextlib import aclosing
from agent_graph.app.services.conversation.execution_guard import get_execution_conversation
from agent_graph.app.services.graph.graph_executor import GraphExecutor

logger = logging.getLogger(__name__)


class BackgroundExecutor:
    """后台适配器只负责调度，共享图执行驱动器。"""

    def __init__(self, conversation_manager, mcp_service, executor=None):
        self._pending = {}
        self.conversation_manager = conversation_manager
        self.executor = executor or GraphExecutor(conversation_manager, mcp_service)
        self.message_creator = self.executor.message_creator
        self.node_executor_core = self.executor.node_executor_core

    async def execute_graph_background(self, graph_name, flattened_config, input_text, model_service=None, user_id="default_user"):
        self.conversation_manager.runtime.ensure_open()
        conversation_id = await self.conversation_manager.create_conversation_with_config(graph_name, flattened_config, user_id)
        runtime = self.conversation_manager.runtime
        runtime.claim(conversation_id)
        try:
            await self.message_creator.record_user_input(conversation_id, input_text)
            runtime.spawn(conversation_id, lambda: self._execute_graph_background_task(conversation_id, model_service, user_id))
        except BaseException:
            runtime.owners.pop(conversation_id, None)
            self.conversation_manager.release_conversation(conversation_id)
            raise
        return {"status": "started", "conversation_id": conversation_id, "message": "图已在后台开始执行"}

    async def continue_conversation_background(self, conversation_id, input_text=None, model_service=None, *, user_id, continue_from_checkpoint=False):
        await get_execution_conversation(conversation_id, user_id, "graph")
        runtime = self.conversation_manager.runtime
        runtime.claim(conversation_id)
        # 请求参数属于任务，不能在返回前无保护地修改共享会话。
        self._pending[conversation_id] = (input_text, continue_from_checkpoint)
        try:
            task = runtime.spawn(conversation_id, lambda: self._continue_conversation_background_task(conversation_id, model_service, user_id))
            task.add_done_callback(lambda _: self._pending.pop(conversation_id, None))
        except BaseException:
            self._pending.pop(conversation_id, None)
            raise
        return {"status": "started", "conversation_id": conversation_id, "message": "会话已在后台继续执行"}

    async def _execute_graph_background_task(self, conversation_id, model_service, user_id="default_user"):
        await self._run(conversation_id, user_id, new=True)

    async def _continue_conversation_background_task(self, conversation_id, model_service, user_id="default_user"):
        await self._run(conversation_id, user_id, new=False)

    async def _run(self, conversation_id, user_id, *, new):
        try:
            async with self.executor.execution(conversation_id, reserved=True):
                if new:
                    iterator = self.executor.run_nodes(conversation_id, user_id, yield_sse=False)
                else:
                    text, checkpoint = self._pending.pop(conversation_id)
                    iterator = self.executor.run_conversation(conversation_id, text, checkpoint, user_id, yield_sse=False)
                async with aclosing(iterator) as stream:
                    async for _ in stream:
                        pass
                await self.executor.finish(conversation_id)
        except Exception:
            logger.exception("后台图执行失败: %s", conversation_id)
        finally:
            self._pending.pop(conversation_id, None)
