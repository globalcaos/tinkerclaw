/**
 * The unread glow across devices, end to end (FORK 2026-11-14). the architect: a chat opened on the phone
 * stayed green on the laptop, and the other way round.
 *
 * Touches nothing live. A temporary HOME holds a desk file with three tabs, two of them unread; the
 * chat-viewport mock gateway reports that every session finished a turn ten minutes ago; THIS
 * checkout's tinker-prod-ui serves the built page on a spare port. Two browser contexts are the two
 * devices, each with its own storage: a laptop and a phone-sized one (phone mode).
 *
 *  1. Both devices show the two unread chats.
 *  2. Opening chat B on the phone clears B's glow on the laptop within seconds, with no reload, and
 *     leaves C unread there.
 *  3. Opening chat C on the laptop clears the phone's "unread in another chat" mark.
 *  4. The desk file holds the later stamps, and a stale write (an older stamp) cannot lower them.
 *  5. tinker-prod-ui logged each push and the pages it reached.
 *
 * Usage: (cd tinker-ui && npx vite build) && node tinker-ui/e2e/tab-seen/drive.mjs
 * Browser: $CHROME, else /usr/bin/google-chrome, else /usr/bin/chromium. Exit code 1 when a check fails.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GW_PORT = 18997;
const UI_PORT = 18998;
const A = "agent:main:main";
const B = "agent:main:tinker:mockb";
const C = "agent:main:tinker:mockc";
const ENDED = Date.now() - 10 * 60_000;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it is true or `ms` runs out; answers whether it became true. */
const until = async (fn, ms = 8_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
};

// ─── The desk file: B and C finished after they were last seen, Main did not ───
const home = mkdtempSync(join(tmpdir(), "tab-seen-e2e-"));
const deskFile = join(home, ".openclaw/data/tinker-ui-state.json");
mkdirSync(dirname(deskFile), { recursive: true });
writeFileSync(
  deskFile,
  JSON.stringify({
    tabs: [
      { id: "tab-main", sessionKey: A, title: "🏠 Main", isAttached: true },
      { id: "tab-b", sessionKey: B, title: "Second", isAttached: true },
      { id: "tab-c", sessionKey: C, title: "Third", isAttached: true },
    ],
    choices: {
      "tab:active": "tab-main",
      "tab:seen": JSON.stringify({
        [A]: { s: ENDED + 1 },
        [B]: { s: ENDED - 60_000 },
        [C]: { s: ENDED - 60_000 },
      }),
    },
    flags: {},
    collapsed: {},
    closedTabs: {},
  }),
);
const seenInFile = () =>
  JSON.parse(JSON.parse(readFileSync(deskFile, "utf8")).choices["tab:seen"] ?? "{}");

// ─── Servers ───
const procs = [];
let prodLog = "";
const start = (argv, env, ready, sink) =>
  new Promise((ok, fail) => {
    const child = spawn("node", argv, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(child);
    let out = "";
    const t = setTimeout(() => fail(new Error(`${argv[0]} did not start: ${out}`)), 15_000);
    const on = (d) => {
      out += d;
      sink?.(String(d));
      if (ready.test(out)) {
        clearTimeout(t);
        ok();
      }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
  });
const cleanup = () => {
  for (const c of procs) c.kill();
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);

await start(
  [
    "tinker-ui/e2e/chat-viewport/mock-gateway.mjs",
    "--port",
    String(GW_PORT),
    "--dist",
    "tinker-ui/dist",
  ],
  {},
  /127\.0\.0\.1|listening|mock/i,
);
await fetch(`http://127.0.0.1:${GW_PORT}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ endedAt: ENDED }),
});
await start(
  ["scripts/tinker-prod-ui.mjs"],
  {
    HOME: home,
    TINKER_PROD_PORT: String(UI_PORT),
    TINKER_GATEWAY_PORT: String(GW_PORT),
    OPENCLAW_GATEWAY_TOKEN: "mock",
  },
  /production Tinker/,
  (d) => (prodLog += d),
);

// ─── Two devices ───
const executablePath =
  process.env.CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath });
const laptopCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const phoneCtx = await browser.newContext({
  viewport: { width: 412, height: 860 },
  isMobile: true,
  hasTouch: true,
});
const pageErrors = [];
const open = async (ctx, name) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  await page.goto(`http://127.0.0.1:${UI_PORT}/tinker/`);
  return page;
};
const laptop = await open(laptopCtx, "laptop");
const phone = await open(phoneCtx, "phone");
const laptopUnread = (id) => laptop.locator(`.tab[data-tab-id="${id}"].tab-unread`).count();
const phoneElsewhere = () => phone.locator("#phone-header .phone-unread-elsewhere").isVisible();

try {
  // 1. Both devices start with B and C unread.
  check(
    await until(
      async () => (await laptopUnread("tab-b")) === 1 && (await laptopUnread("tab-c")) === 1,
    ),
    "laptop: chats B and C glow as unread",
  );
  check(await until(phoneElsewhere), "phone: the header marks an unread result in another chat");
  await laptop.evaluate(() => {
    window.__tabSeenE2E = "same page";
  });

  // 2. Open B on the phone: B stops glowing on the laptop, C still glows, no reload.
  await phone.locator("#phone-chat-btn").click();
  await phone.locator('.phone-sheet-row[data-phone-tab="tab-b"]').click();
  const t0 = Date.now();
  check(
    await until(async () => (await laptopUnread("tab-b")) === 0),
    "laptop: B stops glowing after B is opened on the phone",
  );
  console.log(`      (laptop cleared B ${Date.now() - t0} ms after the tap on the phone)`);
  check((await laptopUnread("tab-c")) === 1, "laptop: C still glows (not opened anywhere yet)");
  check(
    (await laptop.evaluate(() => window.__tabSeenE2E)) === "same page",
    "laptop: cleared live, without a page reload",
  );

  // 3. Open C on the laptop: the phone's "unread in another chat" mark goes.
  await laptop.locator('.tab[data-tab-id="tab-c"]').click();
  check(
    await until(async () => !(await phoneElsewhere())),
    "phone: no unread mark left after C is opened on the laptop",
  );

  // 4. The file holds the later stamps; an older stamp written over them does not lower them.
  const seen = seenInFile();
  check(seen[B]?.s >= ENDED && seen[C]?.s >= ENDED, "desk file: B and C seen after they ended");
  const stale = JSON.parse(readFileSync(deskFile, "utf8"));
  stale.choices["tab:seen"] = JSON.stringify({ ...seen, [B]: { s: 5 } });
  const posted = await fetch(`http://127.0.0.1:${UI_PORT}/api/ui-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stale),
  });
  check(posted.ok, "a stale snapshot is accepted");
  check(seenInFile()[B]?.s === seen[B].s, "desk file: the stale write did not lower B's stamp");
  await sleep(1_500);
  check((await laptopUnread("tab-b")) === 0, "laptop: B is still read after the stale write");

  // 5. The pushes are on the record.
  check(
    /\[ui-state\] tab-seen raised \[[^\]]*mockb[^\]]*\] → 2 open page\(s\)/.test(prodLog),
    "tinker-prod-ui logged the push of B to both open pages",
  );
  check(
    pageErrors.length === 0,
    `no page errors${pageErrors.length ? `: ${pageErrors.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
