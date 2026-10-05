#!/usr/bin/env node
// Capture every gateway frame for ONE scratch session through one real turn, plus periodic
// chat.history reads, so the Tinker UI's live path can be replayed offline with real frames.
// Based on tinkerclaw scripts/tinker-probe.mjs (same handshake). Writes only under --out.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { WebSocket } = require("ws");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};
const SESSION = flag("session");
const PROMPT = fs.readFileSync(flag("prompt-file"), "utf-8");
const OUT = flag("out");
const HISTORY_EVERY_MS = Number(flag("history-every", 8)) * 1000;
const SETTLE_MS = Number(flag("settle", 60)) * 1000;
const TIMEOUT_MS = Number(flag("timeout", 900)) * 1000;
if (!SESSION || !OUT) {
  console.error("need --session and --out");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function token() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const cfg = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf-8"),
  );
  return cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token ?? "";
}
const TOKEN = token();
const t0 = Date.now();
const frames = fs.createWriteStream(path.join(OUT, "frames.ndjson"), { flags: "w" });
const sessId = SESSION.split(":").pop();
const runKey = "dupcap-" + Math.random().toString(36).slice(2, 10) + "-" + t0;

function keyOf(frame) {
  const p = frame?.payload ?? {};
  return p.sessionKey ?? p?.data?.sessionKey ?? "";
}
function mine(frame) {
  const k = keyOf(frame);
  return typeof k === "string" && k.includes(sessId);
}

const ws = new WebSocket(process.env.CAP_WS ?? "ws://127.0.0.1:18789", {
  headers: { Origin: "http://127.0.0.1:18790", Authorization: `Bearer ${TOKEN}` },
});
const pending = new Map();
let n = 0;
function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = `cap-${++n}`;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

let finals = 0;
let firstFinalAt = 0;
let histN = 0;
let histTimer = null;
let done = false;
async function readHistory(tag) {
  try {
    const res = await req("chat.history", { sessionKey: SESSION, limit: 200 });
    const file = path.join(OUT, `history-${String(++histN).padStart(3, "0")}-${tag}.json`);
    fs.writeFileSync(file, JSON.stringify({ t: Date.now() - t0, tag, res }, null, 1));
    frames.write(
      JSON.stringify({
        t: Date.now() - t0,
        dir: "note",
        note: `history ${histN} ${tag}`,
        file: path.basename(file),
      }) + "\n",
    );
  } catch (e) {
    frames.write(
      JSON.stringify({
        t: Date.now() - t0,
        dir: "note",
        note: `history error ${String(e?.message ?? e)}`,
      }) + "\n",
    );
  }
}
function finish(why) {
  if (done) return;
  done = true;
  clearInterval(histTimer);
  readHistory("end").finally(() => {
    frames.write(JSON.stringify({ t: Date.now() - t0, dir: "note", note: `finish ${why}` }) + "\n");
    frames.end(() => {
      try {
        ws.close();
      } catch {}
      console.log(JSON.stringify({ why, finals, runKey, ms: Date.now() - t0, out: OUT }));
      process.exit(0);
    });
  });
}
setTimeout(() => finish("timeout"), TIMEOUT_MS);

ws.on("message", (buf) => {
  let f;
  try {
    f = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (p) {
      pending.delete(f.id);
      if (p.method !== "chat.history") {
        frames.write(
          JSON.stringify({
            t: Date.now() - t0,
            dir: "res",
            method: p.method,
            ok: f.ok,
            payload: f.payload,
            error: f.error,
          }) + "\n",
        );
      }
      f.ok ? p.resolve(f.payload) : p.reject(new Error(JSON.stringify(f.error)));
    }
    return;
  }
  if (f.type !== "event") return;
  if (f.event === "connect.challenge") {
    req("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        displayName: "Dup Capture",
        version: "0.3",
        platform: "web",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: ["tool-events"],
      auth: { token: TOKEN },
    })
      .then(async () => {
        frames.write(
          JSON.stringify({ t: Date.now() - t0, dir: "note", note: "connected", runKey }) + "\n",
        );
        await readHistory("before");
        const res = await req("chat.send", {
          sessionKey: SESSION,
          message: PROMPT,
          idempotencyKey: runKey,
        });
        frames.write(JSON.stringify({ t: Date.now() - t0, dir: "note", note: "sent", res }) + "\n");
        histTimer = setInterval(() => readHistory("mid"), HISTORY_EVERY_MS);
      })
      .catch((e) => {
        console.error("connect/send failed", e);
        finish("error");
      });
    return;
  }
  if (!mine(f)) return;
  frames.write(
    JSON.stringify({
      t: Date.now() - t0,
      dir: "in",
      event: f.event,
      seq: f.seq,
      payload: f.payload,
    }) + "\n",
  );
  if (f.event === "chat" && f.payload?.state === "final") {
    finals++;
    readHistory(`after-final-${finals}`);
    if (!firstFinalAt) {
      firstFinalAt = Date.now();
      setTimeout(() => finish("settled"), SETTLE_MS);
    }
  }
});
ws.on("error", (e) => {
  console.error("ws error", String(e));
});
ws.on("close", () => {
  if (!done) finish("closed");
});
