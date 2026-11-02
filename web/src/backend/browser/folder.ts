// Folder sync through the File System Access API (Chromium): save everything to a folder in the
// repo layout, or load problems and work from one. Point it at a leetclaude checkout and the
// local server and the browser edition see the same problems/ and workspace/.

import type { Db } from "./db.ts";
import type { ZipEntry } from "./zip.ts";

// Minimal typings: lib.dom does not cover the picker or async directory iteration everywhere.
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BufferSource | Blob | string): Promise<void>; close(): Promise<void> }>;
}
interface DirHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  values(): AsyncIterable<FileHandle | DirHandle>;
  queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}
type Picker = (opts: { id?: string; mode?: "read" | "readwrite" }) => Promise<DirHandle>;

const ROOTS = ["problems", "workspace"];
const SKIP = new Set(["__pycache__", "node_modules", ".git", ".pytest_cache"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const folderSupported = () => typeof (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker === "function";

/** The remembered folder (permission re-requested), or a newly picked one. */
async function folder(db: Db, mode: "read" | "readwrite", pickNew: boolean): Promise<DirHandle> {
  const saved = pickNew ? undefined : await db.get<DirHandle>("meta", "folder_handle");
  if (saved) {
    const state = (await saved.queryPermission({ mode })) === "granted" ? "granted" : await saved.requestPermission({ mode });
    if (state === "granted") return saved;
  }
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  const dir = await picker({ id: "leetclaude", mode });
  await db.put("meta", dir, "folder_handle");
  return dir;
}

export async function folderName(db: Db): Promise<string | null> {
  return (await db.get<DirHandle>("meta", "folder_handle"))?.name ?? null;
}

export async function saveToFolder(db: Db, entries: ZipEntry[], pickNew = false): Promise<{ folder: string; written: number }> {
  const root = await folder(db, "readwrite", pickNew);
  let written = 0;
  for (const e of entries) {
    const parts = e.path.split("/");
    if (!ROOTS.includes(parts[0]) || parts.some((p) => !p || p === "." || p === "..")) continue;
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const existing = await file.getFile();
    if (existing.size === e.data.length && sameBytes(new Uint8Array(await existing.arrayBuffer()), e.data)) continue;
    const w = await file.createWritable();
    await w.write(e.data as BufferSource);
    await w.close();
    written++;
  }
  return { folder: root.name, written };
}

export async function readFolder(db: Db, pickNew = false): Promise<{ folder: string; entries: ZipEntry[] }> {
  const root = await folder(db, "read", pickNew);
  const entries: ZipEntry[] = [];
  const walk = async (dir: DirHandle, prefix: string) => {
    for await (const h of dir.values()) {
      if (SKIP.has(h.name)) continue;
      if (h.kind === "directory") await walk(h, `${prefix}${h.name}/`);
      else {
        const f = await h.getFile();
        if (f.size <= MAX_FILE_BYTES) entries.push({ path: `${prefix}${h.name}`, data: new Uint8Array(await f.arrayBuffer()) });
      }
    }
  };
  for await (const h of root.values()) {
    if (h.kind === "directory" && ROOTS.includes(h.name)) await walk(h, `${h.name}/`);
  }
  return { folder: root.name, entries };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
