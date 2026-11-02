// Client for the runner origin (web/runner/): a hidden cross-origin iframe reached over a
// MessageChannel. The runner is stateless; each request carries what it needs.

import type { RunnerRequest, RunResult } from "../../contracts/generated";

export interface RunnerHello {
  origin: string;
  crossOriginIsolated: boolean;
  webgpu: boolean;
  version: string;
  python: string | null;
}

export type RunnerNotice =
  | { type: "event"; run_id: string; line: string }
  | { type: "status"; run_id: string; phase: "loading" | "running"; detail: string };

export interface ParseResult {
  ok: boolean;
  stage?: string;
  errors?: string;
  problem?: import("./core.ts").FullProblem;
}

export type ValidationResult = Record<string, unknown> & { ok?: boolean; skipped?: boolean; stage?: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const CONNECT_TIMEOUT_MS = 20_000;

export class RunnerClient {
  readonly origin: string;
  private port: Promise<MessagePort> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private noticeListeners = new Set<(n: RunnerNotice) => void>();
  hello: RunnerHello | null = null;
  state: "idle" | "connecting" | "ready" | "failed" = "idle";
  error: string | null = null;
  onState: (() => void) | null = null;

  constructor(origin: string) {
    this.origin = new URL(origin).origin;
  }

  onNotice(fn: (n: RunnerNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  private setState(s: RunnerClient["state"], error: string | null = null) {
    this.state = s;
    this.error = error;
    this.onState?.();
  }

  /** Embed the runner (once) and open the channel. */
  connect(): Promise<MessagePort> {
    if (this.port) return this.port;
    this.setState("connecting");
    this.port = new Promise<MessagePort>((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.src = `${this.origin}/`;
      frame.title = "leetclaude runner";
      frame.allow = "cross-origin-isolated";
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`the runner at ${this.origin} did not answer`));
      }, CONNECT_TIMEOUT_MS);
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== this.origin || e.source !== frame.contentWindow) return;
        if (e.data?.type !== "lc-runner-loaded") return;
        cleanup();
        const channel = new MessageChannel();
        channel.port1.onmessage = (m) => this.onPortMessage(m.data);
        frame.contentWindow!.postMessage({ type: "lc-connect" }, this.origin, [channel.port2]);
        resolve(channel.port1);
      };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      };
      window.addEventListener("message", onMessage);
      document.body.appendChild(frame);
    });
    this.port.then(
      async () => {
        try {
          this.hello = (await this.call("hello")) as RunnerHello;
          this.setState("ready");
        } catch (e) {
          this.setState("failed", String((e as Error).message ?? e));
        }
      },
      (e) => {
        this.port = null;
        this.setState("failed", String(e.message ?? e));
      },
    );
    return this.port;
  }

  private onPortMessage(data: { id?: number; result?: unknown; error?: string; type?: string }) {
    if (data.type === "event" || data.type === "status") {
      for (const l of this.noticeListeners) l(data as RunnerNotice);
      return;
    }
    if (data.type === "ready" || data.id === undefined) return;
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.error !== undefined) p.reject(new Error(data.error));
    else p.resolve(data.result);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const port = await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      port.postMessage({ id, method, params });
    });
  }

  warm() {
    return this.call("warm");
  }

  run(request: RunnerRequest): Promise<RunResult> {
    return this.call("run", { request }) as Promise<RunResult>;
  }

  cancel(runId: string): Promise<{ cancelled: boolean }> {
    return this.call("cancel", { run_id: runId }) as Promise<{ cancelled: boolean }>;
  }

  parse(problemYaml: string): Promise<ParseResult> {
    return this.call("parse", { problem_yaml: problemYaml }) as Promise<ParseResult>;
  }

  validate(params: {
    problem_yaml: string;
    environments: unknown[];
    capabilities: string[];
    packages: string[];
    run_id?: string;
  }): Promise<ValidationResult> {
    return this.call("validate", params) as Promise<ValidationResult>;
  }
}
