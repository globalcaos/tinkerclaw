#!/usr/bin/env node
/**
 * FORK: openclaw-spawn-subagent -- CLI wrapper around fork.subagents.spawn RPC.
 *
 * Purpose: give any process that has gateway credentials a way to spawn an
 * OpenClaw subagent session from a shell. The main consumer is Jarvis inside
 * the tinkerclaw-tinker-bridge harness -- the `claude` CLI has Bash but no native
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
 *     [--label short-name] [--parent <sessionKey>] [--thinking medium]
 *     [--timeout 600] [--json]
 *     [--allow-tools Read,Grep,Glob] [--max-tokens 8000] [--max-tool-calls 40]
 *     [--idempotency-key <key>]
 *
 * Exit codes: 0 spawned (or replayed), 1 failed (no child was created), 2 usage,
 * 4 OUTCOME UNKNOWN: the spawn request was sent but no answer came back, so the
 * child may exist. Do not retry blindly on 4; check the gateway first.
 *
 * --idempotency-key makes a retry safe. The first call records its outcome under
 * <state dir>/spawn-idempotency/. A later call with the same key prints the recorded
 * answer (with `replayed: true`) instead of spawning, and an earlier call whose outcome
 * is unknown makes it exit 4 without spawning. A refused spawn records nothing.
 *
 * --parent is OPTIONAL and has NO default (2026-08-04). Omit it and this CLI
 * sends NO `parentSessionKey` at all, so the RPC boundary picks the requester
 * (src/fork/subagents-rpc.ts reads `parentSessionKey ?? sessionKey`) and the
 * child lands on the headless sink instead of silently claiming the human Main
 * tab. Pass --parent only when you really mean to attribute the child to a
 * specific live session.
 *
 * Environment:
 *   OPENCLAW_GATEWAY_URL     default: http://127.0.0.1:18789 (WS derived)
 *   OPENCLAW_GATEWAY_TOKEN   required (or present in ~/.openclaw/openclaw.json)
 *   OPENCLAW_SPAWN_ACK_TIMEOUT_MS  how long to wait for the spawn answer (default 310000)
 */
import crypto from "node:crypto";
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

const TASK = flag("task") ?? argv.find((a) => !a.startsWith("--"));
if (!TASK) {
  console.error("openclaw-spawn-subagent: --task is required");
  console.error('  usage: openclaw-spawn-subagent --task "Research X" [--model ...] [--label ...]');
  process.exit(2);
}

// FORK 2026-10-21: optional admission hook. On a small host (the Pi) a burst of gateway-routed spawns
// stalls the gateway's event loop and every chat with it. If the host installs an executable
// `<state dir>/admit`, it is run as `admit gateway` and may block until the gateway can take another
// agent; any non-zero exit or a missing hook lets the spawn through. Opt out with OPENCLAW_ADMIT=0.
{
  const admit = path.join(
    process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"),
    "admit",
  );
  if (process.env.OPENCLAW_ADMIT !== "0" && fs.existsSync(admit)) {
    const { spawnSync } = await import("node:child_process");
    spawnSync(admit, ["gateway"], { stdio: ["ignore", "ignore", "inherit"] });
  }
}

const MODEL = flag("model");
const LABEL = flag("label");
const THINKING = flag("thinking");
// NO default parent (2026-08-04). The old literal "agent:main:main" made every
// unattended spawn claim the human Main tab: ORCA
// (docs/superpowers/parallel-implement.workflow.js) shells this CLI with only
// --task/--label/--model/--json and never passes --parent, so every critic/panel
// child hung off Main. Leaving PARENT undefined omits the field from the RPC
// payload entirely and lets the gateway boundary apply the headless sink.
const PARENT = flag("parent") ?? flag("parentSessionKey");
const TIMEOUT = flag("timeout");
const ALLOW_TOOLS = flag("allow-tools");
const MAX_TOKENS = flag("max-tokens") != null ? Number.parseInt(flag("max-tokens"), 10) : undefined;
const MAX_TOOL_CALLS =
  flag("max-tool-calls") != null ? Number.parseInt(flag("max-tool-calls"), 10) : undefined;
const EMIT_JSON = boolFlag("json");
const IDEMPOTENCY_KEY = flag("idempotency-key");
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
    "openclaw-spawn-subagent: no gateway token -- set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token.",
  );
  process.exit(2);
}

// FORK 2026-11-14 (burn review orchestration/F1): a spawn whose answer is slow went ahead in
// the gateway after this CLI had already reported it failed, and a retry made a second child.
// The journal below lets a retry with the same --idempotency-key reuse the first outcome.
const journalPath = IDEMPOTENCY_KEY
  ? path.join(
      process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"),
      "spawn-idempotency",
      crypto.createHash("sha256").update(IDEMPOTENCY_KEY).digest("hex").slice(0, 32) + ".json",
    )
  : null;
function readJournal() {
  try {
    return JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  } catch {
    return null;
  }
}
function writeJournal(record) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify(record));
}

function emit(payload) {
  if (EMIT_JSON) {
    console.log(JSON.stringify(payload));
  } else if (payload?.ok) {
    console.log(
      `spawned subagent childSessionKey=${payload.childSessionKey ?? "-"} runId=${payload.runId ?? "-"}` +
        (payload.note ? ` note=${payload.note}` : "") +
        (payload.replayed ? " (replayed)" : ""),
    );
  } else {
    console.error("spawn failed:", payload?.error ?? payload ?? "unknown");
  }
}

if (journalPath) {
  const prior = readJournal();
  if (prior?.state === "done" && prior.result?.ok) {
    emit({ ...prior.result, replayed: true });
    process.exit(0);
  }
  if (prior?.state === "pending") {
    emit({
      ok: false,
      ackTimedOut: true,
      error: `an earlier spawn with this idempotency key (sent ${prior.at}) got no answer; the child may exist, so this call did not spawn again`,
    });
    process.exit(4);
  }
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

let spawnSent = false;
let finished = false;
const done = (code, payload) => {
  if (finished) {
    return;
  }
  finished = true;
  emit(payload);
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
      .then(() => {
        if (journalPath) {
          writeJournal({ state: "pending", at: new Date().toISOString() });
        }
        spawnSent = true;
        return req("fork.subagents.spawn", {
          task: TASK,
          model: MODEL,
          label: LABEL,
          thinking: THINKING,
          // Omit the field entirely when no --parent was given: the RPC boundary
          // (`parentSessionKey ?? sessionKey`) then applies the headless sink
          // instead of inheriting the human Main tab.
          ...(PARENT ? { parentSessionKey: PARENT } : {}),
          runTimeoutSeconds: TIMEOUT ? Number(TIMEOUT) : undefined,
          ...(ALLOW_TOOLS
            ? {
                allowTools: ALLOW_TOOLS.split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(MAX_TOKENS != null && Number.isFinite(MAX_TOKENS) ? { maxTokens: MAX_TOKENS } : {}),
          ...(MAX_TOOL_CALLS != null && Number.isFinite(MAX_TOOL_CALLS)
            ? { maxToolCalls: MAX_TOOL_CALLS }
            : {}),
        });
      })
      .then((res) => {
        if (journalPath) {
          if (res?.ok) {
            try {
              writeJournal({ state: "done", at: new Date().toISOString(), result: res });
            } catch {} // the child exists: never turn this success into a reported failure
          } else {
            fs.rmSync(journalPath, { force: true });
          }
        }
        done(res?.ok ? 0 : 1, res);
      })
      .catch((err) => {
        // The gateway answered with an error: it refused, so no child exists and a retry is safe.
        if (journalPath) {
          fs.rmSync(journalPath, { force: true });
        }
        done(1, { ok: false, error: String(err?.message ?? err) });
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

// Once the spawn request is out, a lost answer is not a failure: the gateway may still create
// the child, so report the outcome as unknown (exit 4) and keep any journal record as pending.
const unknown = (why) =>
  done(4, {
    ok: false,
    ackTimedOut: true,
    error: `${why}; the gateway may still have created the child`,
  });

ws.on("error", (err) => {
  if (spawnSent) {
    unknown(`ws-error after the spawn was sent: ${String(err)}`);
  } else {
    done(1, { ok: false, error: `ws-error: ${String(err)}` });
  }
});
ws.on("close", () => {
  if (spawnSent) {
    unknown("connection closed before fork.subagents.spawn answered");
  } else {
    done(1, { ok: false, error: "connection closed before the spawn was sent" });
  }
});

// The gateway allows its inner `agent` call 60-300 s (src/agents/subagent-spawn.ts), so the old
// fixed 30 s wait gave up on spawns that then went ahead anyway. Wait at least as long.
const ACK_TIMEOUT_MS =
  Number(process.env.OPENCLAW_SPAWN_ACK_TIMEOUT_MS) > 0
    ? Number(process.env.OPENCLAW_SPAWN_ACK_TIMEOUT_MS)
    : 310_000;
setTimeout(() => {
  if (spawnSent) {
    unknown(`no answer from fork.subagents.spawn after ${ACK_TIMEOUT_MS / 1000}s`);
  } else {
    done(1, { ok: false, error: `no gateway handshake after ${ACK_TIMEOUT_MS / 1000}s` });
  }
}, ACK_TIMEOUT_MS);
