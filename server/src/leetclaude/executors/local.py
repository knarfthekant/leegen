"""Run jobs as local subprocesses inside the environment's uv venv."""

from __future__ import annotations

import asyncio
import os
import platform
import re
import resource
import shutil
import signal
import time
from pathlib import Path

from leetclaude.envs.provision import ensure_local_python
from leetclaude.executors.base import ExecOutcome, Executor, JobSpec, StatusCallback, _no_status
from leetclaude.registry import register
from leetclaude.schema.models import Environment

MAX_OUTPUT = 200_000


def detect_local_capabilities() -> set[str]:
    caps = {"cpu"}
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        caps.add("mps")
    if shutil.which("nvidia-smi"):
        caps.add("cuda")
    return caps


def fill(template: str, values: dict[str, str]) -> str:
    for key, val in values.items():
        if not key.startswith("_"):
            template = template.replace("{" + key + "}", val)
    return template


_VAR = re.compile(r"\$(?:\{(\w+)(?::-([^}]*))?\}|(\w+))")


def expand_vars(value: str, env: dict[str, str]) -> str:
    """Shell-style $VAR / ${VAR} / ${VAR:-default} expansion against `env`."""
    def sub(m: re.Match[str]) -> str:
        name = m.group(1) or m.group(3)
        return env.get(name) or (m.group(2) or "")
    return _VAR.sub(sub, value)


def env_values(env: Environment, python: str) -> dict[str, str]:
    venv = str(Path(python).parent.parent)
    return {"python": python, "venv": venv,
            "site_packages": f"{venv}/lib/python{env.python}/site-packages"}


@register("executor", "local")
class LocalExecutor(Executor):
    kind = "local"

    def __init__(self, config):  # type: ignore[no-untyped-def]
        super().__init__(config)
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled: set[str] = set()

    def capabilities(self) -> set[str]:
        if self.config.capabilities:
            return set(self.config.capabilities)
        return detect_local_capabilities()

    async def prepare(self, env: Environment, extra_deps: list[str]) -> dict[str, str]:
        if env.language == "python" or env.dependencies:
            python = await ensure_local_python(env, extra_deps)
            return env_values(env, str(python))
        return {}

    async def _exec(self, job: JobSpec, argv: list[str], env: dict[str, str], cwd: str,
                    timeout: float, memory_mb: int | None) -> tuple[int | None, str, str, bool]:
        def limits() -> None:
            os.setsid()
            # CPU seconds across all threads (torch is multi-threaded); wall time is the real limit
            cpu = max(60, int(timeout) * 4)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
            if memory_mb and platform.system() == "Linux":  # RLIMIT_AS is unreliable on macOS
                resource.setrlimit(resource.RLIMIT_AS, (memory_mb << 20, memory_mb << 20))

        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, preexec_fn=limits,
        )
        self._procs[job.run_id] = proc
        timed_out = False
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except TimeoutError:
            timed_out = True
            self._kill(proc)
            out, err = await proc.communicate()
        finally:
            self._procs.pop(job.run_id, None)
        return (proc.returncode, out[-MAX_OUTPUT:].decode(errors="replace"),
                err[-MAX_OUTPUT:].decode(errors="replace"), timed_out)

    @staticmethod
    def _kill(proc: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    async def run(self, job: JobSpec, values: dict[str, str],
                  on_status: StatusCallback = _no_status) -> ExecOutcome:
        await on_status("running", "")
        values = {**values, "bundle": str(job.bundle)}
        base_env = {k: v for k, v in os.environ.items()
                    if k in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "CUDA_HOME",
                             "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES")}
        env = dict(base_env)
        for k, v in job.env.items():
            env[k] = expand_vars(fill(v, values), env)
        env["LEETCLAUDE_RESULTS"] = str(job.bundle / job.results_file)
        cwd = str((job.bundle / job.workdir).resolve())
        started = time.perf_counter()
        memory = int(job.env.get("LEETCLAUDE_MEMORY_MB", "0")) or None

        build_log = []
        for step in job.build:
            argv = [fill(a, values) for a in step]
            code, out, err, to = await self._exec(job, argv, env, cwd, job.build_timeout_s, None)
            build_log.append(f"$ {' '.join(argv)}\n{out}{err}")
            if job.run_id in self._cancelled:
                return ExecOutcome(None, cancelled=True, build_output="\n".join(build_log))
            if code != 0 or to:
                return ExecOutcome(code, build_failed=True, timed_out=to,
                                   build_output="\n".join(build_log),
                                   duration_ms=(time.perf_counter() - started) * 1000)

        argv = [fill(a, values) for a in job.command]
        # the harness has its own per-test deadline; the hard limit adds startup headroom
        code, out, err, to = await self._exec(job, argv, env, cwd, job.timeout_s + 15, memory)
        results_path = job.bundle / job.results_file
        results = results_path.read_text() if results_path.exists() else ""
        return ExecOutcome(
            code, stdout=out, stderr=err, results=results, timed_out=to,
            cancelled=job.run_id in self._cancelled, build_output="\n".join(build_log),
            duration_ms=(time.perf_counter() - started) * 1000,
        )

    async def cancel(self, run_id: str) -> bool:
        proc = self._procs.get(run_id)
        if proc is None:
            return False
        self._cancelled.add(run_id)
        self._kill(proc)
        return True
