/**
 * FORK 2026-10-25 — the memory write gate, as core and the plugin SDK see it.
 *
 * The gate is claude-plugins/tinkerclaw-core/scripts/memory-write-gate.mjs (the decision) and memory-gate-door.mjs (the
 * disk around it). Both are dependency-free JS because one of
 * its two doors is a Claude Code PreToolUse hook, and a Claude Code plugin runs from its own folder. The other door is
 * the gateway's: tinkerclaw-memory-enhancements registers a before_tool_call hook on the embedded runner's write and
 * edit tools, and reaches the same code through `openclaw/plugin-sdk/memory-engram`. One implementation, two doors.
 *
 * The public types are declared here rather than re-exported from the .mjs's .d.mts, so the emitted plugin-SDK
 * declarations never point outside dist. Assigning the implementation to them makes tsgo check that the two agree.
 *
 * see also: TINKER_UI_DESIGN_BIBLE/memory-layout.md (the write gate section)
 */
import * as door from "../../../claude-plugins/tinkerclaw-core/scripts/memory-gate-door.mjs";
import * as gate from "../../../claude-plugins/tinkerclaw-core/scripts/memory-write-gate.mjs";

/** `enforce` applies each outcome; `watch` lets every write through and only logs what it would have done. */
export type MemoryGateMode = "enforce" | "watch";

/** Who a note speaks for. `unknown` is what the backfill gives notes written before the gate. */
export type MemorySource = "owner" | "chat" | "nightly" | "third-party" | "unknown";

export type MemoryGateLabel =
  | "new"
  | "repeat"
  | "update"
  | "correction"
  | "clash"
  | "unsourced-rule"
  | "third-party";

export type MemoryGateOutcome = "save" | "skip" | "supersede" | "ask" | "quote";

/** What both doors read from <state dir>/memory-gate/config.json. */
export type MemoryGateConfig = {
  mode: MemoryGateMode;
  /** Folders or single files whose Markdown notes the gate guards. */
  roots: string[];
  /** The always-loaded files a new line is checked against for a clash. */
  rulesFiles: string[];
  /** Folder names under a root that hold logs, not notes. */
  excludeDirs?: string[];
  /** Also guard Claude Code's per-project memory folders (~/.claude/projects/<project>/memory). */
  claudeProjectMemory?: boolean;
};

export type MemoryGateDecision = {
  label: MemoryGateLabel;
  outcome: MemoryGateOutcome;
  source: MemorySource;
  sourceDeclared: boolean;
  reason: string;
  matches: Array<{ file: string; line?: number }>;
};

export type MemoryGateResult =
  | { action: "allow"; decision?: MemoryGateDecision }
  | { action: "deny"; reason: string; decision?: MemoryGateDecision }
  | {
      action: "rewrite";
      input: Record<string, unknown>;
      note: string;
      decision?: MemoryGateDecision;
    };

export type RunMemoryGateArgs = {
  door: "claude-code" | "gateway";
  toolName: string;
  /** The tool's parameters as the model sent them. */
  input: Record<string, unknown>;
  config: MemoryGateConfig | null;
  stateDir: string;
  sessionKey?: string;
  /** What the note was made from, stamped as `from:` on a new note (a session key). */
  origin?: string;
  /** What a relative path is relative to (the agent's workspace). */
  cwd?: string;
  now?: number;
};

/** Run the gate on one write tool call. Never throws: an internal error is `allow`. */
export const runMemoryGate: (args: RunMemoryGateArgs) => MemoryGateResult = door.runMemoryGate;

/** Publish (or, with null, remove) the config both doors read. Returns the path written, or null when off. */
export const publishMemoryGateConfig: (
  stateDir: string,
  config: MemoryGateConfig | null,
) => string | null = door.publishGateConfig;

/** The Claude Code auto-memory folder from ~/.claude/settings.json, when one is set. */
export const claudeAutoMemoryDir: (home?: string) => string | null = door.claudeAutoMemoryDir;

/** Folder names skipped under a memory root unless configured otherwise. */
export const MEMORY_GATE_DEFAULT_EXCLUDE_DIRS: readonly string[] = gate.DEFAULT_EXCLUDE_DIRS;
