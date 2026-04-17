/**
 * FORK: tinkerclaw-cc-bridge — model catalog.
 *
 * Exposes the models claude CLI can drive. No network call — claude's
 * backend picks which server model to use; we just list the names
 * OpenClaw's model-router understands.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { DEFAULT_MODELS, MODEL_ALIASES, PROVIDER_ID } from "./defaults.js";

export function buildClaudeCodeProviderConfig(): ModelProviderConfig {
  const models = DEFAULT_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: PROVIDER_ID,
    api: "anthropic-messages",
    reasoning: m.reasoning,
    input: ["text"] as const,
    contextWindow: 200000,
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
    models: models as unknown as ModelProviderConfig["models"],
  };
}
