import asyncio
import logging
import os
import traceback
import subprocess
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Dict, Any, Optional
import uvicorn
from asyncer import asyncify
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client
from agent_graph.app.core.config import get_settings


settings = get_settings()

logger = logging.getLogger("mcp_client")

SERVERS = {}
CONFIG = {}
_server_locks: dict[str, asyncio.Lock] = {}
_config_lock = asyncio.Lock()
_closing = False
_shutdown_task: asyncio.Task | None = None


def _server_lock(name: str) -> asyncio.Lock:
    """对同名服务器串行变更，保留异名服务器并发。"""
    return _server_locks.setdefault(name, asyncio.Lock())


async def _cleanup_registered_server(name: str) -> None:
    """等待同名连接请求结束，再清理注册的实例。"""
    async with _server_lock(name):
        server = SERVERS.get(name)
        if server is not None:
            await server.cleanup()
            SERVERS.pop(name, None)


async def _cleanup_servers() -> None:
    """停止接收配置与连接请求，等待所有连接退出。"""
    global _closing
    async with _config_lock:
        _closing = True
        results = await asyncio.gather(
            *(_cleanup_registered_server(name) for name in list(SERVERS)),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException):
                logger.error("清理 MCP 连接失败: %s", result)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """管理 MCP server 连接的生命周期。"""
    global _closing, _config_lock, _server_locks, _shutdown_task
    _closing = False
    _config_lock = asyncio.Lock()
    _server_locks = {}
    _shutdown_task = None
    logger.info("MCP 客户端启动")
    try:
        yield
    finally:
        logger.info("MCP 客户端关闭")
        await _cleanup_servers()


app = FastAPI(
    title="MCP Client",
    description="MCP Client for Agent-Graph",
    lifespan=lifespan,
)


class MCPServer:
    """管理单个 MCP 服务器的连接、工具调用与子进程。"""

    def __init__(self, name: str, config: Dict[str, Any]):
        self.name = name
        self.config = config
        self.session: Optional[ClientSession] = None
        self.stdio = None
        self.write = None
        self.tools = []
        self.error = None
        self.init_attempted = False
        self.ai_process = None
        self.is_ai_generated = config.get("ai_generated", False)
        self._connected = False
        self._lifecycle_lock = asyncio.Lock()
        self._call_lock = asyncio.Lock()
        self._owner: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def connect(self) -> bool:
        """等待专属任务建立连接，重复请求复用已连接会话。"""
        async with self._lifecycle_lock:
            if self.is_connected():
                return True
            if self._owner is not None:
                await self._wait_owner()
            self.error = None
            self.init_attempted = False
            self._stop = asyncio.Event()
            ready = asyncio.get_running_loop().create_future()
            self._owner = asyncio.create_task(
                self._run_connection(ready), name=f"mcp-connection:{self.name}"
            )
            try:
                return await asyncio.shield(ready)
            except asyncio.CancelledError:
                self._owner.cancel()
                await asyncio.gather(self._owner, return_exceptions=True)
                raise

    async def _run_connection(self, ready: asyncio.Future) -> None:
        """在同一个 task 中进入和退出 MCP/AnyIO 上下文。"""
        try:
            async with AsyncExitStack() as stack:
                if self.config.get("disabled", False):
                    raise ValueError("服务器已禁用")
                try:
                    async with asyncio.timeout(self.config.get("timeout", 10)):
                        self._validate_transport()
                        if self.is_ai_generated:
                            if not await self._start_ai_process():
                                raise RuntimeError(self.error)
                            await asyncio.sleep(3)
                        await self._open_session(stack)
                except TimeoutError:
                    self.error = f"连接超时（{self.config.get('timeout', 10)}秒）。可能是服务器未响应或配置不正确。"
                    logger.error("服务器 '%s': %s", self.name, self.error)
                    return
                except Exception as exc:
                    self.error = str(exc)
                    logger.exception("服务器 '%s' 连接失败", self.name)
                    return
                self.init_attempted = True
                self._connected = True
                ready.set_result(True)
                await self._stop.wait()
        except asyncio.CancelledError:
            self.error = "连接已取消"
            raise
        except Exception as exc:
            self.error = str(exc)
            logger.exception("服务器 '%s' 连接失败", self.name)
        finally:
            self._connected = False
            self.session = None
            self.stdio = None
            self.write = None
            self.tools = []
            try:
                await self._cleanup_ai_process()
            finally:
                self.init_attempted = True
                if not ready.done():
                    ready.set_result(False)

    def _validate_transport(self) -> None:
        """在创建资源前校验传输配置。"""
        transport = self.config.get("transportType", "stdio")
        if transport == "stdio":
            if not self.config.get("command"):
                raise ValueError("stdio传输类型未指定命令")
        elif transport in ("sse", "streamable_http"):
            if not self.config.get("url"):
                raise ValueError(f"{'SSE' if transport == 'sse' else transport}传输类型未指定URL")
        else:
            raise ValueError(f"使用了不支持的传输类型: {transport}")

    async def _open_session(self, stack: AsyncExitStack) -> None:
        """建立传输并完成会话握手和工具发现。"""
        transport = self.config.get("transportType", "stdio")
        if transport == "stdio":
            env = os.environ.copy()
            env.update(self.config.get("env") or {})
            parameters = StdioServerParameters(
                command=self.config["command"],
                args=self.config.get("args", []),
                env=env,
            )
            streams = await stack.enter_async_context(stdio_client(parameters))
        elif transport == "sse":
            streams = await stack.enter_async_context(
                sse_client(url=self.config["url"], headers=self.config.get("headers"))
            )
        else:
            read, write, _ = await stack.enter_async_context(
                streamablehttp_client(url=self.config["url"], headers=self.config.get("headers"))
            )
            streams = (read, write)
        self.stdio, self.write = streams
        self.session = await stack.enter_async_context(ClientSession(*streams))
        await self.session.initialize()
        response = await self.session.list_tools()
        self.tools = response.tools
        logger.info("已连接到服务器 '%s'，工具: %s", self.name, [tool.name for tool in self.tools])

    async def _start_ai_process(self) -> bool:
        """在线程中启动 AI 工具进程并准备日志文件。"""
        worker = asyncio.create_task(asyncify(self._spawn_ai_process)())
        cancelled = False
        # 线程不能被取消；必须等进程归还后，再由 owner 的 finally 回收。
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                cancelled = True
        result = worker.result()
        if cancelled:
            raise asyncio.CancelledError
        return result

    async def _cleanup_ai_process(self) -> None:
        """等待 AI 子进程退出时让出事件循环。"""
        if self.ai_process is not None:
            await asyncify(self._stop_ai_process)()

    def _spawn_ai_process(self) -> bool:
        """创建工具进程并将输出写入其日志目录。"""
        from agent_graph.app.infrastructure.storage.file_storage import FileManager

        try:
            script = FileManager.get_mcp_tool_main_script(self.name)
            python = FileManager.get_mcp_tool_venv_python(self.name)
            if not script or not python:
                self.error = f"找不到AI生成工具 '{self.name}' 的脚本或虚拟环境"
                return False
            log_dir = settings.get_mcp_tool_dir(self.name)
            with open(log_dir / "mcp_stdout.log", "w") as stdout, open(log_dir / "mcp_stderr.log", "w") as stderr:
                self.ai_process = subprocess.Popen(
                    [str(python), str(script)], stdout=stdout, stderr=stderr,
                    cwd=str(script.parent),
                )
            logger.info("AI工具进程已启动，PID: %s", self.ai_process.pid)
            return True
        except Exception as exc:
            self.error = f"启动AI工具进程时出错: {exc}"
            logger.exception("启动AI工具进程失败")
            return False

    def _stop_ai_process(self) -> None:
        """先请求进程退出，超时后终止并回收子进程。"""
        process = self.ai_process
        if process is None:
            return
        try:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        except Exception:
            logger.exception("关闭AI工具进程失败")
        finally:
            self.ai_process = None

    async def _wait_owner(self) -> None:
        """等待资源所有者退出，清理调用的取消不会中断资源释放。"""
        if self._owner is None:
            return
        waiter = asyncio.gather(self._owner, return_exceptions=True)
        try:
            await asyncio.shield(waiter)
        except asyncio.CancelledError:
            await asyncio.shield(waiter)
            raise

    async def cleanup(self) -> None:
        """停止新工具调用，并等待所有者释放会话和进程。"""
        async with self._lifecycle_lock:
            self._connected = False
            try:
                async with self._call_lock:
                    self._stop.set()
                    await self._wait_owner()
            except asyncio.CancelledError:
                async with self._call_lock:
                    self._stop.set()
                    await self._wait_owner()
                raise
            finally:
                if self._owner is not None and self._owner.done():
                    self._owner = None

    def is_connected(self) -> bool:
        """仅在握手和工具发现完成后报告已连接。"""
        return self._connected

    async def call_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """串行调用会话工具，保留调用超时的错误响应格式。"""
        timeout = self.config.get("timeout", 60)
        async with self._call_lock:
            if not self.is_connected():
                raise RuntimeError(f"服务器 '{self.name}' 未连接")
            if not any(tool.name == tool_name for tool in self.tools):
                raise ValueError(f"服务器 '{self.name}' 没有提供工具 '{tool_name}'")
            try:
                async with asyncio.timeout(timeout):
                    result = await self.session.call_tool(tool_name, params)
                return {"tool_name": tool_name, "server_name": self.name, "content": result.content}
            except TimeoutError:
                error = f"Tool execution timed out after {timeout} seconds. The operation was canceled."
            except Exception as exc:
                error = str(exc)
                logger.exception("调用工具 '%s' 时出错", tool_name)
            return {
                "tool_name": tool_name, "server_name": self.name,
                "error": error, "content": f"ERROR: {error}",
            }


# 工具调用数据模型
class ToolCallData(BaseModel):
    server_name: str
    tool_name: str
    params: Dict[str, Any]


# 配置更新通知数据模型
class ConfigUpdateNotification(BaseModel):
    config: Dict[str, Any]


# 服务器连接请求数据模型
class ServerConnectRequest(BaseModel):
    server_name: str


# API端点

@app.get("/")
async def root():
    """客户端状态检查"""
    return {"status": "running", "servers_connected": len(SERVERS)}


@app.post("/load_config")
async def load_config(notification: ConfigUpdateNotification, background_tasks: BackgroundTasks):
    """加载MCP配置"""
    global CONFIG

    try:
        new_config = notification.config
        logger.info("收到配置更新通知")

        background_tasks.add_task(process_config_update, new_config)

        return {"status": "accepted", "message": "配置加载请求已接受"}
    except Exception as e:
        logger.error(f"处理配置加载请求时出错: {str(e)}")
        raise HTTPException(status_code=500, detail=f"配置加载失败: {str(e)}")

@app.get("/servers")
async def get_servers():
    """获取所有服务器的状态"""
    servers_status = {}
    for name, server in SERVERS.items():
        servers_status[name] = {
            "connected": server.is_connected(),
            "init_attempted": server.init_attempted,
            "tools": [tool.name for tool in server.tools] if server.is_connected() else [],
            "error": server.error,
            "transport_type": server.config.get('transportType', 'stdio')
        }
    return servers_status


@app.post("/connect_server")
async def connect_server(request: ServerConnectRequest):
    """连接特定的服务器，等待连接完成后再返回结果"""
    server_name = request.server_name

    if not CONFIG or 'mcpServers' not in CONFIG or server_name not in CONFIG['mcpServers']:
        raise HTTPException(status_code=404, detail=f"找不到服务器配置: {server_name}")

    # 直接在当前请求中执行连接，而不是使用后台任务
    logger.info(f"开始连接服务器: {server_name} (同步等待)")

    # 调用连接函数
    success = await connect_single_server(server_name)

    if success:
        # 连接成功，返回工具列表
        return {
            "status": "connected",
            "server": server_name,
            "tools": [tool.name for tool in SERVERS[server_name].tools]
        }
    else:
        # 连接失败，返回错误信息
        error_msg = SERVERS[server_name].error if server_name in SERVERS else "未知错误"
        raise HTTPException(
            status_code=400,
            detail=f"无法连接到服务器 '{server_name}': {error_msg}"
        )


@app.post("/tool_call")
async def call_tool(tool_data: ToolCallData):
    """直接调用指定的工具"""
    server_name = tool_data.server_name
    tool_name = tool_data.tool_name
    params = tool_data.params

    if server_name not in SERVERS:
        raise HTTPException(status_code=404, detail=f"找不到服务器: {server_name}")

    server = SERVERS[server_name]
    if not server.is_connected():
        raise HTTPException(status_code=400, detail=f"服务器 '{server_name}' 未连接")

    try:
        result = await server.call_tool(tool_name, params)
        return result
    except Exception as e:
        logger.error(f"调用工具时出错: {str(e)}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tools")
async def get_tools():
    """获取所有可用工具的列表"""
    all_tools = []
    for server_name, server in SERVERS.items():
        if server.is_connected():
            for tool in server.tools:
                all_tools.append({
                    "server_name": server_name,
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.inputSchema
                })
    return all_tools

@app.post("/disconnect_server")
async def disconnect_server(request: ServerConnectRequest):
    """串行断开指定服务器，并等待连接资源释放。"""
    name = request.server_name
    async with _server_lock(name):
        server = SERVERS.get(name)
        if server is None:
            raise HTTPException(status_code=404, detail=f"找不到服务器: {name}")
        connected = server.is_connected()
        await server.cleanup()
        if not connected:
            return {"status": "not_connected", "server": name, "message": "服务器未连接"}
        return {"status": "disconnected", "server": name, "message": f"服务器 '{name}' 连接已断开"}


async def process_config_update(new_config: Dict[str, Any]):
    """按配置版本顺序更新注册表，同名连接变更互斥。"""
    global CONFIG
    if 'mcpServers' not in new_config:
        logger.error("无效配置: 未找到 'mcpServers' 部分")
        return False
    async with _config_lock:
        if _closing:
            return False
        CONFIG = new_config
        names = set(SERVERS) | set(new_config['mcpServers'])
        for name in names:
            async with _server_lock(name):
                config = new_config['mcpServers'].get(name)
                server = SERVERS.get(name)
                if server is not None and server.config == config:
                    continue
                if server is not None:
                    await server.cleanup()
                    SERVERS.pop(name, None)
                if config is not None:
                    SERVERS[name] = MCPServer(name, config)
        return True


async def connect_single_server(server_name: str) -> bool:
    """在同名锁内读取最新配置并建立连接。"""
    async with _server_lock(server_name):
        config = CONFIG.get('mcpServers', {}).get(server_name)
        if _closing or config is None:
            return False
        server = SERVERS.get(server_name)
        if server is not None and server.config != config:
            await server.cleanup()
            server = None
        if server is None:
            server = MCPServer(server_name, config)
            SERVERS[server_name] = server
        return await server.connect()


@app.post("/shutdown")
async def shutdown_client():
    """优雅关闭MCP客户端"""
    logger.info("收到关闭请求")

    # 创建后台任务执行实际关闭
    global _shutdown_task
    if _shutdown_task is None or _shutdown_task.done():
        _shutdown_task = asyncio.create_task(_perform_client_shutdown())

    return {"status": "shutdown_initiated", "message": "客户端关闭过程已启动"}


async def _perform_client_shutdown():
    """执行实际的客户端关闭"""
    logger.info("开始执行客户端关闭流程")

    try:
        await _cleanup_servers()

        # 2. 等待一段时间确保资源释放
        await asyncio.sleep(1)

        # 3. 停止FastAPI应用
        logger.info("即将关闭MCP客户端...")
        import signal
        import os
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception as e:
        logger.error(f"执行客户端关闭流程时出错: {str(e)}")

def run_client(host: str, port: int) -> None:
    """运行客户端"""
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="MCP Client for Agent-Graph")
    parser.add_argument("--host", default=settings.mcp_client_host, help="Host to bind")
    parser.add_argument(
        "--port",
        type=int,
        default=settings.mcp_client_port,
        help="Port to bind",
    )

    args = parser.parse_args()

    run_client(host=args.host, port=args.port)
