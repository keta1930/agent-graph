from unittest.mock import AsyncMock, Mock

from fastapi.testclient import TestClient

import agent_graph.main as main


app = main.app


client = TestClient(app)


def test_health_response_is_typed():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "app_name": "Agent-Graph",
        "version": "3.0.0",
    }


def test_unknown_api_route_returns_json_404():
    response = client.get(
        "/api/route-that-does-not-exist",
        headers={"Accept": "application/json"},
    )

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"detail": "Not Found"}


def test_frontend_fallback_only_handles_html_navigation():
    api_response = client.get(
        "/dashboard",
        headers={"Accept": "application/json"},
    )
    browser_response = client.get(
        "/dashboard",
        headers={"Accept": "text/html"},
    )

    assert api_response.status_code == 404
    assert browser_response.status_code == 200
    assert browser_response.headers["content-type"].startswith("text/html")


def test_lifespan_initializes_external_resources(monkeypatch):
    ensure_directories = Mock()
    initialize_minio = Mock()
    initialize_mongodb = AsyncMock()
    initialize_system = AsyncMock()
    initialize_files = Mock()
    initialize_model = AsyncMock()
    initialize_graph = AsyncMock()
    initialize_mcp = AsyncMock()
    cleanup_mcp = AsyncMock()
    disconnect_mongodb = AsyncMock()

    monkeypatch.setattr(
        type(main.settings),
        "ensure_directories",
        lambda _settings: ensure_directories(),
    )
    monkeypatch.setattr(main.minio_client, "initialize", initialize_minio)
    monkeypatch.setattr(main.mongodb_client, "initialize", initialize_mongodb)
    monkeypatch.setattr(main, "initialize_system", initialize_system)
    monkeypatch.setattr(main.FileManager, "initialize", initialize_files)
    monkeypatch.setattr(main.model_service, "initialize", initialize_model)
    monkeypatch.setattr(main.graph_service, "initialize", initialize_graph)
    monkeypatch.setattr(main.mcp_service, "initialize", initialize_mcp)
    monkeypatch.setattr(main.mcp_service, "cleanup", cleanup_mcp)
    monkeypatch.setattr(main.mongodb_client, "disconnect", disconnect_mongodb)

    with TestClient(app) as lifespan_client:
        assert lifespan_client.get("/health").status_code == 200

    ensure_directories.assert_called_once_with()
    initialize_minio.assert_called_once_with(main.settings)
    initialize_mongodb.assert_awaited_once_with(
        main.settings.mongodb_url,
        main.settings.mongodb_db,
    )
    initialize_system.assert_awaited_once_with()
    initialize_files.assert_called_once_with()
    initialize_model.assert_awaited_once_with(main.mongodb_client)
    initialize_graph.assert_awaited_once_with()
    initialize_mcp.assert_awaited_once_with()
    cleanup_mcp.assert_awaited_once_with()
    disconnect_mongodb.assert_awaited_once_with()
