/**
 * FORK: tinkerclaw-cc-bridge — model catalog.
 *
 * Exposes the models claude CLI can drive. No network call — claude's
 * backend picks which server model to use; we just list the names
 * OpenClaw's model-router understands.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_MODELS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MODEL_ALIASES,
  PROVIDER_ID,
} from "./defaults.js";

export function buildClaudeCodeProviderConfig(): ModelProviderConfig {
  const models = DEFAULT_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: PROVIDER_ID,
    api: "anthropic-messages",
    reasoning: m.reasoning,
    input: ["text"] as const,
    // FORK (2026-04-21): per-model contextWindow pulled from defaults.ts so
    // pi-agent-core's preemptive-compaction budget matches the real capacity
    // of each model (Opus 4.7 and Sonnet 4.6 at 1M, others at 200k).
    contextWindow: m.contextWindow,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    aliases: Object.entries(MODEL_ALIASES)
      .filter(([, target]) => target === m.id)
      .map(([alias]) => alias),
  }));
  return {
    baseUrl: "local://claude-cli",
    api: "anthropic-messages",
    apiKey: "claude-code-oauth",
    // FORK 2026-05-05: provider-level `timeoutSeconds` is what
    // pi-agent-core's `resolveLlmIdleTimeoutMs` reads (per-model
    // requestTimeoutMs alone is ignored — only the provider config feeds
    // `applyConfiguredProviderOverrides → resolveProviderRequestTimeoutMs`).
    // Bumped from the default 120s because claude-cli's tool work emits NO
    // `stream.push` events to pi-ai (FORK 2026-04-22), so a long tool chain
    // looks idle even though claude is actively working — at 120s the
    // watchdog SIGTERMs the subprocess and on a heavy turn both attempts
    // can fail, surfacing as `__ERR_ENV__:Something went wrong while
    // processing your request` over WhatsApp. 600s is generous; the
    // model-fallback layer still bails on truly stuck subprocesses.
    timeoutSeconds: Math.floor(DEFAULT_REQUEST_TIMEOUT_MS / 1000),
    models: models as unknown as ModelProviderConfig["models"],
  };
}
