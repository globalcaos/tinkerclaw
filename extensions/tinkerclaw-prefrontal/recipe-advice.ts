// What Broca's matcher hook does with the one ranked result per task (Broca retrieval v2, phase E).
//
// WHAT THIS IS FOR. The hook asks `requestTaskRanking` (the same ranked result the Thalamus short-list seam reads, started
// by whichever hook asks first), decides from it which matched recipes may seed a plan, and writes the advice the agent and
// the owner see: ONE compact line, `Use: … · Inspiration: … (§ section) · source: Jev|local`, as a `<recipe_advice>` tag in
// the block the hook appends to the turn. The tag is how the chat shows the line under the owner's own prompt, live (a trail
// event) and after a reload (the stored turn carries the tag). It is advice: nothing here loads, runs or forces a recipe.
//
// This file is imported lazily by the hook (`loadAdvice`), so a failure to load the SDK module leaves the hook exactly as it
// was before the ranking existed.
//
// RULES IT KEEPS (charter, phase E): a plan is seeded only from a USE Jev chose with high confidence (a local list may seed
// only a recipe the lexical matcher itself scored high AND the ranking lists as USE); an INSPIRE never seeds; a marked
// runtime notice gets nothing.

import {
  adviceLine,
  isInteractiveSession,
  previousUserTextOf,
  recipeSlugOf,
  recommendable,
  requestTaskRanking,
  seedableCards,
  type RankResult,
  type SkipWhy,
  type TaskRanking,
} from "openclaw/plugin-sdk/fork-thalamus";

/** The most the hook waits for the ranking. The ranker bounds its own Jev call at the short-list budget; this is the net. */
export const RANK_WAIT_MS = 3000;

export { isInteractiveSession };

export type TurnFacts = {
  runId?: string;
  sessionKey: string;
  prompt: string;
  trigger?: string;
  provenanceKind?: string;
  /** The session history as the hook was handed it, for a request with no subject of its own. */
  messages?: unknown;
};

export type Owed = { owed: false; why: SkipWhy } | { owed: true; ranking?: TaskRanking };

const none = (ms: number): Promise<undefined> =>
  new Promise((r) => setTimeout(() => r(undefined), ms).unref?.());

/** Is this turn owed a recommendation, and if so what is the ranking (undefined when Thalamus is off or the ranking is late)? */
export async function rankForTurn(t: TurnFacts): Promise<Owed> {
  const gate = recommendable({
    text: t.prompt,
    sessionKey: t.sessionKey,
    trigger: t.trigger,
    provenanceKind: t.provenanceKind,
  });
  if (!gate.ok) return { owed: false, why: gate.why };
  const prev = previousUserTextOf(t.messages, t.prompt);
  const pending = requestTaskRanking({
    runId: t.runId ?? "",
    sessionKey: t.sessionKey,
    text: t.prompt,
    ...(t.trigger ? { trigger: t.trigger } : {}),
    ...(t.provenanceKind ? { provenanceKind: t.provenanceKind } : {}),
    ...(prev ? { previousUserText: prev } : {}),
  });
  if (!pending) return { owed: true };
  const ranking = await Promise.race([pending, none(RANK_WAIT_MS)]);
  return { owed: true, ...(ranking ? { ranking } : {}) };
}

/**
 * May a plan be seeded from this matched recipe? Undefined means "no opinion, as before" (no ranking, one that failed, or one
 * that was quiet because nothing but recall's order was left). An unranked result for a request with nothing to rank on (a
 * follow-up with no context, no candidates) seeds nothing.
 */
export function allowSeedFrom(
  ranking: TaskRanking | undefined,
): ((slug: string, confidence: string) => boolean) | undefined {
  if (!ranking) return undefined;
  if (!ranking.ranked)
    return ranking.why === "error" || ranking.why === "local-quiet" ? undefined : () => false;
  const jev = new Set(seedableCards(ranking.result).map((id) => recipeSlugOf(id)));
  const local = new Set(
    ranking.result.use.filter((e) => e.source === "local").map((e) => recipeSlugOf(e.cardId)),
  );
  return (slug, confidence) => jev.has(slug) || (confidence === "high" && local.has(slug));
}

/** The card's display name: its id without the kind, as the chip and the short-list note name it. */
const nameOf = (cardId: string): string => cardId.slice(cardId.indexOf(":") + 1);

export type Advice = {
  /** `Use: … · Inspiration: … (§ section) · source: Jev|local` */
  line: string;
  source: "Jev" | "local";
  use: Array<{ cardId: string; source: string }>;
  inspire: Array<{ cardId: string; source: string; section?: string }>;
};

export function adviceOf(ranking: TaskRanking | undefined): Advice | undefined {
  if (!ranking?.ranked) return undefined;
  const r: RankResult = ranking.result;
  const line = adviceLine(r, nameOf);
  if (!line) return undefined;
  return {
    line,
    source: r.source === "local" ? "local" : "Jev",
    use: r.use.map((e) => ({ cardId: e.cardId, source: e.source })),
    inspire: r.inspire.map((e) => ({
      cardId: e.cardId,
      source: e.source,
      ...(e.section ? { section: e.section } : {}),
    })),
  };
}

const xmlText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * The tag the chat reads the line from. The body is the line itself, so the agent reads it as plain advice and the chat can
 * rebuild it from the stored turn after a reload.
 */
export function adviceTag(a: Advice): string {
  return `<recipe_advice source="${a.source}">${xmlText(a.line)}</recipe_advice>`;
}
