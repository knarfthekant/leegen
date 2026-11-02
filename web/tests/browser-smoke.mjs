// Browser-edition smoke test: the static build on two local origins with production headers.
//
//   uv run leetclaude browser build && uv run leetclaude browser serve    (from server/)
//   node tests/browser-smoke.mjs                                          (from web/)
//
// Fresh Chrome profile (empty IndexedDB). Uses the installed Chrome via playwright-core.
import { chromium } from "playwright-core";

const APP = process.env.LEETCLAUDE_APP ?? "http://localhost:13380";
const SHOTS = process.env.SHOTS ?? "/tmp";
const PID = "merge-ranges";
const PYTHON_SEEDS = ["merge-ranges", "iterators-and-await", "py-async-generators", "rate-limiter-service"];
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
tests:
  - name: small
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
  const r = await page.evaluate(([n, i]) => window.leetclaudeTools.call(n, i), [name, input]);
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const toolError = async (name, input) => {
  const r = await page.evaluate(([n, i]) => window.leetclaudeTools.call(n, i), [name, input]);
  if (!r.isError) throw new Error(`${name} should have failed`);
  return r.content[0].text;
};
const editor = (fn, arg) =>
  page.evaluate(`(() => {
    const m = window.monaco, ed = m.editor.getEditors().find((e) => !e.getOption(m.editor.EditorOption.readOnly));
    return (${fn.toString()})(m, ed, ${JSON.stringify(arg ?? null)});
  })()`);
const resultStatus = async () => {
  await page.locator(".result-status").waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Running…"), null, { timeout: 90_000 });
  return page.locator(".result-status").innerText();
};

try {
  step("list page loads the seeds from the static bundle into IndexedDB");
  await page.goto(APP + "/");
  await page.getByText("Merge Booking Ranges").first().waitFor();
  const isolated = await page.evaluate(() => crossOriginIsolated);
  if (!isolated) throw new Error("the app page is not cross-origin isolated");

  step("WebMCP: every manifest tool is registered on the top-level page");
  const registered = await page.evaluate(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = mc?.getTools ? await mc.getTools() : null;
    return { has: !!mc, names: tools ? tools.map((t) => t.name) : null, listed: window.leetclaudeTools.list().length };
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
  await tool("add_test_case", { args: [[[4, 5], [1, 4]]], description: "touching blocks" });
  const full = await tool("run_tests", { full: true });
  const custom = full.tests.find((t) => t.description === "touching blocks");
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

  step("WebGPU: WGSL editor, compile errors with locations, a passing kernel, GPU timing");
  const hasGpu = (await tool("list_executors")).executors[0].capabilities.includes("webgpu");
  if (!hasGpu) {
    console.log("  skipped: no WebGPU adapter in this browser");
  } else {
    for (const id of ["webgpu-vector-add", "webgpu-reduction", "webgpu-tiled-matmul"]) {
      const report = await tool("validate_problem_yaml", { yaml: (await tool("get_problem", { problem_id: id })).yaml });
      console.log(`  ${id}: ok=${report.ok} ${report.summary}`);
      if (!report.ok) throw new Error(`${id}: ${JSON.stringify(report.issues)}`);
    }
    await tool("open_problem", { problem_id: "webgpu-vector-add" });
    await page.locator(".title", { hasText: "Vector Add" }).waitFor();
    await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getModel()?.getLanguageId() === "wgsl"));
    await editor((m, ed) => ed.getModel().setValue("@compute @workgroup_size(64)\nfn main() {\n    let x: f32 = 1u;\n}\n"));
    await page.waitForTimeout(700);
    const broken = await tool("run_tests", {});
    const msg = broken.failing_tests[0]?.message ?? "";
    if (!/kernel\.wgsl:3:\d+/.test(msg)) throw new Error("compile errors should point at kernel.wgsl:3: " + msg);
    console.log("  compile error: " + msg.split("\n").find((l) => l.includes("kernel.wgsl:")).trim().slice(0, 100));
    const ref = (yaml) => yaml.split("reference:")[1].split("content: |\n")[1].split("\n").filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("        ") || !x.trim())).map((l) => l.slice(8)).join("\n");
    await editor((m, ed, code) => ed.getModel().setValue(code), ref((await tool("get_problem", { problem_id: "webgpu-vector-add" })).yaml));
    await page.waitForTimeout(700);
    await page.keyboard.press("ControlOrMeta+Enter");
    const gpuStatus = await resultStatus();
    console.log("  result:", (await page.locator(".result-head").innerText()).replace(/\s+/g, " "));
    if (gpuStatus !== "Accepted") throw new Error(`webgpu-vector-add: expected Accepted, got ${gpuStatus}`);
    await page.screenshot({ path: `${SHOTS}/lc-browser-webgpu.png` });
    await tool("open_problem", { problem_id: "webgpu-tiled-matmul" });
    await page.locator(".title", { hasText: "Tiled Matrix" }).waitFor();
    await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getModel()?.getLanguageId() === "wgsl"));
    await editor((m, ed, code) => ed.getModel().setValue(code), ref((await tool("get_problem", { problem_id: "webgpu-tiled-matmul" })).yaml));
    await page.waitForTimeout(700);
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
  const runnerFrame = () => page.frames().find((f) => f !== page.mainFrame() && f.url().includes(":13381"));
  await page.waitForFunction(() => document.querySelector("iframe[title='leetclaude runner']"));
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
  const offlineValidate = await tool("validate_problem_yaml", { yaml: (await tool("get_problem", { problem_id: "py-async-generators" })).yaml });
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
