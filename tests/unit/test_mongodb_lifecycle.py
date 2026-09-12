import asyncio
from importlib import import_module
from unittest.mock import AsyncMock, Mock

import pytest


module = import_module('agent_graph.app.infrastructure.database.mongodb.client')


@pytest.fixture
def database(monkeypatch):
    motor = Mock()
    motor.__getitem__ = Mock(return_value=Mock())
    motor.admin.command = AsyncMock()
    monkeypatch.setattr(module, 'AsyncIOMotorClient', Mock(return_value=motor))
    client = module.MongoDBClient()
    monkeypatch.setattr(client, '_create_indexes', AsyncMock())
    return client, motor


def assert_disconnected(client):
    assert not client.is_connected
    assert client.client is None
    assert client.db is None
    assert all(value is None for name, value in vars(client).items() if name.endswith(('_collection', '_repository')))


@pytest.mark.parametrize('phase', ['ping', 'indexes', 'repositories'])
async def test_initialize_failure_closes_and_clears_client(database, monkeypatch, phase):
    client, motor = database
    if phase == 'ping':
        motor.admin.command.side_effect = RuntimeError('failed')
    elif phase == 'indexes':
        client._create_indexes.side_effect = RuntimeError('failed')
    else:
        monkeypatch.setattr(client, '_initialize_managers', Mock(side_effect=RuntimeError('failed')))
    with pytest.raises(RuntimeError, match='failed'):
        await client.initialize('unused', 'test')
    motor.close.assert_called_once()
    assert_disconnected(client)


async def test_initialize_cancellation_closes_client(database):
    client, motor = database
    entered = asyncio.Event()

    async def ping(*args):
        entered.set()
        await asyncio.Event().wait()

    motor.admin.command.side_effect = ping
    initialize = asyncio.create_task(client.initialize('unused', 'test'))
    await entered.wait()
    initialize.cancel()
    with pytest.raises(asyncio.CancelledError):
        await initialize
    motor.close.assert_called_once()
    assert_disconnected(client)


async def test_disconnect_is_idempotent_and_resets_repositories(database):
    client, motor = database
    await client.initialize('unused', 'test')
    assert client.user_repository is not None
    await client.disconnect()
    await client.disconnect()
    motor.close.assert_called_once()
    assert_disconnected(client)


async def test_reinitialize_closes_old_client(database):
    client, motor = database
    await client.initialize('unused', 'test')
    await client.initialize('unused', 'test')
    assert motor.close.call_count == 1
    assert client.is_connected
    await client.disconnect()


async def test_close_failure_still_resets_local_state(database):
    client, motor = database
    await client.initialize('unused', 'test')
    motor.close.side_effect = RuntimeError('close failed')
    with pytest.raises(RuntimeError, match='close failed'):
        await client.disconnect()
    assert_disconnected(client)
