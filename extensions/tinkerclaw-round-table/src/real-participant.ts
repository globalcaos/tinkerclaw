/**
 * FORK: Real-LLM, CROSS-PROVIDER debate participant for the Round Table (SYNAPSE)
 * extension. Replaces the deterministic createSimulatedParticipant. Each RAAC
 * phase makes ONE real LLM call, routed by ROLE to a concrete configured
 * cross-provider model ref (Anthropic + OpenAI + Google) for genuine cognitive
 * diversity. The model call is injected as `callModel` so this module is
 * unit-testable and so the live wiring (index.ts) can route through
 * fork.subagents.spawn + agent.wait + chat.history — sharing the cc-bridge
 * billing harness and the 8-worker fan-out budget. No new transport.
 */

import type { ProviderProfile } from "./cognitive-diversity.js";
import type { DebateParticipant } from "./raac-protocol.js";

export type Phase = "propose" | "challenge" | "defend" | "synthesize" | "ratify";

// F2: role → concrete configured cross-provider model ref. Verified present in
// agents.defaults.models (~/.openclaw/openclaw.json). DeepSeek is NOT configured,
// so the researcher role substitutes openai/o3 (closest math/code/CoT reasoner),
// keeping a 3-vendor spread (Anthropic + OpenAI + Google).
const ROLE_MODEL: Record<string, string> = {
  architect: "claude-code/claude-opus-4-8",
  critic: "openai/gpt-5.3-codex",
  pragmatist: "google/gemini-3.1-pro-preview",
  researcher: "openai/o3",
  synthesizer: "claude-code/claude-sonnet-4-6",
};
const FALLBACK_MODEL = "claude-code/claude-sonnet-4-6";

/**
 * 7B: user-configurable role -> model-ref map ("provider/model"). Supplied from
 * `openclaw.plugin.json:configSchema.properties.roleModels`. Lets a cloner whose
 * catalog lacks the 2026 default refs keep genuine cross-provider diversity
 * instead of silently collapsing every role to FALLBACK_MODEL.
 */
export type RoleModels = Record<string, string>;

/**
 * 7B precedence: roleModels[role] (config override) -> ROLE_MODEL[role] (builtin
 * default) -> FALLBACK_MODEL. An empty-string override is ignored (treated as
 * unset) so a malformed config key cannot route a role to "".
 */
export function modelForRole(role: string, overrides?: RoleModels): string {
  const override = overrides?.[role];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return ROLE_MODEL[role] ?? FALLBACK_MODEL;
}

/** The builtin defaults, exported so callers/validators can compare against them. */
export const DEFAULT_ROLE_MODELS: Readonly<RoleModels> = ROLE_MODEL;
export { FALLBACK_MODEL };

/**
 * 7B: one role whose chosen ref was unavailable in the host catalog and had to
 * fall back. Surfacing these (one WARN per substitution at debate start) makes a
 * silent cross-provider-diversity collapse visible (recon Risk 1).
 */
export interface Substitution {
  role: string;
  requested: string;
  fellBackTo: string;
}

/**
 * 7B: validate each profile's chosen ref against the host catalog. `resolveAvailable`
 * returns true when a ref is resolvable (e.g. a thin wrapper over the gateway's
 * model-resolution path). Records a substitution for every role whose chosen ref is
 * unavailable; the debate still runs (graceful-degrade — see the 7B open question),
 * but the caller can WARN per entry. Pure + injectable so it is unit-testable.
 */
export async function validateRoleModels(
  profiles: Array<{ role: string }>,
  resolveAvailable: (ref: string) => boolean | Promise<boolean>,
  overrides?: RoleModels,
): Promise<Substitution[]> {
  const subs: Substitution[] = [];
  const seen = new Set<string>();
  for (const { role } of profiles) {
    if (seen.has(role)) continue;
    seen.add(role);
    const requested = modelForRole(role, overrides);
    const ok = await resolveAvailable(requested);
    if (!ok) {
      subs.push({ role, requested, fellBackTo: FALLBACK_MODEL });
    }
  }
  return subs;
}

export interface PhaseContext {
  task?: string;
  role: string;
  priorSynthesis?: string;
  proposal?: string;
  attacks?: string[];
  proposals?: string[];
  challenges?: string[];
  defenses?: string[];
  synthesis?: string;
}

export function buildPhasePrompt(
  phase: Phase,
  profile: ProviderProfile,
  ctx: PhaseContext,
): string {
  const header =
    `You are a debate participant in role "${ctx.role}". ` +
    `Your strengths: ${profile.strengths.join(", ")}. ` +
    `Be concise (<=120 words). This is the ${phase.toUpperCase()} phase.\n\n`;
  switch (phase) {
    case "propose":
      return (
        header +
        `Task: ${ctx.task}\n` +
        (ctx.priorSynthesis ? `Prior synthesis to refine: ${ctx.priorSynthesis}\n` : "") +
        `Write your proposal.`
      );
    case "challenge":
      return header + `Proposal under review:\n${ctx.proposal}\n\nWrite your strongest challenge.`;
    case "defend":
      return (
        header +
        `Challenges against your proposal:\n- ${(ctx.attacks ?? []).join("\n- ")}\n\nDefend it.`
      );
    case "synthesize":
      return (
        header +
        `Proposals:\n- ${(ctx.proposals ?? []).join("\n- ")}\n\n` +
        `Challenges:\n- ${(ctx.challenges ?? []).join("\n- ")}\n\n` +
        `Defenses:\n- ${(ctx.defenses ?? []).join("\n- ")}\n\n` +
        `Write a single synthesized consensus position.`
      );
    case "ratify":
      return (
        header +
        `Proposed synthesis:\n${ctx.synthesis}\n\n` +
        `Vote with exactly ONE word on its own first line: ACCEPT, REJECT, or AMEND. ` +
        `Then one sentence of reasoning.`
      );
  }
}

export function normalizeVote(text: string): "accept" | "reject" | "amend" {
  const t = text.toLowerCase();
  // First explicit keyword wins; default accept (consensus-biased; matches prior
  // createSimulatedParticipant behavior where ratify always returned "accept").
  const candidates: Array<["accept" | "reject" | "amend", number]> = (
    [
      ["accept", t.indexOf("accept")],
      ["reject", t.indexOf("reject")],
      ["amend", t.indexOf("amend")],
    ] as Array<["accept" | "reject" | "amend", number]>
  ).filter(([, i]) => i >= 0);
  if (candidates.length === 0) return "accept";
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0][0];
}

export interface RealParticipantDeps {
  /** Make one LLM call. Resolves with the final assistant text. */
  callModel: (args: {
    model: string;
    prompt: string;
    phase: Phase;
    role: string;
  }) => Promise<string>;
}

export function createRealParticipant(
  profile: ProviderProfile,
  deps: RealParticipantDeps,
  overrides?: RoleModels,
): DebateParticipant {
  const model = modelForRole(profile.role, overrides);
  const call = (phase: Phase, ctx: PhaseContext) =>
    deps.callModel({ model, prompt: buildPhasePrompt(phase, profile, ctx), phase, role: ctx.role });
  return {
    modelId: profile.modelId,
    role: profile.role,
    profile,
    async propose(task, role, priorSynthesis) {
      return call("propose", { task, role, priorSynthesis });
    },
    async challenge(proposal, role) {
      return call("challenge", { proposal, role });
    },
    async defend(attacks, role) {
      return call("defend", { attacks, role });
    },
    async synthesize(proposals, challenges, defenses) {
      return call("synthesize", { proposals, challenges, defenses, role: profile.role });
    },
    async ratify(synthesis) {
      return normalizeVote(await call("ratify", { synthesis, role: profile.role }));
    },
  };
}
