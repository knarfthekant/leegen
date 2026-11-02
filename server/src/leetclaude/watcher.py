"""Watches problems/ and workspace/ and pushes changes to the UI.

- problems/*.yaml changed  -> "problems_changed" (+ "problem_changed" for that id)
- workspace/<id>/<file> changed by someone other than this server (an agent editing the file
  directly) -> turned into a proposal, so the user still accepts or rejects it.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from watchfiles import awatch

from leetclaude.state import app_state
from leetclaude.store.workspace import STATE_DIR

log = logging.getLogger("leetclaude.watcher")


async def _on_problem_change(paths: set[Path]) -> None:
    hub = app_state().hub
    await hub.broadcast({"type": "problems_changed"})
    for p in paths:
        if p.suffix == ".yaml":
            await hub.broadcast({"type": "problem_changed", "problem_id": p.stem})


async def _on_workspace_change(path: Path) -> None:
    st = app_state()
    try:
        rel = path.resolve().relative_to(st.workspace.root.resolve())
    except ValueError:
        return
    parts = rel.parts
    if len(parts) < 2 or STATE_DIR in parts:
        return
    problem = st.problems.get(parts[0])
    file = "/".join(parts[1:])
    if problem is None or not path.is_file():
        return
    f = problem.file(file)
    if f is None or f.role != "editable":
        return
    content = path.read_text()
    if content == st.workspace.last_written(problem.id, file):
        return  # our own write
    if content == st.service.current_files(problem).get(file):
        return
    try:
        await st.service.propose_edit(file, content=content, problem_id=problem.id,
                                      author="external edit", source="disk",
                                      rationale="the file was changed on disk")
    except ValueError:
        pass


async def watch_forever(stop: asyncio.Event) -> None:
    st = app_state()
    roots = [st.problems.dir, st.workspace.root]
    for r in roots:
        r.mkdir(parents=True, exist_ok=True)
    problems_root = st.problems.dir.resolve()
    async for changes in awatch(*roots, stop_event=stop, debounce=200, recursive=True):
        problem_paths: set[Path] = set()
        for _, raw in changes:
            path = Path(raw)
            if path.resolve().is_relative_to(problems_root):
                problem_paths.add(path)
            else:
                try:
                    await _on_workspace_change(path)
                except Exception:  # noqa: BLE001
                    log.exception("workspace change handling failed for %s", path)
        if problem_paths:
            await _on_problem_change(problem_paths)
