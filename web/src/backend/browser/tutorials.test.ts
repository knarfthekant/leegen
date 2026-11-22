/// <reference types="node" />
// BrowserTutorialService and zip transfer against an in-memory store and a fake runner.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Db } from "./db.ts";
import type { FullTutorial } from "./tutorial.ts";
import { BrowserTutorialService } from "./tutorials.ts";
import { collectEntries, importEntries, normalise } from "./transfer.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../../contracts/fixtures/tutorials.json", import.meta.url), "utf8")) as { tutorial: FullTutorial };
const YAML = "id: fixture-tutorial\n";
const SHIM = JSON.stringify({ id: "tut-fixture-tutorial", environment: "python", files: [] });
const enc = new TextEncoder();

/** The slice of Db the tutorial code uses, over Maps. */
function memoryDb(): Db {
  const stores = new Map<string, Map<string, unknown>>();
  const store = (n: string) => stores.get(n) ?? stores.set(n, new Map()).get(n)!;
  return {
    get: async (n: string, k: string) => store(n).get(k),
    all: async (n: string) => [...store(n).values()],
    keys: async (n: string) => [...store(n).keys()],
    put: async (n: string, v: { id?: string }, k?: string) => void store(n).set(k ?? v.id!, v),
    delete: async (n: string, k: string) => void store(n).delete(k),
    update: async (n: string, k: string, fn: (o: unknown) => unknown) => {
      const next = fn(store(n).get(k));
      store(n).set(k, next);
      return next;
    },
  } as unknown as Db;
}

function setup() {
  const db = memoryDb();
  const runs: Record<string, unknown>[] = [];
  let status: "ok" | "error" = "ok";
  let checkStatus: "pass" | "fail" = "pass";
  const session = { problem_id: null as string | null, buffers: {} as Record<string, string>, active_file: null as string | null,
    cursor: null as unknown, selection: null as unknown, updated_at: 0 };
  const service = {
    session,
    now: () => 100,
    environmentById: () => ({ id: "python", language: "python", requires: [], browser: { packages: [] } }),
    capabilities: async () => ["cpu"],
    tutorialGuide: () => "the guide",
    requestPersistence: () => undefined,
    cancel: async () => ({ cancelled: true }),
    runConsole: async (_p: unknown, opts: Record<string, unknown>) => {
      runs.push(opts);
      return { run_id: "r", problem_id: "tut-fixture-tutorial", status, executor: "browser", device: "cpu", file: null,
        started_at: 0, duration_ms: 1, stdout: "", stderr: "", result: null, error: null,
        checks: opts.checks && (opts.checks as unknown[]).length ? [{ description: "x is two", status: checkStatus, message: "" }] : [] };
    },
  };
  const snippets: Record<string, unknown>[] = [];
  const runner = {
    // validation runs: the reference ("x = 2") passes its check, anything else fails it
    runSnippet: async (req: { snippet: { code: string; checks: unknown[] } }) => {
      snippets.push(req as never);
      const pass = req.snippet.code === "x = 2";
      return { status: "ok", error: null, stdout: "", stderr: "", result: null,
        checks: req.snippet.checks.length ? [{ description: "x is two", status: pass ? "pass" : "fail", message: "" }] : [] };
    },
    parseTutorial: async (yaml: string) => yaml.startsWith("id: fixture-tutorial")
      ? { ok: true, tutorial: fixture.tutorial, shim: SHIM }
      : { ok: false, errors: "bad tutorial" },
  };
  const events: Record<string, unknown>[] = [];
  const hub = { broadcast: (e: Record<string, unknown>) => events.push(e) };
  const tutorials = new BrowserTutorialService({ db, hub: hub as never, runner: runner as never, service: service as never });
  return { db, tutorials, service, runner, runs, events, session, snippets, set: (s: typeof status, c: typeof checkStatus) => ((status = s), (checkStatus = c)) };
}

test("open, edit, run a cell: earlier cells replay, checks run, results are kept", async () => {
  const { tutorials, runs, set } = setup();
  await tutorials.save("fixture-tutorial", YAML, { tutorial: fixture.tutorial, shim: SHIM });

  const opened = await tutorials.get("fixture-tutorial");
  assert.equal(opened.files["cells/one.py"], "x = 1");
  assert.doesNotMatch(JSON.stringify(opened), /assert x == 2/);        // no checks, no reference

  set("ok", "fail");
  await tutorials.runCell("fixture-tutorial", "one", { "cells/one.py": "x = 5" }, "run1");
  assert.deepEqual(runs[0].prior, []);
  assert.deepEqual(runs[0].checks, [{ description: "x is two", code: "assert x == 2" }]);
  assert.equal(runs[0].problemYaml, SHIM);
  assert.equal(runs[0].source, "ui");
  assert.equal((await tutorials.get("fixture-tutorial")).files["cells/one.py"], "x = 5");   // saved with the run
  let list = (await tutorials.list()).tutorials;
  assert.equal(list[0].passed, 0);

  set("ok", "pass");
  await tutorials.runCell("fixture-tutorial", "two", {}, "run2");
  assert.deepEqual(runs[1].prior, ["x = 5"]);                           // the learner's current code
  await tutorials.runCell("fixture-tutorial", "one", {}, "run3");
  list = (await tutorials.list()).tutorials;
  assert.deepEqual([list[0].checked, list[0].passed, list[0].cells], [1, 1, 3]);
  assert.equal((await tutorials.get("fixture-tutorial")).results.one.passed, true);
});

test("reset puts one cell, or all of them, back to the starter and drops results", async () => {
  const { tutorials } = setup();
  await tutorials.save("fixture-tutorial", YAML, { tutorial: fixture.tutorial, shim: SHIM });
  await tutorials.saveFiles("fixture-tutorial", { "cells/one.py": "x = 9", "cells/two.py": "x" });
  await tutorials.runCell("fixture-tutorial", "one", {}, "r");
  const one = await tutorials.reset("fixture-tutorial", "one");
  assert.deepEqual([one.files["cells/one.py"], one.files["cells/two.py"], Object.keys(one.results)], ["x = 1", "x", []]);
  const all = await tutorials.reset("fixture-tutorial");
  assert.equal(all.files["cells/two.py"], "x + 1");
});

test("only cell files can be saved", async () => {
  const { tutorials } = setup();
  await tutorials.save("fixture-tutorial", YAML, { tutorial: fixture.tutorial, shim: SHIM });
  await assert.rejects(tutorials.saveFiles("fixture-tutorial", { "evil.py": "" }), /not a cell file/);
  await assert.rejects(tutorials.get("missing"), /no tutorial/);
});

test("export then import brings tutorials and their work into another store", async () => {
  const a = setup();
  await a.tutorials.save("fixture-tutorial", YAML, { tutorial: fixture.tutorial, shim: SHIM });
  await a.tutorials.runCell("fixture-tutorial", "one", { "cells/one.py": "x = 2" }, "r");
  const entries = await collectEntries(a.db, async () => undefined);
  const paths = entries.map((e) => e.path).sort();
  assert.ok(paths.includes("tutorials/fixture-tutorial.yaml"));
  assert.ok(paths.includes("workspace/tut-fixture-tutorial/cells/one.py"));
  assert.ok(paths.includes("workspace/tut-fixture-tutorial/.leegen/cell_results.json"));

  // a zip of a whole checkout, plus a workspace for a tutorial that is not there, plus a bad file
  const wrapped = [...entries, { path: "workspace/tut-ghost/cells/a.py", data: enc.encode("x") },
    { path: "tutorials/broken.yaml", data: enc.encode("nonsense") }].map((e) => ({ ...e, path: `leegen/data/${e.path}` }));
  const b = setup();
  const summary = await importEntries(wrapped, { db: b.db, runner: b.runner as never, service: b.service as never, tutorials: b.tutorials });
  assert.deepEqual(summary.tutorials, ["fixture-tutorial"]);
  assert.deepEqual(summary.workspaces, ["tut-fixture-tutorial"]);
  assert.deepEqual(summary.errors.map((e) => e.path).sort(), ["tutorials/broken.yaml", "workspace/tut-ghost/cells/a.py"]);
  const back = await b.tutorials.get("fixture-tutorial");
  assert.equal(back.files["cells/one.py"], "x = 2");
  assert.equal(back.results.one.status, "ok");

  const again = await importEntries(entries, { db: b.db, runner: b.runner as never, service: b.service as never, tutorials: b.tutorials });
  assert.deepEqual([again.tutorials, again.unchanged], [[], ["fixture-tutorial"]]);
  assert.equal(normalise(wrapped).some((e) => e.path.startsWith("leegen")), false);
});

test("agent authoring: validate replays references and starters, create saves, update and delete follow", async () => {
  const { tutorials, events, snippets } = setup();
  assert.equal((await tutorials.validateYaml("nonsense")).report.stage, "schema");

  const ok = await tutorials.validateYaml(YAML);
  assert.equal(ok.report.ok, true);
  assert.deepEqual(snippets.map((r) => (r.snippet as { code: string }).code), ["x = 2", "x = 1"]);   // reference, then starter

  const created = await tutorials.create(YAML);
  assert.deepEqual([created.saved, created.validated, created.path], [true, true, "tutorials/fixture-tutorial.yaml"]);
  assert.deepEqual(events.map((e) => e.type), ["tutorials_changed", "tutorial_changed"]);
  assert.match(String((await tutorials.create(YAML)).errors), /overwrite=true/);
  assert.equal((await tutorials.create(YAML, true)).saved, true);
  assert.equal((await tutorials.update("fixture-tutorial", YAML)).saved, true);
  assert.equal((await tutorials.update("other", YAML)).saved, false);
  assert.equal((await tutorials.agentGet("fixture-tutorial")).yaml, YAML);
  assert.doesNotMatch(JSON.stringify(await tutorials.agentGet("fixture-tutorial", false)), /assert/);
  assert.equal((await tutorials.agentList()).tutorials.length, 1);
  assert.equal((await tutorials.agentList("no-track")).tutorials.length, 0);
  assert.equal(tutorials.guide(), "the guide");

  assert.deepEqual(await tutorials.navigate("fixture-tutorial"), { opened: "fixture-tutorial" });
  assert.deepEqual(events.at(-1), { type: "navigate_tutorial", tutorial_id: "fixture-tutorial" });
  await assert.rejects(tutorials.navigate("nope"), /no tutorial/);
  assert.deepEqual(await tutorials.delete("fixture-tutorial", true), { deleted: true });
  assert.equal((await tutorials.agentList()).tutorials.length, 0);
});

test("a starter that already passes is refused, and a cell that raises is reported", async () => {
  const { tutorials, runner } = setup();
  const cheating = { ...fixture.tutorial, cells: fixture.tutorial.cells.map((c) => (c.type === "code" && c.id === "one" ? { ...c, starter: "x = 2" } : c)) };
  const parse = runner.parseTutorial;
  runner.parseTutorial = async (y: string) => ({ ...(await parse(y)), tutorial: cheating }) as never;
  const refused = await tutorials.create(YAML);
  assert.equal(refused.saved, false);
  assert.match(String((refused.issues as string[])[0]), /starter already passes/);
  assert.equal((await tutorials.agentList()).tutorials.length, 0);
});

test("run_tutorial_cell uses the learner's unsaved buffers without saving them; the session describes the tutorial", async () => {
  const { tutorials, session, runs, events } = setup();
  await tutorials.create(YAML);
  await assert.rejects(tutorials.runForAgent(), /no tutorial_id/);

  Object.assign(session, { problem_id: "tut-fixture-tutorial", active_file: "cells/one.py", buffers: { "cells/one.py": "x = 2" },
    cursor: { line: 1, column: 2 }, selection: null, updated_at: 90 });
  const ran = await tutorials.runForAgent();                       // open tutorial, active cell
  assert.deepEqual([ran.cell, ran.status, ran.passed], ["one", "ok", true]);
  assert.equal(runs[0].source, "webmcp");
  assert.equal(runs[0].code, "x = 2");
  assert.equal((await tutorials.get("fixture-tutorial")).files["cells/one.py"], "x = 1");   // not persisted
  assert.equal(events.filter((e) => e.type === "tutorial_cell_finished").at(-1)?.cell, "one");
  await assert.rejects(tutorials.runForAgent(null, "nope"), /no cell 'nope'/);

  const view = await tutorials.sessionView();
  assert.deepEqual([view.kind, view.problem_id, view.tutorial_id, view.active_cell, view.seconds_since_activity], ["tutorial", "tut-fixture-tutorial", "fixture-tutorial", "one", 10]);
  const code = (view.cells as { id?: string; code?: string; modified?: boolean; outcome?: unknown }[]).filter((c) => c.id);
  assert.deepEqual([code[0].code, code[0].modified], ["x = 2", true]);
  assert.equal((code[0].outcome as { status: string }).status, "ok");
  assert.doesNotMatch(JSON.stringify(view), /assert x == 2/);        // hidden checks stay out

  session.problem_id = null;
  assert.equal((await tutorials.sessionView()).problem_id, null);
});
