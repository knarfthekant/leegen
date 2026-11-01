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

const step = (msg) => console.log("•", msg);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

try {
  // reset server state for a deterministic run
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

  step("add a custom test case (expected comes from the reference)");
  await page.getByRole("tab", { name: "Testcase" }).click();
  await page.getByRole("button", { name: "Add test case" }).click();
  const ta = page.locator("textarea.field-input").first();
  await ta.fill("[[4, 5], [1, 4]]");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator(".pill", { hasText: "Custom 1" }).waitFor({ timeout: 60000 });
  await page.locator(".pill", { hasText: "Custom 1" }).click();
  const caseText = await page.locator(".case").innerText();
  if (!caseText.includes("[[1, 5]]")) throw new Error("custom case expected [[1, 5]]:\n" + caseText);
  console.log("  custom case ok:", caseText.split("\n").filter(Boolean).slice(0, 8).join(" | "));
  await page.screenshot({ path: `${SHOTS}/lc-smoke-custom.png` });

  step("annotations from the AI are highlighted and listed");
  await fetch(`${BASE}/mcp`, { method: "GET" }).catch(() => undefined);
  const ann = await fetch(`${BASE}/api/workspace/${PID}`).then((r) => r.json());
  console.log("  annotations on server:", ann.annotations.length);
  await page.getByRole("tab", { name: /Review/ }).click();
  await page.screenshot({ path: `${SHOTS}/lc-smoke-review.png` });

  console.log("SMOKE OK");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/lc-smoke-failure.png` });
  console.error("SMOKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
