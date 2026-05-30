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

/**
 * FORK 2026-05-04: extra plugin directories the cc-bridge passes to
 * claude-cli via `--plugin-dir`. Without this, Jarvis cannot see any of the
 * 88 skills in `~/.openclaw/workspace/skills/` (notably `outlook-hack` and
 * `teams-hack`) because claude-code only loads skills from PLUGINS, not from
 * `${cwd}/.claude/skills/`. The wrapper at the path below has a `skills`
 * symlink pointing at the workspace skills dir, giving claude-code the
 * expected `<plugin-root>/skills/<name>/SKILL.md` layout.
 *
 * If the wrapper directory doesn't exist on a host (fresh clone, different
 * deployment), claude-cli logs a warning and continues — Jarvis just sees
 * fewer skills. Safe default.
 */
export const DEFAULT_PLUGIN_DIRS = [
  path.join(homedir(), ".openclaw", "jarvis-plugins", "jarvis-skills"),
];

// FORK (2026-04-21): per-model contextWindow. Previously catalog.ts hardcoded
// 200_000 for every model, which made pi-agent-core think Opus 4.7 had the
// old 200k window and triggered preemptive compaction on turn 0 the moment
// the bootstrap stack + main-session history loaded past 200k. Opus 4.7 and
// Sonnet 4.6 are the 1M-context variants; Opus 4.6 and Haiku 4.5 keep 200k.
//
// FORK 2026-05-05: provider-level idle timeout. pi-agent-core's
// `resolveLlmIdleTimeoutMs` only reads from `providerConfig.timeoutSeconds`
// — per-model `requestTimeoutMs` alone is ignored. claude-cli's tool work
// emits NO `stream.push` events to pi-ai (tool_use blocks would trigger
// re-execution; see FORK 2026-04-22 in stream.ts), so a long tool chain
// looks "idle" to the watchdog even though claude is actively working. With
// the default 120s a complex turn (e.g. "read outlook AND list project
// state from memory") fires the idle timer twice and surfaces
// `__ERR_ENV__:Something went wrong while processing your request` over WA.
// 10 min is generous enough for heavy turns; the model-fallback layer will
// still bail correctly on truly stuck subprocesses.
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

// FORK 2026-05-29: per-model `maxOutputTokens` — the model's real max output
// (thinking + visible text), the value cc-bridge pins as
// CLAUDE_CODE_MAX_OUTPUT_TOKENS on the CLI and reports as the provider's
// maxTokens. NOT a round-number reflex: each is at-or-below its family's
// documented output ceiling (so it never 400s) and far above any realistic
// response (~15k), so it never truncates. Sonnet 4.x carries the higher 64k
// output ceiling; the Opus/Haiku families sit at 32k. Bump a value here when
// Anthropic raises a model's output limit — single source of truth.
export const DEFAULT_MODELS = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
] as const;

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

/** Output-token ceiling for a model id (resolves aliases). Falls back to a
 *  safe 32k when the model is unknown/unset. */
export function maxOutputTokensFor(modelId: string | undefined): number {
  if (!modelId) return 32_000;
  const id = MODEL_ALIASES[modelId] ?? modelId;
  return DEFAULT_MODELS.find((m) => m.id === id)?.maxOutputTokens ?? 32_000;
}
