#!/usr/bin/env node
/**
 * Drives the built tinker-ui (served by mock-gateway.mjs) through one scenario in headless Chromium,
 * then dumps the chat as rendered, reloads, and dumps it again (the reload is the control).
 * Adapted from tinker-ui/e2e/chat-viewport/drive.mjs (that file is not modified).
 *
 *   node drive.mjs --url http://127.0.0.1:<port> --scenario <scenario.json> --out <dir> [--headed]
 *
 * Seeds two tabs (tab-main on the main session, tab-r on the scenario session, tab-r active), waits
 * for the first history merge of the scenario session, starts the mock's clock, performs the
 * scenario's actions at their times, waits until scenario.end, dumps every `.msg` bubble under
 * #messages and every console line starting "[dup-prov]", reloads, waits for the merge, dumps again.
 *
 * Actions ({at, do, ...}): send {text} · switch-away {to?} · switch-back · reload · offline {ms}
 * (Playwright network emulation: measured 2026-10-03, it does NOT close an open WebSocket — use
 * drop for an outage) · drop {ms} (the mock closes every socket and refuses new ones; the page
 * redials after 2 s) · dump {label} (a mid-run snapshot of the bubbles) · eval {js} · wait.
 *
 * A dumped row is a `.msg` bubble or a `.tool-row`, in DOM order: role (user / assistant / thinking
 * = .msg-thinking / system / tool), data-oc-id + data-oc-part (only rows drawn from served history
 * carry them), the body text length with the bubble's chrome removed (elapsed chip, badges, the
 * fractal-prompt link, retry controls, nested tool rows), the first 60 chars, and the enclosing
 * <details> fold if any.
 *
 * Writes <out>/result.json (everything), bubbles-live.txt, bubbles-reload.txt, dumps.txt,
 * dup-prov.txt, console.txt, mock-log.json, summary.txt; prints summary.txt.
 * No network beyond the mock: every request to any other origin is aborted.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WT = process.env.HARNESS_WORKTREE ?? fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = createRequire(path.join(WT, "package.json"))("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] ?? true]] : a),
      [],
    ),
);
const URL_ = args.url;
const scenario = JSON.parse(fs.readFileSync(args.scenario, "utf-8"));
const OUT = args.out;
fs.mkdirSync(OUT, { recursive: true });
const SESSION = scenario.session;
const MAIN = scenario.mainSession ?? "agent:main:main";
const origin = new URL(URL_).origin;

const browser = await chromium.launch({ headless: args.headed !== true && args.headed !== "true" });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:"))
    return route.continue();
  return route.abort();
});
await ctx.addInitScript(
  ([main, sess]) => {
    if (!localStorage.getItem("tinker-tabs")) {
      localStorage.setItem(
        "tinker-tabs",
        JSON.stringify([
          { id: "tab-main", sessionKey: main, title: "🏠 Main", isAttached: true },
          { id: "tab-r", sessionKey: sess, title: "Replay", isAttached: true },
        ]),
      );
      localStorage.setItem("tinker.uiChoices", JSON.stringify({ "tab:active": "tab-r" }));
    }
  },
  [MAIN, SESSION],
);
const page = await ctx.newPage();

let startReal = null;
const rel = () => (startReal === null ? null : Date.now() - startReal);
const consoleRows = [];
const dupProv = [];
const pageErrors = [];
let loadNo = 0;
page.on("console", (m) => {
  const text = m.text();
  const row = { t: rel(), load: loadNo, type: m.type(), text };
  consoleRows.push(row);
  if (text.startsWith("[dup-prov]")) dupProv.push(row);
});
page.on("pageerror", (e) => pageErrors.push({ t: rel(), load: loadNo, error: String(e) }));
page.on("load", () => {
  loadNo++;
});

/** Resolves when the page logs its history merge for the scenario session after `since`. */
async function waitReconcile(sinceIdx, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (let i = sinceIdx; i < dupProv.length; i++) {
      const r = dupProv[i];
      if (
        r.text.startsWith("[dup-prov] history:reconcile") &&
        r.text.includes(JSON.stringify(SESSION))
      ) {
        return r;
      }
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function dumpBubbles() {
  return page.evaluate(() => {
    const root = document.getElementById("messages");
    if (!root) return { build: null, bubbles: [] };
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    let i = 0;
    for (const el of root.querySelectorAll(".msg, .tool-row")) {
      if (el.classList.contains("tool-row")) {
        const fold = el.closest("details");
        const text = norm(el.textContent);
        out.push({
          i: i++,
          role: "tool",
          cls: "tool-row",
          ocId: null,
          ocPart: null,
          len: text.length,
          rawLen: text.length,
          head: text.slice(0, 60),
          fold: fold ? [...fold.classList].join(".") + (fold.open ? "[open]" : "") : "",
          inMsg: el.closest(".msg") !== null,
          text,
        });
        continue;
      }
      const cls = [...el.classList].filter((c) => c !== "msg");
      const role = cls.includes("user")
        ? "user"
        : cls.includes("assistant")
          ? cls.includes("msg-thinking")
            ? "thinking"
            : "assistant"
          : cls.includes("system")
            ? "system"
            : cls[0] || "?";
      const fold = el.parentElement ? el.parentElement.closest("details") : null;
      // The body without the bubble's chrome (elapsed chip, badges, prompt link, retry controls),
      // which differs between a live page and a reload for reasons that are not the transcript.
      const clone = el.cloneNode(true);
      for (const x of clone.querySelectorAll(
        ".msg-elapsed, .msg-incomplete-badge, .user-prompt-link, [class*='badge'], [class^='retry'], button, .tool-row, .tool-detail",
      )) {
        x.remove();
      }
      const text = norm(clone.textContent);
      out.push({
        i: i++,
        role,
        cls: cls.join("."),
        ocId: el.dataset.ocId ?? null,
        ocPart: el.dataset.ocPart ?? null,
        len: text.length,
        rawLen: norm(el.textContent).length,
        head: text.slice(0, 60),
        fold: fold ? [...fold.classList].join(".") + (fold.open ? "[open]" : "") : "",
        text,
      });
    }
    const toolRows = root.querySelectorAll(".tool-row").length;
    return { build: root.dataset.uiBuild ?? null, toolRows, bubbles: out };
  });
}

function fmtBubbles(d) {
  return d.bubbles
    .map(
      (b) =>
        `${String(b.i).padStart(3)} ${b.role.padEnd(9)} ${(b.ocId ? `${b.ocId}#${b.ocPart}` : b.role === "tool" ? (b.inMsg ? "(tool row, inside a .msg)" : "(tool row)") : "(client)").padEnd(52)} len=${String(b.len).padStart(5)} ${b.fold ? `[${b.fold}] ` : ""}${JSON.stringify(b.head)}`,
    )
    .join("\n");
}

/** Copies (same text twice) and tails (one bubble's text = the end of a longer one), len >= 40. */
function analyse(d) {
  const big = d.bubbles.filter((b) => b.len >= 40 && b.role !== "tool");
  const byText = new Map();
  for (const b of big) {
    const k = `${b.role}|${b.text}`;
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(b.i);
  }
  const copies = [...byText.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({
      role: k.split("|")[0],
      bubbles: v,
      len: k.length - k.indexOf("|") - 1,
      head: k.slice(k.indexOf("|") + 1, k.indexOf("|") + 61),
    }));
  const tails = [];
  const within = [];
  for (const b of big) {
    for (const a of d.bubbles) {
      if (a.role === "tool" || a.i === b.i || a.len <= b.len) continue;
      if (a.text.endsWith(b.text)) {
        tails.push({
          tail: b.i,
          of: a.i,
          tailLen: b.len,
          ofLen: a.len,
          cutAt: a.len - b.len,
          tailHead: b.head,
        });
        break;
      }
      if (b.len >= 80 && a.text.includes(b.text)) {
        within.push({
          part: b.i,
          of: a.i,
          partLen: b.len,
          ofLen: a.len,
          at: a.text.indexOf(b.text),
          partHead: b.head,
        });
        break;
      }
    }
  }
  return { copies, tails, within };
}

function diffLiveReload(live, reload) {
  const pool = new Map();
  for (const b of reload.bubbles) {
    const k = `${b.role}|${b.text}`;
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const liveOnly = [];
  for (const b of live.bubbles) {
    const k = `${b.role}|${b.text}`;
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else
      liveOnly.push({
        i: b.i,
        role: b.role,
        ocId: b.ocId,
        ocPart: b.ocPart,
        len: b.len,
        head: b.head,
      });
  }
  const livePool = new Map();
  for (const b of live.bubbles) {
    const k = `${b.role}|${b.text}`;
    livePool.set(k, (livePool.get(k) ?? 0) + 1);
  }
  const reloadOnly = [];
  for (const b of reload.bubbles) {
    const k = `${b.role}|${b.text}`;
    const n = livePool.get(k) ?? 0;
    if (n > 0) livePool.set(k, n - 1);
    else
      reloadOnly.push({
        i: b.i,
        role: b.role,
        ocId: b.ocId,
        ocPart: b.ocPart,
        len: b.len,
        head: b.head,
      });
  }
  return { liveOnly, reloadOnly };
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────
const actionLog = [];
const dumps = [];
await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
const firstMerge = await waitReconcile(0);
await page.waitForTimeout(1500);
const startRes = await (await fetch(`${URL_}/__mock/start`, { method: "POST", body: "{}" })).json();
startReal = startRes.startReal;
for (const r of consoleRows) if (r.t === null) r.tPre = true;

const actions = [...(scenario.actions ?? [])].sort((a, b) => a.at - b.at);
for (const a of actions) {
  const wait = startReal + a.at - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  const at = rel();
  let detail = null;
  try {
    if (a.do === "send") {
      const ta = page.locator("#chat-textarea");
      await ta.click();
      await ta.fill(String(a.text ?? ""));
      await ta.press("Enter");
    } else if (a.do === "switch-away") {
      await page.click(`[data-tab-id="${a.to ?? "tab-main"}"]`);
    } else if (a.do === "switch-back") {
      await page.click(`[data-tab-id="${a.to ?? "tab-r"}"]`);
    } else if (a.do === "reload") {
      await page.reload({ waitUntil: "load" });
    } else if (a.do === "offline") {
      await ctx.setOffline(true);
      await page.waitForTimeout(Number(a.ms ?? 3000));
      await ctx.setOffline(false);
    } else if (a.do === "drop") {
      await fetch(`${URL_}/__mock/drop`, {
        method: "POST",
        body: JSON.stringify({ ms: a.ms ?? 3000 }),
      });
    } else if (a.do === "dump") {
      const d = await dumpBubbles();
      dumps.push({ label: a.label ?? `t${at}`, t: at, ...d });
    } else if (a.do === "eval") {
      detail = await page.evaluate(a.js);
    }
  } catch (e) {
    detail = `ERROR ${String(e?.message ?? e)}`;
  }
  actionLog.push({
    at: a.at,
    t: at,
    do: a.do,
    ...(a.label ? { label: a.label } : {}),
    ...(detail !== null ? { detail } : {}),
  });
}
{
  const wait = startReal + Number(scenario.end ?? 0) - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}
const live = await dumpBubbles();
const liveT = rel();

// The control: a reload draws the transcript from chat.history alone.
const before = dupProv.length;
await page.reload({ waitUntil: "load" });
const reloadMerge = await waitReconcile(before);
await page.waitForTimeout(2500);
const reload = await dumpBubbles();
const mockLog = await (await fetch(`${URL_}/__mock/log`)).json();
await browser.close();

const result = {
  scenario: {
    name: scenario.name,
    file: path.resolve(args.scenario),
    session: SESSION,
    end: scenario.end,
  },
  build: live.build,
  start: startRes,
  firstMerge: firstMerge?.text ?? null,
  reloadMerge: reloadMerge?.text ?? null,
  actions: actionLog,
  live: { t: liveT, toolRows: live.toolRows, bubbles: live.bubbles, ...analyse(live) },
  reload: { toolRows: reload.toolRows, bubbles: reload.bubbles, ...analyse(reload) },
  diff: diffLiveReload(live, reload),
  dumps: dumps.map((d) => ({ ...d, ...analyse(d) })),
  dupProv,
  pageErrors,
};
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(OUT, "bubbles-live.txt"), fmtBubbles(live) + "\n");
fs.writeFileSync(path.join(OUT, "bubbles-reload.txt"), fmtBubbles(reload) + "\n");
fs.writeFileSync(
  path.join(OUT, "dumps.txt"),
  dumps.map((d) => `== ${d.label} (t=${d.t})\n${fmtBubbles(d)}`).join("\n\n") + "\n",
);
fs.writeFileSync(
  path.join(OUT, "dup-prov.txt"),
  dupProv.map((r) => `t=${r.t} load=${r.load} ${r.text}`).join("\n") + "\n",
);
fs.writeFileSync(
  path.join(OUT, "console.txt"),
  consoleRows.map((r) => `t=${r.t} load=${r.load} ${r.type} ${r.text}`).join("\n") + "\n",
);
fs.writeFileSync(path.join(OUT, "mock-log.json"), JSON.stringify(mockLog, null, 1));

const L = [];
L.push(
  `scenario ${scenario.name}  build ${live.build}  clock skew ${startRes.skewMs} ms  page errors ${pageErrors.length}`,
);
L.push(
  `actions: ${actionLog.map((a) => `${a.do}@${a.t}${a.detail ? `(${String(a.detail).slice(0, 60)})` : ""}`).join(", ") || "none"}`,
);
L.push("");
L.push(`== LIVE (t=${liveT}) — ${live.bubbles.length} bubbles, ${live.toolRows} tool rows`);
L.push(fmtBubbles(live));
L.push("");
L.push(`== RELOAD (control) — ${reload.bubbles.length} bubbles, ${reload.toolRows} tool rows`);
L.push(fmtBubbles(reload));
L.push("");
const la = analyse(live);
const ra = analyse(reload);
L.push(`live copies: ${JSON.stringify(la.copies)}`);
L.push(`live tails:  ${JSON.stringify(la.tails)}`);
L.push(`live within: ${JSON.stringify(la.within)}`);
L.push(`reload copies: ${JSON.stringify(ra.copies)}  reload tails: ${JSON.stringify(ra.tails)}`);
L.push(`live-only bubbles (not in the reload): ${JSON.stringify(result.diff.liveOnly)}`);
L.push(`reload-only bubbles: ${JSON.stringify(result.diff.reloadOnly)}`);
L.push("");
L.push(`== [dup-prov] (${dupProv.length})`);
for (const r of dupProv) L.push(`t=${r.t} load=${r.load} ${r.text.slice(0, 400)}`);
if (pageErrors.length) {
  L.push("");
  L.push("== page errors");
  for (const e of pageErrors) L.push(`t=${e.t} ${e.error.slice(0, 300)}`);
}
const summary = L.join("\n") + "\n";
fs.writeFileSync(path.join(OUT, "summary.txt"), summary);
process.stdout.write(summary);
