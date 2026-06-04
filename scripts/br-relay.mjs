#!/usr/bin/env node
// Drive the OpenClaw browser relay (shared tab) via gateway WS RPC `browser.request`.
// Usage: node br-relay.mjs <GET|POST> <path> [queryJSON] [bodyJSON]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
const [, , METHOD = "GET", RPATH = "/tabs", QJSON, BJSON] = process.argv;
const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789")
  .replace(/^http/, "ws")
  .replace(/\/$/, "");
function token() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const c = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf-8"),
    );
    return c?.gateway?.auth?.token ?? c?.gateway?.controlUi?.auth?.token ?? "";
  } catch {
    return "";
  }
}
const TOKEN = token();
const pending = new Map();
const uuid = () => "cli-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now();
const ws = new WebSocket(WS_URL, {
  headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
});
function req(method, params) {
  return new Promise((res, rej) => {
    const id = uuid();
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
function fin(code, o) {
  try {
    ws.close();
  } catch {}
  console.log(typeof o === "string" ? o : JSON.stringify(o));
  process.exit(code);
}
ws.on("message", (buf) => {
  let f;
  try {
    f = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (f.type === "event" && f.event === "connect.challenge") {
    req("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        displayName: "br-relay",
        version: "0.1",
        platform: "cli",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth: { token: TOKEN },
    })
      .then(() =>
        req("browser.request", {
          method: METHOD,
          path: RPATH,
          query: QJSON ? JSON.parse(QJSON) : undefined,
          body: BJSON ? JSON.parse(BJSON) : undefined,
          timeoutMs: 25000,
        }),
      )
      .then((r) => fin(0, r))
      .catch((e) => fin(1, { err: String(e?.message ?? e) }));
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (!p) return;
    pending.delete(f.id);
    f.ok ? p.res(f.payload) : p.rej(f.error);
  }
});
ws.on("error", (e) => fin(1, { err: "ws-error: " + String(e) }));
setTimeout(() => fin(1, { err: "timeout" }), 28000);
