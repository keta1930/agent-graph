from importlib import import_module
from types import SimpleNamespace

import pytest


module = import_module(
    "agent_graph.app.infrastructure.storage.object_storage.minio_client"
)


class FakeMinio:
    def __init__(self, **connection_options):
        self.connection_options = connection_options
        self.created_buckets: list[str] = []
        self.versioning_updates: list[tuple[str, object]] = []

    def bucket_exists(self, _bucket_name: str) -> bool:
        return False

    def make_bucket(self, bucket_name: str) -> None:
        self.created_buckets.append(bucket_name)

    def get_bucket_versioning(self, _bucket_name: str) -> SimpleNamespace:
        return SimpleNamespace(status=None)

    def set_bucket_versioning(self, bucket_name: str, config: object) -> None:
        self.versioning_updates.append((bucket_name, config))


def test_constructor_has_no_network_side_effects():
    client = module.MinIOClient()

    with pytest.raises(RuntimeError, match="has not been initialized"):
        _ = client.client


def test_initialize_prepares_bucket_and_versioning(monkeypatch, test_settings):
    monkeypatch.setattr(module, "Minio", FakeMinio)
    client = module.MinIOClient()

    client.initialize(test_settings)

    assert client.bucket_name == "agent-graph"
    assert client.client.created_buckets == ["agent-graph"]
    assert len(client.client.versioning_updates) == 1
    assert client.client.connection_options == {
        "endpoint": "127.0.0.1:9000",
        "access_key": "testkey",
        "secret_key": "testsecret",
        "secure": False,
    }
