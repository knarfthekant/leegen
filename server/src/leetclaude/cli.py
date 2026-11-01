"""leetclaude CLI: serve | validate | run | schema | list."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from leetclaude.config import settings


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("leetclaude.app:app", host=args.host, port=args.port, reload=args.reload,
                reload_dirs=[str(Path(__file__).parent)] if args.reload else None)
    return 0


def _cmd_schema(args: argparse.Namespace) -> int:
    from leetclaude.schema.export import problem_json_schema, write_schema

    if args.stdout:
        print(json.dumps(problem_json_schema(), indent=2))
    else:
        print(write_schema())
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    from leetclaude.store.problems import ProblemStore

    store = ProblemStore()
    for p in store.list():
        print(f"{p.id:32} {p.difficulty:7} {p.environment:10} {p.judge.kind:9} {p.title}")
    for e in store.errors():
        print(f"INVALID {e.path}\n  " + e.error.replace("\n", "\n  "), file=sys.stderr)
    return 1 if store.errors() else 0


def _print_result(result) -> None:  # type: ignore[no-untyped-def]
    print(f"{result.problem_id}: {result.status} {result.passed}/{result.total} "
          f"[{result.executor}/{result.device}, {result.duration_ms:.0f} ms]")
    for t in result.tests:
        mark = "ok  " if t.status == "pass" else t.status.upper()[:4]
        print(f"  {mark} {t.name}")
        if t.status != "pass" and t.message:
            print("       " + t.message.strip().replace("\n", "\n       ")[:1500])
    if result.compile_output and result.status == "compile_error":
        print("  build output:\n    " + result.compile_output.strip().replace("\n", "\n    ")[-3000:])
    if result.error:
        print("  error: " + result.error.strip().replace("\n", "\n  ")[:3000])
    if result.status in ("error", "compile_error") and result.stderr.strip():
        print("  stderr:\n    " + result.stderr.strip().replace("\n", "\n    ")[-2000:])


def _cmd_validate(args: argparse.Namespace) -> int:
    from leetclaude.store.problems import ProblemStore
    from leetclaude.validate import validate_problem

    store = ProblemStore()
    if args.file:
        from leetclaude.store.problems import format_error, parse_problem_yaml

        try:
            problems = [parse_problem_yaml(Path(args.file).read_text())]
        except Exception as exc:  # noqa: BLE001
            print(f"INVALID {args.file}\n{format_error(exc)}")
            return 1
    else:
        problems = store.list() if args.all or not args.ids else [
            p for p in store.list() if p.id in args.ids]
        bad = store.errors()
        for e in bad:
            print(f"INVALID {e.path}\n  " + e.error.replace("\n", "\n  "))
    failed = 0
    for p in problems:
        report = asyncio.run(validate_problem(p, executor=args.executor))
        status = "OK  " if report.ok else ("SKIP" if report.skipped else "FAIL")
        print(f"{status} {p.id}" + (f" ({report.summary})" if report.summary else ""))
        for issue in report.issues:
            print(f"     - {issue}")
        if not report.ok and not report.skipped:
            failed += 1
    return 1 if failed or (not args.file and store.errors()) else 0


def _cmd_run(args: argparse.Namespace) -> int:
    from leetclaude.runner import Orchestrator, RunRequest
    from leetclaude.store.problems import ProblemStore
    from leetclaude.store.workspace import Workspace

    p = ProblemStore().get(args.id)
    if p is None:
        print(f"no problem {args.id!r}", file=sys.stderr)
        return 2
    files = {} if args.reference else Workspace().files(p)
    mode = "reference" if args.reference else "user"
    result = asyncio.run(Orchestrator().run(RunRequest(problem=p, files=files, mode=mode,
                                                       executor=args.executor)))
    if args.json:
        print(result.model_dump_json(indent=2))
    else:
        _print_result(result)
    return 0 if result.status == "passed" else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="leetclaude", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the web app + MCP server")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--reload", action="store_true")
    s.set_defaults(fn=_cmd_serve)

    s = sub.add_parser("schema", help="write schema/problem.schema.json")
    s.add_argument("--stdout", action="store_true")
    s.set_defaults(fn=_cmd_schema)

    s = sub.add_parser("list", help="list problems")
    s.set_defaults(fn=_cmd_list)

    s = sub.add_parser("validate", help="validate problems by running their reference solutions")
    s.add_argument("ids", nargs="*")
    s.add_argument("--all", action="store_true")
    s.add_argument("--file", help="validate a YAML file that is not in problems/ yet")
    s.add_argument("--executor")
    s.set_defaults(fn=_cmd_validate)

    s = sub.add_parser("run", help="run the workspace code (or --reference) for a problem")
    s.add_argument("id")
    s.add_argument("--reference", action="store_true")
    s.add_argument("--executor")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=_cmd_run)

    args = parser.parse_args(argv)
    settings()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
