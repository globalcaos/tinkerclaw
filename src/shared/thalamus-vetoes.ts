// THALAMUS v4 — vetoes come first (design doc sections 10-11; paper J19 v4.0 P§3 "Vetoes", P§4).
//
// WHAT THIS IS FOR. Four checks run before any price: privacy, policy, capacity and quota. v2
// already owns the last two and the reachability and engagement checks (`feasibility()` in
// `thalamus-feasibility.ts`); this file adds the two v2 does not have and runs them in front:
//
//   1. privacy  content from a source the operator marked private goes only to approved
//               providers. It is settled from the SOURCE, before any read and before anything
//               leaves the machine.
//   2. policy   the operator's table of which vendors may take which classes of topic.
//   3. v2       supply spent / cooling / unfunded, capacity, engagement (learned refusals).
//
// CAUTIOUS MODE (paper P§4, "when the reader is unsure"): when nobody checked the topic (Jev
// silent, or below the confidence floor) every vendor that has ANY topic restriction is left out,
// because a restricted vendor is a bet on a topic nobody looked at.
//
// HOW IT WAS DERIVED. Order and names follow v2: reachability is cheapest and most decisive, so
// privacy (which costs nothing to evaluate and cannot be undone once content is sent) goes first.
// A veto is a hard no, never a price penalty.
//
// PURE. No clock, no I/O; `nowMs` is an argument.

import { aaFamilyOf } from "./aa-effort-index.js";
import {
  feasibility,
  REFUSAL_VETO_COUNT,
  refusalCount,
  type FeasibilityContext,
  type RefusalLedger,
  type SubjectClass,
} from "./thalamus-feasibility.js";
import type { FrontierRung } from "./thalamus-frontier.js";
import { supplyOfKey, type SupplyId } from "./thalamus-supply.js";
import type { VetoRecord } from "./thalamus-v4-types.js";

/** Vendor (supply) x topic class -> allow or deny. Absent means allow. The operator owns it. */
export type PolicyTable = Partial<
  Record<SupplyId, Partial<Record<SubjectClass, "allow" | "deny">>>
>;

const CLASSES: readonly SubjectClass[] = ["medical", "security", "legal", "sensitive"];

/** The provider id of a `provider/model` route key ("claude-code" in "claude-code/claude-opus-5"). */
export function providerOfKey(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : key;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Is this source private? `source` is a label such as "channel:whatsapp" or "tinker"; patterns
 * may end in a star ("channel:*"). No source is not private: a call with no known origin is
 * treated like the Tinker chat, and the operator's list is what marks anything else.
 */
export function isPrivateSource(
  source: string | undefined,
  privateSources: readonly string[],
): boolean {
  if (!source) return false;
  return privateSources.some((p) => globToRegExp(p).test(source));
}

/**
 * Does this route's vendor have a topic restriction we know of? True when the operator's table
 * denies it any class, or when learned refusals have already vetoed its family for any class.
 */
export function hasTopicRestriction(
  key: string,
  policy: PolicyTable | undefined,
  refusals: RefusalLedger | undefined,
  nowMs: number,
): boolean {
  const row = policy?.[supplyOfKey(key)];
  if (row && Object.values(row).some((v) => v === "deny")) return true;
  const family = aaFamilyOf(key);
  return CLASSES.some((cls) => refusalCount(refusals, family, cls, nowMs) >= REFUSAL_VETO_COUNT);
}

export type VetoParams = Omit<FeasibilityContext, "subject"> & {
  /** From `isPrivateSource`, decided before any read. */
  private: boolean;
  /** Providers (route-key prefixes) that may see private content. */
  approvedProviders: readonly string[];
  topic: SubjectClass;
  /** Nobody checked the topic: leave out every vendor with a restriction. */
  cautious: boolean;
  policy?: PolicyTable;
};

export type VetoOutcome = {
  passed: FrontierRung[];
  vetoes: Array<{ key: string } & VetoRecord>;
};

/** The veto for one route key, or undefined when it passes. */
export function vetoFor(key: string, p: VetoParams): VetoRecord | undefined {
  if (p.private && !p.approvedProviders.includes(providerOfKey(key))) {
    return { veto: "privacy", detail: `${providerOfKey(key)} is not approved for private content` };
  }
  const row = p.policy?.[supplyOfKey(key)];
  if (p.topic !== "none" && row?.[p.topic] === "deny") {
    return {
      veto: "policy",
      detail: `${supplyOfKey(key)} is denied ${p.topic} work by the policy table`,
    };
  }
  if (p.cautious && hasTopicRestriction(key, p.policy, p.refusals, p.nowMs)) {
    return { veto: "policy", detail: "topic unchecked and this vendor has a topic restriction" };
  }
  const f = feasibility(key, { ...p, subject: p.topic });
  if (!f.ok) return { veto: f.veto!, detail: f.detail };
  return undefined;
}

/** Split rungs into the ones that may be priced and the ones that may not, with the reason. */
export function applyVetoes(rungs: readonly FrontierRung[], p: VetoParams): VetoOutcome {
  const passed: FrontierRung[] = [];
  const vetoes: VetoOutcome["vetoes"] = [];
  const seen = new Map<string, VetoRecord | undefined>();
  for (const r of rungs) {
    // The veto depends on the route, not the effort: compute once per key.
    if (!seen.has(r.key)) seen.set(r.key, vetoFor(r.key, p));
    const v = seen.get(r.key);
    if (v) {
      if (!vetoes.some((x) => x.key === r.key)) vetoes.push({ key: r.key, ...v });
    } else {
      passed.push(r);
    }
  }
  return { passed, vetoes };
}
