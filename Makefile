# Run from the repo root. Ports: LEEGEN_PORT (default 13370), LEEGEN_WEB_PORT (13371).
.PHONY: start dev stop restart build check test smoke browser browser-serve browser-smoke

## UI + API + MCP on one port; installs deps and rebuilds the UI when needed
start:
	cd server && uv sync -q && uv run leegen start

## backend --reload + Vite hot reload; Ctrl-C stops both
dev:
	cd server && uv sync -q && uv run leegen dev

## stop the server started by `make start` / `make dev` (from any terminal)
stop:
	cd server && uv run leegen stop

restart: stop start

build:
	cd web && npm install --no-fund --no-audit && npm run build

test:
	cd server && uv run pytest

check: test
	cd server && uv run leegen validate --all
	cd web && npm test && npm run typecheck && npm run build

## browser smoke test against a running server (make start)
smoke:
	cd web && node tests/smoke.mjs

## browser edition: build both static sites (app + runner) for local origins, then serve them
browser:
	cd server && uv run leegen browser build

browser-serve:
	cd server && uv run leegen browser serve

## browser smoke test against `make browser-serve`
browser-smoke:
	cd web && npm test && node tests/browser-smoke.mjs
