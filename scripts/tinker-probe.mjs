#!/usr/bin/env node
/**
 * FORK: tinker-probe.mjs — agent-friendly Tinker UI test harness.
 *
 * Connects to the gateway as a webchat-ui client, sends a chat prompt,
 * and captures the full event stream (lifecycle / chat deltas /
 * fallback errors / anatomy / tool events). Emits a concise human
 * summary + a raw NDJSON dump for deep inspection.
 *
 * Usage:
 *   node scripts/tinker-probe.mjs "prompt text here"
 *   node scripts/tinker-probe.mjs --prompt "…" --session agent:main:main --timeout 180 --raw /tmp/tinker-probe.ndjson
 *
 * Environment:
 *   OPENCLAW_GATEWAY_TOKEN   override token (default: read from ~/.openclaw/openclaw.json)
 *   TINKER_PROBE_WS          override WS URL (default: ws://127.0.0.1:18789)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) {
    return fallback;
  }
  return argv[i + 1];
}
const promptFromFlag = flag("prompt");
const positional = argv.find(
  (a) => !a.startsWith("--") && a !== argv[argv.indexOf("--prompt") + 1],
);
const PROMPT = promptFromFlag ?? positional ?? "Say hello briefly, Jarvis.";
const SESSION_KEY = flag("session", "agent:main:main");
const TIMEOUT_S = Number(flag("timeout", 180));
const RAW_PATH = flag("raw", "/tmp/tinker-probe.ndjson");
const WS_URL = process.env.TINKER_PROBE_WS ?? "ws://127.0.0.1:18789";

function resolveToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return process.env.OPENCLAW_GATEWAY_TOKEN;
  }
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const t = cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token;
    if (typeof t === "string" && t) {
      return t;
    }
  } catch {}
  return "";
}
const TOKEN = resolveToken();

// ─── State ─────────────────────────────────────────────────────
const startedAt = Date.now();
const summary = {
  ws: WS_URL,
  token: TOKEN ? `${TOKEN.slice(0, 8)}…` : "(none)",
  sessionKey: SESSION_KEY,
  prompt: PROMPT,
  canonicalSessionKey: null,
  runId: null,
  lifecycle: {
    gotChallenge: false,
    connected: false,
    phaseStart: false,
    phaseStartPayload: null,
    phaseEnd: false,
    phaseEndPayload: null,
    contextAnatomy: 0,
  },
  chat: {
    deltas: 0,
    thinkDeltas: 0,
    finalText: "",
    finalThinking: "",
    firstDeltaMs: null,
    finalMessageMs: null,
  },
  toolExec: { start: 0, complete: 0 },
  errors: [],
  unknownEventTypes: new Map(),
};
const rawSink = RAW_PATH ? fs.createWriteStream(RAW_PATH, { flags: "w" }) : null;
function raw(direction, obj) {
  if (!rawSink) {
    return;
  }
  rawSink.write(JSON.stringify({ t: Date.now() - startedAt, dir: direction, ...obj }) + "\n");
}
function markUnknown(kind) {
  summary.unknownEventTypes.set(kind, (summary.unknownEventTypes.get(kind) ?? 0) + 1);
}

// ─── WebSocket client ───────────────────────────────────────────
const pending = new Map();
function uuid() {
  return "probe-" + Math.random().toString(36).slice(2, 14) + "-" + Date.now();
}

const wsHeaders = {
  Origin: process.env.TINKER_PROBE_ORIGIN ?? "http://127.0.0.1:18790",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};
const ws = new WebSocket(WS_URL, { headers: wsHeaders });

ws.on("open", () => raw("sys", { note: "ws-open" }));
ws.on("error", (err) => {
  summary.errors.push({ stage: "ws", msg: String(err) });
});
ws.on("close", (code, reason) => {
  raw("sys", { note: "ws-close", code, reason: String(reason) });
});

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    pending.set(id, { resolve, reject });
    const frame = { type: "req", id, method, params };
    raw("out", frame);
    ws.send(JSON.stringify(frame));
  });
}

ws.on("message", (buf) => {
  let frame;
  try {
    frame = JSON.parse(buf.toString());
  } catch {
    summary.errors.push({ stage: "parse", msg: "non-json frame" });
    return;
  }
  raw("in", frame);

  if (frame.type === "event") {
    if (frame.event === "connect.challenge") {
      summary.lifecycle.gotChallenge = true;
      req("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "webchat-ui",
          displayName: "Tinker Probe",
          version: "0.3",
          platform: "web",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        auth: { token: TOKEN },
      })
        .then((hello) => {
          summary.lifecycle.connected = true;
          if (hello?.snapshot?.sessionDefaults?.mainSessionKey) {
            summary.canonicalSessionKey = hello.snapshot.sessionDefaults.mainSessionKey;
          }
          runProbeTurn();
        })
        .catch((err) => summary.errors.push({ stage: "connect", msg: String(err) }));
      return;
    }
    onAgentEvent(frame);
    return;
  }
  if (frame.type === "res") {
    const p = pending.get(frame.id);
    if (!p) {
      return;
    }
    pending.delete(frame.id);
    if (frame.ok) {
      p.resolve(frame.payload);
    } else {
      p.reject(frame.error);
    }
  }
});

// ─── Agent-event classifier ─────────────────────────────────────
function matchesSession(evtSessionKey) {
  const target = summary.canonicalSessionKey ?? SESSION_KEY;
  if (!evtSessionKey) {
    return false;
  }
  return evtSessionKey === target;
}

function onAgentEvent(frame) {
  const p = frame.payload ?? frame.data ?? frame;
  const stream = p?.stream;
  const data = p?.data ?? {};
  const evtSessionKey = data?.sessionKey ?? p?.sessionKey;

  // Skip control-plane events with no stream (nonce pings, etc.)
  if (!stream) {
    return;
  }

  // Track runId for our turn (filtered by sessionKey)
  if (!summary.runId && matchesSession(evtSessionKey) && typeof p?.runId === "string") {
    summary.runId = p.runId;
  }

  if (stream === "lifecycle") {
    const phase = data?.phase;
    if (phase === "start" && matchesSession(evtSessionKey)) {
      summary.lifecycle.phaseStart = true;
      summary.lifecycle.phaseStartPayload = {
        runId: p.runId,
        model: data.model,
        provider: data.modelProvider ?? data.provider,
        authProfileId: data.authProfileId,
        sessionKey: evtSessionKey,
      };
    } else if (phase === "end" && matchesSession(evtSessionKey)) {
      summary.lifecycle.phaseEnd = true;
      summary.lifecycle.phaseEndPayload = {
        runId: p.runId,
        durationMs: data.durationMs,
        finalUsage: data.finalUsage,
        error: data.error,
      };
      setTimeout(finish, 500);
    } else if (phase === "context-anatomy" && matchesSession(evtSessionKey)) {
      summary.lifecycle.contextAnatomy++;
    }
    return;
  }

  // Chat text deltas arrive on stream "assistant" (data.text is cumulative; data.delta is increment)
  if (stream === "assistant" && matchesSession(evtSessionKey)) {
    if (summary.chat.firstDeltaMs == null) {
      summary.chat.firstDeltaMs = Date.now() - startedAt;
    }
    summary.chat.deltas++;
    if (typeof data.text === "string" && data.text.length > summary.chat.finalText.length) {
      summary.chat.finalText = data.text;
    } else if (typeof data.delta === "string") {
      summary.chat.finalText += data.delta;
    }
    return;
  }

  // Reasoning / thinking deltas
  if (stream === "reasoning" && matchesSession(evtSessionKey)) {
    summary.chat.thinkDeltas++;
    if (typeof data.text === "string" && data.text.length > summary.chat.finalThinking.length) {
      summary.chat.finalThinking = data.text;
    } else if (typeof data.delta === "string") {
      summary.chat.finalThinking += data.delta;
    }
    return;
  }

  // Final message boundary — some backends emit stream "message" / "message_end"
  if ((stream === "message" || stream === "chat") && matchesSession(evtSessionKey)) {
    const kind = data?.kind ?? data?.type ?? data?.phase;
    if (kind === "end" || kind === "final" || kind === "message_end") {
      summary.chat.finalMessageMs = Date.now() - startedAt;
      if (typeof data.text === "string" && data.text.length > summary.chat.finalText.length) {
        summary.chat.finalText = data.text;
      }
      return;
    }
    markUnknown(`${stream}/${kind}`);
    return;
  }

  if (stream === "fallback" || data?.kind === "fallback-error") {
    summary.errors.push({ stage: "fallback", data });
    return;
  }

  if (stream === "tool" || stream === "tool_event") {
    const kind = data?.kind ?? data?.phase;
    if (kind === "start" || kind === "exec-start") {
      summary.toolExec.start++;
    } else if (kind === "complete" || kind === "exec-complete") {
      summary.toolExec.complete++;
    } else {
      markUnknown(`tool/${kind}`);
    }
    return;
  }

  markUnknown(stream ?? "unknown");
}

// ─── Drive the turn ─────────────────────────────────────────────
async function runProbeTurn() {
  try {
    const res = await req("chat.send", {
      sessionKey: SESSION_KEY,
      message: PROMPT,
      idempotencyKey: uuid(),
    });
    if (res?.sessionKey && !summary.canonicalSessionKey) {
      summary.canonicalSessionKey = res.sessionKey;
    }
  } catch (err) {
    summary.errors.push({ stage: "chat.send", msg: String(err) });
    finish();
  }
}

// ─── Safety timeout ─────────────────────────────────────────────
const timeoutHandle = setTimeout(finish, TIMEOUT_S * 1000);

let finished = false;
function finish() {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeoutHandle);
  try {
    ws.close();
  } catch {}
  if (rawSink) {
    rawSink.end();
  }
  printSummary();
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

function printSummary() {
  const l = summary.lifecycle;
  const c = summary.chat;
  const indicators = {
    chat_opus: l.phaseStart && l.phaseStartPayload?.model ? "✓" : "✗",
    session_panel: l.phaseStart ? "✓" : "✗",
    model_glow: l.phaseStart && l.phaseStartPayload?.model ? "✓" : "✗",
    prefrontal_tree: l.phaseStart ? "✓" : "✗",
  };
  console.log("=== Tinker Probe Summary ===");
  console.log(`ws=${summary.ws} token=${summary.token}`);
  console.log(`session=${SESSION_KEY} canonical=${summary.canonicalSessionKey ?? "-"}`);
  console.log(`prompt="${PROMPT.slice(0, 80)}${PROMPT.length > 80 ? "…" : ""}"`);
  console.log(`challenge=${l.gotChallenge ? "✓" : "✗"} connected=${l.connected ? "✓" : "✗"}`);
  console.log(`runId=${summary.runId ?? "-"}`);
  console.log(
    `lifecycle.start=${l.phaseStart ? "✓" : "✗"} end=${l.phaseEnd ? "✓" : "✗"} anatomy=${l.contextAnatomy}`,
  );
  if (l.phaseStartPayload) {
    console.log(
      `  → model=${l.phaseStartPayload.model ?? "-"} provider=${l.phaseStartPayload.provider ?? "-"} profile=${l.phaseStartPayload.authProfileId ?? "-"}`,
    );
  }
  if (l.phaseEndPayload) {
    console.log(
      `  → end durationMs=${l.phaseEndPayload.durationMs ?? "-"} error=${l.phaseEndPayload.error ?? "none"}`,
    );
  }
  console.log(
    `chat.deltas=${c.deltas} think.deltas=${c.thinkDeltas} firstDeltaMs=${c.firstDeltaMs ?? "-"} finalMs=${c.finalMessageMs ?? "-"}`,
  );
  console.log(`chat.finalText.len=${c.finalText.length}`);
  console.log(`  preview: ${c.finalText.slice(0, 240)}${c.finalText.length > 240 ? "…" : ""}`);
  console.log(`tool.exec start=${summary.toolExec.start} complete=${summary.toolExec.complete}`);
  console.log("Indicator predictions (require phase=start w/ model):");
  for (const [k, v] of Object.entries(indicators)) {
    console.log(`  ${k}: ${v}`);
  }
  if (summary.unknownEventTypes.size > 0) {
    console.log("Unknown event types:");
    for (const [k, n] of summary.unknownEventTypes.entries()) {
      console.log(`  ${k} × ${n}`);
    }
  }
  if (summary.errors.length > 0) {
    console.log("Errors:");
    for (const e of summary.errors.slice(0, 5)) {
      console.log("  ", JSON.stringify(e));
    }
  }
  if (RAW_PATH) {
    console.log(`raw ndjson → ${RAW_PATH}`);
  }
  pollTimelineDb();
}

function pollTimelineDb() {
  const dbPath = path.join(os.homedir(), ".openclaw", "data", "anatomy-timeline.db");
  if (!fs.existsSync(dbPath)) {
    console.log(`timeline-db: (no file at ${dbPath})`);
    return;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const total = db.prepare("SELECT COUNT(*) as n FROM anatomy_events").get();
    const since = db
      .prepare("SELECT COUNT(*) as n FROM anatomy_events WHERE timestamp_ms >= ?")
      .get(startedAt);
    const lastRow = db
      .prepare(
        `SELECT session_key, turn, provider, model,
                datetime(timestamp_ms/1000,'unixepoch','localtime') as ts,
                response_tokens, response_thinking_tokens, response_text_tokens
         FROM anatomy_events ORDER BY id DESC LIMIT 1`,
      )
      .get();
    db.close();
    console.log(`timeline-db: total=${total.n} newThisTurn=${since.n}`);
    if (lastRow) {
      console.log(`  last row: ${JSON.stringify(lastRow)}`);
    }
    if (since.n === 0 && summary.lifecycle.phaseEnd) {
      console.log("  ⚠️  DB miss — turn completed but no anatomy_events row appeared.");
    }
  } catch (err) {
    console.log(`timeline-db: probe-error ${String(err).slice(0, 120)}`);
  }
}
