"""Operational status follows the MCP service's application lifecycle."""

from fastapi.testclient import TestClient

from leegen.app import create_app


def test_service_status_tracks_mcp_lifecycle():
    app = create_app(watch=False)
    with TestClient(app) as client:
        assert client.get("/api/status").json() == {"server": True, "mcp": True}
        app.state.mcp_online = False
        assert client.get("/api/status").json() == {"server": True, "mcp": False}
        app.state.mcp_online = True
    assert app.state.mcp_online is False
