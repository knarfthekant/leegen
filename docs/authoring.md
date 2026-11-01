# Authoring leetclaude problems

A problem is one YAML file, `problems/<id>.yaml`, validated against
`schema/problem.schema.json`. It contains everything needed to show and grade the problem:
- the description
- the starter code
- hidden setup and tests
- a reference solution

The loop:

1. Draft the YAML.
2. `validate_problem_yaml` (MCP) or `uv run leetclaude validate --file draft.yaml`
   (CLI) checks the schema, runs the **reference** (it must pass every test) and runs the
   **starter** (it must fail at least one test).
3. Fix the issues, then `create_problem` (MCP), or save to `problems/` and run
   `leetclaude validate <id>`.

## 1. Top-level fields

```yaml
schema_version: 1
id: two-pointer-pairs          # lowercase slug = file name
title: Count Pairs Under a Budget
difficulty: easy               # intro | easy | medium | hard
tags: [arrays, two-pointers]
track: algorithms-basics       # optional curriculum id
order: 3                       # optional position inside the track
environment: python            # id of environments/<id>.yaml
requires: [cpu]                # cpu | gpu (cuda or mps) | cuda (NVIDIA only)
description: |                 # Markdown, see section 5
  ...
hints:                         # revealed one at a time, most general first
  - ...
files: [...]                   # section 2
reference: {files: [...]}      # section 2
judge: {...}                   # section 3
sections: [...]                # optional groups for tests, section 4
tests: [...]                   # section 4
limits: {timeout_s: 10}        # whole run; GPU problems usually need 30-60
benchmark: {...}               # optional, section 3.4
```

Environments right now:

| id | Use for | requires |
|---|---|---|
| `python` | Python 3.13 + pytest, CPU problems | `[cpu]` |
| `pytorch` | PyTorch (+ numpy) on CUDA or Apple MPS | `[gpu]` |
| `triton` | Triton kernels + PyTorch, Linux/NVIDIA | `[cuda]` |
| `cuda` | CUDA C++ with nvcc 13 (from PyPI wheels); `script` judge | `[cuda]` |
| `cpp` | C++17 with the system compiler; `script` judge | `[cpu]` |

`list_environments` returns the live list and the executors that can run each environment. If
no executor can run a problem, validation is skipped and the problem is saved unvalidated, so
prefer environments the user can run.

## 2. Files and the reference

```yaml
files:
  - path: solution.py      # what the user edits
    role: editable
    content: |
      def count_pairs(nums: list[int], budget: int) -> int:
          ...
  - path: helpers.py       # visible, locked context
    role: readonly
    content: ...
  - path: _gen.py          # never shown to the user
    role: hidden
    content: ...
reference:
  files:
    - path: solution.py    # replaces the editable file of the same path
      content: ...
```

Rules:
- Paths are relative. Subdirectories are fine (`app/service.py`; add an `app/__init__.py` file
  if you import it as a package).
- Starter code compiles and imports cleanly. Use `raise NotImplementedError` or `...` bodies, keep
  the exact signatures, docstrings and type hints, and leave `TODO` comments where the user
  should work.
- The starter must **not** pass the tests (validation enforces this).
- Every file is available to the code at run time. Hidden files are never sent to the browser,
  but a failing hidden test's message may show code from them.
- Name hidden helpers with a leading underscore (`_setup.py`, `_gen.py`).
- In GPU problems, get the device with `from leetclaude_harness import device` (returns `"cuda"`,
  `"mps"` or `"cpu"`) in hidden setup code. User-facing code should take the device from its
  inputs (`x.device`).

## 3. Judge kinds

### 3.1 `function`: call an entry point once per test

```yaml
judge:
  kind: function
  entry: solution.py:count_pairs     # file:function, or file:Class
  params: [nums, budget]             # labels for positional args in the UI
  compare: {kind: exact}             # see below
```

Each test's `input` gives the call arguments:

```yaml
tests:
  - name: Example 1
    input: {args: [[1, 2, 3, 4], 5]}          # count_pairs([1,2,3,4], 5)
    expected: 4
  - name: Keyword args
    description: Same call with `budget` passed by keyword.   # optional, Markdown
    section: basics                                           # optional, see section 4
    input: {args: [[1, 1]], kwargs: {budget: 2}}
    expected: 1
  - name: Large random
    visible: false
    input: {gen: _gen.py:make_case, seed: 7, kwargs: {n: 50000}}
    # expected omitted = expected: from_reference
```

- **Generators** (`gen`) are called as `fn(seed=..., **kwargs)` and return:
  - a **list or tuple**: positional args
  - a **dict**: keyword args

  Use them for big or random inputs and for anything that isn't JSON (tensors, numpy arrays,
  objects). Always derive randomness from `seed`: `random.Random(seed)`,
  `torch.Generator().manual_seed(seed)`.
- **`expected: from_reference`** (the default when omitted) means the expected value is computed
  by running the reference on the same inputs. Each phase gets a deep copy of the inputs, so
  mutation can't leak between them.
- **Return value handling:** coroutines are awaited. Generators and async generators are drained
  into a list, so `async def` / generator entry points work directly.
- **Class entry** (design-problem style). The class is built with `args`/`kwargs`, the calls run
  in order, and the compared value is the list of return values:

  ```yaml
  judge: {kind: function, entry: solution.py:LRUCache, compare: {kind: exact}}
  tests:
    - name: Evicts least recently used
      input:
        args: [2]                 # LRUCache(2)
        calls:
          - {method: put, args: [1, 10]}
          - {method: put, args: [2, 20]}
          - {method: get, args: [1]}
          - {method: put, args: [3, 30]}
          - {method: get, args: [2]}
      expected: [null, null, 10, null, -1]
  ```

**Comparators** (`judge.compare`):

| kind | Behaviour |
|---|---|
| `exact` | `==`; tuples and lists treated alike. Tensors and arrays must match exactly. |
| `float` | Recursive `math.isclose(rel_tol=rtol, abs_tol=atol)` over numbers in lists and dicts |
| `unordered` | Lists compared as multisets (order ignored); elements compared exactly |
| `allclose` | torch/numpy: shape must match, then `allclose(rtol, atol)`; reports the max abs diff. Falls back to `float` for plain values |
| `custom` | `fn: _check.py:check`, called as `check(actual, expected, inputs) -> bool \| (bool, message)` |

Use `custom` when many answers are valid (any valid topological order, any shortest path). The
checker gets `inputs = {"args", "kwargs", "calls"}`.

### 3.2 `pytest`: test files

```yaml
judge: {kind: pytest}            # optional: test_files: [test_visible.py, test_hidden.py]
files:
  - {path: solution.py,     role: editable, content: ...}
  - {path: test_visible.py, role: readonly, content: ...}   # the user can read these
  - {path: test_hidden.py,  role: hidden,   content: ...}
```

- Every `test_*.py` file runs, unless `judge.test_files` lists them explicitly.
- Tests in readonly files are marked visible; tests in hidden files are hidden.
- The **first docstring line** of a test becomes its description in the UI. Write it as a
  sentence ("breaking early still closes the connection").
- `async def test_...` works without plugins.
- Plain `assert` failures show as **fail**; other exceptions show as **error**.
- Use it for async code, stateful classes, error behaviour (`pytest.raises`), multi-file
  applications, and anything that needs fixtures or several assertions per scenario.
- The `tests:` list is not used. pytest discovers tests.
- Tests inside a class (`class TestRetries:`) are grouped under that class name in the UI. Plain
  functions stay ungrouped.

### 3.3 `script`: bring your own harness

```yaml
judge:
  kind: script
  build: [["nvcc", "-O2", "-o", "main", "main.cu", "kernel.cu"]]   # optional, run in order
  command: ["./main"]
```

- Commands run inside the user's files directory. `{python}` expands to the environment's
  interpreter.
- A failing build step shows as **Compile Error**, with its output.
- The harness writes result events (one JSON object per line) to the file named by the
  `LEETCLAUDE_RESULTS` environment variable:

  ```json
  {"type": "test", "name": "n=1024", "status": "pass", "visible": true, "expected": "...", "actual": "...", "message": null}
  {"type": "metric", "name": "kernel_ms", "value": 0.42, "unit": "ms", "reference": 0.40}
  ```

  `status` is one of `pass | fail | error | timeout | skipped`. Test events may also carry a
  `description` and a `section` (a free-form group name; the result panel groups by it).
- Validation runs the script with the reference files swapped in.

### 3.4 Benchmarks (`function` judge)

```yaml
benchmark: {against: reference, repeats: 20, max_slowdown: 3.0}
```

- Runs after all tests pass.
- Times the user's entry against the reference on the **last** test's inputs: warm-up, then the
  median of `repeats`, with device synchronisation for CUDA/MPS.
- Reports a `time_ms` metric. With `max_slowdown`, adds a `benchmark` test that fails if the user
  is more than that many times slower.
- Put the largest input last. Avoid benchmarks on interpreter-mode backends.

## 4. Test design

- **Visible tests (2–3)** repeat the examples in the description, so the user can reason about
  them before running anything.
- **Hidden tests** cover what a sloppy solution gets wrong:
  - empty and minimal input
  - boundaries (`<` vs `<=`)
  - duplicates
  - negative numbers
  - unsorted input
  - large inputs that need the intended complexity (set `limits.timeout_s` so a brute-force
    solution actually times out)
  - error paths
- Name tests by **what they check** ("Touching ranges merge"). The UI labels the pills
  `Test 1..N` by position and shows the name as the heading and in the tooltip, so the name is
  for you and the Review/result detail, not for the pill.
- Give a case a one-line `description` when the point of it isn't obvious from the input.
- **Sections** group related cases. Declare them once, then tag tests:

  ```yaml
  sections:
    - id: basics                       # slug that tests reference
      title: Basics
      description: The examples from the statement.   # optional, Markdown
    - {id: edge-cases, title: Edge cases}
  tests:
    - {name: Example, section: basics, input: {...}, expected: ...}
    - {name: Empty, section: edge-cases, input: {...}, expected: ...}
  ```

  Sections appear in the Testcase and Test Result panels in declaration order, each with its
  description. Tests without a `section` land in an "Other" group. Use sections once a problem
  has more than ~5 tests, or when cases fall into clear themes (basics, edge cases, scale).
  Unknown section ids and duplicate ids fail validation. Hidden tests may use sections too; a
  section of only hidden tests is shown in the result panel after a run.
- The user's own cases (Testcase panel `+`, or the `add_test_case` tool) are named `Test <n>`
  automatically. They can carry a `description` and a `section` too.
- Keep tests deterministic: seed everything and avoid wall-clock assertions.
- Floats: `float` or `allclose`. Typical tolerances:
  - CPU float64: `rtol 1e-9`
  - GPU float32: `rtol 1e-4, atol 1e-5`
  - float16/bfloat16: `rtol 1e-2`
- Learning-style problems: one concept per test, with docstrings that teach ("countdown lets
  other tasks run between items").
- Failed hidden tests show their input and output to the user. A passing hidden test shows only
  its name.

## 5. Description markup

Markdown (CommonMark + GFM tables and task lists), plus:

| Feature | Syntax |
|---|---|
| Math | `$O(n \log n)$`, display: `$$ ... $$` (KaTeX) |
| Diagrams | a fenced code block with language `mermaid` (flowchart, sequenceDiagram, classDiagram, stateDiagram, ...) |
| Figures | inline `<svg viewBox="..." ...>`. Use `stroke="currentColor"` / `fill="currentColor"` so it works in light and dark mode |
| Images | `![alt](assets/fig.png)` with the file at `problems/<id>/assets/fig.png` |
| Callouts | `:::note` / `:::tip` / `:::warning` ... `:::` |
| Collapsible | `:::details{summary="Why does this work?"}` ... `:::` |
| Figure + caption | `:::figure{caption="..."}` around an SVG, image or diagram |
| Code | fenced blocks with a language (`python`, `text`, `cpp`, ...) |

Raw HTML other than SVG is stripped, and so are scripts and event handlers. Keep SVGs small and
monochrome (`currentColor`, `opacity` for shading) to match the UI's style.

A good description has:
1. Context or motivation (one or two short paragraphs).
2. The exact task: signature, input/output format, edge-case rules.
3. At least one worked example in a `text` code block.
4. Constraints (sizes, value ranges, complexity target).
5. For learning problems: a short explanation of the concept with a minimal code sample, and
   optionally a `:::details` block with the deeper "why".

## 6. Problem archetypes

- **Learning (language features):** `pytest` judge, `intro`/`easy`. Explain the concept in the
  description, ask for 2–4 small functions, and test each property separately. Example:
  `py-async-generators`.
- **Algorithm (LeetCode-style):** `function` judge, literal expected values for small cases,
  `gen` + `from_reference` for large random cases, timeout tuned to reject brute force. Example:
  `merge-ranges`.
- **Application (half-built code):** several `readonly` files forming a working system, one
  `editable` file with the missing component, `test_visible.py` + `test_hidden.py`. Describe the
  architecture with a mermaid diagram. Example: `rate-limiter-service`.
- **ML fundamentals:** `pytorch` environment, `requires: [gpu]`, `function` judge with tensor
  generators and `allclose`. Put helpers in `readonly` files and keep the user's task focused.
  Example: `kv-cache-basics`.
- **Low-level GPU (CUDA):** `requires: [cuda]`, `script` judge, hidden `main.cu` harness that
  checks results against a CPU computation and prints result events with
  `#include <leetclaude/judge.h>` (`lc::test`, `lc::error`, `lc::metric`; compile with
  `-I{bundle}/_lc/include`). These only run on NVIDIA executors (local Linux box, SSH host,
  SLURM cluster). Examples: `cuda-vector-add` (script), `triton-vector-add` (function judge with
  Triton).

## 7. Checklist before `create_problem`

- [ ] `id` is a slug and equals the intended file name.
- [ ] The description states the signature, I/O format, constraints and a worked example.
- [ ] Related tests share a `section` (with a description) when there are more than ~5 tests.
- [ ] The starter code imports cleanly and keeps exact signatures.
- [ ] The reference is correct, and validation reports it passing every test.
- [ ] 2–3 visible tests plus hidden edge cases, all named by what they check.
- [ ] Randomness is seeded; tolerances are explicit for floats and tensors.
- [ ] Hints go from general to specific and don't give away the full solution.
- [ ] `requires` is the minimum hardware the problem needs.
