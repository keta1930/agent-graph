from typing import Any, Literal

from fastapi import HTTPException, status

from agent_graph.app.infrastructure.database.mongodb.client import mongodb_client


async def get_execution_conversation(
    conversation_id: str,
    user_id: str,
    conversation_type: Literal["agent", "graph"],
    *,
    allow_missing: bool = False,
) -> dict[str, Any] | None:
    """从持久记录校验执行归属，管理员也只允许续跑本人会话。"""
    conversation = await mongodb_client.conversation_repository.get_conversation(conversation_id)
    if conversation is None:
        if allow_missing:
            return None
        raise HTTPException(status.HTTP_404_NOT_FOUND, "会话不存在")
    if conversation.get("user_id") != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无权限执行此会话")
    if conversation.get("type") != conversation_type:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "会话类型不匹配")
    return conversation
