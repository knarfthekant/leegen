// Events: this tab's listeners plus every other tab of the app (BroadcastChannel), which is what
// the server's WebSocket hub does for the server edition. Same BackendEvent union.

import type { BackendEvent } from "../types";

export class EventHub {
  private listeners = new Set<(e: BackendEvent) => void>();
  private channel: BroadcastChannel | null =
    typeof BroadcastChannel === "function" ? new BroadcastChannel("leegen-events") : null;

  constructor() {
    if (this.channel) this.channel.onmessage = (m) => this.deliver(m.data as BackendEvent);
  }

  subscribe(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Deliver to this tab and to the other tabs. `navigate` stays in this tab: agents drive the
   * tab whose tools they called. */
  broadcast(event: BackendEvent) {
    this.deliver(event);
    if (event.type !== "navigate") this.channel?.postMessage(event);
  }

  private deliver(event: BackendEvent) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
