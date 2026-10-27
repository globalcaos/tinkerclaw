/**
 * The memory write gate's gateway door, and the config both doors read.
 *
 * FORK 2026-10-25. The gate itself is engram's (`runMemoryGate` from openclaw/plugin-sdk/memory-engram, the same code
 * the tinkerclaw-core Claude Code hook runs). This plugin owns two things around it:
 *
 *   1. The config. `contradictionGate` in this plugin's config switches it: `enabled: false` turns it off, `mode: "warn"`
 *      (the default) is watch, `mode: "block"` is enforce. On register the plugin publishes the resolved config (mode,
 *      memory roots, always-loaded rule files) to <state dir>/memory-gate/config.json, which is how the Claude Code
 *      hook learns it; off removes the file.
 *   2. The gateway door: a before_tool_call hook on the embedded runner's `write` and `edit` tools (crons such as the
 *      nightly consolidation, non-Claude providers). A refusal is a block with the gate's reason, a quote or a struck
 *      old line is new params, anything else passes. The handler never throws: a thrown before_tool_call blocks the
 *      call (fail-closed), and a gate bug must never cost a note.
 */
import path from "node:path";
import {
  claudeAutoMemoryDir,
  MEMORY_GATE_DEFAULT_EXCLUDE_DIRS,
  runMemoryGate,
  type MemoryGateConfig,
  type MemoryGateMode,
} from "openclaw/plugin-sdk/memory-engram";

export interface ContradictionGateConfig {
  enabled?: boolean;
  mode?: "warn" | "block";
  roots?: string[];
  rulesFiles?: string[];
  excludeDirs?: string[];
}

/** The always-loaded files of a workspace a new note is checked against. */
export const WORKSPACE_RULE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
] as const;

/** `contradictionGate` read as a gate mode: null when off, `block` = enforce, anything else = watch. */
export function resolveGateMode(cg: ContradictionGateConfig | undefined): MemoryGateMode | null {
  if (cg?.enabled === false) {
    return null;
  }
  return cg?.mode === "block" ? "enforce" : "watch";
}

/**
 * The config both doors read. Defaults: the Claude Code auto-memory folder (with its MEMORY.md as a rule file) and,
 * per agent workspace, MEMORY.md and memory/ as roots and the workspace's always-loaded files as rules. Configured
 * `roots` / `rulesFiles` replace the defaults.
 */
export function buildGateConfig(args: {
  mode: MemoryGateMode;
  workspaceDirs: string[];
  autoMemoryDir: string | null;
  cg?: ContradictionGateConfig;
}): MemoryGateConfig {
  const { mode, workspaceDirs, autoMemoryDir, cg } = args;
  const roots = [
    ...(autoMemoryDir ? [autoMemoryDir] : []),
    ...workspaceDirs.flatMap((w) => [path.join(w, "MEMORY.md"), path.join(w, "memory")]),
  ];
  const rulesFiles = [
    ...(autoMemoryDir ? [path.join(autoMemoryDir, "MEMORY.md")] : []),
    ...workspaceDirs.flatMap((w) => WORKSPACE_RULE_FILES.map((f) => path.join(w, f))),
  ];
  return {
    mode,
    roots: cg?.roots?.length ? cg.roots : roots,
    rulesFiles: cg?.rulesFiles?.length ? cg.rulesFiles : rulesFiles,
    excludeDirs: cg?.excludeDirs ?? [...MEMORY_GATE_DEFAULT_EXCLUDE_DIRS],
    claudeProjectMemory: true,
  };
}

/** The default config for this host (the Claude Code settings file supplies the auto-memory folder). */
export function defaultGateConfig(
  mode: MemoryGateMode,
  workspaceDirs: string[],
  cg?: ContradictionGateConfig,
): MemoryGateConfig {
  return buildGateConfig({ mode, workspaceDirs, autoMemoryDir: claudeAutoMemoryDir(), cg });
}

type ToolEvent = { toolName: string; params: Record<string, unknown> };
type ToolCtx = { agentId?: string; sessionKey?: string };
type ToolResult = { block: true; blockReason: string } | { params: Record<string, unknown> };

/** The before_tool_call handler for the embedded runner's write and edit tools. */
export function createWriteGateHook(args: {
  config: MemoryGateConfig;
  stateDir: string;
  workspaceFor: (agentId: string | undefined) => string | undefined;
  warn?: (msg: string) => void;
}): (event: ToolEvent, ctx: ToolCtx) => ToolResult | undefined {
  return (event, ctx) => {
    const tool = event.toolName.toLowerCase();
    if (tool !== "write" && tool !== "edit") {
      return undefined;
    }
    try {
      const result = runMemoryGate({
        door: "gateway",
        toolName: tool,
        input: event.params ?? {},
        config: args.config,
        stateDir: args.stateDir,
        sessionKey: ctx.sessionKey,
        origin: ctx.sessionKey,
        cwd: args.workspaceFor(ctx.agentId),
      });
      if (result.action === "deny") {
        return { block: true, blockReason: result.reason };
      }
      if (result.action === "rewrite") {
        return { params: result.input };
      }
      return undefined;
    } catch (err) {
      args.warn?.(
        `[memory-enhancements] write gate failed open: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  };
}
