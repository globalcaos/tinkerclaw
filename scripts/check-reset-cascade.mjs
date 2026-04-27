#!/usr/bin/env node
/**
 * Cascade probe: send a chat turn, fire sessions.reset on that sessionKey,
 * send another turn, then inspect the cc-bridge session-map. We expect:
 *   - turn 1 creates cc-sp-X with sessionId A
 *   - sessions.reset rotates the OpenClaw sessionId
 *   - turn 2 creates cc-sp-Y (different from cc-sp-X) with sessionId B
 *   - no `--resume` flag on turn 2's spawn
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const GATEWAY = "ws://localhost:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const SESSION_KEY = `cli:reset-${Date.now().toString(36)}`;

async function ws() {
  const sock = new WebSocket(GATEWAY);
  const pending = new Map();
  let connected = false;
  let resolveOpen;
  const open = new Promise((r) => (resolveOpen = r));
  sock.on("message", async (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "res") {
      const h = pending.get(f.id);
      if (h) {
        pending.delete(f.id);
        if (f.ok) {
          h.resolve(f.payload ?? f.result ?? f.data);
        } else {
          h.reject(f.error ?? f);
        }
      }
      return;
    }
    if (f.type === "event" && f.event === "connect.challenge" && !connected) {
      connected = true;
      const id = randomUUID();
      const handshake = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      sock.send(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "cli",
              displayName: "reset-probe",
              version: "0.1",
              platform: "linux",
              mode: "cli",
            },
            role: "operator",
            scopes: ["operator.admin"],
            caps: ["tool-events"],
            auth: { token: TOKEN },
          },
        }),
      );
      await handshake;
      resolveOpen();
    }
  });
  await open;
  return {
    req(method, params) {
      const id = randomUUID();
      const p = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      sock.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
      setTimeout(() => pending.has(id) && (pending.delete(id), p), 30000);
      return p;
    },
    onEvent(handler) {
      sock.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === "event") {
          handler(f);
        }
      });
    },
    close: () => sock.close(),
  };
}

async function sendAndWait(client, message) {
  const idemp = randomUUID();
  let resolveTurn;
  let rejectTurn;
  const turn = new Promise((res, rej) => {
    resolveTurn = res;
    rejectTurn = rej;
  });
  let final = "";
  const matches = (k) => k === SESSION_KEY || (k ?? "").endsWith(`:${SESSION_KEY}`);
  const handler = (f) => {
    const p = f.payload ?? {};
    if (f.event === "chat" && matches(p.sessionKey)) {
      if (p.state === "delta") {
        const txt = p.message?.content?.find?.((b) => b.type === "text")?.text ?? "";
        if (txt && txt.length > final.length) {
          final = txt;
        }
      } else if (p.state === "final") {
        const txt = p.message?.content?.find?.((b) => b.type === "text")?.text ?? final;
        resolveTurn(txt);
      } else if (p.state === "error" || p.state === "aborted") {
        rejectTurn(new Error(p.errorMessage ?? p.state));
      }
    }
  };
  client.onEvent(handler);
  await client.req("chat.send", { sessionKey: SESSION_KEY, message, idempotencyKey: idemp });
  setTimeout(() => rejectTurn(new Error("turn timeout")), 90000);
  return turn;
}

const sock = await ws();

console.log(`[probe] sessionKey = ${SESSION_KEY}`);
console.log("[probe] turn 1: send 'echo TURN-A'");
const t1 = await sendAndWait(sock, "Run bash 'echo TURN-A' and reply with one line.");
console.log(`[probe] turn 1 reply: ${t1.slice(0, 80)}`);

console.log("[probe] sessions.reset on this key");
const resetRes = await sock.req("sessions.reset", { key: SESSION_KEY, reason: "reset" });
console.log(`[probe] reset.ok = ${resetRes.ok} new sessionId = ${resetRes.entry?.sessionId}`);

console.log("[probe] turn 2: send 'echo TURN-B'");
const t2 = await sendAndWait(
  sock,
  "Run bash 'echo TURN-B' and reply with one line. Do not reference any previous turn.",
);
console.log(`[probe] turn 2 reply: ${t2.slice(0, 80)}`);

sock.close();
process.exit(0);
