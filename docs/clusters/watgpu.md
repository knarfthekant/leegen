# Cluster setup: watgpu (UWaterloo CS)

How the `watgpu` executor was set up, written down so a coding agent can repeat or repair it,
and use it as a worked example when setting up a different cluster. Every cluster differs, so
**probe, don't copy**. The procedure for a new cluster is in
[Onboarding a new cluster](#onboarding-a-new-cluster).

Last verified: 2026-11-01. All six seed problems validate. `cuda-vector-add` and
`triton-vector-add` ran here, and `kv-cache-basics` passed 5/5 on CUDA.

## Executor entry

`~/.config/leetclaude/executors.yaml` on the user's machine:

```yaml
executors:
  - id: watgpu
    kind: slurm
    description: UWaterloo watgpu, VZHNG partition (1 GPU per run)
    host: g3shan@watgpu.cs.uwaterloo.ca
    ssh_options: [-i, ~/.ssh/id_ed25519, -o, IdentitiesOnly=yes, -o, IdentityAgent=none]
    workdir: ~/.leetclaude
    uv: ~/.local/bin/uv
    srun_args: [--partition=VZHNG, --gres=gpu:1, --time=00:15:00, --cpus-per-task=4, --mem=16G]
    capabilities: [cpu, cuda]
```

- `ssh_options` pins one key and disables the SSH agent, so no other identity is ever offered.
  Use the key the user has cleared for this host. Never put key material or passwords in this
  file.
- `provision_on_node` is not set, so it takes the SLURM default (`true`). That is required
  here; see below.

## What the cluster looks like

| Probe | Result | Consequence |
|---|---|---|
| Login node `watgpu` | has `sinfo`, `srun`, `scancel`, `timeout`, `setsid`, `tar`; **no `nvcc`**, `uv` not on non-interactive `PATH` | jobs go through `srun`; `uv` needs an explicit path |
| Home `/u2/g3shan` | NFS, shared by login and compute nodes, **mounted `noexec` on the login node** | nothing in home can execute on the login node, so environments are built and run **inside the SLURM job** |
| Compute nodes (`VZHNG`) | home is executable; `uv` 0.11 at `~/.local/bin/uv` runs | `uv: ~/.local/bin/uv` works from inside jobs |
| `VZHNG` partition | nodes `watgpu[1101,1109,1208-1209,1308-1309]` and `watgpu508`, GRES `gpu:vzhnggpu`, 7-day limit | `--partition=VZHNG --gres=gpu:1` |
| GPU (seen on `watgpu1109`) | NVIDIA RTX PRO 6000 Blackwell Server Edition, 96 GB, compute capability 12.0 | needs a toolkit that knows sm_120 |
| Driver | 610.43.02, CUDA UMD **13.3** | toolkits newer than 13.3 can't JIT PTX on this driver |
| CUDA toolkit | none on any node, no `module` system | `nvcc` comes from PyPI wheels (below) |
| Scratch | no `/scratch`; `/tmp` is node-local (178 GB free) | the workdir lives in home (`~/.leetclaude`) so environments are shared by all nodes |

## How environments are built

All of this happens inside the `srun` job on the compute node (`provision_on_node`):

```
uv venv --no-config --python 3.12 ~/.leetclaude/envs/<env>-<hash>
uv pip install --no-config --python <venv>/bin/python --default-index https://pypi.org/simple <deps>
touch <venv>/.ready
```

- **One venv per environment**, keyed by a hash of the Python version and dependency list.
  Built on first use, then reused by every node through the shared home. Present right now:
  `cuda-…`, `pytorch-…`, `triton-…`. Build logs are in `~/.leetclaude/envs/<env>-<hash>.log`.
- **Base interpreter:** uv picked the node's system Python (`pyvenv.cfg`: `home = /usr/bin`,
  3.12.3). The venvs are tied to the compute-node OS image, which all `VZHNG` nodes share. If
  the image changes, delete `~/.leetclaude/envs/` and they rebuild.
- **Versions are deliberately not pinned.** Each cluster resolves the environment specs in
  `environments/*.yaml` against its own platform (driver, glibc, GPU). PyTorch resolved to a
  CUDA build from PyPI.
- **Concurrent first runs** are serialised with `flock` on `<venv>.lock`.
- **Run directories** `~/.leetclaude/runs/<run-id>` are uploaded (tar over ssh), used, and
  deleted after each run.

### CUDA specifics

- The `cuda` environment installs `nvidia-cuda-nvcc`, which pulls in `nvidia-nvvm`,
  `nvidia-cuda-runtime` and `nvidia-cuda-crt`; everything lands under
  `<venv>/lib/python3.12/site-packages/nvidia/cu13`. `PATH` and `CUDA_HOME` point there. The
  host compiler is the node's system `gcc`.
- The wheels resolved to CUDA **13.4**, newer than the driver's **13.3**. Without changes,
  kernels failed at launch with *"the provided PTX was compiled with an unsupported toolchain"*.
  The fix is in `environments/cuda.yaml`: `NVCC_APPEND_FLAGS=-arch=native`, which compiles SASS
  for the GPU on the build node (sm_120), so no PTX JIT happens. CUDA minor-version
  compatibility covers the runtime.

## Timings

| Situation | Time |
|---|---|
| First run of `pytorch` or `triton` environment (CUDA torch download and install) | ~5.5 min |
| First run of `cuda` environment | ~10 s |
| Cached environment, including queue wait (usually under 1 s when nodes are free) | 20–30 s |

## Maintenance

| Task | Command |
|---|---|
| Check the executor works | `uv run leetclaude run cuda-vector-add --reference --executor watgpu` (from `server/`) |
| Rebuild one environment | `ssh <host> 'rm -rf ~/.leetclaude/envs/<env>-<hash>*'` |
| Free space | `ssh <host> 'du -sh ~/.leetclaude/envs/*'`. PyTorch environments are several GB each |
| Stuck job | `ssh <host> 'squeue -u $USER; scancel --name=lc-<run-id>'` |

## Onboarding a new cluster

What an agent should do when the user asks to add a cluster. Each step is a probe; record the
findings in a new `docs/clusters/<name>.md` modelled on this file.

1. **Credentials.** Only use what the user has cleared for this host. Read `~/.ssh/config` and
   any notes next to the keys first, and pin one key in `ssh_options` (`-i …`,
   `IdentitiesOnly=yes`, `IdentityAgent=none`). Test with `ssh -o BatchMode=yes <host> hostname`.
2. **Login node.** Which of `sinfo`/`srun`/`scancel`/`timeout`/`setsid`/`tar`/`uv`/`nvcc` exist?
   What do `findmnt` options say for home and scratch (`noexec`?), and is there a `module`
   system?
3. **Partition and GPU.** `sinfo -o "%P %a %l %D %G %N"`; ask the user which partition and
   account to use. Then run a short job such as
   `srun -p <part> --gres=gpu:1 --time=00:03:00 bash -c 'hostname; nvidia-smi; findmnt …'` to
   see the GPU, the driver's CUDA version, and which filesystems can execute on compute nodes.
4. **Choose the layout.**
   - `workdir` must be executable on the nodes that run jobs and should be shared between
     nodes.
   - Use `provision_on_node: true` (the default) unless the login node can execute from
     `workdir` and has the same software stack.
   - Use `setup:` for `module load …` if the cluster has modules.
5. **uv.** If it's missing, ask before installing it into the user's account
   (`curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh`). Point `uv:` at
   it. Check the nodes can reach PyPI, or set `LEETCLAUDE_PACKAGE_INDEX` to a mirror.
6. **CUDA toolkit.** Use the cluster's own `nvcc` (via `module`/`setup:`) if one exists and
   matches the driver. Otherwise use the PyPI wheels. If the wheels are newer than the driver,
   keep `-arch=native` or constrain `nvidia-cuda-nvcc` to the driver's major.minor in a cluster
   copy of the environment.
7. **Verify.**
   - `leetclaude run cuda-vector-add --reference --executor <id>`
   - `leetclaude run kv-cache-basics --reference --executor <id>`
   - `leetclaude validate --all`

   Write down the timings and any errors with their fixes.
