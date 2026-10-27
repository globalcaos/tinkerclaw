/**
 * FORK 2026-10-25: the Fractal gate tutor's model call (`src/infra/fractal/gate-tutor.ts`), through the gateway's
 * embedded runner the way the tab namer (`suggest-title.ts`) and the amygdala's reviewer (`explain-run.ts`) call it: no
 * tools, no persona, no thinking trace, a throwaway transcript. It runs as `temp:fractal-gate-review:*`, a session the
 * amygdala and restart recovery skip, and beside the shared `sessions` lane, so a chat turn never waits behind it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FractalGateReviewRun } from "../../infra/fractal/gate-tutor.js";
import { extractTitleText } from "./suggest-title.js";

export const FRACTAL_GATE_REVIEW_SESSION_KEY = "temp:fractal-gate-review";

export function fractalGateReviewRun(cfg: OpenClawConfig, timeoutMs: number): FractalGateReviewRun {
  return async (prompt, rung, signal) => {
    const slash = rung.indexOf("/");
    if (slash <= 0) {
      throw new Error(`bad rung ${rung}`);
    }
    const agentId = resolveDefaultAgentId(cfg);
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-gate-review-"));
    const runId = `fractal-gate-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await runEmbeddedPiAgent({
        sessionId: runId,
        sessionKey: `${FRACTAL_GATE_REVIEW_SESSION_KEY}:${runId}`,
        agentId,
        sessionFile: path.join(dir, "run.jsonl"),
        workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
        agentDir: resolveAgentDir(cfg, agentId),
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
        enqueue: (task) => task(),
      });
      return extractTitleText(result);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
