// Shared WebGPU probe helpers (copied into both the app and runner origins at build time).

export const DOUBLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&data)) {
    data[id.x] = data[id.x] * 2.0;
  }
}`;

// Request an adapter + device and run a tiny compute kernel. Works in a page or a worker.
export async function runComputeProbe(n = 1 << 20) {
  const r = { available: "gpu" in navigator };
  if (!r.available) return r;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    r.adapter = !!adapter;
    if (!adapter) return r;
    const info = adapter.info || {};
    r.info = { vendor: info.vendor, architecture: info.architecture, description: info.description };
    r.timestampQuery = adapter.features.has("timestamp-query");
    r.maxWorkgroupStorage = adapter.limits.maxComputeWorkgroupStorageSize;
    const device = await adapter.requestDevice({
      requiredFeatures: r.timestampQuery ? ["timestamp-query"] : [],
    });

    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = i % 1000;
    const storage = device.createBuffer({
      size: input.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(storage, 0, input);
    const readback = device.createBuffer({
      size: input.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: DOUBLE_WGSL }), entryPoint: "main" },
    });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storage } }],
    });

    let querySet, queryBuf, queryRead;
    if (r.timestampQuery) {
      querySet = device.createQuerySet({ type: "timestamp", count: 2 });
      queryBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      queryRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }

    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass(querySet ? {
      timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    } : undefined);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(storage, 0, readback, 0, input.byteLength);
    if (querySet) {
      enc.resolveQuerySet(querySet, 0, 2, queryBuf, 0);
      enc.copyBufferToBuffer(queryBuf, 0, queryRead, 0, 16);
    }
    device.queue.submit([enc.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    r.roundTripMs = performance.now() - t0;
    const out = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    r.computeOk = out.every((v, i) => v === input[i] * 2);
    if (queryRead) {
      await queryRead.mapAsync(GPUMapMode.READ);
      const [a, b] = new BigUint64Array(queryRead.getMappedRange().slice(0));
      queryRead.unmap();
      r.gpuPassMs = Number(b - a) / 1e6;
    }
    device.destroy();
  } catch (e) {
    r.error = String(e?.message || e);
  }
  return r;
}

export function probeWebGPUInWorker(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(url, { type: "module" }); } catch (e) {
      resolve({ error: `worker: ${e?.message || e}` });
      return;
    }
    const timer = setTimeout(() => { w.terminate(); resolve({ error: "timed out" }); }, timeoutMs);
    w.onmessage = ({ data }) => { clearTimeout(timer); w.terminate(); resolve(data); };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: e.message || "worker error" }); };
    w.postMessage("go");
  });
}
