/**
 * One-shot session-title suggester.
 *
 * Runs a SINGLE cheap completion (the tab auto-namer — NOT the metered Anthropic
 * API, NOT ollama) and returns the suggested title text. Modeled on the shape of
 * src/hooks/llm-slug-generator.ts but with the provider/model/options hardcoded
 * for the title-suggest use case.
 *
 * 2026-09-01: switched off claude-code/claude-sonnet-4-6. Title gen is a 4-word
 * one-shot that was burning Claude subscription tokens (and a full `claude` CLI
 * cold-spawn per rename). Grok 4.6 is the surplus-token lane.
 *
 * FORK 2026-09-12 (the architect: "the auto-rename tab feature is not working anymore")
 * — the suggester ran ONE hardcoded supply with NO recovery ladder. When xAI's
 * weekly allowance hit 100% the run threw `FailoverError: 403 "You have run out
 * of credits"`, the catch below returned null, and EVERY rename silently kept
 * its placeholder name for the rest of the week (journal 2026-09-12 16:04 and
 * 16:11, ~38 s per attempt). Thalamus doctrine (bible §5.8U): a supply that
 * 429s/403s has an effective intelligence of ZERO, so a single-rung route is
 * not a route. The run now goes through `runWithModelFallback` — the same
 * ladder machinery the main turn uses — with an explicit chain, so an exhausted
 * primary moves the rename to the next supply instead of ending it.
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
import { runWithModelFallback } from "../../agents/model-fallback.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("suggest-title");

/**
 * The recovery ladder, in order. `provider/model` keys, one per supply, and
 * every rung must be a lane that answers a 4-word one-shot without a persona.
 *
 * - `xai/grok-4.6` — the surplus-token lane (weekly window, no 5-hour window);
 *   stays primary so a rename costs nothing from the Claude subscription.
 * - `claude-code/claude-haiku-4-5` — the cheapest Claude rung. It pays a
 *   `claude` CLI cold-spawn (~15 s) and a few Haiku tokens, which is exactly the
 *   cost the 2026-09-01 switch avoided — but only while Grok is OUT, and a
 *   named tab beats a fortune-cookie placeholder for a week.
 *
 * Two rungs on two DIFFERENT supplies is the invariant (see the test): a ladder
 * whose rungs share a billing pool fails together.
 */
export const TITLE_SUGGEST_LADDER: readonly string[] = [
  "xai/grok-4.6",
  "claude-code/claude-haiku-4-5",
];

/** Per-rung cap. Grok HTTP is 1–3 s; the cc-bridge cold-spawn is ~14–19 s. */
const TITLE_RUNG_TIMEOUT_MS = 45_000;

function splitModelKey(key: string): { provider: string; model: string } {
  const slash = key.indexOf("/");
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}

type EmbeddedRunResult = Awaited<ReturnType<typeof runEmbeddedPiAgent>>;

/**
 * The first non-empty, non-error, non-reasoning payload text — or null when the
 * run produced no usable title (an error-only result, an empty result).
 */
export function extractTitleText(result: unknown): string | null {
  const payloads = (result as { payloads?: unknown } | null)?.payloads;
  if (!Array.isArray(payloads)) {
    return null;
  }
  for (const payload of payloads as Array<{
    text?: unknown;
    isError?: boolean;
    isReasoning?: boolean;
  } | null>) {
    if (!payload || payload.isError || payload.isReasoning) {
      continue;
    }
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * Generate a short session title from a prompt via a one-shot completion on the
 * first rung of `ladder` that answers. Returns the trimmed title text, or null
 * when every rung failed (never throws).
 */
export async function suggestTitleViaBridge({
  prompt,
  cfg,
  ladder = TITLE_SUGGEST_LADDER,
}: {
  prompt: string;
  cfg: OpenClawConfig;
  ladder?: readonly string[];
}): Promise<string | null> {
  let tempDir: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);

    // Throwaway temp dir for this one-off completion. Each RUNG gets its own
    // transcript file inside it: a failed rung's error turn must not become the
    // history the next rung reads.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-title-"));
    const sessionRoot = tempDir;

    const stamp = Date.now();
    const runId = `title-suggest-${stamp}`;
    const primary = splitModelKey(ladder[0] ?? "");
    let attempt = 0;

    const outcome = await runWithModelFallback<EmbeddedRunResult>({
      cfg,
      provider: primary.provider,
      model: primary.model,
      runId,
      agentDir,
      // Explicit chain: the rest of the ladder, and NOT agents.defaults.model.fallbacks
      // (which is `[]` in the live config and must stay that way — see
      // reference_empty_config_array_starves_a_working_mechanism).
      fallbacksOverride: ladder.slice(1),
      // A rung that returns without throwing but carries no title text (error-only
      // payloads, an empty reply) is a MISS, not a title: move to the next rung.
      classifyResult: ({ result, provider, model }) =>
        extractTitleText(result)
          ? null
          : {
              message: `${provider}/${model} returned no title text`,
              reason: "empty_response",
              code: "empty_title",
            },
      run: async (provider, model) => {
        attempt += 1;
        return runEmbeddedPiAgent({
          sessionId: `${runId}-a${attempt}`,
          sessionKey: "temp:title-suggest",
          agentId,
          sessionFile: path.join(sessionRoot, `attempt-${attempt}.jsonl`),
          workspaceDir,
          agentDir,
          config: cfg,
          prompt,
          provider,
          model,
          disableTools: true,
          // Probe-style: no persona, no workspace bootstrap, no reasoning trace.
          // A 4-word tab name does not need SOUL.md or a thinking block.
          modelRun: true,
          promptMode: "none",
          thinkLevel: "off",
          reasoningLevel: "off",
          verboseLevel: "off",
          timeoutMs: TITLE_RUNG_TIMEOUT_MS,
          runId,
          cleanupBundleMcpOnRunEnd: true,
        });
      },
    });

    if (outcome.attempts.length > 0) {
      log.warn(
        `title served by ${outcome.provider}/${outcome.model} after ${outcome.attempts.length} failed rung(s): ` +
          outcome.attempts
            .map((a) => `${a.provider}/${a.model} (${a.reason ?? "error"})`)
            .join(", "),
      );
    }
    return extractTitleText(outcome.result);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to suggest title (ladder ${ladder.join(" → ")} exhausted): ${message}`);
    return null;
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
