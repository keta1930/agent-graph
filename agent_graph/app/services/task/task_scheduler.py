import asyncio
import logging
from typing import Dict, Any, Optional
from datetime import datetime
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.events import EVENT_SCHEDULER_SHUTDOWN
from anyio import CancelScope
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.jobstores.base import JobLookupError
from apscheduler.executors.asyncio import AsyncIOExecutor
from agent_graph.app.models.task_schema import TaskStatus, local_datetime
from agent_graph.app.services.task.task_service import task_service
from agent_graph.app.services.task.scheduling import build_task_trigger

logger = logging.getLogger(__name__)


class TaskScheduler:
    """任务调度器 - 基于APScheduler"""

    def __init__(self):
        """初始化任务调度器"""
        self.scheduler: Optional[AsyncIOScheduler] = None
        self._initialized = False
        self._stopping = False
        self._running_jobs = set()
        self._shutdown_waiter = None

    def initialize(self):
        """初始化调度器"""
        if self._initialized or self._shutdown_waiter is not None:
            return
        self._stopping = False

        try:
            # 配置调度器
            jobstores = {
                'default': MemoryJobStore()
            }
            executors = {
                'default': AsyncIOExecutor()
            }
            job_defaults = {
                'coalesce': False,
                'max_instances': 3
            }

            self.scheduler = AsyncIOScheduler(
                jobstores=jobstores,
                executors=executors,
                job_defaults=job_defaults
            )

            self.scheduler.start()
            self._initialized = True
            logger.info("任务调度器初始化成功")

        except Exception as e:
            logger.error(f"任务调度器初始化失败: {str(e)}")
            self._initialized = False

    async def shutdown(self):
        """停止触发并等待运行任务清理和调度器关闭。"""
        if self._shutdown_waiter is not None:
            await asyncio.shield(self._shutdown_waiter)
            return
        self._stopping = True
        waiter = asyncio.get_running_loop().create_future()
        self._shutdown_waiter = waiter
        scheduler = self.scheduler
        cancelled = False

        async def wait_until_done(work):
            nonlocal cancelled
            with CancelScope(shield=True):
                while not work.done():
                    try:
                        await asyncio.shield(work)
                    except asyncio.CancelledError:
                        cancelled = True
            return work.result()

        try:
            if scheduler and scheduler.running:
                scheduler.pause()
            jobs = list(self._running_jobs)
            for job in jobs:
                job.cancel()
            if jobs:
                await wait_until_done(asyncio.gather(*jobs, return_exceptions=True))
            if scheduler and scheduler.running:
                stopped = asyncio.get_running_loop().create_future()
                def on_shutdown(event):
                    if not stopped.done():
                        stopped.set_result(None)
                scheduler.add_listener(on_shutdown, EVENT_SCHEDULER_SHUTDOWN)
                try:
                    scheduler.shutdown(wait=True)
                    await wait_until_done(stopped)
                finally:
                    scheduler.remove_listener(on_shutdown)
        finally:
            self.scheduler = None
            self._initialized = False
            self._shutdown_waiter = None
            if not waiter.done():
                waiter.set_result(None)
        if cancelled:
            raise asyncio.CancelledError

    async def schedule_task(self, task: Dict[str, Any]) -> bool:
        """调度任务"""
        try:
            if self._stopping:
                return False
            trigger = build_task_trigger(task)
            if not self._initialized:
                self.initialize()
            if not self.scheduler:
                raise RuntimeError("调度器未初始化")
            task_id = task['id']
            schedule_type = task['schedule_type']
            execute = self._execute_and_cleanup_single_task if schedule_type == 'single' else self._execute_task_wrapper
            self.scheduler.add_job(
                func=execute, trigger=trigger, args=[task], id=task_id,
                name=f"Task: {task.get('task_name', task_id)}", replace_existing=True,
            )

            logger.info(f"任务 {task_id} 调度成功，类型: {schedule_type}")
            return True

        except Exception as e:
            logger.error(f"调度任务失败: {str(e)}")
            return False

    async def remove_task(self, task_id: str) -> bool:
        """移除调度中的任务"""
        try:
            if not self.scheduler:
                return True

            try:
                self.scheduler.remove_job(task_id)
                logger.info(f"已移除调度任务: {task_id}")
            except JobLookupError:
                pass

            return True

        except Exception as e:
            logger.error(f"移除调度任务失败: {str(e)}")
            return False

    async def pause_task(self, task_id: str) -> bool:
        """暂停调度中的任务"""
        try:
            if not self.scheduler:
                return False

            self.scheduler.pause_job(task_id)
            logger.info(f"已暂停调度任务: {task_id}")
            return True

        except Exception as e:
            logger.error(f"暂停调度任务失败: {str(e)}")
            return False

    async def resume_task(self, task_id: str) -> bool:
        """恢复调度中的任务"""
        try:
            if not self.scheduler:
                return False

            self.scheduler.resume_job(task_id)
            logger.info(f"已恢复调度任务: {task_id}")
            return True

        except Exception as e:
            logger.error(f"恢复调度任务失败: {str(e)}")
            return False

    async def _execute_task_wrapper(self, task: Dict[str, Any]):
        """执行一次周期任务并返回实际启动的会话。"""
        return await self._run_task(task, single=False)

    async def _execute_and_cleanup_single_task(self, task: Dict[str, Any]):
        """按启动结果保存单次任务终态。"""
        return await self._run_task(task, single=True)

    async def _run_task(self, task: Dict[str, Any], *, single: bool):
        """跟踪执行及状态保存，使 shutdown 能等待整个任务退出。"""
        if self._stopping:
            return []
        running = asyncio.current_task()
        self._running_jobs.add(running)
        try:
            try:
                conversation_ids = await task_service.execute_task(task)
            except Exception:
                logger.exception("执行调度任务失败: %s", task.get('id'))
                conversation_ids = []
            if single:
                status = TaskStatus.COMPLETED if conversation_ids else TaskStatus.ERROR
                await task_service.update_task_status(task['id'], status)
            return conversation_ids
        finally:
            self._running_jobs.discard(running)

    def get_scheduled_jobs(self) -> list:
        """获取所有调度中的任务"""
        try:
            if not self.scheduler:
                return []

            jobs = []
            for job in self.scheduler.get_jobs():
                jobs.append({
                    "id": job.id,
                    "name": job.name,
                    "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
                    "trigger": str(job.trigger)
                })
            return jobs

        except Exception as e:
            logger.error(f"获取调度任务列表失败: {str(e)}")
            return []

    async def load_active_tasks(self):
        """从数据库加载活跃任务到调度器"""
        try:
            if not self._initialized:
                self.initialize()

            logger.info("开始加载活跃任务到调度器...")

            # 获取所有活跃任务
            active_tasks = await task_service.get_active_tasks()

            loaded_count = 0
            for task in active_tasks:
                # 过期的单次任务在加载时标记为 error，并跳过调度
                try:
                    schedule_type = task.get("schedule_type")
                    schedule_config = task.get("schedule_config", {})
                    execute_at = schedule_config.get("execute_at") if schedule_config else None
                    if schedule_type == "single" and execute_at and local_datetime(execute_at) <= datetime.now():
                        from agent_graph.app.models.task_schema import TaskStatus
                        await task_service.update_task_status(task.get("id"), TaskStatus.ERROR)
                        logger.warning(f"发现过期的单次任务 {task.get('id')}（执行时间 {execute_at}），状态已标记为 error，跳过调度")
                        continue
                except Exception as mark_err:
                    logger.error(f"标记过期单次任务为 error 时出错: {mark_err}")
                    # 即便标记失败，也不要调度这个任务
                    continue

                success = await self.schedule_task(task)
                if success:
                    loaded_count += 1

            logger.info(f"成功加载 {loaded_count}/{len(active_tasks)} 个活跃任务到调度器")

        except Exception as e:
            logger.error(f"加载活跃任务失败: {str(e)}")


# 创建全局任务调度器实例
task_scheduler = TaskScheduler()