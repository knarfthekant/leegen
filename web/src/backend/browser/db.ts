// IndexedDB, the browser edition's canonical store. It mirrors the repo layout:
//
//   problems   problems/<id>.yaml           {id, yaml, problem (parsed), source, seed_version}
//   assets     problems/<id>/assets/...     Blob, keyed "<id>/<path>"
//   workspace  workspace/<id>/              {id, files, state: {custom_tests, last_run, ...}}
//   meta       small key/value records (seed version, persistence asked, ...)

import type { FullProblem } from "./core.ts";

export interface ProblemRecord {
  id: string;
  yaml: string;
  problem: FullProblem;
  /** "seed": shipped with the app (replaced by newer builds); "user": created or imported. */
  source: "seed" | "user";
  seed_version?: string;
  /** Seeds: asset paths served from the app's data/assets/<id>/ (user problems keep theirs in
   * the assets store). */
  assets?: string[];
  updated_at: number;
}

export interface WorkspaceRecord {
  id: string;
  /** The user's editable files. Missing paths fall back to the starter code. */
  files: Record<string, string>;
  /** Same names as the server's workspace/<id>/.leetclaude/<name>.json. */
  state: Record<string, unknown>;
}

const DB_NAME = "leetclaude";
const DB_VERSION = 1;
type StoreName = "problems" | "assets" | "workspace" | "meta";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class Db {
  private constructor(private db: IDBDatabase) {
    db.onversionchange = () => db.close();   // another tab upgraded the schema
  }

  static open(name = DB_NAME): Promise<Db> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("problems")) db.createObjectStore("problems", { keyPath: "id" });
        if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets");
        if (!db.objectStoreNames.contains("workspace")) db.createObjectStore("workspace", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      r.onsuccess = () => resolve(new Db(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("the leetclaude database is blocked by another tab; close it and reload"));
    });
  }

  private store(name: StoreName, mode: IDBTransactionMode = "readonly") {
    return this.db.transaction(name, mode).objectStore(name);
  }

  get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return req(this.store(name).get(key));
  }

  all<T>(name: StoreName): Promise<T[]> {
    return req(this.store(name).getAll());
  }

  keys(name: StoreName): Promise<IDBValidKey[]> {
    return req(this.store(name).getAllKeys());
  }

  async put(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    await req(this.store(name, "readwrite").put(value, key));
  }

  async delete(name: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
    await req(this.store(name, "readwrite").delete(key));
  }

  /** Delete every key in `name` that starts with `prefix` (asset folders). */
  async deletePrefix(name: StoreName, prefix: string): Promise<void> {
    await this.delete(name, IDBKeyRange.bound(prefix, prefix + "￿"));
  }

  /** Read-modify-write one record atomically (one transaction). */
  update<T>(name: StoreName, key: IDBValidKey, fn: (old: T | undefined) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, "readwrite");
      const store = tx.objectStore(name);
      let next: T;
      const g = store.get(key);
      g.onsuccess = () => {
        try {
          next = fn(g.result as T | undefined);
        } catch (e) {
          tx.abort();
          reject(e);
          return;
        }
        if (store.keyPath) store.put(next);
        else store.put(next, key);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });
  }
}
