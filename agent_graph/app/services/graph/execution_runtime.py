"""管理单进程内的图执行归属与停机。"""
import asyncio
from contextlib import asynccontextmanager
from fastapi import HTTPException


class GraphExecutionRuntime:
    """同一会话只允许一个写入者，持有所有执行任务直至退出。"""

    def __init__(self):
        self.owners = {}
        self.background_tasks = set()
        self.closing = False

    def ensure_open(self):
        if self.closing:
            raise HTTPException(503, "图执行服务正在关闭")

    def claim(self, conversation_id):
        """在首个副作用前同步取得进程内执行权。"""
        self.ensure_open()
        if conversation_id in self.owners:
            raise HTTPException(409, "会话正在执行，请稍后重试")
        self.owners[conversation_id] = asyncio.current_task()

    @asynccontextmanager
    async def execution(self, conversation_id, *, reserved=False):
        """执行者退出后释放会话写入权。"""
        if not reserved:
            self.claim(conversation_id)
        else:
            self.owners[conversation_id] = asyncio.current_task()
        try:
            yield
        finally:
            self.owners.pop(conversation_id, None)

    def spawn(self, conversation_id, factory):
        """保留后台任务并在创建失败时交还已取得的执行权。"""
        coroutine = None
        try:
            coroutine = factory()
            task = asyncio.create_task(coroutine)
        except BaseException:
            if coroutine is not None:
                coroutine.close()
            self.owners.pop(conversation_id, None)
            raise
        self.owners[conversation_id] = task
        self.background_tasks.add(task)
        def completed(task):
            self.background_tasks.discard(task)
            if self.owners.get(conversation_id) is task:
                self.owners.pop(conversation_id, None)
            if not task.cancelled():
                task.exception()
        task.add_done_callback(completed)
        return task

    async def shutdown(self):
        """停止接收执行并等待全部生产者完成清理。"""
        self.closing = True
        current = asyncio.current_task()
        tasks = set(self.owners.values()) | self.background_tasks
        tasks.discard(current)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.owners.clear()
        self.background_tasks.clear()
