from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_graph.app.core.config import Settings, get_settings


class TestSettings:
    def test_loads_case_insensitive_environment_variables(
        self,
        set_required_env,
    ):
        set_required_env(lowercase=True)

        settings = get_settings()

        assert settings.port == 20050
        assert settings.mcp_client_port == 20052
        assert settings.mongodb_url.endswith("/test")
        assert settings.jwt_secret_key.get_secret_value().startswith("test_secret_key_")

    def test_defaults(self, make_settings):
        settings = make_settings()

        assert settings.app_name == "Agent-Graph"
        assert settings.app_version == "3.0.0"
        assert settings.jwt_algorithm == "HS256"
        assert settings.mongodb_db == "agent-graph"
        assert settings.minio_bucket_name == "agent-graph"
        assert settings.minio_secure is False
        assert settings.cors_origins == []

    @pytest.mark.parametrize("port", [0, 65536, "not-a-port"])
    def test_rejects_invalid_port(self, make_settings, port):
        with pytest.raises(ValidationError):
            make_settings(port=port)

    def test_rejects_short_jwt_secret(self, make_settings):
        with pytest.raises(ValidationError):
            make_settings(jwt_secret_key="too-short")

    @pytest.mark.parametrize(
        "secret",
        [
            "your-secret-key-change-in-production",
            "your-secret-key-here-run-generate-script",
        ],
    )
    def test_rejects_public_jwt_placeholders(self, make_settings, secret):
        with pytest.raises(ValidationError):
            make_settings(jwt_secret_key=secret)

    def test_rejects_short_admin_password(self, make_settings):
        with pytest.raises(ValidationError):
            make_settings(admin_password="admin123")

    def test_parses_comma_separated_cors_origins(self, make_settings):
        settings = make_settings(
            cors_origins=" http://localhost:3000, http://localhost:3001 "
        )

        assert settings.cors_origins == [
            "http://localhost:3000",
            "http://localhost:3001",
        ]

    def test_parses_public_api_base_url(self, make_settings):
        settings = make_settings(public_api_base_url="https://example.com/")

        assert str(settings.public_api_base_url) == "https://example.com/"

    @pytest.mark.parametrize("url", ["", "/api", "ftp://example.com"])
    def test_rejects_invalid_public_api_base_url(self, make_settings, url):
        with pytest.raises(ValidationError):
            make_settings(public_api_base_url=url)

    def test_converts_scalar_types(self, make_settings):
        settings = make_settings(
            port="21000",
            jwt_access_token_expire_minutes="30",
            jwt_refresh_token_expire_days="14",
            minio_secure="true",
        )

        assert settings.port == 21000
        assert settings.jwt_access_token_expire_minutes == 30
        assert settings.jwt_refresh_token_expire_days == 14
        assert settings.minio_secure is True

    def test_loads_explicit_env_file(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text(
            "\n".join(
                [
                    "PORT=21000",
                    "PUBLIC_API_BASE_URL=http://127.0.0.1:21000",
                    "MCP_CLIENT_PORT=20052",
                    "MONGODB_URL=mongodb://test:test@127.0.0.1/test",
                    f"JWT_SECRET_KEY={'a' * 32}",
                    "ADMIN_USERNAME=test-admin",
                    "ADMIN_PASSWORD=test-password-123",
                    "MINIO_ENDPOINT=127.0.0.1:9000",
                    "MINIO_ACCESS_KEY=testkey",
                    "MINIO_SECRET_KEY=testsecret",
                    "APP_NAME=Configured App",
                ]
            ),
            encoding="utf-8",
        )

        settings = Settings(_env_file=env_file)

        assert settings.port == 21000
        assert settings.app_name == "Configured App"

    def test_example_env_requires_operator_secrets(self):
        env_file = Path(__file__).parents[2] / ".env.example"

        with pytest.raises(ValidationError):
            Settings(_env_file=env_file)


class TestGetSettings:
    def test_returns_cached_instance(self, set_required_env):
        set_required_env()

        first = get_settings()
        second = get_settings()

        assert first is second

    def test_cache_clear_reloads_settings(self, set_required_env):
        set_required_env()
        first = get_settings()

        get_settings.cache_clear()

        assert get_settings() is not first


class TestDirectoryPaths:
    def test_derived_directories(self, test_settings):
        assert test_settings.exports_dir == Path.home() / ".agent_graph" / "exports"
        assert test_settings.mcp_tools_dir == Path.home() / ".agent_graph" / "mcp"

    def test_agent_graph_dir_is_configurable(self, make_settings, tmp_path):
        settings = make_settings(agent_graph_dir=tmp_path)

        assert settings.exports_dir == tmp_path / "exports"
        assert settings.mcp_tools_dir == tmp_path / "mcp"

    def test_ensure_directories_is_idempotent(self, make_settings, tmp_path):
        settings = make_settings(agent_graph_dir=tmp_path)

        settings.ensure_directories()
        settings.ensure_directories()

        assert settings.exports_dir.is_dir()
        assert settings.mcp_tools_dir.is_dir()

    def test_get_mcp_tool_dir(self, make_settings, tmp_path):
        settings = make_settings(agent_graph_dir=tmp_path)

        assert settings.get_mcp_tool_dir("my-tool") == tmp_path / "mcp" / "my-tool"
