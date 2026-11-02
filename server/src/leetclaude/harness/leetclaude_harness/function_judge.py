"""function judge: call the entry for each test, compare with expected.

Phases, all in one process:
  1. build inputs (generators run once; each phase gets a deep copy)
  2. reference phase: compute `from_reference` expectations (+ benchmark timing)
  3. user phase: run the user's entry and compare
"""

from __future__ import annotations

import copy
import inspect
import statistics
import time
from pathlib import Path
from typing import Any

from leetclaude_harness import compare as cmp
from leetclaude_harness._common import (
    Deadline,
    TestTimeout,
    alarm,
    capture,
    load_isolated,
    module_scope,
    resolve,
    run_coro,
    sync_device,
    user_traceback,
)
from leetclaude_harness.protocol import describe, emit, truncate


def _finish(value: Any) -> Any:
    """Await coroutines; drain (async) generators into lists."""
    if inspect.iscoroutine(value):
        value = run_coro(value)
    if inspect.isasyncgen(value):
        async def drain(agen: Any) -> list[Any]:
            return [x async for x in agen]

        value = run_coro(drain(value))
    elif inspect.isgenerator(value):
        value = list(value)
    return value


def build_inputs(test: dict[str, Any], directory: Path) -> dict[str, Any]:
    spec = test.get("input") or {}
    args, kwargs = list(spec.get("args") or []), dict(spec.get("kwargs") or {})
    if spec.get("gen"):
        gen = load_isolated(directory, spec["gen"])
        produced = gen(seed=spec.get("seed", 0), **kwargs)
        if isinstance(produced, dict):
            args, kwargs = [], produced
        elif isinstance(produced, (list, tuple)):
            args, kwargs = list(produced), {}
        else:
            args, kwargs = [produced], {}
    return {"args": args, "kwargs": kwargs, "calls": spec.get("calls")}


def invoke(target: Any, inputs: dict[str, Any]) -> Any:
    args, kwargs, calls = inputs["args"], inputs["kwargs"], inputs["calls"]
    if inspect.isclass(target) and calls is not None:
        obj = target(*args, **kwargs)
        return [_finish(getattr(obj, c["method"])(*c.get("args", []), **c.get("kwargs", {})))
                for c in calls]
    return _finish(target(*args, **kwargs))


def display_input(test: dict[str, Any], inputs: dict[str, Any] | None) -> Any:
    spec = test.get("input") or {}
    if spec.get("gen"):
        kw = ", ".join(f"{k}={v!r}" for k, v in (spec.get("kwargs") or {}).items())
        shown: dict[str, Any] = {"generated": f"{spec['gen']}(seed={spec.get('seed', 0)}"
                                 f"{', ' + kw if kw else ''})"}
        if inputs is not None:
            shown["args"] = describe(inputs["args"])
            if inputs["kwargs"]:
                shown["kwargs"] = describe(inputs["kwargs"])
        return shown
    return {k: v for k, v in spec.items() if v not in (None, [], {}) and k != "seed"}


def _time_call(target: Any, inputs: dict[str, Any], repeats: int) -> float:
    for _ in range(min(3, repeats)):
        invoke(target, copy.deepcopy(inputs))
    sync_device()
    samples = []
    for _ in range(repeats):
        fresh = copy.deepcopy(inputs)
        t0 = time.perf_counter()
        invoke(target, fresh)
        sync_device()
        samples.append((time.perf_counter() - t0) * 1000)
    return statistics.median(samples)


def run(cfg: dict[str, Any]) -> None:
    judge = cfg["judge"]
    tests: list[dict[str, Any]] = cfg["tests"]
    user_dir = Path(cfg["user_dir"])
    ref_dir = Path(cfg["ref_dir"]) if cfg.get("ref_dir") else None
    deadline = Deadline(cfg["timeout_s"])
    entry = judge["entry"]
    comp = judge.get("compare") or {"kind": "exact"}
    bench = cfg.get("benchmark")

    # 1. inputs ---------------------------------------------------------------
    inputs: dict[str, dict[str, Any]] = {}
    input_errors: dict[str, str] = {}
    for t in tests:
        try:
            inputs[t["name"]] = build_inputs(t, user_dir)
        except Exception as exc:  # noqa: BLE001
            input_errors[t["name"]] = "input generator failed:\n" + user_traceback(exc)

    # 2. reference -------------------------------------------------------------
    expected: dict[str, Any] = {t["name"]: t.get("expected") for t in tests}
    ref_errors: dict[str, str] = {}
    ref_time: float | None = None
    need_ref = [t for t in tests if t.get("needs_reference") and t["name"] in inputs]
    if (need_ref or bench) and ref_dir is not None:
        with module_scope(ref_dir):
            try:
                ref_target = resolve(entry)
            except Exception as exc:  # noqa: BLE001
                ref_target = None
                for t in need_ref:
                    ref_errors[t["name"]] = "reference failed to import:\n" + user_traceback(exc)
            if ref_target is not None:
                for t in need_ref:
                    try:
                        with alarm(deadline.remaining()), capture():
                            expected[t["name"]] = invoke(ref_target, copy.deepcopy(inputs[t["name"]]))
                    except TestTimeout:
                        ref_errors[t["name"]] = "reference timed out (problem limits too tight?)"
                    except BaseException as exc:  # noqa: BLE001
                        ref_errors[t["name"]] = "reference raised:\n" + user_traceback(exc)
                if bench and tests and tests[-1]["name"] in inputs:
                    try:
                        with alarm(deadline.remaining()), capture():
                            ref_time = _time_call(ref_target, inputs[tests[-1]["name"]],
                                                  bench.get("repeats", 20))
                    except BaseException:  # noqa: BLE001
                        ref_time = None

    # 3. user ------------------------------------------------------------------
    with module_scope(user_dir):
        try:
            with alarm(max(deadline.remaining(), 0.001)), capture() as out:
                target = resolve(entry)
        except BaseException as exc:  # noqa: BLE001
            msg = user_traceback(exc) if not isinstance(exc, TestTimeout) else "import timed out"
            emit({"type": "error", "message": f"Could not load {entry}:\n{msg}",
                  "stdout": truncate(out.getvalue()) if "out" in locals() else None})
            return

        all_passed = True
        for t in tests:
            name = t["name"]
            base = {"type": "test", "name": name, "visible": t.get("visible", True),
                    "custom": t.get("custom", False), "description": t.get("description"),
                    "section": t.get("section")}
            shown_input = display_input(t, inputs.get(name))
            if name in input_errors or name in ref_errors:
                emit({**base, "status": "error", "input": shown_input,
                      "message": input_errors.get(name) or ref_errors.get(name)})
                all_passed = False
                continue
            if deadline.expired():
                emit({**base, "status": "timeout", "input": shown_input,
                      "message": "not run: time limit reached"})
                all_passed = False
                continue
            t0 = time.perf_counter()
            status, actual, message, stdout = "error", None, None, ""
            try:
                with alarm(deadline.remaining()), capture() as buf:
                    actual = invoke(target, copy.deepcopy(inputs[name]))
                stdout = buf.getvalue()
                if comp["kind"] == "custom":
                    fn = load_isolated(user_dir, comp["fn"])
                    ok, message = cmp.run_custom(fn, actual, expected[name], inputs[name])
                else:
                    ok, message = cmp.BUILTIN[comp["kind"]](
                        actual, expected[name], rtol=comp.get("rtol", 1e-6), atol=comp.get("atol", 1e-8))
                status = "pass" if ok else "fail"
            except TestTimeout:
                status, message = "timeout", f"exceeded the {cfg['timeout_s']:g}s time limit"
                stdout = buf.getvalue() if "buf" in locals() else ""
            except BaseException as exc:  # noqa: BLE001
                status, message = "error", user_traceback(exc)
                stdout = buf.getvalue() if "buf" in locals() else ""
            all_passed &= status == "pass"
            emit({**base, "status": status, "input": shown_input,
                  "expected": describe(expected[name]), "actual": describe(actual),
                  "message": truncate(message), "stdout": truncate(stdout) or None,
                  "duration_ms": round((time.perf_counter() - t0) * 1000, 3)})

        if bench and all_passed and tests and tests[-1]["name"] in inputs:
            try:
                with alarm(max(deadline.remaining(), 0.001)), capture():
                    user_time = _time_call(target, inputs[tests[-1]["name"]], bench.get("repeats", 20))
            except BaseException as exc:  # noqa: BLE001
                emit({"type": "test", "name": "benchmark", "status": "error", "visible": True,
                      "message": "benchmark failed: " + (
                          "time limit reached" if isinstance(exc, TestTimeout) else user_traceback(exc))})
                return
            emit({"type": "metric", "name": "time_ms", "value": user_time, "unit": "ms",
                  "reference": ref_time})
            limit = bench.get("max_slowdown")
            if limit and ref_time:
                slowdown = user_time / ref_time if ref_time > 0 else 1.0
                emit({"type": "test", "name": "benchmark", "visible": True,
                      "status": "pass" if slowdown <= limit else "fail",
                      "actual": f"{user_time:.3f} ms ({slowdown:.2f}x reference)",
                      "expected": f"<= {limit:g}x reference ({ref_time:.3f} ms)",
                      "message": None if slowdown <= limit else "too slow"})
