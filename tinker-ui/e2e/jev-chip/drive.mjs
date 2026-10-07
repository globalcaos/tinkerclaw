/**
 * Drives the built tinker-ui against mock-gateway.mjs (same folder) through the JEV CHIP contract (Jev ships dormant, phase C,
 * FORK 2026-10-06): a compact chip beside the composer that says whether Jev is off (no token), checking, on or refused, and
 * follows the gateway's `jev.status` event without a reload.
 *
 *   J1  at load, with no token, the chip reads "Jev: off — no token" and its hint carries what is off and where the token goes
 *   J2  an arming event turns it to "Jev: on" with no reload; a refused token reads "Jev: off — token refused"; and back
 *   J3  the chip sits in the composer row, on one line, inside the viewport, not over the Send button or the text box
 *   J4  after a reload the state comes back from the gateway, not from the page
 *   J5  the page asked `jev.status` and sent no chat.send, abort or inject; no page errors
 *   J6  the status text never carries a token
 *
 * `--mode control` runs the same checks' inverse on a build WITHOUT the feature (develop): no chip, no `jev.status` asked.
 * `--mode old-gateway` runs the new page against a gateway that does not know `jev.status` (start the mock with --no-jev):
 * no chip, nothing broken, no page error.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18998 --out /tmp/jev-e2e [--mode new|control|old-gateway]
 * Exit code 1 when an assertion fails.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18998";
const OUT = args.out ?? "/tmp/jev-e2e";
const MODE = args.mode ?? "new";
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const post = (path, body) =>
  fetch(`${URL_}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
const frames = () => fetch(`${URL_}/__mock/frames`).then((r) => r.json());

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const chip = () =>
  page.evaluate(() => {
    const el = document.querySelector("#amy-dot-host .jev-chip");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const send = document.getElementById("action-btn")?.getBoundingClientRect();
    const box = document.getElementById("chat-textarea")?.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight);
    const over = (a, b) =>
      b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return {
      text: el.textContent.trim(),
      cls: el.className,
      title: el.getAttribute("title") ?? "",
      state: el.getAttribute("data-jev-state"),
      lines: Math.round(r.height / lh),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      overSend: over(r, send),
      overBox: over(r, box),
      inComposerRow: !!el.closest(".chat-input"),
      color: cs.color,
      box: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  });
const shoot = (name) => page.locator(".chat-input").screenshot({ path: `${OUT}/${name}.png` });
const settle = () => page.waitForTimeout(900);

await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
await page.waitForFunction(() => document.getElementById("chat-textarea"), null, {
  timeout: 20000,
});
await page.waitForFunction(
  () => document.querySelectorAll("#messages .msg.user").length >= 3,
  null,
  { timeout: 20000 },
);
await page.waitForTimeout(1500);

if (MODE === "control" || MODE === "old-gateway") {
  let c = await chip();
  check(c === null, `C1. no chip is drawn (${MODE})`, JSON.stringify(c));
  await post("/__mock/jev", { state: "armed", keySource: "env" });
  await settle();
  c = await chip();
  check(c === null, "C2. a jev.status event draws nothing here either", JSON.stringify(c));
  const f = await frames();
  if (MODE === "control")
    check(
      !f.includes("jev.status"),
      "C3. the page never asked jev.status",
      `asked=${f.includes("jev.status")}`,
    );
  else
    check(
      f.includes("jev.status"),
      "C3. the page asked jev.status and the gateway said unknown method",
      `asked=${f.includes("jev.status")}`,
    );
  check(pageErrors.length === 0, "C4. no page errors", pageErrors.slice(0, 3).join(" | "));
  check(
    await page.evaluate(
      () => !!document.getElementById("amy-dot-host") && !!document.getElementById("action-btn"),
    ),
    "C5. the composer is intact",
  );
  await shoot(`${MODE}-composer`);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
  process.exit(failures.length ? 1 : 0);
}

// J1 ── dormant at load.
let c = await chip();
await shoot("new-1-dormant");
check(
  !!c && c.state === "dormant" && c.text === "Jev: off — no token",
  "J1a. dormant at load reads 'Jev: off — no token'",
  JSON.stringify(c?.text),
);
check(
  !!c &&
    /enables: safety checks, routing reads, recipe ranking/.test(c.title) &&
    c.title.includes("/home/demo/.openclaw/jev/token") &&
    /restart/.test(c.title),
  "J1b. the hint names what is off, where the token goes, and that env needs a restart",
  JSON.stringify(c?.title),
);
check(!!c && /jev-chip--off/.test(c.cls), "J1c. drawn in the muted 'off' style", c?.cls);
check(
  !!c && !/http/.test(c.title),
  "J1d. no token pointer unless the owner configured one",
  c?.title,
);

// J3 ── placement.
check(
  !!c && c.inComposerRow && c.lines === 1 && c.inViewport && !c.overSend && !c.overBox,
  "J3. in the composer row, one line, inside the viewport, not over Send or the text box",
  JSON.stringify(
    c && {
      row: c.inComposerRow,
      lines: c.lines,
      vp: c.inViewport,
      overSend: c.overSend,
      overBox: c.overBox,
      box: c.box,
    },
  ),
);

// J2 ── live changes.
await post("/__mock/jev", { state: "unverified", keySource: "file" });
await settle();
c = await chip();
await shoot("new-2-checking");
check(
  !!c && c.state === "unverified" && c.text === "Jev: on — checking",
  "J2a. a token found reads 'Jev: on — checking', no reload",
  JSON.stringify(c?.text),
);

await post("/__mock/jev", { state: "armed", keySource: "file" });
await settle();
c = await chip();
await shoot("new-3-armed");
check(
  !!c && c.state === "armed" && c.text === "Jev: on" && /jev-chip--on/.test(c.cls),
  "J2b. armed reads 'Jev: on', no reload",
  JSON.stringify(c?.text),
);

await post("/__mock/jev", { state: "armed", keySource: "file", breakerOpen: true });
await settle();
c = await chip();
check(
  !!c && c.text === "Jev: on — paused",
  "J2c. an open breaker reads 'Jev: on — paused'",
  JSON.stringify(c?.text),
);

await post("/__mock/jev", { state: "rejected", keySource: "file" });
await settle();
c = await chip();
await shoot("new-4-refused");
check(
  !!c &&
    c.state === "rejected" &&
    c.text === "Jev: off — token refused" &&
    /jev-chip--refused/.test(c.cls),
  "J2d. a refused token reads 'Jev: off — token refused'",
  JSON.stringify(c?.text),
);

await post("/__mock/jev", { state: "dormant", tokenHelpUrl: "https://example.test/get-a-token" });
await settle();
c = await chip();
check(
  !!c && c.state === "dormant" && c.title.includes("https://example.test/get-a-token"),
  "J2e. back to off; the owner's token pointer shows once configured",
  JSON.stringify(c?.title),
);

// J4 ── a reload gets it from the gateway.
await post("/__mock/jev", { state: "armed", keySource: "env" });
await settle();
await page.reload({ waitUntil: "load" });
await page.waitForFunction(
  () => document.querySelectorAll("#messages .msg.user").length >= 3,
  null,
  { timeout: 20000 },
);
await page.waitForTimeout(1500);
c = await chip();
await shoot("new-5-reloaded");
check(
  !!c && c.state === "armed" && c.text === "Jev: on",
  "J4. after a reload the chip comes back from the gateway",
  JSON.stringify(c?.text),
);

// J5 ── nothing was sent but reads.
const f = await frames();
const writes = f.filter((m) =>
  /^chat\.(send|abort|inject)$|^sessions\.(delete|reset|patch)$/.test(m),
);
check(
  f.includes("jev.status") && writes.length === 0,
  "J5a. the page asked jev.status and sent no chat.send, abort or inject",
  `writes=${JSON.stringify(writes)}`,
);
check(pageErrors.length === 0, "J5b. no page errors", pageErrors.slice(0, 3).join(" | "));

// J6 ── never a token in the page.
const html = await page.evaluate(() => document.getElementById("amy-dot-host")?.outerHTML ?? "");
check(!/tok-|apiKey|Bearer/.test(html), "J6. the chip carries no token", html.slice(0, 160));

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
