#!/usr/bin/env node
/**
 * FORK: openclaw-recipe-state -- publish recipe + step state to the Prefrontal panel.
 *
 * Jarvis calls this while orchestrating a recipe-driven workflow so the
 * Tinker UI shows which playbook is active and which step is currently
 * running. Frontier-clean: one small WS RPC, no side effects beyond a
 * broadcast event.
 *
 * Usage:
 *   openclaw-recipe-state --recipe revise-paper --step 3 --total 6 \
 *                         --step-name "evidence check"
 *   openclaw-recipe-state --trail dispatch --label "§3-oauth-check" \
 *                         --message "dispatched to sonnet-4-6"
 *
 * Flags:
 *   Recipe state mode:
 *     --recipe <id>        (required) recipe id, e.g. revise-paper
 *     --step <n>           optional current step number (1-based)
 *     --total <n>          optional total steps
 *     --step-name <name>   optional human-readable current step name
 *     --cap <n>            optional max concurrent subagents
 *     --in-flight <labels> optional comma-separated list of labels now running
 *     --note <text>        optional free-form note (e.g. "opus for §12 only")
 *
 *   Trail event mode:
 *     --trail <kind>       one of: dispatch | complete | note | transition | warn
 *     --label <label>      optional short label of what the event concerns
 *     --message <text>     required message body
 *     --icon <glyph>       optional single-char icon override
 *
 *   Global:
 *     --session <key>      session key to scope the event to (default: agent:main:main)
 *     --json               machine-readable output on success
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

const RECIPE = flag("recipe");
const STEP = flag("step");
const TOTAL = flag("total");
const STEP_NAME = flag("step-name");
const CAP = flag("cap");
const IN_FLIGHT = flag("in-flight");
const NOTE = flag("note");
const TRAIL_KIND = flag("trail");
const LABEL = flag("label");
const MESSAGE = flag("message");
const ICON = flag("icon");
const SESSION = flag("session", "agent:main:main");
const EMIT_JSON = boolFlag("json");

if (!RECIPE && !TRAIL_KIND) {
  console.error(
    "openclaw-recipe-state: either --recipe <id> or --trail <kind> must be provided.",
  );
  process.exit(2);
}
if (TRAIL_KIND && !MESSAGE) {
  console.error("openclaw-recipe-state: --trail mode requires --message.");
  process.exit(2);
}

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
    "openclaw-recipe-state: no gateway token -- set OPENCLAW_GATEWAY_TOKEN or configure gateway.auth.token.",
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
    if (RECIPE) {
      console.log(
        `recipe-state set: ${payload.recipeId ?? RECIPE} step=${payload.step ?? STEP ?? "-"}` +
          `/${payload.totalSteps ?? TOTAL ?? "-"} stepName=${payload.stepName ?? STEP_NAME ?? "-"}`,
      );
    } else {
      console.log(`trail-event emitted: ${TRAIL_KIND} ${LABEL ?? ""}`);
    }
  } else {
    console.error("failed:", payload?.error ?? payload ?? "unknown");
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
        displayName: "openclaw-recipe-state",
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
        if (RECIPE) {
          return req("fork.prefrontal.setRecipe", {
            recipeId: RECIPE,
            step: STEP ? Number(STEP) : undefined,
            totalSteps: TOTAL ? Number(TOTAL) : undefined,
            stepName: STEP_NAME,
            parallelismCap: CAP ? Number(CAP) : undefined,
            inFlightLabels: IN_FLIGHT
              ? IN_FLIGHT.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            note: NOTE,
            sessionKey: SESSION,
          });
        }
        return req("fork.prefrontal.trailEvent", {
          kind: TRAIL_KIND,
          label: LABEL,
          message: MESSAGE,
          icon: ICON,
          sessionKey: SESSION,
        });
      })
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

setTimeout(() => done(1, { ok: false, error: "timeout after 15s" }), 15_000);
