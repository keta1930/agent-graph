"""
Agent 运行服务
职责：处理 Agent 运行请求的业务逻辑
"""
import json
import logging
import asyncio
from anyio import move_on_after
from typing import Optional, List, Dict, Any, Tuple
from bson import ObjectId
from fastapi import HTTPException, status, UploadFile
from agent_graph.app.services.agent.file_handler import file_handler
from agent_graph.app.infrastructure.database.mongodb.client import mongodb_client
from agent_graph.app.services.conversation.title_service import generate_title_and_tags
from agent_graph.app.services.conversation.execution_guard import get_execution_conversation

logger = logging.getLogger(__name__)
TITLE_WAIT_TIMEOUT = 3.0
STREAM_CLEANUP_TIMEOUT = 3.0


class AgentRunService:
    """Agent 运行服务 - 处理 Agent 运行请求的业务逻辑"""

    def __init__(self):
        """初始化 Agent 运行服务"""
        pass

    async def validate_request_params(
        self,
        user_prompt: str,
        agent_name: Optional[str],
        model_name: Optional[str],
        user_id: str,
        mcp_servers: Optional[str],
        system_tools: Optional[str]
    ) -> Tuple[Optional[str], Optional[List[str]], Optional[List[str]]]:
        """
        验证请求参数

        Args:
            user_prompt: 用户输入
            agent_name: Agent 名称
            model_name: 模型名称
            user_id: 用户 ID
            mcp_servers: MCP 服务器列表（JSON 字符串）
            system_tools: 系统工具列表（JSON 字符串）

        Returns:
            Tuple: (验证后的 agent_name, mcp_servers_list, system_tools_list)

        Raises:
            HTTPException: 参数验证失败
        """

        # 验证 user_prompt
        if not user_prompt or not user_prompt.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="用户消息不能为空"
            )

        # 验证配置：必须提供 agent_name 或 model_name
        if not agent_name and not model_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="必须提供 agent_name 或 model_name"
            )

        # 如果提供了 agent_name，验证 Agent 是否存在
        if agent_name:
            agent = await mongodb_client.agent_repository.get_agent(
                agent_name,
                user_id
            )

            if not agent:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"找不到 Agent: {agent_name}"
                )

        # 解析 JSON 字符串参数
        mcp_servers_list = json.loads(mcp_servers) if mcp_servers else None
        system_tools_list = json.loads(system_tools) if system_tools else None

        return agent_name, mcp_servers_list, system_tools_list

    async def ensure_conversation_exists(
        self,
        conversation_id: Optional[str],
        user_id: str,
        agent_name: Optional[str],
        project_id: Optional[str] = None
    ) -> Tuple[str, bool]:
        """
        确保 Agent 会话存在（包括 conversation 和 agent_run 记录）

        Args:
            conversation_id: 会话 ID（可选，如果为 None 则自动生成）
            user_id: 用户 ID
            agent_name: Agent 名称（用于生成标题）

        Returns:
            Tuple: (conversation_id, is_new_conversation)

        Note:
            此方法专门用于 Agent 会话，会同时创建 conversation 和 agent_run 记录。
            对于其他类型的会话，请使用 conversation_repository.ensure_conversation_exists()
        """

        # 生成或使用现有 conversation_id
        conversation_id = conversation_id or str(ObjectId())

        # 检查对话是否已存在
        existing_conversation = await get_execution_conversation(
            conversation_id, user_id, "agent", allow_missing=True
        )
        is_new_conversation = (existing_conversation is None)

        # 目标会话授权后再验证 project 权限。
        if project_id:
            project = await mongodb_client.get_project(project_id, user_id)
            if not project:
                raise ValueError(f"Project 不存在或无权限访问: {project_id}")

        if is_new_conversation:
            # 创建 conversation 记录（类型为 agent）
            created = await mongodb_client.conversation_repository.create_conversation(
                conversation_id=conversation_id,
                conversation_type="agent",
                user_id=user_id,
                title=f"{agent_name or 'Manual'} 对话",
                tags=[],
                project_id=project_id
            )

            if not created:
                # 并发创建同一 ID 时重新校验，避免继续写入其他请求创建的会话。
                await get_execution_conversation(conversation_id, user_id, "agent")
                return conversation_id, False

            # 创建 agent_run 记录（Agent 专用）
            await mongodb_client.agent_run_repository.create_agent_run(
                conversation_id=conversation_id
            )

            if project_id:
                await mongodb_client.update_project_conversation_count(project_id, 1)

        return conversation_id, is_new_conversation

    async def process_files(
        self,
        files: Optional[List[UploadFile]],
        user_id: str,
        conversation_id: str
    ) -> List[Dict[str, Any]]:
        """
        处理上传的文件

        Args:
            files: 上传的文件列表
            user_id: 用户 ID
            conversation_id: 会话 ID

        Returns:
            List: 图片信息列表
        """
        images_info = []

        if files:
            result = await file_handler.process_uploaded_files(
                files=files,
                user_id=user_id,
                conversation_id=conversation_id
            )
            images_info = result.get("images_info", [])
            logger.info(
                f"处理文件完成: {len(images_info)} 个图片, "
                f"{len(result.get('files_uploaded', []))} 个文本文件"
            )

        return images_info

    def create_title_generator(
        self,
        user_id: str,
        user_prompt: str,
        conversation_id: str
    ) -> Tuple[asyncio.Queue, asyncio.Task]:
        """
        创建标题生成器

        Args:
            user_id: 用户 ID
            user_prompt: 用户输入
            conversation_id: 会话 ID

        Returns:
            Tuple: (title_queue, background_task)
        """
        # 创建队列用于标题更新通知
        title_queue = asyncio.Queue()

        # 后台标题生成任务
        async def generate_title_background():
            try:
                title, tags = await generate_title_and_tags(
                    user_id=user_id,
                    user_prompt=user_prompt
                )

                # 更新数据库中的标题和标签
                await mongodb_client.conversation_repository.update_conversation_title_and_tags(
                    conversation_id=conversation_id,
                    title=title,
                    tags=tags
                )

                logger.info(f"✓ 后台生成标题成功: {title}")

                # 通知前端标题更新
                await title_queue.put({
                    "type": "title_update",
                    "title": title,
                    "tags": tags,
                    "conversation_id": conversation_id
                })

            except Exception as e:
                logger.error(f"后台生成标题出错: {str(e)}")

        # 启动后台任务
        background_task = asyncio.create_task(generate_title_background())

        return title_queue, background_task

    async def create_stream_generator(
        self,
        agent_stream_executor,
        agent_name: Optional[str],
        user_prompt: str,
        user_id: str,
        conversation_id: str,
        images_info: List[Dict[str, Any]],
        model_name: Optional[str],
        system_prompt: Optional[str],
        mcp_servers_list: Optional[List[str]],
        system_tools_list: Optional[List[str]],
        max_iterations: Optional[int],
        is_new_conversation: bool
    ):
        """
        创建流式响应生成器

        Args:
            agent_stream_executor: Agent 流式执行器
            agent_name: Agent 名称
            user_prompt: 用户输入
            user_id: 用户 ID
            conversation_id: 会话 ID
            images_info: 图片信息列表
            model_name: 模型名称
            system_prompt: 系统提示词
            mcp_servers_list: MCP 服务器列表
            system_tools_list: 系统工具列表
            max_iterations: 最大迭代次数
            is_new_conversation: 是否为新会话

        Yields:
            str: SSE 格式的流式响应
        """
        # 标题任务随流消费创建，确保未开始消费的响应不会遗留后台任务。
        await get_execution_conversation(conversation_id, user_id, "agent")
        title_queue = asyncio.Queue()
        title_task = None
        title_sent = False
        agent_stream = None
        try:
            if is_new_conversation:
                title_queue, title_task = self.create_title_generator(user_id, user_prompt, conversation_id)

            agent_stream = agent_stream_executor.run_agent_stream(
                agent_name=agent_name,
                user_prompt=user_prompt,
                user_id=user_id,
                conversation_id=conversation_id,
                images_info=images_info,
                model_name=model_name,
                system_prompt=system_prompt,
                mcp_servers=mcp_servers_list,
                system_tools=system_tools_list,
                max_iterations=max_iterations
            )
            async for chunk in agent_stream:
                # executor 保留直接消费时的 DONE 契约，组合响应由外层统一收尾。
                if chunk.strip() != "data: [DONE]":
                    yield chunk
                if not title_sent and not title_queue.empty():
                    title_sent = True
                    yield f"data: {json.dumps(title_queue.get_nowait())}\n\n"

            if title_task is not None and not title_sent:
                # 等待不隐式取消子任务，超时与断开都交给同一处受保护的清理。
                await asyncio.wait({title_task}, timeout=TITLE_WAIT_TIMEOUT)
                if not title_queue.empty():
                    yield f"data: {json.dumps(title_queue.get_nowait())}\n\n"

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Agent 流式响应生成出错: {str(e)}")
            error_chunk = {
                "error": {
                    "message": str(e),
                    "type": "api_error"
                }
            }
            yield f"data: {json.dumps(error_chunk)}\n\n"
        finally:
            # ASGI 断开会反复取消 await；清理期间屏蔽外层取消并设置独立上限。
            try:
                if title_task is not None:
                    with move_on_after(STREAM_CLEANUP_TIMEOUT, shield=True) as cleanup:
                        if not title_task.done():
                            title_task.cancel()
                        await asyncio.gather(title_task, return_exceptions=True)
                    if cleanup.cancel_called:
                        logger.warning("Agent 标题任务清理超时")
            finally:
                if agent_stream is not None:
                    with move_on_after(STREAM_CLEANUP_TIMEOUT, shield=True) as cleanup:
                        await agent_stream.aclose()
                    if cleanup.cancel_called:
                        logger.warning("Agent 执行流清理超时")

        # 清理先于终态，非流式 collector 在 DONE 处退出也不会遗留任务。
        yield "data: [DONE]\n\n"


# 全局实例
agent_run_service = AgentRunService()
