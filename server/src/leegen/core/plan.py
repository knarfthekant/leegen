"""Run planning: which tests run, what goes into run.json, which files make up the bundle.

The native orchestrator writes a plan to a temp dir; the browser runner writes the same plan
to Pyodide's in-memory filesystem. The harness package itself is added by each side.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from leegen.core.models import FROM_REFERENCE, Problem

Mode = Literal["user", "reference"]


@dataclass
class RunPlan:
    tests: list[dict[str, Any]]
    run_config: dict[str, Any]                 # run.json
    files: dict[str, str] = field(default_factory=dict)   # bundle-relative: user/..., ref/...
    needs_ref_dir: bool = False


def unique_test_name(wanted: str | None, taken: set[str]) -> str:
    """`wanted` if free; otherwise suffix it. Unnamed tests become `Test <n>` (n = next free)."""
    wanted = (wanted or "").strip()
    if wanted and wanted not in taken:
        return wanted
    base = wanted or "Test"
    n = 1
    while True:
        name = f"{base} {n}" if not wanted else f"{wanted} ({n + 1})"
        if name not in taken:
            return name
        n += 1


def test_payload(problem: Problem, custom_tests: list[dict[str, Any]] | None = None,
                 only_visible: bool = False) -> list[dict[str, Any]]:
    tests = []
    for t in problem.tests:
        if only_visible and not t.visible:
            continue
        tests.append({
            "name": t.name, "visible": t.visible, "custom": False, "section": t.section,
            "input": t.input.model_dump(mode="json") if t.input else None,
            "expected": None if t.needs_reference else t.expected,
            "needs_reference": t.needs_reference,
        })
    if problem.judge.kind == "function":
        taken = {t["name"] for t in tests}
        section_ids = {s.id for s in problem.sections}
        for ct in custom_tests or []:
            expected = ct.get("expected", FROM_REFERENCE)
            needs_ref = expected == FROM_REFERENCE
            name = unique_test_name(ct.get("name"), taken)
            taken.add(name)
            section = ct.get("section")
            tests.append({
                "name": name, "visible": True, "custom": True,
                "section": section if section in section_ids else None,
                "input": ct.get("input") or {}, "needs_reference": needs_ref,
                "expected": None if needs_ref else expected,
            })
    return tests


def materialize(problem: Problem, overrides: dict[str, str]) -> dict[str, str]:
    """All problem files, with the user's editable files swapped in."""
    files = {f.path: f.content for f in problem.files}
    files.update({k: v for k, v in overrides.items()
                  if (f := problem.file(k)) and f.role == "editable"})
    return files


def reference_files(problem: Problem) -> dict[str, str]:
    assert problem.reference
    return {rf.path: rf.content for rf in problem.reference.files}


def judge_config(problem: Problem, tests: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
    """(run.json entries for the judge kind, whether the reference dir is needed)."""
    judge = problem.judge.model_dump(mode="json")
    kind = problem.judge.kind
    if kind == "function":
        needs_ref = bool(problem.reference) and (
            any(t.get("needs_reference") for t in tests) or problem.benchmark is not None)
        return ({"judge": judge, "tests": tests,
                 "benchmark": problem.benchmark.model_dump() if problem.benchmark else None},
                needs_ref)
    if kind == "pytest":
        files = problem.pytest_files()
        visible = [p for p in files if (f := problem.file(p)) and f.role != "hidden"]
        return {"judge": judge, "test_files": files, "visible_files": visible}, False
    return {"judge": judge, "tests": tests}, False


def plan_run(problem: Problem, files: dict[str, str] | None = None, *, mode: Mode = "user",
             custom_tests: list[dict[str, Any]] | None = None, only_visible: bool = False,
             device: str = "cpu") -> RunPlan:
    if mode == "reference" and not problem.reference:
        raise ValueError("problem has no reference solution")
    tests = test_payload(problem, custom_tests, only_visible)
    config, needs_ref = judge_config(problem, tests)
    user = materialize(problem, files or {})
    if mode == "reference":
        user.update(reference_files(problem))
    bundle = {f"user/{k}": v for k, v in user.items()}
    if needs_ref:
        ref = {**materialize(problem, {}), **reference_files(problem)}
        bundle.update({f"ref/{k}": v for k, v in ref.items()})
    run_config = {**config, "mode": mode, "user_dir": "user",
                  "ref_dir": "ref" if needs_ref else None,
                  "timeout_s": problem.limits.timeout_s, "device": device}
    return RunPlan(tests=tests, run_config=run_config, files=bundle, needs_ref_dir=needs_ref)


SNIPPET_TIMEOUT_S = 30.0
MAX_SNIPPET_CODE = 200_000
MAX_SNIPPET_STDIN = 64_000


def plan_snippet(problem: Problem, files: dict[str, str] | None = None, *, file: str | None,
                 code: str, stdin: str = "", device: str = "cpu",
                 timeout_s: float = SNIPPET_TIMEOUT_S, prior: list[str] | None = None,
                 checks: list[dict[str, str]] | None = None) -> RunPlan:
    """A console run: the problem's files with the user's edits, plus one code snippet.

    `file` names the module the snippet runs inside (Jupyter-style); None means a bare namespace.
    There are no tests, so the run never goes through `assemble()`.

    Tutorial cells add `prior` (code of the cells before this one, replayed silently in the same
    namespace) and `checks` (`{description, code}`, run after `code` and reported as `check`
    events). Either one switches the harness to the notebook namespace instead of a file module.
    """
    if len(code) > MAX_SNIPPET_CODE:
        raise ValueError(f"snippet is too long (max {MAX_SNIPPET_CODE} characters)")
    if sum(len(c) for c in prior or []) > MAX_SNIPPET_CODE:
        raise ValueError(f"the earlier cells are too long (max {MAX_SNIPPET_CODE} characters)")
    if len(stdin) > MAX_SNIPPET_STDIN:
        raise ValueError(f"stdin is too long (max {MAX_SNIPPET_STDIN} characters)")
    user = materialize(problem, files or {})
    if file is not None and file not in user:
        raise ValueError(f"unknown file {file!r}")
    run_config = {
        "mode": "snippet",
        "snippet": {"file": file, "code": code, "stdin": stdin,
                    **({"prior": prior} if prior is not None else {}),
                    **({"checks": checks} if checks else {})},
        "user_dir": "user",
        "ref_dir": None,
        "timeout_s": timeout_s,
        "device": device,
    }
    return RunPlan(tests=[], run_config=run_config,
                   files={f"user/{k}": v for k, v in user.items()})
