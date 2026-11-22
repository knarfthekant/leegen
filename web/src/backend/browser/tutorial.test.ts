/// <reference types="node" />
// Conformance: the TypeScript tutorial views against fixtures generated from the Python core.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cellRunInputs, compareTutorials, publicTutorial, referenceIssues, sessionCells, starterIssues, tutorialSummary, type FullTutorial } from "./tutorial.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../../contracts/fixtures/tutorials.json", import.meta.url), "utf8")) as {
  tutorial: FullTutorial;
  cases: { fn: string; args: Args; result: unknown }[];
};

type Args = { files?: Record<string, string>; cell?: string; result?: Parameters<typeof referenceIssues>[1]; results?: Parameters<typeof sessionCells>[2] };

const calls: Record<string, (a: Args) => unknown> = {
  reference_issues: (a) => referenceIssues(a.cell!, a.result!),
  starter_issues: (a) => starterIssues(a.cell!, a.result!),
  session_cells: (a) => sessionCells(fixture.tutorial, a.files ?? {}, a.results ?? {}),
  public_tutorial: () => publicTutorial(fixture.tutorial),
  tutorial_summary: () => tutorialSummary(fixture.tutorial),
  cell_run_inputs: (a) => cellRunInputs(fixture.tutorial, a.files ?? {}, a.cell!),
};

for (const [i, c] of fixture.cases.entries()) {
  test(`tutorial fixture ${i}: ${c.fn} ${c.args.cell ?? ""} ${(c.args as { label?: string }).label ?? ""}`, () => {
    assert.deepEqual(calls[c.fn](c.args), c.result);
  });
}

test("the learner's view carries no checks or references", () => {
  assert.doesNotMatch(JSON.stringify(publicTutorial(fixture.tutorial)), /assert|reference/);
});

test("an unknown cell is an error", () => {
  assert.throws(() => cellRunInputs(fixture.tutorial, {}, "nope"), /unknown cell/);
});

test("tutorials sort by track, order, then title", () => {
  const t = (title: string, track: string | null, order: number | null) => ({ title, track, order });
  const sorted = [t("b", null, null), t("z", "x", 2), t("a", "x", 1), t("c", null, 1)].sort(compareTutorials).map((x) => x.title);
  assert.deepEqual(sorted, ["a", "z", "c", "b"]);
});
