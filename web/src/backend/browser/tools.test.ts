/// <reference types="node" />
// The WebMCP layer covers every tool in contracts/tools.json and checks inputs itself (Codex
// does not enforce inputSchema).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HANDLERS, callTool, checkInput, type ManifestTool } from "./tools.ts";
import { BrowserToolService, type ServiceDeps } from "./service.ts";
import type { AgentStatus, BackendEvent } from "../../contracts/generated.ts";

const manifest: { tools: ManifestTool[] } = JSON.parse(
  readFileSync(new URL("../../../../contracts/tools.json", import.meta.url), "utf8"),
);
const tool = (name: string) => manifest.tools.find((t) => t.name === name)!;

test("every manifest tool has a browser handler, and nothing extra", () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), manifest.tools.map((t) => t.name).sort());
});

test("inputs are checked against the manifest schema", () => {
  const annotate = tool("annotate").inputSchema;
  assert.equal(checkInput({ annotations: [{ message: "m", start_line: 2, file: "a.py" }] }, annotate), null);
  assert.equal(checkInput({}, annotate), "input.annotations is required");
  assert.match(checkInput({ annotations: [{ message: "m", severity: "nitpick" }] }, annotate)!, /severity must be one of/);
  assert.match(checkInput({ annotations: [{ message: 3 }] }, annotate)!, /message must be string/);
  assert.equal(checkInput({ problem_id: null }, tool("run_tests").inputSchema), null);
  assert.match(checkInput({ yaml: 1 }, tool("create_problem").inputSchema)!, /yaml must be string/);
  assert.match(checkInput({ file: "a.py", rationale: "r", edits: [{ old: "x" }] }, tool("propose_edit").inputSchema)!, /new is required/);
});

test("agent status tool broadcasts, survives reload, expires, renews and clears without a problem", async () => {
  let now = 1000;
  const stored = new Map<string, AgentStatus>();
  const events: BackendEvent[] = [];
  const deps = {
    db: {
      get: async (_store: string, key: string) => stored.get(key),
      put: async (_store: string, value: AgentStatus, key: string) => { stored.set(key, value); },
    },
    hub: { broadcast: (event: BackendEvent) => events.push(event) },
    runner: {}, environments: [], guides: {}, schema: {},
    clock: { now: () => now, newId: () => "unused" },
  } as unknown as ServiceDeps;
  const service = new BrowserToolService(deps);
  const statusTool = tool("set_agent_status");
  assert.equal((await service.getAgentStatus()).status, "idle");
  for (const args of [{}, { status: "thinking" }, { status: null }]) {
    assert.equal((await callTool(service, statusTool, args)).isError, true);
  }
  assert.equal(events.length, 0);
  for (const activity of ["creating_problem", "reviewing"] as const) {
    const result = await callTool(service, statusTool, { status: activity });
    assert.equal(result.isError, undefined);
    const expected = { status: activity, updated_at: now, expires_at: now + 300 };
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.deepEqual(events.at(-1), { type: "agent_status_changed", agent_status: expected });
    assert.deepEqual(await new BrowserToolService(deps).getAgentStatus(), expected);
  }
  now = 1300;
  assert.equal((await service.getAgentStatus()).status, "idle");
  await callTool(service, statusTool, { status: "reviewing" });
  assert.equal((await service.getAgentStatus()).expires_at, 1600);
  await callTool(service, statusTool, { status: "idle" });
  assert.deepEqual(await service.getAgentStatus(), { status: "idle", updated_at: 1300, expires_at: null });
});
