// Status UI regression checks. Start the server, then run:
// LEEGEN_URL=http://127.0.0.1:13370 node tests/status-smoke.mjs
// Include the browser edition with BROWSER_DIST=/path/to/browser/app.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.LEEGEN_URL ?? "http://127.0.0.1:13370";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

async function checkPanel(page, labels) {
  const trigger = page.getByLabel("Service status", { exact: true });
  await trigger.click();
  const panel = page.getByRole("group", { name: "Service details" });
  await panel.waitFor();
  for (const label of labels) assert.equal(await panel.getByText(label, { exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await panel.isVisible(), false);
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  await panel.waitFor();
  await trigger.click();
  assert.equal(await panel.isVisible(), false);
}

async function checkBadgesFit(page) {
  const fits = await page.locator(".service-status").evaluate((el) => {
    const header = el.closest("header").getBoundingClientRect();
    return [...el.querySelectorAll("summary, .service-issues button")].every((badge) => {
      const rect = badge.getBoundingClientRect();
      return rect.left >= header.left && rect.right <= header.right && rect.top >= header.top && rect.bottom <= header.bottom;
    });
  });
  assert.equal(fits, true, "Every status badge must remain visible inside the topbar");
}

try {
  await page.clock.install();
  let mcp = true;
  let reachable = true;
  await page.route("**/api/status", (route) => reachable
    ? route.fulfill({ json: { server: true, mcp } }) : route.abort());
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector(".service-count")?.textContent === "3/3");
  await checkPanel(page, ["Server", "MCP", "Live updates"]);

  mcp = false;
  await page.clock.runFor(15_100);
  const mcpIssue = page.getByRole("button", { name: "MCP offline", exact: true });
  await mcpIssue.waitFor();
  assert.equal(await page.locator(".service-disclosure").getAttribute("open"), null);
  await mcpIssue.click();
  await page.getByRole("group", { name: "Service details" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await mcpIssue.isVisible(), true);

  await page.getByLabel("Service status", { exact: true }).click();
  await page.getByRole("heading").first().click();
  assert.equal(await page.getByRole("group", { name: "Service details" }).isVisible(), false);

  mcp = true;
  await page.clock.runFor(15_100);
  await page.waitForFunction(() => !document.querySelector(".service-issues")?.textContent);

  reachable = false;
  await page.clock.runFor(15_100);
  await page.getByText("Server offline", { exact: true }).waitFor();
  await mcpIssue.waitFor();
  reachable = true;
  await page.clock.runFor(15_100);
  await page.waitForFunction(() => document.querySelector(".service-count")?.textContent === "3/3");

  await page.goto(`${BASE}/p/merge-ranges`);
  await page.waitForFunction(() => document.querySelector(".service-count")?.textContent === "3/3");
  await checkPanel(page, ["Server", "MCP", "Live updates"]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByLabel("Service status", { exact: true }).click();
    await page.screenshot({ path: `/tmp/leegen-status-server-${theme}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
  }

  // A failed WebSocket must be visible even while the REST API stays healthy.
  const disconnected = await context.newPage();
  await disconnected.routeWebSocket("**/api/ws", (ws) => ws.close());
  await disconnected.goto(BASE);
  await disconnected.getByRole("button", { name: "Live updates offline", exact: true }).waitFor();
  await disconnected.getByText("Server online", { exact: true }).waitFor();
  await disconnected.route("**/api/status", (route) => route.fulfill({ json: { server: true, mcp: false } }));
  await disconnected.goto(`${BASE}/p/merge-ranges`);
  await disconnected.getByRole("button", { name: "MCP offline", exact: true }).waitFor();
  for (const width of [1440, 1024, 900]) {
    await disconnected.setViewportSize({ width, height: 900 });
    await checkBadgesFit(disconnected);
  }
  await disconnected.close();
  console.log("Server status: healthy, MCP failure, API failure, WebSocket failure, recovery, keyboard and both themes passed.");

  if (process.env.BROWSER_DIST) {
    const manifest = JSON.parse(await readFile(new URL("../../contracts/tools.json", import.meta.url), "utf8"));
    for (const mode of ["online", "unavailable", "partial", "registration-failed", "runner-offline"]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.clock.install();
      await p.addInitScript((mode) => {
        Object.defineProperty(document, "modelContext", { value: ["unavailable", "runner-offline"].includes(mode) ? undefined : {
          registerTool() {
            if (mode === "registration-failed" || (mode === "partial" && this.registered)) throw new Error("Registration failed");
            this.registered = true;
          },
        } });
        Object.defineProperty(navigator, "modelContext", { value: undefined });
      }, mode);
      await p.route("http://runner.leegen.test/**", (route) => route.fulfill({
        contentType: "text/html",
        body: mode === "runner-offline" ? "<!doctype html>Runner unavailable" : `<!doctype html><script>
          parent.postMessage({type: 'lc-runner-loaded'}, '*');
          addEventListener('message', (e) => {
            const port = e.ports[0];
            if (!port) return;
            port.onmessage = (m) => port.postMessage({id: m.data.id, result: {
              origin: location.origin, crossOriginIsolated: false, webgpu: false, version: 'test', python: null
            }});
          });
        </script>`,
      }));
      await p.route("http://browser.leegen.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/config.json") return route.fulfill({ json: { runner_origin: "http://runner.leegen.test", version: "test" } });
        if (path === "/data/bundle.json") return route.fulfill({ json: {
          version: "test", problems: [], environments: [], guides: {}, schema: {}, tools: manifest,
        } });
        const file = resolve(process.env.BROWSER_DIST, path === "/" ? "index.html" : path.slice(1));
        const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)];
        try { await route.fulfill({ body: await readFile(file), contentType }); }
        catch { await route.fulfill({ status: 404, body: "Not found" }); }
      });
      await p.goto("http://browser.leegen.test/");
      await p.getByText("Browser online", { exact: true }).waitFor();
      if (mode === "runner-offline") {
        await p.getByRole("button", { name: "Python runner connecting", exact: true }).waitFor();
        await p.clock.runFor(20_100);
        await p.getByRole("button", { name: "Python runner offline", exact: true }).waitFor();
        await p.getByRole("button", { name: "WebMCP unavailable", exact: true }).waitFor();
      } else if (mode === "online") {
        await p.waitForFunction(() => document.querySelector(".service-count")?.textContent === "3/3");
      } else {
        const state = mode === "partial" ? "partial" : mode === "registration-failed" ? "offline" : "unavailable";
        await p.getByRole("button", { name: `WebMCP ${state}`, exact: true }).waitFor();
      }
      await checkBadgesFit(p);
      await checkPanel(p, ["Browser", "Python runner", "WebMCP"]);
      for (const theme of ["light", "dark"]) {
        await p.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await p.getByLabel("Service status", { exact: true }).click();
        await p.screenshot({ path: `/tmp/leegen-status-browser-${mode}-${theme}.png`, animations: "disabled" });
        await p.keyboard.press("Escape");
      }
      await ctx.close();
    }
    console.log("Browser status: WebMCP online, unavailable, partial/failed registration and runner timeout passed.");
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
