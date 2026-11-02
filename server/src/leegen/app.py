"""ASGI app: REST API + WebSocket + MCP (/mcp) + the built web UI."""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from leegen.api.routes import router
from leegen.config import settings
from leegen.mcp_server import build_mcp
from leegen.watcher import watch_forever


def create_app(*, watch: bool = True) -> FastAPI:
    mcp = build_mcp()
    mcp_app = mcp.streamable_http_app(streamable_http_path="/mcp")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        stop = asyncio.Event()
        task = asyncio.create_task(watch_forever(stop)) if watch else None
        async with mcp.session_manager.run():
            try:
                yield
            finally:
                stop.set()
                if task:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task

    app = FastAPI(title="leegen", lifespan=lifespan)
    app.include_router(router)
    app.router.routes.extend(mcp_app.routes)  # POST/GET/DELETE /mcp

    dist = settings().web_dist
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (dist / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
