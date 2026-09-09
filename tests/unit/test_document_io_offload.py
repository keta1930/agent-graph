import asyncio
from datetime import datetime, timezone
from importlib import import_module
from threading import Event, get_ident
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


class FakeStorage:
    """记录 SDK 及惰性响应的执行线程，并可阻塞指定阶段。"""

    def __init__(self, prefix):
        self.object_name = f"{prefix}/alice/entity/notes/中文.md"
        self.calls = []
        self.payload = "原样\nhttps://example.test/\t中文".encode()
        self.fail = None
        self.block = None
        self.started = Event()
        self.resume = Event()
        self.released = Event()
        self.put_finished = Event()

    def record(self, stage, **kwargs):
        self.calls.append((stage, get_ident(), kwargs))
        if self.block == stage:
            self.started.set()
            self.resume.wait(1)
        if self.fail == stage:
            raise OSError(f"fake {stage} failure")

    def put_object(self, **kwargs):
        self.record("put", **kwargs)
        assert kwargs["data"].read() == self.payload
        assert kwargs["length"] == len(self.payload)
        self.put_finished.set()
        return SimpleNamespace(version_id="new-version")

    def get_object(self, **kwargs):
        self.record("get", **kwargs)
        return self

    def read(self):
        self.record("read")
        return self.payload

    def close(self):
        self.record("close")

    def release_conn(self):
        self.record("release")
        self.released.set()

    def list_objects(self, **kwargs):
        self.record("list", **kwargs)

        def iterate():
            for version, day, name in [("old", 1, self.object_name),
                                       ("other", 3, self.object_name + ".bak"),
                                       ("new", 2, self.object_name)]:
                self.record("iterate")
                yield SimpleNamespace(
                    object_name=name, version_id=version,
                    last_modified=datetime(2026, 9, day, tzinfo=timezone.utc),
                )

        return iterate()

    def remove_object(self, **kwargs):
        self.record("remove", **kwargs)


@pytest.fixture(params=["conversation", "project"])
def storage(request, monkeypatch, set_required_env):
    set_required_env()
    kind = request.param
    module = import_module(
        f"agent_graph.app.infrastructure.storage.object_storage.{kind}_document_manager"
    )
    sdk = FakeStorage(f"{kind}_doc")
    monkeypatch.setattr(module, "minio_client", SimpleNamespace(client=sdk, bucket_name="test-bucket"))
    manager = getattr(module, f"{kind.title()}DocumentManager")()
    return manager, sdk, kind


@pytest.mark.parametrize("operation", ["create_file", "update_file", "read_file", "list_versions", "delete_file", "delete_all"])
async def test_complete_sdk_operation_runs_outside_event_loop(storage, operation):
    manager, sdk, kind = storage
    args = ["alice", "entity", "notes/中文.md"]
    if operation in ("create_file", "update_file"):
        args.append(sdk.payload.decode())
    elif operation == "read_file":
        args.append("selected-version")
    elif operation == "delete_all":
        operation = f"delete_all_{kind}_files"
        args.pop()

    result = await getattr(manager, operation)(*args)

    assert sdk.calls
    assert all(thread != get_ident() for _, thread, _ in sdk.calls)
    for stage, _, kwargs in sdk.calls:
        if stage in ("put", "get", "list", "remove"):
            assert kwargs["bucket_name"] == "test-bucket"
    if operation in ("create_file", "update_file"):
        assert result == {"version_id": "new-version", "size": len(sdk.payload)}
        assert sdk.calls[0][2]["object_name"] == sdk.object_name
    elif operation == "read_file":
        assert result.encode() == sdk.payload
        assert sdk.calls[0][2]["version_id"] == "selected-version"
        assert [stage for stage, _, _ in sdk.calls] == ["get", "read", "close", "release"]
    elif operation == "list_versions":
        assert [version["version_id"] for version in result] == ["new", "old"]
    else:
        assert result is True
        deleted = [kwargs for stage, _, kwargs in sdk.calls if stage == "remove"]
        assert len(deleted) == (3 if operation.startswith("delete_all") else 2)
        if operation == "delete_file":
            assert {item["object_name"] for item in deleted} == {sdk.object_name}
        else:
            assert sdk.calls[0][2]["prefix"] == f"{kind}_doc/alice/entity/"
            assert sdk.calls[0][2]["recursive"] is True


@pytest.mark.parametrize("failure", ["read", "decode", "close"])
async def test_read_failure_always_closes_and_releases_response(storage, failure):
    manager, sdk, _ = storage
    sdk.fail = failure
    if failure == "decode":
        sdk.payload = b"\xff"

    assert await manager.read_file("alice", "entity", "notes/中文.md") is None
    assert [stage for stage, _, _ in sdk.calls][-2:] == ["close", "release"]
    assert sdk.released.is_set()
    assert all(thread != get_ident() for _, thread, _ in sdk.calls)


@pytest.mark.parametrize("stage", ["read", "put", "iterate", "remove"])
async def test_sync_storage_wait_does_not_block_ticker(storage, stage):
    manager, sdk, _ = storage
    sdk.block = stage
    if stage == "put":
        operation = manager.create_file("alice", "entity", "notes/中文.md", sdk.payload.decode())
    elif stage == "iterate":
        operation = manager.list_versions("alice", "entity", "notes/中文.md")
    elif stage == "remove":
        operation = manager.delete_file("alice", "entity", "notes/中文.md")
    else:
        operation = manager.read_file("alice", "entity", "notes/中文.md")
    task = asyncio.create_task(operation)
    ticks = 0
    try:
        async with asyncio.timeout(3):
            while not sdk.started.is_set():
                await asyncio.sleep(0)
            for _ in range(5):
                await asyncio.sleep(0)
                ticks += 1
            assert not task.done(), "SDK 阻塞期间 loop 必须仍可推进"
            assert ticks == 5
    finally:
        sdk.resume.set()
        await task


async def test_cancelled_read_still_releases_response_when_thread_finishes(storage):
    manager, sdk, _ = storage
    sdk.block = "read"
    task = asyncio.create_task(manager.read_file("alice", "entity", "notes/中文.md"))
    try:
        async with asyncio.timeout(3):
            while not sdk.started.is_set():
                await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    finally:
        sdk.resume.set()
        async with asyncio.timeout(3):
            while not sdk.released.is_set():
                await asyncio.sleep(0)


async def test_delete_failure_is_reported_after_attempting_every_version(storage):
    manager, sdk, _ = storage
    sdk.fail = "remove"
    assert await manager.delete_file("alice", "entity", "notes/中文.md") is False
    assert len([stage for stage, _, _ in sdk.calls if stage == "remove"]) == 2


async def test_cancelled_service_write_does_not_commit_unconfirmed_metadata(storage, monkeypatch):
    manager, sdk, kind = storage
    module = import_module(f"agent_graph.app.services.{kind}.{kind}_document_service")
    repository = SimpleNamespace(
        get_conversation=AsyncMock(return_value={"user_id": "alice"}),
        get_project=AsyncMock(return_value={"user_id": "alice"}),
        file_exists=AsyncMock(return_value=False),
        add_file_metadata=AsyncMock(),
    )
    monkeypatch.setattr(module, "mongodb_client", SimpleNamespace(**{f"{kind}_repository": repository}))
    monkeypatch.setattr(module, f"{kind}_document_manager", manager)
    service = getattr(module, f"{kind.title()}DocumentService")()
    sdk.block = "put"
    task = asyncio.create_task(service.create_file(
        **{f"{kind}_id": "entity"}, user_id="alice", filename="notes/中文.md",
        content=sdk.payload.decode(), summary="", log="",
    ))
    try:
        async with asyncio.timeout(3):
            while not sdk.started.is_set():
                await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    finally:
        sdk.resume.set()
        async with asyncio.timeout(3):
            while not sdk.put_finished.is_set():
                await asyncio.sleep(0)
    repository.add_file_metadata.assert_not_awaited()
