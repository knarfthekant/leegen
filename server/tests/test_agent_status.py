"""Agent activity reaches live tabs and reconnecting tabs, without an open problem."""

from mcp import Client
from fastapi.testclient import TestClient

from leegen.app import create_app
from leegen.mcp_server import build_mcp
from leegen.state import app_state


async def test_mcp_agent_status(monkeypatch):
    st = app_state()
    monkeypatch.setattr(st.session, "problem_id", None)
    monkeypatch.setattr("leegen.service.time.time", lambda: 1000.0)
    events = []

    async def broadcast(event):
        events.append(event)

    monkeypatch.setattr(st.hub, "broadcast", broadcast)
    async with Client(build_mcp()) as client:
        for activity in ("reviewing", "creating_problem", "idle"):
            result = await client.call_tool("set_agent_status", {"status": activity})
            assert not result.is_error
            expected = {"status": activity, "updated_at": 1000.0,
                        "expires_at": None if activity == "idle" else 1300.0}
            assert result.structured_content == expected
            assert events[-1] == {"type": "agent_status_changed", "agent_status": expected}
            assert st.service.get_agent_status() == expected

        for args in ({}, {"status": "thinking"}):
            result = await client.call_tool("set_agent_status", args)
            assert result.is_error
        assert len(events) == 3


def test_rest_websocket_snapshot_broadcast_and_expiry(monkeypatch):
    now = 1000.0
    monkeypatch.setattr("leegen.service.time.time", lambda: now)
    client = TestClient(create_app(watch=False))
    client.post("/api/agent-status", json={"status": "idle"})
    assert client.post("/api/agent-status", json={"status": "thinking"}).status_code == 422
    with client.websocket_connect("/api/ws") as first:
        assert first.receive_json()["agent_status"]["status"] == "idle"
        result = client.post("/api/agent-status", json={"status": "creating_problem"})
        assert result.status_code == 200
        expected = result.json()
        assert first.receive_json() == {"type": "agent_status_changed", "agent_status": expected}
        with client.websocket_connect("/api/ws") as reconnected:
            assert reconnected.receive_json()["agent_status"] == expected
        assert client.get("/api/agent-status").json() == expected
        now = 1300.0
        assert client.get("/api/agent-status").json()["status"] == "idle"
        with client.websocket_connect("/api/ws") as expired:
            assert expired.receive_json()["agent_status"]["status"] == "idle"
        renewed = client.post("/api/agent-status", json={"status": "reviewing"}).json()
        assert renewed["expires_at"] == 1600.0
        assert first.receive_json()["agent_status"] == renewed
        cleared = client.post("/api/agent-status", json={"status": "idle"}).json()
        assert first.receive_json()["agent_status"] == cleared
        assert cleared["expires_at"] is None
