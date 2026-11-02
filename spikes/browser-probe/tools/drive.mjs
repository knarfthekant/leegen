// Headless check of the probe page with the installed Chrome. Prints the report JSON.
//   node --preserve-symlinks spikes/browser-probe/tools/drive.mjs [url]
// Resolves playwright-core from web/node_modules (already a dev dependency there).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../web/package.json"));
const { chromium } = require("playwright-core");

const url = process.argv[2] || "http://localhost:13380/";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebMCPTesting"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => {
  const raw = document.getElementById("raw")?.textContent;
  try { return JSON.parse(raw).generatedAt; } catch { return false; }
}, null, { timeout: 180_000 });
const report = JSON.parse(await page.textContent("#raw"));
console.log(JSON.stringify(report, null, 1));
if (logs.length) console.error("--- console ---\n" + logs.join("\n"));
await browser.close();
