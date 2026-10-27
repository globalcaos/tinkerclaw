/**
 * FORK: tinkerclaw-harness-id — rename or strip the harness identity sentence
 * ("You are a personal assistant running inside OpenClaw.") in outbound prompts.
 *
 * Designed to be used with an Anthropic API key only. Will not start next to cc-bridge
 * (tinkerclaw-tinker-bridge) or any subscription-style Anthropic login: see
 * README "Do not combine with cc-bridge".
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  buildHarnessIdReplacement,
  resolveHarnessIdGate,
  type HarnessIdConfig,
} from "./src/harness-id.js";

export default definePluginEntry({
  id: "tinkerclaw-harness-id",
  name: "Harness ID",
  description: "Rename or strip the harness identity sentence. Designed for API-key use only.",
  register(api: OpenClawPluginApi) {
    const gate = resolveHarnessIdGate(api.config as Parameters<typeof resolveHarnessIdGate>[0]);
    if (!gate.ok) {
      api.logger.warn(`[tinkerclaw-harness-id] NOT active: ${gate.reason}. See README.`);
      return;
    }
    const replacement = buildHarnessIdReplacement(api.pluginConfig as HarnessIdConfig);
    if ("error" in replacement) {
      api.logger.warn(`[tinkerclaw-harness-id] NOT active: ${replacement.error}`);
      return;
    }
    api.registerTextTransforms({ input: [replacement] });
    api.logger.info(`[tinkerclaw-harness-id] active: "${replacement.to}"`);
  },
});
