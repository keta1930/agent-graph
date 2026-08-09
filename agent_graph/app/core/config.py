from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import AnyHttpUrl, BeforeValidator, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _split_comma_separated(value: str | list[str]) -> list[str]:
    """将逗号分隔的配置值解析为列表。"""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


CommaSeparatedList = Annotated[
    list[str],
    NoDecode,
    BeforeValidator(_split_comma_separated),
]


class Settings(BaseSettings):
    """集中管理并验证应用运行时配置。"""

    app_name: str = "Agent-Graph"
    app_version: str = "3.0.0"
    port: int = Field(ge=1, le=65535)
    public_api_base_url: AnyHttpUrl
    mcp_client_host: str = "127.0.0.1"
    mcp_client_port: int = Field(ge=1, le=65535)

    mongodb_url: str = Field(min_length=1)
    mongodb_db: str = "agent-graph"

    jwt_secret_key: SecretStr = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = Field(default=15, ge=1, le=1440)
    jwt_refresh_token_expire_days: int = Field(default=7, ge=1, le=90)

    admin_username: str = Field(min_length=3, max_length=50)
    admin_password: SecretStr = Field(min_length=12)

    minio_endpoint: str = Field(min_length=1)
    minio_access_key: str = Field(min_length=3)
    minio_secret_key: SecretStr = Field(min_length=8)
    minio_secure: bool = False
    minio_bucket_name: str = "agent-graph"

    cors_origins: CommaSeparatedList = Field(default_factory=list)
    agent_graph_dir: Path = Field(
        default_factory=lambda: Path.home() / ".agent_graph"
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("jwt_secret_key", mode="before")
    @classmethod
    def reject_placeholder_jwt_secret(cls, value: str) -> str:
        """拒绝示例配置中的公开 JWT 密钥。"""
        insecure_values = {
            "your-secret-key-change-in-production",
            "your-secret-key-here-run-generate-script",
        }
        if value in insecure_values:
            raise ValueError("JWT_SECRET_KEY must be generated before startup")
        return value

    @property
    def exports_dir(self) -> Path:
        """返回导出文件目录。"""
        return self.agent_graph_dir / "exports"

    @property
    def mcp_tools_dir(self) -> Path:
        """返回 MCP 工具目录。"""
        return self.agent_graph_dir / "mcp"

    def ensure_directories(self) -> None:
        """创建应用运行所需的本地目录。"""
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.mcp_tools_dir.mkdir(parents=True, exist_ok=True)

    def get_mcp_tool_dir(self, tool_name: str) -> Path:
        """返回指定 MCP 工具的目录。"""
        return self.mcp_tools_dir / tool_name


@lru_cache
def get_settings() -> Settings:
    """返回进程内共享的应用配置。"""
    return Settings()
