"""Export real job bundles for the browser probe, using the core planning code (core.plan).

Run from the repo root:
    uv run --project server python -I spikes/browser-probe/tools/export_bundles.py \
        --out spikes/browser-probe/build/runner/bundles merge-ranges py-async-generators

Each bundle is a JSON file {problem_id, mode, expect, files: {relpath: content}} holding exactly
what the orchestrator would write to its temp dir: user/, ref/ (if needed), _lc/leetclaude_harness
and run.json. Nothing is executed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from leetclaude.core.plan import plan_run
from leetclaude.runner.orchestrator import HARNESS_DIR
from leetclaude.store.problems import parse_problem_yaml


def bundle_files(problem, mode: str) -> dict[str, str]:
    plan = plan_run(problem, mode=mode, device="cpu")
    files = dict(plan.files)
    for path in sorted(HARNESS_DIR.rglob("*.py")):
        files[f"_lc/leetclaude_harness/{path.relative_to(HARNESS_DIR)}"] = path.read_text()
    files["run.json"] = json.dumps(plan.run_config, indent=2)
    return files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--problems-dir", type=Path, default=Path("problems"))
    ap.add_argument("ids", nargs="+")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    index = []
    for pid in args.ids:
        path = args.problems_dir / f"{pid}.yaml"
        if not path.is_file():
            sys.exit(f"unknown problem {pid!r} ({path})")
        problem = parse_problem_yaml(path.read_text())
        # reference must pass every test; the untouched starter must fail at least one
        for mode, expect in (("reference", "all_pass"), ("user", "some_fail")):
            name = f"{pid}.{mode}.json"
            payload = {"problem_id": pid, "judge": problem.judge.kind, "mode": mode,
                       "expect": expect, "files": bundle_files(problem, mode)}
            (args.out / name).write_text(json.dumps(payload))
            index.append({"file": name, "problem_id": pid, "judge": problem.judge.kind,
                          "mode": mode, "expect": expect})
    (args.out / "index.json").write_text(json.dumps(index, indent=2))
    print(f"wrote {len(index)} bundles to {args.out}")


if __name__ == "__main__":
    main()
