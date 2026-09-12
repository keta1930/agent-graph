"""协调一个存储版本和它的元数据提交。"""

import asyncio
from collections.abc import Awaitable, Callable
import logging
from typing import Any

from anyio import CancelScope

logger = logging.getLogger(__name__)
Version = dict[str, Any]


async def _settle(task):
    """等待正在进行的写操作确定结果，再决定是否回滚。"""
    with CancelScope(shield=True):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                break
    return task.result()


async def write_document(
    write: Callable[[], Awaitable[Version | None]],
    save_metadata: Callable[[Version], Awaitable[bool]],
    discard: Callable[[Version], Awaitable[bool]],
) -> Version | None:
    """失败只撤销本次版本，取消时等待存储与元数据完成。"""
    async def rollback(version):
        try:
            if not await _settle(asyncio.create_task(discard(version))):
                logger.error("回滚文档版本失败: %s", version.get('version_id'))
        except Exception:
            logger.exception("回滚文档版本失败: %s", version.get('version_id'))

    operation = asyncio.create_task(write())
    try:
        version = await asyncio.shield(operation)
    except asyncio.CancelledError:
        try:
            version = await _settle(operation)
        except Exception:
            version = None
        if version:
            await rollback(version)
        raise
    if not version:
        return None

    try:
        metadata = asyncio.create_task(save_metadata(version))
        committed = await asyncio.shield(metadata)
    except asyncio.CancelledError:
        try:
            committed = await _settle(metadata)
        except Exception:
            committed = False
        if not committed:
            await rollback(version)
        raise
    except Exception:
        await rollback(version)
        raise
    if not committed:
        await rollback(version)
        return None
    return version
