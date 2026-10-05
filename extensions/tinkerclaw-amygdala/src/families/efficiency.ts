/**
 * Efficiency family (design doc §5.4, paper §6.4): tells a stuck loop from steady work and picks the procedure a
 * request calls for. Code counts the repeats; the judge only scores progress and chooses among listed candidates.
 * Ships off by default (`families.efficiency`).
 */
import type { TurnState } from "../context.js";
import type { Seam, Situation, Verdict } from "../types.js";
import { CANNOT_TELL, crossesId, clip, optionProb, pick } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

export interface EfficiencyOptions {
  /** Past outcomes of a procedure (Phase E feeds this); no record means a success rate of 0.5. */
  stats?: (procedureId: string) => { chosen: number; ok: number } | undefined;
}

/** Repeats of the same error that make a stuck loop; the judge alone never triggers a warning. */
const REPEAT_LIMIT = 3;
const STEPS_LIMIT = 8;
/** Weights of the judge's probability and of the procedure's track record in the blended score. */
const W_JUDGE = 0.6;
const W_STATS = 0.4;
const LOAD_AT = 0.8;
const SUGGEST_AT = 0.5;
/** Guards float error at the exact boundaries (0.6 * 1 + 0.4 * 0.5 is 0.8 only up to rounding). */
const EPS = 1e-9;

export function createEfficiencyFamily(_deps: FamilyDeps, opts: EfficiencyOptions = {}): Family {
  const successRate = (id: string): number => {
    const st = opts.stats?.(id);
    return st && st.chosen > 0 ? st.ok / st.chosen : 0.5;
  };

  const futilityCrossed = (s: Situation, verdicts: Verdict[], asked: AskedQuestions): boolean =>
    crossesId(asked, verdicts, "progress-made") && (s.repeatedErrors.value ?? 0) >= REPEAT_LIMIT;

  /** The best candidate, if the judge picked one that exists and the cut-off is reached. */
  const bestCandidate = (
    s: Situation,
    verdicts: Verdict[],
    asked: AskedQuestions,
  ): { id: string; p: number } | null => {
    const v = pick(verdicts, "procedure-choice");
    if (!v || v.type !== "choice" || !crossesId(asked, verdicts, "procedure-choice")) return null;
    let top = String(v.answer);
    if (v.probs) {
      let best = -1;
      for (const [o, p] of Object.entries(v.probs)) {
        if (p > best) {
          best = p;
          top = o;
        }
      }
    }
    if (top === "none" || top === CANNOT_TELL) return null;
    const m = /^candidate-(\d+)$/.exec(top);
    if (!m) return null;
    const cand = (s.candidates.value ?? [])[Number(m[1]) - 1];
    if (!cand) return null;
    return { id: cand.id, p: optionProb(v, top) };
  };

  return {
    id: "efficiency",

    questionsFor(seam: Seam, s: Situation): string[] {
      if (seam === "post-tool") {
        const stuck =
          (s.repeatedErrors.value ?? 0) >= REPEAT_LIMIT ||
          (s.stepsSinceNewFact.value ?? 0) >= STEPS_LIMIT;
        return stuck ? ["progress-made"] : [];
      }
      if (seam === "prompt") {
        return (s.candidates.value ?? []).length > 0 ? ["procedure-choice"] : [];
      }
      return [];
    },

    // State changes live here so that decide stays free of side effects.
    observe(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): void {
      if (seam === "stop") {
        state.stopTask = false;
        return;
      }
      if (seam !== "post-tool" || !futilityCrossed(s, verdicts, asked)) return;
      if (state.futilityWarnings === 0) {
        state.futilityWarnings = 1;
      } else {
        state.stopTask = true;
        state.futilityWarnings = 2;
      }
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam === "pre-tool") {
        if (!state.stopTask) return null;
        return {
          response: { kind: "proof", templateId: "stop-task", slots: {}, needs: [] },
          drivers: [],
          reasonCode: "stop-task",
        };
      }

      if (seam === "post-tool") {
        if (!futilityCrossed(s, verdicts, asked)) return null;
        // observe already moved the counter: 1 = this was the first warning, 2 = the loop goes on after it.
        if (state.futilityWarnings === 1) {
          return {
            response: {
              kind: "note",
              templateId: "futility",
              slots: { n: s.repeatedErrors.value ?? 0 },
              channel: "additionalContext",
            },
            drivers: ["progress-made"],
            reasonCode: "futility-warn",
          };
        }
        if (state.futilityWarnings >= 2) {
          return {
            response: {
              kind: "note",
              templateId: "stop-task",
              slots: {},
              channel: "additionalContext",
            },
            drivers: ["progress-made"],
            reasonCode: "futility-stop",
          };
        }
        return null;
      }

      if (seam === "prompt") {
        const best = bestCandidate(s, verdicts, asked);
        if (!best) return null;
        const blended = W_JUDGE * best.p + W_STATS * successRate(best.id);
        if (blended < SUGGEST_AT - EPS) return null;
        return {
          response: {
            kind: "note",
            templateId: "procedure",
            slots: { id: clip(best.id), p: blended.toFixed(2) },
            channel: "additionalContext",
          },
          drivers: ["procedure-choice"],
          reasonCode: blended >= LOAD_AT - EPS ? "procedure-load" : "procedure-suggest",
        };
      }
      return null;
    },
  };
}
