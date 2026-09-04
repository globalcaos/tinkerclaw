// src/shared/thalamus-feasibility.ts
//
// FEASIBILITY — the vetoes THALAMUS applies BEFORE it compares fitness.
//
// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md §2 (M1), jarvis-icu.
//
// A constraint is not a preference, and collapsing the two is how a router talks itself into a
// model that cannot do the job. Three vetoes, each ruling out a different way a turn is lost at
// full price:
//
//   REACHABILITY — the supply is spent, cooling after a failure, or unfunded. A model that 429s
//                  has an effective intelligence of ZERO, however good its benchmark row is.
//   CAPACITY     — the job does not FIT. On the live board (2026-09-03) Grok 4.6 publishes a
//                  500,000-token window and Opus 5 publishes 1,000,000, so a task above ~500K is
//                  not a question of which model is smarter; Grok cannot hold it. This is the
//                  architect's "the context size of Grok could make sometimes require Opus",
//                  stated as arithmetic instead of as a hunch.
//   ENGAGEMENT   — the family systematically declines LEGITIMATE work in this subject class, so
//                  the turn returns a refusal instead of an answer and we pay for both.
//
// ON THE ENGAGEMENT VETO, PRECISELY. This exists because our own corpus contains real work that
// some families decline and others do not: herbal and clinical writing (the Pàmies edition),
// offensive-security research (J9 AEGIS), and adversarial prompts written to test our OWN agents.
// The request is identical whichever supplier serves it; only the supplier changes. This module
// therefore never rewrites, softens or reframes a prompt to get past a refusal — it routes to a
// supplier that will do the work as asked, and if none will, it says so and the turn stops.
//
// AND IT IS MEASURED, NOT DECLARED. There is no hand-written table of "who is prudish about
// what" here, on purpose: that is exactly the kind of opinion Fugu's epistemology replaces with
// measurement (arXiv 2606.21228 §3.1.2). The penalty comes from a ledger of refusals we have
// ACTUALLY OBSERVED, keyed (family, subjectClass), and an empty ledger vetoes nothing. Day one
// this term is inert by design; it earns its authority one observed refusal at a time.
//
// PURE. No I/O, no clock beyond the `nowMs` argument.

import { aaFamilyOf } from "./aa-effort-index.js";
import { supplyOfKey, type SupplyId, type SupplyState } from "./thalamus-supply.js";

/** Why a rung cannot be used this turn. Ordered by how early it is decided. */
export type FeasibilityVeto =
  | "supply-spent"
  | "supply-cooling"
  | "supply-unfunded"
  | "capacity"
  | "engagement"
  | "not-allowed";

export type Feasibility = { ok: boolean; veto?: FeasibilityVeto; detail?: string };

// ─── subject classes ────────────────────────────────────────────────────────────────────────

/**
 * The subject classes where a refusal is a plausible ROUTING outcome rather than a correct one.
 * Deliberately few and coarse: a class with too few observations never accumulates evidence,
 * which is the same reason the task-domain list in `thalamus-frontier.ts` is coarse.
 */
export type SubjectClass = "medical" | "security" | "legal" | "sensitive" | "none";

const SUBJECT_CUES: { cls: SubjectClass; re: RegExp }[] = [
  {
    cls: "medical",
    re: /\b(dose|dosage|posolog\w*|contraindicat\w*|herbal|herb|tincture|infusion|remedy|remedies|symptom|diagnos\w*|treatment|therapeutic|medicinal|clinical|patient|pharmac\w*|toxicity|side ?effects?|mg\/kg|phytotherap\w*|pamies|pàmies)\b/gi,
  },
  {
    cls: "security",
    re: /\b(exploit|payload|vulnerab\w*|cve-\d|penetration test|pentest|red ?team|malware|ransomware|reverse shell|privilege escalation|injection attack|prompt injection|jailbreak|threat model|attack surface|sandbox escape|c2 framework)\b/gi,
  },
  {
    cls: "legal",
    re: /\b(contract|clause|liability|indemnit\w*|licen[cs]e terms|gdpr|nda|patent claim|infring\w*|litigation|statute|regulat\w*|compliance)\b/gi,
  },
  {
    cls: "sensitive",
    re: /\b(politic\w*|election|immigration|abortion|religio\w*|extremis\w*|self-harm|suicide|weapon)\b/gi,
  },
];

/** Coarse, deterministic, inspectable — the same stand-in shape as `classifyTaskDomain`. */
export function classifySubject(text: string): SubjectClass {
  const t = (text ?? "").slice(0, 4000);
  if (!t.trim()) return "none";
  let best: SubjectClass = "none";
  let bestN = 0;
  for (const cue of SUBJECT_CUES) {
    const n = t.match(cue.re)?.length ?? 0;
    if (n > bestN) {
      bestN = n;
      best = cue.cls;
    }
  }
  return bestN > 0 ? best : "none";
}

// ─── the refusal ledger ─────────────────────────────────────────────────────────────────────

/** One observed refusal of legitimate work, as the reply path recorded it. */
export type RefusalRecord = {
  /** AA family key, e.g. "claude-opus-5" — families refuse, individual efforts do not. */
  family: string;
  cls: SubjectClass;
  atMs: number;
};

/**
 * How many observed refusals in a class before that family is vetoed for it, and how long an
 * observation counts. Two is deliberate: one refusal is a prompt, two is a policy. 30 days is
 * long enough to accumulate and short enough that a vendor loosening its guidance is forgiven
 * without anyone editing a table.
 */
export const REFUSAL_VETO_COUNT = 2;
export const REFUSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RefusalLedger = readonly RefusalRecord[];

export function refusalCount(
  ledger: RefusalLedger | undefined,
  family: string,
  cls: SubjectClass,
  nowMs: number,
): number {
  if (!ledger || cls === "none") return 0;
  let n = 0;
  for (const r of ledger) {
    if (r.cls === cls && r.family === family && nowMs - r.atMs < REFUSAL_TTL_MS) n += 1;
  }
  return n;
}

// ─── capacity ───────────────────────────────────────────────────────────────────────────────

/**
 * How much of a published window we are willing to plan into. A context window is the hard
 * ceiling for prompt PLUS completion plus whatever the turn grows by mid-flight, and a router
 * that plans to 100% of it schedules an overflow. 0.8 leaves the fifth for the answer.
 */
export const CAPACITY_HEADROOM = 0.8;

/**
 * Does this route have room for the job?
 *
 * UNKNOWN IS NOT A VETO. Several catalog rows publish `contextWindow: 0` (every google/* entry
 * on the 2026-09-03 board), and a missing number means the vendor did not tell us — reading that
 * as "zero capacity" would silently delete a whole supply from the frontier. Unknown passes and
 * the runtime overflow path (M4's `capacity` reroute) catches the rare miss.
 */
export function fitsContext(
  contextWindow: number | undefined,
  estimatedTokens: number | undefined,
): boolean {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return true;
  if (!estimatedTokens || !Number.isFinite(estimatedTokens)) return true;
  return estimatedTokens <= contextWindow * CAPACITY_HEADROOM;
}

// ─── the combined veto ──────────────────────────────────────────────────────────────────────

export type FeasibilityContext = {
  supplies: ReadonlyMap<SupplyId, SupplyState>;
  /** Supplies in a failure cooldown right now, from the health ledger (M4). */
  cooling?: ReadonlySet<SupplyId>;
  /** Supplies with no usable balance — today: openrouter while deliberately unfunded. */
  unfunded?: ReadonlySet<SupplyId>;
  /** `provider/model` → published context window, from the live model catalog. */
  contextWindowFor?: (key: string) => number | undefined;
  estimatedTokens?: number;
  subject?: SubjectClass;
  refusals?: RefusalLedger;
  nowMs: number;
};

/**
 * The full veto for one route key. Order matters and is the design's: reachability first
 * because it is cheapest and most decisive, capacity next because it is arithmetic, engagement
 * last because it is the only term that rests on accumulated observation.
 */
export function feasibility(key: string, ctx: FeasibilityContext): Feasibility {
  const id = supplyOfKey(key);
  const state = ctx.supplies.get(id);
  if (state?.spent) {
    return { ok: false, veto: "supply-spent", detail: `${id} ${state.binding?.label ?? ""} spent` };
  }
  if (ctx.cooling?.has(id)) {
    return { ok: false, veto: "supply-cooling", detail: `${id} cooling after a failure` };
  }
  if (ctx.unfunded?.has(id)) {
    return { ok: false, veto: "supply-unfunded", detail: `${id} has no funded balance` };
  }
  const window = ctx.contextWindowFor?.(key);
  if (!fitsContext(window, ctx.estimatedTokens)) {
    return {
      ok: false,
      veto: "capacity",
      detail: `~${Math.round((ctx.estimatedTokens ?? 0) / 1000)}k tokens exceeds ${Math.round((window ?? 0) / 1000)}k window`,
    };
  }
  const cls = ctx.subject ?? "none";
  if (cls !== "none") {
    const fam = aaFamilyOf(key);
    const n = refusalCount(ctx.refusals, fam, cls, ctx.nowMs);
    if (n >= REFUSAL_VETO_COUNT) {
      return {
        ok: false,
        veto: "engagement",
        detail: `${fam} declined ${cls} work ${n}× in the last 30 days`,
      };
    }
  }
  return { ok: true };
}
