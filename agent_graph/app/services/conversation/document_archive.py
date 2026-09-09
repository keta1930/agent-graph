"""为已授权的会话文件创建有界读取、线程压缩的 ZIP。"""

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from contextvars import copy_context
from functools import partial
import logging
import os
import shutil
import tempfile
import zipfile
from typing import TypeVar

from anyio import CancelScope

logger = logging.getLogger(__name__)

READ_CONCURRENCY = 4
T = TypeVar("T")


async def run_archive_io(operation: Callable[[], T]) -> T:
    """取消时等待同步操作完成，避免关闭文件前开始资源清理。"""
    # executor Future 不属于 all_tasks，全局 task 取消不会使它提前进入取消终态。
    work = asyncio.get_running_loop().run_in_executor(None, copy_context().run, operation)
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        with CancelScope(shield=True):
            while not work.done():
                try:
                    await asyncio.shield(work)
                except asyncio.CancelledError:
                    pass
                except Exception:
                    break
        if not work.cancelled():
            work.exception()
        raise


async def remove_archive_directory(directory: str) -> None:
    """在取消作用域内也等到临时目录删除结束。"""
    with CancelScope(shield=True):
        await run_archive_io(partial(shutil.rmtree, directory, ignore_errors=True))


def _write_batch(path: str, mode: str, files: list[tuple[str, str | bytes]]) -> None:
    """在线程内按原始顺序编码并写入本批文件。"""
    with zipfile.ZipFile(path, mode, zipfile.ZIP_DEFLATED) as archive:
        for filename, content in files:
            archive.writestr(filename, content)


async def create_document_archive(
    filenames: Sequence[str],
    read_content: Callable[[str], Awaitable[str | bytes | None]],
    archive_name: str,
    *,
    skip_unreadable: bool = False,
) -> str:
    """生成归档，成功后由调用者在响应结束时清理所在临时目录。"""
    temp_dir = tempfile.mkdtemp()
    complete = False
    try:
        path = os.path.join(temp_dir, archive_name)
        for offset in range(0, len(filenames), READ_CONCURRENCY):
            batch = filenames[offset:offset + READ_CONCURRENCY]
            contents = await asyncio.gather(
                *(read_content(filename) for filename in batch),
                return_exceptions=True,
            )
            files = []
            for filename, content in zip(batch, contents):
                if isinstance(content, asyncio.CancelledError):
                    raise content
                if isinstance(content, BaseException) or content is None:
                    if not skip_unreadable:
                        raise OSError(f"读取文件内容失败：{filename}") from (
                            content if isinstance(content, BaseException) else None
                        )
                    logger.warning("跳过无法读取的分享文件：%s", filename)
                    continue
                files.append((filename, content))

            await run_archive_io(partial(_write_batch, path, "w" if offset == 0 else "a", files))
        complete = True
        return path
    finally:
        if not complete:
            await remove_archive_directory(temp_dir)
