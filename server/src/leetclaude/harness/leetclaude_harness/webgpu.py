"""WebGPU from Python, for the browser edition's `webgpu` problems (Pyodide only).

A problem's hidden host module (e.g. `_host.py`) reads the user's WGSL kernel, dispatches it with
this helper and returns plain Python values, which the `function` judge compares as usual:

    from leetclaude_harness import webgpu as wg

    def vector_add(a, b):
        out = wg.dispatch(wg.source("kernel.wgsl", __file__),
                          [wg.storage(wg.f32(a)), wg.storage(wg.f32(b)),
                           wg.storage(size=4 * len(a), read_only=False)],
                          workgroups=(wg.groups(len(a), 64),))
        return wg.to_f32(out[2])

Bindings are numbered in order (`@group(0) @binding(i)`). `dispatch` returns the contents of every
writable storage buffer after the kernel ran (read-only bindings give None). WGSL compile errors
raise `WGSLError` with file:line:column messages. With `timed=True`, when the adapter supports
`timestamp-query`, the GPU time of the compute pass is in `last_gpu_ms` (browsers round
timestamps to roughly 0.1 ms, so time large inputs).

GPU work that never finishes (an endless loop in a kernel) is stopped by the runner's wall-clock
deadline, like any other runaway code.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

last_gpu_ms: float | None = None
_device: Any = None
_timestamps = False


class WebGPUUnavailable(RuntimeError):
    pass


class WGSLError(Exception):
    """The kernel did not compile or validate. The message points at the WGSL source."""


# ------------------------------------------------------------------ data helpers


def f32(values: Any) -> bytes:
    vals = list(values)
    return struct.pack(f"<{len(vals)}f", *vals)


def i32(values: Any) -> bytes:
    vals = list(values)
    return struct.pack(f"<{len(vals)}i", *vals)


def u32(values: Any) -> bytes:
    vals = list(values)
    return struct.pack(f"<{len(vals)}I", *vals)


def to_f32(data: bytes, count: int | None = None) -> list[float]:
    n = len(data) // 4 if count is None else count
    return list(struct.unpack_from(f"<{n}f", data))


def to_i32(data: bytes, count: int | None = None) -> list[int]:
    n = len(data) // 4 if count is None else count
    return list(struct.unpack_from(f"<{n}i", data))


def to_u32(data: bytes, count: int | None = None) -> list[int]:
    n = len(data) // 4 if count is None else count
    return list(struct.unpack_from(f"<{n}I", data))


def groups(n: int, size: int) -> int:
    """Workgroups needed to cover `n` items with `size` invocations each."""
    return max(1, math.ceil(n / size))


def source(name: str, near: str) -> str:
    """Read a kernel file that sits next to the calling module (pass `__file__`)."""
    return (Path(near).resolve().parent / name).read_text()


# ------------------------------------------------------------------ bindings


@dataclass
class Binding:
    kind: str                    # "storage" | "uniform"
    data: bytes | None
    size: int
    read_only: bool


def storage(data: bytes | None = None, *, size: int | None = None,
            read_only: bool | None = None) -> Binding:
    """A storage buffer. Initial `data`, or zeros of `size` bytes. Buffers created from data are
    read-only unless `read_only=False`; buffers created by size are writable."""
    if data is None and size is None:
        raise ValueError("storage() needs data or size")
    nbytes = len(data) if data is not None else int(size)  # type: ignore[arg-type]
    ro = (data is not None) if read_only is None else read_only
    return Binding("storage", data, nbytes, ro)


def uniform(data: bytes) -> Binding:
    return Binding("uniform", data, len(data), True)


# ------------------------------------------------------------------ the device


def _js():
    try:
        import js  # type: ignore[import-not-found]
        from pyodide.ffi import run_sync, to_js  # type: ignore[import-not-found]
    except ImportError:
        raise WebGPUUnavailable("WebGPU problems run only in the browser edition") from None
    return js, run_sync, to_js


def _missing(value: Any) -> bool:
    """JS null/undefined: Pyodide gives None for undefined but a JsNull object for null."""
    return value is None or type(value).__name__ == "JsNull"


def _obj(value: Any) -> Any:
    js, _, to_js = _js()
    return to_js(value, dict_converter=js.Object.fromEntries)


def device() -> Any:
    """The shared GPUDevice (created on first use)."""
    global _device, _timestamps
    if _device is not None:
        return _device
    js, run_sync, _ = _js()
    gpu = getattr(js.navigator, "gpu", None)
    if _missing(gpu):
        raise WebGPUUnavailable("this browser has no WebGPU (navigator.gpu is missing)")
    adapter = run_sync(gpu.requestAdapter())
    if _missing(adapter):
        raise WebGPUUnavailable("no WebGPU adapter is available")
    _timestamps = bool(adapter.features.has("timestamp-query"))
    features = ["timestamp-query"] if _timestamps else []
    _device = run_sync(adapter.requestDevice(_obj({"requiredFeatures": features})))
    return _device


def _round4(n: int) -> int:
    return max(4, (n + 3) // 4 * 4)


def _layout(dev: Any, bindings: list[Binding]) -> Any:
    """An explicit layout from the bindings, so a kernel that doesn't use a binding (yet) still
    accepts it, and a wrong access mode in the WGSL is reported as such."""
    js, _, _ = _js()
    kinds = {"uniform": "uniform"}
    entries = [{"binding": i, "visibility": js.GPUShaderStage.COMPUTE,
                "buffer": {"type": kinds.get(b.kind) or
                           ("read-only-storage" if b.read_only else "storage")}}
               for i, b in enumerate(bindings)]
    return dev.createBindGroupLayout(_obj({"entries": entries}))


def _compile(dev: Any, wgsl: str, entry: str, filename: str, layout: Any) -> Any:
    js, run_sync, _ = _js()
    dev.pushErrorScope("validation")
    module = dev.createShaderModule(_obj({"code": wgsl}))
    info = run_sync(module.getCompilationInfo())
    errors = [m for m in info.messages if m.type == "error"]
    if errors:
        run_sync(dev.popErrorScope())
        lines = [f"{filename}:{m.lineNum}:{m.linePos}: {m.message}" for m in errors]
        raise WGSLError("\n".join(lines))
    pipeline = dev.createComputePipeline(_obj({
        "layout": dev.createPipelineLayout(_obj({"bindGroupLayouts": [layout]})),
        "compute": {"module": module, "entryPoint": entry}}))
    err = run_sync(dev.popErrorScope())
    if not _missing(err):
        raise WGSLError(f"{filename}: {err.message}")
    return pipeline


def dispatch(wgsl: str, bindings: list[Binding], workgroups: tuple[int, ...],
             entry: str = "main", timed: bool = False,
             filename: str = "kernel.wgsl") -> list[bytes | None]:
    """Compile `wgsl`, bind `bindings` to @group(0), dispatch `workgroups` (x[, y[, z]]) and
    read back every writable storage buffer."""
    global last_gpu_ms
    js, run_sync, to_js = _js()
    dev = device()
    usage = js.GPUBufferUsage
    layout = _layout(dev, bindings)
    pipeline = _compile(dev, wgsl, entry, filename, layout)

    buffers = []
    for b in bindings:
        flags = (usage.STORAGE if b.kind == "storage" else usage.UNIFORM) | usage.COPY_DST
        if b.kind == "storage" and not b.read_only:
            flags |= usage.COPY_SRC
        size = _round4(b.size)
        buf = dev.createBuffer(_obj({"size": size, "usage": flags}))
        if b.data:
            padded = b.data + bytes(size - len(b.data))
            dev.queue.writeBuffer(buf, 0, to_js(memoryview(padded)))
        buffers.append(buf)

    dev.pushErrorScope("validation")
    group = dev.createBindGroup(_obj({
        "layout": layout,
        "entries": [{"binding": i, "resource": {"buffer": buf}} for i, buf in enumerate(buffers)],
    }))
    encoder = dev.createCommandEncoder()
    pass_desc: dict[str, Any] = {}
    query = resolve = None
    if timed and _timestamps:
        query = dev.createQuerySet(_obj({"type": "timestamp", "count": 2}))
        resolve = dev.createBuffer(_obj({"size": 16, "usage": usage.QUERY_RESOLVE | usage.COPY_SRC}))
        pass_desc["timestampWrites"] = {"querySet": query, "beginningOfPassWriteIndex": 0,
                                        "endOfPassWriteIndex": 1}
    cpass = encoder.beginComputePass(_obj(pass_desc))
    cpass.setPipeline(pipeline)
    cpass.setBindGroup(0, group)
    x, y, z = (tuple(workgroups) + (1, 1))[:3]
    cpass.dispatchWorkgroups(x, y, z)
    cpass.end()

    staging: list[tuple[int, Any, int]] = []
    for i, (b, buf) in enumerate(zip(bindings, buffers)):
        if b.kind == "storage" and not b.read_only:
            size = _round4(b.size)
            st = dev.createBuffer(_obj({"size": size, "usage": usage.MAP_READ | usage.COPY_DST}))
            encoder.copyBufferToBuffer(buf, 0, st, 0, size)
            staging.append((i, st, b.size))
    stamp = None
    if query is not None:
        encoder.resolveQuerySet(query, 0, 2, resolve, 0)
        stamp = dev.createBuffer(_obj({"size": 16, "usage": usage.MAP_READ | usage.COPY_DST}))
        encoder.copyBufferToBuffer(resolve, 0, stamp, 0, 16)
    dev.queue.submit(to_js([encoder.finish()]))
    err = run_sync(dev.popErrorScope())
    if not _missing(err):
        raise WGSLError(f"{filename}: {err.message}")

    out: list[bytes | None] = [None] * len(bindings)
    for i, st, nbytes in staging:
        run_sync(st.mapAsync(js.GPUMapMode.READ))
        out[i] = js.Uint8Array.new(st.getMappedRange()).to_bytes()[:nbytes]
        st.unmap()
        st.destroy()
    last_gpu_ms = None
    if stamp is not None:
        run_sync(stamp.mapAsync(js.GPUMapMode.READ))
        begin, end = struct.unpack("<QQ", js.Uint8Array.new(stamp.getMappedRange()).to_bytes())
        stamp.unmap()
        stamp.destroy()
        last_gpu_ms = (end - begin) / 1e6 if end >= begin else None
    for buf in buffers:
        buf.destroy()
    return out
