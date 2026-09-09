import asyncio
from copy import deepcopy
import importlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_graph.app.api import model_routes
from agent_graph.app.auth.dependencies import get_current_user
from agent_graph.app.infrastructure.database.mongodb.repositories.model_config_repository import ModelConfigRepository
from agent_graph.app.models.auth_schema import CurrentUser
from agent_graph.app.services.model.model_service import ModelService


class MemoryCollection:
    """只替代 Mongo 集合 I/O，保留真实仓储的筛选、投影和更新逻辑。"""

    def __init__(self):
        self.documents = [
            {"name": "model", "user_id": user, "base_url": "http://127.0.0.1:1/v1", "model": "local", "api_key": key, "temperature": 0.3}
            for user, key in [("owner", "owner-public-test-key"), ("other", "other-public-test-key")]
        ]
        self.writes = []

    async def find_one(self, query, projection=None):
        result = next((deepcopy(row) for row in self.documents if all(row.get(key) == value for key, value in query.items())), None)
        if result is not None:
            for key, include in (projection or {}).items():
                if include == 0:
                    result.pop(key, None)
        return result

    async def insert_one(self, document):
        self.writes.append(("insert", deepcopy(document)))
        self.documents.append(deepcopy(document))
        return SimpleNamespace(inserted_id="created")

    async def update_one(self, query, changes):
        self.writes.append(("update", deepcopy(query), deepcopy(changes)))
        for row in self.documents:
            if all(row.get(key) == value for key, value in query.items()):
                row.update(deepcopy(changes["$set"]))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


@pytest.fixture
def models(monkeypatch):
    collection = MemoryCollection()
    service = ModelService()
    service.model_config_repository = ModelConfigRepository(None, collection)
    module = importlib.import_module("agent_graph.app.services.model.model_service")
    sdk = module.AsyncOpenAI
    clients = []

    def deny_network(_request):
        raise AssertionError("Model update must not call an upstream model")

    def create_client(**options):
        client = sdk(**options, http_client=httpx.AsyncClient(transport=httpx.MockTransport(deny_network), trust_env=False))
        clients.append(client)
        return client

    monkeypatch.setattr(module, "AsyncOpenAI", create_client)
    monkeypatch.setattr(model_routes, "model_service", service)
    app = FastAPI()
    app.include_router(model_routes.router)
    user = CurrentUser(user_id="owner", role="normal")
    app.dependency_overrides[get_current_user] = lambda: user
    client = TestClient(app)
    yield SimpleNamespace(collection=collection, service=service, user=user, app=app, client=client, clients=clients)
    client.close()

    async def close_clients():
        for model_client in clients:
            await model_client.close()

    asyncio.run(close_clients())


def update_body(**changes):
    return {"name": "model", "base_url": "http://127.0.0.1:1/v1", "model": "local", "temperature": 0.7} | changes


def stored(models, user="owner", name="model"):
    return next(row for row in models.collection.documents if row["user_id"] == user and row["name"] == name)


@pytest.mark.parametrize("key_field", [{}, {"api_key": None}, {"api_key": ""}], ids=["omitted", "null", "empty"])
def test_edit_without_new_key_preserves_stored_key_and_client_key(models, key_field):
    editing = models.client.get("/models/model").json()["data"]
    assert "api_key" not in editing
    response = models.client.put("/models/model", json=editing | {"temperature": 0.7} | key_field)
    assert response.status_code == 200
    assert stored(models)["temperature"] == 0.7
    assert stored(models)["api_key"] == "owner-public-test-key"
    assert models.service.clients["owner:model"].api_key == "owner-public-test-key"
    assert "api_key" not in models.client.get("/models/model").json()["data"]


def test_explicit_new_key_replaces_persistence_and_client(models):
    response = models.client.put("/models/model", json=update_body(api_key="new-public-test-key", provider="OPENAI", model_type="LLM", extra_body={"reasoning": {"enabled": True}}))
    assert response.status_code == 200
    assert stored(models)["api_key"] == models.service.clients["owner:model"].api_key == "new-public-test-key"
    assert stored(models)["provider"] == "openai"
    assert stored(models)["model_type"] == "llm"
    assert stored(models)["extra_body"] == {"reasoning": {"enabled": True}}


@pytest.mark.parametrize("key_field", [{}, {"api_key": None}, {"api_key": 1}])
def test_create_still_requires_a_string_key(models, key_field):
    response = models.client.post("/models", json=update_body(name="new") | key_field)
    assert response.status_code == 422
    assert any(error["loc"] == ["body", "api_key"] for error in response.json()["detail"])
    assert not models.collection.writes
    assert not models.clients


def test_local_provider_with_existing_empty_key_can_be_updated(models):
    stored(models)["api_key"] = ""
    response = models.client.put("/models/model", json=update_body())
    assert response.status_code == 200
    assert stored(models)["api_key"] == models.service.clients["owner:model"].api_key == ""


def test_create_preserves_existing_local_empty_key_compatibility(models):
    response = models.client.post("/models", json=update_body(name="local-empty", api_key=""))
    assert response.status_code == 200
    assert stored(models, name="local-empty")["api_key"] == ""


@pytest.mark.parametrize("changes,field", [({"api_key": 1}, "api_key"), ({"api_key": []}, "api_key"), ({"temperature": 2.1}, "temperature")])
def test_invalid_update_fields_still_fail_before_effects(models, changes, field):
    response = models.client.put("/models/model", json=update_body(**changes))
    assert response.status_code == 422
    assert any(error["loc"] == ["body", field] for error in response.json()["detail"])
    assert not models.collection.writes
    assert not models.clients


@pytest.mark.parametrize("user", ["owner", "other"])
def test_same_named_models_keep_each_authenticated_users_key(models, user):
    models.user.user_id = user
    other_user = "other" if user == "owner" else "owner"
    untouched = deepcopy(stored(models, user=other_user))
    response = models.client.put("/models/model", json=update_body(user_id=other_user))
    assert response.status_code == 200
    assert stored(models, user=user)["api_key"] == models.service.clients[f"{user}:model"].api_key == f"{user}-public-test-key"
    assert stored(models, user=other_user) == untouched
    assert models.collection.writes[0][1] == {"name": "model", "user_id": user}


@pytest.mark.parametrize("role", ["normal", "admin", "super_admin"])
def test_missing_owned_model_is_404_without_cross_user_updates(models, role):
    models.user.user_id = "unrelated"
    models.user.role = role
    response = models.client.put("/models/model", json=update_body())
    assert response.status_code == 404
    assert not models.collection.writes
    assert not models.clients


def test_rename_retains_key_and_moves_only_owned_client(models):
    old_client = SimpleNamespace()
    models.service.clients["owner:model"] = old_client
    response = models.client.put("/models/model", json=update_body(name="renamed"))
    assert response.status_code == 200
    assert stored(models, name="renamed")["api_key"] == models.service.clients["owner:renamed"].api_key == "owner-public-test-key"
    assert "owner:model" not in models.service.clients
    assert stored(models, user="other")["name"] == "model"


def test_rename_conflict_still_returns_400(models):
    models.collection.documents.append(deepcopy(stored(models)) | {"name": "taken"})
    response = models.client.put("/models/model", json=update_body(name="taken"))
    assert response.status_code == 400
    assert not models.collection.writes
    assert not models.clients


def test_openapi_keeps_create_key_required_and_other_update_requirements(models):
    schema = models.app.openapi()
    def request_schema(path, method):
        ref = schema["paths"][path][method]["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        return schema["components"]["schemas"][ref.rsplit("/", 1)[1]]
    create = request_schema("/models", "post")
    update = request_schema("/models/{model_name}", "put")
    assert set(create["required"]) == {"name", "base_url", "api_key", "model"}
    assert set(update["required"]) == {"name", "base_url", "model"}


def test_direct_service_update_resolves_key_without_mutating_input(models):
    body = update_body()
    before = deepcopy(body)
    assert asyncio.run(models.service.update_model("model", "owner", body)) is True
    assert body == before
    assert models.service.clients["owner:model"].api_key == "owner-public-test-key"


def test_direct_service_missing_model_does_not_construct_or_write(models):
    assert asyncio.run(models.service.update_model("missing", "owner", update_body())) is False
    assert not models.collection.writes
    assert not models.clients
