#!/usr/bin/env node
/**
 * AMYGDALA v3.1 — PreToolUse hook (the pre-execution enforcement seam).
 *
 * Runs INSIDE claude-cli's hook sandbox (NOT the gateway process), so it must be
 * DEPENDENCY-FREE: only node builtins, no imports from the extension. tinker-bridge
 * passes `--settings <cc-hook-settings.json>` to every spawn; that settings file
 * registers this script as a PreToolUse hook. claude-cli honours a `deny`
 * permission decision here EVEN under `--permission-mode bypassPermissions`, so
 * this is a real synchronous block on the primary runner — retracting the old
 * "observe-only is a physics limit" claim.
 *
 * Contract:
 *   stdin  = PreToolUse JSON payload {tool_name, tool_input, session_id, ...}
 *   policy = $AMYGDALA_DATA_DIR/policy.json (compiled by policy-snapshot.ts)
 *   stdout = on an ENFORCED match: a hookSpecificOutput deny object; else nothing
 *   exit   = always 0 (fail-open: any internal error allows the action)
 *
 * Every meaningful decision is spooled to $AMYGDALA_DATA_DIR/hook-decisions.jsonl
 * (fire-and-forget) so the gateway extension can ingest real enforced denials —
 * the strongest feedback signal, previously invisible.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = process.env.AMYGDALA_DATA_DIR || join(homedir(), ".openclaw", "data", "amygdala");
const POLICY_PATH = join(DATA_DIR, "policy.json");
const SPOOL_PATH = join(DATA_DIR, "hook-decisions.jsonl");

/** Tool names whose input is execution-tool command text. */
const EXEC_TOOL_RE = /^(bash|shell|exec|command|run|sh|zsh)$/i;

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function spool(row) {
  try {
    appendFileSync(SPOOL_PATH, JSON.stringify(row) + "\n");
  } catch {
    /* best-effort */
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

function main() {
  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, "utf-8"));
  } catch {
    return; // no policy / corrupt → fail-open
  }
  if (!policy || !Array.isArray(policy.rules)) return;

  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return; // unparseable payload → fail-open
  }

  const toolName = String(payload.tool_name || payload.toolName || "");
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};

  // Build the two candidate texts. EXEC text is only the command (or the
  // serialized input for shell-like tools); ALL text is name + serialized input.
  let execText = "";
  if (/^bash$/i.test(toolName) && typeof toolInput?.command === "string") {
    execText = toolInput.command;
  } else if (EXEC_TOOL_RE.test(toolName)) {
    execText = safeStringify(toolInput);
  }
  const allText = `${toolName} ${safeStringify(toolInput)}`;

  const enforcement = policy.hookEnforcement !== false;
  let sampledAllow = false;

  for (const r of policy.rules) {
    if (!r || !r.source) continue;
    const text = r.scope === "all" ? allText : execText;
    if (!text) continue;
    let re;
    try {
      re = new RegExp(r.source, r.flags || "");
    } catch {
      continue;
    }
    if (!re.test(text)) continue;

    const target = String(text).slice(0, 200);
    if (r.enforce && enforcement) {
      deny(
        `AMYGDALA AEGIS [${r.id}]: ${r.explanation}. If this is genuinely intended, ask the user to confirm and they can override.`,
      );
      spool({
        ts: new Date().toISOString(),
        tool: toolName,
        target,
        decision: "deny",
        rule: r.id,
        enforced: true,
        src: "cc-hook",
      });
      return;
    }
    // Matched but observe-only (enforce:false or enforcement globally off).
    spool({
      ts: new Date().toISOString(),
      tool: toolName,
      target,
      decision: "observe",
      rule: r.id,
      enforced: false,
      src: "cc-hook",
    });
    return;
  }

  // No rule matched: spool a sampled "allow" so the feed shows the gate is alive
  // without writing a row for every benign tool call (latency + file growth).
  sampledAllow = pickSample(toolName, allText);
  if (sampledAllow) {
    spool({
      ts: new Date().toISOString(),
      tool: toolName,
      target: String(allText).slice(0, 200),
      decision: "allow",
      rule: null,
      enforced: false,
      src: "cc-hook",
    });
  }
}

function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) || "";
  } catch {
    return "";
  }
}

/** Deterministic 1-in-50 sampler keyed on the payload (no Math.random in a hook). */
function pickSample(toolName, text) {
  let h = 0;
  const s = toolName + text;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 50 === 0;
}

try {
  main();
} catch {
  /* fail-open: never block the agent on a hook error */
}
process.exit(0);
