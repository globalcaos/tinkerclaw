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
 * Tools we disable inside claude. OpenClaw already runs its own tool loop via
 * pi-embedded-runner; we want claude to produce TEXT ONLY for v0.1.
 * Everything in the built-in Claude Code tool set that could mutate state or
 * invoke subagents lives here.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Agent",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "AskUserQuestion",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "TaskOutput",
  "ExitPlanMode",
];

export const DEFAULT_MODELS = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false },
] as const;

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};
