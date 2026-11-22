/// <reference types="node" />
// Zip plumbing and path normalisation for export/import (data layout).

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalise } from "./transfer.ts";
import { crc32, readZip, writeZip } from "./zip.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("zip round trip keeps paths and bytes", async () => {
  const entries = [
    { path: "problems/a.yaml", data: enc.encode("id: a\n") },
    { path: "workspace/a/solution.py", data: enc.encode("print('é')\n") },
    { path: "workspace/a/.leegen/hints.json", data: enc.encode('{"revealed": 1}') },
  ];
  const back = await readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => [e.path, dec.decode(e.data)]), entries.map((e) => [e.path, dec.decode(e.data)]));
});

test("deflated entries from other zip tools are read", async () => {
  // a one-file zip with a deflated entry, as written by `zip`/Finder
  const data = enc.encode("hello hello hello hello\n");
  const deflated = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const stored = writeZip([{ path: "problems/x.yaml", data: deflated }]);
  const bytes = new Uint8Array(await stored.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const patch = (off: number) => {
    view.setUint16(off, 8, true);                       // method: deflate
  };
  patch(8);                                             // local header
  const cd = bytes.length - 22 - (46 + "problems/x.yaml".length);
  patch(cd + 10);                                       // central directory
  view.setUint32(14, crc32(data), true);
  view.setUint32(cd + 16, crc32(data), true);
  const [entry] = await readZip(new Blob([bytes]));
  assert.equal(dec.decode(entry.data), dec.decode(data));
});

test("import finds the data root in a data folder, a checkout, or a bare export", () => {
  const file = (path: string) => ({ path, data: enc.encode("x") });
  const wanted = ["problems/a.yaml", "tutorials/t.yaml", "workspace/a/solution.py", "workspace/tut-t/cells/one.py"];
  for (const prefix of ["", "data/", "leegen/data/", "leegen-main/data/"]) {
    const out = normalise([...wanted.map((p) => file(prefix + p)), file("leegen/README.md")]);
    assert.deepEqual(out.map((e) => e.path).filter((p) => /^(problems|tutorials|workspace)\//.test(p)).sort(), wanted, prefix);
  }
});
