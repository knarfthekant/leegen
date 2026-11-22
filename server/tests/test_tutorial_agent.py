"""Tutorials through the agent tools: author, validate, open, run a cell, and tutor on a cell."""

from __future__ import annotations

import pytest

from leegen.state import AppState

YAML = """
schema_version: 1
id: agent-demo
title: Agent demo
summary: Two cells.
cells:
  - {type: markdown, text: Set x.}
  - type: code
    id: one
    starter: "x = 1"
    reference: "x = 2"
    checks:
      - {description: x is two, code: "assert x == 2"}
  - type: code
    id: two
    starter: "y = 0"
    reference: "y = x + 1"
    checks:
      - {description: y is three, code: "assert y == 3, 'y is wrong'"}
"""


@pytest.fixture
def app():
    state = AppState()
    events: list[dict] = []

    async def record(event: dict) -> None:
        events.append(event)

    state.hub.broadcast = record  # type: ignore[method-assign]
    state.events = events  # type: ignore[attr-defined]
    state.session.update(problem_id=None, buffers={}, active_file=None)
    yield state
    state.tutorials.delete("agent-demo")
    state.workspace.remove("tut-agent-demo")


async def test_authoring_validates_saves_and_deletes(app):
    tut = app.tutorial_service
    listing = tut.agent_list()
    assert {t["id"] for t in listing["tutorials"]} >= {"dict-first-steps"} and listing["invalid_files"] == []
    assert tut.agent_list(track="no-such-track")["tutorials"] == []
    assert "assert" not in repr(tut.agent_get("dict-first-steps", include_hidden=False))
    assert "assert" in tut.agent_get("dict-first-steps")["yaml"]
    assert "tutorials/<id>.yaml" in tut.guide()

    _, bad = await tut.validate_yaml("id: x\ntitle: t\ncells: []\n")
    assert bad["ok"] is False and bad["stage"] == "schema"
    # a starter that already passes is refused, and nothing is written
    cheating = YAML.replace('starter: "x = 1"', 'starter: "x = 2"')
    refused = await tut.create(cheating)
    assert refused["saved"] is False and "starter already passes" in refused["issues"][0]
    assert tut.tutorials.get("agent-demo") is None

    created = await tut.create(YAML)
    assert created["saved"] and created["validated"] and created["ok"]
    assert {"type": "tutorials_changed"} in app.events
    assert tut.tutorials.read_yaml("agent-demo").strip() == YAML.strip()   # saved as written
    again = await tut.create(YAML)
    assert again["saved"] is False and "overwrite=true" in again["errors"]
    assert (await tut.update("agent-demo", YAML.replace("Two cells.", "Edited.")))["saved"]
    assert (await tut.update("agent-demo", YAML.replace("id: agent-demo", "id: other")))["saved"] is False
    assert (await tut.update("missing", YAML))["saved"] is False

    assert await tut.navigate("agent-demo") == {"opened": "agent-demo"}
    assert {"type": "navigate_tutorial", "tutorial_id": "agent-demo"} in app.events
    with pytest.raises(LookupError):
        await tut.navigate("missing")

    assert (await tut.delete("agent-demo", delete_user_code=True)) == {"deleted": True}
    assert tut.tutorials.get("agent-demo") is None


async def test_run_cell_uses_the_learners_unsaved_code_and_session_describes_it(app):
    tut, svc = app.tutorial_service, app.service
    await tut.create(YAML)
    with pytest.raises(ValueError, match="no tutorial_id"):
        await tut.run_for_agent()

    app.session.update(problem_id="tut-agent-demo", active_file="cells/one.py",
                       buffers={"cells/one.py": "x = 2", "cells/two.py": "y = x + 1"},
                       cursor={"line": 1, "column": 3},
                       selection={"start_line": 1, "end_line": 1, "text": "x"})
    ran = await tut.run_for_agent()        # the open tutorial, its active cell
    assert (ran["cell"], ran["status"], ran["passed"]) == ("one", "ok", True)
    # unsaved buffers were used but not written to disk
    assert tut.workspace.files(tut.shim_for("tut-agent-demo"))["cells/one.py"] == "x = 1"
    done = [e for e in app.events if e["type"] == "tutorial_cell_finished"]
    assert done[-1]["cell"] == "one" and done[-1]["source"] == "mcp"

    second = await tut.run_for_agent(cell="two")           # replays the learner's cell one
    assert second["passed"] is True
    with pytest.raises(LookupError, match="no cell 'nope'"):
        await tut.run_for_agent(cell="nope")

    view = svc.get_session()
    assert view["kind"] == "tutorial" and view["tutorial_id"] == "agent-demo"
    assert view["problem_id"] == "tut-agent-demo" and view["active_cell"] == "one"
    code = {c["id"]: c for c in view["cells"] if c["type"] == "code"}
    assert code["one"]["code"] == "x = 2" and code["one"]["modified"] is True
    assert code["two"]["modified"] is True
    assert code["one"]["outcome"] == {"status": "ok", "passed": True, "checks": [
        {"description": "x is two", "status": "pass", "message": ""}]}
    assert "assert" not in repr(view)                      # hidden checks stay out of the session
    assert view["selection"]["text"] == "x" and view["pending_proposals"] == []


async def test_review_comments_and_edits_reach_a_cell(app):
    tut, svc = app.tutorial_service, app.service
    await tut.create(YAML)
    app.session.update(problem_id="tut-agent-demo", active_file="cells/two.py",
                       buffers={"cells/two.py": "y = x + 2"})

    # no problem_id: the open tutorial is the target
    made = await svc.annotate([{"file": "cells/two.py", "start_line": 1, "start_col": 5,
                                "end_col": 10, "severity": "hint", "message": "off by one"}])
    assert made[0]["file"] == "cells/two.py"
    note = [e for e in app.events if e["type"] == "annotations_changed"][-1]
    assert note["problem_id"] == "tut-agent-demo" and len(note["annotations"]) == 1
    with pytest.raises(ValueError):                         # the file must exist in the tutorial
        await svc.annotate([{"file": "cells/nope.py", "start_line": 1, "message": "m"}])

    proposal = await svc.propose_edit("cells/two.py", rationale="fix", edits=[
        {"old": "x + 2", "new": "x + 1"}], problem_id="tut-agent-demo")
    assert proposal["content"] == "y = x + 1"
    assert svc.get_session()["pending_proposals"][0]["id"] == proposal["id"]
    written = await svc.resolve_proposal("tut-agent-demo", proposal["id"], "accept")
    assert written == {"cells/two.py": "y = x + 1"}
    assert tut.workspace.files(tut.shim_for("tut-agent-demo"))["cells/two.py"] == "y = x + 1"
    assert any(e["type"] == "files_changed" and e["problem_id"] == "tut-agent-demo"
               for e in app.events)

    assert await svc.clear_annotations() == 1
    with pytest.raises(LookupError, match="no tutorial"):
        await svc.annotate([{"message": "m"}], problem_id="tut-missing")
    # tests are for real problems only
    with pytest.raises(LookupError):
        svc.problem("tut-agent-demo")


def test_get_session_for_a_problem_says_so(app):
    app.session.update(problem_id="merge-ranges")
    assert app.service.get_session()["kind"] == "problem"


async def test_rest_routes_serve_a_tutorials_comments_and_edits(app):
    """What the server edition's page calls: open (with review state), session, resolve, dismiss."""
    from fastapi.testclient import TestClient

    from leegen.app import create_app
    from leegen.state import app_state

    shared = app_state()           # the routes use the process-wide state
    await shared.tutorial_service.create(YAML)
    try:
        client = TestClient(create_app(watch=False))
        assert client.post("/api/session", json={
            "problem_id": "tut-agent-demo", "buffers": {"cells/two.py": "y = x + 2"},
            "active_file": "cells/two.py"}).status_code == 200
        svc = shared.service
        await svc.annotate([{"file": "cells/two.py", "start_line": 1, "message": "hm"}])
        proposal = await svc.propose_edit("cells/two.py", rationale="r",
                                          edits=[{"old": "x + 2", "new": "x + 1"}])
        opened = client.get("/api/tutorials/agent-demo").json()
        assert len(opened["annotations"]) == 1 and opened["proposals"][0]["id"] == proposal["id"]
        assert "assert" not in repr(opened)

        done = client.post(f"/api/workspace/tut-agent-demo/proposals/{proposal['id']}/accept")
        assert done.status_code == 200 and done.json()["files"] == {"cells/two.py": "y = x + 1"}
        aid = opened["annotations"][0]["id"]
        assert client.delete(f"/api/workspace/tut-agent-demo/annotations/{aid}").json() == {"removed": True}
        assert client.delete("/api/workspace/tut-nope/annotations/x").status_code == 404
        assert client.get("/api/session").json()["kind"] == "tutorial"
    finally:
        await shared.tutorial_service.delete("agent-demo", delete_user_code=True)
        shared.session.update(problem_id=None, buffers={}, active_file=None)
