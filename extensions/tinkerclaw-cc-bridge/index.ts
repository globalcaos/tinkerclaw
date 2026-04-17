/**
 * FORK: tinkerclaw-cc-bridge — plugin entry.
 *
 * Registers a new OpenClaw provider `claude-code` that drives the real
 * `claude` CLI as a persistent subprocess pool. Replaces the need for the
 * `anthropic` provider with OAuth gymnastics; inherits the Claude Code
 * subscription entitlement by using the binary Anthropic already blesses.
 *
 * Integration points:
 *   - provider id: "claude-code"
 *   - streaming: persistent subprocess per session, stream-json NDJSON
 *   - memory plugins: unchanged — they build the system prompt we forward
 *   - tool loop: unchanged — disabled inside claude, OpenClaw owns tools
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { checkClaudeCredentials } from "./src/auth.js";
import { buildClaudeCodeProviderConfig } from "./src/catalog.js";
import {
  DEFAULT_BINARY,
  DEFAULT_CWD,
  DEFAULT_DISALLOWED_TOOLS,
  PROVIDER_ID,
  PROVIDER_LABEL,
} from "./src/defaults.js";
import { createClaudeCodeStreamFn } from "./src/stream.js";

type CcBridgeConfig = {
  binary?: string;
  cwd?: string;
  disallowedTools?: string[];
  warmOnBoot?: string[];
};

export default definePluginEntry({
  id: "tinkerclaw-cc-bridge",
  name: "Claude Code Bridge",
  description: "FORK: drives the real claude CLI as a persistent subprocess provider.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as CcBridgeConfig;
    const binary = pluginConfig.binary?.trim() || DEFAULT_BINARY;
    const cwd = pluginConfig.cwd?.trim() || DEFAULT_CWD;
    const disallowedTools =
      Array.isArray(pluginConfig.disallowedTools) && pluginConfig.disallowedTools.length > 0
        ? pluginConfig.disallowedTools
        : DEFAULT_DISALLOWED_TOOLS;

    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      envVars: ["CLAUDE_CODE_BINARY", "CLAUDE_CODE_CWD"],
      auth: [
        {
          id: "oauth",
          label: "Claude Code OAuth",
          hint: "Uses ~/.claude/.credentials.json (run `claude` once to log in)",
          kind: "custom",
          run: async (_ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const status = checkClaudeCredentials();
            if (!status.ok) {
              throw new Error(`Claude Code OAuth not ready: ${status.reason}`);
            }
            return {
              profiles: [
                {
                  profileId: "claude-code:oauth",
                  credential: {
                    kind: "synthetic",
                    provider: PROVIDER_ID,
                    apiKey: "claude-code-oauth",
                    source: "~/.claude/.credentials.json",
                    mode: "oauth",
                  } as unknown as ProviderAuthResult["profiles"][number]["credential"],
                },
              ],
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (_ctx: ProviderDiscoveryContext) => {
          return { provider: buildClaudeCodeProviderConfig() };
        },
      },
      createStreamFn: ({ model }) => {
        // OpenClaw calls this once per provider-model pair at request time.
        // We build a stream fn that routes to the per-session worker pool.
        return createClaudeCodeStreamFn({
          binary,
          cwd,
          disallowedTools,
          sessionKey: (model as unknown as { sessionKey?: string }).sessionKey,
        });
      },
      resolveSyntheticAuth: () => ({
        apiKey: "claude-code-oauth",
        source: "tinkerclaw-cc-bridge (synthetic OAuth marker)",
        mode: "oauth",
      }),
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === "claude-code-oauth",
      buildUnknownModelHint: () =>
        "Claude Code bridge requires a logged-in `claude` CLI on this host. " +
        "Run `claude` once interactively to populate ~/.claude/.credentials.json.",
    });

    // warmOnBoot is declared in config-schema but deferred: the system prompt
    // is assembled per-turn by memory plugins, and the current pool only
    // honors the prompt from the first spawn. Pre-warming needs the pool to
    // detect a prompt change and respawn with the new one. Tracked as
    // follow-up work; eagerly reading the config now would be misleading.
    void pluginConfig.warmOnBoot;
  },
});
