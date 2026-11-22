// Browser-edition smoke test: the static build on two local origins with production headers.
//
//   uv run leegen browser build && uv run leegen browser serve    (from server/)
//   node tests/browser-smoke.mjs                                          (from web/)
//
// Fresh Chrome profile (empty IndexedDB). Uses the installed Chrome via playwright-core.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const APP = process.env.LEEGEN_APP ?? "http://localhost:13380";
const SHOTS = process.env.SHOTS ?? "/tmp";
const PID = "merge-ranges";
const PYTHON_SEEDS = ["merge-ranges", "iterators-and-await"];
const SOLUTION = `def merge_ranges(bookings):
    merged = []
    for start, end in sorted(bookings):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
`;

const TRIVIAL = `id: trivial-add
title: Trivial add
environment: python
description: Add two numbers.
files:
  - path: solution.py
    role: editable
    content: |
      def add(a, b):
          return a + b
reference:
  files:
    - path: solution.py
      content: |
        def add(a, b):
            return a + b
judge:
  kind: function
  entry: solution.py:add
sections:
  - id: basics
    title: Basics
    description: Adding two small numbers.
tests:
  - name: small
    section: basics
    input: {args: [1, 2]}
    expected: 3
`;

let current = "";
const step = (msg) => {
  current = msg;
  console.log("•", msg);
};
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebMCPTesting"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`page error during "${current}": ${e.message.split("\n").slice(-3).join(" | ")}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/favicon/.test(t)) problems.push(`console: ${t}`);
});

const tool = async (name, input = {}) => {
  const r = await page.evaluate(([n, i]) => window.leegenTools.call(n, i), [name, input]);
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const toolError = async (name, input) => {
  const r = await page.evaluate(([n, i]) => window.leegenTools.call(n, i), [name, input]);
  if (!r.isError) throw new Error(`${name} should have failed`);
  return r.content[0].text;
};
const editor = (fn, arg) =>
  page.evaluate(`(() => {
    const m = window.monaco, ed = m.editor.getEditors().find((e) => !e.getOption(m.editor.EditorOption.readOnly));
    return (${fn.toString()})(m, ed, ${JSON.stringify(arg ?? null)});
  })()`);
const trigger = (id) => editor((m, ed, action) => ed.trigger("smoke", action, {}), id);
const setBuffer = (code) => editor((m, ed, value) => {
  const model = ed.getModel();
  model.setValue(value);
  const line = model.getLineCount();
  ed.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
  ed.focus();
}, code);
const resultStatus = async () => {
  await page.locator(".result-status").waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Running…"), null, { timeout: 90_000 });
  return page.locator(".result-status").innerText();
};

try {
  step("list page loads the seeds from the static bundle into IndexedDB");
  await page.goto(APP + "/");
  await page.getByText("Merge Booking Ranges").first().waitFor();
  const seeds = await page.locator(".problem-row").count();
  if (seeds !== 9) throw new Error(`expected 9 bundled problems, got ${seeds}`);
  await page.getByRole("button", { name: "Minimize Codex guide" }).click();
  const isolated = await page.evaluate(() => crossOriginIsolated);
  if (!isolated) throw new Error("the app page is not cross-origin isolated");

  step("WebMCP: every manifest tool is registered on the top-level page");
  const registered = await page.evaluate(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = mc?.getTools ? await mc.getTools() : null;
    return { has: !!mc, names: tools ? tools.map((t) => t.name) : null, listed: window.leegenTools.list().length };
  });
  console.log(`  modelContext: ${registered.has}; registered: ${registered.names?.length ?? "?"}; manifest tools: ${registered.listed}`);
  if (registered.has && registered.names && registered.names.length !== registered.listed) {
    throw new Error("not every tool was registered: " + registered.names.join(", "));
  }

  step("the python seeds pass validation in the browser runner (reference passes, starter fails)");
  for (const id of PYTHON_SEEDS) {
    const { yaml } = await tool("get_problem", { problem_id: id });
    const t0 = Date.now();
    const report = await tool("validate_problem_yaml", { yaml });
    console.log(`  ${id}: ok=${report.ok} ${report.summary} (${Date.now() - t0} ms)`);
    if (!report.ok) throw new Error(`${id}: ${JSON.stringify(report.issues)}`);
  }
  const torch = await tool("validate_problem_yaml", { yaml: (await tool("get_problem", { problem_id: "kv-cache-basics" })).yaml });
  if (!torch.skipped) throw new Error("pytorch problems should be skipped in the browser: " + JSON.stringify(torch));
  console.log(`  kv-cache-basics: skipped (${torch.summary})`);

  step("tools validate their input like the server");
  console.log("  " + (await toolError("annotate", { annotations: "nope" })));
  console.log("  " + (await toolError("get_problem", { problem_id: "nope" })));

  step("open the problem, write a solution, run it: Accepted");
  await page.getByText("Merge Booking Ranges").first().click();
  await page.locator(".title", { hasText: "Merge Booking Ranges" }).waitFor();
  await page.locator(".monaco-editor").first().waitFor();
  await editor((m, ed, code) => { ed.getModel().setValue(code); ed.focus(); }, SOLUTION);
  await page.waitForTimeout(700);

  step("editor intelligence works in the static build");
  await setBuffer(SOLUTION + "\nmer");
  await trigger("editor.action.triggerSuggest");
  await page.locator(".suggest-widget").waitFor({ timeout: 10_000 });
  const suggestions = await page.locator(".suggest-widget .monaco-list-row").allInnerTexts();
  if (!suggestions.some((s) => s.includes("merge_ranges"))) throw new Error("no merge_ranges completion: " + JSON.stringify(suggestions.slice(0, 8)));
  await page.keyboard.press("Escape");
  await setBuffer(SOLUTION + "\nmerge_ranges(");
  await trigger("editor.action.triggerParameterHints");
  await page.locator(".parameter-hints-widget").waitFor({ timeout: 10_000 });
  const hints = await page.locator(".parameter-hints-widget").innerText();
  if (!hints.includes("bookings")) throw new Error("parameter hints missing bookings: " + hints);
  await page.keyboard.press("Escape");
  await setBuffer(SOLUTION);
  await page.waitForTimeout(700);
  const hoverPoint = await editor((m, ed) => {
    const p = ed.getScrolledVisiblePosition({ lineNumber: 1, column: 6 });
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.left + p.left + 2, y: r.top + p.top + p.height / 2 };
  });
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.locator(".monaco-hover", { hasText: "def merge_ranges(bookings" }).waitFor({ timeout: 10_000 });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);

  step("console: snippet with stdout and an echoed expression");
  await page.getByRole("tab", { name: "Console" }).click();
  await page.locator("textarea.console-input").first().fill('print("hi")\n2 + 3');
  await page.getByRole("button", { name: /^Run \(/ }).last().click();
  await page.locator(".console-entry .chip", { hasText: "ok" }).first().waitFor({ timeout: 90_000 });
  const consoleText = await page.locator(".console-entry").first().innerText();
  if (!consoleText.includes("hi") || !consoleText.includes("5")) throw new Error("console output:\n" + consoleText);
  console.log("  console ok:", consoleText.replace(/\s+/g, " ").slice(0, 80));

  step("run the selected line in the Console");
  await editor((m, ed) => {
    const model = ed.getModel();
    const last = model.getLineCount();
    const end = model.getLineMaxColumn(last);
    ed.executeEdits("smoke", [{ range: new m.Range(last, end, last, end), text: "\nmerge_ranges([[4, 5], [1, 2]])" }]);
    const line = model.getLineCount();
    ed.setSelection(new m.Range(line, 1, line, model.getLineMaxColumn(line)));
    ed.focus();
  });
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await page.waitForFunction(() => {
    const entries = document.querySelectorAll(".console-entry");
    return entries.length >= 2 && entries[0].querySelector(".chip")?.textContent?.trim() === "ok";
  }, null, { timeout: 90_000 });
  const selectionText = await page.locator(".console-entry").first().innerText();
  if (!selectionText.includes("[[1, 2], [4, 5]]")) throw new Error("selection output:\n" + selectionText);
  console.log("  selection ok:", selectionText.replace(/\s+/g, " ").slice(0, 80));
  await setBuffer(SOLUTION);
  await page.waitForTimeout(700);

  step("run with ⌘↵ and expect all tests to pass");
  await page.keyboard.press("ControlOrMeta+Enter");
  const status = await resultStatus();
  console.log("  result:", (await page.locator(".result-head").innerText()).replace(/\s+/g, " "));
  if (status !== "Accepted") throw new Error(`expected Accepted, got ${status}`);
  await page.screenshot({ path: `${SHOTS}/lc-browser-passed.png` });

  step("get_session sees the editor, annotate + propose_edit reach the UI");
  const session = await tool("get_session");
  if (session.problem_id !== PID || !session.user_files["solution.py"].includes("sorted(bookings)")) {
    throw new Error("get_session does not reflect the editor: " + JSON.stringify(session).slice(0, 300));
  }
  if (session.last_run?.status !== "passed") throw new Error("last_run should be passed");
  const ann = await tool("annotate", {
    annotations: [{ file: "solution.py", start_line: 3, severity: "praise", message: "Sorting first is the key step." }],
  });
  await page.getByRole("tab", { name: /Review/ }).waitFor();
  const prop = await tool("propose_edit", {
    file: "solution.py",
    rationale: "name the loop result",
    edits: [{ old: "    return merged\n", new: "    result = merged\n    return result\n" }],
  });
  console.log(`  annotation ${ann.created[0]}, proposal ${prop.proposal_id}`);
  await page.getByRole("button", { name: "Accept" }).first().click();
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().includes("result = merged")));

  step("run_tests through the tool, and a custom test case");
  const run = await tool("run_tests", {});
  if (run.status !== "passed") throw new Error("run_tests: " + JSON.stringify(run));
  await tool("add_test_case", { args: [[[4, 5], [1, 4]]], section: "basics" });
  const full = await tool("run_tests", { full: true });
  const custom = full.tests.find((t) => /^Test \d+$/.test(t.name) && t.section === "basics");
  if (!custom || JSON.stringify(custom.expected) !== "[[1,5]]") throw new Error("custom test: " + JSON.stringify(custom));

  step("a runaway loop is stopped and reported as a timeout");
  await editor((m, ed) => ed.getModel().setValue("def merge_ranges(bookings):\n    while True:\n        pass\n"));
  await page.waitForTimeout(700);
  const t0 = Date.now();
  await page.keyboard.press("ControlOrMeta+Enter");
  const slow = await resultStatus();
  console.log(`  status: ${slow} after ${Date.now() - t0} ms`);
  if (!/time limit|timeout/i.test(slow)) throw new Error(`expected a timeout, got ${slow}`);

  step("cancel stops a run");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.getByRole("button", { name: "Cancel run" }).click({ timeout: 10_000 });
  const cancelled = await resultStatus();
  console.log(`  status: ${cancelled}`);
  if (!/cancel/i.test(cancelled)) throw new Error(`expected cancelled, got ${cancelled}`);

  step("work persists across a reload");
  await editor((m, ed, code) => ed.getModel().setValue(code), SOLUTION);
  await page.waitForTimeout(800);
  await page.reload();
  await page.locator(".monaco-editor").first().waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().includes("sorted(bookings)")));

  step("create_problem validates in the runner and refuses a starter that already passes");
  const { yaml } = await tool("get_problem", { problem_id: PID });
  const copy = yaml.replace(/^id: merge-ranges$/m, "id: merge-ranges-copy").replace(/^title: .*$/m, "title: Merge Copy");
  const created = await tool("create_problem", { yaml: copy });
  if (!created.saved) throw new Error("create_problem: " + JSON.stringify(created));
  const refused = await tool("create_problem", { yaml: TRIVIAL });
  if (refused.saved || !refused.issues.some((i) => i.includes("starter code already passes"))) {
    throw new Error("a passing starter must be refused: " + JSON.stringify(refused));
  }
  console.log("  created merge-ranges-copy; refused trivial-add (starter passes)");

  step("export -> import round trip in the repo layout");
  await page.goto(APP + "/");
  await page.getByText("Merge Copy").first().waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Export/ }).click();
  const file = await download;
  const zipPath = `${SHOTS}/lc-browser-export.zip`;
  await file.saveAs(zipPath);
  await tool("delete_problem", { problem_id: "merge-ranges-copy", delete_user_code: true });
  await page.waitForFunction(() => !document.body.innerText.includes("Merge Copy"));
  await page.locator('input[type="file"]').setInputFiles(zipPath);
  await page.getByText(/Imported 1 problem/).waitFor({ timeout: 30_000 });
  await page.getByText("Merge Copy").first().waitFor();
  console.log("  " + (await page.locator(".soft-alert").first().innerText()).split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}/lc-browser-import.png` });

  step("tutorials: run cells with hidden checks, navigate with prev/next and the list, export/import them");
  const TUT = "dict-first-steps";
  const setCell = (cell, code) => page.evaluate(([c, v]) => {
    const ed = window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith(`/cells/${c}.py`));
    ed.getModel().setValue(v);
  }, [cell, code]);
  const runCell = (n) => page.locator(".t-run").nth(n).click();
  await page.goto(APP + "/?view=tutorials");
  const row = page.locator(".tutorial-row", { hasText: "Dictionaries, one step at a time" });
  await row.waitFor();
  if ((await page.locator(".tutorial-row").count()) !== 6) throw new Error("expected 6 bundled tutorials");
  await row.click();
  await page.locator(".t-cell").first().waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors().length >= 3);
  // the starter fails its checks; the reference passes, and cell 2 sees cell 1's `ages` (replay)
  await runCell(0);
  await page.locator(".t-dot.fail, .t-dot.error").first().waitFor({ timeout: 90_000 });
  await setCell("build", 'ages = {"ada": 36, "alan": 41}');
  await runCell(0);
  await page.waitForFunction(() => document.querySelectorAll(".t-cell.complete").length === 1, null, { timeout: 90_000 });
  await setCell("update", 'ages["grace"] = 45\noldest = max(ages, key=ages.get)');
  await runCell(1);
  await page.waitForFunction(() => document.querySelectorAll(".t-cell.complete").length === 2, null, { timeout: 90_000 });
  console.log("  2 cells complete; the later cell ran on the earlier cell's namespace");

  await page.reload();
  await page.locator(".t-cell").first().waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().includes('"alan": 41')));
  if (await page.getByRole("button", { name: /Random/ }).count()) throw new Error("tutorials have no shuffle button");
  await page.getByRole("button", { name: "Next tutorial" }).click();
  await page.waitForFunction((id) => !location.pathname.endsWith(id) && location.pathname.includes("/t/"), TUT);
  await page.getByRole("button", { name: "Previous tutorial" }).click();
  await page.waitForFunction((id) => location.pathname.endsWith(id), TUT);
  await page.getByRole("button", { name: "Tutorial List" }).click();
  await page.locator(".drawer .tutorial-row.current").waitFor();
  if ((await page.locator(".drawer .tutorial-row").count()) !== 6) throw new Error("the drawer should list every tutorial");
  await page.locator(".drawer .tutorial-row:not(.current)").first().click();
  await page.waitForFunction((id) => !location.pathname.endsWith(id), TUT);
  console.log("  prev/next and the drawer navigate; progress survives a reload");

  await page.goto(APP + "/?view=tutorials");
  await page.locator(".tutorial-row").first().waitFor();
  const tutDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Export/ }).click();
  const tutZip = `${SHOTS}/lc-browser-export-tutorials.zip`;
  await (await tutDownload).saveAs(tutZip);
  const listing = execFileSync("unzip", ["-Z1", tutZip], { encoding: "utf8" });
  for (const want of [`tutorials/${TUT}.yaml`, `workspace/tut-${TUT}/cells/build.py`, `workspace/tut-${TUT}/.leegen/cell_results.json`]) {
    if (!listing.split("\n").includes(want)) throw new Error(`export is missing ${want}:\n${listing}`);
  }
  await page.locator('input[type="file"]').setInputFiles(tutZip);
  await page.getByText(/^Imported \d+ problems?/).waitFor({ timeout: 30_000 });
  if (await page.locator(".soft-alert.tone-warn").count()) throw new Error("re-importing the export reported errors");
  console.log("  export has tutorials/ and tut-<id> work; re-import is clean");

  // a changed tutorial is parsed by the Python core in the runner; a broken one is reported
  const dir = mkdtempSync(join(tmpdir(), "lc-tutorial-import-"));
  mkdirSync(join(dir, "data", "tutorials"), { recursive: true });
  const src = readFileSync(new URL("../../data/tutorials/dict-first-steps.yaml", import.meta.url), "utf8");
  writeFileSync(join(dir, "data", "tutorials", "dict-first-steps.yaml"), src.replace("Dictionaries, one step at a time", "Dictionaries, edited"));
  writeFileSync(join(dir, "data", "tutorials", "broken.yaml"), "id: broken\ntitle: x\ncells: []\n");
  const editedZip = join(dir, "edited.zip");
  execFileSync("zip", ["-qr", editedZip, "data"], { cwd: dir });
  await page.locator('input[type="file"]').setInputFiles(editedZip);
  await page.getByText(/Imported 0 problems and 1 tutorial/).waitFor({ timeout: 30_000 });
  await page.locator(".soft-alert.tone-warn summary", { hasText: "tutorials/broken.yaml" }).waitFor();
  await page.locator(".tutorial-row", { hasText: "Dictionaries, edited" }).waitFor();
  console.log("  a changed tutorial was re-parsed and imported; a broken one was reported");

  step("tutorial tools: author, open, tutor on a cell (session, comments, edits, runs), clean up");
  const TUT_YAML = `schema_version: 1
id: agent-demo
title: Agent demo
summary: Written by an agent.
cells:
  - type: markdown
    text: Set x to two.
  - type: code
    id: one
    starter: |
      x = 1
    reference: |
      x = 2
    checks:
      - description: x is two
        code: assert x == 2
  - type: code
    id: two
    starter: |
      y = 0
    reference: |
      y = x + 1
    checks:
      - description: y is three
        code: assert y == 3
`;
  const tutList = await tool("list_tutorials");
  if (tutList.tutorials.length !== 6 || !tutList.tutorials.every((t) => "passed" in t)) throw new Error("list_tutorials: " + JSON.stringify(tutList).slice(0, 300));
  if (!(await tool("get_tutorial_guide")).includes("hidden **checks**")) throw new Error("get_tutorial_guide is missing the guide");
  const hidden = await tool("get_tutorial", { tutorial_id: "dict-first-steps" });
  const visible = await tool("get_tutorial", { tutorial_id: "dict-first-steps", include_hidden: false });
  if (!hidden.yaml.includes("assert ages") || JSON.stringify(visible).includes("assert ")) throw new Error("get_tutorial: hidden checks must be in the YAML only");

  const cheating = TUT_YAML.replace("x = 1", "x = 2");
  const refusedTutorial = await tool("create_tutorial", { yaml: cheating });
  if (refusedTutorial.saved || !refusedTutorial.issues.some((i) => i.includes("starter already passes"))) {
    throw new Error("a passing starter must be refused: " + JSON.stringify(refusedTutorial));
  }
  if ((await tool("validate_tutorial_yaml", { yaml: "id: x\n" })).stage !== "schema") throw new Error("schema errors come first");
  const madeTutorial = await tool("create_tutorial", { yaml: TUT_YAML });
  if (!madeTutorial.saved || !madeTutorial.validated) throw new Error("create_tutorial: " + JSON.stringify(madeTutorial));
  if ((await tool("list_tutorials")).tutorials.length !== 7) throw new Error("the new tutorial should be listed");

  await tool("open_tutorial", { tutorial_id: "agent-demo" });
  await page.waitForFunction(() => location.pathname.endsWith("/t/agent-demo"));
  await page.locator(".t-cell").nth(1).waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors().length >= 2);
  await setCell("one", "x = 5");
  await page.locator(".t-cell").first().locator(".monaco-editor").click();
  let tutSession;
  for (let i = 0; i < 40; i++) {
    tutSession = await tool("get_session");
    if (tutSession.kind === "tutorial" && tutSession.cells.some((c) => c.code === "x = 5")) break;
    await page.waitForTimeout(150);
  }
  if (tutSession.kind !== "tutorial" || tutSession.problem_id !== "tut-agent-demo" || tutSession.active_cell !== "one") {
    throw new Error("get_session should describe the open tutorial: " + JSON.stringify(tutSession).slice(0, 400));
  }
  if (JSON.stringify(tutSession).includes("assert x")) throw new Error("the session must not carry hidden checks");

  const wrong = await tool("run_tutorial_cell", { cell: "one" });          // runs the unsaved x = 5
  if (wrong.status !== "ok" || wrong.passed || wrong.checks[0].status !== "fail") throw new Error("x = 5 should fail: " + JSON.stringify(wrong));
  await page.locator(".t-cell").first().locator(".t-dot.fail").waitFor();   // the page shows the agent's run

  await tool("annotate", { problem_id: "tut-agent-demo", annotations: [{ file: "cells/one.py", start_line: 1, start_col: 5, end_col: 6, severity: "hint", message: "What should **x** be?" }] });
  await page.locator(".t-cell").first().locator(".t-notes .review-item", { hasText: "What should" }).waitFor();
  await page.locator(".t-cell").first().locator(".lc-ann").waitFor();
  await tool("propose_edit", { problem_id: "tut-agent-demo", file: "cells/one.py", rationale: "x must be two", edits: [{ old: "x = 5", new: "x = 2" }] });
  await page.locator(".t-proposal").waitFor();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().trim() === "x = 2"));
  const right = await tool("run_tutorial_cell", { cell: "one" });
  if (!right.passed) throw new Error("x = 2 should pass: " + JSON.stringify(right));
  await page.waitForFunction(() => document.querySelectorAll(".t-cell.complete").length === 1, null, { timeout: 30_000 });
  if ((await tool("clear_annotations", { problem_id: "tut-agent-demo" })).removed !== 1) throw new Error("clear_annotations should remove the comment");
  await page.locator(".t-notes").waitFor({ state: "detached" });
  await toolError("run_tests", { problem_id: "tut-agent-demo" });           // tests are for problems only
  console.log("  authored, opened, read the session, ran cells, commented and edited a cell");

  await tool("delete_tutorial", { tutorial_id: "agent-demo", delete_user_code: true });
  if ((await tool("list_tutorials")).tutorials.length !== 6) throw new Error("delete_tutorial should remove it");
  await page.goto(APP + "/");
  await page.waitForFunction(() => window.leegenTools);

  step("WebGPU: WGSL editor, compile errors with locations, a passing kernel, GPU timing");
  const hasGpu = (await tool("list_executors")).executors[0].capabilities.includes("webgpu");
  if (!hasGpu) {
    console.log("  skipped: no WebGPU adapter in this browser");
  } else {
    const id = "webgpu-tiled-matmul";
    const report = await tool("validate_problem_yaml", { yaml: (await tool("get_problem", { problem_id: id })).yaml });
    console.log(`  ${id}: ok=${report.ok} ${report.summary}`);
    if (!report.ok) throw new Error(`${id}: ${JSON.stringify(report.issues)}`);
    await tool("open_problem", { problem_id: id });
    await page.locator(".title", { hasText: "Tiled Matrix" }).waitFor();
    await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getModel()?.getLanguageId() === "wgsl"));
    step("the WGSL editor gets no Python suggestions");
    await editor((m, ed) => {
      ed.getModel().setValue("pri\n");
      ed.setPosition({ lineNumber: 1, column: 4 });
      ed.focus();
    });
    await trigger("editor.action.triggerSuggest");
    await page.waitForTimeout(800);
    const wgslSuggestions = await page.locator(".suggest-widget.visible .monaco-list-row").allInnerTexts().catch(() => []);
    if (wgslSuggestions.some((s) => /merge_ranges|\bprint\b|sorted\b/.test(s))) {
      throw new Error("Python suggestions leaked into WGSL: " + JSON.stringify(wgslSuggestions.slice(0, 8)));
    }
    await page.keyboard.press("Escape");
    step("WebGPU: compile errors with locations, a passing kernel, GPU timing");
    await editor((m, ed) => ed.getModel().setValue("@compute @workgroup_size(64)\nfn main() {\n    let x: f32 = 1u;\n}\n"));
    await page.waitForTimeout(700);
    const broken = await tool("run_tests", {});
    const msg = broken.failing_tests[0]?.message ?? "";
    if (!/kernel\.wgsl:3:\d+/.test(msg)) throw new Error("compile errors should point at kernel.wgsl:3: " + msg);
    console.log("  compile error: " + msg.split("\n").find((l) => l.includes("kernel.wgsl:")).trim().slice(0, 100));
    const ref = (yaml) => yaml.split("reference:")[1].split("content: |\n")[1].split("\n").filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("        ") || !x.trim())).map((l) => l.slice(8)).join("\n");
    await editor((m, ed, code) => ed.getModel().setValue(code), ref((await tool("get_problem", { problem_id: id })).yaml));
    await page.waitForTimeout(700);
    await page.keyboard.press("ControlOrMeta+Enter");
    const gpuStatus = await resultStatus();
    console.log("  result:", (await page.locator(".result-head").innerText()).replace(/\s+/g, " "));
    if (gpuStatus !== "Accepted") throw new Error(`${id}: expected Accepted, got ${gpuStatus}`);
    await page.screenshot({ path: `${SHOTS}/lc-browser-webgpu.png` });
    const mm = await tool("run_tests", {});
    if (mm.status !== "passed") throw new Error("matmul reference: " + JSON.stringify(mm).slice(0, 500));
    console.log("  matmul metrics:", JSON.stringify(mm.metrics));
  }

  step("problems that need native executors are marked");
  await page.goto(APP + "/");
  await page.locator(".problem-row", { hasText: "Decode with a KV Cache" }).getByText("server edition").waitFor();

  step("offline: service workers cache the app and Python; a run works without the network");
  await page.goto(APP + "/p/" + PID);
  await page.locator(".monaco-editor").first().waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const runnerFrame = () => page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).origin !== new URL(APP).origin);
  await page.waitForFunction(() => document.querySelector("iframe[title='leegen runner']"));
  for (let i = 0; i < 100 && !runnerFrame(); i++) await page.waitForTimeout(100);
  const precached = await runnerFrame().evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    // wait for the install (precache) to finish
    for (let i = 0; i < 600 && !reg.active; i++) await new Promise((r) => setTimeout(r, 100));
    const keys = await caches.keys();
    let n = 0;
    for (const k of keys) n += (await (await caches.open(k)).keys()).length;
    return n;
  });
  console.log(`  runner cache: ${precached} files`);
  await context.setOffline(true);
  await page.reload();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getValue().includes("sorted(bookings)")));
  const offline = await tool("run_tests", { problem_id: PID });
  console.log(`  offline run: ${offline.status} (${offline.passed}/${offline.total})`);
  if (offline.status !== "passed") throw new Error("offline run: " + JSON.stringify(offline).slice(0, 400));
  const offlineValidate = await tool("validate_problem_yaml", { yaml: (await tool("get_problem", { problem_id: "iterators-and-await" })).yaml });
  if (!offlineValidate.ok) throw new Error("offline validation (loads pytest): " + JSON.stringify(offlineValidate.issues));
  await context.setOffline(false);

  const unexpected = problems.filter((p) => !/Failed to load resource/.test(p));
  if (unexpected.length) throw new Error("console errors:\n" + unexpected.join("\n"));
  console.log("\nbrowser smoke: OK");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/lc-browser-failure.png` }).catch(() => undefined);
  console.error("\nbrowser smoke: FAILED\n", e.message);
  if (problems.length) console.error(problems.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
