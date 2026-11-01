import shutil

import pytest

from leetclaude.runner import Orchestrator, RunRequest
from leetclaude.store.problems import ProblemStore, parse_problem_yaml

from .conftest import FIXTURES

orch = Orchestrator()


def problem(pid):
    p = ProblemStore().get(pid)
    assert p is not None
    return p


async def run(pid_or_problem, **kw):
    p = problem(pid_or_problem) if isinstance(pid_or_problem, str) else pid_or_problem
    return await orch.run(RunRequest(problem=p, **kw))


GOOD = """def merge_ranges(bookings):
    out = []
    for s, e in sorted(bookings):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out
"""


async def test_function_reference_passes_starter_fails():
    ref = await run("merge-ranges", mode="reference")
    assert ref.status == "passed" and ref.passed == ref.total == 7
    starter = await run("merge-ranges")
    assert starter.status == "failed" and starter.passed == 0


async def test_function_user_solution_and_custom_test():
    r = await run("merge-ranges", files={"solution.py": GOOD},
                  custom_tests=[{"input": {"args": [[[4, 5], [1, 4]]]}}])
    assert r.status == "passed", r
    custom = [t for t in r.tests if t.custom]
    assert custom[0].expected == [[1, 5]] and custom[0].actual == [[1, 5]]


async def test_off_by_one_fails_only_touching_cases():
    buggy = GOOD.replace("s <= out", "s < out")
    r = await run("merge-ranges", files={"solution.py": buggy})
    failing = {t.name for t in r.tests if t.status == "fail"}
    assert "Example" in failing and "Unsorted input" not in failing


async def test_hidden_tests_redacted_when_passing_revealed_when_failing():
    r = await run("merge-ranges", files={"solution.py": GOOD})
    hidden = [t for t in r.tests if not t.visible]
    assert hidden and all(t.input is None and t.actual is None for t in hidden)
    r = await run("merge-ranges", files={"solution.py": "def merge_ranges(b):\n    return b\n"})
    failed_hidden = [t for t in r.tests if not t.visible and t.status == "fail"]
    assert failed_hidden and all(t.input is not None for t in failed_hidden)


async def test_timeout_reported_per_test():
    p = problem("merge-ranges").model_copy(deep=True)
    p.limits.timeout_s = 1.5
    r = await run(p, files={"solution.py": "def merge_ranges(b):\n    while True: pass\n"})
    assert r.status == "failed"
    assert r.tests[0].status == "timeout"
    assert all(t.status == "timeout" for t in r.tests)


async def test_syntax_error_is_reported_with_user_paths():
    r = await run("merge-ranges", files={"solution.py": "def merge_ranges(b)\n    return b\n"})
    assert r.passed == 0
    assert "SyntaxError" in (r.error or "")
    assert 'File "solution.py"' in r.error and "_lc" not in r.error


async def test_hard_crash_marks_remaining_tests():
    r = await run("merge-ranges", files={"solution.py": "import os\ndef merge_ranges(b):\n    os._exit(3)\n"})
    assert r.passed == 0 and all(t.status == "error" for t in r.tests)


async def test_pytest_judge():
    ref = await run("rate-limiter-service", mode="reference")
    assert ref.status == "passed" and ref.total == 9
    visible = {t.name for t in ref.tests if t.visible}
    assert "test_allows_up_to_capacity" in visible
    assert "test_keys_are_independent" not in visible
    starter = await run("rate-limiter-service")
    statuses = {t.name: t.status for t in starter.tests}
    assert statuses["test_denies_when_empty"] == "fail"
    assert statuses["test_cost_above_capacity_raises"] == "fail"  # pytest.raises -> fail, not error


async def test_pytest_async_tests_and_docstrings():
    r = await run("py-async-generators", mode="reference")
    assert r.status == "passed"
    assert any(t.description == "countdown(3) yields 3, 2, 1" for t in r.tests)


@pytest.mark.skipif(shutil.which("c++") is None, reason="no C++ compiler")
async def test_script_judge_cpp():
    p = parse_problem_yaml((FIXTURES / "cpp-sum.yaml").read_text())
    ref = await run(p, mode="reference")
    assert ref.status == "passed" and ref.total == 3, ref
    assert ref.metrics and ref.metrics[0].name == "cases"
    starter = await run(p)
    assert starter.status == "failed"
    broken = await run(p, files={"solution.cpp": "long long sum(int) { return }"})
    assert broken.status == "compile_error" and "error" in (broken.compile_output or "")


async def test_cuda_problem_has_no_local_executor_on_cpu_only_machines():
    from leetclaude.executors.local import detect_local_capabilities

    if "cuda" in detect_local_capabilities():
        pytest.skip("machine has CUDA")
    r = await run("cuda-vector-add", mode="reference")
    assert r.status == "error" and "no configured executor" in (r.error or "")


async def test_gpu_problem_on_local_accelerator():
    from leetclaude.executors.local import detect_local_capabilities

    if not {"mps", "cuda"} & detect_local_capabilities():
        pytest.skip("no local GPU")
    r = await run("kv-cache-basics", mode="reference")
    assert r.status == "passed", r.error
    assert r.device in ("mps", "cuda")
