import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from agent_graph.app.api import agent_routes, graph_routes
from agent_graph.app.auth.dependencies import get_current_user
from agent_graph.app.infrastructure.database.mongodb.client import mongodb_client
from agent_graph.app.models.auth_schema import CurrentUser
from agent_graph.app.models.graph_schema import GraphInput
from agent_graph.app.services.agent.agent_run_service import AgentRunService, agent_run_service
from agent_graph.app.services.graph.graph_service import graph_service


@pytest.fixture
def execution(monkeypatch):
    document = {"_id": "existing", "user_id": "owner", "type": "agent"}
    repository = SimpleNamespace(
        get_conversation=AsyncMock(side_effect=lambda _id: document),
        create_conversation=AsyncMock(return_value=True),
        update_conversation_title_and_tags=AsyncMock(),
    )
    runs = SimpleNamespace(create_agent_run=AsyncMock(), get_agent_run=AsyncMock())
    monkeypatch.setattr(mongodb_client, "conversation_repository", repository)
    monkeypatch.setattr(mongodb_client, "agent_run_repository", runs)
    monkeypatch.setattr(mongodb_client, "agent_repository", SimpleNamespace(get_agent=AsyncMock(return_value={})))
    monkeypatch.setattr(mongodb_client, "user_repository", SimpleNamespace(get_user_language=AsyncMock(return_value="en")))
    count = AsyncMock()
    monkeypatch.setattr(mongodb_client, "update_project_conversation_count", count)
    monkeypatch.setattr(mongodb_client, "get_project", AsyncMock(return_value={"_id": "project"}))
    files = AsyncMock(return_value=[])
    title = Mock()
    monkeypatch.setattr(agent_run_service, "process_files", files)
    monkeypatch.setattr(agent_run_service, "create_title_generator", title)
    model = AsyncMock(return_value=None)
    monkeypatch.setattr(agent_routes.agent_stream_executor, "_load_effective_config", model)
    manager = SimpleNamespace(
        get_conversation=AsyncMock(return_value={"graph_config": {}, "rounds": [], "user_id": "untrusted-cache"}),
        update_conversation_file=AsyncMock(),
        check_execution_resumption_point=AsyncMock(return_value={"action": "continue", "from_level": 0}),
        _get_final_output=AsyncMock(return_value="finished"),
    )
    monkeypatch.setattr(graph_service, "conversation_manager", manager)
    monkeypatch.setattr(graph_service.executor, "conversation_manager", manager)
    monkeypatch.setattr(graph_service.background_executor, "conversation_manager", manager)
    monkeypatch.setattr(graph_service, "get_graph", AsyncMock(return_value={"config": {}}))
    monkeypatch.setattr(graph_service, "detect_graph_cycles", AsyncMock(return_value=None))
    preprocess = AsyncMock(return_value={})
    monkeypatch.setattr(graph_service, "_preprocess_graph_prompts", preprocess)
    record = AsyncMock()
    monkeypatch.setattr(graph_service.executor.message_creator, "record_user_input", record)
    monkeypatch.setattr(graph_service.background_executor.message_creator, "record_user_input", record)
    app = FastAPI()
    app.include_router(agent_routes.router)
    app.include_router(graph_routes.router)
    current_user = CurrentUser(user_id="intruder", role="normal")
    app.dependency_overrides[get_current_user] = lambda: current_user
    return SimpleNamespace(
        document=document, repository=repository, runs=runs, count=count,
        files=files, title=title, model=model, manager=manager,
        record=record, preprocess=preprocess, user=current_user, client=TestClient(app),
    )


def assert_no_effects(execution):
    execution.repository.create_conversation.assert_not_awaited()
    execution.repository.update_conversation_title_and_tags.assert_not_awaited()
    execution.runs.create_agent_run.assert_not_awaited()
    execution.runs.get_agent_run.assert_not_awaited()
    execution.count.assert_not_awaited()
    execution.files.assert_not_awaited()
    execution.title.assert_not_called()
    execution.model.assert_not_awaited()
    execution.manager.get_conversation.assert_not_awaited()
    execution.manager.check_execution_resumption_point.assert_not_awaited()
    execution.manager.update_conversation_file.assert_not_awaited()
    execution.record.assert_not_awaited()
    execution.preprocess.assert_not_awaited()


@pytest.mark.parametrize("role", ["normal", "admin", "super_admin"])
@pytest.mark.parametrize("upload", [False, True])
@pytest.mark.parametrize("stream", [False, True])
def test_agent_route_rejects_other_owner_before_effects(execution, role, upload, stream):
    execution.user.role = role
    response = execution.client.post(
        "/agent/run",
        data={"user_prompt": "hello", "model_name": "valid", "conversation_id": "existing", "project_id": "project", "stream": str(stream).lower()},
        files={"files": ("note.txt", b"private")} if upload else None,
    )
    assert response.status_code == 403
    assert_no_effects(execution)


def test_agent_route_rejects_wrong_type(execution):
    execution.user.user_id = "owner"
    execution.document["type"] = "graph"
    response = execution.client.post("/agent/run", data={"user_prompt": "hello", "model_name": "valid", "conversation_id": "existing"})
    assert response.status_code == 400
    assert_no_effects(execution)


@pytest.mark.parametrize("role", ["normal", "admin", "super_admin"])
@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("checkpoint", [False, True])
def test_graph_route_rejects_other_owner_before_response_or_task(execution, role, background, checkpoint):
    execution.document["type"] = "graph"
    execution.user.role = role
    response = execution.client.post("/graphs/execute", json={"graph_name": "valid", "input_text": "hello", "conversation_id": "existing", "background": background, "continue_from_checkpoint": checkpoint})
    assert response.status_code == 403
    assert_no_effects(execution)


@pytest.mark.parametrize("background", [False, True])
def test_graph_route_rejects_wrong_type(execution, background):
    execution.user.user_id = "owner"
    response = execution.client.post("/graphs/execute", json={"graph_name": "valid", "conversation_id": "existing", "background": background})
    assert response.status_code == 400
    assert_no_effects(execution)


@pytest.mark.parametrize("entry", ["service_stream", "service_background", "executor_stream", "executor_background", "agent_executor"])
async def test_direct_execution_entries_reject_other_owner(execution, entry):
    execution.document["type"] = "agent" if entry == "agent_executor" else "graph"
    with pytest.raises(HTTPException) as error:
        if entry == "service_background":
            await graph_service.execute_graph_background("valid", "hello", {}, "existing", user_id="intruder")
        elif entry == "executor_background":
            await graph_service.background_executor.continue_conversation_background("existing", "hello", user_id="intruder")
        else:
            if entry == "agent_executor":
                stream = agent_routes.agent_stream_executor.run_agent_stream(None, "hello", "intruder", "existing", model_name="valid")
            else:
                owner = graph_service if entry == "service_stream" else graph_service.executor
                stream = owner.continue_conversation_stream("existing", "hello", continue_from_checkpoint=True, user_id="intruder")
            _ = [chunk async for chunk in stream]
    assert error.value.status_code == 403
    assert_no_effects(execution)


@pytest.mark.parametrize("conversation_id", [None, "new-id"])
async def test_agent_creates_missing_conversation(execution, conversation_id):
    execution.repository.get_conversation.side_effect = None
    execution.repository.get_conversation.return_value = None
    result_id, is_new = await agent_run_service.ensure_conversation_exists(conversation_id, "owner", None, "project")
    assert is_new
    assert result_id
    if conversation_id:
        assert result_id == conversation_id
    execution.repository.create_conversation.assert_awaited_once()
    execution.runs.create_agent_run.assert_awaited_once_with(conversation_id=result_id)
    execution.count.assert_awaited_once_with("project", 1)


async def test_agent_reuses_owned_conversation(execution):
    assert await agent_run_service.ensure_conversation_exists("existing", "owner", None) == ("existing", False)
    assert_no_effects(execution)


@pytest.mark.parametrize("background", [False, True])
def test_graph_missing_target_is_404(execution, background):
    execution.repository.get_conversation.side_effect = None
    execution.repository.get_conversation.return_value = None
    response = execution.client.post("/graphs/execute", json={"graph_name": "valid", "conversation_id": "missing", "background": background})
    assert response.status_code == 404
    assert_no_effects(execution)


@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("checkpoint", [False, True])
async def test_owned_graph_continues_with_authenticated_user(execution, monkeypatch, background, checkpoint):
    execution.document["type"] = "graph"
    execution.user.user_id = "owner"
    seen_users = []

    async def run_levels(*_args):
        seen_users.append(_args[-1])
        yield 'data: {"content":"finished"}\n\n'

    monkeypatch.setattr(graph_service.executor, "_execute_graph_by_level_sequential_stream", run_levels)
    monkeypatch.setattr(graph_service.executor, "_continue_graph_by_level_sequential_stream", run_levels)
    background_task = AsyncMock()
    monkeypatch.setattr(graph_service.background_executor, "_continue_conversation_background_task", background_task)
    response = await graph_routes.execute_graph(
        GraphInput(graph_name="valid", conversation_id="existing", input_text="hello", background=background, continue_from_checkpoint=checkpoint),
        execution.user,
    )
    if background:
        assert response.status_code == 200
        await asyncio.sleep(0)
        background_task.assert_awaited_once_with("existing", graph_routes.model_service, "owner")
    else:
        chunks = [chunk async for chunk in response.body_iterator]
        assert chunks[-1] == "data: [DONE]\n\n"
        assert seen_users == ["owner"]
        if checkpoint:
            execution.manager.check_execution_resumption_point.assert_awaited_once_with("existing")
    if checkpoint:
        execution.record.assert_not_awaited()
        execution.preprocess.assert_not_awaited()
    else:
        execution.record.assert_awaited_once_with("existing", "hello")


async def test_graph_node_keeps_authenticated_user_over_cached_owner(execution, monkeypatch):
    node_executor = graph_service.executor.node_executor_core
    monkeypatch.setattr(node_executor, "conversation_manager", execution.manager)
    execution.manager.get_conversation.return_value["_current_round"] = 0
    load_config = AsyncMock(return_value=None)
    monkeypatch.setattr(node_executor.agent_stream_executor, "_load_effective_config", load_config)
    with pytest.raises(Exception, match="无法加载节点"):
        _ = [chunk async for chunk in node_executor.execute_node({"name": "node", "model_name": "valid"}, "existing", user_id="owner")]
    assert load_config.await_args.kwargs["user_id"] == "owner"


async def test_agent_failed_concurrent_create_rechecks_owner_before_run_record(execution):
    execution.repository.get_conversation.side_effect = [None, execution.document]
    execution.repository.create_conversation.return_value = False
    with pytest.raises(HTTPException) as error:
        await agent_run_service.ensure_conversation_exists("existing", "intruder", None, "project")
    assert error.value.status_code == 403
    execution.runs.create_agent_run.assert_not_awaited()
    execution.count.assert_not_awaited()


def test_background_route_preserves_defensive_guard_http_status(execution):
    execution.document["type"] = "graph"
    execution.repository.get_conversation.side_effect = [
        {"user_id": "intruder", "type": "graph"}, execution.document,
    ]
    response = execution.client.post("/graphs/execute", json={"graph_name": "valid", "conversation_id": "existing", "background": True})
    assert response.status_code == 403
    assert_no_effects(execution)


@pytest.mark.parametrize("is_new", [False, True])
@pytest.mark.parametrize("stream", [False, True])
def test_owned_agent_route_executes_and_saves(execution, monkeypatch, is_new, stream):
    execution.user.user_id = "owner"
    if is_new:
        execution.repository.get_conversation.side_effect = [None, execution.document, execution.document]
        monkeypatch.setattr(agent_run_service, "create_title_generator", AgentRunService().create_title_generator)
        monkeypatch.setattr("agent_graph.app.services.agent.agent_run_service.generate_title_and_tags", AsyncMock(return_value=("Title", [])))
    executor = agent_routes.agent_stream_executor
    execution.model.return_value = {
        "agent_name": "manual", "model_name": "valid", "system_prompt": "",
        "mcp_servers": [], "system_tools": [], "max_iterations": 1,
    }
    messages = AsyncMock(return_value=[{"role": "user", "content": "hello"}])
    monkeypatch.setattr(executor, "_build_messages", messages)
    monkeypatch.setattr(executor, "_prepare_agent_tools", AsyncMock(return_value=[]))
    save = AsyncMock()
    monkeypatch.setattr(executor, "_save_agent_run_result", save)

    async def run_loop(**_kwargs):
        yield 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n'
        yield {"messages": [{"role": "assistant", "content": "answer"}]}

    monkeypatch.setattr(executor, "run_agent_loop", run_loop)
    response = execution.client.post("/agent/run", data={"user_prompt": "hello", "model_name": "valid", "conversation_id": "existing", "stream": str(stream).lower()})
    assert response.status_code == 200
    if stream:
        assert response.text.count("data: [DONE]") == 1
        assert response.text.endswith("data: [DONE]\n\n")
    else:
        assert response.json()["output"] == "answer"
    assert "answer" in response.text
    messages.assert_awaited_once()
    assert save.await_args.kwargs["user_id"] == "owner"
    assert save.await_args.kwargs["conversation_id"] == "existing"


@pytest.mark.parametrize("background", [False, True])
async def test_graph_without_target_creates_new_conversation(execution, monkeypatch, background):
    execution.user.user_id = "owner"
    create = AsyncMock(return_value="new-graph")
    monkeypatch.setattr(execution.manager, "create_conversation_with_config", create, raising=False)
    execution.preprocess.return_value = {"nodes": []}
    run_background = AsyncMock()
    monkeypatch.setattr(graph_service.background_executor, "_execute_graph_background_task", run_background)

    async def levels(*_args):
        yield 'data: {"content":"finished"}\n\n'

    monkeypatch.setattr(graph_service.executor, "_execute_graph_by_level_sequential_stream", levels)
    response = await graph_routes.execute_graph(GraphInput(graph_name="valid", input_text="hello", background=background), execution.user)
    if background:
        assert response.status_code == 200
        await asyncio.sleep(0)
        run_background.assert_awaited_once_with("new-graph", graph_routes.model_service, "owner")
    else:
        chunks = [chunk async for chunk in response.body_iterator]
        assert any("conversation_created" in chunk for chunk in chunks)
        assert chunks[-1] == "data: [DONE]\n\n"
    assert create.await_args.args[-1] == "owner"
    execution.record.assert_awaited_once_with("new-graph", "hello")
    execution.repository.get_conversation.assert_not_awaited()
