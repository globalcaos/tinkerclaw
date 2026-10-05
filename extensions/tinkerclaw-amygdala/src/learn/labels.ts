/**
 * Labels (design doc §7.3 item 1): what the user, an override or an outcome says about a decision, stored with a
 * weight, and the per-context counts that follow them.
 *
 * Value semantics:
 *  - `judge`:   +1 the judge was right (the alarm was warranted), -1 it was wrong (a false alarm).
 *  - `useful`:  +1 thumbs up, -1 thumbs down.
 *  - `miss`:    value +1, "the amygdala should have acted and did not" (on a proceeded decision).
 *  - `outcome`: what happened next (+1 good, -1 bad).
 *  - `undone`:  a loosening the user reverted.
 * Weights by source: user 3, override 2, outcome 1.
 */
import { randomUUID } from "node:crypto";
import { parseDrivers } from "../events.js";
import type { AmygdalaStore } from "../store.js";
import type { Label, LabelKind, Situation } from "../types.js";
import { recordConfirm, recordFalseAlarm } from "./contexts.js";

type Source = Label["source"];

const WEIGHT: Record<Source, Label["weight"]> = { user: 3, override: 2, outcome: 1 };

export class LabelService {
  private readonly store: AmygdalaStore;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(o: { store: AmygdalaStore; now?: () => number; idGen?: () => string }) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.idGen = o.idGen ?? randomUUID;
  }

  label(i: {
    targetId: string;
    targetKind: "decision" | "verdict";
    kind: LabelKind;
    value: -1 | 0 | 1;
    source?: Source;
  }): Label {
    const source = i.source ?? "user";
    const l: Label = {
      id: this.idGen(),
      targetId: i.targetId,
      targetKind: i.targetKind,
      kind: i.kind,
      value: i.value,
      source,
      weight: WEIGHT[source],
      ts: this.now(),
    };
    this.store.addLabel(l);
    if (
      i.targetKind === "decision" &&
      (i.kind === "judge" || i.kind === "useful") &&
      i.value !== 0
    ) {
      const { situation, questionIds } = this.driversOf(i.targetId);
      if (situation) {
        if (i.value < 0) recordFalseAlarm(this.store, situation, questionIds, l.ts);
        else recordConfirm(this.store, situation, questionIds, l.ts);
      }
    }
    return l;
  }

  /** The user's button on a card. Unknown interventions and answers that carry no judgement do nothing. */
  onIntervention(interventionId: string, answer: string): void {
    const iv = this.store.listInterventions().find((x) => x.id === interventionId);
    if (!iv) return;
    const acting = iv.kind === "hold" || iv.kind === "proof" || iv.kind === "ask";
    if (answer === "allow-once" && acting) {
      this.label({
        targetId: iv.decisionId,
        targetKind: "decision",
        kind: "judge",
        value: -1,
        source: "override",
      });
    } else if (answer === "keep-held" && acting) {
      this.label({
        targetId: iv.decisionId,
        targetKind: "decision",
        kind: "judge",
        value: 1,
        source: "override",
      });
    } else if (answer === "evidence") {
      this.label({
        targetId: iv.decisionId,
        targetKind: "decision",
        kind: "outcome",
        value: 1,
        source: "outcome",
      });
    }
  }

  markMiss(decisionId: string): Label {
    return this.label({
      targetId: decisionId,
      targetKind: "decision",
      kind: "miss",
      value: 1,
      source: "user",
    });
  }

  driversOf(decisionId: string): { situation: Situation | undefined; questionIds: string[] } {
    const d = this.store.getDecision(decisionId);
    if (!d) return { situation: undefined, questionIds: [] };
    return {
      situation: this.store.situationRecord(d.situationId),
      questionIds: parseDrivers(d.reasonCode),
    };
  }
}
