"""REST + WebSocket API used by the web UI. Thin adapter over `ToolService`."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from leetclaude.core.views import public_problem
from leetclaude.service import ToolService
from leetclaude.state import app_state

router = APIRouter(prefix="/api")
T = TypeVar("T")


def _svc() -> ToolService:
    return app_state().service


def _call(fn: Callable[[], T]) -> T:
    try:
        return fn()
    except LookupError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


async def _acall(coro: Any) -> Any:
    try:
        return await coro
    except LookupError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/problems")
def list_problems() -> dict[str, Any]:
    return _svc().problem_list_view()


@router.get("/problems/{problem_id}")
def get_problem(problem_id: str) -> dict[str, Any]:
    return _call(lambda: public_problem(_svc().problem(problem_id)))


@router.get("/problems/{problem_id}/assets/{asset_path:path}")
def get_asset(problem_id: str, asset_path: str) -> FileResponse:
    base = (app_state().problems.dir / problem_id / "assets").resolve()
    target = (base / asset_path).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise HTTPException(404, "asset not found")
    return FileResponse(target)


@router.get("/workspace/{problem_id}")
def get_workspace(problem_id: str) -> dict[str, Any]:
    return _call(lambda: _svc().workspace_view(problem_id))


class FilesBody(BaseModel):
    files: dict[str, str]


@router.put("/workspace/{problem_id}/files")
def save_files(problem_id: str, body: FilesBody) -> dict[str, Any]:
    return _call(lambda: _svc().save_files(problem_id, body.files))


@router.post("/workspace/{problem_id}/reset")
def reset_workspace(problem_id: str) -> dict[str, Any]:
    return _call(lambda: _svc().reset_workspace(problem_id))


class CustomTestsBody(BaseModel):
    tests: list[dict[str, Any]]


@router.put("/workspace/{problem_id}/custom_tests")
async def save_custom_tests(problem_id: str, body: CustomTestsBody) -> dict[str, Any]:
    # the UI already shows its own list; no echo event back to it
    return await _acall(_svc().set_custom_tests(problem_id, body.tests, broadcast=False))


class TestCaseBody(BaseModel):
    __test__ = False

    args: list[Any]
    kwargs: dict[str, Any] | None = None
    name: str | None = None
    description: str | None = None
    section: str | None = None


@router.post("/workspace/{problem_id}/custom_tests")
async def add_test_case(problem_id: str, body: TestCaseBody) -> dict[str, Any]:
    return await _acall(_svc().add_test_case(body.args, body.kwargs, body.name,
                                             body.description, body.section, problem_id))


class HintsBody(BaseModel):
    revealed: int


@router.put("/workspace/{problem_id}/hints")
def save_hints(problem_id: str, body: HintsBody) -> dict[str, Any]:
    return _call(lambda: _svc().set_hints(problem_id, body.revealed))


class RunBody(BaseModel):
    problem_id: str
    files: dict[str, str] | None = None
    executor: str | None = None
    run_id: str | None = None


@router.post("/run")
async def run(body: RunBody) -> dict[str, Any]:
    p = _call(lambda: _svc().problem(body.problem_id))
    result = await _acall(_svc().run(p, files=body.files, executor=body.executor,
                                     run_id=body.run_id, source="ui"))
    return result.model_dump(mode="json")


@router.post("/run/{run_id}/cancel")
async def cancel(run_id: str) -> dict[str, Any]:
    return await _svc().cancel(run_id)


@router.get("/executors")
def executors(problem_id: str | None = None) -> dict[str, Any]:
    return _call(lambda: _svc().executors_for(problem_id))


@router.get("/environments")
def environments() -> dict[str, Any]:
    return _svc().environment_list()


class SessionBody(BaseModel):
    problem_id: str | None = None
    buffers: dict[str, str] | None = None
    active_file: str | None = None
    cursor: dict[str, int] | None = None
    selection: dict[str, Any] | None = None
    executor: str | None = None


@router.post("/session")
def report_session(body: SessionBody) -> dict[str, Any]:
    return _svc().report_session(**body.model_dump(exclude_unset=True))


@router.get("/session")
def get_session() -> dict[str, Any]:
    """The same view the tutoring agent gets from the get_session tool."""
    return _svc().get_session()


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
    files = await _acall(_svc().resolve_proposal(problem_id, proposal_id, action))  # type: ignore[arg-type]
    return {"files": files}


@router.delete("/workspace/{problem_id}/annotations/{annotation_id}")
async def delete_annotation(problem_id: str, annotation_id: str) -> dict[str, Any]:
    _call(lambda: _svc().problem(problem_id))
    return {"removed": await _svc().remove_annotation(problem_id, annotation_id)}


@router.delete("/workspace/{problem_id}/annotations")
async def clear_annotations(problem_id: str, file: str | None = None) -> dict[str, Any]:
    return {"removed": await _acall(_svc().clear_annotations(problem_id, file))}
