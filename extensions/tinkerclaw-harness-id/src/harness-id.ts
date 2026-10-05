/**
 * FORK: tinkerclaw-harness-id — pure core (gate + transforms), kept free of the
 * plugin API so it unit-tests without a gateway.
 */

/** The harness identity sentence core emits at the top of every system prompt. */
export const HARNESS_ID_SENTENCE = "You are a personal assistant running inside OpenClaw.";

/** Plugin ids of the Claude Code subscription bridge (cc-bridge). */
export const CC_BRIDGE_PLUGIN_IDS = ["tinkerclaw-tinker-bridge", "tinkerclaw-cc-bridge"] as const;

export type HarnessIdMode = "rename" | "strip";

export type HarnessIdConfig = {
  mode?: HarnessIdMode;
  name?: string;
};

type ConfigLike = {
  plugins?: {
    deny?: string[];
    entries?: Record<string, { enabled?: boolean } | undefined>;
  };
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string } | undefined>;
  };
};

export type HarnessIdGate = { ok: true } | { ok: false; reason: string };

/**
 * harness-id is designed to be used with an Anthropic API key only, so it does
 * not start next to cc-bridge or any subscription-style Anthropic login
 * (oauth / setup-token).
 */
export function resolveHarnessIdGate(config: ConfigLike | undefined): HarnessIdGate {
  const entries = config?.plugins?.entries ?? {};
  const deny = config?.plugins?.deny ?? [];
  for (const id of CC_BRIDGE_PLUGIN_IDS) {
    const entry = entries[id];
    if (entry && entry.enabled !== false && !deny.includes(id)) {
      return {
        ok: false,
        reason: `cc-bridge (${id}) is enabled — harness-id must not run alongside it`,
      };
    }
  }
  for (const [profileId, profile] of Object.entries(config?.auth?.profiles ?? {})) {
    const provider = profile?.provider ?? "";
    const mode = profile?.mode ?? "";
    if ((provider === "anthropic" || provider === "claude-code") && mode !== "api_key") {
      return {
        ok: false,
        reason: `auth profile "${profileId}" is an Anthropic ${mode || "non-API-key"} login — harness-id is designed for API-key use only`,
      };
    }
  }
  return { ok: true };
}

/** Names that would present the harness as Anthropic's own client. */
const RESERVED_NAME = /claude|anthropic/i;

export function buildHarnessIdReplacement(
  cfg: HarnessIdConfig | undefined,
): { from: string; to: string } | { error: string } {
  const mode: HarnessIdMode = cfg?.mode === "strip" ? "strip" : "rename";
  if (mode === "strip") {
    return { from: HARNESS_ID_SENTENCE, to: "You are a personal assistant." };
  }
  const name = cfg?.name?.trim() || "TinkerClaw";
  if (RESERVED_NAME.test(name)) {
    return { error: `harness name "${name}" is reserved (would present as Anthropic's client)` };
  }
  return { from: HARNESS_ID_SENTENCE, to: `You are a personal assistant running inside ${name}.` };
}
