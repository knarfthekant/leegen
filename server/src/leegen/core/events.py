"""Records and UI events shared by both editions (WebSocket in the server, BroadcastChannel in
the browser). Exported as JSON Schema into contracts/ and turned into TypeScript types."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from leegen.core.models import RunResult
from leegen.core.review import Severity


AgentActivity = Literal["idle", "reviewing", "creating_problem"]


class AgentStatus(BaseModel):
    status: AgentActivity = "idle"
    updated_at: float = 0.0
    expires_at: float | None = None


class AgentStatusChangedEvent(BaseModel):
    type: Literal["agent_status_changed"]
    agent_status: AgentStatus


class Annotation(BaseModel):
    id: str
    file: str | None = None
    start_line: int | None = None
    end_line: int | None = None
    start_col: int | None = None
    end_col: int | None = None
    severity: Severity
    message: str
    author: str
    created_at: float


class Proposal(BaseModel):
    id: str
    file: str
    content: str
    rationale: str = ""
    author: str
    source: Literal["mcp", "disk", "webmcp"]
    created_at: float


class CustomTest(BaseModel):
    name: str | None = None
    description: str | None = None
    section: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    expected: Any = None


class RunStartedEvent(BaseModel):
    type: Literal["run_started"]
    problem_id: str
    run_id: str
    source: str


class RunStatusEvent(BaseModel):
    type: Literal["run_status"]
    problem_id: str
    run_id: str
    phase: Literal["preparing", "queued", "running", "loading"]
    detail: str


class RunFinishedEvent(BaseModel):
    type: Literal["run_finished"]
    problem_id: str
    run_id: str
    source: str
    result: RunResult


class AnnotationsChangedEvent(BaseModel):
    type: Literal["annotations_changed"]
    problem_id: str
    annotations: list[Annotation]


class ProposalsChangedEvent(BaseModel):
    type: Literal["proposals_changed"]
    problem_id: str
    proposals: list[Proposal]
    added: bool = False


class FilesChangedEvent(BaseModel):
    type: Literal["files_changed"]
    problem_id: str
    files: dict[str, str]
    reason: str


class CustomTestsChangedEvent(BaseModel):
    type: Literal["custom_tests_changed"]
    problem_id: str
    tests: list[CustomTest]


class NavigateEvent(BaseModel):
    type: Literal["navigate"]
    problem_id: str


class ProblemsChangedEvent(BaseModel):
    type: Literal["problems_changed"]


class ProblemChangedEvent(BaseModel):
    type: Literal["problem_changed"]
    problem_id: str


BackendEvent = Annotated[
    RunStartedEvent | RunStatusEvent | RunFinishedEvent | AnnotationsChangedEvent
    | ProposalsChangedEvent | FilesChangedEvent | CustomTestsChangedEvent | NavigateEvent
    | ProblemsChangedEvent | ProblemChangedEvent | AgentStatusChangedEvent,
    Field(discriminator="type"),
]


# ------------------------------------------------------------------ browser runner protocol
# The app origin sends RunnerRequest to the separate-origin runner over a MessageChannel; the
# runner streams harness event lines back and answers with a RunResult (or a validation report).


class RunnerRequest(BaseModel):
    run_id: str
    problem_yaml: str = Field(description="The full problem, including hidden files and reference.")
    files: dict[str, str] = Field(default_factory=dict, description="Editable file overrides.")
    mode: Literal["user", "reference"] = "user"
    custom_tests: list[CustomTest] = Field(default_factory=list)
    only_visible: bool = False
    packages: list[str] = Field(default_factory=list, description="Pyodide packages to load.")
    device: str = "cpu"


class RunnerEvent(BaseModel):
    """One harness result line, streamed while the run is in progress."""

    run_id: str
    line: str
