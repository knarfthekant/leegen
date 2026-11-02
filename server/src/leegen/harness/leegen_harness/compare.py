"""Comparators used by the function judge. Each returns (ok, message)."""

from __future__ import annotations

import json
import math
from typing import Any, Callable

Result = tuple[bool, str | None]


def _norm(v: Any) -> Any:
    if isinstance(v, tuple):
        return [_norm(x) for x in v]
    if isinstance(v, list):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    return v


def _is_tensor(v: Any) -> bool:
    return type(v).__module__.startswith("torch") and hasattr(v, "shape")


def _is_ndarray(v: Any) -> bool:
    return type(v).__module__.startswith("numpy") and hasattr(v, "shape")


def exact(actual: Any, expected: Any, **_: Any) -> Result:
    if _is_tensor(actual) or _is_tensor(expected) or _is_ndarray(actual) or _is_ndarray(expected):
        return allclose(actual, expected, rtol=0.0, atol=0.0)
    return (_norm(actual) == _norm(expected), None)


def _float_eq(a: Any, e: Any, rtol: float, atol: float, path: str) -> Result:
    if isinstance(a, bool) or isinstance(e, bool):
        return (a == e, None if a == e else f"at {path or 'value'}: {a!r} != {e!r}")
    if isinstance(a, (int, float)) and isinstance(e, (int, float)):
        if math.isnan(a) and math.isnan(e):
            return (True, None)
        ok = math.isclose(a, e, rel_tol=rtol, abs_tol=atol)
        return (ok, None if ok else f"at {path or 'value'}: {a!r} vs expected {e!r}")
    if isinstance(a, (list, tuple)) and isinstance(e, (list, tuple)):
        if len(a) != len(e):
            return (False, f"at {path or 'value'}: length {len(a)} vs expected {len(e)}")
        for i, (x, y) in enumerate(zip(a, e)):
            ok, msg = _any_close(x, y, rtol, atol, f"{path}[{i}]")
            if not ok:
                return (ok, msg)
        return (True, None)
    if isinstance(a, dict) and isinstance(e, dict):
        if set(a) != set(e):
            return (False, f"at {path or 'value'}: keys {sorted(a)} vs expected {sorted(e)}")
        for k in e:
            ok, msg = _any_close(a[k], e[k], rtol, atol, f"{path}.{k}")
            if not ok:
                return (ok, msg)
        return (True, None)
    ok = _norm(a) == _norm(e)
    return (ok, None if ok else f"at {path or 'value'}: {a!r} != {e!r}")


def _any_close(a: Any, e: Any, rtol: float, atol: float, path: str) -> Result:
    if _is_tensor(a) or _is_tensor(e) or _is_ndarray(a) or _is_ndarray(e):
        ok, msg = allclose(a, e, rtol=rtol, atol=atol)
        return (ok, f"at {path}: {msg}" if msg and path else msg)
    return _float_eq(a, e, rtol, atol, path)


def float_cmp(actual: Any, expected: Any, rtol: float = 1e-6, atol: float = 1e-8, **_: Any) -> Result:
    return _any_close(actual, expected, rtol, atol, "")


def unordered(actual: Any, expected: Any, **_: Any) -> Result:
    if not isinstance(actual, (list, tuple)):
        return (False, f"expected a list, got {type(actual).__name__}")
    key = lambda x: json.dumps(_norm(x), sort_keys=True, default=repr)  # noqa: E731
    ok = sorted(map(key, actual)) == sorted(map(key, expected))
    return (ok, None if ok else "elements differ (order ignored)")


def allclose(actual: Any, expected: Any, rtol: float = 1e-5, atol: float = 1e-8, **_: Any) -> Result:
    if _is_tensor(actual) or _is_tensor(expected):
        import torch

        if not _is_tensor(actual):
            return (False, f"expected a tensor, got {type(actual).__name__}")
        a = actual.detach().to("cpu")
        e = expected.detach().to("cpu") if _is_tensor(expected) else torch.as_tensor(expected)
        if tuple(a.shape) != tuple(e.shape):
            return (False, f"shape {list(a.shape)} vs expected {list(e.shape)}")
        if a.dtype.is_floating_point or e.dtype.is_floating_point:
            a64, e64 = a.to(torch.float64), e.to(torch.float64)
            ok = bool(torch.allclose(a64, e64, rtol=rtol, atol=atol, equal_nan=True))
            if ok:
                return (True, None)
            diff = (a64 - e64).abs()
            idx = int(diff.flatten().nan_to_num(float("inf")).argmax())
            return (False, f"max abs diff {float(diff.flatten()[idx]):.3g} at flat index {idx} "
                           f"(rtol={rtol}, atol={atol})")
        ok = bool(torch.equal(a, e.to(a.dtype)))
        return (ok, None if ok else "integer/bool tensors differ")
    if _is_ndarray(actual) or _is_ndarray(expected):
        import numpy as np

        a, e = np.asarray(actual), np.asarray(expected)
        if a.shape != e.shape:
            return (False, f"shape {list(a.shape)} vs expected {list(e.shape)}")
        ok = bool(np.allclose(a, e, rtol=rtol, atol=atol, equal_nan=True))
        if ok:
            return (True, None)
        return (False, f"max abs diff {float(np.nanmax(np.abs(a - e))):.3g}")
    return _float_eq(actual, expected, rtol, atol, "")


BUILTIN: dict[str, Callable[..., Result]] = {
    "exact": exact,
    "float": float_cmp,
    "unordered": unordered,
    "allclose": allclose,
}


def run_custom(fn: Callable[..., Any], actual: Any, expected: Any, inputs: Any) -> Result:
    out = fn(actual, expected, inputs)
    if isinstance(out, tuple):
        return (bool(out[0]), str(out[1]) if len(out) > 1 and out[1] is not None else None)
    return (bool(out), None)
