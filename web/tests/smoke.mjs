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
  // cases are numbered, so they show a description and no title
  await page.locator(".case", { hasText: "example from the statement" }).waitFor();
  if (await page.locator(".case-name").count()) throw new Error("test titles should be gone");

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

  step("comments: character ranges, one mark each, overlaps stay visible");
  await page.getByRole("tab", { name: "Testcase" }).click();
  const lines = SOLUTION.split("\n");
  const col = lines[2].indexOf("sorted(bookings)") + 1; // `for start, end in sorted(bookings):`
  await call("annotate", { problem_id: PID, annotations: [
    { file: "solution.py", start_line: 3, start_col: col, end_col: col + 16, severity: "hint", message: "Sorting is the key step." },
    // overlaps the first one on `(bookings)`
    { file: "solution.py", start_line: 3, start_col: col + 6, end_col: col + 17, severity: "error", message: "The call and colon." },
    // no columns: the text of the line, without indentation
    { file: "solution.py", start_line: 6, severity: "praise", message: "Good merge." },
    // two lines: one connected bar
    { file: "solution.py", start_line: 4, end_line: 5, severity: "warning", message: "Check this branch." },
  ] });
  await page.getByRole("tab", { name: /Review/ }).waitFor();
  const editorEval = (fn, arg) => page.evaluate(`(() => {
    const m = window.monaco, ed = m.editor.getEditors().find((e) => !e.getOption(m.editor.EditorOption.readOnly));
    return (${fn.toString()})(m, ed, ${JSON.stringify(arg ?? null)});
  })()`);
  const decos = () => editorEval((m, ed) => {
    const model = ed.getModel();
    return model.getAllDecorations().filter((d) => d.options.className?.includes("lc-ann") || d.options.glyphMarginClassName?.includes("lc-glyph"))
      .map((d) => ({ cls: d.options.className ?? "", glyph: d.options.glyphMarginClassName ?? "", lane: d.options.glyphMargin?.position ?? 0,
                     line: d.range.startLineNumber, text: model.getValueInRange(d.range) }));
  });
  await page.waitForFunction(() => window.monaco.editor.getEditors().some((e) => e.getModel().getAllDecorations().some((d) => d.options.className?.includes("lc-ann"))));
  let d = await decos();
  const layer = (sev) => d.find((x) => x.cls.includes("lc-ann") && x.cls.includes(`lc-sev-${sev}`));
  const marks = (sev) => d.filter((x) => x.glyph.includes(`lc-sev-${sev}`));
  if (layer("hint").text !== "sorted(bookings)") throw new Error("hint covers " + JSON.stringify(layer("hint").text));
  if (layer("error").text !== "(bookings):") throw new Error("error covers " + JSON.stringify(layer("error").text));
  if (layer("praise").text !== "else:") throw new Error("a comment without columns should cover the text only: " + JSON.stringify(layer("praise").text));
  if (!layer("warning").text.startsWith("if merged") || !layer("warning").text.endsWith("end)")) throw new Error("multi-line text range: " + JSON.stringify(layer("warning").text));
  for (const sev of ["hint", "error", "praise"]) if (marks(sev).length !== 1 || !marks(sev)[0].glyph.includes("lc-glyph-dot")) throw new Error(`${sev} should have exactly one dot`);
  const bar = marks("warning").map((x) => x.glyph.match(/lc-glyph-(start|mid|end|dot)/)[1]).join(",");
  if (bar !== "start,end") throw new Error("a two-line comment should be a start+end bar, got " + bar);
  if (marks("hint")[0].lane === marks("error")[0].lane) throw new Error("overlapping comments must use different gutter lanes");
  console.log("  ranges ok:", ["hint", "error", "praise", "warning"].map((s) => JSON.stringify(layer(s).text.slice(0, 18))).join(" "));
  await page.screenshot({ path: `${SHOTS}/lc-smoke-overlap.png` });

  const px = (line, column) => editorEval((m, ed, [l, c]) => {
    const p = ed.getScrolledVisiblePosition({ lineNumber: l, column: c });
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.left + p.left + 2, y: r.top + p.top + p.height / 2 };
  }, [line, column]);
  const clickAt = async (line, column) => { const p = await px(line, column); await page.mouse.click(p.x, p.y); };
  const focused = async () => (await page.locator(".review-item.selected").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  const darkened = async () => (await decos()).filter((x) => x.cls.includes("lc-sel") || x.glyph.includes("lc-sel")).length;
  const expectFocus = async (what, msg, marks = 1) => {
    await page.waitForTimeout(200);
    const f = await focused();
    if (what ? !(f.length === 1 && f[0].includes(what)) : f.length) throw new Error(`${msg}: focused = ${JSON.stringify(f)}`);
    if ((await darkened()) !== (what ? 1 + marks : 0)) throw new Error(`${msg}: expected ${what ? `text layer + ${marks} mark(s)` : "nothing"} darkened`);
  };

  step("hover peek shows every comment under the pointer");
  const both = await px(3, col + 8);
  await page.mouse.move(both.x, both.y);
  await page.locator(".monaco-hover", { hasText: "Sorting is the key step." }).waitFor();
  const peek = await page.locator(".monaco-hover").first().innerText();
  if (!peek.includes("The call and colon.")) throw new Error("peek should list the overlapping comment too: " + peek);

  step("click focuses a comment (darkens it, no outline); clicking again unfocuses");
  await clickAt(3, col + 1); // only the hint covers this
  await expectFocus("Sorting is the key step.", "click on a comment");
  const outline = await page.evaluate(() => { const el = document.querySelector(".lc-ann.lc-sel"); return el ? getComputedStyle(el).outlineStyle : "none"; });
  if (outline !== "none") throw new Error("a focused comment should not have an outline");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/lc-smoke-review.png` });
  await clickAt(3, col + 1);
  await expectFocus(null, "second click on the focused comment");

  step("other ways to unfocus: click elsewhere in the editor, Escape, click the Review row again");
  await clickAt(3, col + 1);
  await expectFocus("Sorting is the key step.", "refocus");
  await clickAt(1, 3); // plain code, no comment
  await expectFocus(null, "click on plain code");
  await clickAt(3, col + 1);
  await page.keyboard.press("Escape");
  await expectFocus(null, "Escape");
  await page.locator(".review-item", { hasText: "Good merge." }).click();
  await expectFocus("Good merge.", "Review row click");
  await page.locator(".review-item", { hasText: "Good merge." }).click();
  await expectFocus(null, "Review row clicked again");
  await page.locator(".review-item", { hasText: "Good merge." }).click();
  await page.locator(".review").click({ position: { x: 4, y: 4 } });
  await expectFocus(null, "click on empty Review space");

  step("overlapped comments: clicking the overlap steps through them, then unfocuses");
  await clickAt(3, col + 8);
  await expectFocus("The call and colon.", "overlap, first click (smaller range first)");
  await clickAt(3, col + 8);
  await expectFocus("Sorting is the key step.", "overlap, second click");
  await clickAt(3, col + 8);
  await expectFocus(null, "overlap, third click");

  step("the gutter bar focuses its comment");
  const barBox = await page.locator(".lc-glyph-end.lc-sev-warning").boundingBox();
  await page.mouse.click(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
  await expectFocus("Check this branch.", "gutter bar", 2); // the whole bar darkens
  await page.keyboard.press("Escape");
  await call("clear_annotations", { problem_id: PID });

  console.log("SMOKE OK");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/lc-smoke-failure.png` });
  console.error("SMOKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
