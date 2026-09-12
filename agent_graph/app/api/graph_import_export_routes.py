import logging
import os
import tempfile
from functools import partial
from pathlib import Path

from anyio import CancelScope
from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, BackgroundTasks
from agent_graph.app.api.archive_response import TemporaryArchiveResponse
from agent_graph.app.auth.dependencies import get_current_user
from agent_graph.app.core.config import get_settings
from agent_graph.app.models.auth_schema import CurrentUser
from agent_graph.app.models.graph_schema import GraphFilePath
from agent_graph.app.services.conversation.document_archive import run_archive_io, remove_archive_directory
from agent_graph.app.services.graph.graph_archive_service import GraphArchiveService, GraphArchiveError

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(tags=["graph"])


async def _respond(operation):
    """HTTP 层统一转换归档业务错误，保留明确的状态语义。"""
    try:
        return await operation
    except HTTPException:
        raise
    except GraphArchiveError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    except Exception as exc:
        logger.exception("Graph归档处理失败")
        raise HTTPException(500, "Graph归档处理失败") from exc


@router.post("/graphs/import", response_model=dict)
async def import_graph(data: GraphFilePath, current_user: CurrentUser = Depends(get_current_user)):
    """从本地 JSON 文件导入图。"""
    return await _respond(GraphArchiveService(settings).import_json(data.file_path, current_user.user_id))


@router.post("/graphs/import_package", response_model=dict)
async def import_graph_package(data: GraphFilePath, current_user: CurrentUser = Depends(get_current_user)):
    """从本地 ZIP 包导入图及附属组件。"""
    return await _respond(GraphArchiveService(settings).import_package(data.file_path, current_user.user_id))


async def _import_upload(file, extension, importer):
    """分块暂存上传文件，在首个 await 前接管文件描述符。"""
    if not file.filename or not file.filename.endswith(extension):
        raise HTTPException(400, f"文件必须是{extension[1:].upper()}格式")
    fd, path = tempfile.mkstemp(suffix=extension)
    handle = None
    try:
        handle = os.fdopen(fd, "wb")
        while chunk := await file.read(1024 * 1024):
            await run_archive_io(partial(handle.write, chunk))
        await run_archive_io(handle.close)
        return await importer(path)
    finally:
        with CancelScope(shield=True):
            if handle is not None:
                await run_archive_io(handle.close)
            else:
                os.close(fd)
            await run_archive_io(partial(Path(path).unlink, missing_ok=True))


@router.post("/graphs/import_from_file", response_model=dict)
async def import_graph_from_file(file: UploadFile = File(...), current_user: CurrentUser = Depends(get_current_user)):
    """从上传的 JSON 文件导入图。"""
    service = GraphArchiveService(settings)
    return await _respond(_import_upload(file, ".json", lambda path: service.import_json(path, current_user.user_id)))


@router.post("/graphs/import_package_from_file", response_model=dict)
async def import_graph_package_from_file(file: UploadFile = File(...), current_user: CurrentUser = Depends(get_current_user)):
    """从上传的 ZIP 包导入图及附属组件。"""
    service = GraphArchiveService(settings)
    return await _respond(_import_upload(file, ".zip", lambda path: service.import_package(path, current_user.user_id)))


@router.get("/graphs/{graph_name}/export")
async def export_graph(graph_name: str, background_tasks: BackgroundTasks, current_user: CurrentUser = Depends(get_current_user)):
    """下载图归档，响应接管临时目录直到发送结束。"""
    path = await _respond(GraphArchiveService(settings).export_package(graph_name, current_user.user_id))
    try:
        return TemporaryArchiveResponse(path, filename=f"{graph_name}.zip", media_type="application/zip", background=background_tasks)
    except BaseException:
        await remove_archive_directory(os.path.dirname(path))
        raise
