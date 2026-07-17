/**
 * One-shot session-title suggester.
 *
 * Runs a SINGLE cc-bridge Sonnet completion (SUBSCRIPTION-billed via the
 * claude-code provider — NOT the metered Anthropic API, NOT ollama) and
 * returns the suggested title text. Modeled on the shape of
 * src/hooks/llm-slug-generator.ts but with the provider/model/options
 * hardcoded for the title-suggest use case.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("suggest-title");

/**
 * Generate a short session title from a prompt via a one-shot cc-bridge
 * Sonnet completion. Returns the trimmed title text, or null on any failure.
 */
export async function suggestTitleViaBridge({
  prompt,
  cfg,
}: {
  prompt: string;
  cfg: OpenClawConfig;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);

    // Throwaway temp session file for this one-off completion.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-title-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const stamp = Date.now();
    const result = await runEmbeddedPiAgent({
      sessionId: `title-suggest-${stamp}`,
      sessionKey: "temp:title-suggest",
      agentId,
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt,
      // Subscription-billed via the claude-code provider (cc-bridge), NOT the
      // metered Anthropic API and NOT ollama. The provider carries the route,
      // so the model id is the bare Sonnet tag.
      provider: "claude-code",
      model: "claude-sonnet-4-6",
      disableTools: true,
      // FORK 2026-06-25 — was 15_000, which the cc-bridge one-shot routinely BLEW under load:
      // the bridge COLD-SPAWNS a full `claude` CLI worker per title (persona + plugins), so most
      // of the wall-clock is worker startup, not generation (observed: ~3.4s gen but ~11s spawn →
      // 14.4s success vs 15s timeouts in the gateway log). On timeout runEmbeddedPiAgent throws
      // FailoverError, this fn returns null, and the tab silently fails to rename — which is the
      // real reason CLONES (titled at clone-time, when the bridge is mid-cold-spawn) never renamed
      // while NEW tabs (titled at turn-end, when a worker just freed) did. 45s clears the cold
      // spawn with margin. (Deeper latency fix = a lighter/persona-less title spawn — tracked.)
      timeoutMs: 45_000,
      runId: `title-suggest-${stamp}`,
      cleanupBundleMcpOnRunEnd: true,
    });

    const payloads = Array.isArray(result.payloads) ? result.payloads : [];
    for (const payload of payloads) {
      if (!payload || payload.isError || payload.isReasoning) {
        continue;
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text) {
        return text;
      }
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to suggest title: ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
