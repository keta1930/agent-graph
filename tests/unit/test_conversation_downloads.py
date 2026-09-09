import asyncio
from importlib import import_module
from pathlib import Path
from threading import Event, get_ident
import tempfile
import shutil
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import quote
import zipfile

from fastapi import BackgroundTasks, FastAPI, HTTPException
import httpx
import pytest


routes = import_module("agent_graph.app.api.conversation_file_routes")
service_module = import_module("agent_graph.app.services.conversation.conversation_document_service")
share_module = import_module("agent_graph.app.services.conversation.conversation_share_service")
share_routes = import_module("agent_graph.app.api.conversation_share_routes")
storage_module = import_module("agent_graph.app.infrastructure.storage.object_storage.conversation_document_manager")
USER = SimpleNamespace(user_id="alice", role="normal")


@pytest.fixture
def documents(monkeypatch, tmp_path):
    contents = {f"notes/{index}.md": f"文件 {index}\n" for index in range(9)}
    repository = SimpleNamespace(
        get_conversation=AsyncMock(return_value={"user_id": "alice"}),
        get_all_files_metadata=AsyncMock(side_effect=lambda _: {"files": [{"filename": name} for name in contents]}),
        get_file_metadata=AsyncMock(side_effect=lambda _, name: {"filename": name} if name in contents else None),
        file_exists=AsyncMock(side_effect=lambda **kwargs: kwargs["filename"] in contents),
    )
    share_repository = SimpleNamespace(get_share_by_id=AsyncMock(return_value={"conversation_id": "conversation", "user_id": "alice"}))
    database = SimpleNamespace(conversation_repository=repository, share_repository=share_repository)
    monkeypatch.setattr(service_module, "mongodb_client", database)
    monkeypatch.setattr(share_module, "mongodb_client", database)
    reads = []

    def get_object(**kwargs):
        reads.append(kwargs["object_name"])
        name = kwargs["object_name"].removeprefix("conversation_doc/alice/conversation/")
        payload = contents[name].encode()
        return SimpleNamespace(read=lambda: payload, close=lambda: None, release_conn=lambda: None)

    monkeypatch.setattr(storage_module, "minio_client", SimpleNamespace(client=SimpleNamespace(get_object=get_object), bucket_name="test-bucket"))
    versions = AsyncMock(return_value=[])
    monkeypatch.setattr(service_module.conversation_document_manager, "list_versions", versions)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    return SimpleNamespace(contents=contents, repository=repository, shares=share_repository,
                           reads=reads, versions=versions, directory=tmp_path)


async def test_single_download_uses_authorized_content_without_version_history(documents):
    response = await routes.download_file("conversation", "notes/0.md", USER)
    assert response.body == documents.contents["notes/0.md"].encode()
    documents.repository.get_conversation.assert_awaited_once_with("conversation")
    documents.repository.get_file_metadata.assert_awaited_once_with("conversation", "notes/0.md")
    documents.versions.assert_not_awaited()


@pytest.mark.parametrize("name", ["note#1.md", "notes/中文 ?.md", "literal%23.md"])
async def test_download_path_and_header_preserve_filename(documents, name):
    documents.contents[name] = "原样内容"
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user] = lambda: USER
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/conversations/conversation/files/{quote(name, safe='')}/download")
    assert response.status_code == 200
    assert response.content == "原样内容".encode()
    assert documents.reads[-1] == f"conversation_doc/alice/conversation/{name}"
    assert "attachment" in response.headers["content-disposition"]


@pytest.mark.parametrize("bulk", [False, True])
async def test_download_rejects_other_owner_before_metadata_or_storage(documents, bulk):
    documents.repository.get_conversation.return_value = {"user_id": "bob"}
    with pytest.raises(HTTPException) as error:
        if bulk:
            await routes.download_all_files("conversation", BackgroundTasks(), USER)
        else:
            await routes.download_file("conversation", "notes/0.md", USER)
    assert error.value.status_code == 404
    documents.repository.get_file_metadata.assert_not_awaited()
    documents.repository.get_all_files_metadata.assert_not_awaited()
    assert documents.reads == []
    assert list(documents.directory.iterdir()) == []


async def test_zip_checks_owner_once_preserves_order_and_cleans_success(documents):
    response = await routes.download_all_files("conversation", BackgroundTasks(), USER)
    path = Path(response.path)
    assert path.is_file()
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == list(documents.contents)
        assert {name: archive.read(name) for name in archive.namelist()} == {
            name: content.encode() for name, content in documents.contents.items()
        }
    documents.repository.get_conversation.assert_awaited_once()
    documents.repository.get_file_metadata.assert_not_awaited()
    documents.versions.assert_not_awaited()
    await response.background()
    assert list(documents.directory.iterdir()) == []


async def test_zip_reads_at_most_four_files_concurrently(documents, monkeypatch):
    release = asyncio.Event()
    first_batch = asyncio.Event()
    active = 0
    maximum = 0
    started = []

    async def read_file(**kwargs):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        started.append(kwargs["filename"])
        if active == 4:
            first_batch.set()
        try:
            await release.wait()
            return documents.contents[kwargs["filename"]]
        finally:
            active -= 1

    monkeypatch.setattr(service_module.conversation_document_manager, "read_file", read_file)
    task = asyncio.create_task(routes.download_all_files("conversation", BackgroundTasks(), USER))
    try:
        await asyncio.wait_for(first_batch.wait(), 2)
        assert started == list(documents.contents)[:4]
        assert not task.done()
    finally:
        release.set()
        response = await task
        await response.background()
    assert maximum == 4
    assert active == 0


@pytest.mark.parametrize("failure", ["read", "write", "response"])
async def test_zip_failure_removes_temporary_directory(documents, monkeypatch, failure):
    if failure == "read":
        monkeypatch.setattr(service_module.conversation_document_manager, "read_file", AsyncMock(return_value=None))
    elif failure == "write":
        def fail_write(*args, **kwargs):
            raise OSError("fake zip write failure")
        monkeypatch.setattr(zipfile.ZipFile, "writestr", fail_write)
    else:
        def fail_response(*args, **kwargs):
            raise RuntimeError("fake response failure")
        monkeypatch.setattr(routes, "TemporaryArchiveResponse", fail_response)
    with pytest.raises(HTTPException) as error:
        await routes.download_all_files("conversation", BackgroundTasks(), USER)
    assert error.value.status_code == 500
    assert list(documents.directory.iterdir()) == []


@pytest.mark.parametrize("cancel", [0, 1, 2])
async def test_zip_compression_keeps_loop_responsive_and_cleans_after_cancel(documents, monkeypatch, cancel):
    original = zipfile.ZipFile.writestr
    original_close = zipfile.ZipFile.close
    original_cleanup = shutil.rmtree
    started = Event()
    release = Event()
    closed = Event()
    threads = []

    def write(archive, *args, **kwargs):
        threads.append(get_ident())
        started.set()
        release.wait(2)
        return original(archive, *args, **kwargs)

    def close(archive):
        original_close(archive)
        closed.set()

    def cleanup(*args, **kwargs):
        assert closed.is_set(), "清理必须等待 ZIP 句柄关闭"
        return original_cleanup(*args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "writestr", write)
    monkeypatch.setattr(zipfile.ZipFile, "close", close)
    monkeypatch.setattr(shutil, "rmtree", cleanup)
    task = asyncio.create_task(routes.download_all_files("conversation", BackgroundTasks(), USER))
    try:
        async with asyncio.timeout(4):
            while not started.is_set():
                await asyncio.sleep(0)
            for _ in range(5):
                await asyncio.sleep(0)
            assert not task.done()
            assert all(thread != get_ident() for thread in threads)
            if cancel:
                for _ in range(cancel):
                    task.cancel()
                    for _ in range(5):
                        await asyncio.sleep(0)
                assert not task.done(), "取消必须等 ZIP 写线程收尾后清理"
    finally:
        release.set()
        if cancel:
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            response = await task
            await response.background()
    assert list(documents.directory.iterdir()) == []


async def test_share_zip_preserves_share_auth_and_skips_unreadable_files(documents, monkeypatch):
    async def read_file(**kwargs):
        if kwargs["filename"] == "notes/1.md":
            return None
        if kwargs["filename"] == "notes/2.md":
            raise OSError("unavailable")
        return documents.contents[kwargs["filename"]]

    monkeypatch.setattr(service_module.conversation_document_manager, "read_file", read_file)
    background = BackgroundTasks()
    response = await share_routes.download_all_shared_files("shared", background)
    with zipfile.ZipFile(response.path) as archive:
        assert archive.namelist() == [name for name in documents.contents if name not in {"notes/1.md", "notes/2.md"}]
    documents.shares.get_share_by_id.assert_awaited_once_with("shared")
    documents.repository.get_conversation.assert_not_awaited()
    documents.versions.assert_not_awaited()
    await background()
    assert list(documents.directory.iterdir()) == []


async def test_shared_single_download_checks_share_and_file_before_content(documents):
    assert await share_module.conversation_share_service.download_shared_file("shared", "notes/0.md") == documents.contents["notes/0.md"].encode()
    documents.shares.get_share_by_id.assert_awaited_once_with("shared")
    documents.repository.file_exists.assert_awaited_once_with(conversation_id="conversation", filename="notes/0.md")
    documents.repository.get_conversation.assert_not_awaited()
    documents.versions.assert_not_awaited()


@pytest.mark.parametrize("method, suffix, action", [
    ("GET", "", "get_file"),
    ("GET", "/versions/version", "get_file_version"),
    ("PUT", "", "save_file"),
    ("DELETE", "", "delete_file"),
])
async def test_file_routes_decode_reserved_filename_exactly_once(documents, monkeypatch, method, suffix, action):
    filename = "notes/中文%23.md"
    operation = AsyncMock(return_value={"success": False, "error": "missing", "message": "不存在"})
    monkeypatch.setattr(routes.conversation_document_service, action, operation)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user] = lambda: USER
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.request(method, f"/conversations/conversation/files/{quote(filename, safe='')}{suffix}",
                                        json={"content": "内容", "summary": "", "log": ""} if method == "PUT" else None)
    assert response.status_code == 404
    assert operation.await_args.kwargs["filename"] == filename


async def test_shared_download_returns_unicode_basename_header(documents):
    filename = "notes/中文%23.md"
    documents.contents[filename] = "下载内容"
    app = FastAPI()
    app.include_router(share_routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(f"/share/shared/file/{quote(filename, safe='')}")
    assert response.status_code == 200
    assert response.content == "下载内容".encode()
    assert response.headers["content-disposition"] == f"attachment; filename*=utf-8''{quote('中文%23.md')}"
    assert response.headers["content-type"] == "application/octet-stream"


@pytest.mark.parametrize("share", [False, True])
async def test_zip_with_no_files_creates_no_temporary_resources(documents, share):
    documents.contents.clear()
    with pytest.raises(HTTPException) as error:
        if share:
            await share_routes.download_all_shared_files("shared", BackgroundTasks())
        else:
            await routes.download_all_files("conversation", BackgroundTasks(), USER)
    assert error.value.status_code == 404
    assert list(documents.directory.iterdir()) == []


@pytest.mark.parametrize("bulk", [False, True])
async def test_missing_share_cannot_read_conversation_files(documents, bulk):
    documents.shares.get_share_by_id.return_value = None
    with pytest.raises(HTTPException) as error:
        if bulk:
            await share_routes.download_all_shared_files("missing", BackgroundTasks())
        else:
            await share_module.conversation_share_service.download_shared_file("missing", "notes/0.md")
    assert error.value.status_code == 404
    documents.repository.get_all_files_metadata.assert_not_awaited()
    documents.repository.file_exists.assert_not_awaited()
    assert documents.reads == []


@pytest.mark.parametrize("failure", ["write", "response"])
async def test_share_zip_failure_cleans_temporary_directory(documents, monkeypatch, failure):
    def fail(*args, **kwargs):
        raise OSError("fake zip failure")
    if failure == "write":
        monkeypatch.setattr(zipfile.ZipFile, "writestr", fail)
    else:
        monkeypatch.setattr(share_routes, "TemporaryArchiveResponse", fail)
    with pytest.raises(HTTPException):
        await share_routes.download_all_shared_files("shared", BackgroundTasks())
    assert list(documents.directory.iterdir()) == []
