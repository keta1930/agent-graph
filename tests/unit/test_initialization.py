import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pymongo.errors import DuplicateKeyError

from agent_graph.app.core import initialization


@pytest.mark.parametrize('existing, error', [
    (True, None), (False, None), (False, DuplicateKeyError('duplicate')),
])
async def test_super_admin_initialization_is_idempotent(monkeypatch, test_settings, existing, error):
    collection = SimpleNamespace(
        find_one=AsyncMock(return_value={'user_id': 'admin'} if existing else None),
        insert_one=AsyncMock(side_effect=error),
    )
    monkeypatch.setattr(initialization, 'settings', test_settings)
    monkeypatch.setattr(initialization.mongodb_client, 'users_collection', collection)
    thread_ids = []

    def hash_password(password):
        thread_ids.append(threading.get_ident())
        return 'password-hash'

    monkeypatch.setattr(initialization, 'hash_password', hash_password)
    await initialization.initialize_super_admin()
    if existing:
        collection.insert_one.assert_not_awaited()
        assert thread_ids == []
    else:
        collection.insert_one.assert_awaited_once()
        assert collection.insert_one.call_args.args[0]['password_hash'] == 'password-hash'
        assert thread_ids and thread_ids[0] != threading.get_ident()


async def test_super_admin_initialization_propagates_database_failure(monkeypatch, test_settings):
    collection = SimpleNamespace(find_one=AsyncMock(return_value=None), insert_one=AsyncMock(side_effect=RuntimeError('db failed')))
    monkeypatch.setattr(initialization, 'settings', test_settings)
    monkeypatch.setattr(initialization.mongodb_client, 'users_collection', collection)
    monkeypatch.setattr(initialization, 'hash_password', lambda password: 'hash')
    with pytest.raises(RuntimeError, match='db failed'):
        await initialization.initialize_super_admin()
