"""
会话文件管理API路由
提供文件的CRUD操作、版本查看、下载等功能
"""
import logging
import os
from fastapi import APIRouter, HTTPException, Depends, Path, Query, BackgroundTasks
from fastapi.responses import Response
from urllib.parse import quote

from agent_graph.app.models.auth_schema import CurrentUser
from agent_graph.app.api.archive_response import TemporaryArchiveResponse
from agent_graph.app.auth.dependencies import get_current_user
from agent_graph.app.models.conversation_file_schema import (
    FileListResponse,
    FileDetailResponse,
    FileVersionResponse,
    CreateFileRequest,
    SaveFileRequest,
    FileOperationResponse,
    DeleteFileResponse,
    DownloadAllRequest
)
from agent_graph.app.services.conversation.conversation_document_service import conversation_document_service
from agent_graph.app.services.conversation.document_archive import create_document_archive, remove_archive_directory

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/conversations/{conversation_id}/files",
    tags=["conversation_files"]
)


@router.get("", response_model=FileListResponse)
async def list_files(
    conversation_id: str = Path(..., description="会话ID"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    获取会话所有文件列表

    返回文件名列表（含路径），如果会话属于项目，还会返回项目的共享文件
    """
    try:
        from agent_graph.app.infrastructure.database.mongodb import mongodb_client
        from agent_graph.app.services.project import project_document_service

        # 获取conversation文件
        result = await conversation_document_service.get_all_files(
            conversation_id=conversation_id,
            user_id=current_user.user_id
        )

        if not result["success"]:
            raise HTTPException(status_code=404, detail=result.get("error", "获取文件列表失败"))

        # 检查是否属于project，如果是则获取project文件
        conversation = await mongodb_client.conversation_repository.get_conversation(conversation_id)
        if conversation and conversation.get("project_id"):
            project_id = conversation.get("project_id")
            project_result = await project_document_service.get_all_files(
                project_id=project_id,
                user_id=current_user.user_id
            )

            if project_result["success"]:
                result["project_id"] = project_id
                result["project_files"] = project_result["files"]

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取文件列表失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"获取文件列表失败: {str(e)}")


@router.post("", response_model=FileOperationResponse)
async def create_file(
    conversation_id: str = Path(..., description="会话ID"),
    request: CreateFileRequest = ...,
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    创建新文件

    用户手动创建新文件
    """
    try:
        result = await conversation_document_service.create_file(
            conversation_id=conversation_id,
            filename=request.filename,
            summary=request.summary,
            content=request.content,
            log=request.log,
            user_id=current_user.user_id
        )

        if not result["success"]:
            status_code = 409 if "已存在" in result.get("message", "") else 400
            raise HTTPException(status_code=status_code, detail=result.get("message", "创建文件失败"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"创建文件失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"创建文件失败: {str(e)}")


@router.get("/download-all")
async def download_all_files(
    conversation_id: str = Path(..., description="会话ID"),
    background_tasks: BackgroundTasks = ...,
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    打包下载所有文件

    将会话内所有文件打包为zip下载，保持目录结构
    """
    zip_path = None
    response_ready = False
    try:
        # 获取所有文件列表
        files_result = await conversation_document_service.get_all_files(
            conversation_id=conversation_id,
            user_id=current_user.user_id
        )

        if not files_result["success"]:
            raise HTTPException(status_code=404, detail=files_result.get("error", "获取文件列表失败"))

        files = files_result["files"]
        
        if not files:
            raise HTTPException(status_code=404, detail="该会话没有文件")

        async def read_content(filename: str) -> str | None:
            return await conversation_document_service.read_authorized_file_content(
                conversation_id=conversation_id,
                filename=filename,
                user_id=current_user.user_id,
            )

        zip_path = await create_document_archive(
            files, read_content, f"conversation_{conversation_id}_files.zip"
        )

        response = TemporaryArchiveResponse(
            path=zip_path,
            filename=f"conversation_{conversation_id}_files.zip",
            media_type="application/zip",
            background=background_tasks
        )
        response_ready = True
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"批量下载失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"批量下载失败: {str(e)}")
    finally:
        if zip_path is not None and not response_ready:
            await remove_archive_directory(os.path.dirname(zip_path))

@router.get("/{filename:path}/download")
async def download_file(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    下载单个文件
    """
    try:
        # 获取文件内容
        result = await conversation_document_service.get_file_content(
            conversation_id=conversation_id,
            filename=filename,
            user_id=current_user.user_id
        )

        if not result["success"]:
            raise HTTPException(status_code=404, detail=result.get("error", "文件不存在"))

        content = result["content"]
        file_content = content.encode('utf-8')

        # 路径参数已由 ASGI 解码；响应头以 RFC 5987 保留中文和保留字符。
        encoded_filename = quote(filename)
        disposition = (
            f"attachment; filename*=utf-8''{encoded_filename}"
            if encoded_filename != filename
            else f'attachment; filename="{filename}"'
        )

        # 返回文件下载响应
        return Response(
            content=file_content,
            media_type="text/plain",
            headers={
                "Content-Disposition": disposition
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"下载文件失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"下载文件失败: {str(e)}")


@router.get("/{filename:path}/versions/{version_id}", response_model=FileVersionResponse)
async def get_file_version(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    version_id: str = Path(..., description="版本ID"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    获取文件特定版本

    用于查看历史版本的内容
    """
    try:
        result = await conversation_document_service.get_file_version(
            conversation_id=conversation_id,
            filename=filename,
            version_id=version_id,
            user_id=current_user.user_id
        )

        if not result["success"]:
            raise HTTPException(status_code=404, detail=result.get("error", "获取文件版本失败"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取文件版本失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"获取文件版本失败: {str(e)}")


@router.get("/{filename:path}", response_model=FileDetailResponse)
async def get_file(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    获取文件详情

    返回文件内容、摘要、版本列表等信息
    """
    try:
        result = await conversation_document_service.get_file(
            conversation_id=conversation_id,
            filename=filename,
            user_id=current_user.user_id
        )

        if not result["success"]:
            raise HTTPException(status_code=404, detail=result.get("error", "文件不存在"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取文件详情失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"获取文件详情失败: {str(e)}")


@router.put("/{filename:path}", response_model=FileOperationResponse)
async def save_file(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    request: SaveFileRequest = ...,
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    保存文件

    用户在前端编辑器中修改后保存
    """
    try:
        result = await conversation_document_service.save_file(
            conversation_id=conversation_id,
            filename=filename,
            content=request.content,
            summary=request.summary,
            log=request.log,
            user_id=current_user.user_id
        )

        if not result["success"]:
            status_code = 404 if "不存在" in result.get("message", "") else 400
            raise HTTPException(status_code=status_code, detail=result.get("message", "保存文件失败"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"保存文件失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"保存文件失败: {str(e)}")


@router.delete("/{filename:path}", response_model=DeleteFileResponse)
async def delete_file(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    删除文件

    删除文件及其所有历史版本
    """
    try:
        result = await conversation_document_service.delete_file(
            conversation_id=conversation_id,
            filename=filename,
            user_id=current_user.user_id
        )

        if not result["success"]:
            raise HTTPException(status_code=404, detail=result.get("message", "删除文件失败"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除文件失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"删除文件失败: {str(e)}")


@router.post("/{filename:path}/push-to-project", response_model=FileOperationResponse)
async def push_file_to_project(
    conversation_id: str = Path(..., description="会话ID"),
    filename: str = Path(..., description="文件名（含路径）"),
    project_id: str = Query(..., description="目标Project ID"),
    current_user: CurrentUser = Depends(get_current_user)
):
    """
    推送文件到Project

    将conversation中的文件复制到project
    """
    try:
        from agent_graph.app.services.project import project_document_service

        result = await project_document_service.push_file_from_conversation(
            conversation_id=conversation_id,
            project_id=project_id,
            filename=filename,
            user_id=current_user.user_id
        )

        if not result["success"]:
            status_code = 404 if "不存在" in result.get("message", "") else 400
            if "已存在" in result.get("message", ""):
                status_code = 409
            raise HTTPException(status_code=status_code, detail=result.get("message", "推送文件失败"))

        return {
            "success": True,
            "message": result["message"]
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"推送文件到Project失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"推送文件失败: {str(e)}")
