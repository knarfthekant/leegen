"""ssh/slurm executors, exercised through a local shell instead of a real SSH connection."""

import os
import stat

import pytest

from leetclaude.executors.remote import SlurmExecutor, SshExecutor
from leetclaude.runner import Orchestrator, RunRequest
from leetclaude.schema.models import ExecutorConfig
from leetclaude.store.problems import ProblemStore


class _Manager:
    """Minimal ExecutorManager stand-in holding one executor."""

    def __init__(self, ex):
        self.ex = ex

    def choose(self, requires, preferred=None, env=None):
        return self.ex

    def get(self, _id):
        return self.ex


@pytest.fixture
def ssh_config(tmp_path):
    return dict(capabilities=["cpu"], ssh_command=["bash", "-c"], workdir=str(tmp_path / "remote"))


async def _run(ex, pid="merge-ranges", statuses=None, **kw):
    p = ProblemStore().get(pid)

    async def on_status(phase, detail):
        if statuses is not None:
            statuses.append((phase, detail))

    return await Orchestrator(executors=_Manager(ex)).run(RunRequest(problem=p, **kw),
                                                          on_status=on_status)


async def test_ssh_executor_runs_bundle_remotely(ssh_config, tmp_path):
    ex = SshExecutor(ExecutorConfig(id="fake-ssh", kind="ssh", **ssh_config))
    r = await _run(ex, mode="reference")
    assert r.status == "passed", (r.error, r.stderr)
    assert r.executor == "fake-ssh"
    envs = list((tmp_path / "remote" / "envs").iterdir())
    assert envs and (envs[0] / ".ready").exists()          # provisioned on the "remote"
    assert not any((tmp_path / "remote" / "runs").iterdir())  # run dir cleaned up


async def test_ssh_executor_reports_user_failures(ssh_config):
    ex = SshExecutor(ExecutorConfig(id="fake-ssh", kind="ssh", **ssh_config))
    r = await _run(ex)
    assert r.status == "failed" and r.passed == 0


async def test_slurm_executor_wraps_in_srun(ssh_config, tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "srun.log"
    srun = bin_dir / "srun"
    # fake srun: record args, print the queue message, run the trailing `bash -c <script>`
    srun.write_text(f"""#!/bin/bash
echo "$@" > {log}
echo "srun: job 42 queued and waiting for resources" >&2
echo "srun: job 42 has been allocated resources" >&2
while [ "$1" != "bash" ]; do shift; done
exec "$@"
""")
    srun.chmod(srun.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    ex = SlurmExecutor(ExecutorConfig(id="fake-slurm", kind="slurm",
                                      srun_args=["--partition=gpu", "--gres=gpu:1"], **ssh_config))
    statuses = []
    r = await _run(ex, mode="reference", statuses=statuses)
    assert r.status == "passed", (r.error, r.stderr)
    assert "queued and waiting" in r.stderr
    phases = [p for p, _ in statuses]
    assert phases == ["preparing", "queued", "running"], statuses
    assert statuses[1][1] == "fake-slurm (SLURM job 42)"
    args = log.read_text()
    assert "--job-name=lc-" in args and "--partition=gpu" in args and "--gres=gpu:1" in args


def test_ssh_executor_requires_host():
    with pytest.raises(ValueError):
        SshExecutor(ExecutorConfig(id="x", kind="ssh"))


def test_tilde_paths_become_home():
    ex = SshExecutor(ExecutorConfig(id="x", kind="ssh", host="h", workdir="~/.leetclaude/",
                                    uv="~/.local/bin/uv"))
    assert ex._base() == "$HOME/.leetclaude"  # until resolved to an absolute path on first use
    assert ex.uv == "$HOME/.local/bin/uv"
