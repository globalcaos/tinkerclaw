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

export function modelForRole(role: string): string {
  return ROLE_MODEL[role] ?? FALLBACK_MODEL;
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
): DebateParticipant {
  const model = modelForRole(profile.role);
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
