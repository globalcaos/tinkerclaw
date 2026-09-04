// src/shared/thalamus-plan.ts
//
// THE PLAN — what THALAMUS decides for one turn: a primary rung, an ordered recovery chain, and
// a composition mode. Not a point. A plan.
//
// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md, jarvis-icu.
//
// WHY A PLAN AND NOT A MODEL. `agents.defaults.model.fallbacks` in ~/.openclaw/openclaw.json is
// literally `[]`. Underneath it sits a complete failure machinery — runWithModelFallback,
// resolveFallbackCandidates, auth-profile rotation, FallbackSummaryError — being handed an empty
// ladder every turn. That is the whole of "we are experiencing too many rate limitations that
// stall our thinking" (the architect, 2026-09-03): not a missing mechanism, a mechanism with no input.
// So the router stops emitting one model and starts emitting the ladder, and the existing
// `fallbacksOverride` seam consumes it.
//
// THE PIPELINE, in order, each stage a pure function of its arguments:
//
//   classify  → task domain (Fugu/J6 §3.6) · subject class · estimated tokens
//   M1 veto   → reachable ∧ fits ∧ will engage            (thalamus-feasibility.ts)
//   M2 price  → cost_eff = cost × (1 + λ·shadow(supply))  (thalamus-supply.ts)
//   frontier  → Pareto over cost_eff — UNCHANGED code, truthful axis
//   dial      → anchored on Opus 5, reserved set gated    (thalamus-frontier.ts)
//   domain    → measured-strength switch                  (thalamus-frontier.ts)
//   M5 mode   → solo | critic | debate | fan-out
//   M4 chain  → one rung per surviving supply, ordered
//
// THE ORDER IS THE ARGUMENT. Feasibility runs before fitness because a constraint is not a
// preference; the price bends before the frontier because fairness must not need a second
// selector beside the first; and the chain is built from the SAME band as the primary, so a
// fallback is never a model the dial would have refused.

import {
  classifySubject,
  feasibility,
  type FeasibilityContext,
  type FeasibilityVeto,
  type RefusalLedger,
  type SubjectClass,
} from "./thalamus-feasibility.js";
import {
  clampBiasIdx,
  classifyTaskDomain,
  isReservedKey,
  thalamusRoute,
  type FrontierRung,
  type TaskDomain,
  type ThalamusRoute,
} from "./thalamus-frontier.js";
import {
  effectiveCost,
  fanOutSupply,
  supplyOfKey,
  type SupplyId,
  type SupplyState,
} from "./thalamus-supply.js";

/** How the turn is executed. `solo` is the default and the cheap one. */
export type CompositionMode = "solo" | "critic" | "debate" | "fan-out";

/** Why a reserved model (Fable) was admitted. Never absent when one is picked. */
export type ReservedReason = "dial" | "ballistic" | "feasibility";

export type RungVeto = { key: string; veto: FeasibilityVeto; detail?: string };

export type ThalamusPlan = {
  /** The decision the frontier made, with its own reason string. */
  route: ThalamusRoute;
  /** The rung the turn runs on. */
  primary: FrontierRung;
  /** Ordered recovery ladder, one rung per surviving supply, primary excluded. */
  chain: FrontierRung[];
  mode: CompositionMode;
  /** Debate: the independent answerers (access: []). Fan-out: the leaf model. */
  panel: string[];
  /** Debate / fan-out: who synthesises. Chosen per query — the domain leader, never fixed. */
  chair?: string;
  /** Fan-out: the supply the leaves are drawn from — widest clock, most headroom. */
  leafSupply?: SupplyId;
  domain: TaskDomain;
  subject: SubjectClass;
  biasIdx: number;
  ballistic: boolean;
  reservedReason?: ReservedReason;
  /** Every rung that was vetoed, so the panel can show WHY the board shrank. */
  vetoes: RungVeto[];
  supplies: SupplyState[];
  /** One line a human reads. */
  reason: string;
};

export type ThalamusPlanParams = {
  rungs: readonly FrontierRung[];
  supplies: ReadonlyMap<SupplyId, SupplyState>;
  biasIdx?: number;
  promptText?: string;
  /** Explicit overrides; otherwise classified from `promptText`. */
  domain?: TaskDomain;
  subject?: SubjectClass;
  estimatedTokens?: number;
  contextWindowFor?: (key: string) => number | undefined;
  cooling?: ReadonlySet<SupplyId>;
  unfunded?: ReadonlySet<SupplyId>;
  refusals?: RefusalLedger;
  /** How many independent units the caller intends to run. >1 ⇒ fan-out is on the table. */
  fanOutWidth?: number;
  strengthFor?: (
    key: string,
    domain: TaskDomain,
  ) => ReturnType<NonNullable<Parameters<typeof thalamusRoute>[0]["strengthFor"]>>;
  nowMs: number;
};

/** Longest recovery ladder handed to the runtime. One per supply is already the useful limit;
 *  past four the turn has been failing long enough that a human should see it. */
export const MAX_CHAIN = 4;

/**
 * Composition costs strictly more tokens (MAESTRO §2: a capability mechanism applied to an easy
 * task is pure cost), so it is gated on the dial rather than offered by default. At or below
 * balanced the turn is solo unless a ballistic window has made the tokens free.
 */
export const COMPOSITION_MIN_BIAS = 4;

/** Domains where a cross-vendor critic pays — a builder is a poor judge of its own blind spots. */
const BUILDISH: ReadonlySet<TaskDomain> = new Set<TaskDomain>(["code", "agentic"]);

/** A domain is CONTESTED when the leader's margin over the best rival FROM ANOTHER SUPPLY is
 *  below this. Measured cross-supply on purpose: two models of one house share the lineage that
 *  produced the blind spot, so their agreement is not evidence. */
export const CONTESTED_MARGIN = 1.5;

function estimateTokens(
  promptText: string | undefined,
  explicit: number | undefined,
): number | undefined {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  if (!promptText) return undefined;
  // ~4 chars per token is the standard rough rule; this number only ever decides a CAPACITY
  // veto, which has its own 20% headroom, so a coarse estimate is the honest resolution here.
  return Math.ceil(promptText.length / 4);
}

/**
 * The plan.
 *
 * Two passes over the rungs, and the second one only happens when the first leaves nothing:
 * if every rung is vetoed or every survivor is reserved, the reserved set opens with
 * `reservedReason: "feasibility"` — which is the difference between "Thalamus escalated to
 * Fable" and "Thalamus had nothing else and said so".
 */
export function thalamusPlan(params: ThalamusPlanParams): ThalamusPlan | undefined {
  const biasIdx = clampBiasIdx(params.biasIdx);
  const domain = params.domain ?? classifyTaskDomain(params.promptText ?? "");
  const subject = params.subject ?? classifySubject(params.promptText ?? "");
  const estimatedTokens = estimateTokens(params.promptText, params.estimatedTokens);
  const ballistic = [...params.supplies.values()].some((s) => s.ballistic);

  const fctx: FeasibilityContext = {
    supplies: params.supplies,
    cooling: params.cooling,
    unfunded: params.unfunded,
    contextWindowFor: params.contextWindowFor,
    estimatedTokens,
    subject,
    refusals: params.refusals,
    nowMs: params.nowMs,
  };

  // ── M1 + M2: veto, then re-price on the truthful axis ────────────────────────────────────
  const vetoes: RungVeto[] = [];
  const priced: FrontierRung[] = [];
  for (const r of params.rungs) {
    const f = feasibility(r.key, fctx);
    if (!f.ok) {
      vetoes.push({ key: r.key, veto: f.veto!, detail: f.detail });
      continue;
    }
    const supply = params.supplies.get(supplyOfKey(r.key));
    priced.push({ ...r, cost: effectiveCost(r.cost, supply) });
  }
  if (priced.length === 0) return undefined;

  // ── the dial, and the three named reasons the reserved set opens ─────────────────────────
  const onlyReservedLeft = priced.every((r) => isReservedKey(r.key));
  const reservedReason: ReservedReason | undefined =
    biasIdx >= 6 ? "dial" : ballistic ? "ballistic" : onlyReservedLeft ? "feasibility" : undefined;

  const route = thalamusRoute({
    rungs: priced,
    biasIdx,
    domain,
    strengthFor: params.strengthFor,
    allowReserved: reservedReason !== undefined,
  });
  if (!route) return undefined;

  const primary = route.rung;

  // ── M4: the recovery ladder — one rung per OTHER supply, cheapest-effective first ─────────
  const chain = buildChain(priced, route, primary);

  // ── M5: composition ──────────────────────────────────────────────────────────────────────
  const width = Math.max(1, Math.floor(params.fanOutWidth ?? 1));
  const composable = biasIdx >= COMPOSITION_MIN_BIAS || ballistic;
  let mode: CompositionMode = "solo";
  let panel: string[] = [];
  let chair: string | undefined;
  let leafSupply: SupplyId | undefined;

  if (width > 1) {
    // Clock-aware fan-out. The leaves are O(N) tokens and the chair is O(1), so the leaves go
    // to the supply with the most headroom and the most forgiving clock — on our board xAI,
    // for the structural reason that it publishes NO 5-hour window and therefore cannot have a
    // burst trip a short limiter — and the chair stays the domain leader whatever it costs.
    const leaf = fanOutSupply(params.supplies);
    const leafRung = leaf
      ? priced
          .filter((r) => supplyOfKey(r.key) === leaf.id)
          .sort((a, b) => b.smart - a.smart || a.cost - b.cost)[0]
      : undefined;
    if (leafRung) {
      mode = "fan-out";
      leafSupply = leaf?.id;
      panel = [leafRung.key];
      chair = primary.key;
    }
  } else if (composable) {
    const rival = bestRivalSupply(route.frontier, primary);
    const contested = rival !== undefined && primary.smart - rival.smart < CONTESTED_MARGIN;
    if (contested) {
      mode = "debate";
      panel = panelOf(route.frontier, primary, 3);
      chair = primary.key; // the domain leader chairs — chosen per query, never fixed
    } else if (BUILDISH.has(domain) && rival) {
      mode = "critic";
      panel = [rival.key];
      chair = primary.key;
    }
  }

  const reason = buildReason({
    route,
    mode,
    panel,
    leafSupply,
    ballistic,
    reservedReason,
    subject,
    chain,
    vetoes,
  });

  return {
    route,
    primary,
    chain,
    mode,
    panel,
    chair,
    leafSupply,
    domain,
    subject,
    biasIdx,
    ballistic,
    reservedReason: isReservedKey(primary.key) ? reservedReason : undefined,
    vetoes,
    supplies: [...params.supplies.values()],
    reason,
  };
}

/**
 * The recovery ladder: at most one rung per OTHER supply, best-in-supply, ordered by effective
 * cost. SUPPLY DIVERSITY IS THE POINT — the failure this exists to survive is a rate limit, and
 * a second rung on the same rate-limited supply survives nothing. A same-supply rung is
 * appended only at the tail, and only when fewer than two other supplies exist.
 */
function buildChain(
  priced: readonly FrontierRung[],
  route: ThalamusRoute,
  primary: FrontierRung,
): FrontierRung[] {
  const primarySupply = supplyOfKey(primary.key);
  const bySupply = new Map<SupplyId, FrontierRung>();
  for (const r of priced) {
    if (r.key === primary.key && r.effort === primary.effort) continue;
    // A fallback may be dimmer than the pick — that is the whole point of a fallback — but not
    // arbitrarily so. `chainFloor` is the most permissive dial stop's floor, so recovery can
    // trade intelligence for availability inside the range the operator has already sanctioned.
    if (r.smart < route.chainFloor) continue;
    const id = supplyOfKey(r.key);
    if (id === primarySupply) continue;
    const held = bySupply.get(id);
    if (!held || r.smart > held.smart || (r.smart === held.smart && r.cost < held.cost)) {
      bySupply.set(id, r);
    }
  }
  const out = [...bySupply.values()].sort((a, b) => a.cost - b.cost);
  if (out.length < 2) {
    const sameSupply = priced
      .filter(
        (r) =>
          supplyOfKey(r.key) === primarySupply &&
          !(r.key === primary.key && r.effort === primary.effort) &&
          r.smart >= route.chainFloor,
      )
      .sort((a, b) => a.cost - b.cost)[0];
    if (sameSupply) out.push(sameSupply);
  }
  return out.slice(0, MAX_CHAIN);
}

/** The best frontier rung drawn from a DIFFERENT supply than the pick. */
function bestRivalSupply(
  frontier: readonly FrontierRung[],
  pick: FrontierRung,
): FrontierRung | undefined {
  const own = supplyOfKey(pick.key);
  let best: FrontierRung | undefined;
  for (const r of frontier) {
    if (supplyOfKey(r.key) === own) continue;
    if (!best || r.smart > best.smart) best = r;
  }
  return best;
}

/** One answerer per distinct supply, in intelligence order, capped. Fugu's isolation rule
 *  applies at dispatch: panellists answer with `access: []` and only the chair sees them. */
function panelOf(frontier: readonly FrontierRung[], pick: FrontierRung, cap: number): string[] {
  const seen = new Set<SupplyId>([supplyOfKey(pick.key)]);
  const out: string[] = [];
  for (const r of [...frontier].sort((a, b) => b.smart - a.smart)) {
    const id = supplyOfKey(r.key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r.key);
    if (out.length >= cap - 1) break;
  }
  return out;
}

function buildReason(p: {
  route: ThalamusRoute;
  mode: CompositionMode;
  panel: string[];
  leafSupply?: SupplyId;
  ballistic: boolean;
  reservedReason?: ReservedReason;
  subject: SubjectClass;
  chain: readonly FrontierRung[];
  vetoes: readonly RungVeto[];
}): string {
  const bits = [p.route.reason];
  if (p.subject !== "none") bits.push(`subject ${p.subject}`);
  if (p.vetoes.length > 0) {
    const counts = new Map<FeasibilityVeto, number>();
    for (const v of p.vetoes) counts.set(v.veto, (counts.get(v.veto) ?? 0) + 1);
    bits.push(
      `vetoed ${p.vetoes.length} rung(s): ${[...counts].map(([k, n]) => `${k}×${n}`).join(", ")}`,
    );
  }
  if (p.ballistic) bits.push("BALLISTIC — a window is about to destroy surplus; tokens are free");
  if (p.reservedReason) bits.push(`reserved set opened by ${p.reservedReason}`);
  if (p.mode === "fan-out") bits.push(`fan-out leaves on ${p.leafSupply} (widest clock)`);
  else if (p.mode !== "solo") bits.push(`${p.mode}: ${p.panel.join(", ")}`);
  bits.push(
    p.chain.length > 0
      ? `if it fails → ${p.chain.map((r) => r.key).join(" → ")}`
      : "NO fallback available — a failure stalls the turn",
  );
  return bits.join(" · ");
}

/**
 * Reorder the ladder for a KNOWN failure class. The error tells you the DIRECTION of the
 * reroute, which is the difference between recovery and retry:
 *
 *   rate_limit / overloaded → a different supply (already the chain's shape)
 *   capacity                → strictly more context (the runtime form of Grok → Opus)
 *   engagement              → a family we have not seen refuse this subject
 *   timeout                 → cheapest first; the turn is already late
 */
export type FailureClass = "rate_limit" | "overloaded" | "capacity" | "engagement" | "timeout";

export function reorderChain(
  chain: readonly FrontierRung[],
  failure: FailureClass,
  ctx?: { contextWindowFor?: (key: string) => number | undefined },
): FrontierRung[] {
  const out = [...chain];
  if (failure === "capacity") {
    return out.sort(
      (a, b) => (ctx?.contextWindowFor?.(b.key) ?? 0) - (ctx?.contextWindowFor?.(a.key) ?? 0),
    );
  }
  if (failure === "timeout") return out.sort((a, b) => a.cost - b.cost);
  if (failure === "engagement") return out.sort((a, b) => b.smart - a.smart);
  return out;
}
