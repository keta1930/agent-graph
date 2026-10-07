"""Exercise configured headers through the real HTTP transport and MCP loader."""
import importlib
import json
from pathlib import Path

import httpx
import pytest
from mcp.client.streamable_http import streamablehttp_client


@pytest.mark.parametrize("configured_headers", [None, {"User-Agent": "Agent-Graph/3.0.0"}])
async def test_streaming_http_headers(monkeypatch, set_required_env, configured_headers):
    set_required_env()
    client = importlib.import_module("agent_graph.mcp_client")
    monkeypatch.setattr(client, "CONFIG", {})
    monkeypatch.setattr(client, "SERVERS", {})
    requests = []

    def respond(request):
        requests.append(request)
        message = json.loads(request.content)
        method = message["method"]
        if "id" not in message:
            return httpx.Response(202)
        if method == "initialize":
            result = {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fixture", "version": "1"},
            }
        elif method == "tools/list":
            result = {"tools": [{"name": "web_search", "inputSchema": {"type": "object"}}]}
        elif method == "tools/call":
            assert message["params"] == {
                "name": "web_search", "arguments": {"objective": "Python asyncio"}
            }
            result = {"content": [{"type": "text", "text": "https://docs.python.org/3/library/asyncio.html"}]}
        else:
            raise AssertionError(method)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": message["id"], "result": result})

    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(
            headers=headers, timeout=timeout, auth=auth, transport=httpx.MockTransport(respond)
        )

    def transport(**kwargs):
        return streamablehttp_client(**kwargs, httpx_client_factory=factory)

    monkeypatch.setattr(client, "streamablehttp_client", transport)
    markdown = Path("docs/core-components/mcp/first-server.md").read_text()
    config = next(
        json.loads(block.split("```", 1)[0])
        for block in markdown.split("```json\n")[1:]
        if '"parallel_search"' in block.split("```", 1)[0]
    )
    server_config = config["mcpServers"]["parallel_search"]
    if configured_headers is None:
        server_config.pop("headers")
    else:
        assert server_config["headers"] == configured_headers
    original = json.loads(json.dumps(config))
    assert await client.process_config_update(config)
    try:
        assert await client.connect_single_server("parallel_search")
        result = await client.call_tool(client.ToolCallData(
            server_name="parallel_search", tool_name="web_search", params={"objective": "Python asyncio"}
        ))
        assert result["server_name"] == "parallel_search"
        assert "docs.python.org" in result["content"][0].text
        assert [json.loads(r.content)["method"] for r in requests] == [
            "initialize", "notifications/initialized", "tools/list", "tools/call"
        ]
        for request in requests:
            assert str(request.url) == "https://search.parallel.ai/mcp"
            assert "authorization" not in request.headers
            if configured_headers:
                assert request.headers["user-agent"] == configured_headers["User-Agent"]
            else:
                assert request.headers["user-agent"].startswith("python-httpx/")
        assert config == original
        assert server_config["autoApprove"] == []
        assert server_config["timeout"] == 60
    finally:
        await client.SERVERS["parallel_search"].cleanup()
