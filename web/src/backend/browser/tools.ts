// WebMCP agent tools, registered on the top-level page from contracts/tools.json, so names,
// descriptions, input schemas and result shapes are the server's MCP tools exactly.
//
// Codex reads `document.modelContext` tools on the top-level page (not iframes), does not
// enforce inputSchema, and clears tools when the page navigates; this app routes with
// pushState only, and every `execute` validates its input here.

import { InvalidError, NotFoundError } from "./core.ts";
import type { BrowserToolService } from "./service.ts";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  default?: unknown;
  additionalProperties?: boolean | Schema;
};

export interface ManifestTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean; untrustedContentHint: boolean };
}

type Args = Record<string, any>;
type Handler = (svc: BrowserToolService, a: Args) => Promise<unknown> | unknown;

/** One handler per MCP tool, mirroring mcp_server/server.py. */
export const HANDLERS: Record<string, Handler> = {
  get_authoring_guide: (s) => s.authoringGuide(),
  get_tutoring_guide: (s) => s.tutoringGuide(),
  get_problem_schema: (s) => s.problemSchema(),
  list_environments: (s) => s.listEnvironments(),
  list_executors: (s) => s.listExecutors(),
  list_problems: (s, a) => s.listProblems(a.track),
  get_problem: (s, a) => s.getProblem(a.problem_id, a.include_hidden ?? true),
  validate_problem_yaml: async (s, a) => (await s.validateYaml(a.yaml)).report,
  create_problem: (s, a) => s.createProblem(a.yaml, a.overwrite ?? false),
  update_problem: (s, a) => s.updateProblem(a.problem_id, a.yaml),
  delete_problem: (s, a) => s.deleteProblem(a.problem_id, a.delete_user_code ?? false),
  get_session: (s) => s.getSession(),
  open_problem: (s, a) => s.openProblem(a.problem_id),
  run_tests: (s, a) => s.runTests(a.problem_id, a.full ?? false),
  annotate: async (s, a) => {
    const created = await s.annotate(a.annotations, a.problem_id, a.author ?? "assistant");
    return { created: created.map((c) => c.id) };
  },
  clear_annotations: async (s, a) => ({ removed: await s.clearAnnotations(a.problem_id, a.file) }),
  propose_edit: async (s, a) => {
    const p = await s.proposeEdit(a.file, {
      rationale: a.rationale,
      content: a.content,
      edits: a.edits,
      problemId: a.problem_id,
      author: a.author ?? "assistant",
      source: "webmcp",
    });
    return { proposal_id: p.id, status: "pending user review" };
  },
  add_test_case: (s, a) =>
    s.addTestCase(a.args, { kwargs: a.kwargs, name: a.name, description: a.description, section: a.section, problemId: a.problem_id }),
};

// ------------------------------------------------------------------ input validation

const typeOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

function matches(v: unknown, t: string) {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
}

/** A deliberately small JSON Schema check: what pydantic-generated tool schemas use. */
export function checkInput(value: unknown, schema: Schema, root: Schema = schema, path = "input"): string | null {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    const target = root.$defs?.[name];
    return target ? checkInput(value, target, root, path) : null;
  }
  if (schema.anyOf) {
    const errors = schema.anyOf.map((s) => checkInput(value, s, root, path));
    return errors.includes(null) ? null : errors[0];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t) => matches(value, t))) {
    return `${path} must be ${types.join(" or ")}, got ${typeOf(value)}`;
  }
  if (typeOf(value) === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (obj[key] === undefined) continue;
      const err = checkInput(obj[key], sub, root, `${path}.${key}`);
      if (err) return err;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = checkInput(value[i], schema.items, root, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

// ------------------------------------------------------------------ calling and registering

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const text = (v: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }],
  ...(isError ? { isError: true } : {}),
});

export async function callTool(svc: BrowserToolService, tool: ManifestTool, input: unknown): Promise<ToolResult> {
  const handler = HANDLERS[tool.name];
  if (!handler) return text(`tool ${tool.name} is not available in the browser edition`, true);
  let args: unknown = input ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);   // some clients pass the arguments as a JSON string
    } catch {
      return text("input must be a JSON object", true);
    }
  }
  const err = checkInput(args, tool.inputSchema);
  if (err) return text(err, true);
  try {
    return text(await handler(svc, args as Args));
  } catch (e) {
    const expected = e instanceof InvalidError || e instanceof NotFoundError;
    const msg = String((e as Error).message ?? e).replace(/^['"]|['"]$/g, "");
    return text(expected ? msg : `internal error: ${msg}`, true);
  }
}

interface ModelContext {
  registerTool(tool: {
    name: string;
    title?: string;
    description: string;
    inputSchema: unknown;
    annotations?: Record<string, boolean>;
    execute: (input: unknown) => Promise<unknown>;
  }): unknown;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
  // eslint-disable-next-line no-var
  var leegenTools: { list(): ManifestTool[]; call(name: string, input?: unknown): Promise<ToolResult> } | undefined;
}

const BROWSER_NOTE =
  " (leegen browser edition: problems and the user's work live in this browser; code runs in Pyodide.)";

/** Register every manifest tool with WebMCP. Returns how many were registered (0 when the page
 * has no modelContext). Tools are also reachable as `leegenTools.call(name, input)`. */
export async function registerAgentTools(svc: BrowserToolService, manifest: ManifestTool[]): Promise<number> {
  const tools = manifest.filter((t) => HANDLERS[t.name]);
  globalThis.leegenTools = {
    list: () => tools,
    call: (name, input) => {
      const tool = tools.find((t) => t.name === name);
      return tool ? callTool(svc, tool, input) : Promise.resolve(text(`no tool ${name}`, true));
    },
  };
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc?.registerTool) return 0;
  let n = 0;
  for (const tool of tools) {
    try {
      mc.registerTool({
        name: tool.name,
        title: tool.title,
        description: tool.name === "get_session" ? tool.description + BROWSER_NOTE : tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: (input) => callTool(svc, tool, input),
      });
      n++;
    } catch (e) {
      console.warn(`WebMCP: could not register ${tool.name}`, e);
    }
  }
  return n;
}
