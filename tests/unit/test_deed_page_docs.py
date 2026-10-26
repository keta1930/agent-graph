"""Keep the deed.page MCP example identical in the English and Chinese guides."""
import json
from pathlib import Path

GUIDES = [
    Path("docs/core-components/mcp/first-server.md"),
    Path("docs/core-components/mcp/first-server.zh.md"),
]


def _deed_page_config(path):
    blocks = [block.split("```", 1)[0] for block in path.read_text().split("```json\n")[1:]]
    return next(json.loads(block) for block in blocks if '"deed_page"' in block)


def test_deed_page_config_matches_in_both_guides():
    english, chinese = (_deed_page_config(path) for path in GUIDES)
    assert english == chinese
    server = english["mcpServers"]["deed_page"]
    assert server["transportType"] == "streamable_http"
    assert server["url"] == "https://deed.page/mcp"
    assert server["autoApprove"] == []
    assert "Authorization" not in server["headers"]
