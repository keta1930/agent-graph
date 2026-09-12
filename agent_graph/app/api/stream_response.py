from anyio import move_on_after
from fastapi.responses import StreamingResponse


class ClosingStreamingResponse(StreamingResponse):
    """响应发送失败、断开和取消时关闭持有的异步生成器。"""

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with move_on_after(3, shield=True):
                await self.body_iterator.aclose()
