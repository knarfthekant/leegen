// End-to-end smoke test against a running server (default http://127.0.0.1:13370).
// Uses the locally installed Chrome via playwright-core (no browser download).
import { chromium } from "playwright-core";

const BASE = process.env.LEETCLAUDE_URL ?? "http://127.0.0.1:13370";
const SHOTS = process.env.SHOTS ?? "/tmp";
const PID = "merge-ranges";
const SOLUTION = `def merge_ranges(bookings):
    merged = []
    for start, end in sorted(bookings):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
`;

// Minimal MCP-over-HTTP client (streamable HTTP; replies may be JSON or a single SSE event).
async function mcpSession() {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = async (body, extra = {}) => {
    const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const text = await r.text();
    const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
    return { sid: r.headers.get("mcp-session-id"), msg: line ? JSON.parse(line) : null };
  };
  const init = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
  });
  const extra = init.sid ? { "mcp-session-id": init.sid } : {};
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra);
  let n = 1;
  return async (name, args) => {
    const { msg } = await post({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, extra);
    if (msg?.result?.isError) throw new Error(`${name}: ${msg.result.content?.[0]?.text}`);
    return msg?.result?.structuredContent ?? msg?.result;
  };
}

const step = (msg) => console.log("•", msg);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

try {
  // reset server state for a deterministic run
  const call = await mcpSession();
  await call("clear_annotations", { problem_id: PID });
  await fetch(`${BASE}/api/workspace/${PID}/reset`, { method: "POST" });
  await fetch(`${BASE}/api/workspace/${PID}/custom_tests`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tests: [] }),
  });

  step("list page shows the seed problems");
  await page.goto(BASE + "/");
  await page.getByText("Merge Booking Ranges").first().waitFor();

  step("open problem");
  await page.getByText("Merge Booking Ranges").first().click();
  await page.locator(".title", { hasText: "Merge Booking Ranges" }).waitFor();
  await page.locator(".katex").first().waitFor();

  if (await page.getByRole("button", { name: "Reject" }).isVisible().catch(() => false)) {
    step("reject the pending AI suggestion");
    await page.getByRole("button", { name: "Reject" }).click();
  }
  await page.locator(".monaco-editor").first().waitFor();

  step("type a solution into the editor");
  await page.locator(".monaco-editor .view-lines").first().click();
  // setValue goes through the same change events as typing, without auto-indent getting in the way
  await page.evaluate((code) => {
    const ed = window.monaco.editor.getEditors().find((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly));
    ed.getModel().setValue(code);
    ed.focus();
  }, SOLUTION);
  await page.waitForTimeout(700); // autosave debounce

  step("run with ⌘↵ and expect all tests to pass");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.locator(".result-status").waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Running…"), null, { timeout: 60000 });
  const status = await page.locator(".result-status").innerText();
  const summary = await page.locator(".result-head").innerText();
  console.log("  result:", summary.replace(/\s+/g, " "));
  if (status !== "Accepted") throw new Error(`expected Accepted, got ${status}`);
  await page.screenshot({ path: `${SHOTS}/lc-smoke-passed.png` });

  step("sections group the test cases, with descriptions");
  await page.getByRole("tab", { name: "Testcase" }).click();
  await page.locator(".group-head", { hasText: "Basics" }).waitFor();
  await page.locator(".group-desc", { hasText: "examples from the statement" }).waitFor();
  const heads = await page.locator(".group-head").allInnerTexts();
  console.log("  sections:", heads.map((h) => h.replace(/\s+/g, " ")).join(" | "));
  await page.locator(".group-head", { hasText: "Basics" }).click(); // collapse
  if (await page.locator(".group-desc", { hasText: "examples from the statement" }).count()) throw new Error("section did not collapse");
  await page.locator(".group-head", { hasText: "Basics" }).click();
  await page.locator(".pill", { hasText: "Test 1" }).first().click();
  await page.locator(".case-name", { hasText: "Example" }).waitFor();

  step("undo and redo buttons follow the edit history");
  const undo = page.getByRole("button", { name: /^Undo/ });
  const redo = page.getByRole("button", { name: /^Redo/ });
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors().find((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly));
    ed.focus();
    ed.executeEdits("smoke", [{ range: new window.monaco.Range(1, 1, 1, 1), text: "# edit\n" }]);
    ed.pushUndoStop();
  });
  await page.waitForFunction(() => !document.querySelector('button[aria-label^="Undo"]').disabled);
  await undo.click();
  const afterUndo = await page.evaluate(() => window.monaco.editor.getEditors().find((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly)).getValue());
  if (afterUndo.includes("# edit")) throw new Error("undo button did not undo");
  await page.waitForFunction(() => !document.querySelector('button[aria-label^="Redo"]').disabled);
  await redo.click();
  const afterRedo = await page.evaluate(() => window.monaco.editor.getEditors().find((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly)).getValue());
  if (!afterRedo.includes("# edit")) throw new Error("redo button did not redo");
  await undo.click(); // leave the solution as it was
  await page.waitForTimeout(700);

  step("add a custom test case (expected comes from the reference)");
  await page.getByRole("tab", { name: "Testcase" }).click();
  await page.getByRole("button", { name: "Add test case" }).click();
  const ta = page.locator("textarea.field-input").first();
  await ta.fill("[[4, 5], [1, 4]]");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("tab", { name: "Test Result" }).click();
  // 7 built-in tests, so the custom case is Test 8 (named "Test 1" by the server)
  await page.locator(".pill", { hasText: "Test 8" }).waitFor({ timeout: 60000 });
  await page.locator(".pill", { hasText: "Test 8" }).click();
  const caseText = await page.locator(".case").innerText();
  if (!caseText.includes("[[1, 5]]")) throw new Error("custom case expected [[1, 5]]:\n" + caseText);
  console.log("  custom case ok:", caseText.split("\n").filter(Boolean).slice(0, 8).join(" | "));
  await page.screenshot({ path: `${SHOTS}/lc-smoke-custom.png` });

  step("precise annotations: highlight, hover peek, click opens the Review item");
  await page.getByRole("tab", { name: "Testcase" }).click();
  // line 3 of the solution: `    for start, end in sorted(bookings):`; mark just `sorted(bookings)`
  const col = SOLUTION.split("\n")[2].indexOf("sorted(bookings)") + 1;
  await call("annotate", { problem_id: PID, annotations: [
    { file: "solution.py", start_line: 3, start_col: col, end_col: col + "sorted(bookings)".length, severity: "hint", message: "Sorting is the key step." },
    { file: "solution.py", start_line: 6, severity: "praise", message: "Good merge." },
  ] });
  await page.getByRole("tab", { name: /Review/ }).waitFor();
  const hl = page.locator(".lc-ann-text.lc-ann-hint");
  await hl.first().waitFor();
  // Monaco splits an inline decoration into one span per token; together they cover the range
  const marked = (await hl.allInnerTexts()).join("");
  if (marked !== "sorted(bookings)") throw new Error(`character range highlighted ${JSON.stringify(marked)}`);
  await hl.first().hover();
  await page.locator(".monaco-hover", { hasText: "Sorting is the key step." }).waitFor();
  await page.screenshot({ path: `${SHOTS}/lc-smoke-peek.png` });
  await hl.first().click();
  await page.locator(".review-item.selected", { hasText: "Sorting is the key step." }).waitFor();
  const loc = await page.locator(".review-item.selected .loc").innerText();
  if (!loc.includes(`3:${col}`)) throw new Error("location label lacks the columns: " + loc);
  await page.waitForTimeout(300); // let the highlight transition finish
  await page.screenshot({ path: `${SHOTS}/lc-smoke-review.png` });
  // and back: clicking the list item selects the exact characters in the editor
  await page.locator(".review-item", { hasText: "Good merge." }).click();
  await page.locator(".review-item.selected", { hasText: "Good merge." }).waitFor();
  await page.locator(".review-item", { hasText: "Sorting is the key step." }).click();
  const picked = await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors().find((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly));
    return ed.getModel().getValueInRange(ed.getSelection());
  });
  if (picked !== "sorted(bookings)") throw new Error(`Review click selected ${JSON.stringify(picked)}`);
  await call("clear_annotations", { problem_id: PID });

  console.log("SMOKE OK");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/lc-smoke-failure.png` });
  console.error("SMOKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
