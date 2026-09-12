import importlib.util
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def runner(monkeypatch):
    directory = Path(__file__).resolve().parents[1] / "e2e"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location("e2e_runner", directory / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cleanup_removes_owned_anonymous_volumes(runner, monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[1] == "inspect":
            output = "run-id\n"
        elif command[1:3] == ["volume", "ls"]:
            output = "unrelated-volume\n"
        else:
            output = ""
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(runner.subprocess, "run", run)
    rows = [{"name": "owned", "id": "container-id", "volumes": ["anonymous"]}]
    errors, containers, volumes = runner.cleanup_containers(rows, "run-id")
    assert (errors, containers, volumes) == ([], [], [])
    assert ["docker", "rm", "--force", "--volumes", "container-id"] in calls


def test_cleanup_does_not_remove_replaced_container(runner, monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "other-run\n" if command[1] == "inspect" else "", "")

    monkeypatch.setattr(runner.subprocess, "run", run)
    assert runner.cleanup_containers([{"name": "reused", "id": None, "volumes": []}], "run-id") == ([], [], [])
    assert not any(command[1] == "rm" for command in calls)


def test_cleanup_reports_remaining_resources(runner, monkeypatch):
    def run(command, **kwargs):
        if command[1] == "inspect":
            output = "run-id\n"
        elif command[1:3] == ["container", "ls"]:
            output = "owned\n"
        elif command[1:3] == ["volume", "ls"]:
            output = "anonymous\nunrelated\n"
        else:
            output = ""
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(runner.subprocess, "run", run)
    _, containers, volumes = runner.cleanup_containers([{"name": "owned", "id": "id", "volumes": ["anonymous"]}], "run-id")
    assert containers == ["owned"]
    assert volumes == ["anonymous"]


def test_cleanup_reports_unavailable_docker(runner, monkeypatch):
    def run(command, **kwargs):
        if kwargs.get("check"):
            raise subprocess.CalledProcessError(1, command, stderr="daemon unavailable")
        return subprocess.CompletedProcess(command, 1, "", "daemon unavailable")

    monkeypatch.setattr(runner.subprocess, "run", run)
    errors, _, _ = runner.cleanup_containers([{"name": "owned", "id": "id", "volumes": []}], "run-id")
    assert errors
