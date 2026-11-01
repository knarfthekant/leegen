# Executors: where code runs

An executor runs a job bundle and returns result events. A problem can run on every executor
whose **capabilities** cover the problem's and environment's `requires`:

| requires | satisfied by |
|---|---|
| `cpu` | any executor with `cpu` |
| `gpu` | `cuda` or `mps` |
| `cuda` | `cuda` only |

The toolbar lists only compatible executors. Validation and `leetclaude run` use the first
compatible one, unless `--executor <id>` is given.

## Configuration

`~/.config/leetclaude/executors.yaml` (override the location with `LEETCLAUDE_EXECUTORS`):

```yaml
executors:
  - id: devbox                         # plain SSH host
    kind: ssh
    host: me@devbox.example.com        # or an alias from ~/.ssh/config
    workdir: ~/.leetclaude             # scratch dir on the remote: envs/ and runs/
    capabilities: [cpu, cuda]

  - id: cluster                        # SLURM through a login node
    kind: slurm
    host: me@login.cluster.example.edu
    ssh_options: [-i, ~/.ssh/id_ed25519, -o, IdentitiesOnly=yes]
    workdir: ~/.leetclaude
    uv: ~/.local/bin/uv                # uv on the compute nodes
    srun_args: [--partition=GPU, --gres=gpu:1, --time=00:15:00, --cpus-per-task=4, --mem=16G]
    setup: "module load gcc"           # optional shell lines run before every job
    max_queue_s: 600                   # how long a run may wait in the queue
    capabilities: [cpu, cuda]
```

The `local` executor (this machine) always exists and detects its own capabilities: `cpu`,
`mps` on Apple silicon, and `cuda` when `nvidia-smi` is present. Define an entry with
`id: local` to override it.

## How the kinds work

**local** runs the job as a subprocess in a uv venv cached at
`~/.cache/leetclaude/envs/<env>-<hash>`. It applies wall-clock and CPU-time limits, uses its own
process group, and cancel kills that group.

**ssh**
1. Uploads the bundle (tar over ssh) to `<workdir>/runs/<run-id>`.
2. Builds the environment's venv under `<workdir>/envs/` the first time it's used (with `uv` on
   the remote).
3. Runs the build and test commands under `timeout`.
4. Fetches the results and deletes the run directory.

It uses the system `ssh` with `BatchMode=yes` and a ControlMaster socket, so repeated runs reuse
one connection. Authentication is whatever `ssh <host>` does; leetclaude never stores
credentials.

**slurm** is the same, except the job script runs as `srun --job-name=lc-<run-id> <srun_args>
bash -c ...` on the login node. Environment provisioning happens **inside the job** on the
compute node (`provision_on_node`, on by default for SLURM). That matters on clusters where
home directories are `noexec` on login nodes, or where compute nodes have a different software
stack. Cancel calls `scancel --name=lc-<run-id>`. srun's "queued and waiting for resources"
lines appear in the run's stderr.

## CUDA without a system toolkit

The `cuda` environment installs `nvcc` and the CUDA runtime from NVIDIA's PyPI wheels
(`nvidia-cuda-nvcc`) into the environment's venv, and puts `.../nvidia/cu13/bin` on `PATH`.
A machine only needs an NVIDIA driver and a host C++ compiler. The environment also sets
`NVCC_APPEND_FLAGS=-arch=native`, so kernels compile to native code for the GPU on the build
node. That avoids the "PTX was compiled with an unsupported toolchain" error when the wheel's
toolkit is a minor version newer than the driver.

## Remote host requirements

- `bash`, `tar` and coreutils `timeout` (standard on Linux)
- `uv` on the machine that provisions environments: the remote for `ssh`, the compute nodes
  for `slurm`. Install it with `curl -LsSf https://astral.sh/uv/install.sh | sh`; set `uv:` if
  it isn't on the non-interactive `PATH`.
- Outbound HTTPS to PyPI on first use of each environment (or a reachable mirror set with
  `LEETCLAUDE_PACKAGE_INDEX`).

## Per-cluster setup notes

Every cluster is different: filesystems, `noexec` mounts, modules, drivers, partitions,
network access. Environments are therefore resolved fresh on each cluster from the unpinned
specs in `environments/`, rather than shipped as pinned lockfiles or prebuilt venvs.

When adding a cluster, an agent probes it, writes the executor entry, and records what it found
in `docs/clusters/<name>.md`. [`docs/clusters/watgpu.md`](clusters/watgpu.md) is the worked
example and contains the onboarding checklist.

## Adding an executor kind

Subclass `leetclaude.executors.base.Executor` and implement:
- `capabilities()`
- `prepare(env, extra_deps)`: returns template values such as `{python}`, `{venv}` and
  `{site_packages}`
- `run(job, values)`: returns an `ExecOutcome` with the raw results JSONL
- optionally `cancel(run_id)`

Register it with `@register("executor", "<kind>")` and import the module in
`executors/__init__.py`. Any extra YAML fields are available as `config.model_extra`.
