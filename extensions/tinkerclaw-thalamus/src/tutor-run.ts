// The tutors' model call (2026-10-25, `src/tutor.ts`), through the gateway's embedded runner the way the amygdala's
// reviewer makes it (`extensions/tinkerclaw-amygdala/src/explain-run.ts`): no tools, no persona, no thinking trace, a
// throwaway transcript. It runs as `temp:thalamus-tutor:*`, a session the router, the tutor itself and restart recovery
// skip, and beside the shared `sessions` lane, so a chat turn never waits behind a review.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TutorRun } from "./tutor.js";

export const TUTOR_SESSION_KEY = "temp:thalamus-tutor";

/** The part of the plugin API the call needs (a fake in tests). */
export type EmbeddedTutorApi = {
  currentConfig(): unknown;
  runEmbeddedPiAgent(params: Record<string, unknown>): Promise<unknown>;
  resolveAgentDir(cfg: unknown, agentId: string): string;
  resolveAgentWorkspaceDir(cfg: unknown, agentId: string): string;
};

export function defaultAgentId(cfg: unknown): string {
  const list = (cfg as { agents?: { list?: { id?: string; default?: boolean }[] } } | undefined)
    ?.agents?.list;
  const pick = (list ?? []).find((a) => a?.default) ?? list?.[0];
  return pick?.id?.trim() || "main";
}

/** The first non-error, non-reasoning text of a run, or null. */
export function firstText(result: unknown): string | null {
  const payloads = (result as { payloads?: unknown } | null)?.payloads;
  if (!Array.isArray(payloads)) {
    return null;
  }
  for (const p of payloads as ({
    text?: unknown;
    isError?: boolean;
    isReasoning?: boolean;
  } | null)[]) {
    if (!p || p.isError || p.isReasoning) {
      continue;
    }
    const t = typeof p.text === "string" ? p.text.trim() : "";
    if (t) {
      return t;
    }
  }
  return null;
}

export function embeddedTutorRun(api: EmbeddedTutorApi, timeoutMs: number): TutorRun {
  return async (prompt, rung, signal) => {
    const slash = rung.indexOf("/");
    if (slash <= 0) {
      throw new Error(`bad rung ${rung}`);
    }
    const cfg = api.currentConfig();
    const agentId = defaultAgentId(cfg);
    const dir = mkdtempSync(join(tmpdir(), "thalamus-tutor-"));
    const runId = `thalamus-tutor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await api.runEmbeddedPiAgent({
        sessionId: runId,
        sessionKey: `${TUTOR_SESSION_KEY}:${runId}`,
        agentId,
        sessionFile: join(dir, "run.jsonl"),
        workspaceDir: api.resolveAgentWorkspaceDir(cfg, agentId),
        agentDir: api.resolveAgentDir(cfg, agentId),
        config: cfg,
        prompt,
        provider: rung.slice(0, slash),
        model: rung.slice(slash + 1),
        disableTools: true,
        modelRun: true,
        promptMode: "none",
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        timeoutMs,
        runId,
        abortSignal: signal,
        cleanupBundleMcpOnRunEnd: true,
        enqueue: (task: () => Promise<unknown>) => task(),
      });
      return firstText(result);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is harmless */
      }
    }
  };
}
