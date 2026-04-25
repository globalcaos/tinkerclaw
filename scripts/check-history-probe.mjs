#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:18789");
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout"))), 30000);
  });
}

ws.on("message", async (raw) => {
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
  if (f.type === "event" && f.event === "connect.challenge") {
    try {
      await send("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "history-probe",
          version: "0.1",
          platform: "linux",
          mode: "cli",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        auth: { token: process.env.OPENCLAW_GATEWAY_TOKEN },
      });
      const res = await send("chat.history", { sessionKey: "agent:main:main", limit: 30 });
      console.log("RAW result keys:", res ? Object.keys(res) : res);
      const msgs = res?.messages ?? [];
      console.log(`history.length=${msgs.length}`);
      // Show last 12 messages with role + content type sketch
      for (const m of msgs.slice(-12)) {
        const types = (Array.isArray(m.content) ? m.content : [])
          .map(
            (c) =>
              c.type +
              (c.tool_use_id ? `(${c.tool_use_id.slice(0, 12)})` : "") +
              (c.id && c.type === "tool_use" ? `(${c.id.slice(0, 12)})` : ""),
          )
          .join(",");
        const text =
          (Array.isArray(m.content) ? m.content : [])
            .find((c) => c.type === "text")
            ?.text?.slice(0, 80) ?? "";
        const meta = m.__openclaw?.kind
          ? ` [${m.__openclaw.kind}/${m.__openclaw.phase ?? ""}]`
          : "";
        console.log(`  ${m.role}${meta} content=[${types}] text="${text}"`);
      }
      ws.close();
      process.exit(0);
    } catch (e) {
      console.error("err:", e?.message ?? e);
      process.exit(1);
    }
  }
});

ws.on("error", (e) => {
  console.error("ws err:", e.message);
  process.exit(2);
});
setTimeout(() => {
  console.error("hard timeout");
  process.exit(3);
}, 60000);
