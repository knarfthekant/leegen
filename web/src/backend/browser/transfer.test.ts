/// <reference types="node" />
// Zip and folder plumbing for export/import (repo layout), with an in-memory directory handle.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFolder, saveToFolder } from "./folder.ts";
import { crc32, readZip, writeZip } from "./zip.ts";
import type { Db } from "./db.ts";

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

// ------------------------------------------------------------------ in-memory folder

type Node = Map<string, Node | Uint8Array>;

function dirHandle(name: string, node: Node): any {
  return {
    kind: "directory",
    name,
    async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
      if (!node.has(n)) {
        if (!opts?.create) throw new Error("NotFoundError");
        node.set(n, new Map());
      }
      return dirHandle(n, node.get(n) as Node);
    },
    async getFileHandle(n: string, opts?: { create?: boolean }) {
      if (!node.has(n)) {
        if (!opts?.create) throw new Error("NotFoundError");
        node.set(n, new Uint8Array());
      }
      return fileHandle(n, node);
    },
    async *values() {
      for (const [n, v] of node) yield v instanceof Map ? dirHandle(n, v) : fileHandle(n, node);
    },
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
  };
}

function fileHandle(name: string, parent: Node): any {
  return {
    kind: "file",
    name,
    getFile: async () => new Blob([parent.get(name) as BlobPart]),
    createWritable: async () => ({
      write: async (d: Uint8Array) => void parent.set(name, new Uint8Array(d)),
      close: async () => undefined,
    }),
  };
}

test("save to a folder, then read it back (only problems/ and workspace/)", async () => {
  const root: Node = new Map([["README.md", enc.encode("not ours")]]);
  const meta = new Map<string, unknown>([["folder_handle", dirHandle("checkout", root)]]);
  const db = { get: async (_s: string, k: string) => meta.get(k), put: async () => undefined } as unknown as Db;
  const entries = [
    { path: "problems/a.yaml", data: enc.encode("id: a\n") },
    { path: "workspace/a/solution.py", data: enc.encode("x = 1\n") },
    { path: "../escape.txt", data: enc.encode("no") },
  ];
  const first = await saveToFolder(db, entries);
  assert.deepEqual(first, { folder: "checkout", written: 2 });
  assert.equal((await saveToFolder(db, entries)).written, 0);   // unchanged files are not rewritten
  const { entries: back } = await readFolder(db);
  assert.deepEqual(back.map((e) => e.path).sort(), ["problems/a.yaml", "workspace/a/solution.py"]);
});
