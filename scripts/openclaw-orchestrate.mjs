#!/usr/bin/env node
/**
 * FORK 2026-06-11: openclaw-orchestrate -- CLI wrapper around the
 * prefrontal.recipe.orchestrate RPC, the sibling of openclaw-spawn-subagent.
 *
 * Purpose: give Jarvis-inside-cc-bridge a way to run a MULTI-agent dynamic
 * workflow (decompose -> fan out N units in parallel/pipeline -> verify) from a
 * shell, where EVERY spawned unit routes through fork.subagents.spawn ->
 * spawnSubagentDirect -> a `claude-code/*` child = a fresh cc-sp-* ClaudeCodeWorker
 * spawned through the IDENTICAL subscription-billed harness (systemd-run --pipe +
 * closed env allowlist + harness-strip). So the whole fan-out stays on the Max
 * subscription -- never the metered API -- and every leaf is its own cc-sp-*
 * node on the Prefrontal effort tree. This is the controlled replication of
 * Claude Code's ultracode dynamic-workflows (native workflows fork un-harnessed
 * `claude` processes that trip Anthropic's overage classifier -> metered).
 *
 * The orchestrate RPC BLOCKS until the whole script finishes (it awaits
 * runOrchestrationScript), so the WS timeout here is large (default 30 min).
 *
 * The orchestration script body may use: agent(prompt, {schema?, label?}),
 * parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args.
 *
 * Usage:
 *   openclaw-orchestrate --script-file <path.js> [--args '<json>']
 *     [--session agent:main:main] [--label name] [--timeout 1800] [--json]
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
  if (i < 0) {
    return fallback;
  }
  return argv[i + 1];
}
function boolFlag(name) {
  return argv.includes(`--${name}`);
}

const SCRIPT_FILE = flag("script-file") ?? flag("script");
if (!SCRIPT_FILE) {
  console.error("openclaw-orchestrate: --script-file <path> is required");
  console.error(
    '  usage: openclaw-orchestrate --script-file plan.js [--args \'{"q":"..."}\'] [--session agent:main:main] [--label name]',
  );
  process.exit(2);
}
let SCRIPT;
try {
  SCRIPT = fs.readFileSync(SCRIPT_FILE, "utf-8");
} catch (err) {
  console.error(`openclaw-orchestrate: cannot read --script-file ${SCRIPT_FILE}: ${String(err)}`);
  process.exit(2);
}

let ARGS;
const rawArgs = flag("args");
if (rawArgs != null) {
  try {
    ARGS = JSON.parse(rawArgs);
  } catch {
    // Not JSON -> pass the raw string through verbatim.
    ARGS = rawArgs;
  }
}

const SESSION = flag("session") ?? flag("sessionKey") ?? "agent:main:main";
const LABEL = flag("label");
const TIMEOUT_S = flag("timeout") != null ? Number(flag("timeout")) : 1800;
const EMIT_JSON = boolFlag("json");
const WS_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789")
  .replace(/^http/, "ws")
  .replace(/\/$/, "");

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
if (!TOKEN) {
  console.error(
    "openclaw-orchestrate: no gateway token -- set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token.",
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
    console.log(`orchestrate ok -- result:`);
    console.log(JSON.stringify(payload.result, null, 2));
    if (Array.isArray(payload.logs) && payload.logs.length) {
      console.log(`logs (${payload.logs.length}):`);
      for (const l of payload.logs) {
        console.log("  " + l);
      }
    }
  } else {
    console.error("orchestrate failed:", payload?.error ?? payload ?? "unknown");
  }
  try {
    ws.close();
  } catch {}
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
        displayName: "openclaw-orchestrate",
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
        req("prefrontal.recipe.orchestrate", {
          script: SCRIPT,
          args: ARGS,
          sessionKey: SESSION,
          label: LABEL,
        }),
      )
      .then((res) => done(res?.ok ? 0 : 1, res))
      .catch((err) => done(1, { ok: false, error: String(err?.message ?? err) }));
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

ws.on("error", (err) => done(1, { ok: false, error: `ws-error: ${String(err)}` }));

setTimeout(
  () => done(1, { ok: false, error: `timeout after ${TIMEOUT_S}s` }),
  Math.max(30, TIMEOUT_S) * 1000,
);
