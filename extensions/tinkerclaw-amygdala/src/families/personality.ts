/**
 * Personality family (design doc 5.5, paper 6.5): three quiet notes at the post-tool seam. A result that contradicts
 * what the agent said it expected, first contact with something unfamiliar, and (opt-in) something the user would want
 * to hear about. It never holds, asks or blocks: the most severe thing it returns is a note.
 */
import type { TurnState } from "../context.js";
import type { Situation, Verdict } from "../types.js";
import { clip, crossesId } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

/** Rationing: one curiosity note per stretch of this many decisions. */
const CURIOSITY_GAP = 10;
/** Habituation: after this many sightings a thing is no longer new and novelty is not asked. */
const HABITUATED_AT = 3;

function subject(s: Situation): string {
  return clip(s.targets.value?.[0]?.path ?? s.tool.value ?? "") || "this step";
}

/**
 * How the last tool call ended, in the words the surprise note uses. Claude Code's Bash results carry no exit code, so
 * a missing exit is NOT an error (2026-10-03, live: every surprise note said "the result was an error"); the record's
 * shape decides, and an entry without one says only "a result".
 */
function observed(s: Situation): string {
  const rec = s.toolRecord.value;
  const last = rec && rec.length > 0 ? rec[rec.length - 1] : undefined;
  if (!last) return "no output";
  if (last.exit !== null) return `exit ${last.exit}`;
  if (last.failed === true) return "an error";
  if (last.outputLines === 0) return "no output";
  if (typeof last.outputLines === "number") {
    return `${last.outputLines} ${last.outputLines === 1 ? "line" : "lines"} of output`;
  }
  return "a result";
}

/** Which note wins, if any: surprise > novelty > worth-knowing. One place, so observe and decide cannot disagree. */
function pickNote(
  s: Situation,
  verdicts: Verdict[],
  asked: AskedQuestions,
): "surprise" | "novelty" | "worth-knowing" | null {
  if (s.seam !== "post-tool") return null;
  if (crossesId(asked, verdicts, "surprise")) return "surprise";
  if (crossesId(asked, verdicts, "novelty")) return "novelty";
  if (crossesId(asked, verdicts, "worth-knowing")) return "worth-knowing";
  return null;
}

export function createPersonalityFamily(_deps: FamilyDeps): Family {
  return {
    id: "personality",

    questionsFor(seam, s, state) {
      if (seam !== "post-tool") return [];
      const ids: string[] = [];
      if ((s.expectation.value ?? "") !== "") ids.push("surprise");
      // No count yet means nothing has been seen: first contact is exactly what novelty is for. Only a step that
      // touches something (a file, a folder, a host) can meet a new thing; a bare "Bash" is not one (2026-10-03).
      if (
        (s.targets.value?.length ?? 0) > 0 &&
        (s.contextCounts.value?.seen ?? 0) < HABITUATED_AT
      ) {
        ids.push("novelty");
      }
      if (!state.hurry && state.stepCount - state.curiosityStep >= CURIOSITY_GAP) {
        ids.push("worth-knowing");
      }
      return ids;
    },

    // The rationing clock starts only when the curiosity note is the one actually delivered.
    observe(seam, s, verdicts, state: TurnState, asked) {
      if (pickNote(s, verdicts, asked) === "worth-knowing") state.curiosityStep = state.stepCount;
    },

    decide(seam, s, verdicts, _state, asked): FamilyResult | null {
      switch (pickNote(s, verdicts, asked)) {
        case "surprise":
          return {
            response: {
              kind: "note",
              templateId: "surprise",
              slots: { expected: clip(s.expectation.value), observed: observed(s) },
              channel: "additionalContext",
            },
            drivers: ["surprise"],
            reasonCode: "surprise",
          };
        case "novelty":
          return {
            response: {
              kind: "note",
              templateId: "novelty",
              slots: { what: subject(s) },
              channel: "additionalContext",
            },
            drivers: ["novelty"],
            reasonCode: "novelty",
          };
        case "worth-knowing":
          return {
            response: {
              kind: "note",
              templateId: "relevant-fact",
              slots: { fact: `this looks relevant to your goals: ${subject(s)}` },
              channel: "additionalContext",
            },
            drivers: ["worth-knowing"],
            reasonCode: "worth-knowing",
          };
        default:
          return null;
      }
    },
  };
}
