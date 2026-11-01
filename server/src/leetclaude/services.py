"""Operations shared by the REST API, MCP tools and CLI."""

from __future__ import annotations

import asyncio
import uuid

from leetclaude.runner import RunRequest
from leetclaude.schema.models import Problem, RunResult
from leetclaude.state import app_state


async def run_for_user(problem: Problem, *, files: dict[str, str] | None = None,
                       executor: str | None = None, run_id: str | None = None,
                       source: str = "ui") -> RunResult:
    """Run the user's code (given buffers, else the saved workspace) and record last_run."""
    st = app_state()
    ws = st.workspace
    if files:
        ws.save_files(problem, files)
    current = ws.files(problem)
    run_id = run_id or uuid.uuid4().hex[:12]
    lock = st.run_lock.setdefault(problem.id, asyncio.Lock())
    async with lock:
        await st.hub.broadcast({"type": "run_started", "problem_id": problem.id,
                                "run_id": run_id, "source": source})
        async def on_status(phase: str, detail: str) -> None:
            await st.hub.broadcast({"type": "run_status", "problem_id": problem.id,
                                    "run_id": run_id, "phase": phase, "detail": detail})

        result = await st.orchestrator.run(
            RunRequest(problem=problem, files=current, executor=executor or st.session.executor,
                       custom_tests=ws.read_state(problem.id, "custom_tests", [])),
            run_id=run_id, on_status=on_status,
        )
        ws.write_state(problem.id, "last_run", result.model_dump(mode="json"))
        await st.hub.broadcast({"type": "run_finished", "problem_id": problem.id,
                                "run_id": run_id, "source": source,
                                "result": result.model_dump(mode="json")})
    return result
