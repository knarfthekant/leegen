import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Backend, BackendEvent, BackendStatus } from "./types";

export type { Backend, BackendEvent, BackendStatus } from "./types";

let current: Backend | null = null;

/** Called once at startup (main.tsx) with the edition's backend. */
export function setBackend(backend: Backend) {
  current = backend;
}

export function getBackend(): Backend {
  if (!current) throw new Error("backend not initialised");
  return current;
}

/** Subscribe to backend push events for the lifetime of the component. */
export function useBackendEvents(handler: (e: BackendEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => getBackend().subscribe((e) => ref.current(e)), []);
}

export function useBackendStatus(): BackendStatus {
  const b = getBackend();
  return useSyncExternalStore(b.status.subscribe, b.status.get);
}

/** The event's problem id, for the events that carry one. */
export function eventProblemId(e: BackendEvent): string | undefined {
  return "problem_id" in e ? e.problem_id : undefined;
}
