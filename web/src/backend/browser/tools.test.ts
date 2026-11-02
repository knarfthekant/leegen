/// <reference types="node" />
// The WebMCP layer covers every tool in contracts/tools.json and checks inputs itself (Codex
// does not enforce inputSchema).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HANDLERS, checkInput, type ManifestTool } from "./tools.ts";

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
