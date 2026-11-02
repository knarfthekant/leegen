import type { Backend } from "../types";

// Placeholder until the browser edition lands (Phase 3).
export async function createBrowserBackend(): Promise<Backend> {
  throw new Error("the browser edition is not built yet");
}
