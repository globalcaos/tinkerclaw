/**
 * The `j.*` row shapes — TINKER_UI_DESIGN_BIBLE/logging.md §4.12 (§9 step 9).
 *
 * ONE module owns how every J-series metric row is filled, so a producer site is a one-line call
 * and the n-slot assignment exists in exactly one place. catalog.ts (§9 step 1) still decides WHAT
 * may be recorded; this module decides only HOW each declared row is filled, and `j-rows.test.ts`
 * checks the two agree slot by slot.
 *
 * Why that check is the point: a producer writing `emitEvent("j.recall.resolve", { n1: count })`
 * by hand is ACCEPTED by the writer — the name is declared — and then charts the wrong series
 * forever, because n1 is `pointer_age_ms`. Nothing at runtime can notice. A typed helper plus a
 * test that reads the catalog can.
 *
 * MECHANISM (code vs prompt): CODE. The want is "every producer fills the same slots the same way,
 * every turn" — consistency, not judgment — and there is a structural producer to hang it on.
 * Nothing here belongs in a prompt.
 *
 * L3: `emitEvent` is O(1), never throws and never awaits, so every helper below is safe on a hot
 * path and safe before the writer starts (pre-start records are counted and dropped).
 * L4: no free text ever reaches a row. Labels are the closed sets typed here; a query, a topic, a
 * concept, a bridge, a recipe name or a path is never passed on. A raw session key may be handed
 * in — `emitEvent` hashes it into `session_hash` + `session_kind` and stores neither.
 */

import type { ThalamusPlan } from "../../shared/thalamus-plan.js";
import { supplyOfKey } from "../../shared/thalamus-supply.js";
import { emitEvent } from "./emit.js";

// ─── the closed label sets §4.12 declares (L1: one categorical dimension) ────────────────────

export const J_RECALL_OUTCOMES = ["hit", "miss"] as const;
export type JRecallOutcome = (typeof J_RECALL_OUTCOMES)[number];

export const J_SKILL_OUTCOMES = ["success", "failure"] as const;
export type JSkillOutcome = (typeof J_SKILL_OUTCOMES)[number];

export const J_LIMBIC_OUTCOMES = ["emitted", "suppressed"] as const;
export type JLimbicOutcome = (typeof J_LIMBIC_OUTCOMES)[number];

export const J_CURIOSITY_STATES = ["logged", "resolved"] as const;
export type JCuriosityState = (typeof J_CURIOSITY_STATES)[number];

export const J_CONTRADICTION_OUTCOMES = ["pass", "flagged", "blocked"] as const;
export type JContradictionOutcome = (typeof J_CONTRADICTION_OUTCOMES)[number];

// ─── the slot map ───────────────────────────────────────────────────────────────────────────

/**
 * What each helper writes, as data. `j-rows.test.ts` checks every entry against `EVENT_CATALOG`,
 * so a catalog slot that moves without its helper moving is a RED test rather than a chart that
 * quietly plots the wrong number.
 */
export interface JRowSpec {
  /**
   * The closed label set, or null when §4.12 declares no label at all (`j.consolidation.run`) or
   * leaves the dimension open (a domain, a bound name).
   */
  readonly labels: readonly string[] | null;
  readonly durMs: string | null;
  readonly n1: string | null;
  readonly n2: string | null;
  readonly n3: string | null;
  readonly n4: string | null;
  /** The declared `fields` keys this helper fills. */
  readonly fields: readonly string[];
}

export const J_ROW_SPECS: Readonly<Record<string, JRowSpec>> = {
  "j.recall.resolve": {
    labels: J_RECALL_OUTCOMES,
    durMs: null,
    n1: "pointer_age_ms",
    n2: "events_returned",
    n3: null,
    n4: null,
    fields: [],
  },
  "j.consolidation.run": {
    labels: null,
    durMs: "nightly cycle",
    n1: "events_scanned",
    n2: "skills_extracted",
    n3: "skills_deprecated",
    n4: null,
    fields: [],
  },
  "j.skill.outcome": {
    labels: J_SKILL_OUTCOMES,
    durMs: null,
    n1: null,
    n2: null,
    n3: null,
    n4: null,
    fields: ["skill_version"],
  },
  "j.limbic.attempt": {
    labels: J_LIMBIC_OUTCOMES,
    durMs: null,
    n1: "humor_potential",
    n2: null,
    n3: null,
    n4: null,
    fields: [],
  },
  "j.curiosity.gap": {
    labels: J_CURIOSITY_STATES,
    durMs: null,
    n1: "age_ms",
    n2: null,
    n3: null,
    n4: null,
    fields: [],
  },
  "j.mnemo.contradiction": {
    labels: J_CONTRADICTION_OUTCOMES,
    durMs: null,
    n1: null,
    n2: null,
    n3: null,
    n4: null,
    fields: [],
  },
  "j.bound.derived": {
    labels: null,
    durMs: null,
    n1: "derived_value",
    n2: "ceiling",
    n3: "fired",
    n4: "sample_size",
    fields: [],
  },
  "j.route.decision": {
    labels: null,
    durMs: null,
    n1: null,
    n2: null,
    n3: null,
    n4: null,
    fields: ["house", "mode", "score", "margin"],
  },
};

// ─── the rows ───────────────────────────────────────────────────────────────────────────────

/**
 * J1 · `j.recall.resolve` — one row per recall: did an evicted range come back when asked for,
 * how far back did it reach, and how many events did it return. The query text never appears.
 */
export function emitJRecallResolve(row: {
  readonly outcome: JRecallOutcome;
  /** Age of the OLDEST returned event; null when nothing came back (an honest gap, not a zero). */
  readonly pointerAgeMs: number | null;
  readonly eventsReturned: number;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.recall.resolve", {
    label: row.outcome,
    n1: row.pointerAgeMs,
    n2: row.eventsReturned,
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J5 · `j.consolidation.run` — one row per consolidation cycle, including an idle one: a cycle
 * that found nothing is a measurement, and suppressing it would make "no data" and "nothing to do"
 * the same reading (L10).
 */
export function emitJConsolidationRun(row: {
  readonly durMs: number;
  readonly eventsScanned: number;
  readonly skillsExtracted: number;
  readonly skillsDeprecated: number;
  readonly sessionKey?: string | null;
}): void {
  emitEvent("j.consolidation.run", {
    durMs: row.durMs,
    n1: row.eventsScanned,
    n2: row.skillsExtracted,
    n3: row.skillsDeprecated,
    sessionKey: row.sessionKey ?? null,
  });
}

/**
 * J5 · `j.skill.outcome` — one row per use of a consolidated skill, written at
 * `fork.skill.recordOutcome` (`src/fork/skill-rpc.ts`) after the outcome is recorded.
 */
export function emitJSkillOutcome(row: {
  readonly outcome: JSkillOutcome;
  /** The skill's version as an id ("v3"), never its body or name. */
  readonly skillVersion?: string | null;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.skill.outcome", {
    label: row.outcome,
    fields: { skill_version: row.skillVersion ?? null },
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J7 · `j.limbic.attempt` — one row per humor attempt, emitted or suppressed, with the computed
 * potential. Concepts, bridge, audience and the gate's reason string all stay out of the row.
 */
export function emitJLimbicAttempt(row: {
  readonly outcome: JLimbicOutcome;
  /** h_v2 for an emitted attempt; null where the gate ran BEFORE the score was computed. */
  readonly humorPotential: number | null;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.limbic.attempt", {
    label: row.outcome,
    n1: row.humorPotential,
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J8 · `j.curiosity.gap` — one row per state change of a knowledge gap. `ageMs` is 0 on `logged`
 * (the gap opens now) and the gap's real open age on `resolved`, which is the whole question.
 * The topic is free text and never travels.
 */
export function emitJCuriosityGap(row: {
  readonly toState: JCuriosityState;
  readonly ageMs: number;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.curiosity.gap", {
    label: row.toState,
    n1: row.ageMs,
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J14 · `j.mnemo.contradiction` — one row per write actually checked by the gate. `blocked` is in
 * the catalog's set but structurally unreachable today: contradiction-gate.ts is passive injection
 * by design, so a run of `blocked: 0` is the measurement that the gate never blocks, not a bug.
 */
export function emitJMnemoContradiction(row: {
  readonly outcome: JContradictionOutcome;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.mnemo.contradiction", {
    label: row.outcome,
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J16 · `j.bound.derived` — one row per derivation of a live bound: the value it derived, the
 * ceiling that could clamp it, whether the clamp actually bound, and how many live signals the
 * derivation had. Parts, never a ratio (L7).
 */
export function emitJBoundDerived(row: {
  /** The bound's stable name, e.g. "overseer.loop" — an id, never a sentence. */
  readonly bound: string;
  readonly derivedValue: number;
  /** The ceiling in force; null when none applied (an unclamped derivation). */
  readonly ceiling: number | null;
  /** 1 when the ceiling actually bound this derivation, else 0. */
  readonly fired: number;
  /** How many live inputs the derivation had — a bound derived from nothing is a constant. */
  readonly sampleSize: number;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.bound.derived", {
    label: row.bound,
    n1: row.derivedValue,
    n2: row.ceiling,
    n3: row.fired,
    n4: row.sampleSize,
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J19 · `j.route.decision` — one row per routed task: the domain it was classified into, the house
 * (billing supply) of the pick, the composition mode, the pick's intelligence score, and its margin
 * over the best rival FROM ANOTHER house.
 *
 * A producer calls `emitJRouteDecisionFromPlan` below, not this: the margin has to be measured the
 * way the plan measured it when it chose the mode, or a `debate` row could carry a margin that says
 * "uncontested" — and a hand-typed `margin: 0` charts a flat line nothing at runtime can notice.
 */
export function emitJRouteDecision(row: {
  /** The classified task domain — the one categorical dimension. */
  readonly domain: string;
  /** The supply/house the pick came from, as an id. */
  readonly house: string;
  readonly mode: string;
  readonly score: number;
  /**
   * The pick's score minus the best rival's FROM ANOTHER house — negative when a rival house is
   * smarter and the dial chose price. NULL when no other house is on the frontier, and the field is
   * then absent from the row (emit.ts skips a null field). Never 0 for "no rival": 0 reads as a
   * dead heat, the most contested board there is, which is the opposite of a one-house board.
   */
  readonly margin: number | null;
  readonly sessionKey?: string | null;
  readonly runId?: string | null;
}): void {
  emitEvent("j.route.decision", {
    label: row.domain,
    fields: {
      house: row.house,
      mode: row.mode,
      score: row.score,
      margin: row.margin,
    },
    sessionKey: row.sessionKey ?? null,
    runId: row.runId ?? null,
  });
}

/**
 * J19 · the route row straight from the plan, so the producer is ONE line.
 *
 * WHERE IT IS CALLED. Not in `src/shared/thalamus-plan.ts`, the site §4.12 names: that module is
 * bundled into the BROWSER (`tinker-ui/src/app.ts` imports `thalamusPlan` at runtime) and cannot
 * import this module — emit.ts pulls in node:worker_threads, node:fs and node:crypto and the vite
 * build would break. The producer is the node-only caller, the `thalamusPlan({…})` site in
 * `src/auto-reply/reply/model-selection.ts`, and only on a turn whose model the PLAN chose: a tier
 * default pinned from the model picker overrides the plan, and rowing that turn would credit the
 * router with a pick it did not make (rowing pinned turns first needs a declared field that tells
 * the two apart). Whether that caller exists today is recorded — and source-checked — in
 * `j-rows.test.ts` (WIRED / UNWIRED), never asserted here, where it would go stale.
 *
 * THE MARGIN is measured exactly as `thalamusPlan` measures it for its CONTESTED test: the smartest
 * rung on `route.frontier` whose supply differs from the pick's (its private `bestRivalSupply`).
 * The plan does not export that number, so this is a SECOND derivation of it, held to the first by
 * `j-rows.test.ts` on a contested and an uncontested board. Once the plan exports its margin, read
 * it here and delete the loop.
 *
 * L4: only the domain, the house id, the mode enum and two numbers travel. Model keys, the reason
 * line and the prompt never do.
 */
export function emitJRouteDecisionFromPlan(
  plan: ThalamusPlan,
  context: { readonly sessionKey?: string | null; readonly runId?: string | null } = {},
): void {
  const house = supplyOfKey(plan.primary.key);
  let rivalSmart: number | null = null;
  for (const rung of plan.route.frontier) {
    if (supplyOfKey(rung.key) === house) {
      continue;
    }
    if (rivalSmart === null || rung.smart > rivalSmart) {
      rivalSmart = rung.smart;
    }
  }
  emitJRouteDecision({
    domain: plan.domain,
    house,
    mode: plan.mode,
    score: plan.primary.smart,
    margin: rivalSmart === null ? null : plan.primary.smart - rivalSmart,
    sessionKey: context.sessionKey ?? null,
    runId: context.runId ?? null,
  });
}
