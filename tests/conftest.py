import os

import pytest


REQUIRED_SETTINGS = {
    "PORT": "20050",
    "PUBLIC_API_BASE_URL": "http://127.0.0.1:20050",
    "MCP_CLIENT_PORT": "20052",
    "MONGODB_URL": "mongodb://test:test@127.0.0.1:27017/test",
    "JWT_SECRET_KEY": "test_secret_key_" + "a" * 16,
    "ADMIN_USERNAME": "test-admin",
    "ADMIN_PASSWORD": "test-password-123",
    "MINIO_ENDPOINT": "127.0.0.1:9000",
    "MINIO_ACCESS_KEY": "testkey",
    "MINIO_SECRET_KEY": "testsecret",
}


for _name, _value in REQUIRED_SETTINGS.items():
    os.environ.setdefault(_name, _value)


@pytest.fixture(autouse=True)
def isolate_settings(monkeypatch):
    """隔离每个测试的环境变量、`.env` 和配置缓存。"""
    from agent_graph.app.core.config import Settings, get_settings

    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
        monkeypatch.delenv(name.lower(), raising=False)

    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def set_required_env(monkeypatch):
    """设置可构造 Settings 的最小环境变量。"""

    def _set(*, lowercase: bool = False) -> None:
        for name, value in REQUIRED_SETTINGS.items():
            monkeypatch.setenv(name.lower() if lowercase else name, value)

    return _set


@pytest.fixture
def make_settings():
    """构造不读取外部 `.env` 的 Settings。"""
    from agent_graph.app.core.config import Settings

    def _make(**overrides):
        values = {
            "port": 20050,
            "public_api_base_url": "http://127.0.0.1:20050",
            "mcp_client_port": 20052,
            "mongodb_url": "mongodb://test:test@127.0.0.1:27017/test",
            "jwt_secret_key": "test_secret_key_" + "a" * 16,
            "admin_username": "test-admin",
            "admin_password": "test-password-123",
            "minio_endpoint": "127.0.0.1:9000",
            "minio_access_key": "testkey",
            "minio_secret_key": "testsecret",
            "_env_file": None,
        }
        values.update(overrides)
        return Settings(**values)

    return _make


@pytest.fixture
def test_settings(make_settings):
    """返回一组有效的测试配置。"""
    return make_settings()
