import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from asyncer import asyncify
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent_graph.app.api.routes import router
from agent_graph.app.core.config import get_settings
from agent_graph.app.core.initialization import initialize_system
from agent_graph.app.infrastructure.database.mongodb import mongodb_client
from agent_graph.app.infrastructure.storage.file_storage import FileManager
from agent_graph.app.infrastructure.storage.object_storage.minio_client import (
    minio_client,
)
from agent_graph.app.services.graph.graph_service import graph_service
from agent_graph.app.services.mcp.mcp_service import mcp_service
from agent_graph.app.services.model.model_service import model_service


settings = get_settings()
logger = logging.getLogger("agent_graph")


class HealthResponse(BaseModel):
    """描述应用健康状态和版本。"""

    status: Literal["healthy"]
    app_name: str
    version: str


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """管理应用依赖的初始化与清理。"""
    logger.info("Starting Agent-Graph application")

    try:
        logger.info("配置目录: %s", settings.agent_graph_dir)
        settings.ensure_directories()

        await asyncify(minio_client.initialize)(settings)
        logger.info("MinIO connected successfully")

        await mongodb_client.initialize(settings.mongodb_url, settings.mongodb_db)
        logger.info("MongoDB connected successfully")

        await initialize_system()
        FileManager.initialize()
        await model_service.initialize(mongodb_client)
        await graph_service.initialize()
        await mcp_service.initialize()

        logger.info("所有服务初始化完成")
        yield
    except Exception:
        logger.exception("Failed to initialize application")
        raise
    finally:
        logger.info("Shutting down Agent-Graph application")

        try:
            await mcp_service.cleanup()
            logger.info("MCP 服务清理完成")
        except Exception:
            logger.exception("清理 MCP 服务时出错")

        try:
            await mongodb_client.disconnect()
            logger.info("MongoDB 连接已断开")
        except Exception:
            logger.exception("断开 MongoDB 连接时出错")


app = FastAPI(
    title=settings.app_name,
    description="通过 MCP 与 Graph 构建 Agent 系统的工具",
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def generic_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    logger.error(
        "未处理的请求异常: %s %s",
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "服务器内部错误"},
    )


app.include_router(router)


@app.get("/health")
async def health_check() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        app_name=settings.app_name,
        version=settings.app_version,
    )


FRONTEND_DIST_DIR = Path(__file__).resolve().parent / "dist"
app.frontend("/", directory=FRONTEND_DIST_DIR, fallback="index.html")
