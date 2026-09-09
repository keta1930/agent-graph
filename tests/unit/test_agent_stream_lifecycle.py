import asyncio
import importlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent_graph.app.infrastructure.database.mongodb.client import mongodb_client
from agent_graph.app.api.agent_routes import AgentStreamingResponse
from agent_graph.app.services.agent.agent_run_service import AgentRunService
from agent_graph.app.services.agent.agent_stream_executor import AgentStreamExecutor
from agent_graph.app.utils.sse_helper import TrajectoryCollector


run_module = importlib.import_module("agent_graph.app.services.agent.agent_run_service")
DONE = "data: [DONE]\n\n"
CONTENT = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'


@pytest.fixture
def stream_context(monkeypatch):
    repository = SimpleNamespace(
        get_conversation=AsyncMock(return_value={"_id": "id", "user_id": "owner", "type": "agent"}),
        update_conversation_title_and_tags=AsyncMock(),
    )
    monkeypatch.setattr(mongodb_client, "conversation_repository", repository)
    title_ready = asyncio.Event()
    title_release = asyncio.Event()
    title_closed = asyncio.Event()

    async def title(**_kwargs):
        title_ready.set()
        try:
            await title_release.wait()
            return "A title", ["tag"]
        finally:
            title_closed.set()

    monkeypatch.setattr(run_module, "generate_title_and_tags", title)
    return SimpleNamespace(
        service=AgentRunService(), repository=repository,
        title_ready=title_ready, title_release=title_release, title_closed=title_closed,
    )


def make_stream(context, execute, *, is_new=True):
    return context.service.create_stream_generator(
        agent_stream_executor=SimpleNamespace(run_agent_stream=execute),
        agent_name=None, user_prompt="hello", user_id="owner", conversation_id="id",
        images_info=[], model_name="valid", system_prompt=None,
        mcp_servers_list=None, system_tools_list=None, max_iterations=None,
        is_new_conversation=is_new,
    )


async def collect(stream):
    return [chunk async for chunk in stream]


def assert_terminal_order(chunks, *, title):
    assert chunks[-1] == DONE
    assert chunks.count(DONE) == 1
    titles = [json.loads(chunk[6:]) for chunk in chunks[:-1] if "title_update" in chunk]
    assert len(titles) == int(title)
    if title:
        assert titles[0]["title"] == "A title"


async def test_early_title_does_not_wait_again_after_done(stream_context):
    async def execute(**_kwargs):
        stream_context.title_release.set()
        await stream_context.title_closed.wait()
        yield CONTENT
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute)), 0.5)
    assert_terminal_order(chunks, title=True)
    stream_context.repository.update_conversation_title_and_tags.assert_awaited_once()


async def test_late_title_is_delivered_before_unique_done(stream_context):
    content_finished = asyncio.Event()

    async def execute(**_kwargs):
        yield CONTENT
        content_finished.set()
        yield DONE

    collecting = asyncio.create_task(collect(make_stream(stream_context, execute)))
    await content_finished.wait()
    await stream_context.title_ready.wait()
    assert not collecting.done()
    stream_context.title_release.set()
    chunks = await asyncio.wait_for(collecting, 0.5)
    assert_terminal_order(chunks, title=True)


async def test_title_failure_finishes_without_empty_queue_wait(stream_context, monkeypatch):
    async def fail_title(**_kwargs):
        raise RuntimeError("fake title failure")

    monkeypatch.setattr(run_module, "generate_title_and_tags", fail_title)

    async def execute(**_kwargs):
        yield CONTENT
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute)), 0.5)
    assert_terminal_order(chunks, title=False)
    assert CONTENT in chunks


async def test_title_timeout_cancels_and_joins_task_before_done(stream_context, monkeypatch):
    monkeypatch.setattr(run_module, "TITLE_WAIT_TIMEOUT", 0.01)

    async def execute(**_kwargs):
        yield CONTENT
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute)), 0.5)
    assert_terminal_order(chunks, title=False)
    assert stream_context.title_closed.is_set()
    stream_context.repository.update_conversation_title_and_tags.assert_not_awaited()


@pytest.mark.parametrize("raise_error", [False, True])
async def test_stream_error_has_one_done_and_cleans_title(stream_context, raise_error):
    async def execute(**_kwargs):
        await stream_context.title_ready.wait()
        if raise_error:
            raise RuntimeError("fake stream failure")
        stream_context.title_release.set()
        yield 'data: {"error":"fake stream failure"}\n\n'
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute)), 0.5)
    assert_terminal_order(chunks, title=not raise_error)
    assert any("error" in chunk for chunk in chunks[:-1])
    assert stream_context.title_closed.is_set()


async def test_closing_stream_cancels_title_and_closes_executor(stream_context):
    executor_closed = asyncio.Event()

    async def execute(**_kwargs):
        try:
            await stream_context.title_ready.wait()
            yield CONTENT
            await asyncio.Event().wait()
        finally:
            executor_closed.set()

    stream = make_stream(stream_context, execute)
    assert await anext(stream) == CONTENT
    await stream.aclose()
    assert executor_closed.is_set()
    assert stream_context.title_closed.is_set()
    stream_context.repository.update_conversation_title_and_tags.assert_not_awaited()


async def test_cancel_during_pending_read_joins_both_tasks(stream_context):
    executor_closed = asyncio.Event()

    async def execute(**_kwargs):
        try:
            await asyncio.Event().wait()
            yield CONTENT
        finally:
            executor_closed.set()

    task = asyncio.create_task(collect(make_stream(stream_context, execute)))
    await stream_context.title_ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert executor_closed.is_set()
    assert stream_context.title_closed.is_set()


async def test_non_stream_collector_finishes_after_title_cleanup(stream_context):
    async def execute(**_kwargs):
        stream_context.title_release.set()
        yield CONTENT
        yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        yield DONE

    result = await asyncio.wait_for(TrajectoryCollector("hello").collect_stream_data(make_stream(stream_context, execute)), 0.5)
    assert result["output"] == "hello"
    assert stream_context.title_closed.is_set()
    stream_context.repository.update_conversation_title_and_tags.assert_awaited_once()


async def test_existing_conversation_does_not_start_title_task(stream_context, monkeypatch):
    create_title = Mock()
    monkeypatch.setattr(stream_context.service, "create_title_generator", create_title)

    async def execute(**_kwargs):
        yield CONTENT
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute, is_new=False)), 0.5)
    assert_terminal_order(chunks, title=False)
    create_title.assert_not_called()


async def test_direct_agent_executor_retains_done_contract(stream_context, monkeypatch):
    executor = AgentStreamExecutor()
    monkeypatch.setattr(mongodb_client, "user_repository", SimpleNamespace(get_user_language=AsyncMock(return_value="en")))
    monkeypatch.setattr(executor, "_load_effective_config", AsyncMock(return_value=None))
    chunks = await collect(executor.run_agent_stream(None, "hello", "owner", "id", model_name="valid"))
    assert_terminal_order(chunks, title=False)
    assert "error" in chunks[0]


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
async def test_http_disconnect_closes_stream_and_title(stream_context, spec_version):
    sent_content = asyncio.Event()
    executor_closed = asyncio.Event()

    async def execute(**_kwargs):
        try:
            await stream_context.title_ready.wait()
            yield CONTENT
        finally:
            executor_closed.set()

    async def receive():
        await sent_content.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            sent_content.set()
            if spec_version == "2.4":
                raise OSError("fake disconnected socket")
            await asyncio.Event().wait()

    response = AgentStreamingResponse(make_stream(stream_context, execute))
    if spec_version == "2.4":
        with pytest.raises(Exception) as error:
            await response({"type": "http", "asgi": {"spec_version": spec_version}}, receive, send)
        assert type(error.value).__name__ == "ClientDisconnect"
    else:
        await response({"type": "http", "asgi": {"spec_version": spec_version}}, receive, send)
    assert executor_closed.is_set()
    assert stream_context.title_closed.is_set()


@pytest.mark.parametrize("waiting_for_title", [False, True])
async def test_http_disconnect_during_read_joins_title_cleanup(stream_context, monkeypatch, waiting_for_title):
    title_started = asyncio.Event()
    title_closed = asyncio.Event()
    stream_finished = asyncio.Event()

    async def title(**_kwargs):
        title_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.01)
            title_closed.set()

    monkeypatch.setattr(run_module, "generate_title_and_tags", title)

    async def execute(**_kwargs):
        if not waiting_for_title:
            await asyncio.Event().wait()
        yield DONE
        stream_finished.set()

    async def receive():
        await title_started.wait()
        if waiting_for_title:
            await stream_finished.wait()
        return {"type": "http.disconnect"}

    response = AgentStreamingResponse(make_stream(stream_context, execute))
    await response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, AsyncMock())
    assert title_closed.is_set()


async def test_title_cleanup_has_a_deadline(stream_context, monkeypatch):
    monkeypatch.setattr(run_module, "TITLE_WAIT_TIMEOUT", 0.01)
    monkeypatch.setattr(run_module, "STREAM_CLEANUP_TIMEOUT", 0.01)
    cleanup_started = asyncio.Event()
    cleanup_ended = asyncio.Event()

    async def title(**_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cleanup_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_ended.set()

    monkeypatch.setattr(run_module, "generate_title_and_tags", title)

    async def execute(**_kwargs):
        yield CONTENT
        yield DONE

    chunks = await asyncio.wait_for(collect(make_stream(stream_context, execute)), 0.5)
    assert_terminal_order(chunks, title=False)
    assert cleanup_started.is_set()
    assert cleanup_ended.is_set()


async def test_direct_executor_close_closes_agent_loop_before_return(stream_context, monkeypatch):
    executor = AgentStreamExecutor()
    monkeypatch.setattr(mongodb_client, "user_repository", SimpleNamespace(get_user_language=AsyncMock(return_value="en")))
    monkeypatch.setattr(executor, "_load_effective_config", AsyncMock(return_value={
        "agent_name": "manual", "model_name": "valid", "system_prompt": "",
        "mcp_servers": [], "system_tools": [], "max_iterations": 1,
    }))
    monkeypatch.setattr(executor, "_build_messages", AsyncMock(return_value=[]))
    monkeypatch.setattr(executor, "_prepare_agent_tools", AsyncMock(return_value=[]))
    save = AsyncMock()
    monkeypatch.setattr(executor, "_save_agent_run_result", save)
    loop_closed = asyncio.Event()

    async def run_loop(**_kwargs):
        try:
            yield CONTENT
            await asyncio.Event().wait()
        finally:
            loop_closed.set()

    monkeypatch.setattr(executor, "run_agent_loop", run_loop)
    stream = executor.run_agent_stream(None, "hello", "owner", "id", model_name="valid")
    assert await anext(stream) == CONTENT
    await stream.aclose()
    assert loop_closed.is_set()
    save.assert_not_awaited()


async def test_unconsumed_response_does_not_create_title_task(stream_context, monkeypatch):
    create_title = Mock()
    monkeypatch.setattr(stream_context.service, "create_title_generator", create_title)

    async def execute(**_kwargs):
        yield CONTENT

    stream = make_stream(stream_context, execute)
    await stream.aclose()
    create_title.assert_not_called()
