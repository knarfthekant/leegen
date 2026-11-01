"""The problem schema and the other wire models.

`Problem` is the source of truth for `schema/problem.schema.json` (see `export.py`).
Field descriptions end up in the JSON Schema, so they are written for problem authors.
"""

from __future__ import annotations

import posixpath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Requirement = Literal["cpu", "gpu", "cuda"]
Capability = Literal["cpu", "gpu", "cuda", "mps"]
FileRole = Literal["editable", "readonly", "hidden"]
TestStatus = Literal["pass", "fail", "error", "timeout", "skipped"]
RunStatus = Literal["passed", "failed", "error", "timeout", "compile_error", "cancelled"]

FROM_REFERENCE = "from_reference"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _check_rel_path(path: str) -> str:
    norm = posixpath.normpath(path)
    if path.startswith("/") or norm.startswith("..") or norm in (".", ""):
        raise ValueError(f"file path must be relative and inside the problem: {path!r}")
    if norm.split("/")[0] in (".leetclaude", "_lc"):
        raise ValueError(f"file path uses a reserved directory: {path!r}")
    return norm


# --------------------------------------------------------------------------- problem


class ProblemFile(_Strict):
    path: str = Field(description="Relative path, e.g. `solution.py` or `app/service.py`.")
    role: FileRole = Field(
        "editable",
        description="`editable`: starter code the user writes in. `readonly`: shown but locked "
        "(context code, visible tests). `hidden`: never shown (setup, generators, hidden tests).",
    )
    content: str = ""
    language: str | None = Field(
        None, description="Editor language override; inferred from the extension when omitted."
    )

    @field_validator("path")
    @classmethod
    def _v_path(cls, v: str) -> str:
        return _check_rel_path(v)


class ReferenceFile(_Strict):
    path: str
    content: str

    @field_validator("path")
    @classmethod
    def _v_path(cls, v: str) -> str:
        return _check_rel_path(v)


class Reference(_Strict):
    files: list[ReferenceFile] = Field(
        description="Replacements for editable files that make up a correct solution."
    )


class Compare(_Strict):
    kind: Literal["exact", "float", "unordered", "allclose", "custom"] = Field(
        "exact",
        description="`exact`: ==, tuples and lists treated alike. `float`: recursive isclose. "
        "`unordered`: order-insensitive list compare. `allclose`: tensors/arrays (torch, numpy) "
        "or nested floats. `custom`: `fn(actual, expected, inputs) -> bool | (bool, message)`.",
    )
    rtol: float = 1e-6
    atol: float = 1e-8
    fn: str | None = Field(None, description="For `custom`: `file.py:function` (usually hidden).")

    @model_validator(mode="after")
    def _custom_needs_fn(self) -> Compare:
        if self.kind == "custom" and not self.fn:
            raise ValueError("compare.kind=custom requires compare.fn")
        return self


class Judge(_Strict):
    kind: Literal["function", "pytest", "script"] = Field(
        description="`function`: call `entry` per test and compare to `expected`. `pytest`: run "
        "test files (readonly = visible, hidden = hidden). `script`: run `command`, which writes "
        "result events itself."
    )
    entry: str | None = Field(
        None,
        description="function kind: `file.py:name`. A function is called with the test's "
        "args/kwargs. A class is driven by the test's `calls` (design-problem style).",
    )
    params: list[str] | None = Field(
        None, description="function kind: display names for positional args in the Testcase panel."
    )
    compare: Compare = Field(default_factory=Compare)
    test_files: list[str] | None = Field(
        None, description="pytest kind: test files to run. Default: every `test_*.py` file."
    )
    build: list[list[str]] = Field(
        default_factory=list, description="script kind: build commands run before `command`."
    )
    command: list[str] | None = Field(None, description="script kind: the harness command.")

    @model_validator(mode="after")
    def _kind_fields(self) -> Judge:
        if self.kind == "function" and not self.entry:
            raise ValueError("judge.kind=function requires judge.entry (e.g. 'solution.py:solve')")
        if self.kind == "script" and not self.command:
            raise ValueError("judge.kind=script requires judge.command")
        if self.entry and ":" not in self.entry:
            raise ValueError("judge.entry must look like 'file.py:name'")
        return self


class Call(_Strict):
    method: str
    args: list[Any] = Field(default_factory=list)
    kwargs: dict[str, Any] = Field(default_factory=dict)


class TestInput(_Strict):
    args: list[Any] = Field(default_factory=list, description="Positional args, JSON values.")
    kwargs: dict[str, Any] = Field(default_factory=dict)
    gen: str | None = Field(
        None,
        description="`file.py:fn` generator returning `(args, kwargs)`, a list of args, or a dict "
        "of kwargs. Called as `fn(seed=..., **kwargs)`. Use for tensors and large inputs.",
    )
    seed: int = 0
    calls: list[Call] | None = Field(
        None,
        description="Class entry: the class is constructed with args/kwargs, then each call runs "
        "in order. The compared value is the list of call return values.",
    )


class TestCase(_Strict):
    __test__ = False  # not a pytest class

    name: str
    visible: bool = Field(True, description="Visible tests show inputs before running.")
    description: str | None = Field(None, description="Shown with the case; Markdown allowed.")
    section: str | None = Field(
        None, description="Id of an entry in the problem's `sections`; groups this case."
    )
    input: TestInput | None = Field(None, description="function kind only.")
    expected: Any = Field(
        FROM_REFERENCE,
        description="Expected value (JSON), or `from_reference` to compute it with the reference "
        "solution at run time.",
    )

    @property
    def needs_reference(self) -> bool:
        return isinstance(self.expected, str) and self.expected == FROM_REFERENCE


class TestSection(_Strict):
    __test__ = False

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", description="Slug that tests reference.")
    title: str
    description: str | None = Field(None, description="Shown under the section header.")


class Limits(_Strict):
    timeout_s: float = Field(10.0, gt=0, le=600)
    memory_mb: int | None = Field(None, gt=0)


class Benchmark(_Strict):
    against: Literal["reference"] = "reference"
    repeats: int = Field(20, ge=1, le=1000)
    max_slowdown: float | None = Field(
        None, gt=0, description="Fail if the user's code is more than this many times slower."
    )


class Problem(_Strict):
    schema_version: Literal[1] = 1
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$", description="Slug; also the file name.")
    title: str
    difficulty: Literal["intro", "easy", "medium", "hard"] = "medium"
    tags: list[str] = Field(default_factory=list)
    track: str | None = Field(None, description="Optional curriculum this problem belongs to.")
    order: int | None = Field(None, description="Position within the track.")
    environment: str = Field(description="Environment id from `environments/`, e.g. `python`.")
    requires: list[Requirement] = Field(
        default_factory=lambda: ["cpu"],
        description="Hardware needed: `cpu`, `gpu` (cuda or mps), `cuda` (NVIDIA only).",
    )
    description: str = Field(description="Markdown with math, mermaid, inline SVG and directives.")
    hints: list[str] = Field(default_factory=list, description="Revealed one at a time.")
    files: list[ProblemFile] = Field(min_length=1)
    reference: Reference | None = Field(
        None, description="Correct solution. Required to validate the problem and for "
        "`expected: from_reference` and user-added tests."
    )
    judge: Judge
    sections: list[TestSection] = Field(
        default_factory=list,
        description="Optional groups for tests. Each test opts in with `section: <id>`.",
    )
    tests: list[TestCase] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)
    benchmark: Benchmark | None = None

    @model_validator(mode="after")
    def _consistency(self) -> Problem:
        paths = [f.path for f in self.files]
        if len(paths) != len(set(paths)):
            raise ValueError("duplicate file paths")
        if not any(f.role == "editable" for f in self.files):
            raise ValueError("at least one file must be editable")
        names = [t.name for t in self.tests]
        if len(names) != len(set(names)):
            raise ValueError("duplicate test names")
        section_ids = [s.id for s in self.sections]
        if len(section_ids) != len(set(section_ids)):
            raise ValueError("duplicate section ids")
        for t in self.tests:
            if t.section is not None and t.section not in section_ids:
                raise ValueError(f"test {t.name!r}: unknown section {t.section!r}")
        editable = {f.path for f in self.files if f.role == "editable"}
        if self.reference:
            for rf in self.reference.files:
                if rf.path not in editable:
                    raise ValueError(f"reference file {rf.path!r} is not an editable file")
        j = self.judge
        if j.kind == "function":
            if not self.tests:
                raise ValueError("function judge needs at least one test")
            for t in self.tests:
                if t.input is None:
                    raise ValueError(f"test {t.name!r}: function judge tests need `input`")
            if any(t.needs_reference for t in self.tests) and not self.reference:
                raise ValueError("tests use expected: from_reference but no reference is given")
            if j.entry and j.entry.split(":")[0] not in paths:
                raise ValueError(f"judge.entry file {j.entry.split(':')[0]!r} is not in files")
        if j.kind == "pytest":
            if not self.pytest_files():
                raise ValueError("pytest judge needs test files (test_*.py or judge.test_files)")
            for p in j.test_files or []:
                if p not in paths:
                    raise ValueError(f"judge.test_files entry {p!r} is not in files")
        if self.benchmark and not self.reference:
            raise ValueError("benchmark needs a reference solution")
        return self

    # helpers ---------------------------------------------------------------
    def pytest_files(self) -> list[str]:
        if self.judge.test_files:
            return list(self.judge.test_files)
        return [f.path for f in self.files if posixpath.basename(f.path).startswith("test_")
                and f.path.endswith(".py")]

    def file(self, path: str) -> ProblemFile | None:
        return next((f for f in self.files if f.path == path), None)

    def editable_files(self) -> list[ProblemFile]:
        return [f for f in self.files if f.role == "editable"]


# --------------------------------------------------------------------------- environments


class Environment(_Strict):
    id: str
    description: str = ""
    language: str = Field(description="Language adapter id: python, cuda, ...")
    python: str = "3.13"
    dependencies: list[str] = Field(default_factory=list)
    requires: list[Requirement] = Field(default_factory=lambda: ["cpu"])
    env: dict[str, str] = Field(default_factory=dict)
    env_without_cuda: dict[str, str] = Field(
        default_factory=dict, description="Extra env vars when the executor has no CUDA."
    )


class ExecutorConfig(BaseModel):
    """Executor entry from executors.yaml. Kind-specific fields are allowed (extra=allow)."""

    model_config = ConfigDict(extra="allow")

    id: str
    kind: str
    capabilities: list[Capability] | None = None
    description: str = ""


# --------------------------------------------------------------------------- results


class TestResult(BaseModel):
    __test__ = False

    name: str
    status: TestStatus
    visible: bool = True
    custom: bool = False
    description: str | None = None
    section: str | None = None
    input: Any = None
    expected: Any = None
    actual: Any = None
    message: str | None = None
    stdout: str | None = None
    duration_ms: float | None = None


class Metric(BaseModel):
    name: str
    value: float
    unit: str = ""
    reference: float | None = None


class RunResult(BaseModel):
    run_id: str
    problem_id: str
    mode: Literal["user", "reference"] = "user"
    status: RunStatus
    executor: str
    device: str | None = None
    started_at: float
    duration_ms: float
    passed: int = 0
    total: int = 0
    tests: list[TestResult] = Field(default_factory=list)
    metrics: list[Metric] = Field(default_factory=list)
    compile_output: str | None = None
    error: str | None = None
    stdout: str = ""
    stderr: str = ""
