/**
 * The companion seam (THALAMUS v4, design doc section 10, "one call, two jobs"; paper P§4).
 *
 * WHAT THIS IS FOR. THALAMUS asks Jev its routing questions in the SAME request as the amygdala's own, so a step
 * costs one call, not two. The routing questions are not the amygdala's: their verdicts never reach a family, the
 * store or the learning loop. `decide()` appends the companion's questions to the call the amygdala is already
 * making, and takes their verdicts back out before anything else looks at the verdict list.
 *
 * With no provider registered (Thalamus off, the normal case) this file does nothing and `decide()` is unchanged.
 * The provider is registered through `openclaw/plugin-sdk/fork-thalamus`; this extension imports no other extension.
 */
import { getRoutingReadProvider, type ProviderQuestion } from "openclaw/plugin-sdk/fork-thalamus";
import type { FamilyId, Question, Seam, Situation, Verdict } from "./types.js";

export interface Companion {
  /** Extra questions for this seam, already shaped as questions. Never throws. */
  questionsFor(seam: Seam, s: Situation): Question[];
  /** The verdicts of exactly those questions, from the same call. Never throws. */
  observe(seam: Seam, s: Situation, verdicts: Verdict[]): void;
}

function toQuestion(q: ProviderQuestion, seam: Seam): Question {
  // These questions are asked but never stored in the book, so the family label only has to be present.
  return {
    ...q,
    family: "routing" as unknown as FamilyId,
    seams: [seam],
    cutoff: { kind: "none" },
    origin: "THALAMUS v4",
    retirement: "owned by THALAMUS",
    mustCatch: [],
    status: "active",
  } as unknown as Question;
}

function view(s: Situation) {
  return {
    id: s.id,
    sessionKey: s.sessionKey,
    turnId: s.turnId,
    originKind: s.originKind,
    ...(s.request.value ? { request: s.request.value } : {}),
    ...(s.tool.value ? { tool: s.tool.value } : {}),
  };
}

/** Delegates to whatever provider THALAMUS registered, if any. */
export const routingCompanion: Companion = {
  questionsFor(seam, s) {
    const p = getRoutingReadProvider();
    if (!p) return [];
    try {
      return p.questionsFor(seam, view(s)).map((q) => toQuestion(q, seam));
    } catch {
      return [];
    }
  },
  observe(seam, s, verdicts) {
    const p = getRoutingReadProvider();
    if (!p) return;
    try {
      p.observe(seam, view(s), verdicts);
    } catch {
      /* the routing side never breaks the guard */
    }
  },
};
