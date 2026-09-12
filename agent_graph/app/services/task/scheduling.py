from datetime import datetime

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from agent_graph.app.models.task_schema import local_datetime


def build_task_trigger(task):
    """验证完整调度配置后构造 trigger，不修改现有任务。"""
    config = task.get('schedule_config') or {}
    if task.get('schedule_type') == 'single':
        execute_at = config.get('execute_at')
        if not execute_at:
            raise ValueError('单次执行任务必须指定执行时间')
        execute_at = local_datetime(execute_at)
        if execute_at <= datetime.now():
            raise ValueError('单次执行任务的时间必须在当前时间之后')
        return DateTrigger(run_date=execute_at)
    if task.get('schedule_type') == 'recurring':
        expression = config.get('cron_expression')
        if not expression:
            raise ValueError('周期性任务缺少cron表达式')
        return CronTrigger.from_crontab(expression)
    raise ValueError(f"不支持的调度类型: {task.get('schedule_type')}")
