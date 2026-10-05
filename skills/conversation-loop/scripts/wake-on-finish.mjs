#!/usr/bin/env node
// wake-on-finish.mjs — watch a SLAVE session and, the moment its turn ends, inject a
// wake-up prompt into the MASTER session so the driving agent gets a fresh turn.
//
// This is the half of the converse loop that converse.mjs cannot do: converse.mjs waits
// INSIDE the caller's turn, so a 5-15 minute agent run either times out or burns the
// caller's whole turn watching a spinner. This script is launched DETACHED (systemd user
// unit — a bare background subprocess is reaped when the caller's turn ends) and outlives
// the turn that armed it.
//
// Usage:
//   node wake-on-finish.mjs --watch <slaveKey> --wake <masterKey> \
//        [--label "<name>"] [--brief] [--message "turn finished, continue"] \
//        [--max-chars 4000] [--timeout 3600] [--ready-file /tmp/x.ready]
//
//   --brief      send ONLY the short line, never the slave's reply text. Use when the
//                master must not read the slave's answer (it audits the artifact instead).
//   default      carry the slave's whole final message into the wake prompt.
//
// The wake prompt is prefixed with `⟦AGENT:<label>⟧` so it lands in the master's tab as a
// blue agent bubble titled with the SLAVE's tab name — the human sees which agent woke
// whom. Label defaults to the slave tab's own cookiePhrase.
//
// Stop an armed watcher:  systemctl --user stop converse-wake-<slave-id>.service
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
const require = createRequire(
  process.env.OPENCLAW_WS_REQUIRE_BASE ?? path.join(os.homedir(), "src/tinkerclaw/package.json"),
);
const { WebSocket } = require("ws");

const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n) => process.argv.includes("--" + n);
const SLAVE = arg("watch");
const MASTER = arg("wake");
const BRIEF = has("brief");
const SHORT = arg("message") ?? "turn finished, continue";
const MAX_CHARS = Number(arg("max-chars") ?? 4000);
const TIMEOUT_MS = Number(arg("timeout") ?? 3600) * 1000;
const READY_FILE = arg("ready-file");
let LABEL = arg("label");
if (!SLAVE || !MASTER) {
  console.error("wake-on-finish: --watch <slaveKey> --wake <masterKey> required");
  process.exit(2);
}
const ARMED_AT = Date.now();

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
  console.error("wake-on-finish: no gateway token");
  process.exit(2);
}

const pending = new Map();
const uuid = () => "wof-" + Math.random().toString(36).slice(2, 12) + "-" + Date.now();
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
const msgText = (m) => {
  if (!m) return "";
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join("");
  return "";
};

let done = false;
async function wake(body, why) {
  if (done) return;
  done = true;
  const label = LABEL || "Agent";
  try {
    await req("sessions.send", {
      key: MASTER,
      message: `⟦AGENT:${label}⟧ ` + body,
      idempotencyKey: `wake-${SLAVE}-${ARMED_AT}`,
    });
    console.error(`woke ${MASTER} (${why})`);
  } catch (err) {
    console.error("wake failed:", err?.message ?? err);
  }
  try {
    ws.close();
  } catch {}
  process.exit(0);
}

// A `final` chat event is NOT the end of the turn. An agent run emits a `final` for every
// assistant message segment (text before a tool call, then more tools, then the next text), so
// the first terminal event woke the master 12 s into a 10-minute Grok run (2026-09-23 06:24).
// The ground truth is the gateway's own run state: wake only once sessions.list reports the
// slave as no longer `running`, AND only after it has been seen running since we armed (so a
// slave that has not picked the turn up yet does not look "finished"). Terminal events just
// record the latest reply text and trigger an early check.
const isTerminal = (ev) =>
  ev?.state === "final" || ev?.state === "error" || ev?.state === "aborted";
let sawRunning = false;
let lastReply = "";
let lastState = "";
async function slaveStatus() {
  try {
    const list = await req("sessions.list", {});
    const s = (list?.sessions ?? []).find((x) => x?.key === SLAVE);
    return s?.status ?? null;
  } catch {
    return null;
  }
}
let checking = false;
async function checkDone(why) {
  if (done || checking) return;
  checking = true;
  try {
    const st = await slaveStatus();
    if (st === "running") {
      sawRunning = true;
      return;
    }
    if (!sawRunning || st == null) return;
    if (BRIEF || !lastReply) return wake(SHORT, `slave ${st} (${why})`);
    wake(
      `${SHORT}\n\n--- reply from the watched session ---\n${lastReply.slice(0, MAX_CHARS)}${
        lastReply.length > MAX_CHARS ? "\n… (truncated)" : ""
      }\n--- end of reply ---`,
      `slave ${st} (${why})`,
    );
  } finally {
    checking = false;
  }
}
function onChat(ev) {
  if (done || !ev || typeof ev.runId !== "string") return;
  if (ev.runId.startsWith("inject-user-")) return; // the echo of the prompt we injected
  const key = ev.sessionKey ?? ev.key;
  if (key && key !== SLAVE) return;
  sawRunning = true; // any non-echo event from the slave means its run has started
  if (!isTerminal(ev)) return;
  const text = msgText(ev.message).trim();
  if (text) lastReply = text;
  lastState = ev.state;
  console.error(`terminal ${ev.state} runId=${ev.runId} — confirming with sessions.list`);
  setTimeout(() => checkDone(`after ${lastState}`), 3000);
}

ws.on("message", async (buf) => {
  let f;
  try {
    f = JSON.parse(buf.toString());
  } catch {
    return;
  }
  if (f.type === "event" && f.event === "chat") return onChat(f.payload);
  if (f.type === "event" && f.event === "connect.challenge") {
    req("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        displayName: "wake-on-finish",
        version: "0.1",
        platform: "cli",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
      auth: { token: TOKEN },
    })
      .then(async () => {
        if (!LABEL) {
          try {
            const list = await req("sessions.list", {});
            const s = (list?.sessions ?? []).find((x) => x?.key === SLAVE);
            const n = s?.cookiePhrase ?? s?.title ?? "";
            LABEL = typeof n === "string" && n.trim() ? n.trim().slice(0, 60) : "Agent";
          } catch {
            LABEL = "Agent";
          }
        }
        if (READY_FILE) {
          try {
            fs.writeFileSync(READY_FILE, String(Date.now()));
          } catch {}
        }
        console.error(`armed: watching ${SLAVE} -> waking ${MASTER} as "${LABEL}"`);
        // Safety net: a missed event must not stall the loop, so poll the run state too.
        setInterval(() => checkDone("poll"), 10000);
      })
      .catch((e) => {
        console.error("connect failed:", e?.message ?? e);
        process.exit(1);
      });
    return;
  }
  if (f.type === "res" && pending.has(f.id)) {
    const { resolve, reject } = pending.get(f.id);
    pending.delete(f.id);
    if (f.ok === false || f.error) reject(new Error(JSON.stringify(f.error ?? f)));
    else resolve(f.result ?? f.payload ?? {});
  }
});
ws.on("error", (e) => {
  console.error("ws error:", e?.message ?? e);
  process.exit(1);
});
ws.on("close", () => {
  if (!done) {
    console.error("ws closed before the watched turn ended");
    process.exit(1);
  }
});
// A watcher that dies silently is worse than one that never armed: on expiry the master is
// woken anyway, told it timed out, so the loop surfaces instead of stalling.
setTimeout(() => {
  wake(
    `no terminal event from the watched session after ${Math.round(TIMEOUT_MS / 1000)}s — check its status before resending`,
    "timeout",
  );
}, TIMEOUT_MS).unref?.();
