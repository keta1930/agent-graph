import asyncio
from datetime import datetime, timedelta, timezone
from importlib import import_module
from threading import get_ident
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException


@pytest.fixture
def user_service(monkeypatch, set_required_env):
    set_required_env()
    module = import_module('agent_graph.app.services.user.user_service')
    repository = SimpleNamespace(
        get_user_by_id=AsyncMock(return_value={'user_id': 'alice', 'role': 'user', 'is_active': True, 'password_hash': 'hash'}),
        update_last_login=AsyncMock(), user_exists=AsyncMock(return_value=False),
        create_user=AsyncMock(return_value={'user_id': 'alice', 'role': 'user', 'password_hash': 'hash'}),
    )
    invite = SimpleNamespace(validate_invite_code=AsyncMock(return_value=(True, None)), increment_invite_code_usage=AsyncMock())
    return module, module.UserService(repository, invite), repository


@pytest.mark.parametrize('operation', ['login', 'register'])
async def test_bcrypt_operations_off_event_loop(user_service, monkeypatch, operation):
    module, service, repository = user_service
    loop_thread = get_ident()
    threads = []
    def crypto(*args):
        threads.append(get_ident())
        return True if operation == 'login' else 'hash'
    monkeypatch.setattr(module, 'verify_password', crypto)
    monkeypatch.setattr(module, 'hash_password', crypto)
    if operation == 'login':
        assert await service.authenticate_user('alice', 'password')
        repository.update_last_login.assert_awaited_once()
    else:
        assert await service.register_user('alice', 'password', 'invite')
    assert threads and all(thread != loop_thread for thread in threads)


class TokenCollection:
    """按 Mongo 单文档条件写语义模拟竞争消费。"""
    def __init__(self):
        self.token = {'token_id': 'old', 'user_id': 'alice', 'is_revoked': False,
                      'expires_at': datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)}
    async def find_one(self, query):
        return dict(self.token)
    async def update_one(self, query, update):
        matches = all(self.token.get(key) > value['$gt'] if isinstance(value, dict) else self.token.get(key) == value
                      for key, value in query.items())
        if matches:
            self.token.update(update['$set'])
        return SimpleNamespace(modified_count=int(matches))


@pytest.fixture
def refresh(monkeypatch, set_required_env):
    set_required_env()
    route = import_module('agent_graph.app.api.auth_routes')
    repo_module = import_module('agent_graph.app.infrastructure.database.mongodb.repositories.refresh_token_repository')
    collection = TokenCollection()
    repo = repo_module.RefreshTokenRepository(None, collection)
    repo.create_refresh_token = AsyncMock(return_value={'token_id': 'new'})
    user = SimpleNamespace(get_user_info=AsyncMock(return_value={'user_id': 'alice', 'role': 'user', 'is_active': True}))
    monkeypatch.setattr(route, 'mongodb_client', SimpleNamespace(refresh_token_repository=repo))
    monkeypatch.setattr(route, 'get_user_service', lambda: user)
    monkeypatch.setattr(route, 'verify_refresh_token', lambda token: {'sub': 'alice', 'jti': 'old'})
    monkeypatch.setattr(route, 'create_tokens', lambda **kw: ('access', 'refresh', 'new', collection.token['expires_at']))
    return route, repo, user, collection


async def test_concurrent_refresh_only_one_consumes_token(refresh):
    route, repo, user, _ = refresh
    ready, both_ready = 0, asyncio.Event()
    async def get_user(user_id):
        nonlocal ready
        ready += 1
        if ready == 2:
            both_ready.set()
        await both_ready.wait()
        return {'user_id': 'alice', 'role': 'user', 'is_active': True}
    user.get_user_info.side_effect = get_user
    request = route.RefreshTokenRequest(refresh_token='token')
    results = await asyncio.gather(route.refresh_token(request), route.refresh_token(request), return_exceptions=True)
    assert sum(not isinstance(result, Exception) for result in results) == 1
    assert sum(isinstance(result, HTTPException) and result.status_code == 401 for result in results) == 1
    repo.create_refresh_token.assert_awaited_once()


async def test_refresh_storage_failure_never_returns_tokens(refresh):
    route, repo, _, collection = refresh
    repo.create_refresh_token.side_effect = OSError('storage unavailable')
    with pytest.raises(HTTPException):
        await route.refresh_token(route.RefreshTokenRequest(refresh_token='token'))
    assert collection.token['is_revoked'] is True


@pytest.mark.parametrize('invalid', ['revoked', 'expired', 'owner'])
async def test_atomic_consume_rejects_invalid_token(refresh, invalid):
    _, repo, _, collection = refresh
    if invalid == 'revoked':
        collection.token['is_revoked'] = True
    elif invalid == 'expired':
        collection.token['expires_at'] = datetime(2000, 1, 1)
    else:
        collection.token['user_id'] = 'bob'
    assert await repo.consume_refresh_token('old', 'alice') is False


async def test_login_storage_failure_never_returns_unusable_tokens(refresh):
    route, repo, user, _ = refresh
    user.authenticate_user = AsyncMock(return_value={'user_id': 'alice', 'role': 'user'})
    repo.create_refresh_token.side_effect = OSError('storage unavailable')
    with pytest.raises(HTTPException) as error:
        await route.login(route.UserLoginRequest(user_id='alice', password='password'))
    assert error.value.status_code == 500
