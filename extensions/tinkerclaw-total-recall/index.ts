/**
 * FORK: Total Recall extension entry point -- ENGRAM episodic memory system.
 *
 * Provides event store, ingestion pipeline, FTS + vector retrieval, pointer
 * compaction, sleep consolidation, entity extraction, contradiction gate,
 * and recall tool. Wired into the OpenClaw plugin SDK as a memory extension.
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/total-recall.json`
 * so other extensions (e.g. Round Table) can detect Total Recall availability.
 *
 * Hook wiring follows in Part B -- this is the scaffold-only entry point.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// -- Constants --

const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");

// -- Cross-extension state helpers --

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeSharedState(): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    TOTAL_RECALL_STATE_PATH,
    JSON.stringify({ active: true, version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

// -- Plugin Entry --

export default definePluginEntry({
  id: "tinkerclaw-total-recall",
  name: "Total Recall",
  description:
    "ENGRAM -- Episodic memory with FTS + vector retrieval, pointer compaction, " +
    "sleep consolidation, and artifact externalization.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const _budgetTokens = (cfg.budgetTokens as number) ?? 2000;
    const _embeddingProvider = (cfg.embeddingProvider as string) ?? "ollama";
    const _embeddingModel = (cfg.embeddingModel as string) ?? "mxbai-embed-large";
    const _retentionDays = (cfg.retentionDays as number | null) ?? null;
    const _pointerMode = (cfg.pointerMode as boolean) ?? true;

    // Write cross-extension state for discovery
    try {
      writeSharedState();
    } catch (err) {
      api.logger.warn(`[total-recall] failed to write shared state: ${err}`);
    }

    // Hook wiring will be added in Part B
    api.logger.info("[total-recall] scaffold loaded (hooks pending Part B)");
  },
});
