# Tutorials

A tutorial is one notebook-like page: Markdown cells and runnable code cells, top to bottom.
Unlike a problem there is no side-by-side description and editor; the learner reads, edits a
cell and runs it. Each code cell carries hidden **checks** that run after the learner's code
and show up only then, as a row of ticks.

Write `tutorials/<id>.yaml` (the file name must equal `id`), then run
`cd server && uv run leegen tutorial validate <id>`.

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

## Storage and API

The learner's code is one file per cell, `workspace/tut-<id>/cells/<cell-id>.py`, and the latest
check outcomes are in `workspace/tut-<id>/.leegen/cell_results.json`. REST (server edition):
`GET /api/tutorials`, `GET /api/tutorials/{id}`, `PUT .../files`, `POST .../reset`,
`POST .../cells/{cell}/run`. The checks and references never leave the server.

The browser edition does not run tutorials yet.
