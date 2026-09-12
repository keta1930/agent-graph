"""Graph 归档装配与导入协调，临时资源由创建者交接给响应。"""
import copy
import json
import logging
import shutil
import tempfile
import zipfile
from datetime import datetime
from functools import partial
from pathlib import Path

from pydantic import ValidationError
from agent_graph.app.infrastructure.database.mongodb import mongodb_client
from agent_graph.app.models.graph_schema import GraphConfig
from agent_graph.app.services.conversation.document_archive import run_archive_io, remove_archive_directory
from agent_graph.app.services.graph.graph_resources import collect_graph_resources, add_graph_readme
from agent_graph.app.services.graph.graph_service import graph_service
from agent_graph.app.services.mcp.mcp_service import mcp_service
from agent_graph.app.services.model.model_service import model_service

logger = logging.getLogger(__name__)


class GraphArchiveError(Exception):
    """由 HTTP 边界转换的导入导出错误。"""

    def __init__(self, status_code, detail):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


def read_json(path):
    """读取归档内 JSON 并将格式错误归类为无效输入。"""
    try:
        with Path(path).open(encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError as exc:
        raise GraphArchiveError(404, f"找不到文件 '{path}'") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise GraphArchiveError(400, "文件不是有效的JSON格式") from exc


def validate_config(config):
    """先验证配置形状，引用存在性留到附属组件导入后检查。"""
    try:
        GraphConfig.model_validate(config)
    except ValidationError as exc:
        raise GraphArchiveError(400, f"图配置无效: {exc}") from exc
    return config


def extract_package(path, directory):
    """解包和解析全部输入，异步协调前完成文件格式检查。"""
    try:
        with zipfile.ZipFile(path) as archive:
            archive.extractall(directory)
    except FileNotFoundError as exc:
        raise GraphArchiveError(404, f"找不到文件 '{path}'") from exc
    except zipfile.BadZipFile as exc:
        raise GraphArchiveError(400, "无效的ZIP文件") from exc
    root = Path(directory)
    if not (root / "config.json").is_file():
        raise GraphArchiveError(400, "ZIP包中缺少config.json文件")
    config = read_json(root / "config.json")
    if isinstance(config, dict) and not config.get("name"):
        config["name"] = Path(path).stem
    validate_config(config)
    mcp_path, model_path = root / "attachment/mcp.json", root / "attachment/model.json"
    mcp = read_json(mcp_path) if mcp_path.exists() else {"mcpServers": {}}
    models = read_json(model_path) if model_path.exists() else {"models": []}
    if not isinstance(mcp, dict) or not isinstance(mcp.get("mcpServers", {}), dict):
        raise GraphArchiveError(400, "MCP配置格式不正确")
    if any(not isinstance(value, dict) for value in mcp.get("mcpServers", {}).values()):
        raise GraphArchiveError(400, "MCP服务器配置必须是对象")
    if not isinstance(models, dict) or not isinstance(models.get("models", []), list):
        raise GraphArchiveError(400, "模型配置格式不正确")
    if any(not isinstance(model, dict) or not isinstance(model.get("name"), str) for model in models.get("models", [])):
        raise GraphArchiveError(400, "模型配置缺少名称")
    if (root / "readme.md").is_file():
        config["readme"] = (root / "readme.md").read_text(encoding="utf-8")
    tools = sorted(path.name for path in (root / "mcp").iterdir() if path.is_dir()) if (root / "mcp").is_dir() else []
    return config, mcp.get("mcpServers", {}), models.get("models", []), tools


def copy_tool(source, target):
    """只清理本次独占创建的目录，不删除其他导入已建的工具。"""
    try:
        target.mkdir()
    except FileExistsError:
        return False
    try:
        shutil.copytree(source, target, dirs_exist_ok=True)
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return True


def write_package(directory, graph_name, config, mcp, models, settings):
    """在线程内直接打包工具树，避免额外复制整个虚拟环境。"""
    path = Path(directory) / "graph.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("config.json", json.dumps(config, ensure_ascii=False, indent=2))
        if config.get("readme"):
            archive.writestr("readme.md", config["readme"])
        archive.writestr("attachment/mcp.json", json.dumps(mcp, ensure_ascii=False, indent=2))
        archive.writestr("attachment/model.json", json.dumps({"models": models}, ensure_ascii=False, indent=2))
        for name in mcp["mcpServers"]:
            source = settings.get_mcp_tool_dir(name)
            if source.is_dir():
                for file in sorted(source.rglob("*")):
                    if file.is_file():
                        archive.write(file, str(Path("mcp") / name / file.relative_to(source)))
    return str(path)


class GraphArchiveService:
    """保持 Graph 包布局与跨用户组件导入语义。"""

    def __init__(self, settings):
        self.settings = settings

    async def import_json(self, path, user_id):
        config = await run_archive_io(partial(read_json, path))
        validate_config(config)
        await self._ensure_new(config["name"], user_id)
        await self._validate_references(config, user_id)
        await add_graph_readme(config, user_id)
        await self._save(config, user_id)
        return {"status": "success", "message": f"图 '{config['name']}' 导入成功"}

    async def _ensure_new(self, name, user_id):
        if await graph_service.get_graph(name, user_id=user_id):
            raise GraphArchiveError(409, f"已存在名为 '{name}' 的图")

    async def _validate_references(self, config, user_id):
        valid, error = await graph_service.validate_graph(config, user_id=user_id)
        if not valid:
            raise GraphArchiveError(400, f"图配置无效: {error}")

    async def _save(self, config, user_id):
        if not await graph_service.save_graph(config["name"], config, user_id=user_id):
            raise GraphArchiveError(500, "保存图配置失败")

    async def import_package(self, path, user_id):
        """失败时报告已导入资源，保留可重试信息而不回滚共享资源。"""
        if not str(path).endswith(".zip"):
            raise GraphArchiveError(400, "文件必须是ZIP格式")
        directory = tempfile.mkdtemp()
        report = {"needs_api_key": [], "skipped_models": [], "skipped_servers": [], "imported_mcp_tools": [], "skipped_mcp_tools": []}
        created = {"models": [], "servers": [], "tools": report["imported_mcp_tools"]}
        try:
            config, servers, models, tools = await run_archive_io(partial(extract_package, path, directory))
            await self._ensure_new(config["name"], user_id)
            await self._import_models(models, user_id, report, created)
            await self._import_servers(servers, user_id, report, created)
            for name in tools:
                copied = await run_archive_io(partial(copy_tool, Path(directory) / "mcp" / name, self.settings.get_mcp_tool_dir(name)))
                report["imported_mcp_tools" if copied else "skipped_mcp_tools"].append(name)
            await self._validate_references(config, user_id)
            await self._save(config, user_id)
            return {"status": "success", "message": f"图包 '{config['name']}' 导入成功", **report}
        except GraphArchiveError as exc:
            if any(created.values()):
                raise GraphArchiveError(exc.status_code, {"message": str(exc), "imported": created, "partial_import": True}) from exc
            raise
        except Exception as exc:
            raise GraphArchiveError(500, {"message": "导入图包失败", "imported": created, "partial_import": any(created.values())}) from exc
        finally:
            await remove_archive_directory(directory)

    async def _import_models(self, models, user_id, report, created):
        existing = {model["name"] for model in await model_service.get_all_models(user_id=user_id)}
        for model in models:
            name = model["name"]
            if name in existing:
                report["skipped_models"].append(name)
                continue
            if not await model_service.add_model(user_id, model):
                raise GraphArchiveError(500, f"导入模型失败: {name}")
            created["models"].append(name)
            existing.add(name)
            if not model.get("api_key"):
                report["needs_api_key"].append(name)

    async def _import_servers(self, servers, user_id, report, created):
        if not servers:
            return
        document = await mongodb_client.get_mcp_config()
        config = copy.deepcopy((document or {}).get("config", {"mcpServers": {}}))
        available = config.setdefault("mcpServers", {})
        imported = []
        for name, server in servers.items():
            if name in available:
                report["skipped_servers"].append(name)
            else:
                available[name] = {**server, "provider_user_id": user_id, "created_at": datetime.now().isoformat()}
                imported.append(name)
        if imported:
            result = await mcp_service.update_config(config, (document or {}).get("version", 0))
            error = result.get("status", {}).get("error")
            if error:
                raise GraphArchiveError(409 if error == "version_conflict" else 500, f"导入MCP配置失败: {error}")
            created["servers"].extend(imported)

    async def export_package(self, graph_name, user_id):
        document = await graph_service.get_graph(graph_name, user_id=user_id)
        if not document:
            raise GraphArchiveError(404, f"找不到图 '{graph_name}'")
        config = document.get("config", {})
        mcp, models = await collect_graph_resources(config, user_id)
        for server in mcp["mcpServers"].values():
            server.pop("provider_user_id", None)
            server.pop("created_at", None)
        safe_models = []
        for model in models:
            safe = {key: value for key, value in model.items() if key not in {"user_id", "created_at", "updated_at", "_id"}}
            safe["api_key"] = ""
            safe_models.append(safe)
        directory = tempfile.mkdtemp()
        complete = False
        try:
            path = await run_archive_io(partial(write_package, directory, graph_name, config, mcp, safe_models, self.settings))
            complete = True
            return path
        finally:
            if not complete:
                await remove_archive_directory(directory)
