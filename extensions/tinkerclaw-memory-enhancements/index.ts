/**
 * tinkerclaw-memory-enhancements — plugin entrypoint.
 *
 * Layers four fork wins on top of upstream memory-core without touching
 * memory-core itself:
 *
 *   1. Hippocampus O(1) concept index — pre-computed anchor → chunk lookup.
 *      Bypasses hybrid search entirely for known concepts. v0.1 ships the
 *      core data structure + persistence; v0.2 wires it into retrieval as
 *      a pre-search short-circuit.
 *
 *   2. Task-conditioned retrieval scoring — biases retrieval scores by the
 *      current task context (not just the query text). v0.1 is a stub that
 *      logs readiness; v0.2 will register a score-modifier via the hybrid
 *      search pipeline once upstream exposes a stable hook point.
 *
 *   3. Memory write gate (config key `contradictionGate`) — one gate in front
 *      of every memory note write. It reads the notes in the same folder and
 *      the always-loaded rule files and gives each write one outcome: saved
 *      with its source, skipped as a repeat, saved with the old line struck
 *      and dated, refused until the owner answers a clash, or kept as a quote.
 *      The gate is engram's (openclaw/plugin-sdk/memory-engram); this plugin
 *      publishes its config for the tinkerclaw-core Claude Code hook and runs
 *      the gateway door (before_tool_call on write/edit). "warn" = watch (log
 *      only, the default), "block" = enforce. See src/write-gate-door.ts.
 *
 *   4. Compaction-aware capture — before context compaction drops old
 *      messages, snapshot them into the memory-core corpus so nothing
 *      important is lost. Uses before_compaction hook to pre-capture.
 *
 * Design philosophy: memory-core is the chassis, this plugin adds the
 * fork's uniquely useful bits as a standalone, shippable, ClawHub-ready
 * bundle. Remove this plugin and memory-core still works — you just lose
 * the fork wins. Install it on a vanilla openclaw and memory-core gains
 * the fork wins.
 *
 * Status: hippocampus index and the memory write gate run; task-conditioned
 * scoring is still a scaffold and compaction-capture an observer.
 */

import path from "node:path";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { publishMemoryGateConfig } from "openclaw/plugin-sdk/memory-engram";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { HippocampusIndex, type HippocampusIndexConfig } from "./src/hippocampus-index.js";
import {
  createWriteGateHook,
  defaultGateConfig,
  resolveGateMode,
  type ContradictionGateConfig,
} from "./src/write-gate-door.js";

interface MemoryEnhancementsConfig {
  enabled?: boolean;
  hippocampusIndex?: {
    enabled?: boolean;
    indexDir?: string;
    minConceptLength?: number;
    importanceThreshold?: number;
  };
  taskConditionedScoring?: {
    enabled?: boolean;
    taskWeight?: number;
  };
  contradictionGate?: ContradictionGateConfig;
  compactionCapture?: {
    enabled?: boolean;
    captureMode?: "dropped-only" | "full-context";
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME ?? "", p.slice(1));
  }
  return p;
}

export default definePluginEntry({
  id: "tinkerclaw-memory-enhancements",
  name: "Memory Enhancements",
  description:
    "Four retrieval, write-safety and compaction enhancements layered on upstream memory-core.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as MemoryEnhancementsConfig;
    const enabled = cfg.enabled !== false;

    if (!enabled) {
      api.logger.info("[memory-enhancements] disabled via config");
      return;
    }

    // ---------------------------------------------------------------------
    // 1. Hippocampus O(1) concept index — initialize on load.
    // ---------------------------------------------------------------------
    const hippoCfg: HippocampusIndexConfig = {
      indexDir: expandHome(
        cfg.hippocampusIndex?.indexDir ?? "~/.openclaw/state/memory-enhancements/hippocampus",
      ),
      minConceptLength: cfg.hippocampusIndex?.minConceptLength ?? 3,
      importanceThreshold: cfg.hippocampusIndex?.importanceThreshold ?? 0.5,
    };
    const hippocampus = new HippocampusIndex(hippoCfg);

    const hippoEnabled = cfg.hippocampusIndex?.enabled !== false;
    if (hippoEnabled) {
      try {
        hippocampus.load();
        const stats = hippocampus.stats();
        api.logger.info(
          `[memory-enhancements] hippocampus: loaded ${stats.conceptCount} concepts, ${stats.totalChunkRefs} chunk refs from ${hippoCfg.indexDir}`,
        );
      } catch (err) {
        api.logger.warn(
          `[memory-enhancements] hippocampus: failed to load index (${err instanceof Error ? err.message : String(err)}); starting empty`,
        );
      }
    } else {
      api.logger.info("[memory-enhancements] hippocampus: disabled via config");
    }

    // ---------------------------------------------------------------------
    // 2. Task-conditioned retrieval scoring — v0.1 stub.
    // ---------------------------------------------------------------------
    const tcsEnabled = cfg.taskConditionedScoring?.enabled !== false;
    if (tcsEnabled) {
      const weight = cfg.taskConditionedScoring?.taskWeight ?? 0.3;
      api.logger.info(
        `[memory-enhancements] task-conditioned scoring: scaffold ready (weight=${weight}); full wiring lands in v0.2 once upstream exposes a stable retrieval score-modifier hook`,
      );
    }

    // ---------------------------------------------------------------------
    // 3. Memory write gate. Publish the config the Claude Code hook reads (or
    //    remove it when off), then guard the embedded runner's write/edit.
    // ---------------------------------------------------------------------
    const gateMode = resolveGateMode(cfg.contradictionGate);
    const stateDir = resolveStateDir();
    const agentIds = (api.config.agents?.list ?? []).map((a) => a.id).filter(Boolean);
    const defaultAgentId = resolveDefaultAgentId(api.config);
    const workspaceFor = (agentId: string | undefined): string | undefined => {
      try {
        return api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId ?? defaultAgentId);
      } catch {
        return undefined;
      }
    };
    const workspaceDirs = [...new Set([defaultAgentId, ...agentIds])]
      .map(workspaceFor)
      .filter((d): d is string => Boolean(d));
    const gateConfig = gateMode
      ? defaultGateConfig(gateMode, workspaceDirs, cfg.contradictionGate)
      : null;
    try {
      publishMemoryGateConfig(stateDir, gateConfig);
    } catch (err) {
      api.logger.warn(
        `[memory-enhancements] write gate: could not publish its config (${err instanceof Error ? err.message : String(err)}); the Claude Code hook stays off`,
      );
    }
    if (gateConfig) {
      api.on(
        "before_tool_call",
        createWriteGateHook({
          config: gateConfig,
          stateDir,
          workspaceFor,
          warn: (m) => api.logger.warn(m),
        }),
      );
      api.logger.info(
        `[memory-enhancements] write gate: ${gateConfig.mode} on ${gateConfig.roots.length} memory roots, ${gateConfig.rulesFiles.length} rule files; decisions in ${path.join(stateDir, "data", "memory-gate", "gate.jsonl")}`,
      );
    } else {
      api.logger.info("[memory-enhancements] write gate: off (contradictionGate.enabled=false)");
    }

    // ---------------------------------------------------------------------
    // 4. Compaction-aware capture — v0.1 registers before_compaction hook.
    //    Snapshots messages about to be dropped. Persists via memory-core's
    //    public artifacts interface.
    // ---------------------------------------------------------------------
    const ccEnabled = cfg.compactionCapture?.enabled === true;
    if (ccEnabled) {
      const captureMode = cfg.compactionCapture?.captureMode ?? "dropped-only";
      api.logger.warn(
        `[memory-enhancements] compaction-capture: ENABLED in v0.1 OBSERVER mode. ` +
          `This hook does NOT delay compaction and does NOT persist anything; it only logs ` +
          `which messages would have been dropped (mode=${captureMode}). Real eviction + persistence ` +
          `lands in v0.2. Disable in config if you don't want the noise.`,
      );
      api.on(
        "before_compaction",
        async (
          event: { messageCount?: number; willKeepCount?: number },
          ctx: { sessionKey?: string },
        ) => {
          const willKeep = event.willKeepCount ?? 0;
          const total = event.messageCount ?? 0;
          const willDrop = Math.max(0, total - willKeep);
          if (willDrop === 0) {
            return;
          }
          api.logger.info(
            `[memory-enhancements] compaction-capture (observer): session=${ctx.sessionKey ?? "?"} would drop ${willDrop} of ${total} messages (mode=${captureMode})`,
          );
        },
      );
    }

    api.logger.info(
      "[memory-enhancements] ready — hippocampus index and write gate live; scoring is a scaffold, compaction-capture an observer (see plugin description).",
    );
  },
});
