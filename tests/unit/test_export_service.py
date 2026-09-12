import asyncio
import io
import json
from importlib import import_module
from pathlib import Path
from threading import Event, get_ident
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def export(monkeypatch, set_required_env, tmp_path):
    set_required_env()
    module = import_module('agent_graph.app.services.export.export_service')
    conversation = {'_id': 'own', 'user_id': 'alice', 'type': 'agent',
                    'rounds': [{'messages': [{'role': 'user', 'content': '中文'}]}]}
    db = SimpleNamespace(get_conversation=AsyncMock(return_value=conversation),
                         get_conversation_with_messages=AsyncMock(return_value=conversation))
    storage = SimpleNamespace(upload_file=Mock(return_value=True), list_objects=Mock(return_value=[]),
                              download_file=Mock(return_value=True), delete_object=Mock(return_value=True),
                              get_object_info=Mock(return_value=None))
    monkeypatch.setattr(module, 'mongodb_client', db)
    monkeypatch.setattr(module, 'minio_client', storage)
    original = module.tempfile.mkdtemp
    monkeypatch.setattr(module.tempfile, 'mkdtemp', lambda suffix=None, prefix=None, dir=None: original(suffix=suffix, prefix=prefix, dir=str(tmp_path)))
    return module, module.ExportService(), db, storage


@pytest.mark.parametrize('ids', [['foreign'], ['own', 'foreign']])
async def test_foreign_conversations_rejected_before_content_read(export, ids):
    _, service, db, storage = export
    db.get_conversation.side_effect = lambda cid: {'user_id': 'bob' if cid == 'foreign' else 'alice'}
    db.get_conversation_with_messages.return_value['user_id'] = 'bob'
    result = await service.export_conversations('数据 集', 'data', ids, user_id='alice')
    assert result['success'] is False
    db.get_conversation_with_messages.assert_not_awaited()
    storage.upload_file.assert_not_called()


@pytest.mark.parametrize('field', ['file_name', 'dataset_name'])
@pytest.mark.parametrize('name', ['../escape', '/tmp/escape', 'nested/name', 'a\\b', '', '.', '..', 'bad\x00name'])
async def test_unsafe_names_rejected_before_io(export, field, name):
    _, service, db, storage = export
    args = dict(dataset_name='dataset', file_name='data', conversation_ids=['own'], user_id='alice')
    args[field] = name
    result = await service.export_conversations(**args)
    assert result['success'] is False
    db.get_conversation_with_messages.assert_not_awaited()
    storage.upload_file.assert_not_called()


@pytest.mark.parametrize('results', [[False], [True, False]])
async def test_upload_failure_is_not_success(export, results, tmp_path):
    _, service, _, storage = export
    storage.upload_file.side_effect = results
    result = await service.export_conversations('dataset', 'data', ['own'], user_id='alice')
    assert result['success'] is False
    assert storage.upload_file.call_count == len(results)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('file_format', ['jsonl', 'csv', 'parquet'])
async def test_export_formats_off_loop_and_content_preserved(export, file_format, tmp_path):
    _, service, _, storage = export
    captured = {}
    def upload(name, path):
        assert get_ident() != loop_thread
        captured[name.rsplit('/', 1)[-1]] = Path(path).read_bytes()
        return True
    loop_thread = get_ident()
    storage.upload_file.side_effect = upload
    result = await service.export_conversations('数据 集', 'data', ['own'], file_format, user_id='alice')
    assert result['success'] is True
    assert result['total_records'] == 1
    assert result['preview_data'][0]['messages'][0]['content'] == '中文'
    assert json.loads(captured['dataset_info.json'])['数据 集']['num_samples'] == 1
    assert captured['data.' + file_format]
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('name', ['conversation_export/alice/standard/data/../evil', 'other/data.jsonl'])
async def test_download_rejects_unsafe_object_names(export, name, tmp_path):
    _, service, _, storage = export
    storage.list_objects.return_value = [{'object_name': name}]
    assert await service.download_dataset('data', user_id='alice') is None
    storage.download_file.assert_not_called()
    assert not list(tmp_path.iterdir())


async def test_download_failure_cleans_directory(export, tmp_path):
    _, service, _, storage = export
    storage.list_objects.return_value = [{'object_name': 'conversation_export/alice/standard/data/data.jsonl'}]
    storage.download_file.return_value = False
    assert await service.download_dataset('data', user_id='alice') is None
    assert not list(tmp_path.iterdir())


async def test_cancelled_download_waits_for_worker_then_cleans(export, tmp_path):
    _, service, _, storage = export
    storage.list_objects.return_value = [{'object_name': 'conversation_export/alice/standard/data/data.jsonl'}]
    started, release = Event(), Event()
    loop_thread = get_ident()
    def download(name, path):
        assert get_ident() != loop_thread
        started.set()
        release.wait(2)
        Path(path).write_text('data')
        return True
    storage.download_file.side_effect = download
    task = asyncio.create_task(service.download_dataset('data', user_id='alice'))
    try:
        async with asyncio.timeout(3):
            while not started.is_set() and not task.done():
                await asyncio.sleep(0)
            assert started.is_set()
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not list(tmp_path.iterdir())


async def test_dataset_list_uses_existing_metadata(export):
    _, service, _, storage = export
    storage.list_objects.return_value = [
        {'object_name': 'conversation_export/alice/standard/a/dataset_info.json', 'last_modified': '2026-01-01T00:00:00+00:00'},
        {'object_name': 'conversation_export/alice/standard/a/data.jsonl'},
    ]
    result = await service.list_datasets('alice')
    assert [item['dataset_name'] for item in result['exports']] == ['a']
    storage.get_object_info.assert_not_called()


async def test_partial_delete_reports_failure(export):
    _, service, _, storage = export
    storage.list_objects.return_value = [{'object_name': name} for name in ['one', 'two']]
    storage.delete_object.side_effect = [True, False]
    assert (await service.delete_dataset('data', user_id='alice'))['success'] is False


def test_export_api_rejects_paths_without_side_effects(export, monkeypatch):
    module = import_module('agent_graph.app.api.export_routes')
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[module.get_current_user] = lambda: SimpleNamespace(user_id='alice')
    operation = AsyncMock()
    monkeypatch.setattr(module.export_service, 'export_conversations', operation)
    with TestClient(app) as client:
        response = client.post('/export/conversations', json={
            'dataset_name': 'valid', 'file_name': '../evil', 'conversation_ids': ['own']})
    assert response.status_code == 422
    operation.assert_not_awaited()


@pytest.mark.parametrize('outcome', ['normal', 'send-error', 'cancel', 'range'])
async def test_export_download_response_cleans_directory(export, monkeypatch, tmp_path, outcome):
    from fastapi import BackgroundTasks
    module = import_module('agent_graph.app.api.export_routes')
    directory = tmp_path / 'archive'
    directory.mkdir()
    path = directory / 'dataset.zip'
    path.write_bytes(b'archive')
    monkeypatch.setattr(module.export_service, 'download_dataset', AsyncMock(return_value=str(path)))
    response = await module.download_dataset('dataset', 'standard', BackgroundTasks(), SimpleNamespace(user_id='alice'))
    async def send(message):
        if outcome == 'send-error':
            raise OSError('disconnected')
        if outcome == 'cancel':
            raise asyncio.CancelledError()
    headers = [(b'range', b'bytes=999-1000')] if outcome == 'range' else []
    operation = response({'type': 'http', 'method': 'GET', 'headers': headers, 'asgi': {'spec_version': '2.4'}}, AsyncMock(), send)
    if outcome in {'send-error', 'cancel'}:
        with pytest.raises(OSError if outcome == 'send-error' else asyncio.CancelledError):
            await operation
    else:
        await operation
    assert not directory.exists()


def test_export_api_foreign_owner_has_no_storage_side_effects(export, monkeypatch):
    _, service, db, storage = export
    module = import_module('agent_graph.app.api.export_routes')
    db.get_conversation.return_value = {'user_id': 'bob'}
    monkeypatch.setattr(module, 'export_service', service)
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[module.get_current_user] = lambda: SimpleNamespace(user_id='alice')
    with TestClient(app) as client:
        response = client.post('/export/conversations', json={'dataset_name': 'data', 'file_name': 'data', 'conversation_ids': ['foreign']})
    assert response.status_code == 400
    db.get_conversation_with_messages.assert_not_awaited()
    storage.upload_file.assert_not_called()


@pytest.mark.parametrize('file_format', ['jsonl', 'csv', 'parquet'])
async def test_preview_limits_records_and_offloads_reader(export, monkeypatch, file_format):
    _, service, _, storage = export
    loop_thread = get_ident()
    storage.download_content = Mock(return_value=json.dumps({'data': {'file_name': 'records.' + file_format, 'num_samples': 100}}))
    storage.object_exists = Mock(return_value=True)
    def preview(name, max_records):
        assert get_ident() != loop_thread
        assert max_records == 20
        return [{'messages': ['中文']}] * 20
    monkeypatch.setattr(service.preview_readers[file_format], 'preview', preview)
    result = await service.preview_dataset('data', user_id='alice')
    assert result['success'] is True
    assert len(result['preview_data']) == 20 and result['total_records'] == 100
