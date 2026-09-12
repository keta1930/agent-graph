import asyncio
from datetime import datetime, timedelta, timezone
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from apscheduler.triggers.date import DateTrigger
from pydantic import ValidationError


@pytest.fixture
def scheduler(monkeypatch, set_required_env):
    set_required_env()
    module = import_module('agent_graph.app.services.task.task_scheduler')
    service = SimpleNamespace(execute_task=AsyncMock(return_value=[]), update_task_status=AsyncMock(), get_active_tasks=AsyncMock(return_value=[]))
    monkeypatch.setattr(module, 'task_service', service)
    return module.TaskScheduler(), service


@pytest.mark.parametrize('ids,expected', [([], 'error'), (['conv'], 'completed')])
async def test_single_task_status_reflects_started_instances(scheduler, ids, expected):
    manager, service = scheduler
    service.execute_task.return_value = ids
    await manager._execute_and_cleanup_single_task({'id': 'task'})
    assert service.update_task_status.await_args.args == ('task', expected)


async def test_single_task_exception_is_error(scheduler):
    manager, service = scheduler
    service.execute_task.side_effect = OSError('failed')
    await manager._execute_and_cleanup_single_task({'id': 'task'})
    assert service.update_task_status.await_args.args == ('task', 'error')


async def test_shutdown_waits_for_job_cleanup_and_can_restart(scheduler):
    manager, service = scheduler
    entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def execute(task):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()
    service.execute_task.side_effect = execute
    manager.initialize()
    original = manager.scheduler
    original.add_job(manager._execute_and_cleanup_single_task, DateTrigger(run_date=datetime.now()), args=[{'id': 'task'}])
    async with asyncio.timeout(3):
        await entered.wait()
        closing = asyncio.create_task(manager.shutdown())
        await cleanup.wait()
        try:
            assert not closing.done()
        finally:
            release.set()
        await closing
    assert not original.running
    service.update_task_status.assert_not_awaited()
    await manager.shutdown()
    manager.initialize()
    assert manager.scheduler is not original and manager.scheduler.running
    await manager.shutdown()


@pytest.mark.parametrize('offset', [0, 8, -7])
def test_schedule_config_normalizes_aware_datetime(offset):
    from agent_graph.app.models.task_schema import ScheduleConfig
    timestamp = datetime.now(timezone(timedelta(hours=offset))) + timedelta(days=1)
    config = ScheduleConfig(execute_at=timestamp.isoformat())
    assert config.execute_at == timestamp.astimezone().replace(tzinfo=None)


@pytest.mark.parametrize('count', [0, -1])
def test_execution_count_must_be_positive(count):
    from agent_graph.app.models.task_schema import TaskCreate
    with pytest.raises(ValidationError):
        TaskCreate(task_name='task', graph_name='g', input_text='hi', execution_count=count,
                   schedule_type='recurring', schedule_config={'cron_expression': '* * * * *'})


async def test_invalid_reschedule_preserves_existing_job(scheduler):
    manager, _ = scheduler
    task = {'id': 'task', 'schedule_type': 'recurring', 'schedule_config': {'cron_expression': '* * * * *'}}
    assert await manager.schedule_task(task)
    original = manager.scheduler.get_job('task')
    try:
        assert not await manager.schedule_task({**task, 'schedule_config': {'cron_expression': 'invalid'}})
        assert manager.scheduler.get_job('task') is original
    finally:
        await manager.shutdown()


async def test_invalid_activation_does_not_change_persisted_status(scheduler, monkeypatch):
    route = import_module('agent_graph.app.api.task_routes')
    from fastapi import HTTPException
    from agent_graph.app.models.task_schema import TaskStatusUpdate
    task = {'id': 'task', 'user_id': 'alice', 'schedule_type': 'single',
            'schedule_config': {'execute_at': datetime(2000, 1, 1)}}
    service = SimpleNamespace(get_task=AsyncMock(return_value=task), update_task_status=AsyncMock(return_value={'status': 'success'}))
    monkeypatch.setattr(route, 'task_service', service)
    monkeypatch.setattr(route, 'task_scheduler', scheduler[0])
    with pytest.raises(HTTPException) as error:
        await route.update_task_status('task', TaskStatusUpdate(status='active'), SimpleNamespace(user_id='alice', is_admin=lambda: False))
    assert error.value.status_code == 400
    service.update_task_status.assert_not_awaited()


async def test_cancelled_shutdown_still_finishes_job_cleanup(scheduler):
    manager, service = scheduler
    entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def execute(task):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()
    service.execute_task.side_effect = execute
    manager.initialize()
    original = manager.scheduler
    original.add_job(manager._execute_task_wrapper, DateTrigger(run_date=datetime.now()), args=[{'id': 'task'}])
    async with asyncio.timeout(3):
        await entered.wait()
        closing = asyncio.create_task(manager.shutdown())
        await cleanup.wait()
        closing.cancel()
        await asyncio.sleep(0)
        try:
            assert not closing.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await closing
    assert not original.running


@pytest.mark.parametrize('operation', ['create', 'activate'])
@pytest.mark.parametrize('persisted', [True, False])
async def test_schedule_failure_reports_only_confirmed_status(monkeypatch, set_required_env, operation, persisted):
    set_required_env()
    from fastapi import HTTPException
    from agent_graph.app.models.task_schema import TaskCreate, TaskStatusUpdate
    route = import_module('agent_graph.app.api.task_routes')
    task = {'id': 'task', 'user_id': 'alice', 'status': 'active', 'schedule_type': 'recurring',
            'schedule_config': {'cron_expression': '* * * * *'}}
    update = AsyncMock(return_value={'status': 'success' if persisted else 'error'})
    if operation == 'activate':
        update.side_effect = [{'status': 'success'}, {'status': 'success' if persisted else 'error'}]
    service = SimpleNamespace(create_task=AsyncMock(return_value={'status': 'success', 'task_id': 'task'}),
                              get_task=AsyncMock(side_effect=lambda *a, **kw: dict(task)), update_task_status=update)
    manager = SimpleNamespace(schedule_task=AsyncMock(return_value=False), remove_task=AsyncMock(return_value=True))
    monkeypatch.setattr(route, 'task_service', service)
    monkeypatch.setattr(route, 'task_scheduler', manager)
    user = SimpleNamespace(user_id='alice', is_admin=lambda: False)
    if operation == 'create':
        request = TaskCreate(task_name='task', graph_name='graph', input_text='input', schedule_type='recurring', schedule_config=task['schedule_config'])
        if persisted:
            result = await route.create_task(request, user)
            assert result['data']['task']['status'] == 'error'
        else:
            with pytest.raises(HTTPException) as error:
                await route.create_task(request, user)
            assert error.value.status_code == 500
            assert '保存error状态失败' in error.value.detail
    else:
        with pytest.raises(HTTPException) as error:
            await route.update_task_status('task', TaskStatusUpdate(status='active'), user)
        assert error.value.status_code == 500
        assert ('状态已设为error' if persisted else '保存error状态失败') in error.value.detail
    manager.remove_task.assert_awaited_once_with('task')
