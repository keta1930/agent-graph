import asyncio
import io
from importlib import import_module
from threading import get_ident
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from starlette.datastructures import UploadFile


@pytest.fixture
def image_storage(monkeypatch, set_required_env):
    set_required_env()
    module = import_module('agent_graph.app.infrastructure.storage.object_storage.conversation_image_manager')
    response = SimpleNamespace(read=Mock(return_value=b'image'), close=Mock(), release_conn=Mock())
    sdk = SimpleNamespace(get_object=Mock(return_value=response), list_objects=Mock(return_value=[]), remove_object=Mock())
    monkeypatch.setattr(module, 'minio_client', SimpleNamespace(client=sdk, bucket_name='bucket'))
    return module, module.ConversationImageManager(), sdk, response


@pytest.mark.parametrize('failure', ['read', 'close'])
async def test_image_read_failure_releases_response(image_storage, failure):
    _, manager, sdk, response = image_storage
    getattr(response, failure).side_effect = OSError('broken')
    assert await manager.get_image('old/key.png') is None
    response.close.assert_called_once()
    response.release_conn.assert_called_once()


async def test_image_read_and_lazy_delete_are_off_loop(image_storage):
    _, manager, sdk, response = image_storage
    loop_thread = get_ident()
    def read():
        assert get_ident() != loop_thread
        return b'image'
    response.read.side_effect = read
    assert await manager.get_image('old/key.png') == b'image'
    def objects(**kwargs):
        assert get_ident() != loop_thread
        yield SimpleNamespace(object_name='old/key.png', version_id='version')
    sdk.list_objects.side_effect = objects
    assert await manager.delete_image('old/key.png') is True
    sdk.remove_object.assert_called_once_with(bucket_name='bucket', object_name='old/key.png', version_id='version')


def test_image_paths_unique_and_filename_stays_in_conversation(image_storage):
    _, manager, _, _ = image_storage
    paths = {manager.generate_minio_path('alice', 'conv', '../folder/photo.PNG') for _ in range(5)}
    assert len(paths) == 5
    assert all(path.startswith('conversation_image/alice/conv/') and len(path.split('/')) == 4 for path in paths)
    assert all(path.endswith('.png') for path in paths)


async def test_image_delete_all_versions_and_continue_after_failure(image_storage):
    _, manager, sdk, _ = image_storage
    prefix = 'conversation_image/alice/conv/'
    sdk.list_objects.return_value = [SimpleNamespace(object_name=prefix + 'photo.png', version_id=v) for v in ['old', 'new', 'marker']]
    sdk.remove_object.side_effect = [OSError('one failed'), None, None]
    assert await manager.delete_all_conversation_images('alice', 'conv') is False
    assert sdk.list_objects.call_args.kwargs['include_version'] is True
    assert [call.kwargs['version_id'] for call in sdk.remove_object.call_args_list] == ['old', 'new', 'marker']


@pytest.mark.parametrize('success', [True, False])
async def test_file_handler_waits_for_image_upload(image_storage, monkeypatch, success):
    module, manager, _, _ = image_storage
    handler_module = import_module('agent_graph.app.services.agent.file_handler')
    entered, release = asyncio.Event(), asyncio.Event()
    async def upload(**kwargs):
        entered.set()
        await release.wait()
        return success
    manager.upload_image = upload
    monkeypatch.setattr(module, 'conversation_image_manager', manager)
    handler = handler_module.FileHandler()
    operation = asyncio.create_task(handler.process_uploaded_files([UploadFile(io.BytesIO(b'image'), filename='photo.png')], 'alice', 'conv'))
    await entered.wait()
    try:
        assert not operation.done()
    finally:
        release.set()
    result = await operation
    assert len(result['images_info']) == int(success)


@pytest.mark.parametrize('failure', ['read', 'decode', 'close'])
def test_minio_content_failure_releases_response(monkeypatch, failure):
    module = import_module('agent_graph.app.infrastructure.storage.object_storage.minio_client')
    response = SimpleNamespace(read=Mock(return_value=b'\xff' if failure == 'decode' else b'ok'), close=Mock(), release_conn=Mock())
    if failure != 'decode':
        getattr(response, failure).side_effect = OSError('broken')
    client = module.MinIOClient()
    client._client = SimpleNamespace(get_object=Mock(return_value=response))
    client._bucket_name = 'bucket'
    with pytest.raises((OSError, UnicodeDecodeError)):
        client.download_content('key')
    response.close.assert_called_once()
    response.release_conn.assert_called_once()
