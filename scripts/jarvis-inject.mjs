#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
/**
 * Jarvis injector — opens a WebSocket to the gateway, sends one message to
 * a chosen sessionKey, prints live output (run events + deltas), and exits
 * once the turn's assistant message completes or a timeout fires.
 *
 * Usage:
 *   node jarvis-inject.mjs --session <sessionKey> --message "..." [--timeout 600]
 *   node jarvis-inject.mjs --new --message "..."    (auto-creates cli-<ts>)
 *
 * Exit codes:
 *   0   turn completed with a final assistant message
 *   1   aborted / error / timeout
 *   2   bad args / ws connect failure
 */
import WebSocket from "ws";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    new: { type: "boolean", default: false },
    message: { type: "string" },
    timeout: { type: "string", default: "600" },
    "raw-events": { type: "boolean", default: false },
    gw: { type: "string", default: "ws://localhost:18789" },
  },
});

if (!values.message) {
  console.error("missing --message");
  process.exit(2);
}

const sessionKey = values.new
  ? `cli:${Date.now().toString(36)}`
  : (values.session ?? "agent:main:main");
const timeoutMs = parseInt(values.timeout, 10) * 1000;
const pending = new Map(); // requestId -> {resolve,reject}
const ws = new WebSocket(values.gw);

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`req timeout: ${method}`));
      }
    }, 30_000);
  });
}

let turnDone = false;
let finalText = "";
let hardTimer;

function log(kind, obj) {
  const ts = new Date().toISOString();
  if (values["raw-events"]) {
    console.log(`[${ts}] ${kind} ${JSON.stringify(obj)}`);
  } else {
    console.log(`[${ts}] ${kind}`, obj);
  }
}

ws.on("open", async () => {
  hardTimer = setTimeout(() => {
    console.error(`[injector] hard timeout ${values.timeout}s — exiting`);
    try {
      ws.close();
    } catch {}
    process.exit(1);
  }, timeoutMs);
});

ws.on("message", async (raw) => {
  let f;
  try {
    f = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (f.type === "res") {
    const h = pending.get(f.id);
    if (!h) {
      return;
    }
    pending.delete(f.id);
    if (f.ok) {
      h.resolve(f.result ?? f.data);
    } else {
      h.reject(f.error ?? f);
    }
    return;
  }
  if (f.type !== "event") {
    return;
  }

  // Handshake
  if (f.event === "connect.challenge") {
    try {
      await send("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "jarvis-inject",
          version: "0.1",
          platform: "linux",
          mode: "cli",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        auth: process.env.OPENCLAW_GATEWAY_TOKEN
          ? { token: process.env.OPENCLAW_GATEWAY_TOKEN }
          : undefined,
      });
      log("connected", { gw: values.gw, sessionKey });
      // Fire the message
      await send("chat.send", {
        sessionKey,
        message: values.message,
        idempotencyKey: randomUUID(),
      });
      log("sent", { len: values.message.length });
    } catch (e) {
      console.error("[injector] handshake/send failed", e?.message ?? e);
      process.exit(1);
    }
    return;
  }

  // All gateway events live under `payload`.
  const p = f.payload ?? {};

  if (f.event === "agent" || f.event === "agent.event") {
    const stream = p.stream;
    const d = p.data ?? {};
    if (stream === "tool") {
      if (d.phase === "start") {
        log("tool.start", {
          name: d.name,
          id: d.toolCallId?.slice(0, 12),
          purpose: (d.purpose ?? "").slice(0, 120),
          args: JSON.stringify(d.args ?? {}).slice(0, 240),
        });
      } else if (d.phase === "result") {
        log("tool.result", {
          id: d.toolCallId?.slice(0, 12),
          isError: d.isError,
          stdout_len: (d.result ?? "").length,
          stdout_head: (d.result ?? "").slice(0, 220),
        });
      }
    } else if (stream === "lifecycle") {
      log("lifecycle", { phase: d.phase, runId: p.runId?.slice(0, 8) });
    } else if (stream === "thinking") {
      // thinking payload is noisy; skip unless --raw-events was set
      if (values["raw-events"]) {
        log("thinking", { delta_len: (d.delta ?? "").length });
      }
    }
    return;
  }

  if (f.event === "chat") {
    // sessionKey filter — only react to frames for our session
    if (p.sessionKey !== sessionKey && !(p.sessionKey ?? "").endsWith(sessionKey)) {
      return;
    }

    if (p.state === "delta") {
      // delta payload: { message: { content: [{type:"text", text: <cumulative>}, ...] } }
      const txt = p.message?.content?.find?.((b) => b.type === "text")?.text ?? "";
      if (txt && txt.length > finalText.length) {
        finalText = txt;
      }
    } else if (p.state === "final") {
      const txt = p.message?.content?.find?.((b) => b.type === "text")?.text ?? finalText;
      finalText = txt;
      log("final", { text_len: finalText.length, head: finalText.slice(0, 400) });
      turnDone = true;
      clearTimeout(hardTimer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        process.exit(0);
      }, 500);
    } else if (p.state === "aborted" || p.state === "error") {
      log("aborted-or-error", { state: p.state, errorMessage: p.errorMessage });
      turnDone = true;
      clearTimeout(hardTimer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        process.exit(1);
      }, 500);
    }
    return;
  }
});

ws.on("close", () => {
  if (!turnDone) {
    console.error("[injector] socket closed before final — finalText.len=" + finalText.length);
    console.error("--- finalText (head) ---\n" + finalText.slice(0, 1200));
    process.exit(1);
  }
});
ws.on("error", (e) => {
  console.error("[injector] ws error", e?.message ?? e);
  process.exit(2);
});
