import pytest
from pydantic import ValidationError

from agent_graph.app.models.auth_schema import UpdatePasswordRequest
from agent_graph.app.models.mcp_schema import MCPConfig, MCPServerConfig
from agent_graph.app.models.system_tools_schema import SystemToolSchema


def test_update_password_rejects_reuse():
    with pytest.raises(ValidationError, match="新密码不能与旧密码相同"):
        UpdatePasswordRequest(old_password="password", new_password="password")


def test_mcp_config_normalizes_and_filters_transport_fields():
    config = MCPConfig(
        mcpServers={
            "remote": MCPServerConfig(
                type="streamable-http",
                url="https://example.com/mcp",
                command="unused",
                args=["unused"],
            )
        }
    )

    assert config.model_dump() == {
        "mcpServers": {
            "remote": {
                "autoApprove": [],
                "disabled": False,
                "timeout": 60,
                "transportType": "streamable_http",
                "url": "https://example.com/mcp",
            }
        }
    }


def test_system_tool_schema_preserves_public_schema_field():
    model = SystemToolSchema(name="search", schema={"type": "function"})

    assert model.model_dump(by_alias=True) == {
        "name": "search",
        "schema": {"type": "function"},
    }
