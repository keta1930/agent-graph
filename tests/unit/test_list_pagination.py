from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_graph.app.api import agent_routes, conversation_routes
from agent_graph.app.auth.dependencies import get_current_user
from agent_graph.app.infrastructure.database.mongodb.client import mongodb_client
from agent_graph.app.infrastructure.database.mongodb.repositories.agent_repository import AgentRepository
from agent_graph.app.infrastructure.database.mongodb.repositories.conversation_repository import ConversationRepository
from agent_graph.app.models.auth_schema import CurrentUser


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, keys, direction=None):
        for field, order in reversed([(keys, direction)] if isinstance(keys, str) else keys):
            self.documents.sort(key=lambda doc: doc[field], reverse=order < 0)
        return self

    def skip(self, count):
        self.documents = self.documents[count:]
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, length=None):
        return self.documents[:length]

    def __aiter__(self):
        self.iterator = iter(self.documents)
        return self

    async def __anext__(self):
        try:
            return next(self.iterator)
        except StopIteration:
            raise StopAsyncIteration


class Collection:
    def __init__(self, documents):
        self.documents = documents
        self.failure = False

    def find(self, query):
        if self.failure:
            raise RuntimeError('database offline')
        def matches(document):
            for key, value in query.items():
                actual = document
                for part in key.split('.'):
                    actual = actual.get(part)
                if actual != value:
                    return False
            return True
        return Cursor([dict(document) for document in self.documents if matches(document)])

    async def count_documents(self, query):
        return len(self.find(query).documents)


@pytest.fixture
def lists(monkeypatch):
    conversations = Collection([])
    agents = Collection([])
    monkeypatch.setattr(mongodb_client, 'conversation_repository', ConversationRepository(None, conversations))
    monkeypatch.setattr(mongodb_client, 'agent_repository', AgentRepository(None, agents))
    app = FastAPI()
    app.include_router(conversation_routes.router)
    app.include_router(agent_routes.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(user_id='owner', role='normal')
    return TestClient(app), conversations, agents


def document(index, user_id='owner'):
    return {'_id': f'{index:04}', 'user_id': user_id, 'type': 'agent' if index % 2 else 'graph',
            'status': ['active', 'favorite', 'deleted'][index % 3], 'project_id': f'project-{index % 2}',
            'created_at': datetime(2026, 1, 1), 'updated_at': datetime(2026, 1, 1),
            'agent_config': {'name': f'agent-{index}', 'category': 'coding' if index % 2 else 'writing', 'model': 'model'}}


@pytest.mark.parametrize('total', [0, 100, 101, 200, 201, 400])
@pytest.mark.parametrize('resource,key,default_limit', [('conversations', 'conversations', 200), ('agent/list', 'agents', 100)])
def test_pages_return_true_total_and_stable_complete_order(lists, total, resource, key, default_limit):
    client, conversations, agents = lists
    collection = conversations if key == 'conversations' else agents
    collection.documents = [document(index) for index in range(total)] + [document(9000, 'other')]
    first = client.get(f'/{resource}').json()
    assert first['total_count'] == total
    assert len(first[key]) == min(total, default_limit)
    items = []
    for offset in range(0, max(1, total), 100):
        response = client.get(f'/{resource}', params={'limit': 100, 'skip': offset})
        assert response.status_code == 200
        assert response.json()['total_count'] == total
        items.extend(response.json()[key])
    identifier = 'conversation_id' if key == 'conversations' else 'name'
    expected = [f'{index:04}' if key == 'conversations' else f'agent-{index}' for index in reversed(range(total))]
    assert [item[identifier] for item in items] == expected


@pytest.mark.parametrize('params', [{'limit': 0}, {'limit': -1}, {'limit': 201}, {'skip': -1}])
@pytest.mark.parametrize('path', ['/conversations', '/agent/list'])
def test_page_bounds_reject_invalid_values(lists, params, path):
    assert lists[0].get(path, params=params).status_code == 422


def test_category_count_uses_same_filter_as_page(lists):
    client, _, agents = lists
    agents.documents = [document(index) for index in range(401)] + [document(9001, 'other')]
    response = client.get('/agent/list', params={'category': 'coding', 'limit': 100, 'skip': 100}).json()
    assert response['total_count'] == 200
    assert len(response['agents']) == 100
    assert all(agent['category'] == 'coding' for agent in response['agents'])


@pytest.mark.asyncio
async def test_conversation_count_matches_user_type_project_and_includes_every_status(lists):
    _, conversations, _ = lists
    conversations.documents = [document(index) for index in range(401)] + [document(9001, 'other')]
    repository = mongodb_client.conversation_repository
    filters = {'user_id': 'owner', 'conversation_type': 'agent', 'project_id': 'project-1'}
    assert await repository.count_conversations(**filters) == 200
    page = await repository.list_conversations(**filters, limit=200)
    assert len(page) == 200
    assert {item['status'] for item in page} == {'active', 'favorite', 'deleted'}


@pytest.mark.parametrize('path', ['/conversations', '/agent/list'])
def test_database_failure_is_not_a_successful_empty_page(lists, path):
    client, conversations, agents = lists
    conversations.failure = agents.failure = True
    assert client.get(path).status_code == 500


@pytest.mark.parametrize('path', ['/conversations', '/agent/list'])
def test_count_failure_is_not_returned_as_zero(lists, path, monkeypatch):
    client, conversations, agents = lists
    collection = conversations if path == '/conversations' else agents
    collection.documents = [document(0)]
    monkeypatch.setattr(collection, 'count_documents', AsyncMock(side_effect=RuntimeError('count unavailable')))
    assert client.get(path).status_code == 500
