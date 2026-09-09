import asyncio
import json
import os
from pathlib import Path
import time
import uuid

from agent_graph.main import app as production_app
from agent_graph.app.services.mcp.mcp_service import mcp_service


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        async def record_child():
            while True:
                manager = mcp_service.client_manager
                child = manager.client_process if manager else None
                if child:
                    try:
                        stat = Path(f"/proc/{child.pid}/stat").read_text()
                    except FileNotFoundError:
                        pass
                    else:
                        record = {"pid": child.pid, "start_time": stat.split(") ", 1)[1].split()[19]}
                        destination = Path(os.environ["E2E_ARTIFACT_DIR"]) / "mcp-process.json"
                        temporary = destination.with_suffix(".tmp")
                        temporary.write_text(json.dumps(record))
                        temporary.replace(destination)
                await asyncio.sleep(0.05)
        monitor = asyncio.create_task(record_child())
        try:
            return await production_app(scope, receive, send)
        finally:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
    if scope["type"] != "http" or scope.get("path") not in {"/api/agent/run", "/api/graphs/execute"}:
        return await production_app(scope, receive, send)
    directory = Path(os.environ["E2E_ARTIFACT_DIR"]) / "wire"
    directory.mkdir(exist_ok=True)
    name = str(time.time_ns()) + "-" + uuid.uuid4().hex[:8]
    record = {"path": scope["path"], "chunks": 0, "bytes": 0, "finished": False}
    with (directory / (name + ".sse")).open("wb") as wire:
        async def capture(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            elif message["type"] == "http.response.body":
                data = message.get("body", b"")
                wire.write(data)
                wire.flush()
                record["chunks"] += 1
                record["bytes"] += len(data)
                record["finished"] = not message.get("more_body", False)
            await send(message)
        try:
            await production_app(scope, receive, capture)
        finally:
            (directory / (name + ".json")).write_text(json.dumps(record, indent=2) + "\n")
