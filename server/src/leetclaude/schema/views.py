"""What the browser (and the tutoring agent) may see of a problem."""

from __future__ import annotations

from typing import Any

from leetclaude.schema.models import Problem


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
