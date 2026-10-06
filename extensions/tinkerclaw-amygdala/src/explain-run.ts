/**
 * The WOULD HAVE explainer's model call, through the gateway's embedded runner (the same call the tab namer makes in
 * `src/gateway/server-methods/suggest-title.ts`): no tools, no persona, no thinking trace, a throwaway transcript. It
 * runs as `temp:jev-explain`, a session Jev itself skips (native.ts), so an explanation is never judged and explained.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOnce } from "./explain.js";

export const EXPLAIN_SESSION_KEY = "temp:jev-explain";

/** The part of the plugin API the call needs (a fake in tests). */
export interface EmbeddedRunApi {
  currentConfig(): unknown;
  runEmbeddedPiAgent(params: Record<string, unknown>): Promise<unknown>;
  resolveAgentDir(cfg: unknown, agentId: string): string;
  resolveAgentWorkspaceDir(cfg: unknown, agentId: string): string;
}

/** The configured default agent: the first marked default, else the first listed, else "main". */
export function defaultAgentId(cfg: unknown): string {
  const list = (cfg as { agents?: { list?: { id?: string; default?: boolean }[] } } | undefined)
    ?.agents?.list;
  const pick = (list ?? []).find((a) => a?.default) ?? list?.[0];
  return pick?.id?.trim() || "main";
}

/** The first non-error, non-reasoning text of a run, or null. */
export function firstText(result: unknown): string | null {
  const payloads = (result as { payloads?: unknown } | null)?.payloads;
  if (!Array.isArray(payloads)) return null;
  for (const p of payloads as ({
    text?: unknown;
    isError?: boolean;
    isReasoning?: boolean;
  } | null)[]) {
    if (!p || p.isError || p.isReasoning) continue;
    const t = typeof p.text === "string" ? p.text.trim() : "";
    if (t) return t;
  }
  return null;
}

export function embeddedExplainRun(api: EmbeddedRunApi, timeoutMs: number): RunOnce {
  return async (prompt, rung, signal) => {
    const slash = rung.indexOf("/");
    if (slash <= 0) throw new Error(`bad rung ${rung}`);
    const cfg = api.currentConfig();
    const agentId = defaultAgentId(cfg);
    const dir = mkdtempSync(join(tmpdir(), "amy-explain-"));
    const runId = `jev-explain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await api.runEmbeddedPiAgent({
        sessionId: runId,
        sessionKey: EXPLAIN_SESSION_KEY,
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
