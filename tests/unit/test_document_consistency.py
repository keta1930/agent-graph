import asyncio
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.fixture(params=['conversation', 'project'])
def document_service(request, monkeypatch, set_required_env):
    set_required_env()
    kind = request.param
    module = import_module(f'agent_graph.app.services.{kind}.{kind}_document_service')
    repository = SimpleNamespace(get_conversation=AsyncMock(return_value={'user_id': 'alice'}),
                                 get_project=AsyncMock(return_value={'user_id': 'alice'}),
                                 file_exists=AsyncMock(return_value=False), add_file_metadata=AsyncMock(return_value=False),
                                 update_file_metadata=AsyncMock(return_value=False))
    manager = SimpleNamespace(create_file=AsyncMock(return_value={'version_id': 'new', 'size': 5}),
                              update_file=AsyncMock(return_value={'version_id': 'new', 'size': 5}),
                              delete_version=AsyncMock(return_value=True))
    monkeypatch.setattr(module, 'mongodb_client', SimpleNamespace(**{f'{kind}_repository': repository}))
    monkeypatch.setattr(module, f'{kind}_document_manager', manager)
    service = getattr(module, kind.title() + 'DocumentService')()
    return kind, service, repository, manager


@pytest.mark.parametrize('operation', ['create_file', 'save_file'])
@pytest.mark.parametrize('failure', ['false', 'exception'])
async def test_failed_metadata_discards_only_new_version(document_service, operation, failure):
    kind, service, repository, manager = document_service
    repository.file_exists.return_value = operation == 'save_file'
    if failure == 'exception':
        repository.add_file_metadata.side_effect = OSError('metadata failed')
        repository.update_file_metadata.side_effect = OSError('metadata failed')
    result = await getattr(service, operation)(**{f'{kind}_id': 'entity'}, user_id='alice', filename='notes.md', content='new', summary='', log='')
    assert result['success'] is False
    manager.delete_version.assert_awaited_once_with(user_id='alice', **{f'{kind}_id': 'entity'}, filename='notes.md', version_id='new')


async def test_cancelled_write_waits_and_discards_new_version(document_service):
    kind, service, repository, manager = document_service
    started, release = asyncio.Event(), asyncio.Event()
    async def write(**kwargs):
        started.set()
        await release.wait()
        return {'version_id': 'new', 'size': 5}
    manager.create_file.side_effect = write
    task = asyncio.create_task(service.create_file(**{f'{kind}_id': 'entity'}, user_id='alice', filename='notes.md', content='new', summary='', log=''))
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    repository.add_file_metadata.assert_not_awaited()
    manager.delete_version.assert_awaited_once()


async def test_project_storage_failure_preserves_project_and_associations(monkeypatch, set_required_env):
    set_required_env()
    module = import_module('agent_graph.app.services.project.project_service')
    db = SimpleNamespace(get_project=AsyncMock(return_value={'_id': 'project'}),
                         get_conversations_by_project=AsyncMock(return_value=[{'_id': 'conv'}]),
                         update_conversation_project=AsyncMock(return_value=True), delete_project=AsyncMock(return_value=True))
    monkeypatch.setattr(module, 'mongodb_client', db)
    monkeypatch.setattr(module.project_document_manager, 'delete_all_project_files', AsyncMock(return_value=False))
    result = await module.ProjectService().delete_project('project', 'alice')
    assert result['success'] is False
    db.delete_project.assert_not_awaited()
    db.update_conversation_project.assert_not_awaited()


@pytest.mark.parametrize('committed', [True, False])
async def test_cancelled_metadata_waits_and_preserves_confirmed_version(document_service, committed):
    kind, service, repository, manager = document_service
    started, release = asyncio.Event(), asyncio.Event()
    async def commit(**kwargs):
        started.set()
        await release.wait()
        return committed
    repository.add_file_metadata.side_effect = commit
    task = asyncio.create_task(service.create_file(**{f'{kind}_id': 'entity'}, user_id='alice', filename='notes.md', content='new', summary='', log=''))
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert manager.delete_version.await_count == int(not committed)


async def test_successful_document_write_keeps_version(document_service):
    kind, service, repository, manager = document_service
    repository.add_file_metadata.return_value = True
    result = await service.create_file(**{f'{kind}_id': 'entity'}, user_id='alice', filename='notes.md', content='new', summary='', log='')
    assert result['success'] is True
    assert result['file']['version_id'] == 'new'
    manager.delete_version.assert_not_awaited()


async def test_project_push_failure_discards_exact_version(monkeypatch, set_required_env):
    set_required_env()
    module = import_module('agent_graph.app.services.project.project_document_service')
    repo = SimpleNamespace(get_project=AsyncMock(return_value={'user_id': 'alice'}), file_exists=AsyncMock(return_value=False), add_file_metadata=AsyncMock(return_value=False))
    conversation = SimpleNamespace(get_conversation=AsyncMock(return_value={'user_id': 'alice'}), get_file_metadata=AsyncMock(return_value={'summary': 'note'}))
    manager = SimpleNamespace(create_file=AsyncMock(return_value={'version_id': 'new', 'size': 4}), delete_version=AsyncMock(return_value=True))
    monkeypatch.setattr(module, 'mongodb_client', SimpleNamespace(project_repository=repo, conversation_repository=conversation))
    monkeypatch.setattr(module, 'project_document_manager', manager)
    monkeypatch.setattr(module, 'conversation_document_manager', SimpleNamespace(read_file=AsyncMock(return_value='text')))
    result = await module.ProjectDocumentService().push_file_from_conversation('conv', 'project', 'note.md', 'alice')
    assert result['success'] is False
    manager.delete_version.assert_awaited_once_with(user_id='alice', project_id='project', filename='note.md', version_id='new')


@pytest.mark.parametrize('kind', ['conversation', 'project'])
async def test_delete_version_keeps_other_versions(monkeypatch, set_required_env, kind):
    from threading import get_ident
    set_required_env()
    module = import_module(f'agent_graph.app.infrastructure.storage.object_storage.{kind}_document_manager')
    remaining = {'old', 'new', 'concurrent'}
    loop_thread = get_ident()
    def remove(**kwargs):
        assert get_ident() != loop_thread
        assert kwargs['object_name'] == f'{kind}_doc/alice/entity/note.md'
        remaining.remove(kwargs['version_id'])
    monkeypatch.setattr(module, 'minio_client', SimpleNamespace(bucket_name='bucket', client=SimpleNamespace(remove_object=remove)))
    manager = getattr(module, kind.title() + 'DocumentManager')()
    assert await manager.delete_version('alice', 'entity', 'note.md', 'new') is True
    assert remaining == {'old', 'concurrent'}
    with pytest.raises(ValueError):
        await manager.delete_version('alice', 'entity', 'note.md', '')


class ConversationCollection:
    """解析真实文档结构和 positional 路径，拒绝把对象当成数组。"""
    def __init__(self):
        self.document = {'_id': 'conv', 'user_id': 'alice', 'documents': {'total_count': 2, 'files': [
            {'filename': 'other.md', 'summary': 'keep', 'size': 2, 'current_version_id': 'other', 'logs': []},
            {'filename': 'note.md', 'summary': 'old', 'size': 3, 'current_version_id': 'old', 'logs': []},
        ]}}
        self.fail_write = False

    async def find_one(self, query, projection=None):
        from copy import deepcopy
        if query['_id'] != self.document['_id']:
            return None
        name = query.get('documents.files.filename')
        if name and not any(item['filename'] == name for item in self.document['documents']['files']):
            return None
        return deepcopy(self.document)

    async def count_documents(self, query):
        return int(await self.find_one(query) is not None)

    async def update_one(self, query, updates):
        from copy import deepcopy
        if self.fail_write:
            raise OSError('database unavailable')
        if not await self.find_one(query):
            return SimpleNamespace(modified_count=0)
        changed = deepcopy(self.document)
        def target(path):
            current = changed
            parts = path.split('.')
            for part in parts[:-1]:
                if part == '$':
                    if not isinstance(current, list):
                        raise ValueError('positional operator requires an array')
                    current = next(item for item in current if item['filename'] == query['documents.files.filename'])
                else:
                    current = current[part]
            return current, parts[-1]
        for path, value in updates.get('$set', {}).items():
            current, key = target(path)
            current[key] = value
        for path, value in updates.get('$push', {}).items():
            current, key = target(path)
            position = value.get('$position', len(current[key]))
            current[key][position:position] = value['$each']
        self.document = changed
        return SimpleNamespace(modified_count=1)


@pytest.mark.parametrize('write_fails', [False, True])
async def test_save_uses_real_repository_and_correct_file_array(monkeypatch, set_required_env, write_fails):
    set_required_env()
    module = import_module('agent_graph.app.services.conversation.conversation_document_service')
    repo_module = import_module('agent_graph.app.infrastructure.database.mongodb.repositories.conversation_repository')
    collection = ConversationCollection()
    collection.fail_write = write_fails
    repository = repo_module.ConversationRepository(None, collection)
    manager = SimpleNamespace(update_file=AsyncMock(return_value={'version_id': 'new', 'size': 10}), delete_version=AsyncMock(return_value=True))
    monkeypatch.setattr(module, 'mongodb_client', SimpleNamespace(conversation_repository=repository))
    monkeypatch.setattr(module, 'conversation_document_manager', manager)
    result = await module.ConversationDocumentService().save_file('conv', 'note.md', 'new content', 'new summary', 'edited', 'alice')
    assert result['success'] is not write_fails
    other, note = collection.document['documents']['files']
    assert other == {'filename': 'other.md', 'summary': 'keep', 'size': 2, 'current_version_id': 'other', 'logs': []}
    if write_fails:
        assert note['current_version_id'] == 'old'
        manager.delete_version.assert_awaited_once_with(user_id='alice', conversation_id='conv', filename='note.md', version_id='new')
    else:
        assert (note['current_version_id'], note['summary'], note['size']) == ('new', 'new summary', 10)
        assert note['logs'][0]['comment'] == 'edited' and note['logs'][0]['agent'] == 'user'
        assert note['updated_at'] == collection.document['updated_at']
        manager.delete_version.assert_not_awaited()
