/**
 * Second-opinion family (design §5.3, paper §6.2): does the plan rest on the right reading of the request? It screens
 * a request for a misreading at the prompt, keeps the list of open readings settled by evidence, and at pre-tool
 * checks that a draft binds the user no harder than asked, that a step stays inside the request, and that no standing
 * fact is broken. It runs before safety, so the risk `observe` writes to the turn state is what safety reads.
 */
import type { TurnState } from "../context.js";
import { severity } from "../respond.js";
import type { Seam, Situation, Verdict } from "../types.js";
import { clip, crossesId, pick } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

function hasText(f: { value: string | null }): boolean {
  return typeof f.value === "string" && f.value.trim().length > 0;
}

function leadingOpen(state: TurnState) {
  return state.readings.find((r) => r.status === "open");
}

export function createSecondOpinionFamily(_deps: FamilyDeps): Family {
  return {
    id: "second-opinion",

    enrich(_seam: Seam, s: Situation, state: TurnState): void {
      if (state.readings.length > 0) return;
      const text = s.restatement.value;
      if (typeof text !== "string") return;
      const labels: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const m = LINE.exec(line);
        if (m?.[1]) labels.push(clip(m[1], 80));
      }
      if (labels.length < 2) return;
      state.readings = labels.map((label, i) => ({ id: `r${i + 1}`, label, status: "open" }));
    },

    questionsFor(seam: Seam, s: Situation, state: TurnState): string[] {
      const ids: string[] = [];
      if (seam === "prompt") {
        if (hasText(s.request)) ids.push("misreading-screen");
        return ids;
      }
      if (seam === "pre-tool") {
        if ((s.draftCommitments.value ?? []).length > 0) ids.push("commitment-changed");
        const effect = s.effectClass.value;
        if (
          (effect === "send" || effect === "spend" || effect === "delete") &&
          (hasText(s.request) || hasText(s.restatement))
        ) {
          ids.push("excess-scope");
        }
        if ((s.standingFacts.value ?? []).length > 0) ids.push("standing-fact-clash");
      }
      // Known design gap: one call per step covers only the leading open reading, not one call per reading.
      if ((seam === "pre-tool" || seam === "post-tool") && leadingOpen(state)) {
        ids.push("reading-confirmed", "reading-ruled-out");
      }
      return ids;
    },

    observe(
      seam: Seam,
      _s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): void {
      if (seam === "prompt") {
        if (!pick(verdicts, "misreading-screen")) return;
        state.misreadingRisk = crossesId(asked, verdicts, "misreading-screen") ? "medium" : "low";
        return;
      }
      if (seam !== "pre-tool" && seam !== "post-tool") return;
      const lead = leadingOpen(state);
      if (!lead) return;
      if (crossesId(asked, verdicts, "reading-ruled-out")) lead.status = "ruled-out";
      else if (crossesId(asked, verdicts, "reading-confirmed")) lead.status = "confirmed";
      // Evidence about consequences rather than intent is out of scope for this build.
      const open = state.readings.filter((r) => r.status === "open").length;
      const confirmed = state.readings.filter((r) => r.status === "confirmed").length;
      const ruled = state.readings.filter((r) => r.status === "ruled-out").length;
      if (open === 0 && confirmed >= 1) state.misreadingRisk = "low";
      else if (open >= 2) state.misreadingRisk = "high";
      else if (open === 1 && confirmed === 0 && ruled === state.readings.length - 1) {
        state.misreadingRisk = "medium";
      }
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      _state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam === "prompt") {
        if (!crossesId(asked, verdicts, "misreading-screen")) return null;
        return {
          response: {
            kind: "note",
            templateId: "reading-list",
            slots: { readings: "each plausible reading, one line each, plus a meaning not listed" },
            channel: "additionalContext",
          },
          drivers: ["misreading-screen"],
          reasonCode: "screen-flagged",
        };
      }
      if (seam !== "pre-tool") return null;

      const cands: FamilyResult[] = [];
      if (crossesId(asked, verdicts, "commitment-changed")) {
        cands.push({
          response: {
            kind: "ask",
            askId: `commitment-${s.id}`,
            options: [
              { id: "as-drafted", label: "Send it as drafted" },
              { id: "restore", label: "Restore what you asked for" },
              { id: "other", label: "Something else…" },
            ],
            preselect: "restore",
          },
          drivers: ["commitment-changed"],
          reasonCode: "commitment-changed",
        });
      }
      if (crossesId(asked, verdicts, "excess-scope")) {
        cands.push({
          response: {
            kind: "ask",
            askId: `scope-${s.id}`,
            options: [
              { id: "only-asked", label: "Do only what you asked" },
              { id: "go-beyond", label: "Go ahead beyond it" },
              { id: "other", label: "Something else…" },
            ],
            preselect: "only-asked",
          },
          drivers: ["excess-scope"],
          reasonCode: "excess-scope",
        });
      }
      if (crossesId(asked, verdicts, "standing-fact-clash")) {
        const fact = clashedFact(
          pick(verdicts, "standing-fact-clash"),
          s.standingFacts.value ?? [],
        );
        if (fact !== undefined) {
          cands.push({
            response: {
              kind: "note",
              templateId: "relevant-fact",
              slots: { fact: `the plan contradicts a standing fact: ${clip(fact)}` },
              channel: "additionalContext",
            },
            drivers: ["standing-fact-clash"],
            reasonCode: "standing-fact-clash",
          });
        }
      }
      // Most severe wins; the first in table order wins a tie.
      let best: FamilyResult | null = null;
      for (const c of cands) {
        if (!best || severity(c.response) > severity(best.response)) best = c;
      }
      return best;
    },
  };
}

/** `fact-N` names the Nth standing fact; an index outside the list means nothing to say. */
function clashedFact(v: Verdict | undefined, facts: readonly string[]): string | undefined {
  if (!v) return undefined;
  let key = v.answer;
  if (typeof key !== "string" || !/^fact-\d+$/.test(key)) {
    // The top pick was "none" but enough mass sits on a fact to cross: name the likeliest one.
    const probs = Object.entries(v.probs ?? {}).filter(([o]) => /^fact-\d+$/.test(o));
    probs.sort((a, b) => b[1] - a[1]);
    key = probs[0]?.[0] ?? "";
  }
  const m = /^fact-(\d+)$/.exec(String(key));
  if (!m) return undefined;
  return facts[Number(m[1]) - 1];
}
