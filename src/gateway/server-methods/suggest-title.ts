/**
 * One-shot session-title suggester.
 *
 * Runs a SINGLE xAI Grok 4.6 completion (the tab auto-namer — NOT cc-bridge
 * Sonnet, NOT the metered Anthropic API, NOT ollama) and returns the suggested
 * title text. Modeled on the shape of src/hooks/llm-slug-generator.ts but with
 * the provider/model/options hardcoded for the title-suggest use case.
 *
 * 2026-09-01: switched off claude-code/claude-sonnet-4-6. Title gen is a 4-word
 * one-shot that was burning Claude subscription tokens (and a full `claude` CLI
 * cold-spawn per rename). Grok 4.6 is the surplus-token lane.
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
 * Generate a short session title from a prompt via a one-shot xAI Grok 4.6
 * completion. Returns the trimmed title text, or null on any failure.
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
      // FORK 2026-09-01 — xAI Grok 4.6 (surplus-token lane). Was cc-bridge
      // claude-sonnet-4-6, which burned Claude subscription tokens and cold-spawned
      // a full `claude` CLI worker per rename. Grok is an HTTP completions call.
      provider: "xai",
      model: "grok-4.6",
      disableTools: true,
      // Probe-style: no persona, no workspace bootstrap, no reasoning trace.
      // A 4-word tab name does not need SOUL.md or a thinking block.
      modelRun: true,
      promptMode: "none",
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      // FORK 2026-06-25 — was 15_000 when this was a cc-bridge cold-spawn (~14–19s).
      // Grok HTTP is typically 1–3s; 45s stays as a generous cap so a slow call
      // still returns a title instead of silently leaving the fortune-cookie name.
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
