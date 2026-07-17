/**
 * FORK: tinkerclaw-tinker-bridge (ClawHub: "tinker-bridge"; formerly tinker-bridge) — plugin entry.
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
// FORK 2026-05-10: register the static-side runtime defaults (currently
// `timeoutSeconds: 600`) into the plugin overlay so the LLM idle watchdog
// resolves them without requiring `~/.openclaw/openclaw.json` to mirror
// the value. See `src/agents/plugin-provider-config-overlay.ts`.
import { registerPluginProviderConfigOverlay } from "openclaw/plugin-sdk/provider-config-overlay";
import { checkClaudeCredentials } from "./src/auth.js";
import { buildClaudeCodeProviderConfig } from "./src/catalog.js";
import {
  DEFAULT_BINARY,
  DEFAULT_CWD,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROVIDER_ID,
  PROVIDER_LABEL,
} from "./src/defaults.js";
import { createClaudeCodeStreamFn } from "./src/stream.js";
import { claudeCodeThinkingProfile } from "./src/thinking-budget.js";

type TinkerBridgeConfig = {
  binary?: string;
  cwd?: string;
  disallowedTools?: string[];
  warmOnBoot?: string[];
};

export default definePluginEntry({
  id: "tinkerclaw-tinker-bridge",
  name: "Tinker Bridge",
  description: "FORK: drives the real claude CLI as a persistent subprocess provider.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as TinkerBridgeConfig;
    const binary = pluginConfig.binary?.trim() || DEFAULT_BINARY;
    const cwd = pluginConfig.cwd?.trim() || DEFAULT_CWD;
    const disallowedTools =
      Array.isArray(pluginConfig.disallowedTools) && pluginConfig.disallowedTools.length > 0
        ? pluginConfig.disallowedTools
        : DEFAULT_DISALLOWED_TOOLS;

    // FORK 2026-05-10: surface the tinker-bridge runtime defaults to the LLM idle
    // watchdog. `applyConfiguredProviderOverrides` reads `timeoutSeconds` off
    // `cfg.models.providers["claude-code"]`; the overlay merges this value in
    // when the user hasn't set it explicitly in openclaw.json, so heavy tool
    // chains don't SIGTERM at the 120s default.
    registerPluginProviderConfigOverlay(PROVIDER_ID, {
      timeoutSeconds: Math.floor(DEFAULT_REQUEST_TIMEOUT_MS / 1000),
    });

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
        source: "tinkerclaw-tinker-bridge (synthetic OAuth marker)",
        mode: "oauth",
      }),
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === "claude-code-oauth",
      buildUnknownModelHint: () =>
        "Claude Code bridge requires a logged-in `claude` CLI on this host. " +
        "Run `claude` once interactively to populate ~/.claude/.credentials.json.",
      // FORK 2026-06-19: expose the full 7-level thinking profile (…high, xhigh,
      // max) so the Tinker effort slider's top stops are admitted. Core's
      // BASE_THINKING_LEVELS stops at `high` and never admits `max`; a provider
      // profile is used verbatim, so this is the non-deprecated way to widen the
      // ceiling for claude-code. tinker-bridge already budgets these levels
      // (thinkLevelToMaxThinkingTokens). Default is omitted on purpose.
      resolveThinkingProfile: () => claudeCodeThinkingProfile(),
    });

    // warmOnBoot is declared in config-schema but deferred: the system prompt
    // is assembled per-turn by memory plugins, and the current pool only
    // honors the prompt from the first spawn. Pre-warming needs the pool to
    // detect a prompt change and respawn with the new one. Tracked as
    // follow-up work; eagerly reading the config now would be misleading.
    void pluginConfig.warmOnBoot;
  },
});
