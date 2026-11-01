"""Remote executors: run job bundles on another machine over SSH, optionally through SLURM.

executors.yaml examples:

    - id: devbox
      kind: ssh
      host: devbox                      # alias from ~/.ssh/config
      workdir: ~/.leetclaude            # remote scratch (envs/ and runs/ live here)
      capabilities: [cpu, cuda]

    - id: cluster
      kind: slurm
      host: hpc-login
      workdir: /scratch/$USER/leetclaude
      srun_args: [--partition=gpu, --gres=gpu:1, --time=00:10:00]
      setup: "module load cuda/12.4"    # optional shell lines run before every job
      capabilities: [cpu, cuda]

The remote needs bash, tar, coreutils `timeout` and, for Python environments, `uv` on PATH.
Authentication is whatever `ssh <host>` already does (keys, agent, ControlMaster); leetclaude
never handles credentials itself.
"""

from __future__ import annotations

import asyncio
import io
import re
import shlex
import tarfile
import time
from collections.abc import Awaitable, Callable
from typing import Any

from leetclaude.config import settings
from leetclaude.envs.registry import env_hash
from leetclaude.executors.base import ExecOutcome, Executor, JobSpec, StatusCallback, _no_status
from leetclaude.executors.local import MAX_OUTPUT, env_values, fill
from leetclaude.registry import register
from leetclaude.schema.models import Environment

BUILD_LOG = ".lc_build.log"
BUILD_FAILED = ".lc_build_failed"


class RemoteError(RuntimeError):
    pass


def _tar_bundle(job: JobSpec) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        tar.add(job.bundle, arcname=".")
    return buf.getvalue()


@register("executor", "ssh")
class SshExecutor(Executor):
    kind = "ssh"

    def __init__(self, config):  # type: ignore[no-untyped-def]
        super().__init__(config)
        extra: dict[str, Any] = config.model_extra or {}
        self.host: str | None = extra.get("host")
        self.workdir: str = extra.get("workdir", "~/.leetclaude")
        self.ssh_options: list[str] = list(extra.get("ssh_options", []))
        self.setup: str = extra.get("setup", "")
        uv = str(extra.get("uv", "uv"))
        self.uv: str = ("$HOME" + uv[1:]) if uv.startswith("~/") else uv
        # transport override, mainly for tests: argv prefix that runs one shell command string
        self.ssh_command: list[str] | None = extra.get("ssh_command")
        # build environments inside the job (on the compute node) instead of on the login host
        self.provision_on_node: bool = bool(extra.get("provision_on_node", self.kind == "slurm"))
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled: set[str] = set()
        self._abs_base: str | None = None
        if not self.host and not self.ssh_command:
            raise ValueError(f"executor {config.id!r}: `host` is required")

    def capabilities(self) -> set[str]:
        return set(self.config.capabilities or ["cpu"])

    # transport --------------------------------------------------------------
    def _argv(self, remote_cmd: str) -> list[str]:
        if self.ssh_command:
            return [*self.ssh_command, remote_cmd]
        control = settings().cache_dir / "ssh"
        control.mkdir(parents=True, exist_ok=True)
        return ["ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=auto",
                "-o", f"ControlPath={control}/%C", "-o", "ControlPersist=10m",
                *self.ssh_options, str(self.host), remote_cmd]

    async def _sh(self, script: str, *, stdin: bytes | None = None, timeout: float = 600,
                  run_id: str | None = None) -> tuple[int | None, str, str, bool]:
        argv = self._argv("bash -lc " + shlex.quote(script))
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        if run_id:
            self._procs[run_id] = proc
        timed_out = False
        try:
            out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
        except TimeoutError:
            timed_out = True
            proc.kill()
            out, err = await proc.communicate()
        finally:
            if run_id:
                self._procs.pop(run_id, None)
        return (proc.returncode, out[-MAX_OUTPUT:].decode(errors="replace"),
                err[-MAX_OUTPUT:].decode(errors="replace"), timed_out)

    async def _resolve_base(self) -> str:
        """Absolute remote workdir ($HOME etc. expanded once), so paths survive any quoting."""
        if self._abs_base is None:
            code, out, err, _ = await self._sh(f'mkdir -p "{self._base()}" && cd "{self._base()}" && pwd',
                                               timeout=60)
            if code != 0 or not out.strip():
                raise RemoteError(f"cannot reach {self.id}: {err.strip() or out.strip()}")
            self._abs_base = out.strip().splitlines()[-1]
        return self._abs_base

    async def _sh_stream(self, script: str, *, timeout: float, run_id: str,
                         on_stderr_line: Callable[[str], Awaitable[None]]) -> tuple[int | None, str, str, bool]:
        """Like _sh, but reports stderr lines as they arrive (SLURM queue messages)."""
        argv = self._argv("bash -lc " + shlex.quote(script))
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        self._procs[run_id] = proc
        err_lines: list[str] = []

        async def pump_err() -> None:
            assert proc.stderr
            async for raw in proc.stderr:
                line = raw.decode(errors="replace")
                err_lines.append(line)
                await on_stderr_line(line)

        timed_out = False
        try:
            assert proc.stdout
            out_task = asyncio.ensure_future(proc.stdout.read())
            await asyncio.wait_for(asyncio.gather(out_task, pump_err(), proc.wait()), timeout)
            out = out_task.result()
        except TimeoutError:
            timed_out = True
            proc.kill()
            await proc.wait()
            out = b""
        finally:
            self._procs.pop(run_id, None)
        return (proc.returncode, out[-MAX_OUTPUT:].decode(errors="replace"),
                "".join(err_lines)[-MAX_OUTPUT:], timed_out)

    def _base(self) -> str:
        if self._abs_base:
            return self._abs_base
        # paths are used inside double quotes, where ~ doesn't expand but $HOME does
        w = self.workdir
        if w == "~" or w.startswith("~/"):
            w = "$HOME" + w[1:]
        return w.rstrip("/")

    # environments -----------------------------------------------------------
    def provision_script(self, env: Environment, extra_deps: list[str]) -> tuple[str, str]:
        deps = sorted({*env.dependencies, *extra_deps})
        env_dir = f"{self._base()}/envs/{env.id}-{env_hash(env, extra_deps)}"
        install = (f'{self.uv} pip install --no-config --python "{env_dir}/bin/python" '
                   f'--default-index {shlex.quote(settings().package_index)} '
                   + " ".join(shlex.quote(d) for d in deps)) if deps else "true"
        build = (f'rm -rf "{env_dir}" && mkdir -p "$(dirname "{env_dir}")" && '
                 f'{self.uv} venv --no-config --python {shlex.quote(env.python)} "{env_dir}" && '
                 f'{install} && touch "{env_dir}/.ready"')
        script = "\n".join([
            f'if [ ! -f "{env_dir}/.ready" ]; then',
            f'  mkdir -p "$(dirname "{env_dir}")"',
            # serialize concurrent provisioning of the same environment
            f'  if command -v flock >/dev/null 2>&1; then',
            f'    flock "{env_dir}.lock" bash -c {shlex.quote(f"[ -f {env_dir}/.ready ] || {{ {build}; }}")} '
            f'>"{env_dir}.log" 2>&1',
            f'  else ( {build} ) >"{env_dir}.log" 2>&1; fi',
            f'  if [ ! -f "{env_dir}/.ready" ]; then echo "environment {env.id} failed to build:" >&2; '
            f'tail -50 "{env_dir}.log" >&2; exit 4; fi',
            "fi",
        ])
        return env_dir, script

    async def prepare(self, env: Environment, extra_deps: list[str]) -> dict[str, str]:
        if env.language != "python" and not env.dependencies:
            return {}
        try:
            await self._resolve_base()
        except RemoteError as exc:
            from leetclaude.envs.provision import ProvisionError

            raise ProvisionError(str(exc)) from exc
        env_dir, script = self.provision_script(env, extra_deps)
        values = env_values(env, f"{env_dir}/bin/python")
        if self.provision_on_node:
            return {**values, "_provision": script}
        code, out, err, _ = await self._sh("set -e\n" + self.setup + "\n" + script, timeout=1800)
        if code != 0:
            from leetclaude.envs.provision import ProvisionError

            raise ProvisionError(f"remote provisioning on {self.id} failed:\n{out}\n{err}")
        return values

    # running ----------------------------------------------------------------
    def wrap(self, job: JobSpec, script: str) -> str:
        """Hook for subclasses (SLURM): how the job script is started on the remote."""
        # own process group (setsid) so cancel can kill the whole tree
        return f"$(command -v setsid || true) bash -c {shlex.quote(script)}"

    def job_script(self, job: JobSpec, values: dict[str, str], remote_bundle: str) -> str:
        env = {k: fill(v, values) for k, v in job.env.items()}
        env["LEETCLAUDE_RESULTS"] = f"{remote_bundle}/{job.results_file}"
        lines = ["set -u", self.setup,
                 # coreutils timeout is standard on Linux; degrade gracefully elsewhere
                 '_lc_to() { local t=$1; shift; if command -v timeout >/dev/null 2>&1; then '
                 'timeout -k 2 "$t" "$@"; else "$@"; fi; }',
                 f'cd "{remote_bundle}/{job.workdir}"', "echo $$ > \"" + remote_bundle + "/.pid\""]
        if values.get("_provision"):
            lines.append(values["_provision"])
        lines += [f"export {k}={shlex.quote(v)}" if "$" not in v else f'export {k}="{v}"'
                  for k, v in env.items()]
        for step in job.build:
            cmd = " ".join(shlex.quote(fill(a, values)) for a in step)
            lines.append(f'echo "$ {cmd}" >> "{remote_bundle}/{BUILD_LOG}"')
            lines.append(f'if ! _lc_to {int(job.build_timeout_s)} {cmd} >> "{remote_bundle}/{BUILD_LOG}" 2>&1; '
                         f'then touch "{remote_bundle}/{BUILD_FAILED}"; exit 3; fi')
        run_cmd = " ".join(shlex.quote(fill(a, values)) for a in job.command)
        lines.append(f"_lc_to {int(job.timeout_s + 15)} {run_cmd}")
        return "\n".join(line for line in lines if line)

    async def on_job_stderr(self, line: str, on_status: StatusCallback) -> None:
        """Hook: interpret scheduler messages. Plain SSH runs start immediately."""
        return None

    async def run(self, job: JobSpec, values: dict[str, str],
                  on_status: StatusCallback = _no_status) -> ExecOutcome:
        started = time.perf_counter()
        try:
            await self._resolve_base()
        except RemoteError as exc:
            return ExecOutcome(None, stderr=str(exc))
        remote_bundle = f"{self._base()}/runs/{job.run_id}"
        values = {**values, "bundle": remote_bundle}

        code, out, err, _ = await self._sh(
            f'mkdir -p "{remote_bundle}" && tar -xzf - -C "{remote_bundle}"',
            stdin=_tar_bundle(job), timeout=300)
        if code != 0:
            return ExecOutcome(code, stderr=f"upload to {self.id} failed:\n{out}{err}",
                               duration_ms=(time.perf_counter() - started) * 1000)
        try:
            script = self.job_script(job, values, remote_bundle)
            budget = job.timeout_s + 30 + job.build_timeout_s * len(job.build) + self.queue_budget()
            if values.get("_provision"):
                budget += 1800  # first use builds the environment on the node
            if not isinstance(self, SlurmExecutor):
                await on_status("running", self.id)
            code, out, err, timed_out = await self._sh_stream(
                self.wrap(job, script), timeout=budget, run_id=job.run_id,
                on_stderr_line=lambda line: self.on_job_stderr(line, on_status))
            # fetch results + build log in one round trip
            sep = "\x1e--leetclaude--\x1e"
            _, fetched, _, _ = await self._sh(
                f'cat "{remote_bundle}/{job.results_file}" 2>/dev/null; printf "{sep}"; '
                f'cat "{remote_bundle}/{BUILD_LOG}" 2>/dev/null; printf "{sep}"; '
                f'[ -f "{remote_bundle}/{BUILD_FAILED}" ] && echo failed', timeout=120)
            results, build_log, build_flag = (fetched.split(sep) + ["", "", ""])[:3]
            return ExecOutcome(
                code, stdout=out, stderr=err, results=results, timed_out=timed_out or code == 124,
                cancelled=job.run_id in self._cancelled, build_failed="failed" in build_flag,
                build_output=build_log, duration_ms=(time.perf_counter() - started) * 1000)
        finally:
            await self._sh(f'rm -rf "{remote_bundle}"', timeout=60)

    def queue_budget(self) -> float:
        return 0.0

    async def cancel(self, run_id: str) -> bool:
        self._cancelled.add(run_id)
        remote_bundle = f"{self._base()}/runs/{run_id}"
        await self._sh(f'[ -f "{remote_bundle}/.pid" ] && kill -- -$(cat "{remote_bundle}/.pid") '
                       f"2>/dev/null; true", timeout=30)
        proc = self._procs.get(run_id)
        if proc and proc.returncode is None:
            proc.kill()
        return True


@register("executor", "slurm")
class SlurmExecutor(SshExecutor):
    """Like ssh, but each job runs as a SLURM job step via blocking `srun` on a login node."""

    kind = "slurm"

    def __init__(self, config):  # type: ignore[no-untyped-def]
        super().__init__(config)
        extra: dict[str, Any] = config.model_extra or {}
        self.srun_args: list[str] = list(extra.get("srun_args", []))
        self.max_queue_s: float = float(extra.get("max_queue_s", 600))

    def wrap(self, job: JobSpec, script: str) -> str:
        args = " ".join(shlex.quote(a) for a in self.srun_args)
        return f"srun --job-name=lc-{job.run_id} {args} bash -c {shlex.quote(script)}"

    def queue_budget(self) -> float:
        return self.max_queue_s

    _QUEUED = re.compile(r"job (\d+) queued and waiting")
    _ALLOCATED = re.compile(r"job (\d+) has been allocated resources")

    async def on_job_stderr(self, line: str, on_status: StatusCallback) -> None:
        if m := self._QUEUED.search(line):
            await on_status("queued", f"{self.id} (SLURM job {m.group(1)})")
        elif m := self._ALLOCATED.search(line):
            await on_status("running", f"{self.id} (SLURM job {m.group(1)})")

    async def cancel(self, run_id: str) -> bool:
        self._cancelled.add(run_id)
        await self._sh(f"scancel --name=lc-{run_id} 2>/dev/null; true", timeout=30)
        proc = self._procs.get(run_id)
        if proc and proc.returncode is None:
            proc.kill()
        return True


