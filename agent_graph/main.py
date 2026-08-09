import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from asyncer import asyncify
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

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
    title="Agent-Graph",
    description="通过MCP+Graph构建Agent系统的工具",
    version="2.0.0",
    lifespan=lifespan,
)

# 添加CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 全局异常处理
@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"未处理的异常: {str(exc)}")
    import traceback
    traceback.print_exc()
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": f"服务器内部错误: {str(exc)}"},
    )


# 注册路由
app.include_router(router, prefix="/api")


@app.get("/health")
async def health_check():
    return {"status": "healthy", "app_name": settings.app_name, "version": settings.app_version}


# 静态文件服务配置
FRONTEND_DIST_DIR = Path(__file__).parent / "dist"

# 如果前端构建文件存在，则提供静态文件服务
if FRONTEND_DIST_DIR.exists() and FRONTEND_DIST_DIR.is_dir():
    logger.info(f"前端静态文件目录存在: {FRONTEND_DIST_DIR}")

    # 挂载静态资源目录（CSS, JS, images等）
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST_DIR / "assets")), name="assets")

    # 处理所有非API路由，返回index.html（支持前端路由）
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """
        为所有非API路由提供前端应用
        支持前端单页应用的客户端路由
        """
        # 如果请求的是具体文件且存在，直接返回
        file_path = FRONTEND_DIST_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path)

        # 否则返回 index.html，让前端路由处理
        index_path = FRONTEND_DIST_DIR / "index.html"
        if index_path.exists():
            return FileResponse(index_path)

        # 如果 index.html 不存在，返回 404
        return JSONResponse(
            status_code=404,
            content={"detail": "Frontend not found"}
        )
else:
    logger.warning(f"前端静态文件目录不存在: {FRONTEND_DIST_DIR}")
    logger.warning("如需使用集成前端，请先运行 'npm run build' 构建前端应用")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=False,
        log_level="info",
    )