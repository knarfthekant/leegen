# Tutorials

Use a tutorial instead of a problem when the goal is to teach: a gentle introduction to a
concept, built up in small steps. (There is no `intro` difficulty for problems; introductions are
tutorials.) A tutorial is one notebook-like page: Markdown cells and runnable code cells, top to bottom.
Unlike a problem there is no side-by-side description and editor; the learner reads, edits a
cell and runs it. Each code cell carries hidden **checks** that run after the learner's code
and show up only then, as a row of ticks.

Write `data/tutorials/<id>.yaml` (the file name must equal `id`), then run
`cd server && uv run leegen tutorial validate <id>`. With the leegen tools (MCP, or WebMCP in the
browser edition) use `validate_tutorial_yaml` and `create_tutorial` instead; see
[Writing a tutorial with the agent tools](#writing-a-tutorial-with-the-agent-tools).

```yaml
schema_version: 1
id: dict-first-steps          # slug, equals the file name
title: Dictionaries, one step at a time
summary: Build, read and count with a dict.   # one line for the list page
tags: [python, dict]
environment: python           # any Python environment in environments/
order: 1                      # optional; with `track`, orders the list
cells:
  - type: markdown
    text: |                   # Markdown, math, mermaid, inline SVG, :::note blocks
      A **dict** maps keys to values.
  - type: code
    id: build                 # slug, unique in the tutorial
    starter: |                # what the learner sees first (a stub, a TODO, or a demo)
      ages = {}
    reference: |              # a correct cell; required when the cell has checks
      ages = {"ada": 36}
    stdin: ""                 # optional text for input()
    checks:                   # hidden until the cell has run
      - description: ada is 36            # one line, shown on failure
        code: assert ages["ada"] == 36    # raises nothing = pass; assert = fail
```

## How cells run

Cells share one namespace, like a notebook, but there is no live kernel. Running cell N replays
the learner's **current** code for cells 1..N-1 silently (output discarded), runs cell N with
its output captured (a trailing expression is echoed unless the code ends with `;`), then runs
its checks. Cell N therefore sees everything earlier cells defined, and editing an earlier cell
marks the later results stale. If an earlier cell raises, the run stops and names that cell.

Each check runs on a copy of the namespace, so a check cannot disturb the next one. An
`AssertionError` is a **fail** (its message, if any, is shown); any other exception is an
**error**. Checks may spell out the expected answer, because the learner never receives them.

## Authoring rules

- Every cell with checks needs a `reference`. Validation replays the references in order: every
  check must pass on the reference, and the **starter must fail at least one check**, so a
  cell can't be passed by doing nothing.
- A cell without checks is a demo or scratch cell: it only runs.
- Quote YAML that holds `: ` (for example a dict literal) by using a `|` block for `code`.
- One idea per cell, and a Markdown cell before each code cell that sets the task. The UI shows
  no instructions of its own.
- Keep cells fast: the replay makes cell N cost the sum of cells 1..N.

## Writing a tutorial with the agent tools

Call `get_tutorial_guide` (this page), then work in a loop:

1. Look at what exists: `list_tutorials` (cell counts, how many cells the learner has passed) and
   `get_tutorial` (`include_hidden=true` returns the YAML with checks and references; `false`
   returns what the learner sees). Match the voice and size of the existing ones.
2. Write the whole YAML and call `validate_tutorial_yaml`. It checks the schema, then replays every
   reference (each check must pass) and every starter (a check must fail), exactly as
   `leegen tutorial validate` does. Fix every issue it lists; a reported issue always names the cell.
3. `create_tutorial` validates again and saves `tutorials/<id>.yaml` only when validation passes
   (pass `overwrite=true` to replace one; `update_tutorial` does that for an existing id). It saves
   unvalidated, and says so, only when no executor can run the environment. The learner's saved code
   survives an update, keyed by cell id, so keep ids stable when editing.
4. `open_tutorial` moves the learner to it. `delete_tutorial` removes it (and, with
   `delete_user_code=true`, their code and results).

Set `set_agent_status(creating_problem)` while authoring, `idle` when done. In the browser edition
the tutorial is validated by Pyodide in the runner and stored in the browser, so only
environments with a `browser:` block can be validated there.

## Helping a learner on a tutorial

`get_session` returns `"kind": "tutorial"` while a tutorial is open: every cell in order, with the
learner's current code, whether they changed it, and the outcome of their last run of each cell
(check descriptions, statuses and messages; never the check code). Cells share one namespace, so
look at *earlier* cells' outcomes before blaming the one that failed. Then:

- `run_tutorial_cell` runs a cell (default: the one they are on) on their current code, like the Run
  button. The ticks update in their page.
- `annotate`, `clear_annotations` and `propose_edit` take the session's `problem_id`
  (`tut-<tutorial id>`) and `file="cells/<cell id>.py"`. Comments appear under the cell and as
  highlights in it; an edit is a diff the learner accepts or rejects.
- Give hints in small steps. `get_tutorial` with `include_hidden=true` shows the checks and the
  reference so you can understand a cell, but do not paste them to the learner.

## Storage and API

The learner's code is one file per cell, `data/workspace/tut-<id>/cells/<cell-id>.py`, and the latest
check outcomes are in `data/workspace/tut-<id>/.leegen/cell_results.json`. REST (server edition):
`GET /api/tutorials`, `GET /api/tutorials/{id}`, `PUT .../files`, `POST .../reset`,
`POST .../cells/{cell}/run`. The checks and references are not sent to the page; they reach only
an agent that asks `get_tutorial` for the hidden view.

The browser edition runs the same tutorials from IndexedDB, bundled at build time and importable
in a zip (see [browser.md](browser.md#tutorials)). Its API is the same, so a tutorial that
validates on the server runs unchanged there; tutorials need a Python environment with a
`browser:` block.
