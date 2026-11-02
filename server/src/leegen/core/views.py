"""What the browser (and the tutoring agent) may see of problems and runs."""

from __future__ import annotations

from typing import Any

from leegen.core.models import Problem


def problem_summary(p: Problem) -> dict[str, Any]:
    return {
        "id": p.id,
        "title": p.title,
        "difficulty": p.difficulty,
        "tags": p.tags,
        "track": p.track,
        "order": p.order,
        "environment": p.environment,
        "requires": p.requires,
        "judge": p.judge.kind,
    }


def run_status(last_run: dict[str, Any] | None) -> str | None:
    """Problem-list badge: passed / attempted / never run."""
    if not last_run:
        return None
    return "passed" if last_run.get("status") == "passed" else "attempted"


def sort_key(summary: dict[str, Any]) -> tuple[str, int, str]:
    return (summary["track"] or "~", summary["order"] or 0, summary["title"].lower())


def public_problem(p: Problem) -> dict[str, Any]:
    """Problem without hidden files, the reference, or hidden test data."""
    tests = []
    for t in p.tests:
        item: dict[str, Any] = {"name": t.name, "visible": t.visible,
                                "description": t.description, "section": t.section}
        if t.visible:
            item["input"] = t.input.model_dump(exclude_defaults=True) if t.input else None
            item["expected"] = None if t.needs_reference else t.expected
        tests.append(item)
    return {
        **problem_summary(p),
        "description": p.description,
        "hints": p.hints,
        "files": [f.model_dump() for f in p.files if f.role != "hidden"],
        "judge": {
            "kind": p.judge.kind,
            "entry": p.judge.entry,
            "params": p.judge.params,
            "compare": p.judge.compare.kind,
        },
        "sections": [s.model_dump() for s in p.sections],
        "tests": tests,
        "has_reference": p.reference is not None,
        "limits": p.limits.model_dump(),
        "benchmark": p.benchmark.model_dump() if p.benchmark else None,
    }


BRIEF_TEST_KEYS = ("name", "section", "description", "status", "visible", "input", "expected",
                   "actual", "message", "stdout")


def brief_run(result: dict[str, Any] | None, *, full: bool = False) -> dict[str, Any] | None:
    """A run as the tutoring agent sees it: failing tests only, unless `full`."""
    if not result:
        return None
    tests = result.get("tests", [])
    shown = tests if full else [t for t in tests if t.get("status") != "pass"]
    return {
        "status": result.get("status"), "passed": result.get("passed"),
        "total": result.get("total"), "executor": result.get("executor"),
        "device": result.get("device"), "error": result.get("error"),
        "compile_output": result.get("compile_output"), "metrics": result.get("metrics"),
        "tests" if full else "failing_tests": [
            {k: t.get(k) for k in BRIEF_TEST_KEYS if t.get(k) is not None} for t in shown
        ],
    }
