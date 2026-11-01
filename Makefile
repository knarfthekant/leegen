# Run from the repo root. Ports: LEETCLAUDE_PORT (default 13370), LEETCLAUDE_WEB_PORT (13371).
.PHONY: start dev stop restart build check test smoke

## UI + API + MCP on one port; installs deps and rebuilds the UI when needed
start:
	cd server && uv sync -q && uv run leetclaude start

## backend --reload + Vite hot reload; Ctrl-C stops both
dev:
	cd server && uv sync -q && uv run leetclaude dev

## stop the server started by `make start` / `make dev` (from any terminal)
stop:
	cd server && uv run leetclaude stop

restart: stop start

build:
	cd web && npm install --no-fund --no-audit && npm run build

test:
	cd server && uv run pytest

check: test
	cd server && uv run leetclaude validate --all
	cd web && npm run typecheck && npm run build

## browser smoke test against a running server (make start)
smoke:
	cd web && node tests/smoke.mjs
