"""Result events: one JSON object per line, appended to $LEETCLAUDE_RESULTS.

The path is read on every emit (a warm Pyodide interpreter runs many bundles), and an optional
sink also receives each event as it happens (the browser runner streams them to the UI).
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Callable
from typing import Any

MAX_TEXT = 4000
_SINK: Callable[[str], None] | None = None


def set_sink(sink: Callable[[str], None] | None) -> None:
    """Also hand every event line to `sink` (or stop, with None)."""
    global _SINK
    _SINK = sink


def emit(event: dict[str, Any]) -> None:
    line = json.dumps(event, default=str)
    with open(os.environ.get("LEETCLAUDE_RESULTS", "results.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    if _SINK is not None:
        _SINK(line)


def device() -> str:
    """Device chosen by the executor (LEETCLAUDE_DEVICE), else the best one torch can see."""
    forced = os.environ.get("LEETCLAUDE_DEVICE")
    if forced:
        return forced
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def truncate(text: str | None, limit: int = MAX_TEXT) -> str | None:
    if text is None or len(text) <= limit:
        return text
    return text[:limit] + f"\n... ({len(text) - limit} more characters)"


def _is_json_native(v: Any, depth: int = 0) -> bool:
    if depth > 20:
        return False
    if v is None or isinstance(v, (bool, int, str)):
        return True
    if isinstance(v, float):
        return math.isfinite(v)
    if isinstance(v, (list, tuple)):
        return all(_is_json_native(x, depth + 1) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and _is_json_native(x, depth + 1) for k, x in v.items())
    return False


def _tensor_repr(v: Any) -> str | None:
    mod = type(v).__module__
    if mod.startswith("torch") and hasattr(v, "shape") and hasattr(v, "dtype"):
        t = v.detach().to("cpu")
        flat = t.flatten()[:8].tolist()
        preview = ", ".join(f"{x:.4g}" if isinstance(x, float) else str(x) for x in flat)
        more = ", ..." if t.numel() > 8 else ""
        return (f"tensor(shape={list(t.shape)}, dtype={str(t.dtype).replace('torch.', '')}, "
                f"device={v.device}) [{preview}{more}]")
    if mod.startswith("numpy") and hasattr(v, "shape") and hasattr(v, "dtype"):
        flat = ", ".join(str(x) for x in v.reshape(-1)[:8].tolist())
        more = ", ..." if v.size > 8 else ""
        return f"ndarray(shape={list(v.shape)}, dtype={v.dtype}) [{flat}{more}]"
    return None


def describe(v: Any) -> Any:
    """JSON-safe display value. Non-JSON values become {"__repr__": "..."}."""
    if _is_json_native(v):
        text = json.dumps(v)
        if len(text) <= MAX_TEXT:
            return v
        return {"__repr__": truncate(text)}
    tr = _tensor_repr(v)
    if tr is not None:
        return {"__repr__": tr}
    if isinstance(v, (list, tuple)) and len(v) <= 50:
        return [describe(x) for x in v]
    if isinstance(v, dict) and len(v) <= 50:
        return {str(k): describe(x) for k, x in v.items()}
    try:
        text = repr(v)
    except Exception as exc:  # noqa: BLE001
        text = f"<unrepresentable {type(v).__name__}: {exc}>"
    return {"__repr__": truncate(text)}
