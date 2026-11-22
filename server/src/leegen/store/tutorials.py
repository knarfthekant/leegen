"""Tutorial bank: YAML files in tutorials/. One file per tutorial, `<id>.yaml`."""

from __future__ import annotations

import threading
from pathlib import Path

from leegen.config import settings
from leegen.core.parse import format_error
from leegen.core.tutorial import Tutorial, parse_tutorial_yaml
from leegen.store.problems import LoadError

__all__ = ["TutorialStore"]


class TutorialStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.dir = directory or settings().tutorials_dir
        self._lock = threading.Lock()
        self._cache: dict[Path, tuple[float, Tutorial | LoadError]] = {}

    def _scan(self) -> list[Tutorial | LoadError]:
        out: list[Tutorial | LoadError] = []
        seen: set[Path] = set()
        with self._lock:
            for path in sorted(self.dir.glob("*.yaml")):
                seen.add(path)
                mtime = path.stat().st_mtime
                cached = self._cache.get(path)
                if cached and cached[0] == mtime:
                    out.append(cached[1])
                    continue
                try:
                    item: Tutorial | LoadError = parse_tutorial_yaml(path.read_text())
                    if item.id != path.stem:
                        item = LoadError(str(path), f"id {item.id!r} does not match file name")
                except Exception as exc:  # noqa: BLE001 - surfaced to agents
                    item = LoadError(str(path), format_error(exc))
                self._cache[path] = (mtime, item)
                out.append(item)
            for stale in set(self._cache) - seen:
                del self._cache[stale]
        return out

    def list(self) -> list[Tutorial]:
        items = [t for t in self._scan() if isinstance(t, Tutorial)]
        return sorted(items, key=lambda t: (t.track or "~", t.order if t.order is not None else 9999,
                                            t.title.lower()))

    def errors(self) -> list[LoadError]:
        return [t for t in self._scan() if isinstance(t, LoadError)]

    def get(self, tutorial_id: str) -> Tutorial | None:
        return next((t for t in self.list() if t.id == tutorial_id), None)

    # ---------------------------------------------------------------- agent edits

    def path_for(self, tutorial_id: str) -> Path:
        return self.dir / f"{tutorial_id}.yaml"

    def read_yaml(self, tutorial_id: str) -> str | None:
        path = self.path_for(tutorial_id)
        return path.read_text() if path.is_file() else None

    def save_yaml(self, tutorial_id: str, text: str) -> Path:
        """Write the author's YAML as given: comments and block scalars survive."""
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.path_for(tutorial_id)
        tmp = path.with_suffix(".yaml.tmp")
        tmp.write_text(text if text.endswith("\n") else text + "\n")
        tmp.replace(path)
        return path

    def delete(self, tutorial_id: str) -> bool:
        path = self.path_for(tutorial_id)
        if path.exists():
            path.unlink()
            return True
        return False
