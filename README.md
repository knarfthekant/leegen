# leetclaude

A local, LeetCode-style programming trainer where **agents write the problems**. There is no
fixed problem bank. Problems are YAML files (description, starter code, hidden setup, tests and a
reference solution) that an agent creates through MCP. You solve them in a three-pane web UI and
run the tests on your CPU or GPU, or on a remote SSH/SLURM machine.

Your own AI assistant (Claude Code, Codex, ...) connects to the same MCP server to act as a
tutor. It can read your current code, run it, highlight lines with comments, and suggest edits
that you accept or reject in the editor.

## Quick start

```bash
cd server && uv sync
cd ../web && npm install && npm run build
cd ../server && uv run leetclaude serve          # open http://127.0.0.1:8000
claude mcp add --transport http leetclaude http://127.0.0.1:8000/mcp
```

Then ask your agent: *"Create a leetclaude problem that teaches Python context managers"*, or
open a problem and ask *"look at my code in leetclaude and give me a hint"*.

## What's in the box

- **Judges:** `function` (call an entry point and compare, including tensors with `allclose`),
  `pytest` (test files, async tests), `script` (any language; the harness prints JSON result
  lines).
- **Environments:** `python` (CPU) and `pytorch` (CUDA or Apple MPS). Each is a uv-managed venv
  created on first use.
- **Executors:** `local` (auto-detects cpu/mps/cuda), plus `ssh` and `slurm` for remote NVIDIA
  machines. See `docs/executors.md`.
- **Seed problems:** async generators (learning), merge ranges (algorithm), rate limiter
  (half-built app), KV cache (PyTorch on GPU).

Docs: [`AGENTS.md`](AGENTS.md) (agent manual: authoring, tutoring, architecture) ·
[`docs/authoring.md`](docs/authoring.md) (problem format) ·
[`schema/problem.schema.json`](schema/problem.schema.json).
