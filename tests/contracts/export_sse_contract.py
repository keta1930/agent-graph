"""输出实时生产 SSE，供前端契约测试直接消费。"""
import asyncio
import importlib
import json
import logging
import os
import sys
from tempfile import TemporaryDirectory
from pathlib import Path
from types import SimpleNamespace
from typing import TypedDict
from unittest.mock import AsyncMock, patch

# 测试不加载用户环境、应用配置或真实服务凭据。
os.environ.clear()
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
logging.disable(logging.CRITICAL)

import httpx
from openai import AsyncOpenAI
from agent_graph.app.core.config import Settings

Settings.model_config["env_file"] = None
storage = TemporaryDirectory(prefix="agent-graph-sse-contract-")
os.environ.update({
    "PORT": "20050", "PUBLIC_API_BASE_URL": "http://127.0.0.1:20050", "MCP_CLIENT_PORT": "20052",
    "MONGODB_URL": "mongodb://127.0.0.1:1/contract",
    "JWT_SECRET_KEY": "contract-placeholder-" + "x" * 32,
    "ADMIN_USERNAME": "contract", "ADMIN_PASSWORD": "contract-placeholder-password",
    "MINIO_ENDPOINT": "127.0.0.1:1", "MINIO_ACCESS_KEY": "contract", "MINIO_SECRET_KEY": "contract-placeholder",
    "AGENT_GRAPH_DIR": storage.name,
})

from agent_graph.app.services.agent.agent_stream_executor import AgentStreamExecutor
from agent_graph.app.services.model.model_service import model_service
from agent_graph.app.utils.sse_helper import SSEHelper

agent_module = importlib.import_module("agent_graph.app.services.agent.agent_stream_executor")
db_module = importlib.import_module("agent_graph.app.infrastructure.database.mongodb.client")


class ObservedRequest(TypedDict):
    tools_present: bool
    stream: bool


class ContractCase(TypedDict):
    name: str
    requests: list[ObservedRequest]
    frames: list[str]


def chunk(delta=None, finish=None, usage=None):
    """模型原始数据省略未提供字段，由真实 SDK 补全并序列化。"""
    value = {"id": "contract-chunk", "object": "chat.completion.chunk", "created": 0,
             "model": "contract", "choices": [] if usage else [
                 {"index": 0, "delta": delta or {}, "finish_reason": finish}]}
    if usage:
        value["usage"] = usage
    return value


async def produce(name, rounds, *, tools=False, task_id=None, error=False) -> ContractCase:
    """仅隔离模型 HTTP、配置、持久化和工具执行，保留完整生产流链路。"""
    requests: list[ObservedRequest] = []
    responses = iter(rounds)

    async def transport(request):
        payload = json.loads(request.content)
        requests.append({"tools_present": "tools" in payload, "stream": payload["stream"]})
        if error:
            raise RuntimeError("contract upstream failure")
        body = "".join(f"data: {json.dumps(item)}\n\n" for item in next(responses)) + "data: [DONE]\n\n"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    async with AsyncOpenAI(api_key="contract-placeholder", base_url="https://contract.invalid/v1", max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False)) as client:
        executor = AgentStreamExecutor()
        prepared_tools = [{"type": "function", "function": {"name": "contract_tool", "parameters": {"type": "object"}}}] if tools else []
        config = {"agent_name": "contract", "model_name": "contract", "system_prompt": "",
                  "mcp_servers": [], "system_tools": [], "max_iterations": 4}
        messages = [{"role": "user", "content": "public contract input"}]
        with patch.dict(model_service.clients, {"contract:contract": client}), \
             patch.object(model_service, "get_model", AsyncMock(return_value={"model": "contract"})), \
             patch.object(agent_module, "get_execution_conversation", AsyncMock(return_value={"type": "agent"})), \
             patch.object(db_module.mongodb_client, "user_repository", SimpleNamespace(get_user_language=AsyncMock(return_value="en"))), \
             patch.object(executor, "_load_effective_config", AsyncMock(return_value=config)), \
             patch.object(executor, "_build_messages", AsyncMock(return_value=messages)), \
             patch.object(executor, "_prepare_agent_tools", AsyncMock(return_value=prepared_tools)), \
             patch.object(executor, "_save_agent_run_result", AsyncMock()), \
             patch.object(executor.tool_executor, "execute_tools_batch", AsyncMock(return_value=[
                 {"tool_call_id": "call-0", "content": "contract tool result"}])):
            if task_id:
                stream = executor.run_agent_loop("contract", "contract", messages, prepared_tools, [], 4,
                                                 "contract", "contract-conversation", task_id=task_id)
            else:
                stream = executor.run_agent_stream(None, "public contract input", "contract",
                                                   "contract-conversation", model_name="contract")
            frames = [item async for item in stream if isinstance(item, str)]
    return {"name": name, "requests": requests, "frames": frames}


async def export() -> list[ContractCase]:
    """生成正文、思考、工具及相邻终态的公开测试流。"""
    usage = {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5,
             "completion_tokens_details": {"reasoning_tokens": 1}}
    ordinary = [chunk({"role": "assistant"}), chunk({"content": "你好🙂"}), chunk(finish="stop"), chunk(usage=usage)]
    first_call = chunk({"tool_calls": [{"index": 0, "id": "call-0", "type": "function",
                                         "function": {"name": "contract_tool", "arguments": "{"}}]})
    continuation = chunk({"tool_calls": [{"index": 0, "function": {"arguments": "}"}}]})
    cases = [
        await produce("plain", [ordinary]),
        await produce("reasoning_content", [[chunk({"reasoning_content": "思考"}), chunk({"content": "回答"}), chunk(finish="stop")]]),
        await produce("reasoning", [[chunk({"reasoning": "思考"}), chunk({"content": "回答"}), chunk(finish="stop")]]),
        await produce("tools", [[first_call, continuation, chunk(finish="tool_calls")], ordinary], tools=True),
        await produce("nullable_function", [[first_call, chunk({"tool_calls": [{"index": 0}]}), continuation,
                                               chunk(finish="tool_calls")], ordinary], tools=True),
        await produce("task", [ordinary], task_id="contract-task"),
        await produce("length", [[chunk({"content": "partial"}), chunk(finish="length")]]),
        await produce("content_filter", [[chunk(finish="content_filter")]]),
        await produce("agent_error", [], error=True),
    ]
    cases.append({"name": "graph", "requests": [], "frames": [
        SSEHelper.send_json({"type": "conversation_created", "conversation_id": "contract-conversation"}),
        SSEHelper.send_node_start("contract-node", 1), SSEHelper.send_node_end("contract-node"),
        SSEHelper.send_graph_complete("contract final", [["contract-node"]]), SSEHelper.format_done()]})
    cases.append({"name": "graph_error", "requests": [], "frames": [
        SSEHelper.send_error("contract graph failure"), SSEHelper.format_done()]})
    return cases


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(export()), ensure_ascii=False))
    finally:
        storage.cleanup()
