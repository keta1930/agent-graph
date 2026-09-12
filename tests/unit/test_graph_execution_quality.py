import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from agent_graph.app.services.agent.agent_run_service import AgentRunService
from agent_graph.app.services.agent.agent_stream_executor import AgentStreamExecutor
from agent_graph.app.services.graph.conversation_manager import ConversationManager
from agent_graph.app.services.graph.graph_executor import GraphExecutor
from agent_graph.app.services.graph.node_executor_core import NodeExecutorCore
from agent_graph.app.services.graph.message_creator import MessageCreator
from agent_graph.app.services.model.model_service import model_service


@pytest.fixture
def graph_context():
    conversation = {'conversation_id': 'c', 'graph_config': {'nodes': [{'name': 'a', 'level': 0}]}, 'rounds': [], 'execution_chain': [], '_current_round': 0}
    manager = ConversationManager()
    manager.active_conversations['c'] = conversation
    manager.create_conversation_with_config = AsyncMock(return_value='c')
    manager.update_conversation_file = AsyncMock(return_value=True)
    manager._get_final_output = AsyncMock(return_value='answer')
    graph = GraphExecutor(manager, None)
    graph.message_creator.record_user_input = AsyncMock()
    return SimpleNamespace(manager=manager, graph=graph, conversation=conversation)


async def test_node_failure_never_reports_graph_complete(graph_context):
    async def fail(*args, **kwargs):
        raise RuntimeError('node failed')
        yield
    graph_context.graph.node_executor_core.execute_node = fail
    chunks = [chunk async for chunk in graph_context.graph.execute_graph_stream('g', {}, 'hello')]
    assert sum('execution_error' in chunk for chunk in chunks) == 1
    assert not any('graph_complete' in chunk for chunk in chunks)
    graph_context.manager._get_final_output.assert_not_awaited()


async def test_agent_instruction_reaches_graph_messages(graph_context):
    core = NodeExecutorCore(graph_context.manager, None, MessageCreator(graph_context.manager))
    core.agent_stream_executor._load_effective_config = AsyncMock(return_value={'agent_name': 'agent', 'model_name': 'm', 'system_prompt': 'Instruction', 'mcp_servers': [], 'system_tools': [], 'max_iterations': 1})
    core._prepare_handoffs_tools = AsyncMock(return_value=[])
    core._prepare_mcp_tools = AsyncMock(return_value=[])
    captured = {}
    async def capture(**kwargs):
        captured.update(kwargs)
        raise RuntimeError('captured')
        yield
    core.agent_stream_executor.run_agent_loop = capture
    with pytest.raises(RuntimeError, match='captured'):
        await anext(core.execute_node({'name': 'a', 'agent_name': 'agent', 'user_prompt': 'hello'}, 'c'))
    assert captured['messages'][0] == {'role': 'system', 'content': 'Instruction'}


async def test_checkpoint_keeps_remaining_nodes_at_same_level(graph_context):
    graph_context.conversation['graph_config']['nodes'] = [{'name':'a','level':0}, {'name':'b','level':0}, {'name':'c','level':1}]
    graph_context.conversation['rounds'] = [{'node_name':'a','level':0}]
    resume = await graph_context.manager.check_execution_resumption_point('c')
    assert resume['from_level'] == 0
    assert resume['next_node'] == 'b'


async def test_agent_loop_closes_held_model_generator(monkeypatch):
    closed = asyncio.Event()
    async def model():
        try:
            yield 'data: {"x":1}\n\n'
        finally:
            closed.set()
    upstream = model()
    monkeypatch.setattr(model_service, 'stream_chat_with_tools', lambda **kwargs: upstream)
    stream = AgentStreamExecutor().run_agent_loop('a','m',[{'role':'user','content':'hi'}],[],[],1,'u','c')
    try:
        await anext(stream)
        await stream.aclose()
        assert closed.is_set()
    finally:
        await upstream.aclose()


@pytest.mark.parametrize('value', ['"text"', '{}', '[1]', '[null]'])
async def test_agent_tools_reject_wrong_json_shapes(value):
    with pytest.raises((ValueError, HTTPException)):
        await AgentRunService().validate_request_params('hello', None, 'm', 'u', value, None)


async def test_shared_driver_resumes_same_level_in_both_modes(graph_context):
    graph_context.conversation['graph_config']['nodes'] = [{'name':'a','level':0}, {'name':'b','level':0}, {'name':'c','level':1}]
    seen=[]
    async def node(node, *args, **kwargs):
        seen.append(node['name'])
        yield {'success':True, 'has_handoffs':False}
    graph_context.graph.node_executor_core.execute_node=node
    for stream in (False, True):
        seen.clear()
        graph_context.conversation['rounds']=[{'node_name':'a','level':0}]
        chunks=[item async for item in graph_context.graph.run_conversation('c', None, True, 'u', yield_sse=stream)]
        assert seen == ['b','c']
        assert bool(chunks) is stream


async def test_shared_driver_handoffs_uses_iteration_not_recursion(graph_context):
    graph_context.conversation['graph_config']['nodes']=[{'name':'a','level':0,'handoffs':2000}, {'name':'b','level':0}, {'name':'c','level':1}]
    calls=0
    seen=[]
    async def node(node,*args,**kwargs):
        nonlocal calls
        calls+=1
        seen.append(node['name'])
        yield {'success':True,'has_handoffs':calls < 1100,'selected_node':'a' if calls<1100 else None}
    graph_context.graph.node_executor_core.execute_node=node
    _=[item async for item in graph_context.graph.run_nodes('c','u',yield_sse=False)]
    assert calls == 1101
    assert seen[-1] == 'c'
    assert 'b' not in seen


async def test_graph_runtime_rejects_same_conversation_and_shutdown_joins_finally():
    from agent_graph.app.services.graph.execution_runtime import GraphExecutionRuntime
    runtime=GraphExecutionRuntime()
    entered=asyncio.Event()
    cleaned=asyncio.Event()
    async def work():
        async with runtime.execution('c'):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                cleaned.set()
    task=asyncio.create_task(work())
    await entered.wait()
    with pytest.raises(HTTPException) as error:
        runtime.claim('c')
    assert error.value.status_code==409
    async with runtime.execution('other'):
        pass
    await runtime.shutdown()
    assert task.done() and cleaned.is_set()
    assert not runtime.owners
    with pytest.raises(HTTPException) as error:
        runtime.claim('new')
    assert error.value.status_code==503


async def test_background_task_cancelled_before_start_releases_reservation():
    from agent_graph.app.services.graph.execution_runtime import GraphExecutionRuntime
    runtime=GraphExecutionRuntime()
    runtime.claim('c')
    async def run():
        await asyncio.Event().wait()
    task=runtime.spawn('c',run)
    await runtime.shutdown()
    assert task.done()
    assert not runtime.owners and not runtime.background_tasks


async def test_graph_stream_close_saves_and_releases_cache(graph_context):
    closed=asyncio.Event()
    async def node(*args,**kwargs):
        try:
            yield 'data: content\n\n'
        finally:
            closed.set()
    graph_context.graph.node_executor_core.execute_node=node
    stream=graph_context.graph.execute_graph_stream('g',{},'hello')
    while await anext(stream) != 'data: content\n\n':
        pass
    await stream.aclose()
    assert closed.is_set()
    assert not graph_context.manager.runtime.owners
    assert 'c' not in graph_context.manager.active_conversations


async def test_model_service_closes_sdk_stream_on_early_exit(monkeypatch):
    from agent_graph.app.services.model.model_service import ModelService
    from agent_graph.app.services.model.stream_handler import StreamHandler
    service=ModelService()
    sdk=SimpleNamespace(close=AsyncMock())
    service.clients['u:m']=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=sdk))))
    service.get_model=AsyncMock(return_value={'model':'remote'})
    async def chunks(*args):
        yield 'chunk'
    monkeypatch.setattr(StreamHandler,'stream_and_accumulate',chunks)
    stream=service.stream_chat_with_tools('m',[],user_id='u')
    assert await anext(stream)=='chunk'
    await stream.aclose()
    sdk.close.assert_awaited_once()


async def test_failed_snapshot_does_not_report_graph_complete(graph_context):
    async def node(*args,**kwargs):
        yield {'success':True}
    graph_context.graph.node_executor_core.execute_node=node
    graph_context.manager.update_conversation_file.return_value=False
    chunks=[chunk async for chunk in graph_context.graph.execute_graph_stream('g',{},'hello')]
    assert any('execution_error' in chunk for chunk in chunks)
    assert not any('graph_complete' in chunk for chunk in chunks)
    assert not graph_context.manager.runtime.owners


async def test_default_nullable_graph_tools_validate():
    from agent_graph.app.models.graph_schema import GraphConfig
    from agent_graph.app.services.graph.graph_processor import GraphProcessor
    config=GraphConfig(name='g',nodes=[{'name':'a','model_name':'m','input_nodes':['start'],'output_nodes':['end']}]).model_dump()
    processor=GraphProcessor(AsyncMock())
    valid,error=await processor.validate_graph(config, AsyncMock(return_value={'name':'m'}), lambda: {}, 'u')
    assert valid, error


async def test_background_shutdown_closes_node_before_releasing_cache(graph_context):
    from agent_graph.app.services.graph.background_executor import BackgroundExecutor
    background=BackgroundExecutor(graph_context.manager,None,graph_context.graph)
    entered=asyncio.Event()
    closed=asyncio.Event()
    async def node(*args,**kwargs):
        try:
            entered.set()
            await asyncio.Event().wait()
            yield {'success':True}
        finally:
            closed.set()
    graph_context.graph.node_executor_core.execute_node=node
    result=await background.execute_graph_background('g',{},'hello',user_id='u')
    assert result['status']=='started'
    await entered.wait()
    await graph_context.manager.runtime.shutdown()
    assert closed.is_set()
    assert 'c' not in graph_context.manager.active_conversations
    assert not background._pending


async def test_failed_graph_persists_failure_instead_of_completion(graph_context):
    async def node(*args, **kwargs):
        raise RuntimeError('upstream unavailable')
        yield
    graph_context.graph.node_executor_core.execute_node=node
    _=[item async for item in graph_context.graph.execute_graph_stream('g',{},'hello')]
    assert graph_context.conversation['execution_status']=='failed'
    assert graph_context.conversation['execution_error']=='upstream unavailable'
    assert graph_context.conversation['completed'] is False


async def test_resume_after_handoffs_target_skips_unselected_siblings(graph_context):
    graph_context.conversation['graph_config']['nodes']=[{'name':'source','level':0}, {'name':'chosen','level':1}, {'name':'other','level':1}, {'name':'next','level':2}]
    graph_context.conversation['rounds']=[{'node_name':'source','level':0,'messages':[{'role':'assistant','tool_calls':[{'function':{'name':'transfer_to_chosen'}}]}]}, {'node_name':'chosen','level':1}]
    plan=await graph_context.manager.check_execution_resumption_point('c')
    assert plan['from_level']==2


async def test_checkpoint_does_not_replay_stale_handoffs_selection(graph_context):
    graph_context.conversation['graph_config']['nodes']=[{'name':'a','level':0,'handoffs':1,'output_nodes':['a','end']}]
    graph_context.conversation['rounds']=[{'node_name':'a','level':0,'messages':[{'role':'assistant','content':'finished'}]}]
    graph_context.conversation['handoffs_status']={'a':{'used_count':1,'total_limit':1,'last_selection':'a'}}
    plan=await graph_context.manager.check_execution_resumption_point('c')
    assert plan['action']=='continue'
    assert plan['from_level']==1


@pytest.mark.parametrize('late_snapshot', [None, {'conversation_id': 'c', 'graph_config': {'nodes': []}, 'rounds': []}])
async def test_late_restore_preserves_execution_owned_conversation(monkeypatch, late_snapshot):
    from agent_graph.app.infrastructure.database.mongodb import mongodb_client
    manager = ConversationManager()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    reads = 0

    async def read(conversation_id):
        nonlocal reads
        reads += 1
        if reads == 1:
            first_started.set()
            await release_first.wait()
            return late_snapshot
        return {'conversation_id': 'c', 'graph_config': {'nodes': []}, 'rounds': []}

    monkeypatch.setattr(mongodb_client, 'get_graph_run_conversation', read)
    late_read = asyncio.create_task(manager.get_conversation('c'))
    try:
        await asyncio.wait_for(first_started.wait(), 1)
        owned = await manager.get_conversation('c')
        async with manager.runtime.execution('c'):
            owned['rounds'].append({'node_name': 'finished_a'})
            release_first.set()
            restored = await asyncio.wait_for(late_read, 1)
            assert restored is owned
            assert await manager.get_conversation('c') is owned
            assert restored['rounds'] == [{'node_name': 'finished_a'}]
    finally:
        release_first.set()
        await asyncio.gather(late_read, return_exceptions=True)


@pytest.mark.parametrize('interruption', ['cancel', 'timeout'])
async def test_interrupted_snapshot_stays_dirty_until_successful_retry(monkeypatch, interruption):
    from agent_graph.app.infrastructure.database.mongodb import mongodb_client
    manager = ConversationManager()
    conversation = {'conversation_id': 'c', 'graph_config': {'nodes': []}, 'rounds': []}
    manager.active_conversations['c'] = conversation
    executor = GraphExecutor(manager, None)
    saving = asyncio.Event()

    async def blocked_save(*args):
        saving.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(mongodb_client, 'update_graph_run_data', blocked_save)

    async def execute():
        async with executor.execution('c'):
            conversation['rounds'].append({'node_name': 'finished_a'})

    task = asyncio.create_task(execute())
    try:
        await asyncio.wait_for(saving.wait(), 1)
        if interruption == 'cancel':
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await asyncio.wait_for(task, 5)
        assert 'c' not in manager.runtime.owners
        assert 'c' in manager._dirty_conversation_ids
        for index in range(129):
            manager.active_conversations[str(index)] = {}
        manager._trim_cache()
        assert manager.active_conversations['c'] is conversation
        assert conversation['rounds'] == [{'node_name': 'finished_a'}]

        retry = AsyncMock(return_value=True)
        monkeypatch.setattr(mongodb_client, 'update_graph_run_data', retry)
        assert await manager.update_conversation_file('c') is True
        assert 'c' not in manager._dirty_conversation_ids
        assert retry.await_args.args[1]['rounds'] == [{'node_name': 'finished_a'}]
        manager._trim_cache()
        assert 'c' not in manager.active_conversations
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('missing_snapshot', [False, True])
async def test_late_restore_after_successful_release_reads_saved_rounds(monkeypatch, missing_snapshot):
    from agent_graph.app.infrastructure.database.mongodb import mongodb_client
    manager = ConversationManager()
    executor = GraphExecutor(manager, None)
    stored = {'conversation_id': 'c', 'graph_config': {'nodes': []}, 'rounds': []}
    started = asyncio.Event()
    release = asyncio.Event()
    reads = 0

    async def read(conversation_id):
        nonlocal reads
        reads += 1
        snapshot = copy.deepcopy(stored)
        if reads == 1:
            started.set()
            await release.wait()
            return None if missing_snapshot else snapshot
        return snapshot

    async def write(conversation_id, data):
        stored.update(copy.deepcopy(data))
        return True

    monkeypatch.setattr(mongodb_client, 'get_graph_run_conversation', read)
    monkeypatch.setattr(mongodb_client, 'update_graph_run_data', write)
    late = asyncio.create_task(manager.get_conversation('c'))
    try:
        await asyncio.wait_for(started.wait(), 1)
        async with executor.execution('c'):
            owned = await manager.get_conversation('c')
            owned['rounds'].append({'node_name': 'finished_a'})
        assert 'c' not in manager.active_conversations
        assert stored['rounds'] == [{'node_name': 'finished_a'}]
        release.set()
        restored = await asyncio.wait_for(late, 1)
        assert restored is not None
        assert restored['rounds'] == stored['rounds']
        assert await manager.get_conversation('c') is restored
        assert not manager._restore_reads
    finally:
        release.set()
        await asyncio.gather(late, return_exceptions=True)


@pytest.mark.parametrize('outcome', ['cancel', 'error', 'missing'])
async def test_restore_read_registration_is_released(monkeypatch, outcome):
    from agent_graph.app.infrastructure.database.mongodb import mongodb_client
    manager = ConversationManager()
    started = asyncio.Event()

    async def read(conversation_id):
        started.set()
        if outcome == 'cancel':
            await asyncio.Event().wait()
        if outcome == 'error':
            raise RuntimeError('read failed')
        return None

    monkeypatch.setattr(mongodb_client, 'get_graph_run_conversation', read)
    task = asyncio.create_task(manager.get_conversation('c'))
    try:
        await asyncio.wait_for(started.wait(), 1)
        if outcome == 'cancel':
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        elif outcome == 'error':
            with pytest.raises(RuntimeError, match='read failed'):
                await task
        else:
            assert await task is None
        assert not manager._restore_reads
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
