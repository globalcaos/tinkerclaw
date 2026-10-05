/**
 * Inert-state DOM check: with a gateway that has no amygdala methods, the page must match the develop build — same panel,
 * same chat, same composer except for the one empty `#amy-dot-host` span. Needs two mock gateways: one serving this
 * branch's `dist`, one serving a build of develop's base commit (see README.md).
 * Usage: node inert-compare.mjs --ours http://127.0.0.1:18995 --base http://127.0.0.1:18996
 */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const NOW = Date.now();
const history = [
  {
    role: "user",
    content: [{ type: "text", text: "Please tidy the draft folder." }],
    timestamp: NOW - 60_000,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Done — the folder is tidy." }],
    timestamp: NOW - 45_000,
  },
];
const norm = (s) =>
  s
    .replace(/data-timestamp="[^"]*"/g, 'data-timestamp=""')
    .replace(/\d{2}:\d{2}:\d{2}/g, "")
    .replace(/\s*<span id="amy-dot-host"><\/span>/g, "");
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
async function grab(url) {
  await fetch(`${url}/__mock/state`, {
    method: "POST",
    body: JSON.stringify({ history, amygdala: false, status: null, feed: {} }),
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`${url}/tinker/`);
  await page.waitForSelector("#messages");
  await page.waitForTimeout(1500);
  const out = {};
  for (const [k, sel, inner] of [
    ["panel", "#amygdala-panel", false],
    ["messages", "#messages", true],
    ["composer", ".chat-input", false],
  ])
    out[k] = norm(
      await page.locator(sel).evaluate((e, i) => (i ? e.innerHTML : e.outerHTML), inner),
    );
  await page.close();
  return out;
}
const [ours, base] = [await grab(args.ours), await grab(args.base)];
let bad = 0;
for (const k of Object.keys(ours)) {
  const same = ours[k] === base[k];
  console.log(`${same ? "PASS" : "FAIL"}  inert ${k} matches develop`);
  if (!same) bad++;
}
await browser.close();
process.exit(bad ? 1 : 0);
