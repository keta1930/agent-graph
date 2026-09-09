"""将临时归档的释放责任延续到实际 ASGI 响应结束。"""

from collections.abc import Mapping
import os

from fastapi import BackgroundTasks
from fastapi.responses import FileResponse

from agent_graph.app.services.conversation.document_archive import remove_archive_directory


class TemporaryArchiveResponse(FileResponse):
    """正常发送、异常、取消及 Range 提前返回均释放临时归档。"""

    def __init__(
        self,
        path: str,
        *,
        filename: str,
        media_type: str,
        background: BackgroundTasks,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(path, filename=filename, media_type=media_type, headers=headers, background=background)
        self._directory = os.path.dirname(path)
        self._cleanup_complete = False
        background.add_task(self.cleanup)

    async def cleanup(self) -> None:
        """让 background 与响应 finally 共享一次清理。"""
        if self._cleanup_complete:
            return
        try:
            await remove_archive_directory(self._directory)
        finally:
            self._cleanup_complete = True

    async def __call__(self, scope, receive, send) -> None:
        """在 FileResponse 完成文件读取并退出后清理目录。"""
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.cleanup()
