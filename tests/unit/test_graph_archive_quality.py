import io
import os
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from agent_graph.app.api import graph_import_export_routes as routes
from agent_graph.app.services.graph import graph_archive_service as archive_service
from agent_graph.app.models.auth_schema import CurrentUser
from agent_graph.app.models.graph_schema import GraphFilePath


@pytest.fixture
def archive_context(monkeypatch, tmp_path):
    user = CurrentUser(user_id='owner', role='normal')
    monkeypatch.setattr(archive_service.graph_service, 'get_graph', AsyncMock(return_value=None))
    monkeypatch.setattr(archive_service.graph_service, 'save_graph', AsyncMock(return_value=True))
    monkeypatch.setattr(archive_service.graph_service, 'validate_graph', AsyncMock(return_value=(True, None)))
    monkeypatch.setattr(archive_service.mongodb_client, 'get_mcp_config', AsyncMock(return_value={}))
    monkeypatch.setattr(archive_service.model_service, 'get_all_models', AsyncMock(return_value=[]))
    return SimpleNamespace(user=user, root=tmp_path)


@pytest.mark.parametrize('kind', ['json','zip'])
async def test_upload_read_failure_closes_temp_fd(archive_context, monkeypatch, kind):
    real_create = routes.tempfile.mkstemp
    opened = []
    def create(*args, **kwargs):
        result = real_create(*args, **kwargs)
        opened.append(result)
        return result
    monkeypatch.setattr(routes.tempfile, 'mkstemp', create)
    upload = UploadFile(io.BytesIO(), filename='data.'+kind)
    upload.read = AsyncMock(side_effect=OSError('upload failed'))
    route = routes.import_graph_from_file if kind=='json' else routes.import_graph_package_from_file
    try:
        with pytest.raises(HTTPException):
            await route(upload, archive_context.user)
        for fd, path in opened:
            assert not os.path.exists(path)
            with pytest.raises(OSError):
                os.fstat(fd)
    finally:
        for fd, _ in opened:
            try:
                os.close(fd)
            except OSError:
                pass


async def test_export_send_failure_releases_archive(archive_context, monkeypatch):
    directory = archive_context.root / 'archive'
    directory.mkdir()
    monkeypatch.setattr(routes.tempfile, 'mkdtemp', lambda **kwargs: str(directory))
    archive_service.graph_service.get_graph.return_value={'config':{'name':'g','nodes':[]}}
    response = await routes.export_graph('g', BackgroundTasks(), archive_context.user)
    async def send(message):
        raise OSError('disconnected')
    async def receive():
        return {'type':'http.disconnect'}
    with pytest.raises(OSError):
        await response({'type':'http','method':'GET','headers':[], 'asgi':{'spec_version':'2.4'}}, receive, send)
    assert not directory.exists()


async def test_package_invalid_json_is_bad_request(archive_context):
    path=archive_context.root / 'invalid.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('config.json','{bad')
    with pytest.raises(HTTPException) as error:
        await routes.import_graph_package(GraphFilePath(file_path=str(path)), archive_context.user)
    assert error.value.status_code == 400


async def test_package_reports_successfully_copied_tools(archive_context, monkeypatch):
    path=archive_context.root / 'valid.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('config.json',json.dumps({'name':'g','nodes':[]}))
        archive.writestr('mcp/tool/server.py','print(1)')
    tools=archive_context.root/'tools'
    tools.mkdir()
    monkeypatch.setattr(routes, 'settings', SimpleNamespace(get_mcp_tool_dir=lambda name: tools/name))
    result=await routes.import_graph_package(GraphFilePath(file_path=str(path)), archive_context.user)
    assert result['imported_mcp_tools'] == ['tool']
    assert (tools/'tool'/'server.py').exists()


async def test_package_model_failure_does_not_report_success(archive_context, monkeypatch):
    path=archive_context.root/'models.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('config.json',json.dumps({'name':'g','nodes':[]}))
        archive.writestr('attachment/model.json',json.dumps({'models':[{'name':'new'}]}))
    monkeypatch.setattr(archive_service.model_service,'add_model',AsyncMock(return_value=False))
    with pytest.raises(HTTPException) as error:
        await routes.import_graph_package(GraphFilePath(file_path=str(path)),archive_context.user)
    assert error.value.status_code == 500
    archive_service.graph_service.save_graph.assert_not_awaited()


async def test_package_partial_import_reports_created_resources(archive_context, monkeypatch):
    path=archive_context.root/'models.zip'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('config.json',json.dumps({'name':'g','nodes':[]}))
        archive.writestr('attachment/model.json',json.dumps({'models':[{'name':'first'}, {'name':'second'}]}))
    monkeypatch.setattr(archive_service.model_service,'add_model',AsyncMock(side_effect=[True,False]))
    with pytest.raises(HTTPException) as error:
        await routes.import_graph_package(GraphFilePath(file_path=str(path)),archive_context.user)
    assert error.value.detail['partial_import'] is True
    assert error.value.detail['imported']['models']==['first']
    archive_service.graph_service.save_graph.assert_not_awaited()


async def test_graph_archive_offloads_and_waits_for_worker_on_cancel(archive_context, monkeypatch):
    import asyncio
    import threading
    entered=threading.Event()
    release=threading.Event()
    seen={}
    def write(directory,*args):
        seen['directory']=directory
        seen['thread']=threading.get_ident()
        entered.set()
        release.wait(5)
        assert os.path.isdir(directory)
        return str(archive_context.root/'unused')
    monkeypatch.setattr(archive_service,'write_package',write)
    archive_service.graph_service.get_graph.return_value={'config':{'name':'g','nodes':[]}}
    task=asyncio.create_task(archive_service.GraphArchiveService(routes.settings).export_package('g','owner'))
    try:
        while not entered.is_set():
            await asyncio.sleep(0)
        assert seen['thread'] != threading.get_ident()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert os.path.isdir(seen['directory'])
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert not os.path.exists(seen['directory'])


async def test_readme_accepts_nullable_tools(archive_context):
    from agent_graph.app.services.graph.graph_resources import add_graph_readme
    archive_service.mongodb_client.get_mcp_config.return_value={'config':{'mcpServers':{'server':{}}}}
    config={'name':'g','nodes':[{'name':'a','model_name':'m','mcp_servers':None,'input_nodes':['start'],'output_nodes':['end']}, {'name':'b','model_name':'m','mcp_servers':['server']}]}
    result=await add_graph_readme(config,'owner')
    assert result['readme']
