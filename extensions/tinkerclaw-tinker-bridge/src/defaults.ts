/**
 * FORK: tinkerclaw-tinker-bridge — constants.
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
 * FORK 2026-06-11 (AMYGDALA v3.1): claude-cli settings file that registers the
 * amygdala pre-execution PreToolUse hook. The learned-intuition extension writes
 * this file when hook enforcement is on and deletes it when off — so its mere
 * PRESENCE is the enable signal. When present, tinker-bridge passes it via
 * `--settings`; the hook then synchronously DENIES destructive-execution AEGIS
 * rules INSIDE claude-cli, which works even under `bypassPermissions`. This
 * retracts the old "tinker-bridge tools can't be gated pre-execution" assumption.
 */
export const AMYGDALA_CC_HOOK_SETTINGS_PATH = path.join(
  homedir(),
  ".openclaw",
  "data",
  "amygdala",
  "cc-hook-settings.json",
);

/**
 * FORK 2026-05-04: extra plugin directories the tinker-bridge passes to
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

// FORK 2026-06-23 (BRIDGE FIX 2/3 — fast-fail init-only stall): a turn that
// emits NO visible text and NO thinking and only a tiny handful of init
// stream lines, then goes silent, is almost certainly stuck during claude-cli
// startup (auth handshake / spawn wedge) rather than doing real work. Rather
// than burn the full DEFAULT_REQUEST_TIMEOUT_MS (load-bearing for long tool
// chains — DO NOT lower it), the stream watchdog aborts such a turn early once
// elapsed > FAST_FAIL_INIT_SILENT_MS. The linesSeen<=FAST_FAIL_MAX_INIT_LINES
// gate is the critical non-regression: a legitimately-long heavy TOOL turn
// emits MANY stream lines while text.len stays 0, so it stays above this line
// budget and is NEVER fast-failed.
export const FAST_FAIL_INIT_SILENT_MS = 90_000;
export const FAST_FAIL_MAX_INIT_LINES = 5;

// FORK 2026-06-23 (oversized-resume guard): `claude --resume <uuid>` ingests
// the entire transcript .jsonl at startup. A fat transcript (14.5–15.3MB
// observed) wedges the brain: claude stalls parsing it, emits no stream
// events, and the idle watchdog SIGTERMs the worker before the turn begins.
// When the on-disk transcript exceeds this threshold the bridge starts a
// FRESH session instead of resuming (fail-open: any stat error falls through
// to a normal resume — a guard bug must never mute the brain). 8MB is well
// above a healthy multi-day conversation yet far below the wedge zone.
export const RESUME_MAX_TRANSCRIPT_BYTES = 8_000_000;

// Optional secondary ceiling (line count). Not currently enforced by the
// guard — byte size is the operative signal — but exported so the predicate
// can grow a line-based check without another constant churn.
export const RESUME_MAX_TRANSCRIPT_LINES = 50_000;

// FORK 2026-05-29: per-model `maxOutputTokens` — the model's real max output
// (thinking + visible text), the value tinker-bridge pins as
// CLAUDE_CODE_MAX_OUTPUT_TOKENS on the CLI and reports as the provider's
// maxTokens. NOT a round-number reflex: each is at-or-below its family's
// documented output ceiling (so it never 400s) and far above any realistic
// response (~15k), so it never truncates. Sonnet 4.x carries the higher 64k
// output ceiling; the Opus/Haiku families sit at 32k. Bump a value here when
// Anthropic raises a model's output limit — single source of truth.
export const DEFAULT_MODELS = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
  },
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
  opus: "claude-opus-5",
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
