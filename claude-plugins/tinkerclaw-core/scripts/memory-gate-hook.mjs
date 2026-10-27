#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: the memory write gate's door for Claude Code (Write, Edit, MultiEdit).
 *
 * FORK 2026-10-25. Chat workers, background reflections and plain Claude Code write memory notes with the Write and
 * Edit tools, straight to disk. This hook puts each such write through the gate (memory-write-gate.mjs decides,
 * memory-gate-door.mjs reads the disk and applies the outcome), which reads
 * the notes in the same folder and the always-loaded rule files and gives the write one outcome: saved (with its source
 * stamped), skipped as a repeat, saved with the old line struck and dated, refused until the owner answers a clash,
 * or saved as a quote only. The gateway's embedded runner goes through the same gate from the
 * tinkerclaw-memory-enhancements plugin.
 *
 * WHEN IT ACTS. Only when <state dir>/memory-gate/config.json exists: the memory-enhancements plugin publishes it on
 * gateway start from its `contradictionGate` config (`warn` = watch, `block` = enforce). No file: the hook exits
 * without reading stdin. A write outside the memory roots costs one path check.
 *
 *   enforce  a refusal is a deny with the reason; a quote, a struck old line or a source stamp is an updatedInput
 *   watch    the write runs unchanged; what the gate would have done goes to <state dir>/data/memory-gate/gate.jsonl
 *
 * The plugin can be loaded twice in one session (marketplace and --plugin-dir): the second copy stays silent for a tool
 * call the first one claimed. Exit code is always 0 and an internal error lets the write through.
 *
 * Also a small CLI: `node memory-gate-hook.mjs backfill <dir> [--apply]` gives every note in <dir> that has
 * frontmatter but no `source:` the field `source: unknown` (a dry run without --apply).
 */
import { pathToFileURL } from "node:url";
import { claim, readStdin } from "./hook-common.mjs";
import {
  backfillSources,
  gateStateDir,
  readGateConfig,
  runMemoryGate,
} from "./memory-gate-door.mjs";

/** The hook's stdout for one gate result, or "" when the write goes ahead untouched. */
export function hookOutput(result) {
  if (result.action === "deny") {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason,
      },
    })}\n`;
  }
  if (result.action === "rewrite") {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: result.input,
        additionalContext: result.note,
      },
    })}\n`;
  }
  return "";
}

function main() {
  const stateDir = gateStateDir();
  const config = readGateConfig(stateDir);
  if (!config) {
    return;
  }
  const payload = readStdin();
  const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "";
  if (toolUseId && !claim("memory-gate", toolUseId, "pre", 1)) {
    return;
  }
  const sessionKey = process.env.TC_SESSION_KEY?.trim() || "";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const result = runMemoryGate({
    door: "claude-code",
    toolName: String(payload.tool_name ?? ""),
    input: payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {},
    config,
    stateDir,
    sessionKey,
    origin: sessionKey || (sessionId ? `claude-code:${sessionId.slice(0, 8)}` : "claude-code"),
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : undefined,
  });
  const out = hookOutput(result);
  if (out) {
    process.stdout.write(out);
  }
}

function cli(argv) {
  const dir = argv[3];
  if (!dir) {
    process.stderr.write("usage: memory-gate-hook.mjs backfill <dir> [--apply]\n");
    process.exitCode = 2;
    return;
  }
  const res = backfillSources(dir, { apply: argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify({ dir, apply: argv.includes("--apply"), ...res })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "backfill") {
    cli(process.argv);
  } else {
    try {
      main();
    } catch {
      // Fail open: a gate bug must never stop a write.
    }
  }
}
