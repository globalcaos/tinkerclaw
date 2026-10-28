// phone-badge.mjs: the Jarvis app icon's number = Tinker chats with a result the owner has not read
// (the architect, 2026-10-28: "The phone app icon shows me numbers overlaid, it should match the number of unread
// chat results"). Before, the launcher counted every alert still in the shade.
//
// Same rule as tinker-ui/src/tab-attention.ts, on the same data: a chat is unread when its session's last
// final (the gateway row's endedAt, or the page's own stamp `f` if newer) is after `s`, the moment the owner
// last saw it; a chat with no record yet is not. Read from the shared page state (tinker-ui-state.json: the
// open tabs and the "tab:seen" choice) and the gateway's session rows. On a change it sends
// jarvis.badge {count, titles} to the phone (apps/android JarvisBadge.kt); node.invoke wakes a sleeping app
// through FCM. Light on the Pi: sessions.list for the last few minutes every 10 s, the full list every 5 min.
//
//   node scripts/phone-door/phone-badge.mjs          (unit phone-badge.service)
//   PHONE_BADGE_DRY=1 node …                         print the count, send nothing, exit
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const STATE_FILE =
  process.env.PHONE_BADGE_UI_STATE || path.join(HOME, ".openclaw", "data", "tinker-ui-state.json");
const MEMO = process.env.PHONE_BADGE_MEMO || path.join(HOME, ".local", "state", "phone-badge.json");
const TICK_MS = 10_000;
const FULL_EVERY_MS = 5 * 60_000;
const RETRY_FAILED_MS = 10 * 60_000;

const stamp = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
export const keyMatches = (a, b) => a === b || a.endsWith(":" + b) || b.endsWith(":" + a);

/** The open tabs with an unread result, in tab order: [{key, title}]. `endedAt(key)` = the row's endedAt or undefined. */
export function unreadTabs(uiState, endedAt) {
  let seen = {};
  try {
    seen = JSON.parse(uiState?.choices?.["tab:seen"] || "{}") || {};
  } catch {
    seen = {};
  }
  const out = [];
  const done = new Set();
  for (const tab of Array.isArray(uiState?.tabs) ? uiState.tabs : []) {
    const key = tab && typeof tab.sessionKey === "string" ? tab.sessionKey : "";
    if (!key || done.has(key)) continue;
    done.add(key);
    const rec = seen[key];
    const s = stamp(rec?.s);
    if (s === undefined) continue; // never seen on any screen: nothing is news yet
    const server = stamp(endedAt(key));
    const own = stamp(rec?.f);
    const final = server === undefined ? own : own === undefined ? server : Math.max(server, own);
    if (final !== undefined && final > s) out.push({ key, title: String(tab.title || "").trim() });
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function main() {
  const { WebSocket } = createRequire(path.join(HOME, "src", "tinkerclaw", "package.json"))("ws");
  const TOKEN = readJson(path.join(HOME, ".openclaw", "openclaw.json"), {})?.gateway?.auth?.token;
  if (!TOKEN) throw new Error("no gateway token in ~/.openclaw/openclaw.json");
  const ws = new WebSocket("ws://127.0.0.1:18789", {
    headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
  });
  let n = 0;
  const pending = new Map();
  const req = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = `pb${++n}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  ws.on("close", () => {
    log("gateway connection closed; exiting so systemd restarts me");
    process.exit(1);
  });
  ws.on("error", (err) => log("gateway socket error:", err.message));
  ws.on("message", (raw) => {
    const f = JSON.parse(raw);
    if (f.type === "res" && pending.has(f.id)) {
      const p = pending.get(f.id);
      pending.delete(f.id);
      clearTimeout(p.timer);
      f.ok ? p.resolve(f.payload) : p.reject(new Error(JSON.stringify(f.error)));
    } else if (f.type === "event" && f.event === "connect.challenge") {
      req("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat-ui",
          displayName: "phone-badge",
          version: "1",
          platform: "cli",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        auth: { token: TOKEN },
      }).then(loop, (err) => {
        log("connect failed:", err.message);
        process.exit(1);
      });
    }
  });

  const ended = new Map(); // session key -> endedAt (ms)
  let lastFull = 0;
  const memo = readJson(MEMO, {});

  async function refreshRows(now) {
    const full = now - lastFull >= FULL_EVERY_MS;
    const res = await req("sessions.list", full ? {} : { activeMinutes: 3 });
    if (full) {
      ended.clear();
      lastFull = now;
    }
    for (const row of res?.sessions || []) {
      if (row && typeof row.key === "string") ended.set(row.key, row.endedAt);
    }
  }
  const endedAt = (key) => {
    if (ended.has(key)) return ended.get(key);
    for (const [k, v] of ended) if (keyMatches(k, key)) return v;
    return undefined;
  };

  async function phoneNode() {
    const nodes = (await req("node.list", {}))?.nodes || [];
    const ok = nodes.filter(
      (x) => /android/i.test(x.platform || "") && (x.commands || []).includes("jarvis.badge"),
    );
    return (ok.find((x) => x.connected) || ok[0])?.nodeId || process.env.PHONE_BADGE_NODE || "";
  }

  async function tick() {
    const now = Date.now();
    await refreshRows(now);
    const unread = unreadTabs(readJson(STATE_FILE, {}), endedAt);
    const titles = unread.map((u) => u.title);
    const sig = JSON.stringify([unread.length, titles]);
    if (process.env.PHONE_BADGE_DRY) {
      log(`unread ${unread.length}:`, titles.join(" | ") || "-");
      process.exit(0);
    }
    if (sig === memo.sig && (memo.ok || now - (memo.at || 0) < RETRY_FAILED_MS)) return;
    const nodeId = await phoneNode();
    if (!nodeId) {
      if (memo.sig !== sig)
        log(`unread ${unread.length}, but no phone advertises jarvis.badge yet (older app)`);
      Object.assign(memo, { sig, ok: false, at: now });
      return;
    }
    try {
      await req(
        "node.invoke",
        {
          nodeId,
          command: "jarvis.badge",
          params: { count: unread.length, titles },
          timeoutMs: 30_000,
          idempotencyKey: `badge-${now}`,
        },
        90_000,
      );
      Object.assign(memo, { sig, ok: true, at: now });
      log(`badge ${unread.length}`, titles.length ? `(${titles.join(" | ")})` : "");
    } catch (err) {
      Object.assign(memo, { sig, ok: false, at: now });
      log(`badge ${unread.length} not delivered:`, String(err.message).slice(0, 200));
    }
    fs.mkdirSync(path.dirname(MEMO), { recursive: true });
    fs.writeFileSync(MEMO, JSON.stringify(memo));
  }

  async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (err) {
        log("tick failed:", err.message);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    log("fatal:", err.message);
    process.exit(1);
  });
}
