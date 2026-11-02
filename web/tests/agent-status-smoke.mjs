// Agent activity end-to-end: isolated server at LEEGEN_URL, plus a browser build at BROWSER_DIST.
// LEEGEN_URL=http://127.0.0.1:13379 BROWSER_DIST=/tmp/leegen-agent-browser node tests/agent-status-smoke.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.LEEGEN_URL ?? "http://127.0.0.1:13370";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];

async function exercise(context, url, setStatus, edition) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator(".list-page").waitFor();
  const headerBefore = await page.locator(".topbar").boundingBox();
  if (edition === "browser") await page.locator(".codex-guide").waitFor();
  await setStatus(page, "creating_problem");
  await page.getByText("Agent is creating a problem", { exact: true }).waitFor();
  await page.getByText("Please wait", { exact: true }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".agent-banner")).transform === "none");
  const floating = await page.locator(".agent-banner").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return getComputedStyle(el).position === "fixed" && rect.bottom <= innerHeight
      && rect.bottom >= innerHeight - 24 && rect.width < innerWidth - 32;
  });
  assert.equal(floating, true, "Activity must float above the bottom edge without filling the page");
  assert.deepEqual(await page.locator(".topbar").boundingBox(), headerBefore, "Activity must not move the page or toolbar");
  if (edition === "browser") assert.equal(await page.locator(".codex-guide, .codex-guide-launcher").count(), 0);

  const second = await context.newPage();
  await second.goto(url);
  await second.getByText("Agent is creating a problem", { exact: true }).waitFor();
  await setStatus(page, "reviewing");
  for (const tab of [page, second]) await tab.getByText("Agent is reviewing your code", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Agent is reviewing your code", { exact: true }).waitFor();

  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `/tmp/leegen-agent-${edition}-${theme}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".agent-banner").evaluate((el) => el.getBoundingClientRect().right <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.ok(await page.locator(".agent-banner .spin").evaluate((el) => parseFloat(getComputedStyle(el).animationDuration) <= 0.001));
  await page.screenshot({ path: `/tmp/leegen-agent-${edition}-mobile.png`, animations: "disabled" });

  if (edition === "server") {
    await page.goto(url + "/p/merge-ranges");
    await page.locator(".monaco-editor").first().waitFor();
    await page.getByText("Agent is reviewing your code", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.monaco.editor.getEditors().some((e) => !e.getOption(window.monaco.editor.EditorOption.readOnly))), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "/tmp/leegen-agent-workspace.png", animations: "disabled" });
    await context.setOffline(true);
    await setStatus(page, "creating_problem");
    await context.setOffline(false);
    await page.getByText("Agent is creating a problem", { exact: true }).waitFor();
  }

  await setStatus(page, "idle");
  for (const tab of [page, second]) await tab.locator(".agent-banner").waitFor({ state: "detached" });
  if (edition === "browser") {
    await page.locator(".codex-guide").waitFor();
    await page.getByRole("button", { name: "Minimize Codex guide" }).click();
    await page.getByRole("button", { name: "Use with Codex" }).waitFor();
  }
  await page.clock.install();
  await setStatus(page, "reviewing");
  await page.locator(".agent-banner").waitFor();
  if (edition === "browser") assert.equal(await page.locator(".codex-guide, .codex-guide-launcher").count(), 0);
  await page.clock.fastForward(300_100);
  await page.locator(".agent-banner").waitFor({ state: "detached" });
  if (edition === "browser") await page.getByRole("button", { name: "Use with Codex" }).waitFor();
  console.log(`${edition}: bottom floating activity, unchanged page layout, live updates, reload, clear, expiry and themes passed${edition === "browser" ? "; Codex guide hides and restores its minimized state" : ""}`);
}

try {
  const server = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const setServerStatus = async (_page, status) => {
    const r = await fetch(`${BASE}/api/agent-status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
    assert.equal(r.ok, true);
  };
  try { await exercise(server, BASE, setServerStatus, "server"); }
  finally { await setServerStatus(null, "idle"); await server.close(); }

  if (process.env.BROWSER_DIST) {
    const manifest = JSON.parse(await readFile(new URL("../../contracts/tools.json", import.meta.url), "utf8"));
    const browserEdition = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await browserEdition.addInitScript(() => {
      // Exercise the registered WebMCP execute function, with the real manifest and validation.
      window.registeredTools = {};
      Object.defineProperty(document, "modelContext", { value: {
        registerTool(tool) { window.registeredTools[tool.name] = tool; },
      } });
    });
    await browserEdition.route("http://runner.leegen.test/**", (route) => route.fulfill({
      contentType: "text/html", body: `<!doctype html><script>
        parent.postMessage({type: 'lc-runner-loaded'}, '*');
        addEventListener('message', (e) => {
          const port = e.ports[0];
          if (port) port.onmessage = (m) => port.postMessage({id: m.data.id, result: {
            origin: location.origin, crossOriginIsolated: false, webgpu: false, version: 'test', python: null
          }});
        });</script>`,
    }));
    await browserEdition.route("http://browser.leegen.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/config.json") return route.fulfill({ json: { runner_origin: "http://runner.leegen.test", version: "test" } });
      if (path === "/data/bundle.json") return route.fulfill({ json: {
        version: "test", problems: [], environments: [], guides: {}, schema: {}, tools: manifest,
      } });
      const file = resolve(process.env.BROWSER_DIST, path === "/" ? "index.html" : path.slice(1));
      try {
        await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] });
      } catch { await route.fulfill({ status: 404, body: "Not found" }); }
    });
    const setBrowserStatus = async (page, status) => {
      await page.waitForFunction(() => !!window.registeredTools?.set_agent_status);
      const result = await page.evaluate((status) => window.registeredTools.set_agent_status.execute({ status }), status);
      assert.equal(result.isError, undefined);
    };
    await exercise(browserEdition, "http://browser.leegen.test", setBrowserStatus, "browser");
    await browserEdition.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
