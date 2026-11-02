"""Create and cache one uv venv per environment hash: <cache>/envs/<id>-<hash>/."""

from __future__ import annotations

import asyncio
import fcntl
import shutil
from collections.abc import Iterable
from pathlib import Path

from leegen.config import settings
from leegen.envs.registry import env_hash
from leegen.schema.models import Environment

_locks: dict[Path, asyncio.Lock] = {}


class ProvisionError(RuntimeError):
    pass


async def _run(cmd: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    text = out.decode(errors="replace")
    if proc.returncode != 0:
        raise ProvisionError(f"$ {' '.join(cmd)}\n{text}")
    return text


def local_env_dir(env: Environment, extra_deps: Iterable[str] = ()) -> Path:
    return settings().cache_dir / "envs" / f"{env.id}-{env_hash(env, extra_deps)}"


async def ensure_local_python(env: Environment, extra_deps: Iterable[str] = ()) -> Path:
    """Return the venv's python, creating the venv on first use."""
    extra = list(extra_deps)
    path = local_env_dir(env, extra)
    python = path / "bin" / "python"
    if (path / ".ready").exists():
        return python
    lock = _locks.setdefault(path, asyncio.Lock())
    async with lock:
        if (path / ".ready").exists():
            return python
        uv = shutil.which("uv")
        if uv is None:
            raise ProvisionError("uv is not installed; it is needed to build environments")
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path.parent / f".{path.name}.lock", "w") as lockfile:
            fcntl.flock(lockfile, fcntl.LOCK_EX)  # another server process may be provisioning
            try:
                if (path / ".ready").exists():
                    return python
                shutil.rmtree(path, ignore_errors=True)
                await _run([uv, "venv", "--no-config", "--python", env.python, str(path)])
                deps = sorted({*env.dependencies, *extra})
                if deps:
                    await _run([uv, "pip", "install", "--no-config", "--python", str(python),
                                "--default-index", settings().package_index, *deps])
                (path / ".ready").write_text("\n".join(deps))
            except BaseException:
                shutil.rmtree(path, ignore_errors=True)
                raise
            finally:
                fcntl.flock(lockfile, fcntl.LOCK_UN)
    return python
