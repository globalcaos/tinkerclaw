#!/usr/bin/env node
/**
 * FORK: jarvis-send.mjs -- fire-and-forget chat.send to main Jarvis session.
 *
 * Unlike tinker-probe.mjs (which waits for the turn to complete), this sends
 * the prompt and closes the socket immediately. Use when you're driving
 * Jarvis from an automation loop and don't want to block.
 *
 * Usage:
 *   node scripts/jarvis-send.mjs --file /tmp/prompt.txt
 *   node scripts/jarvis-send.mjs --message "raw text"
 *   node scripts/jarvis-send.mjs --file /tmp/prompt.txt --session agent:main:main
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) {
    return fallback;
  }
  return argv[i + 1];
}
const FILE = flag("file");
const MESSAGE_INLINE = flag("message");
const SESSION = flag("session", "agent:main:main");
const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789")
  .replace(/^http/, "ws")
  .replace(/\/$/, "");

let message;
if (FILE) {
  message = fs.readFileSync(FILE, "utf-8");
} else if (MESSAGE_INLINE) {
  message = MESSAGE_INLINE;
} else {
  console.error("jarvis-send: --file <path> or --message <text> required");
  process.exit(2);
}

function resolveToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return process.env.OPENCLAW_GATEWAY_TOKEN;
  }
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf-8"),
    );
    const t = cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token;
    if (typeof t === "string" && t) {
      return t;
    }
  } catch {}
  return "";
}
const TOKEN = resolveToken();
if (!TOKEN) {
  console.error("jarvis-send: no gateway token");
  process.exit(2);
}

const ws = new WebSocket(WS_URL, {
  headers: {
    Origin: process.env.OPENCLAW_SPAWN_ORIGIN ?? "http://127.0.0.1:18790",
    Authorization: `Bearer ${TOKEN}`,
  },
});
const pending = new Map();
function uuid() {
  return "js-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now();
}
function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
ws.on("message", (buf) => {
  let frame;
  try {
    frame = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (frame.type === "event" && frame.event === "connect.challenge") {
    req("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        displayName: "jarvis-send",
        version: "0.1",
        platform: "cli",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth: { token: TOKEN },
    })
      .then(() => req("chat.send", { sessionKey: SESSION, message, idempotencyKey: uuid() }))
      .then((res) => {
        console.log("sent:", JSON.stringify(res ?? { ok: true }));
        try {
          ws.close();
        } catch {}
        process.exit(0);
      })
      .catch((err) => {
        console.error("send failed:", err?.message ?? err);
        try {
          ws.close();
        } catch {}
        process.exit(1);
      });
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
ws.on("error", (err) => {
  console.error("ws error:", String(err));
  process.exit(1);
});
setTimeout(() => {
  console.error("timeout after 30s");
  process.exit(1);
}, 30_000);
