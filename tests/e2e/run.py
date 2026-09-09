import argparse
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

from fixture_credentials import expired_access

ROOT = Path(__file__).resolve().parents[2]
PORTS = range(20053, 20059)


def listening(port):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def wait_ready(url, process=None):
    for _ in range(120):
        if process is not None and process.poll() is not None:
            raise RuntimeError("Owned service exited during startup; see private runtime logs")
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError(f"Owned service did not become healthy: {url}")


def main():
    parser = argparse.ArgumentParser(description="Run isolated real-backend browser acceptance")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--grep", help="Run a focused Playwright case; default runs the complete acceptance suite")
    args = parser.parse_args()
    for command in ["docker", "node", "npm"]:
        if shutil.which(command) is None:
            raise RuntimeError(f"Required command is missing: {command}")
    occupied = [port for port in PORTS if listening(port)]
    if occupied:
        raise RuntimeError(f"E2E ports already occupied; existing services were not touched: {occupied}")
    base = ROOT / ".file/e2e"
    base.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="real-", dir=base))
    output.mkdir(parents=True, exist_ok=True)
    artifacts = output / "artifacts"
    runtime = output / "runtime"
    artifacts.mkdir(exist_ok=False)
    runtime.mkdir(mode=0o700)
    run_id = secrets.token_hex(5)
    private = {"user": "e2e-user", "password": secrets.token_urlsafe(24), "jwt": secrets.token_urlsafe(48), "model_key": secrets.token_urlsafe(24), "minio_user": "e2e-storage", "minio_password": secrets.token_urlsafe(24)}
    private["expired_access"] = expired_access(private["user"], private["jwt"])
    temporary = runtime / "tmp"
    temporary.mkdir()
    private_path = runtime / "private.json"
    private_path.write_text(json.dumps(private))
    private_path.chmod(0o600)
    minio_env = runtime / "minio.env"
    minio_env.write_text("MINIO_ROOT_USER=" + private["minio_user"] + "\nMINIO_ROOT_PASSWORD=" + private["minio_password"] + "\n")
    minio_env.chmod(0o600)
    state = {"run_id": run_id, "ports": list(PORTS), "containers": [], "processes": [], "substitutions": ["deterministic model HTTP upstream"], "controlled_resources": ["test MCP arithmetic tool"], "user_ports_before": {str(port): listening(port) for port in [20050, 20051, 20052]}}
    children = []
    logs = []
    exit_code = 1
    creating_process = False
    pending_signal = None

    def save():
        (artifacts / "services.json").write_text(json.dumps(state, indent=2) + "\n")

    def container(kind, arguments, port):
        name = f"agent-graph-e2e-{run_id}-{kind}"
        row = {"name": name, "id": None, "port": port}
        state["containers"].append(row)
        save()
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            result = subprocess.run(["docker", "run", "--detach", "--rm", "--name", name, "--label", "agent-graph-e2e=" + run_id, *arguments], capture_output=True, text=True, timeout=180)
            if result.returncode:
                raise RuntimeError(f"Could not start isolated {kind}: {result.stderr}")
            row["id"] = result.stdout.strip()
            save()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "CI", "PLAYWRIGHT_BROWSERS_PATH", "E2E_CHROMIUM_EXECUTABLE", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG") if key in os.environ} | {
        "MINIO_SECURE": "false",
        "TMPDIR": str(temporary),
        "PYTHONPATH": str(ROOT / "tests/e2e") + os.pathsep + str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PORT": "20055",
        "PUBLIC_API_BASE_URL": "http://127.0.0.1:20055",
        "MCP_CLIENT_HOST": "127.0.0.1",
        "MCP_CLIENT_PORT": "20056",
        "MONGODB_URL": "mongodb://127.0.0.1:20053",
        "MONGODB_DB": "e2e_" + run_id,
        "JWT_SECRET_KEY": private["jwt"],
        "ADMIN_USERNAME": private["user"],
        "ADMIN_PASSWORD": private["password"],
        "MINIO_ENDPOINT": "127.0.0.1:20054",
        "MINIO_ACCESS_KEY": private["minio_user"],
        "MINIO_SECRET_KEY": private["minio_password"],
        "MINIO_BUCKET_NAME": "e2e-" + run_id,
        "AGENT_GRAPH_DIR": str(runtime / "agent-state"),
        "CORS_ORIGINS": "http://127.0.0.1:20058",
        "E2E_ARTIFACT_DIR": str(artifacts),
        "E2E_PRIVATE_CONFIG": str(private_path),
        "E2E_PYTHON": sys.executable,
        "E2E_BASE_URL": "http://127.0.0.1:20058"
    }

    def process(name, command, port, *, cwd=runtime, log_name=None):
        nonlocal creating_process, pending_signal
        log = (runtime / ((log_name or name) + ".log")).open("w")
        logs.append(log)
        # 延迟Python中断直到进程登记完成，不让子进程继承被屏蔽的SIGTERM。
        creating_process = True
        try:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(child)
            state["processes"].append({"name": name, "pid": child.pid, "port": port})
            save()
        finally:
            creating_process = False
            if pending_signal is not None:
                raise SystemExit(128 + pending_signal)
        return child

    def interrupted(signum, _frame):
        nonlocal pending_signal
        state["received_signal"] = signum
        if creating_process:
            pending_signal = signum
            return
        raise SystemExit(128 + signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)

    try:
        container("mongo", ["-p", "127.0.0.1:20053:27017", "mongodb/mongodb-community-server:8.2.1-ubuntu2204-20251113T064937Z"], 20053)
        container("minio", ["--env-file", str(minio_env), "-p", "127.0.0.1:20054:9000", "minio/minio:RELEASE.2025-04-22T22-12-26Z", "server", "/data"], 20054)
        wait_ready("http://127.0.0.1:20054/minio/health/live")
        for _ in range(80):
            if listening(20053):
                break
            time.sleep(0.25)
        upstream = process("model-upstream", [sys.executable, str(ROOT / "tests/e2e/model_upstream.py")], 20057)
        wait_ready("http://127.0.0.1:20057/", upstream)
        api = process("api", [sys.executable, "-m", "uvicorn", "recorded_api:app", "--host", "127.0.0.1", "--port", "20055", "--log-level", "warning"], 20055)
        wait_ready("http://127.0.0.1:20055/health", api)
        frontend = process("vite", ["node", str(ROOT / "frontend/node_modules/vite/bin/vite.js"), "--config", str(ROOT / "frontend/e2e/vite.config.ts")], 20058)
        wait_ready("http://127.0.0.1:20058/", frontend)
        browser_command = ["npm", "run", "test:e2e:browser"] + (["--", "--grep", args.grep] if args.grep else [])
        browser = process("playwright", browser_command, None, cwd=ROOT / "frontend", log_name="browser")
        exit_code = browser.wait()
        state["test_exit_code"] = exit_code
        if exit_code == 0 and not args.grep:
            subprocess.run([sys.executable, str(ROOT / "tests/e2e/verify.py")], cwd=runtime, env=env, check=True)
    finally:
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, signal.SIG_IGN)
        cleanup_errors = []
        for child in reversed(children):
            try:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
            except ProcessLookupError:
                pass
            except Exception as error:
                cleanup_errors.append(type(error).__name__ + ": process " + str(child.pid))
        # MCP 使用独立会话，按进程启动时间核验所有权后兜底清理。
        registry = artifacts / "mcp-process.json"
        try:
            owned = json.loads(registry.read_text()) if registry.exists() else None
            def still_owned():
                try:
                    stat = Path(f"/proc/{owned['pid']}/stat").read_text()
                    return stat.split(") ", 1)[1].split()[19] == owned["start_time"]
                except FileNotFoundError:
                    return False
            if owned and still_owned():
                os.killpg(owned["pid"], signal.SIGTERM)
                for _ in range(40):
                    if not still_owned():
                        break
                    time.sleep(0.1)
                if still_owned():
                    os.killpg(owned["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as error:
            cleanup_errors.append(type(error).__name__ + ": MCP registry/cleanup")
        for row in reversed(state["containers"]):
            try:
                inspected = subprocess.run(["docker", "inspect", "--format", '{{index .Config.Labels "agent-graph-e2e"}}', row["name"]], capture_output=True, text=True, timeout=15)
                if inspected.returncode == 0 and inspected.stdout.strip() == run_id:
                    removed = subprocess.run(["docker", "rm", "--force", row["name"]], capture_output=True, text=True, timeout=30)
                    if removed.returncode:
                        cleanup_errors.append("Docker cleanup failed: " + row["name"])
            except Exception as error:
                cleanup_errors.append(type(error).__name__ + ": " + row["name"])
        state["cleanup_errors"] = cleanup_errors
        for log in logs:
            log.close()
        extra_file = runtime / "extra-secrets.json"
        redact_complete = True
        try:
            extra_secrets = json.loads(extra_file.read_text()) if extra_file.exists() else []
        except (OSError, ValueError):
            extra_secrets = []
            redact_complete = False
            cleanup_errors.append("Extra secret registry unreadable; private logs withheld")
        def redact(content):
            for secret in [*private.values(), *extra_secrets]:
                content = content.replace(secret, "[REDACTED_TEST_SECRET]")
            content = re.sub(r"Bearer\s+[^\s\"'<>]+", "Bearer [REDACTED_TOKEN]", content, flags=re.IGNORECASE)
            return re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED_JWT]", content)
        for source in runtime.rglob("*.log"):
            content = redact(source.read_text(errors="replace")) if redact_complete else "Private log withheld: extra secret registry unreadable\n"
            (artifacts / (source.name + ".redacted")).write_text(content)
        for source in artifacts.rglob("*"):
            if source.is_file() and source.suffix in {".json", ".jsonl", ".md", ".txt", ".sse", ".redacted"}:
                source.write_text(redact(source.read_text(errors="replace")))
        if (artifacts / "browser.log.redacted").exists():
            print((artifacts / "browser.log.redacted").read_text())
        state["remaining_owned_ports"] = [port for port in PORTS if listening(port)]
        state["user_ports_after"] = {str(port): listening(port) for port in [20050, 20051, 20052]}
        state["cleanup_complete"] = not state["remaining_owned_ports"] and not cleanup_errors
        save()
        print(f"Real E2E evidence: {artifacts.relative_to(ROOT) if artifacts.is_relative_to(ROOT) else artifacts}")
        if not state["cleanup_complete"]:
            raise RuntimeError("Owned services remain after cleanup; see services.json")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
