# Setting up a remote cluster backend

Use this guide when connecting leetclaude to a remote machine or Slurm cluster. It is intended
for both people and coding agents. Probe the target system before choosing paths, packages,
or scheduler options: login and compute nodes can have different software and mount settings.

Executor configuration lives on the computer running leetclaude, in
`~/.config/leetclaude/executors.yaml` (or the path set by `LEETCLAUDE_EXECUTORS`). See
[Executors](../executors.md) for how remote runs work.

## 1. Establish SSH access and the execution target

Use the user's existing SSH alias and the identity configured for that host. Check
`~/.ssh/config` and any local connection notes, then test non-interactive access:

```bash
ssh -o BatchMode=yes <host-alias> hostname
```

Choose `kind: ssh` for a host that directly runs jobs, or `kind: slurm` when jobs must run
through the scheduler. For Slurm, determine the permitted partition, account, GPU request,
and resource limits from existing configuration or the user before submitting a job.

## 2. Probe the host and compute nodes

On the remote host, inspect the available tools and filesystems:

```bash
command -v bash tar timeout setsid flock uv gcc nvcc
findmnt -T "$HOME" -no TARGET,OPTIONS
```

For Slurm, also check scheduler commands and available partitions:

```bash
command -v sinfo srun scancel
sinfo -o "%P %a %l %D %G %N"
```

Run a short GPU probe on the execution host. For Slurm, submit it through the permitted
partition; add an account or adjust the GPU request if the cluster requires it:

```bash
srun --partition=<partition> --gres=gpu:1 --time=00:03:00 \
  --cpus-per-task=1 --mem=1G \
  bash -c 'hostname; nvidia-smi; command -v uv gcc nvcc; findmnt -T "$HOME" -no TARGET,OPTIONS'
```

Record the GPU model, driver, available toolkit, compiler, and whether home or scratch is
executable on the nodes that will run jobs. Check for a module system if tools are missing
from `PATH`. A queued job confirms scheduler submission; verify actual GPU execution after
the job receives resources.

## 3. Choose storage and provision dependencies

The remote `workdir` contains cached environments under `envs/` and temporary bundles under
`runs/`. Choose a writable path that is executable on the execution nodes. Shared storage
lets multiple compute nodes reuse environments; node-local paths need separate provisioning.

For Slurm, keep `provision_on_node: true` (the default) when the login node has a `noexec`
home mount or differs from compute nodes. Environments will then be built inside each job
when needed. Use `setup:` for shell commands such as the cluster's required module loads.

Check that uv runs on the execution nodes. If it is absent, install it as part of the
authorized setup using the cluster's supported method, or the uv installer:

```bash
curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
```

Set `uv:` to its explicit path if non-interactive shells cannot find it. Check HTTPS access
to the package index from the nodes that provision environments. If the cluster uses a
mirror, set `LEETCLAUDE_PACKAGE_INDEX` in the local leetclaude server's environment.

Resolve the unpinned environment specifications in `environments/` on the target system.
Avoid reusing another cluster's prebuilt virtual environments or package pins. For CUDA,
inspect the target's compiler and driver before choosing a toolkit. The repo's CUDA
environment provisions NVIDIA's compiler wheels and uses `-arch=native`; see
[CUDA without a system toolkit](../executors.md#cuda-without-a-system-toolkit). Compile and
launch a real kernel to verify compatibility.

## 4. Configure the executor

Add an entry to the local executor configuration, preserving existing entries. Replace the
example values with findings from the probes:

```yaml
executors:
  - id: my-cluster
    kind: slurm
    description: My remote GPU cluster
    host: my-cluster-login             # existing SSH alias
    workdir: ~/.leetclaude             # must be executable on compute nodes
    uv: ~/.local/bin/uv
    provision_on_node: true
    srun_args:
      - --partition=<partition>
      - --gres=gpu:1
      - --time=00:15:00
      - --cpus-per-task=4
      - --mem=16G
    capabilities: [cpu, cuda]
```

If needed, set `setup: "module load <required-module>"` and add `--account=<account>` to
`srun_args`. For a direct SSH machine, use `kind: ssh` and omit the scheduler options.
Declare only capabilities supported by the host. Authentication uses SSH; keep credentials
out of this YAML. To select one identity explicitly, add `ssh_options` with `-i` and an
absolute key path, `-o IdentitiesOnly=yes`, and, if appropriate, `-o IdentityAgent=none`.

Restart the leetclaude server after changing executor configuration. Check `list_executors`
and `list_environments` through MCP, or the browser's executor selector, to confirm that the
backend is available for compatible problems.

## 5. Verify through leetclaude

From `server/`, test the complete upload, provisioning, build, and result path. For an NVIDIA
GPU backend, run the CUDA and PyTorch references:

```bash
uv run leetclaude run cuda-vector-add --reference --executor my-cluster
uv run leetclaude run kv-cache-basics --reference --executor my-cluster
uv run leetclaude run triton-vector-add --reference --executor my-cluster
```

Use a CPU exercise such as `merge-ranges` for a CPU-only host. To validate both reference
and starter behavior for an exercise on this backend:

```bash
uv run leetclaude validate <problem-id> --executor my-cluster
```

Confirm that test results report the intended executor and device. Distinguish queue delays
from provisioning, build, and runtime failures. First runs can take longer while dependencies
install; later runs reuse the cache.

## Keep machine-specific notes local

Record connection details, mount behavior, module requirements, driver/toolkit observations,
verified commands, timings, and any fixes in `docs/clusters/<name>.md`. These Markdown files
are gitignored; this shared `README.md` is the only tracked guide in this directory. Keep
host-specific executor configuration in the user's local configuration file.
