import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import anyio
import pytest

from agent_graph import mcp_client


@pytest.fixture
def connection(monkeypatch):
    entered = []
    exited = []
    initialized = asyncio.Event()
    release = asyncio.Event()
    release.set()
    failure = {}

    @asynccontextmanager
    async def transport(*args, **kwargs):
        try:
            async with anyio.create_task_group():
                entered.append(asyncio.current_task())
                yield (None, None)
        finally:
            exited.append(asyncio.current_task())

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def initialize(self):
            initialized.set()
            await release.wait()
            if failure.get('initialize'):
                raise RuntimeError('initialize failed')

        async def list_tools(self):
            if failure.get('list_tools'):
                raise RuntimeError('list_tools failed')
            return SimpleNamespace(tools=[SimpleNamespace(name='echo')])

    monkeypatch.setattr(mcp_client, 'sse_client', transport)
    monkeypatch.setattr(mcp_client, 'ClientSession', lambda *args: Session())
    return SimpleNamespace(
        entered=entered, exited=exited, initialized=initialized,
        release=release, failure=failure,
        make=lambda: mcp_client.MCPServer('test', {'transportType': 'sse', 'url': 'unused'}),
    )


async def test_connection_cleanup_exits_anyio_context_in_owning_task(connection):
    server = connection.make()
    assert await asyncio.create_task(server.connect())
    await asyncio.create_task(server.cleanup())
    assert connection.exited == connection.entered
    assert not server.is_connected()
    assert server.tools == []


@pytest.mark.parametrize('phase', ['initialize', 'list_tools'])
async def test_partial_connection_failure_releases_transport(connection, phase):
    connection.failure[phase] = True
    server = connection.make()
    try:
        assert not await server.connect()
        assert not server.is_connected()
        assert connection.exited == connection.entered
    finally:
        await server.cleanup()


async def test_cancelled_connection_waits_for_resource_cleanup(connection):
    connection.release.clear()
    server = connection.make()
    task = asyncio.create_task(server.connect())
    await connection.initialized.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert connection.exited == connection.entered
    assert not server.is_connected()


async def test_same_server_concurrent_connections_reuse_owner(connection):
    server = connection.make()
    try:
        assert await asyncio.gather(server.connect(), server.connect()) == [True, True]
        assert len(connection.entered) == 1
    finally:
        await server.cleanup()


async def test_different_servers_connect_concurrently(connection, monkeypatch):
    monkeypatch.setattr(mcp_client, 'CONFIG', {'mcpServers': {
        name: {'transportType': 'sse', 'url': 'unused'} for name in ['a', 'b']
    }})
    monkeypatch.setattr(mcp_client, 'SERVERS', {})
    connection.release.clear()
    tasks = [asyncio.create_task(mcp_client.connect_single_server(name)) for name in ['a', 'b']]
    try:
        async with asyncio.timeout(2):
            while len(connection.entered) != 2:
                await asyncio.sleep(0)
        connection.release.set()
        assert await asyncio.gather(*tasks) == [True, True]
    finally:
        connection.release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(server.cleanup() for server in mcp_client.SERVERS.values()))


@pytest.fixture(autouse=True)
def isolate_registry(monkeypatch):
    monkeypatch.setattr(mcp_client, '_server_locks', {})
    monkeypatch.setattr(mcp_client, '_config_lock', asyncio.Lock())
    monkeypatch.setattr(mcp_client, '_closing', False)
    monkeypatch.setattr(mcp_client, '_shutdown_task', None)
    monkeypatch.setattr(mcp_client, 'SERVERS', {})
    monkeypatch.setattr(mcp_client, 'CONFIG', {})


async def test_registry_same_name_connect_is_not_replaced_mid_handshake(connection):
    mcp_client.CONFIG = {'mcpServers': {'test': connection.make().config}}
    connection.release.clear()
    first = asyncio.create_task(mcp_client.connect_single_server('test'))
    await connection.initialized.wait()
    second = asyncio.create_task(mcp_client.connect_single_server('test'))
    connection.release.set()
    try:
        assert await asyncio.gather(first, second) == [True, True]
        assert len(connection.entered) == 1
    finally:
        await mcp_client._cleanup_servers()


@pytest.mark.parametrize('config', [{}, {'test': {'transportType': 'sse', 'url': 'new'}}])
async def test_config_update_waits_for_same_server_connection(connection, config):
    mcp_client.CONFIG = {'mcpServers': {'test': connection.make().config}}
    connection.release.clear()
    connect = asyncio.create_task(mcp_client.connect_single_server('test'))
    await connection.initialized.wait()
    old = mcp_client.SERVERS['test']
    update = asyncio.create_task(mcp_client.process_config_update({'mcpServers': config}))
    await asyncio.sleep(0)
    assert not update.done()
    connection.release.set()
    assert await connect
    assert await update
    assert not old.is_connected()
    assert connection.entered == connection.exited
    if config:
        assert mcp_client.SERVERS['test'] is not old
        assert mcp_client.SERVERS['test'].config == config['test']
    else:
        assert mcp_client.SERVERS == {}


async def test_cleanup_waits_for_active_tool_and_rejects_queued_calls(connection):
    server = connection.make()
    await server.connect()
    started = asyncio.Event()
    release = asyncio.Event()

    async def call(*args):
        started.set()
        await release.wait()
        return SimpleNamespace(content='done')

    server.session.call_tool = call
    active = asyncio.create_task(server.call_tool('echo', {}))
    await started.wait()
    cleanup = asyncio.create_task(server.cleanup())
    await asyncio.sleep(0)
    assert not cleanup.done()
    queued = asyncio.create_task(server.call_tool('echo', {}))
    release.set()
    assert (await active)['content'] == 'done'
    await cleanup
    with pytest.raises(RuntimeError, match='未连接'):
        await queued
    assert connection.entered == connection.exited


@pytest.mark.parametrize('force', [False, True])
async def test_ai_process_wait_runs_outside_event_loop(force):
    import subprocess
    import threading

    server = mcp_client.MCPServer('ai', {'ai_generated': True})
    entered = threading.Event()
    release = threading.Event()
    calls = []

    class Process:
        pid = 42

        def terminate(self):
            calls.append('terminate')

        def wait(self, timeout=None):
            calls.append(('wait', timeout))
            entered.set()
            assert release.wait(2)
            if force and timeout is not None:
                raise subprocess.TimeoutExpired('ai', timeout)

        def kill(self):
            calls.append('kill')

    server.ai_process = Process()
    cleanup = asyncio.create_task(server._cleanup_ai_process())
    try:
        async with asyncio.timeout(2):
            while not entered.is_set():
                await asyncio.sleep(0)
        assert not cleanup.done()
    finally:
        release.set()
        await cleanup
    assert server.ai_process is None
    assert calls == (['terminate', ('wait', 5), 'kill', ('wait', None)] if force else ['terminate', ('wait', 5)])


@pytest.mark.parametrize('config', [
    {'disabled': True}, {'transportType': 'unknown'},
    {'transportType': 'stdio'}, {'transportType': 'sse'}, {'transportType': 'streamable_http'},
])
async def test_invalid_configuration_never_starts_ai_process(config, monkeypatch):
    server = mcp_client.MCPServer('invalid', {**config, 'ai_generated': True})
    start = AsyncMock()
    monkeypatch.setattr(server, '_start_ai_process', start)
    assert not await server.connect()
    assert server.init_attempted
    assert not server.is_connected()
    start.assert_not_called()


async def test_connection_timeout_cleans_partial_transport(connection):
    connection.release.clear()
    server = connection.make()
    server.config['timeout'] = 0.02
    assert not await server.connect()
    assert not server.is_connected()
    assert connection.entered == connection.exited


async def test_cleanup_is_idempotent_and_reconnects(connection):
    server = connection.make()
    for _ in range(2):
        assert await asyncio.create_task(server.connect())
        await asyncio.gather(server.cleanup(), server.cleanup())
    assert len(connection.entered) == 2
    assert connection.entered == connection.exited


async def test_real_stdio_server_connect_call_disconnect_reconnect(tmp_path):
    import os
    import sys

    script = tmp_path / 'mcp_fixture.py'
    script.write_text('''from mcp.server.fastmcp import FastMCP
import os
app = FastMCP("lifecycle-fixture")
@app.tool()
def process_id() -> int:
    return os.getpid()
app.run(transport="stdio")
''')
    server = mcp_client.MCPServer('real', {
        'command': sys.executable, 'args': [str(script)], 'timeout': 10,
    })
    for _ in range(2):
        try:
            assert await asyncio.create_task(server.connect())
            result = await server.call_tool('process_id', {})
            pid = int(result['content'][0].text)
        finally:
            await asyncio.create_task(server.cleanup())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


async def test_cancelled_cleanup_still_waits_for_active_tool(connection):
    server = connection.make()
    await server.connect()
    started = asyncio.Event()
    release = asyncio.Event()

    async def call(*args):
        started.set()
        await release.wait()
        assert server.session is not None
        return SimpleNamespace(content='done')

    server.session.call_tool = call
    active = asyncio.create_task(server.call_tool('echo', {}))
    await started.wait()
    cleanup = asyncio.create_task(server.cleanup())
    await asyncio.sleep(0)
    cleanup.cancel()
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(cleanup), 0.02)
        assert server.session is not None
    finally:
        release.set()
        await asyncio.gather(active, cleanup, return_exceptions=True)
    assert connection.entered == connection.exited


async def test_success_marks_initialization_attempted(connection):
    server = connection.make()
    try:
        assert await server.connect()
        assert server.init_attempted
    finally:
        await server.cleanup()


@pytest.mark.parametrize('transport_name', ['stdio', 'sse', 'streamable_http'])
async def test_supported_transports_publish_tools_after_handshake(connection, monkeypatch, transport_name):
    transport = mcp_client.sse_client
    monkeypatch.setattr(mcp_client, 'stdio_client', transport)

    @asynccontextmanager
    async def http_transport(**kwargs):
        async with transport(**kwargs) as streams:
            yield (*streams, lambda: 'session-id')

    monkeypatch.setattr(mcp_client, 'streamablehttp_client', http_transport)
    server = mcp_client.MCPServer('transport', {
        'transportType': transport_name, 'url': 'unused', 'command': 'unused',
    })
    try:
        assert await server.connect()
        assert [tool.name for tool in server.tools] == ['echo']
    finally:
        await server.cleanup()
    assert connection.entered == connection.exited


async def test_transport_background_failure_finishes_owner(connection, monkeypatch):
    fail = asyncio.Event()
    entered = []
    exited = []

    async def child():
        await fail.wait()
        raise RuntimeError('transport failed')

    @asynccontextmanager
    async def transport(**kwargs):
        try:
            async with anyio.create_task_group() as group:
                entered.append(asyncio.current_task())
                group.start_soon(child)
                yield (None, None)
        finally:
            exited.append(asyncio.current_task())

    monkeypatch.setattr(mcp_client, 'sse_client', transport)
    server = connection.make()
    assert await server.connect()
    owner = server._owner
    fail.set()
    async with asyncio.timeout(2):
        await asyncio.shield(owner)
    assert not server.is_connected()
    assert server.session is None
    assert entered == exited
    await server.cleanup()


async def test_http_connection_lifecycle_and_shutdown_cleanup(connection):
    import httpx

    async with mcp_client.lifespan(mcp_client.app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=mcp_client.app), base_url='http://test') as client:
            response = await client.post('/load_config', json={'config': {'mcpServers': {'test': connection.make().config}}})
            assert response.status_code == 200
            assert response.json()['status'] == 'accepted'
            response = await client.post('/connect_server', json={'server_name': 'test'})
            assert response.json() == {'status': 'connected', 'server': 'test', 'tools': ['echo']}
            status = (await client.get('/servers')).json()['test']
            assert status['connected'] and status['init_attempted']
            response = await client.post('/disconnect_server', json={'server_name': 'test'})
            assert response.json()['status'] == 'disconnected'
            assert (await client.post('/connect_server', json={'server_name': 'test'})).status_code == 200
    assert mcp_client.SERVERS == {}
    assert connection.entered == connection.exited
    assert not await mcp_client.connect_single_server('test')
    assert not await mcp_client.process_config_update({'mcpServers': {}})


@pytest.mark.parametrize('mode', ['cancel', 'timeout'])
async def test_ai_spawn_cancellation_waits_for_worker_and_reclaims_process(monkeypatch, mode):
    import threading

    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    stopped = []
    server = mcp_client.MCPServer('ai-spawn', {
        'ai_generated': True, 'transportType': 'sse', 'url': 'unused',
        'timeout': 0.02 if mode == 'timeout' else 10,
    })

    class Process:
        def terminate(self):
            stopped.append('terminate')

        def wait(self, timeout):
            stopped.append(('wait', timeout))

    def spawn():
        entered.set()
        assert release.wait(2)
        server.ai_process = Process()
        finished.set()
        return True

    monkeypatch.setattr(server, '_spawn_ai_process', spawn)
    connect = asyncio.create_task(server.connect())
    try:
        async with asyncio.timeout(2):
            while not entered.is_set():
                await asyncio.sleep(0)
        if mode == 'cancel':
            connect.cancel()
        else:
            async with asyncio.timeout(2):
                while not server._owner.cancelling():
                    await asyncio.sleep(0)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(connect), 0.02)
        assert not finished.is_set()
        release.set()
        if mode == 'cancel':
            with pytest.raises(asyncio.CancelledError):
                await connect
        else:
            assert not await connect
        assert finished.is_set()
        assert server._owner.done()
        assert server.ai_process is None
        assert stopped == ['terminate', ('wait', 5)]
    finally:
        release.set()
        await asyncio.gather(connect, return_exceptions=True)
        async with asyncio.timeout(2):
            while not finished.is_set():
                await asyncio.sleep(0)
        await server.cleanup()
        await server._cleanup_ai_process()


@pytest.mark.parametrize('extra', [{}, {'env': None}, {'env': {}}, {'env': {'MCP_ENV_TEST': 'custom'}}])
async def test_stdio_environment_accepts_missing_null_and_custom_mapping(connection, monkeypatch, extra):
    received = []
    transport = mcp_client.sse_client

    @asynccontextmanager
    async def stdio(parameters):
        received.append(parameters.env)
        async with transport() as streams:
            yield streams

    monkeypatch.setattr(mcp_client, 'stdio_client', stdio)
    monkeypatch.setenv('MCP_ENV_TEST', 'inherited')
    server = mcp_client.MCPServer('environment', {'command': 'unused', **extra})
    try:
        assert await server.connect()
        assert received[0]['MCP_ENV_TEST'] == (extra.get('env') or {}).get('MCP_ENV_TEST', 'inherited')
    finally:
        await server.cleanup()
