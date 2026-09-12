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

    assert config["name"] == "agent-graph"
    assert {volume["name"] for volume in config["volumes"].values()} == {
        "agent-graph_mongodb_data",
        "agent-graph_mongodb_config",
        "agent-graph_minio_data",
    }


def test_sdist_keeps_only_root_metadata_and_package(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for name in ("pyproject.toml", ".gitignore", "README.md", "LICENSE"):
        shutil.copy2(PROJECT_ROOT / name, source / name)

    expected_package = {}
    for path in (PROJECT_ROOT / "agent_graph").rglob("*"):
        if not path.is_file():
            continue
        name = path.relative_to(PROJECT_ROOT).as_posix()
        if path.suffix != ".py" and not name.startswith("agent_graph/dist/"):
            continue
        expected_package[name] = path.read_bytes()
        destination = source / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(expected_package[name])
    assert "agent_graph/main.py" in expected_package
    assert "agent_graph/dist/index.html" in expected_package
    assert any(name.startswith("agent_graph/dist/assets/") for name in expected_package)

    (source / "aaa-package-alias").symlink_to(source / "agent_graph", target_is_directory=True)

    # Keep unrelated files present, including ignored directories, during the real build.
    for name in (
        "frontend/node_modules/example/README.md",
        "frontend/node_modules/example/LICENSE",
        "frontend/node_modules/example/agent_graph/unrelated.py",
        "frontend/README.md",
        "docs/README.md",
        ".file/runtime/README.md",
        ".venv/LICENSE",
    ):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("Synthetic unrelated build input.\n")

    build_dir = tmp_path / "build"
    result = subprocess.run(
        ["uv", "build", "--sdist", "--out-dir", str(build_dir)],
        cwd=source,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    distribution = next(build_dir.glob("*.tar.gz"))
    with tarfile.open(distribution, "r:gz") as archive:
        members = archive.getmembers()
        assert len(members) == len({member.name for member in members})
        files = {
            member.name.split("/", 1)[1]: archive.extractfile(member).read()
            for member in members
            if member.isfile()
        }

    root_metadata = {"README.md", "LICENSE", "pyproject.toml", "PKG-INFO", ".gitignore"}
    unexpected = sorted(files.keys() - expected_package.keys() - root_metadata)
    assert not unexpected, unexpected
    assert {name: files[name] for name in expected_package} == expected_package
    assert {"pyproject.toml", "PKG-INFO"} <= files.keys()
    assert files["README.md"] == (PROJECT_ROOT / "README.md").read_bytes()
    assert files["LICENSE"] == (PROJECT_ROOT / "LICENSE").read_bytes()


@pytest.mark.parametrize("from_sdist", [False, True], ids=["direct-wheel", "sdist-to-wheel"])
def test_distributions_include_frontend_and_wheel_imports(
    tmp_path: Path,
    from_sdist: bool,
) -> None:
    build_dir = tmp_path / "build"
    command = ["uv", "build", "--out-dir", str(build_dir)]
    if not from_sdist:
        command.append("--wheel")
    result = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    wheel = next(build_dir.glob("*.whl"))
    expected_frontend = {
        path.relative_to(PROJECT_ROOT).as_posix(): path.read_bytes()
        for path in (PROJECT_ROOT / "agent_graph/dist").rglob("*")
        if path.is_file()
    }
    assert "agent_graph/dist/index.html" in expected_frontend
    assert any(path.startswith("agent_graph/dist/assets/") for path in expected_frontend)

    with zipfile.ZipFile(wheel) as archive:
        wheel_files = archive.namelist()
        assert len(wheel_files) == len(set(wheel_files)), "Duplicate wheel members"
        wheel_frontend = {
            name: archive.read(name)
            for name in wheel_files
            if name.startswith("agent_graph/dist/") and not name.endswith("/")
        }
        assert wheel_frontend == expected_frontend
        extracted_wheel = tmp_path / "wheel"
        archive.extractall(extracted_wheel)

    if from_sdist:
        source_distribution = next(build_dir.glob("*.tar.gz"))
        with tarfile.open(source_distribution, mode="r:gz") as archive:
            source_files = archive.getnames()
            assert len(source_files) == len(set(source_files)), "Duplicate sdist members"
            source_frontend = {
                member.name.split("/", 1)[1]: archive.extractfile(member).read()
                for member in archive.getmembers()
                if member.isfile() and "/agent_graph/dist/" in member.name
            }
            assert source_frontend == expected_frontend

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
