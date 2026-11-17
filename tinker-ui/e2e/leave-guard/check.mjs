// The leave guard in a real browser (src/leave-guard.ts): the page is never replaced by a link.
// A tiny page under /tinker/ loads the real guard module with stand-ins for its reports, and Chromium is
// driven through each way of leaving:
//   T1 a click on a link with no new-tab mark: the page stays, the link loads in a new tab, a report is made,
//      a notice is shown and a fix is asked for; a second click on the same kind of link asks for no second fix
//   T2 a click on a link that already opens a new tab: nothing is reported
//   T3 a script sets the address: the page stays and a report says a script tried
//   T4 Back asks first (the browser's own question); staying keeps the page
//   T5 the page's own reload and a reload from the keyboard do not ask
//   T6 the app's own page under /tinker/ (sign-in) loads in this tab, with no question
//   T7 in the phone layout nothing asks: Back leaves at once
// node tinker-ui/e2e/leave-guard/check.mjs      (Pi: PW_CHROMIUM=/usr/bin/chromium)
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const esbuild = require("esbuild");
const { chromium } = createRequire(new URL("../../../package.json", import.meta.url))("playwright");

const bundle = (
  await esbuild.build({
    entryPoints: [new URL("../../src/leave-guard.ts", import.meta.url).pathname],
    bundle: true,
    format: "iife",
    globalName: "LG",
    write: false,
  })
).outputFiles[0].text;

const APP = `<!doctype html><title>app</title><body>
<a id="bare" href="/other.html?n=1">bare link</a>
<a id="bare2" href="/other.html?n=2">second bare link</a>
<a id="marked" href="/other.html?n=3" target="_blank" rel="noopener">marked link</a>
<button id="go">script</button> <button id="reload">reload</button>
<script>${bundle}</script>
<script>
  window.__log = { reports: [], notices: [], fixes: [] };
  LG.installLeaveGuard({
    win: window, doc: document, appBase: "/tinker/",
    sessionKey: () => "agent:main:tinker:test",
    askOnLeave: () => !document.body.classList.contains("phone"),
    report: async (r) => { __log.reports.push(r); return "/tmp/report.json"; },
    notify: (text, url) => __log.notices.push({ text, url }),
    askFix: async (key, text) => { __log.fixes.push({ key, text }); },
  });
  document.getElementById("go").onclick = () => { location.href = "/other.html?script=1"; };
  document.getElementById("reload").onclick = () => { LG.allowLeave(); location.reload(); };
</script>`;
const server = http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      req.url.startsWith("/tinker/login")
        ? "<title>login</title>sign in"
        : req.url.startsWith("/tinker/")
          ? APP
          : `<title>other</title>other ${req.url}`,
    );
  })
  .listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let failed = false;
const check = (ok, what, got) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${got !== undefined ? `   [${got}]` : ""}`);
  if (!ok) failed = true;
};
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const log = () => page.evaluate(() => window.__log);
await page.goto(`${ORIGIN}/other.html?start=1`);
await page.goto(`${ORIGIN}/tinker/`);

// T1
let [tab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null),
  page.click("#bare"),
]);
await page.waitForTimeout(400);
let l = await log();
check(
  page.url() === `${ORIGIN}/tinker/` && !!tab && tab.url().includes("/other.html?n=1"),
  "T1a a bare link leaves the page in place and loads in a new tab",
  `page ${page.url()} tab ${tab?.url()}`,
);
check(
  l.reports.length === 1 &&
    l.reports[0].how === "link" &&
    l.reports[0].element.includes('id="bare"') &&
    l.notices.length === 1 &&
    l.fixes.length === 1 &&
    l.fixes[0].text.startsWith("⟦AGENT:🛡 Leave guard"),
  "T1b one report, one notice, one request for a fix",
  `reports ${l.reports.length} notices ${l.notices.length} fixes ${l.fixes.length}`,
);
await tab?.close();
[tab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null),
  page.click("#bare2"),
]);
await page.waitForTimeout(400);
l = await log();
check(
  page.url() === `${ORIGIN}/tinker/` && !!tab && l.reports.length === 2 && l.fixes.length === 1,
  "T1c the same fault again: reported, no second request for a fix",
  `reports ${l.reports.length} fixes ${l.fixes.length}`,
);
await tab?.close();

// T2
[tab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null),
  page.click("#marked"),
]);
await page.waitForTimeout(300);
l = await log();
check(
  page.url() === `${ORIGIN}/tinker/` && !!tab && l.reports.length === 2,
  "T2 a link that already opens a new tab is not reported",
  `reports ${l.reports.length}`,
);
await tab?.close();

// T3
[tab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null),
  page.click("#go"),
]);
await page.waitForTimeout(600);
l = await log();
check(
  page.url() === `${ORIGIN}/tinker/` &&
    l.reports.length === 3 &&
    l.reports[2].how === "script" &&
    l.reports[2].url.includes("script=1"),
  "T3 a script that sets the address is stopped and reported",
  `page ${page.url()} how ${l.reports[2]?.how} newTab ${!!tab}`,
);
await tab?.close();

// T4
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.type());
  void d.dismiss();
});
await page.evaluate(() => history.back());
await page.waitForTimeout(1200);
l = await log().catch(() => null);
check(
  dialogs.includes("beforeunload") &&
    page.url() === `${ORIGIN}/tinker/` &&
    l?.reports.at(-1)?.how === "asked",
  "T4 Back asks first, and staying keeps the page",
  `dialogs ${dialogs} page ${page.url()} last ${l?.reports.at(-1)?.how}`,
);

// T5
dialogs.length = 0;
await page.click("#reload");
await page.waitForTimeout(800);
check(
  dialogs.length === 0 && page.url() === `${ORIGIN}/tinker/` && (await log()).reports.length === 0,
  "T5a the page's own reload does not ask",
  `dialogs ${dialogs}`,
);
await page.mouse.click(300, 300); // a click on the page, so the browser would be allowed to ask
await page.keyboard.press("F5");
await page.waitForTimeout(800);
check(
  dialogs.length === 0 && page.url() === `${ORIGIN}/tinker/` && (await log()).reports.length === 0,
  "T5b a reload from the keyboard does not ask",
  `dialogs ${dialogs}`,
);

// T6
await page.evaluate(() => location.replace("/tinker/login"));
await page.waitForTimeout(600);
check(
  page.url() === `${ORIGIN}/tinker/login` && dialogs.length === 0,
  "T6 the app's own sign-in page loads in this tab, with no question",
  page.url(),
);

// T7
await page.goto(`${ORIGIN}/other.html?start=2`);
await page.goto(`${ORIGIN}/tinker/`);
await page.click("#marked").catch(() => {});
await page.evaluate(() => document.body.classList.add("phone"));
dialogs.length = 0;
await page.evaluate(() => history.back());
await page.waitForTimeout(1000);
check(
  dialogs.length === 0 && page.url().includes("/other.html?start=2"),
  "T7 in the phone layout Back leaves at once, with no question",
  `dialogs ${dialogs} page ${page.url()}`,
);

await browser.close();
server.close();
console.log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
