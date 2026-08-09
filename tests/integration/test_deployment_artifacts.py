import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.integration


def test_compose_preserves_persistent_volume_names() -> None:
    if shutil.which("docker") is None:
        pytest.skip("Docker Compose is not available")

    environment = dict(os.environ)
    environment.pop("COMPOSE_PROJECT_NAME", None)
    environment.update(
        {
            "MONGO_ROOT_USERNAME": "admin",
            "MONGO_ROOT_PASSWORD": "test-password",
            "MONGO_DATABASE": "agent-graph",
            "MONGO_PORT": "20040",
            "MONGO_EXPRESS_PORT": "20041",
            "MONGO_EXPRESS_USERNAME": "admin",
            "MONGO_EXPRESS_PASSWORD": "test-password",
            "MINIO_ROOT_USER": "minioadmin",
            "MINIO_ROOT_PASSWORD": "test-password",
            "MINIO_API_PORT": "20042",
            "MINIO_CONSOLE_PORT": "20043",
        }
    )
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(PROJECT_ROOT / "docker/docker-compose.yml"),
            "config",
            "--format",
            "json",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    config = json.loads(result.stdout)

    assert config["name"] == "agent_graph_services"
    assert {volume["name"] for volume in config["volumes"].values()} == {
        "agent_graph_services_mongodb_data",
        "agent_graph_services_mongodb_config",
        "agent_graph_services_minio_data",
    }


def test_distributions_include_frontend_and_wheel_imports(
    tmp_path: Path,
) -> None:
    build_dir = tmp_path / "build"
    subprocess.run(
        ["uv", "build", "--out-dir", str(build_dir)],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    wheel = next(build_dir.glob("*.whl"))
    source_distribution = next(build_dir.glob("*.tar.gz"))

    with zipfile.ZipFile(wheel) as archive:
        wheel_files = set(archive.namelist())
        extracted_wheel = tmp_path / "wheel"
        archive.extractall(extracted_wheel)

    with tarfile.open(source_distribution, mode="r:gz") as archive:
        source_files = set(archive.getnames())

    assert "agent_graph/dist/index.html" in wheel_files
    assert any(
        path.endswith("/agent_graph/dist/index.html") for path in source_files
    )
    assert any(
        path.startswith("agent_graph/dist/assets/") for path in wheel_files
    )
    assert any("/agent_graph/dist/assets/" in path for path in source_files)

    environment = os.environ | {
        "PYTHONPATH": str(extracted_wheel),
        "PORT": "20050",
        "PUBLIC_API_BASE_URL": "http://127.0.0.1:20050",
        "MCP_CLIENT_PORT": "20052",
        "MONGODB_URL": "mongodb://127.0.0.1/test",
        "JWT_SECRET_KEY": "test_secret_key_aaaaaaaaaaaaaaaa",
        "ADMIN_USERNAME": "test-admin",
        "ADMIN_PASSWORD": "test-password-123",
        "MINIO_ENDPOINT": "127.0.0.1:9000",
        "MINIO_ACCESS_KEY": "testkey",
        "MINIO_SECRET_KEY": "testsecret",
        "EXPECTED_PACKAGE_ROOT": str(extracted_wheel / "agent_graph"),
    }
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import os
from pathlib import Path

from fastapi.testclient import TestClient

import agent_graph.main as main

package_root = Path(main.__file__).resolve().parent
assert package_root == Path(os.environ["EXPECTED_PACKAGE_ROOT"])
response = TestClient(main.app).get("/")
assert response.status_code == 200
assert response.headers["content-type"].startswith("text/html")
""",
        ],
        cwd=tmp_path,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
