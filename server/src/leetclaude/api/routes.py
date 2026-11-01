"""REST + WebSocket API used by the web UI."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from leetclaude.envs.registry import satisfies
from leetclaude.schema.models import Problem
from leetclaude.schema.views import problem_summary, public_problem
from leetclaude.services import run_for_user
from leetclaude.state import app_state

router = APIRouter(prefix="/api")


def _problem(problem_id: str) -> Problem:
    p = app_state().problems.get(problem_id)
    if p is None:
        raise HTTPException(404, f"no problem {problem_id!r}")
    return p


@router.get("/problems")
def list_problems() -> dict[str, Any]:
    st = app_state()
    items = []
    for p in st.problems.list():
        last = st.workspace.read_state(p.id, "last_run", None)
        status = None
        if last:
            status = "passed" if last.get("status") == "passed" else "attempted"
        items.append({**problem_summary(p), "status": status})
    items.sort(key=lambda x: (x["track"] or "~", x["order"] or 0, x["title"].lower()))
    errors = [{"path": e.path, "error": e.error} for e in st.problems.errors()]
    return {"problems": items, "errors": errors}


@router.get("/problems/{problem_id}")
def get_problem(problem_id: str) -> dict[str, Any]:
    return public_problem(_problem(problem_id))


@router.get("/problems/{problem_id}/assets/{asset_path:path}")
def get_asset(problem_id: str, asset_path: str) -> FileResponse:
    base = (app_state().problems.dir / problem_id / "assets").resolve()
    target = (base / asset_path).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise HTTPException(404, "asset not found")
    return FileResponse(target)


@router.get("/workspace/{problem_id}")
def get_workspace(problem_id: str) -> dict[str, Any]:
    p = _problem(problem_id)
    ws = app_state().workspace
    return {
        "files": ws.files(p),
        "custom_tests": ws.read_state(p.id, "custom_tests", []),
        "last_run": ws.read_state(p.id, "last_run", None),
        "annotations": ws.read_state(p.id, "annotations", []),
        "proposals": ws.read_state(p.id, "proposals", []),
        "hints_revealed": ws.read_state(p.id, "hints", {"revealed": 0})["revealed"],
    }


class FilesBody(BaseModel):
    files: dict[str, str]


@router.put("/workspace/{problem_id}/files")
def save_files(problem_id: str, body: FilesBody) -> dict[str, Any]:
    p = _problem(problem_id)
    try:
        written = app_state().workspace.save_files(p, body.files)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"written": sorted(written)}


@router.post("/workspace/{problem_id}/reset")
def reset_workspace(problem_id: str) -> dict[str, Any]:
    p = _problem(problem_id)
    return {"files": app_state().workspace.reset(p)}


class CustomTestsBody(BaseModel):
    tests: list[dict[str, Any]]


@router.put("/workspace/{problem_id}/custom_tests")
def save_custom_tests(problem_id: str, body: CustomTestsBody) -> dict[str, Any]:
    p = _problem(problem_id)
    app_state().workspace.write_state(p.id, "custom_tests", body.tests)
    return {"tests": body.tests}


class HintsBody(BaseModel):
    revealed: int


@router.put("/workspace/{problem_id}/hints")
def save_hints(problem_id: str, body: HintsBody) -> dict[str, Any]:
    p = _problem(problem_id)
    revealed = max(0, min(body.revealed, len(p.hints)))
    app_state().workspace.write_state(p.id, "hints", {"revealed": revealed})
    return {"revealed": revealed}


class RunBody(BaseModel):
    problem_id: str
    files: dict[str, str] | None = None
    executor: str | None = None
    run_id: str | None = None


@router.post("/run")
async def run(body: RunBody) -> dict[str, Any]:
    p = _problem(body.problem_id)
    result = await run_for_user(p, files=body.files, executor=body.executor, run_id=body.run_id,
                                source="ui")
    return result.model_dump(mode="json")


@router.post("/run/{run_id}/cancel")
async def cancel(run_id: str) -> dict[str, Any]:
    return {"cancelled": await app_state().orchestrator.cancel(run_id)}


@router.get("/executors")
def executors(problem_id: str | None = None) -> dict[str, Any]:
    st = app_state()
    requires: list[str] = []
    if problem_id:
        p = _problem(problem_id)
        env = st.environments.get(p.environment)
        requires = sorted({*p.requires, *(env.requires if env else [])})
    out = []
    for ex in st.executors.all().values():
        out.append({**ex.describe(), "compatible": satisfies(ex.capabilities(), requires),
                    "device": ex.device_for(requires)})
    return {"executors": out, "requires": requires}


@router.get("/environments")
def environments() -> dict[str, Any]:
    return {"environments": [e.model_dump() for e in app_state().environments.all().values()]}


class SessionBody(BaseModel):
    problem_id: str | None = None
    buffers: dict[str, str] | None = None
    active_file: str | None = None
    cursor: dict[str, int] | None = None
    selection: dict[str, Any] | None = None
    executor: str | None = None


@router.post("/session")
def report_session(body: SessionBody) -> dict[str, Any]:
    st = app_state()
    st.session.update(**body.model_dump(exclude_unset=True))
    return {"ok": True}


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    hub = app_state().hub
    await ws.accept()
    hub.clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # clients only listen; keep the socket open
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)




# ------------------------------------------------------------------ review (annotations/proposals)


@router.post("/workspace/{problem_id}/proposals/{proposal_id}/{action}")
async def resolve_proposal(problem_id: str, proposal_id: str, action: str) -> dict[str, Any]:
    from leetclaude import tutor

    if action not in ("accept", "reject"):
        raise HTTPException(400, "action must be accept or reject")
    p = _problem(problem_id)
    try:
        files = await tutor.resolve_proposal(p, proposal_id, action)  # type: ignore[arg-type]
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"files": files}


@router.delete("/workspace/{problem_id}/annotations/{annotation_id}")
async def delete_annotation(problem_id: str, annotation_id: str) -> dict[str, Any]:
    from leetclaude import tutor

    _problem(problem_id)
    return {"removed": await tutor.remove_annotation(problem_id, annotation_id)}
