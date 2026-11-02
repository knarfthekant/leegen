"""leegen CLI: start | dev | stop | serve | validate | run | schema | list | browser."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from leegen.config import settings


def _cmd_serve(args: argparse.Namespace) -> int:
    from leegen.devserver import serve

    return serve(args.host, args.port, reload=args.reload)


def _cmd_start(args: argparse.Namespace) -> int:
    from leegen.devserver import start

    return start(args.host, args.port, build=not args.no_build)


def _cmd_stop(args: argparse.Namespace) -> int:
    from leegen.devserver import stop

    return stop(args.port, timeout=args.timeout)


def _cmd_dev(args: argparse.Namespace) -> int:
    from leegen.devserver import dev

    return dev(args.host, args.port, args.web_port)


def _cmd_schema(args: argparse.Namespace) -> int:
    from leegen.schema.contracts import check_all, write_all
    from leegen.schema.export import problem_json_schema

    if args.stdout:
        print(json.dumps(problem_json_schema(), indent=2))
        return 0
    root = settings().root
    if args.check:
        stale = check_all()
        for p in stale:
            print(f"out of date: {p.relative_to(root)}")
        if stale:
            print("run `uv run leegen schema` and commit the result")
        return 1 if stale else 0
    for p in write_all():
        print(p.relative_to(root))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    from leegen.store.problems import ProblemStore

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
    from leegen.store.problems import ProblemStore
    from leegen.validate import validate_problem

    store = ProblemStore()
    if args.file:
        from leegen.store.problems import format_error, parse_problem_yaml

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
    from leegen.runner import Orchestrator, RunRequest
    from leegen.store.problems import ProblemStore
    from leegen.store.workspace import Workspace

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


def _cmd_browser_build(args: argparse.Namespace) -> int:
    from leegen.browser_edition.build import build

    build(args.app_origin, args.runner_origin, Path(args.out), skip_vite=args.skip_vite)
    return 0


def _cmd_browser_serve(args: argparse.Namespace) -> int:
    from leegen.browser_edition.serve import serve

    return serve(Path(args.out), args.app_port, args.runner_port)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="leegen", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    cfg = settings()

    s = sub.add_parser("start", help="build the web UI if needed, then serve UI + API + MCP")
    s.add_argument("--host", default=cfg.host)
    s.add_argument("--port", type=int, default=cfg.port)
    s.add_argument("--no-build", action="store_true", help="serve web/dist as is")
    s.set_defaults(fn=_cmd_start)

    s = sub.add_parser("dev", help="backend with --reload + Vite dev server with hot reload")
    s.add_argument("--host", default=cfg.host)
    s.add_argument("--port", type=int, default=cfg.port)
    s.add_argument("--web-port", type=int, default=cfg.web_port)
    s.set_defaults(fn=_cmd_dev)

    s = sub.add_parser("stop", help="stop the server started by start / dev / serve")
    s.add_argument("--port", type=int, default=cfg.port)
    s.add_argument("--timeout", type=float, default=10.0, help="seconds before SIGKILL")
    s.set_defaults(fn=_cmd_stop)

    s = sub.add_parser("serve", help="serve UI + API + MCP without building (see start)")
    s.add_argument("--host", default=cfg.host)
    s.add_argument("--port", type=int, default=cfg.port)
    s.add_argument("--reload", action="store_true")
    s.set_defaults(fn=_cmd_serve)

    s = sub.add_parser("schema", help="regenerate schema/, contracts/ and the web app's types")
    s.add_argument("--stdout", action="store_true", help="print the problem JSON Schema only")
    s.add_argument("--check", action="store_true", help="fail if generated files are stale")
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

    s = sub.add_parser("browser", help="build or serve the browser edition (static sites)")
    bsub = s.add_subparsers(dest="browser_cmd", required=True)
    default_out = str(cfg.root / "web" / "dist-browser")
    b = bsub.add_parser("build", help="build the app and runner sites")
    b.add_argument("--app-origin", default="http://localhost:13380")
    b.add_argument("--runner-origin", default="http://127.0.0.1:13381")
    b.add_argument("--out", default=default_out)
    b.add_argument("--skip-vite", action="store_true", help="reuse the app's last Vite build")
    b.set_defaults(fn=_cmd_browser_build)
    b = bsub.add_parser("serve", help="serve a build locally with its production headers")
    b.add_argument("--out", default=default_out)
    b.add_argument("--app-port", type=int, default=13380)
    b.add_argument("--runner-port", type=int, default=13381)
    b.set_defaults(fn=_cmd_browser_serve)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
