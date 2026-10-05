/**
 * Precedent index (design doc §7.3 item 2): one incident becomes a precedent at once, no statistics. A candidate must
 * share the feature key and clear a token-overlap threshold; a harmless precedent at least as similar as the best
 * should-hold one cancels it.
 */
import { randomUUID } from "node:crypto";
import type { AmygdalaStore } from "../store.js";
import type { Precedent, Situation } from "../types.js";
import { commandTokens, featureKey, jaccard } from "./keys.js";

type PrecedentLabel = "should-hold" | "harmless";
type Match = { shouldHold: boolean; refs: string[] };

export class PrecedentIndex {
  private readonly store: AmygdalaStore;
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(o: {
    store: AmygdalaStore;
    threshold?: number;
    now?: () => number;
    idGen?: () => string;
  }) {
    this.store = o.store;
    this.threshold = o.threshold ?? 0.6;
    this.now = o.now ?? Date.now;
    this.idGen = o.idGen ?? randomUUID;
  }

  add(s: Situation, label: PrecedentLabel, incidentRef: string): Precedent {
    const p: Precedent = {
      id: this.idGen(),
      featureKey: featureKey(s),
      tokens: commandTokens(s),
      incidentRef,
      label,
      ts: this.now(),
      hits: 0,
    };
    this.store.addPrecedent(p);
    return p;
  }

  /** Null when the decision's situation record has been pruned. */
  addFromDecision(decisionId: string, label: PrecedentLabel): Precedent | null {
    const d = this.store.getDecision(decisionId);
    const s = d ? this.store.situationRecord(d.situationId) : undefined;
    return d && s ? this.add(s, label, decisionId) : null;
  }

  match(s: Situation): Match {
    const key = featureKey(s);
    const tokens = commandTokens(s);
    const hits: { p: Precedent; sim: number }[] = [];
    for (const p of this.store.allPrecedents()) {
      if (p.featureKey !== key) continue;
      const sim = jaccard(tokens, p.tokens);
      if (sim >= this.threshold) hits.push({ p, sim });
    }
    const hold = hits.filter((h) => h.p.label === "should-hold");
    const bestHold = Math.max(-1, ...hold.map((h) => h.sim));
    const bestHarmless = Math.max(
      -1,
      ...hits.filter((h) => h.p.label === "harmless").map((h) => h.sim),
    );
    for (const h of hits) this.store.bumpPrecedent(h.p.id);
    return {
      shouldHold: hold.length > 0 && bestHarmless < bestHold,
      refs: hold.map((h) => h.p.incidentRef),
    };
  }

  asDecideHook(): (s: Situation) => Match {
    return (s) => this.match(s);
  }
}
