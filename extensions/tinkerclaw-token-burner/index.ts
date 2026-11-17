/**
 * tinkerclaw-token-burner — the settings behind the Tinker "Token burner" tab.
 *
 * The token-burner skill spends a flat subscription's spare weekly quota on a job queue. This
 * plugin stores what that spare quota is FOR (one objective, a strategy, the governing prompt, an
 * optional dashboard link) in <stateDir>/token-burner/settings.json, which the skill's CLI reads
 * when it plans jobs. It starts nothing on its own and spends nothing: the only agent run is the
 * one the owner asks for with "Suggest from my chat history", on the gateway's default model.
 *
 * Gateway methods (operator.admin):
 *   tokenBurner.settings.get  {}                 → { settings, objectives, prompt, error? }
 *   tokenBurner.settings.set  { patch }          → { settings, prompt } or { ok:false, error }
 *   tokenBurner.suggest       {} | { runId }     → start a suggestion / poll it
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  OBJECTIVES,
  SettingsError,
  ensurePrompt,
  findDefaultPrompt,
  mergePatch,
  readSettings,
  writeSettings,
} from "./src/settings.js";
import { SuggestRuns, type SuggestSubagent } from "./src/suggest.js";

export default definePluginEntry({
  id: "tinkerclaw-token-burner",
  name: "Token Burner Settings",
  description:
    "Choose what a subscription's spare weekly tokens are spent on: one objective, a strategy and the governing prompt, read by the token-burner skill.",
  register(api: OpenClawPluginApi) {
    const stateDir = resolveStateDir();
    const defaultPrompt = findDefaultPrompt(dirname(fileURLToPath(import.meta.url)));
    const runs = new SuggestRuns(() => api.runtime?.subagent as SuggestSubagent | undefined);

    const promptInfo = (path: string) => {
      try {
        return ensurePrompt(path, defaultPrompt);
      } catch (err) {
        api.logger.warn(`[token-burner] prompt file ${path}: ${(err as Error).message}`);
        return { path, mtime: null, created: false };
      }
    };

    api.registerGatewayMethod(
      "tokenBurner.settings.get",
      async ({ respond }) => {
        const { settings, error } = readSettings(stateDir);
        respond(true, {
          ok: true,
          settings,
          objectives: OBJECTIVES,
          prompt: promptInfo(settings.promptPath),
          ...(error ? { error } : {}),
        });
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      "tokenBurner.settings.set",
      async ({ params, respond }) => {
        const { settings: current } = readSettings(stateDir);
        try {
          const patch = (params as { patch?: unknown } | undefined)?.patch;
          const saved = writeSettings(stateDir, mergePatch(current, patch, stateDir));
          respond(true, { ok: true, settings: saved, prompt: promptInfo(saved.promptPath) });
        } catch (err) {
          if (!(err instanceof SettingsError)) {
            api.logger.error(`[token-burner] settings not saved: ${(err as Error).message}`);
          }
          respond(true, { ok: false, error: (err as Error).message });
        }
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      "tokenBurner.suggest",
      async ({ params, respond }) => {
        const runId = (params as { runId?: unknown } | undefined)?.runId;
        if (runId !== undefined) {
          respond(true, await runs.poll(runId));
          return;
        }
        const started = await runs.start(api.config, readSettings(stateDir).settings);
        if (!started.ok) api.logger.warn(`[token-burner] suggest not started: ${started.reason}`);
        respond(
          true,
          started.ok
            ? { status: "running", runId: started.runId }
            : {
                status: "failed",
                reason: started.reason,
              },
        );
      },
      { scope: "operator.admin" },
    );

    api.logger.info(`[token-burner] settings in ${stateDir}/token-burner/settings.json`);
  },
});
