import asyncio
from importlib import import_module
from pathlib import Path
import subprocess
import sys
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

from anyio import CancelScope, sleep
from fastapi import BackgroundTasks
import pytest


archive_module = import_module("agent_graph.app.services.conversation.document_archive")
routes = import_module("agent_graph.app.api.conversation_file_routes")
share_routes = import_module("agent_graph.app.api.conversation_share_routes")


def test_archive_shutdown_cancels_all_tasks_without_stalling_loop(tmp_path):
    script = r'''
import asyncio
import importlib
from pathlib import Path
import runpy
import sys
import tempfile
import threading
from unittest.mock import patch

runpy.run_path("tests/conftest.py")
module = importlib.import_module("agent_graph.app.services.conversation.document_archive")
started = threading.Event()
release = threading.Event()
finished = threading.Event()

def write(path, *_args):
    started.set()
    assert release.wait(5)
    Path(path).write_bytes(b"completed")
    finished.set()

async def content(_):
    return "content"

async def main():
    with patch.object(module, "_write_batch", write), patch.object(tempfile, "tempdir", sys.argv[1]):
        request = asyncio.create_task(module.create_document_archive(["note.md"], content, "test.zip"))
        while not started.is_set():
            await asyncio.sleep(0)
        pending = asyncio.all_tasks() - {asyncio.current_task()}
        for task in pending:
            task.cancel()
        for _ in range(5):
            await asyncio.sleep(0)
        print("loop-progress", flush=True)
        assert not request.done()
        assert list(Path(sys.argv[1]).iterdir())
        release.set()
        results = await asyncio.gather(*pending, return_exceptions=True)
        assert isinstance(request.exception() if not request.cancelled() else asyncio.CancelledError(), asyncio.CancelledError)
        assert finished.is_set()
        assert not list(Path(sys.argv[1]).iterdir())
        print("thread-finished-and-cleaned", flush=True)

asyncio.run(main())
'''
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True, text=True, timeout=8,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "loop-progress" in result.stdout
    assert "thread-finished-and-cleaned" in result.stdout


@pytest.fixture
def archive_route(monkeypatch, tmp_path):
    monkeypatch.setattr(archive_module.tempfile, "tempdir", str(tmp_path))

    async def read_content(*args, **kwargs):
        return "归档内容"

    monkeypatch.setattr(routes.conversation_document_service, "get_all_files", AsyncMock(return_value={"success": True, "files": ["note.md"]}))
    monkeypatch.setattr(routes.conversation_document_service, "read_authorized_file_content", read_content)
    share_service = import_module("agent_graph.app.services.conversation.conversation_share_service")
    monkeypatch.setattr(share_service, "mongodb_client", SimpleNamespace(
        share_repository=SimpleNamespace(get_share_by_id=AsyncMock(return_value={"conversation_id": "conversation", "user_id": "alice"})),
        conversation_repository=SimpleNamespace(get_all_files_metadata=AsyncMock(return_value={"files": [{"filename": "note.md"}]})),
    ))

    async def create(shared):
        if shared:
            return await share_routes.download_all_shared_files("shared", BackgroundTasks())
        return await routes.download_all_files("conversation", BackgroundTasks(), SimpleNamespace(user_id="alice"))

    return create


@pytest.mark.parametrize("shared", [False, True])
@pytest.mark.parametrize("outcome", ["normal", "send-error", "cancel", "cancel-scope", "range-400", "range-416"])
async def test_real_archive_response_always_cleans_once(archive_route, monkeypatch, shared, outcome):
    response = await archive_route(shared)
    path = Path(response.path)
    removals = []
    original = archive_module.shutil.rmtree

    def remove(directory, **kwargs):
        removals.append(Path(directory))
        return original(directory, **kwargs)

    monkeypatch.setattr(archive_module.shutil, "rmtree", remove)
    sent = []
    headers = []
    if outcome == "range-400":
        headers = [(b"range", b"not-a-valid-range")]
    elif outcome == "range-416":
        headers = [(b"range", b"bytes=999999-")]

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body":
            if outcome == "send-error":
                raise OSError("disconnected socket")
            if outcome == "cancel":
                asyncio.current_task().cancel()
                await asyncio.sleep(0)
            if outcome == "cancel-scope":
                scope.cancel()
                await sleep(0)

    async def invoke():
        await response({"type": "http", "method": "GET", "headers": headers, "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)

    if outcome == "send-error":
        with pytest.raises(OSError, match="disconnected"):
            await invoke()
    elif outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await asyncio.create_task(invoke())
    elif outcome == "cancel-scope":
        with CancelScope() as scope:
            await invoke()
    else:
        await invoke()
        assert sent[0]["status"] == {"normal": 200, "range-400": 400, "range-416": 416}[outcome]
    assert not path.exists()
    assert not path.parent.exists()
    assert removals == [path.parent]
    await response.background()
    assert removals == [path.parent], "响应 finally 与 background 必须共享幂等清理"


@pytest.mark.parametrize("shared", [False, True])
async def test_cancellation_during_archive_cleanup_waits_for_directory_removal(archive_route, monkeypatch, shared):
    response = await archive_route(shared)
    path = Path(response.path)
    started = Event()
    release = Event()
    original = archive_module.shutil.rmtree

    def remove(directory, **kwargs):
        started.set()
        assert release.wait(3)
        return original(directory, **kwargs)

    monkeypatch.setattr(archive_module.shutil, "rmtree", remove)
    task = asyncio.create_task(response({"type": "http", "method": "GET", "headers": []}, AsyncMock(), AsyncMock()))
    try:
        async with asyncio.timeout(4):
            while not started.is_set():
                await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not path.parent.exists()
