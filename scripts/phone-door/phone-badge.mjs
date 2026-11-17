// phone-badge.mjs: the Jarvis app icon's number = Tinker chats with a result the owner has not read
// (2026-10-28: the app icon badge should equal the number of unread chats). Before, the launcher counted every alert still in the shade.
//
// Same rule as tinker-ui/src/tab-attention.ts, on the same data: a chat is unread when its session's last
// final (the gateway row's endedAt, or the page's own stamp `f` if newer) is after `s`, the moment the owner
// last saw it; a chat with no record yet is not. Read from the shared page state (tinker-ui-state.json: the
// open tabs and the "tab:seen" choice) and the gateway's session rows. On a change it sends
// jarvis.badge {count, titles} to the phone (apps/android JarvisBadge.kt); node.invoke wakes a sleeping app
// through FCM. Light on the Pi: sessions.list for the last few minutes every 10 s, the full list every 5 min.
//
// 2026-11-12, the answer's buzz and voice come at the END of the turn, from here (need: the phone buzzes and
// speaks when the Pi finishes, not when the app is reopened). A prompt sent from the phone leaves a marker
// (phone-away/<chat>; the page refreshes it every 3 s while it is on screen, so it holds the last moment the
// page was seen alive). When that chat's turn ends after that moment, the phone gets ONE wake: a buzz (the
// pattern is the owner's, kept on the phone: app settings), then the turn's spoken line. Before, the `jarvis` speaker did this hand-off at whatever moment
// it was called in mid-turn, not at all when the voice was muted, and the page buzzed only once it was reopened
// and had replayed the whole turn. Muted voice = the buzz alone. Pure parts: answersDue, spokenLine.
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
const VOICE_DIR =
  process.env.PHONE_VOICE_DIR || path.join(HOME, ".openclaw", "data", "jarvis-voice");
const AWAY_DIR = path.join(VOICE_DIR, "phone-away");
const MUTE_FILE = path.join(HOME, ".openclaw", "data", "jarvis-muted.json");
const AWAY_TICK_MS = 3_000; // while a phone prompt waits for its answer
const PAGE_ALIVE_MS = 8_000; // the page's heartbeat is 3 s; quieter than this = off screen
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

/** The reply's spoken line: the italic text after "**Jarvis:**", without its markers. */
export function spokenLine(text) {
  const m = /\*\*Jarvis:\*\*\s*\*([^\n]+?)\*(?:\s|$)/.exec(String(text ?? ""));
  return m ? m[1].trim().slice(0, 500) : "";
}

/**
 * The waiting phone prompts whose turn has ended: [{tail, key, startedAt, away}].
 * `markers` = [{tail, lastSeen}] (lastSeen = the marker's content: when the page was last seen alive, or the
 * send). `rows` = the gateway's session rows. A turn counts as ended when the row is not running and ended
 * after lastSeen. `away` = the page has been quiet longer than its heartbeat allows, so the phone is told.
 */
export function answersDue(markers, rows, now) {
  const out = [];
  for (const mk of markers) {
    if (!(mk.lastSeen > 0)) continue;
    const row = rows.find((r) => r && typeof r.key === "string" && keyMatches(r.key, mk.tail));
    if (!row || row.status === "running" || row.run?.live === true) continue;
    const ended = stamp(row.endedAt) ?? stamp(row.updatedAt);
    if (ended === undefined || ended <= mk.lastSeen) continue;
    out.push({
      tail: mk.tail,
      key: row.key,
      startedAt: stamp(row.startedAt) ?? 0,
      away: now - mk.lastSeen > PAGE_ALIVE_MS,
    });
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
  let lastRows = []; // the newest sessions.list answer, for the turn-end step
  let lastFull = 0;
  const memo = readJson(MEMO, {});

  async function refreshRows(now) {
    const full = now - lastFull >= FULL_EVERY_MS;
    const res = await req("sessions.list", full ? {} : { activeMinutes: 3 });
    if (full) {
      ended.clear();
      lastFull = now;
    }
    lastRows = res?.sessions || [];
    for (const row of lastRows) {
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

  function awayMarkers() {
    let names = [];
    try {
      names = fs.readdirSync(AWAY_DIR);
    } catch {
      return [];
    }
    const out = [];
    for (const tail of names) {
      try {
        const lastSeen = Number(fs.readFileSync(path.join(AWAY_DIR, tail), "utf8").trim());
        if (lastSeen > 0) out.push({ tail, lastSeen });
      } catch {
        // gone between the listing and the read
      }
    }
    return out;
  }

  /** What to say: the line the `jarvis` speaker rendered during this turn, else the reply's own spoken line. */
  async function lineFor(due) {
    if (readJson(MUTE_FILE, {})?.muted === true) return {};
    try {
      const latest = path.join(VOICE_DIR, "latest.txt");
      if (fs.statSync(latest).mtimeMs >= due.startedAt && due.startedAt > 0) {
        const [wav, text] = fs.readFileSync(latest, "utf8").split("\t");
        if (text?.trim()) return { text: text.trim().slice(0, 500) };
        if (/^\d+\.wav$/.test(wav || "")) return { wav: `/tinker/api/jarvis-voice/${wav}` }; // not English: its own voice
      }
    } catch {
      // no line was rendered this turn
    }
    const res = await req("chat.history", { sessionKey: due.key, limit: 6 }, 20_000);
    const last = (res?.messages || []).filter((m) => m?.role === "assistant").pop();
    const text = Array.isArray(last?.content)
      ? last.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : String(last?.content ?? "");
    const line = spokenLine(text);
    return line ? { text: line } : {};
  }

  const voiceLog = (file, line) => {
    try {
      fs.appendFileSync(path.join(VOICE_DIR, file), line + "\n");
    } catch {
      // the log is not worth a failed wake
    }
  };

  /** The turn-end step: one wake per answered phone prompt, with the buzz and the line. */
  async function answerPhonePrompts(now) {
    const due = answersDue(awayMarkers(), lastRows, now);
    for (const d of due) {
      fs.writeFileSync(path.join(AWAY_DIR, d.tail), ""); // consumed first: one wake per answer, whatever happens next
      if (!d.away) {
        voiceLog(
          "phone-away.log",
          `${new Date(now).toISOString()}\tturn-end page-alive\t${d.tail}`,
        );
        continue; // the page is on screen: it buzzes itself as the answer lands
      }
      let said = {};
      let status = "no phone";
      try {
        said = await lineFor(d);
        const nodeId = await phoneNode();
        if (nodeId) {
          const invoke = (command, params) =>
            req(
              "node.invoke",
              {
                nodeId,
                command,
                params,
                timeoutMs: 30_000,
                idempotencyKey: `answer-${d.tail}-${now}-${command}`,
              },
              90_000,
            );
          const res = await invoke("jarvis.pack.run", {
            event: "answer",
            data: said,
          });
          if (/handled\\?"\s*:\s*true/.test(JSON.stringify(res ?? ""))) status = "ok pack";
          else {
            // an app with no content pack: the two verbs themselves
            await invoke("jarvis.buzz", {});
            if (said.text) await invoke("jarvis.say", { text: said.text });
            status = "ok";
          }
        }
      } catch (err) {
        status = `failed ${String(err?.message ?? err).slice(0, 160)}`;
      }
      const what = said.text || (said.wav ? `(wav ${said.wav})` : "(buzz only)");
      voiceLog(
        "phone-away.log",
        `${new Date(now).toISOString()}\tturn-end phone\t${d.tail}\t${status}`,
      );
      voiceLog("calls.log", `${new Date(now).toISOString()}\t${status} turn-end\t${what}`);
      log(`answer to ${d.tail}: ${status}; ${what.slice(0, 80)}`);
    }
  }

  async function tick() {
    const now = Date.now();
    await refreshRows(now);
    if (!process.env.PHONE_BADGE_DRY) {
      try {
        await answerPhonePrompts(now);
      } catch (err) {
        log("turn-end step failed:", err.message);
      }
    }
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
      await new Promise((r) => setTimeout(r, awayMarkers().length ? AWAY_TICK_MS : TICK_MS));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    log("fatal:", err.message);
    process.exit(1);
  });
}
