import { useEffect, useRef, useSyncExternalStore } from "react";

export type ServerEvent = { type: string; problem_id?: string; [key: string]: unknown };

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 0;
let connected = false;
const connectionListeners = new Set<() => void>();

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  connectionListeners.forEach((l) => l());
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/api/ws`);
  socket.onopen = () => {
    retry = 0;
    setConnected(true);
  };
  socket.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as ServerEvent;
      listeners.forEach((l) => l(event));
    } catch {
      /* ignore */
    }
  };
  socket.onclose = () => {
    socket = null;
    setConnected(false);
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 250 * 2 ** retry);
  };
}

/** Subscribe to server push events (runs, file changes, annotations, proposals). */
export function useServerEvents(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!socket) connect();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Whether the live event socket to the server is open. */
export function useConnection(): boolean {
  return useSyncExternalStore(
    (l) => {
      connectionListeners.add(l);
      if (!socket) connect();
      return () => connectionListeners.delete(l);
    },
    () => connected,
  );
}
