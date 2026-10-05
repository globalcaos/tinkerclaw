#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * FORK 2026-09-08 — ui-dup-proof: PROOF, on the live UI, that a REAL session paints every
 * assistant bubble exactly once and keeps doing so across repeated history reloads.
 *
 * INCIDENT 2026-09-08: the architect's long-lived tabs showed the same assistant answer two and
 * three times while `chat.history` held exactly one copy — per-tab STATE that no reading of the
 * code could disprove and no green build could rule out. This instrument turns "zero duplicates on
 * his real tabs" into a measurement: open the live UI, view the session the way a click does,
 * reload its history N times the way the app does (switch away and back through the sessions
 * rail — every rail click ends in switchToTab → applyTabSwitch → loadChat), and count.
 *
 *   node scripts/ui-dup-proof.mjs <sessionKey> [<sessionKey>...] [--cycles 5]
 *
 * WHEN TO MEASURE is not guessed. chat.history lands 3–6 s after the click here (live median
 * 2.7 s, max 20 s), and a count that sits at zero for two seconds is not "stable", it is "not
 * loaded yet". The app itself says when a reload has been merged — loadChat logs
 * `[dup-prov] history:reconcile {sessionKey, mode, added, …}` right after reconcileHistoryIntoPage —
 * so each cycle waits for THAT line for THIS key (60 s), then for 2 s in which neither the bubble
 * count nor the reconcile log moves. A cycle with no reconcile line is reported as such (busy
 * session → loadChat defers; transport failure → the degraded strip), never measured as zero.
 * The rail is likewise not trusted on first paint: it paints once from the hydrated tabs and
 * again when sessions.list lands, so the key is looked up only after the row count has settled.
 *
 * Per cycle, from the DOM under #messages: `.msg.assistant.msg-thinking` bubbles and
 * `.msg.assistant:not(.msg-thinking)` bubbles — total, distinct bodies, and duplicate PAIRS. A
 * pair is a duplicate when both bubbles carry the same server identity+part (data-oc-id /
 * data-oc-part, stamped by renderMsg from history-reconcile's historyRowIdentity: the same row
 * painted twice), or when their bodies are equal (>= 40 chars, the floor
 * scripts/snapshot-dup-census.py shares) and NOT both distinct stamped rows — that is a
 * client-written bubble joined by the server's copy, the class that doubled the tabs. Equal
 * bodies on two DISTINCT server rows are the transcript repeating itself; they are reported as
 * `legit` and never paint red. A body is the whitespace-normalised textContent, not innerText:
 * innerText changes with render state (a thinking bubble folded inside a closed <details> reads
 * differently from the same bubble unfolded), textContent does not.
 *
 * PASS iff every cycle saw its reconcile, has zero duplicate pairs in BOTH classes, the totals
 * never SHRINK across cycles (they may grow: a running session writes, paper only grows), every
 * cycle reached a stable count, and #messages carries a non-empty data-ui-build. Exit 1
 * otherwise. One table per session, then every console line starting with "[dup-prov]" or
 * "[hmr]" and every page error.
 *
 * WRITES NOTHING BUT STDOUT. The headless profile is a throwaway, and the two app paths that
 * would write files on the architect's behalf are both intercepted and answered locally:
 *   - POST /api/ui-state — the durable tab/ui-state mirror that every tab switch fires through
 *     saveTabs(). Left alone, a proof run would rewrite his real tab set. (Verified: the mirror
 *     file's mtime is identical before and after a run.) The read-only hydrate (GET) passes —
 *     it is what hands the page his real tabs.
 *   - debug.dumpUiSnapshot over the gateway WS — the render mirror behind
 *     ~/.openclaw/data/tinker-ui-snapshot.<slug>.html. Left alone, a headless render (often a
 *     still-empty page mid-load) overwrote the per-session snapshot of every session it touched,
 *     which is exactly the record scripts/snapshot-dup-census.py reads. The socket is proxied
 *     frame-for-frame; only that one request is answered with a synthetic ok.
 * No network beyond localhost. The gateway token is never printed — error text is redacted.
 */
import { chromium } from "playwright-core";

const CHROME =
  process.env.UI_SHOT_CHROME ||
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1134/chrome-linux/chrome");
let URL = process.env.UI_SHOT_URL || "http://localhost:18790";
// The dev UI authenticates via a ?token= param; pull the gateway token from
// openclaw.json so the headless instance connects like the real browser.
// (Token is appended to the URL but never printed.)
let TOKEN = "";
try {
  const tok =
    process.env.UI_SHOT_TOKEN ||
    JSON.parse(fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"))
      ?.gateway?.auth?.token;
  if (tok && !URL.includes("token=")) {
    TOKEN = String(tok);
    URL += (URL.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
  }
} catch {
  /* no token available */
}

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};
const cyclesRaw = argOf("--cycles");
const CYCLES = cyclesRaw === null ? 5 : Number(cyclesRaw);
const KEYS = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--cycles");
if (!KEYS.length || !Number.isInteger(CYCLES) || CYCLES < 0) {
  console.log("usage: node scripts/ui-dup-proof.mjs <sessionKey> [<sessionKey>...] [--cycles 5]");
  process.exit(2);
}

/** Scrub the token out of anything we print — Playwright error text embeds the full URL. */
const redact = (s) => {
  let t = String(s ?? "");
  if (TOKEN) {
    t = t.split(encodeURIComponent(TOKEN)).join("<token>").split(TOKEN).join("<token>");
  }
  return t;
};
/** Server rows are canonical (`agent:main:tinker:x`); a tab may hold the short form (`tinker:x`). */
const keyMatches = (a, b) => a === b || a.endsWith(":" + b) || b.endsWith(":" + a);

const ROWS = "#sessions-list .session-row";
const MIN_LEN = 40;
const STABLE_MS = 2000;
const RECONCILE_TIMEOUT_MS = 60000;
const RECONCILE_PREFIX = "[dup-prov] history:reconcile ";
/** Ceiling for the first rail paint. MEASURED 2026-09-08 (box load 11–14, gateway 32% CPU /
 *  7.4 GB RSS): a fresh WS upgrade + connect.challenge took 2–10 s, so the app's ~10 s connect
 *  watchdog killed roughly every other dial and re-dialled 2 s later; the rail landed on dial 1, 2
 *  or 3 (10–31 s after goto). An UNROUTED control showed the same latency, so it is the gateway,
 *  not the proxy below. 45 s covered three dials and failed twice; this outlasts ten. */
const ROWS_TIMEOUT_MS = 120000;
/** The gateway socket: GW_WS is `ws://localhost:18789` (vite dev) or the page host (prod), root
 *  path. Vite's own HMR socket lives under /tinker/ and is not matched. */
const GATEWAY_WS = /^wss?:\/\/localhost:\d+\/?(\?.*)?$/;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });

// Write path 1: the ui-state mirror. GET (hydrate) passes; anything else is answered here.
let interceptedStateWrites = 0;
await page.route("**/api/ui-state*", (route) => {
  if (route.request().method() === "GET") {
    return route.continue();
  }
  interceptedStateWrites++;
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
// Write path 2: the render mirror. Proxy the gateway socket; answer that one RPC locally.
let interceptedSnapshots = 0;
await page.routeWebSocket(
  (url) => GATEWAY_WS.test(url.href),
  (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      if (typeof msg === "string") {
        let f = null;
        try {
          f = JSON.parse(msg);
        } catch {
          /* not JSON: forward untouched */
        }
        if (f && f.type === "req" && f.method === "debug.dumpUiSnapshot") {
          interceptedSnapshots++;
          ws.send(
            JSON.stringify({ type: "res", id: f.id, ok: true, payload: { intercepted: true } }),
          );
          return;
        }
      }
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  },
);

const echo = [];
const errors = [];
/** Every `[dup-prov] history:reconcile` the page logged, in order — the app's own reload receipt. */
const reconciles = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[dup-prov]") || t.startsWith("[hmr]")) {
    echo.push(redact(t));
    if (t.startsWith(RECONCILE_PREFIX)) {
      try {
        const j = JSON.parse(t.slice(RECONCILE_PREFIX.length));
        reconciles.push({
          key: String(j.sessionKey || ""),
          mode: String(j.mode || "?"),
          added: Number(j.added ?? 0),
          incoming: Number(j.incoming ?? 0),
        });
      } catch {
        /* not JSON — still echoed above */
      }
    }
  } else if (m.type() === "error") {
    errors.push(`[console.error] ${redact(t)}`);
  }
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${redact(e.message)}`));

const railKeys = () =>
  page.evaluate(
    (sel) => Array.from(document.querySelectorAll(sel)).map((r) => r.dataset.sessionKey || ""),
    ROWS,
  );

/** The rail paints from hydrated tabs first and from sessions.list a moment later. */
async function waitRailSettled(quietMs = 1500, timeout = 20000) {
  const t0 = Date.now();
  let last = -1;
  let since = t0;
  while (Date.now() - t0 < timeout) {
    const n = (await railKeys()).length;
    if (n !== last) {
      last = n;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return n;
    }
    await page.waitForTimeout(300);
  }
  return last;
}

/** Collapsed groups render NO rows (cron/subagent/whatsapp/other/recovered/fractal start folded). */
async function expandCollapsedGroups() {
  let opened = 0;
  for (let i = 0; i < 12; i++) {
    const clicked = await page.evaluate(() => {
      for (const h of document.querySelectorAll("#sessions-list .session-group-header")) {
        if (h.querySelector(".session-group-arrow")?.textContent?.trim() === "▸") {
          h.click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) {
      break;
    }
    opened++;
    await page.waitForTimeout(150);
  }
  return opened;
}

/** Re-scan the rail for the key until it shows up; open folded groups after a few seconds. */
async function findRailKey(wanted, timeout = 20000) {
  const t0 = Date.now();
  let opened = 0;
  let keys = [];
  while (Date.now() - t0 < timeout) {
    keys = await railKeys();
    const key = keys.find((k) => keyMatches(k, wanted));
    if (key) {
      return { key, keys, opened };
    }
    if (!opened && Date.now() - t0 > 4000) {
      opened = await expandCollapsedGroups();
    }
    await page.waitForTimeout(500);
  }
  return { key: null, keys, opened };
}

/** Click the rail row — the app's own delegated handler does the tab lookup/creation + loadChat. */
const clickRow = (key) =>
  page.evaluate((key) => {
    const row = Array.from(document.querySelectorAll("#sessions-list .session-row")).find(
      (r) => r.dataset.sessionKey === key,
    );
    if (!row) {
      return false;
    }
    row.click();
    return true;
  }, key);

/** `.session-active` is repainted by refreshViewedSessionIndicators → updateSessionsPanel. */
async function waitViewed(key, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const active = await page.evaluate(
      () =>
        document.querySelector("#sessions-list .session-row.session-active")?.dataset.sessionKey ||
        "",
    );
    if (active && keyMatches(active, key)) {
      return true;
    }
    await page.waitForTimeout(150);
  }
  return false;
}

/** Wait for the app's reconcile receipt for `key`, logged at index >= since. */
async function waitReconcile(key, since, timeout = RECONCILE_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = reconciles.slice(since).find((r) => keyMatches(r.key, key));
    if (hit) {
      return { ...hit, ms: Date.now() - t0 };
    }
    await page.waitForTimeout(200);
  }
  return null;
}

/** Wait until neither the assistant-bubble count nor the reconcile log for `key` moved for `ms`. */
async function waitStable(key, ms = STABLE_MS, timeout = 45000) {
  const t0 = Date.now();
  let last = -1;
  let lastLog = -1;
  let since = t0;
  while (Date.now() - t0 < timeout) {
    const n = await page.evaluate(
      () => document.querySelectorAll("#messages .msg.assistant").length,
    );
    const logN = reconciles.filter((r) => keyMatches(r.key, key)).length;
    if (n !== last || logN !== lastLog) {
      last = n;
      lastLog = logN;
      since = Date.now();
    } else if (Date.now() - since >= ms) {
      return { n, stable: true, ms: Date.now() - t0 };
    }
    await page.waitForTimeout(250);
  }
  return { n: last, stable: false, ms: Date.now() - t0 };
}

const measure = () =>
  page.evaluate((MIN_LEN) => {
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const all = Array.from(document.querySelectorAll("#messages .msg.assistant"));
    const bucket = (els) => {
      // FORK 2026-09-08 (second pass) — count by SERVER IDENTITY first. renderMsg stamps every
      // bubble of a server-backed row with data-oc-id (history-reconcile's historyRowIdentity)
      // and data-oc-part (main / thinking / commentary / fractal / subagent: one row paints
      // several parts, and those are not copies of each other). A pair is a DUPLICATE when
      //   - both bubbles carry the same identity+part (the same row painted twice, whatever the
      //     text), or
      //   - the bodies are equal (>= MIN_LEN) and NOT both distinct stamped rows — one side is a
      //     client-written bubble that the server's copy then joined, the exact class that
      //     doubled the tabs for months.
      // Equal bodies on two DISTINCT stamped rows are the transcript honestly repeating itself
      // (a rate-limit note hours apart, "turn failed before producing content" twice) — paper
      // shows both, and they are reported as `legit`, never as red.
      const rows = els.map((e) => ({
        body: norm(e.textContent || ""),
        id: e.dataset.ocId ? `${e.dataset.ocId}|${e.dataset.ocPart || ""}` : "",
      }));
      let pairs = 0;
      let idPairs = 0;
      let legit = 0;
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i];
          const b = rows[j];
          if (a.id && a.id === b.id) {
            idPairs++;
            pairs++;
            continue;
          }
          if (a.body.length >= MIN_LEN && a.body === b.body) {
            if (a.id && b.id) {
              legit++;
            } else {
              pairs++;
            }
          }
        }
      }
      return {
        total: rows.length,
        distinct: new Set(rows.map((r) => r.body)).size,
        pairs,
        idPairs,
        legit,
        stamped: rows.filter((r) => r.id).length,
      };
    };
    const strip = document.getElementById("history-strip");
    return {
      thinking: bucket(all.filter((e) => e.classList.contains("msg-thinking"))),
      answer: bucket(all.filter((e) => !e.classList.contains("msg-thinking"))),
      build: document.getElementById("messages")?.dataset.uiBuild || "",
      busy: !!document.querySelector("#sessions-list .session-row.session-active.session-live"),
      strip:
        strip && strip.style.display !== "none" ? norm(strip.textContent || "").slice(0, 80) : "",
    };
  }, MIN_LEN);

const fmt = (b) => `${b.total}/${b.distinct}/${b.pairs}${b.legit ? `+${b.legit}L` : ""}`;
const fmtRec = (r) => (r ? `${r.mode}+${r.added}` : "NONE");
let allPass = true;

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // The rail fills from sessions.list once the gateway socket is up — see ROWS_TIMEOUT_MS for why
  // "up" can take several dials. The elapsed time is printed so a slow gateway stays visible.
  const tRows = Date.now();
  await page.waitForSelector(ROWS, { state: "attached", timeout: ROWS_TIMEOUT_MS });
  console.log(`rail painted after ${((Date.now() - tRows) / 1000).toFixed(1)}s`);
  await waitRailSettled();

  for (const wanted of KEYS) {
    const notes = [];
    const rows = [];
    let pass = true;

    const found = await findRailKey(wanted);
    if (found.opened) {
      notes.push(`expanded ${found.opened} collapsed rail group(s)`);
    }
    const key = found.key;
    if (!key) {
      console.log(`== ${wanted}`);
      console.log(
        `   FAIL: no rail row for this key (${found.keys.length} rows) — is it on the server's sessions.list?`,
      );
      console.log("");
      allPass = false;
      continue;
    }
    // The reload trigger: another rail row to switch away to. main first (it always exists),
    // then any tinker tab, then anything. Last resort: the degraded strip's manual retry.
    const keys = found.keys;
    const away =
      keys.find((k) => k !== key && k.endsWith(":main")) ||
      keys.find((k) => k !== key && (/:tinker:/.test(k) || k.startsWith("tinker:"))) ||
      keys.find((k) => k !== key && k) ||
      null;

    // Cycle 0: the first view. A reconcile logged at boot counts too (the key may already be the
    // active tab, in which case the rail click is a no-op and loadChat already fired).
    await clickRow(key);
    if (!(await waitViewed(key))) {
      notes.push("viewed state unconfirmed: no .session-active row for the key within 15s");
    }
    let rec = await waitReconcile(key, 0);
    let st = await waitStable(key);
    let m = await measure();
    rows.push({ cycle: 0, rec, st, ...m });

    for (let c = 1; c <= CYCLES; c++) {
      let since;
      if (away) {
        await clickRow(away);
        await waitViewed(away, 10000);
        await page.waitForTimeout(1000);
        since = reconciles.length;
        await clickRow(key);
        await waitViewed(key);
      } else {
        since = reconciles.length;
        const retried = await page.evaluate(() => {
          const s = document.getElementById("history-strip");
          if (s && s.style.display !== "none") {
            s.click();
            return true;
          }
          return false;
        });
        if (!retried) {
          notes.push("no reload trigger: single session on the rail and no degraded strip");
          pass = false;
          break;
        }
        if (c === 1) {
          notes.push("reload via the history strip's manual retry");
        }
      }
      rec = await waitReconcile(key, since);
      st = await waitStable(key);
      m = await measure();
      rows.push({ cycle: c, rec, st, ...m });
    }

    const base = rows[0];
    const reasons = [];
    for (const r of rows) {
      if (!r.rec) {
        reasons.push(
          `cycle ${r.cycle}: no history:reconcile for this key within ${RECONCILE_TIMEOUT_MS / 1000}s` +
            (r.busy ? " (session busy — loadChat defers under a live run)" : "") +
            (r.strip ? ` (degraded strip: "${r.strip}")` : ""),
        );
      }
      if (r.thinking.pairs > 0 || r.answer.pairs > 0) {
        reasons.push(
          `cycle ${r.cycle}: duplicate pairs thinking=${r.thinking.pairs} answer=${r.answer.pairs}` +
            ` (same-row identity collisions ${r.thinking.idPairs}/${r.answer.idPairs};` +
            ` stamped bubbles ${r.thinking.stamped}/${r.thinking.total} and ${r.answer.stamped}/${r.answer.total})`,
        );
      }
      if (!r.st.stable) {
        reasons.push(`cycle ${r.cycle}: count never stable for ${STABLE_MS}ms (a turn streaming?)`);
      }
      if (!r.build) {
        reasons.push(`cycle ${r.cycle}: #messages has no data-ui-build`);
      }
      // FORK 2026-09-08 (second pass) — totals may GROW: a running session writes new rows
      // between cycles (measured live: 261→262 thinking bubbles with zero pairs), and paper only
      // ever grows. Totals that SHRINK mean the page was rewritten, which paper never does.
      if (r.thinking.total < base.thinking.total || r.answer.total < base.answer.total) {
        reasons.push(
          `cycle ${r.cycle}: totals SHRANK (thinking ${base.thinking.total}→${r.thinking.total}, answer ${base.answer.total}→${r.answer.total}) — the page was rewritten`,
        );
      } else if (r.thinking.total !== base.thinking.total || r.answer.total !== base.answer.total) {
        notes.push(
          `cycle ${r.cycle}: totals grew (thinking ${base.thinking.total}→${r.thinking.total}, answer ${base.answer.total}→${r.answer.total}) — a live session writing, pairs stayed ${r.thinking.pairs}/${r.answer.pairs}`,
        );
      }
      if (r.thinking.legit || r.answer.legit) {
        notes.push(
          `cycle ${r.cycle}: ${r.thinking.legit}/${r.answer.legit} equal bodies on DISTINCT server rows (the transcript repeating itself — shown, not red)`,
        );
      }
      if (r.build !== base.build) {
        reasons.push(`cycle ${r.cycle}: build changed ${base.build || "∅"}→${r.build || "∅"}`);
      }
    }
    if (reasons.length) {
      pass = false;
    }

    console.log(`== ${key}${key !== wanted ? `  (matched ${wanted})` : ""}`);
    console.log(
      `   reload trigger: ${away ? `rail → ${away} → back` : "history strip"}   cycles: ${CYCLES}`,
    );
    console.log(
      "   cycle | reconcile   | thinking tot/dist/dup≥40 | answer tot/dist/dup≥40 | stable   | build",
    );
    for (const r of rows) {
      console.log(
        `   ${String(r.cycle).padStart(5)} | ${fmtRec(r.rec).padEnd(11)} | ${fmt(r.thinking).padStart(24)} | ${fmt(r.answer).padStart(22)} | ${(r.st.stable ? (r.st.ms / 1000).toFixed(1) + "s" : "NO").padEnd(8)} | ${r.build || "(none)"}`,
      );
    }
    for (const n of notes) {
      console.log(`   note: ${n}`);
    }
    console.log(pass ? "   PASS" : `   FAIL\n     - ${reasons.join("\n     - ")}`);
    console.log("");
    if (!pass) {
      allPass = false;
    }
  }
} catch (e) {
  console.log("FATAL", redact(e.message));
  allPass = false;
}

console.log("--- console [dup-prov] / [hmr] lines ---");
console.log(echo.length ? echo.join("\n") : "(none)");
console.log("--- page errors ---");
console.log(errors.length ? errors.join("\n") : "(none)");
console.log(
  `--- intercepted, never reached the gateway: ui-state mirror writes ${interceptedStateWrites}, snapshot dumps ${interceptedSnapshots}`,
);
await browser.close();
process.exit(allPass ? 0 : 1);
