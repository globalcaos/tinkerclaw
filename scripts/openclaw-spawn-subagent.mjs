#!/usr/bin/env node
/**
 * FORK: openclaw-spawn-subagent -- CLI wrapper around fork.subagents.spawn RPC.
 *
 * Purpose: give any process that has gateway credentials a way to spawn an
 * OpenClaw subagent session from a shell. The main consumer is Jarvis inside
 * the tinkerclaw-cc-bridge harness -- the `claude` CLI has Bash but no native
 * `sessions_spawn` tool, so without this helper Prefrontal's subagent tree
 * stays empty forever. Also useful for tests, cron jobs, and ad-hoc triage.
 *
 * Provider-agnostic: the RPC this calls lives in src/fork/subagents-rpc.ts
 * and wraps the same `spawnSubagentDirect` code path the native
 * `sessions_spawn` tool uses. If the fork ever switches back to an ordinary
 * LLM provider (anthropic / openai / ollama), the native tool keeps working
 * via pi-agent-core and this helper just sits idle -- zero conflict.
 *
 * Usage:
 *   openclaw-spawn-subagent --task "Research X" [--model claude-code/claude-opus-4-7]
 *     [--label short-name] [--parent agent:main:main] [--thinking medium]
 *     [--timeout 600] [--json]
 *
 * Environment:
 *   OPENCLAW_GATEWAY_URL     default: http://127.0.0.1:18789 (WS derived)
 *   OPENCLAW_GATEWAY_TOKEN   required (or present in ~/.openclaw/openclaw.json)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) {return fallback;}
  return argv[i + 1];
}
function boolFlag(name) {
  return argv.includes(`--${name}`);
}

const TASK = flag("task") ?? argv.find((a) => !a.startsWith("--"));
if (!TASK) {
  console.error("openclaw-spawn-subagent: --task is required");
  console.error('  usage: openclaw-spawn-subagent --task "Research X" [--model ...] [--label ...]');
  process.exit(2);
}

const MODEL = flag("model");
const LABEL = flag("label");
const THINKING = flag("thinking");
const PARENT = flag("parent") ?? flag("parentSessionKey") ?? "agent:main:main";
const TIMEOUT = flag("timeout");
const EMIT_JSON = boolFlag("json");
const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789")
  .replace(/^http/, "ws")
  .replace(/\/$/, "");

function resolveToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {return process.env.OPENCLAW_GATEWAY_TOKEN;}
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const t = cfg?.gateway?.auth?.token ?? cfg?.gateway?.controlUi?.auth?.token;
    if (typeof t === "string" && t) {return t;}
  } catch {}
  return "";
}
const TOKEN = resolveToken();
if (!TOKEN) {
  console.error(
    "openclaw-spawn-subagent: no gateway token -- set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token.",
  );
  process.exit(2);
}

const pending = new Map();
function uuid() {
  return "cli-" + Math.random().toString(36).slice(2, 14) + "-" + Date.now();
}

const ws = new WebSocket(WS_URL, {
  headers: {
    Origin: process.env.OPENCLAW_SPAWN_ORIGIN ?? "http://127.0.0.1:18790",
    Authorization: `Bearer ${TOKEN}`,
  },
});

function req(method, params) {
  return new Promise((resolve, reject) => {
    const id = uuid();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

const done = (code, payload) => {
  if (EMIT_JSON) {
    console.log(JSON.stringify(payload));
  } else if (payload?.ok) {
    console.log(
      `spawned subagent childSessionKey=${payload.childSessionKey ?? "-"} runId=${payload.runId ?? "-"}` +
        (payload.note ? ` note=${payload.note}` : ""),
    );
  } else {
    console.error("spawn failed:", payload?.error ?? payload ?? "unknown");
  }
  try { ws.close(); } catch {}
  process.exit(code);
};

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
        displayName: "openclaw-spawn-subagent",
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
        req("fork.subagents.spawn", {
          task: TASK,
          model: MODEL,
          label: LABEL,
          thinking: THINKING,
          parentSessionKey: PARENT,
          runTimeoutSeconds: TIMEOUT ? Number(TIMEOUT) : undefined,
        }),
      )
      .then((res) => done(res?.ok ? 0 : 1, res))
      .catch((err) => done(1, { ok: false, error: String(err?.message ?? err) }));
    return;
  }
  if (frame.type === "res") {
    const p = pending.get(frame.id);
    if (!p) {return;}
    pending.delete(frame.id);
    if (frame.ok) {p.resolve(frame.payload);}
    else {p.reject(frame.error);}
  }
});

ws.on("error", (err) => done(1, { ok: false, error: `ws-error: ${String(err)}` }));

setTimeout(() => done(1, { ok: false, error: "timeout after 30s" }), 30_000);
