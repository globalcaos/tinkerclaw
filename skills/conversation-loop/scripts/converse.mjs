#!/usr/bin/env node
// converse.mjs — say one turn INTO a gateway session (as a named party) and read the
// agent's reply back. The reusable primitive for AI<->AI dialogue loops.
//
// Usage:
//   node converse.mjs --session <key> --say "<message>" [--as "<tab name>"] [--wait 200] [--json]
//   node converse.mjs --session <key> --say-file <path> ...      # message body from a file
//   node converse.mjs --session <key> --read-only               # just fetch newest assistant text
//   ... [--idempotency-key <k>]   # reissue the SAME logical turn after a timeout: the gateway
//                                 # returns the cached run instead of starting a duplicate
//   ... [--stream]                # echo assistant deltas to stderr while waiting
//
// Env: OPENCLAW_GATEWAY_URL (default http://127.0.0.1:18789), OPENCLAW_GATEWAY_TOKEN
//      (else gateway.auth.token in ~/.openclaw/openclaw.json).
//
// Reply correlation (2026-09-20): the reply is matched to THIS request by the gateway's
// own identity, not by history length. `sessions.send` honours an `idempotencyKey` and
// acks with the started `runId`; every `chat` event carries `{runId, sessionKey, state}`.
// We register the event listener BEFORE sending, keep the acked runId, and accept only
// the terminal event (`final` | `error` | `aborted`) whose runId matches. Previously the
// script polled `chat.history(limit: 30)` and waited for the array to GROW — which can
// never happen once the session already holds 30 messages, so every long dialogue timed
// out even though the reply had landed. Injected user messages are re-broadcast by the
// gateway under an `inject-user-*` runId; those are not the answer and are ignored.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
// Resolve `ws` from the TinkerClaw fork's node_modules regardless of where this
// script lives (ESM bare-imports resolve from the script dir, not cwd).
const require = createRequire(
  process.env.OPENCLAW_WS_REQUIRE_BASE ?? path.join(os.homedir(), "src/tinkerclaw/package.json"),
);
const { WebSocket } = require("ws");

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n) => process.argv.includes("--" + n);
const SESSION = arg("session");
const SAY_FILE = arg("say-file");
const SAY = SAY_FILE ? fs.readFileSync(SAY_FILE, "utf8") : arg("say");
const AS = arg("as");
const WAIT_MS = Number(arg("wait") ?? 200) * 1000;
const JSON_OUT = has("json");
const READ_ONLY = has("read-only");
const STREAM = has("stream");
const NO_WAIT = has("no-wait"); // fire the turn and return; a wake-on-finish watcher reports completion
// 2026-09-23 — the sentinel the Tinker UI actually recognises is `⟦AGENT⟧` / `⟦AGENT:<label>⟧`
// (app.ts AGENT_MARKER_RE). A bare `⟦MARCUS⟧`, which this script used to emit, matched nothing and
// rendered as an ordinary green user bubble with the sentinel showing as literal text. The label is
// the DRIVING tab's name so the human watching the target tab sees who is steering it; with no
// --as it is resolved from this process's own TC_SESSION_KEY (the Tinker cookie phrase).
async function resolveLabel() {
  if (AS) return AS.slice(0, 60);
  const own = process.env.TC_SESSION_KEY;
  if (!own) return "Agent";
  try {
    const list = await req("sessions.list", {});
    const me = (list?.sessions ?? []).find((x) => x?.key === own);
    const name = me?.cookiePhrase ?? me?.title ?? "";
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "Agent";
  } catch {
    return "Agent";
  }
}
if (!SESSION) {
  console.error("converse: --session <key> required");
  process.exit(2);
}
if (!READ_ONLY && !SAY) {
  console.error("converse: --say <message> or --say-file <path> required (or --read-only)");
  process.exit(2);
}
// One stable key per logical turn. Passing the same key again after a timeout makes the
// gateway return the already-started run (cached ack) instead of running the turn twice.
const IDEMPOTENCY_KEY =
  arg("idempotency-key") ?? `converse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789").replace(
  /^http/,
  "ws",
);
function resolveToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"),
    );
    return cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token ?? null;
  } catch {
    return null;
  }
}
const TOKEN = resolveToken();
if (!TOKEN) {
  console.error("converse: no gateway token (OPENCLAW_GATEWAY_TOKEN or gateway.auth.token)");
  process.exit(2);
}

const pending = new Map();
const uuid = () => "cvs-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now();
const ws = new WebSocket(WS_URL, {
  headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
});
function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
let finished = false;
const finish = (code, payload) => {
  if (finished) return;
  finished = true;
  if (JSON_OUT) console.log(JSON.stringify(payload));
  else if (payload?.reply != null) console.log(payload.reply);
  else console.error(JSON.stringify(payload));
  try {
    ws.close();
  } catch {}
  process.exit(code);
};

const msgText = (m) => {
  if (!m) return "";
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join("");
  return "";
};
async function history(limit = 50) {
  const h = await req("chat.history", { sessionKey: SESSION, limit });
  return Array.isArray(h?.messages) ? h.messages : [];
}
function lastAssistant(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i]?.role === "assistant") return { idx: i, text: msgText(msgs[i]).trim() };
  return { idx: -1, text: "" };
}

// ── run correlation ──────────────────────────────────────────────────────────
// Events can arrive BEFORE the sessions.send ack (a fast run, or ack delayed behind a
// delta burst), so every chat event is buffered until the runId is known.
const chatBuffer = [];
let wantedRunId = null;
let onTerminal = null; // (payload) => void, installed once the runId is known
const isTerminal = (ev) =>
  ev?.state === "final" || ev?.state === "error" || ev?.state === "aborted";
function considerChatEvent(ev) {
  if (!ev || typeof ev.runId !== "string") return;
  if (ev.runId.startsWith("inject-user-")) return; // the gateway's echo of OUR injected prompt
  if (STREAM && ev.state === "delta" && wantedRunId && ev.runId === wantedRunId) {
    const t = msgText(ev.message);
    if (t) process.stderr.write(t.slice(-200) + "\n");
  }
  if (!wantedRunId || ev.runId !== wantedRunId || !isTerminal(ev)) return;
  if (onTerminal) onTerminal(ev);
}
function armTerminal(runId, handler) {
  wantedRunId = runId;
  onTerminal = handler;
  // replay anything that landed before the ack
  for (const ev of chatBuffer) considerChatEvent(ev);
  chatBuffer.length = 0;
}

ws.on("message", async (buf) => {
  let f;
  try {
    f = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (f.type === "event" && f.event === "chat") {
    if (!wantedRunId) {
      chatBuffer.push(f.payload);
      if (chatBuffer.length > 500) chatBuffer.shift();
    } else considerChatEvent(f.payload);
    return;
  }
  if (f.type === "event" && f.event === "connect.challenge") {
    req("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        displayName: "converse",
        version: "0.2",
        platform: "cli",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth: { token: TOKEN },
    })
      .then(async () => {
        try {
          if (READ_ONLY) {
            const before = await history(50);
            return finish(0, { reply: lastAssistant(before).text, count: before.length });
          }
          const sentAt = Date.now();
          const prefix = `⟦AGENT:${await resolveLabel()}⟧ `;
          const ack = await req("sessions.send", {
            key: SESSION,
            message: prefix + SAY,
            idempotencyKey: IDEMPOTENCY_KEY,
          });
          const runId = typeof ack?.runId === "string" ? ack.runId : null;
          // --no-wait: the caller armed wake-on-finish.mjs, so waiting here would burn the
          // driving turn for nothing. Hand back the runId and let the detached watcher
          // deliver the completion as a fresh turn in the master's tab.
          if (NO_WAIT) {
            return finish(0, { runId, idempotencyKey: IDEMPOTENCY_KEY, mode: "no-wait" });
          }
          if (!runId) {
            // Deployed gateway did not hand back a runId: fall back to a history read that
            // does NOT depend on the array growing (only on a newer assistant message).
            // Labelled unverified because timestamps are not request identity.
            return await historyFallback(sentAt, "no-runId-in-ack");
          }
          const deadline = sentAt + WAIT_MS;
          const timer = setTimeout(() => void historyFallback(sentAt, "timeout", runId), WAIT_MS);
          armTerminal(runId, (ev) => {
            clearTimeout(timer);
            const text = msgText(ev.message).trim();
            const sessionKeyMismatch =
              typeof ev.sessionKey === "string" && ev.sessionKey !== SESSION
                ? ev.sessionKey
                : undefined;
            if (ev.state === "final")
              return finish(0, {
                reply: text,
                runId,
                idempotencyKey: IDEMPOTENCY_KEY,
                ...(text ? {} : { emptyFinal: true }),
                ...(ev.stopReason ? { stopReason: ev.stopReason } : {}),
                ...(sessionKeyMismatch ? { eventSessionKey: sessionKeyMismatch } : {}),
                waitedMs: Date.now() - sentAt,
              });
            if (ev.state === "error")
              return finish(1, {
                error: ev.errorMessage ?? "run error",
                runId,
                idempotencyKey: IDEMPOTENCY_KEY,
                ...(ev.errorKind ? { errorKind: ev.errorKind } : {}),
                ...(ev.reason ? { reason: ev.reason } : {}),
                ...(ev.retryAfter !== undefined ? { retryAfter: ev.retryAfter } : {}),
                ...(text ? { partial: text } : {}),
              });
            return finish(1, { aborted: true, runId, idempotencyKey: IDEMPOTENCY_KEY });
          });
          void deadline;
        } catch (e) {
          return finish(1, { error: String(e?.message ?? e), idempotencyKey: IDEMPOTENCY_KEY });
        }
      })
      .catch((e) => finish(1, { error: `connect: ${String(e?.message ?? e)}` }));
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (!p) return;
    pending.delete(f.id);
    f.ok ? p.resolve(f.payload) : p.reject(f.error);
  }
});

// After a timeout (or a gateway that gave no runId) read the transcript once. A newer
// assistant message is REPORTED as `unverifiedNewest`, never as the correlated reply:
// it may belong to an earlier queued run or a concurrent message. The caller can
// reconcile by re-running with `--idempotency-key <same key>`, which returns the cached
// run instead of starting another.
async function historyFallback(sentAt, why, runId = null) {
  if (finished) return;
  try {
    const msgs = await history(200);
    const newer = msgs.filter(
      (m) =>
        m?.role === "assistant" &&
        typeof m.timestamp === "number" &&
        m.timestamp >= sentAt - 2000 &&
        msgText(m).trim(),
    );
    const newest = newer.length ? msgText(newer[newer.length - 1]).trim() : null;
    if (why === "no-runId-in-ack" && newest)
      return finish(0, {
        reply: newest,
        correlation: "history-fallback",
        idempotencyKey: IDEMPOTENCY_KEY,
      });
    return finish(1, {
      error: why === "timeout" ? "timeout waiting for reply" : why,
      waitedMs: Date.now() - sentAt,
      ...(runId ? { runId } : {}),
      idempotencyKey: IDEMPOTENCY_KEY,
      unverifiedNewest: newest,
    });
  } catch (e) {
    return finish(1, { error: `${why}; history read failed: ${String(e?.message ?? e)}` });
  }
}

ws.on("error", (e) => finish(1, { error: `ws: ${String(e?.message ?? e)}` }));
setTimeout(() => finish(1, { error: "hard timeout" }), WAIT_MS + 15000);
