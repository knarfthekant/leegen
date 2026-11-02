from leegen.executors import local, remote  # noqa: F401  (registers executor kinds)
from leegen.executors.base import ExecOutcome, Executor, JobSpec
from leegen.executors.manager import ExecutorManager

__all__ = ["ExecOutcome", "Executor", "ExecutorManager", "JobSpec"]
