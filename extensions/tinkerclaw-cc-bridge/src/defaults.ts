/**
 * FORK: tinkerclaw-cc-bridge — constants.
 *
 * Purpose: central home for default values used across the bridge plugin —
 * binary path, cwd, disallowed-tools list, model catalog. Keeping these
 * isolated so empirical tweaks don't sprawl.
 */
import { homedir } from "node:os";
import path from "node:path";

export const PROVIDER_ID = "claude-code";
export const PROVIDER_LABEL = "Claude Code (OAuth)";
export const DEFAULT_BINARY = "claude";
export const DEFAULT_CWD = path.join(homedir(), ".openclaw", "jarvis-workspace");
export const CREDENTIALS_PATH = path.join(homedir(), ".claude", ".credentials.json");

/**
 * Tools we disable inside claude. Kept minimal on purpose: Jarvis needs
 * Bash/Read/Write/Edit/Grep/Glob to do real work (run `jarvis "<text>"` for
 * voice, read memory files, write notes, etc.). We disable only tools that
 * are actively harmful in an agent-loop context: Agent (subagent spawning
 * would fork claude processes), ExitPlanMode / AskUserQuestion / TodoWrite
 * (IDE-session-only UX), TaskCreate/TaskUpdate/... (Claude Code's own task
 * system, not our session's).
 *
 * If a specific tool misbehaves, add it here — but the default is PERMISSIVE:
 * Jarvis should have his full shell unless there's a specific reason not to.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  "Agent",
  "ExitPlanMode",
  "AskUserQuestion",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "TaskOutput",
];

/** Permission mode passed to claude so it doesn't wait for human approval on tool calls. */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions" as const;

// FORK (2026-04-21): per-model contextWindow. Previously catalog.ts hardcoded
// 200_000 for every model, which made pi-agent-core think Opus 4.7 had the
// old 200k window and triggered preemptive compaction on turn 0 the moment
// the bootstrap stack + main-session history loaded past 200k. Opus 4.7 and
// Sonnet 4.6 are the 1M-context variants; Opus 4.6 and Haiku 4.5 keep 200k.
export const DEFAULT_MODELS = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true, contextWindow: 1_000_000 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, contextWindow: 200_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, contextWindow: 1_000_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, contextWindow: 200_000 },
] as const;

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};
