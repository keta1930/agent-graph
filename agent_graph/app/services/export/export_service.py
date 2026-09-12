import asyncio
from functools import partial
import json
import logging
import os
import tempfile
import zipfile
from datetime import datetime
from typing import Any, Dict, List, Optional

from agent_graph.app.infrastructure.database.mongodb import mongodb_client
from agent_graph.app.infrastructure.storage.object_storage import minio_client
from agent_graph.app.models.export_schema import validate_export_name
from agent_graph.app.services.conversation.document_archive import remove_archive_directory, run_archive_io
from agent_graph.app.services.export.dataset_info_generator import DatasetInfoGenerator
from agent_graph.app.services.export.formatters.standard import StandardFormatter
from agent_graph.app.services.export.preview.csv_reader import CSVPreviewReader
from agent_graph.app.services.export.preview.jsonl_reader import JSONLPreviewReader
from agent_graph.app.services.export.preview.parquet_reader import ParquetPreviewReader
from agent_graph.app.services.export.writers.csv_writer import CSVWriter
from agent_graph.app.services.export.writers.jsonl_writer import JSONLWriter
from agent_graph.app.services.export.writers.parquet_writer import ParquetWriter

logger = logging.getLogger(__name__)


class ExportService:
    """协调已授权的会话读取和数据集存储。"""

    def __init__(self):
        self.formatters = {"standard": StandardFormatter()}
        self.writers = {"jsonl": JSONLWriter(), "parquet": ParquetWriter(), "csv": CSVWriter()}
        self.preview_readers = {"jsonl": JSONLPreviewReader(), "parquet": ParquetPreviewReader(), "csv": CSVPreviewReader()}

    def _get_storage_path(self, data_format: str, dataset_name: str, user_id: str = "default_user") -> str:
        validate_export_name(dataset_name)
        if data_format not in self.formatters:
            raise ValueError(f"不支持的数据格式: {data_format}")
        return f"conversation_export/{user_id}/{data_format}/{dataset_name}/"

    async def export_conversations(self, dataset_name: str, file_name: str, conversation_ids: List[str],
                                   file_format: str = "jsonl", data_format: str = "standard",
                                   user_id: str = "default_user") -> Dict[str, Any]:
        """验证归属后在线程内生成和上传数据集。"""
        try:
            storage_path = self._get_storage_path(data_format, dataset_name, user_id)
            validate_export_name(file_name)
            if file_format not in self.writers:
                raise ValueError(f"不支持的文件格式: {file_format}")
            conversations = await self._get_conversations_data(conversation_ids, user_id)
            if not conversations:
                raise ValueError("未找到有效的对话数据")
            return await asyncio.to_thread(self._export_sync, dataset_name, file_name, conversations,
                                           file_format, data_format, storage_path)
        except Exception as exc:
            logger.exception("导出对话数据失败")
            return {"success": False, "message": f"导出失败: {exc}"}

    def _export_sync(self, dataset_name, file_name, conversations, file_format, data_format, storage_path):
        """在同一线程内完成格式化、文件写入和上传并释放临时目录。"""
        data = self.formatters[data_format].format(conversations)
        if not data:
            raise ValueError("格式化后没有有效数据")
        writer = self.writers[file_format]
        full_name = file_name + writer.get_file_extension()
        with tempfile.TemporaryDirectory() as directory:
            data_path = os.path.join(directory, full_name)
            writer.write(data, data_path)
            info_path = os.path.join(directory, "dataset_info.json")
            DatasetInfoGenerator.save_to_file(DatasetInfoGenerator.generate(dataset_name, full_name, len(data)), info_path)
            if not minio_client.upload_file(storage_path + full_name, data_path):
                raise OSError("上传数据文件失败")
            if not minio_client.upload_file(storage_path + "dataset_info.json", info_path):
                raise OSError("上传数据集信息失败")
            file_size = self._format_file_size(os.path.getsize(data_path))
        return {"success": True, "message": f"成功导出 {len(data)} 条数据", "dataset_name": dataset_name,
                "preview_data": data[:20], "total_records": len(data),
                "file_info": {"file_format": file_format, "file_size": file_size}}

    async def _get_conversations_data(self, conversation_ids: List[str], user_id: str) -> List[Dict[str, Any]]:
        """先验证全部归属，再读取正文；重复 ID 复用读取结果。"""
        authorized = []
        for conversation_id in dict.fromkeys(conversation_ids):
            conversation = await mongodb_client.get_conversation(conversation_id)
            if conversation:
                if conversation.get("user_id") != user_id:
                    raise ValueError("Conversation不存在或无权限访问")
                authorized.append(conversation_id)
        documents = {}
        for conversation_id in authorized:
            conversation = await mongodb_client.get_conversation_with_messages(conversation_id)
            if conversation:
                if conversation.get("user_id") != user_id:
                    raise ValueError("Conversation不存在或无权限访问")
                documents[conversation_id] = conversation
        return [documents[cid] for cid in conversation_ids if cid in documents]

    @staticmethod
    def _archive_entry(object_name: str, storage_path: str) -> str:
        """校验存储对象的 ZIP 相对路径。"""
        if not object_name.startswith(storage_path):
            raise ValueError("对象不属于当前数据集")
        name = object_name[len(storage_path):]
        for part in name.split('/'):
            validate_export_name(part)
        return name

    async def download_dataset(self, dataset_name: str, data_format: str = "standard",
                               user_id: str = "default_user") -> Optional[str]:
        """归档成功后移交临时目录，异常或取消时等待线程并清理。"""
        directory = None
        complete = False
        try:
            storage_path = self._get_storage_path(data_format, dataset_name, user_id)
            directory = tempfile.mkdtemp()
            path = os.path.join(directory, "dataset.zip")
            await run_archive_io(partial(self._download_sync, storage_path, directory, path))
            complete = True
            return path
        except Exception:
            logger.exception("下载数据集失败")
            return None
        finally:
            if directory and not complete:
                await remove_archive_directory(directory)

    def _download_sync(self, storage_path, directory, path):
        """逐个下载完整对象并打包，任何失败都中止归档。"""
        objects = minio_client.list_objects(storage_path)
        if not objects:
            raise FileNotFoundError("数据集不存在")
        entries = [(obj['object_name'], self._archive_entry(obj['object_name'], storage_path)) for obj in objects]
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            for index, (object_name, entry) in enumerate(entries):
                local_path = os.path.join(directory, f"object-{index}")
                if not minio_client.download_file(object_name, local_path):
                    raise OSError(f"下载数据文件失败: {entry}")
                archive.write(local_path, entry)
                os.remove(local_path)

    async def preview_dataset(self, dataset_name: str, data_format: str = "standard",
                              user_id: str = "default_user") -> Dict[str, Any]:
        """在线程内读取信息和预览文件。"""
        try:
            path = self._get_storage_path(data_format, dataset_name, user_id)
            return await asyncio.to_thread(self._preview_sync, dataset_name, path)
        except Exception as exc:
            logger.exception("预览数据集失败")
            return {"success": False, "message": f"预览失败: {exc}"}

    def _preview_sync(self, dataset_name, storage_path):
        """根据数据集元信息选择预览读取器。"""
        content = minio_client.download_content(storage_path + "dataset_info.json")
        if not content:
            raise FileNotFoundError("未找到数据集信息")
        info = json.loads(content)
        filename = info.get(dataset_name, {}).get("file_name")
        data_file = None
        if filename:
            self._archive_entry(storage_path + filename, storage_path)
            candidate = storage_path + filename
            if minio_client.object_exists(candidate):
                data_file = candidate
        if data_file is None:
            for obj in minio_client.list_objects(storage_path):
                self._archive_entry(obj['object_name'], storage_path)
                if not obj['object_name'].endswith('dataset_info.json'):
                    data_file = obj['object_name']
                    break
        if data_file is None:
            raise FileNotFoundError("未找到数据文件")
        extension = os.path.splitext(data_file)[1].lower().lstrip('.')
        if extension not in self.preview_readers:
            raise ValueError(f"不支持的预览格式: {extension}")
        preview = self.preview_readers[extension].preview(data_file, max_records=20)
        return {"success": True, "dataset_name": dataset_name, "dataset_info": info,
                "preview_data": preview, "total_records": info.get(dataset_name, {}).get("num_samples", 0)}

    async def delete_dataset(self, dataset_name: str, data_format: str = "standard",
                             user_id: str = "default_user") -> Dict[str, Any]:
        """全部对象删除成功才报告成功。"""
        try:
            path = self._get_storage_path(data_format, dataset_name, user_id)
            await asyncio.to_thread(self._delete_sync, path)
            return {"success": True, "message": f"成功删除数据集 {dataset_name}", "dataset_name": dataset_name}
        except Exception as exc:
            logger.exception("删除数据集失败")
            return {"success": False, "message": f"删除失败: {exc}"}

    @staticmethod
    def _delete_sync(path):
        """尝试删除每个对象并聚合失败。"""
        objects = minio_client.list_objects(path)
        results = [minio_client.delete_object(obj['object_name']) for obj in objects]
        if not results or not all(results):
            raise OSError("数据集不存在或部分文件删除失败")

    async def list_datasets(self, user_id: str = "default_user") -> Dict[str, Any]:
        """直接利用列表返回的元信息，不逐数据集重复请求 HEAD。"""
        try:
            return await asyncio.to_thread(self._list_sync, user_id)
        except Exception:
            logger.exception("列出数据集失败")
            return {"success": False, "exports": []}

    @staticmethod
    def _list_sync(user_id):
        """由 dataset_info 对象构建用户数据集列表。"""
        prefix = f"conversation_export/{user_id}/"
        exports = []
        for obj in minio_client.list_objects(prefix):
            name = obj['object_name']
            if not name.startswith(prefix):
                continue
            parts = name[len(prefix):].split('/')
            if len(parts) != 3 or parts[2] != 'dataset_info.json':
                continue
            modified = obj.get('last_modified')
            local_time = datetime.fromisoformat(modified.replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M:%S') if modified else ''
            exports.append({'dataset_name': parts[1], 'data_format': parts[0], 'created_at': local_time})
        exports.sort(key=lambda item: item['created_at'], reverse=True)
        return {'success': True, 'exports': exports}

    @staticmethod
    def _format_file_size(size_bytes: int) -> str:
        if size_bytes < 1024:
            return f"{size_bytes} B"
        if size_bytes < 1024 ** 2:
            return f"{size_bytes / 1024:.1f} KB"
        if size_bytes < 1024 ** 3:
            return f"{size_bytes / 1024 ** 2:.1f} MB"
        return f"{size_bytes / 1024 ** 3:.1f} GB"


export_service = ExportService()
