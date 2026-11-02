/// <reference types="node" />
// Conformance: the TypeScript core port against fixtures generated from the Python core.
//   node --test src/backend/browser/        (npm test)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as core from "./core.ts";

const fixtures = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}.json`, import.meta.url), "utf8"));

const problems: Record<string, core.FullProblem> = fixtures("problems");

function counterClock(): core.Clock {
  let ids = 0;
  let t = 0;
  return { newId: () => `id${++ids}`, now: () => 1_700_000_000 + ++t };
}

type Case = { fn: string; args: Record<string, any>; result?: unknown; error?: string };

const calls: Record<string, (a: Record<string, any>) => unknown> = {
  // views
  problem_summary: (a) => core.problemSummary(problems[a.problem]),
  public_problem: (a) => core.publicProblem(problems[a.problem]),
  run_status: (a) => core.runStatus(a.last_run),
  brief_run: (a) => core.briefRun(a.result, a.full),
  // review
  resolve_columns: (a) => core.resolveColumns(a.start_col, a.end_col, a.start, a.end, a.lines, a.file),
  make_annotations: (a) => core.makeAnnotations(problems[a.problem], a.files, a.items, a.author, counterClock()),
  without_annotations: (a) =>
    core.withoutAnnotations(a.items, { annotation_id: a.annotation_id, file: a.file, clear: a.clear ?? false }),
  apply_edits: (a) => core.applyEdits(a.content, a.edits),
  make_proposal: (a) =>
    core.makeProposal(
      problems[a.problem],
      a.files,
      a.file,
      { content: a.content, edits: a.edits, rationale: a.rationale ?? "", author: a.author ?? "assistant", source: a.source ?? "mcp" },
      counterClock(),
    ),
  with_proposal: (a) => core.withProposal(a.items, a.proposal),
  make_custom_test: (a) =>
    core.makeCustomTest(problems[a.problem], a.existing, a.args, a.kwargs, a.name, a.description, a.section),
  unique_test_name: (a) => core.uniqueTestName(a.wanted, new Set(a.taken)),
};

for (const file of ["views", "review"]) {
  const cases: Case[] = fixtures(file).cases;
  cases.forEach((c, i) => {
    test(`${file}#${i} ${c.fn}`, () => {
      const fn = calls[c.fn];
      assert.ok(fn, `no TypeScript implementation for ${c.fn}`);
      if (c.error !== undefined) {
        assert.throws(() => fn(c.args), (e: Error) => {
          assert.equal(e.message, c.error);
          return true;
        });
      } else {
        // JSON round trip: drop undefined, compare like Python's json output
        assert.deepEqual(JSON.parse(JSON.stringify(fn(c.args))), c.result);
      }
    });
  });
}

test("pyRepr matches Python for strings and lists", () => {
  assert.equal(core.pyRepr("a.py"), "'a.py'");
  assert.equal(core.pyRepr("it's"), `"it's"`);
  assert.equal(core.pyRepr(["a", "b"]), "['a', 'b']");
  assert.equal(core.pyRepr([]), "[]");
});
