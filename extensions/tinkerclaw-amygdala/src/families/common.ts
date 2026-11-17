/**
 * Helpers shared by every family (design doc §3 M8). The one rule that must hold everywhere lives here:
 * a `cannot-tell` answer NEVER crosses a cut-off, whatever its probability (Phase D charter, item 1).
 */
import { goalFingerprint } from "../context.js";
import { proofGrantCode, requestAllows } from "../grant-code.js";
import type { EffectClass, Question, Situation, Verdict } from "../types.js";
import type { AskedQuestions, FamilyResult } from "./types.js";

export const CANNOT_TELL = "cannot-tell";

/** External effects: what "danger level 3" means in code when the judge is out (design doc C6, C12). */
export const EXTERNAL_EFFECTS: readonly EffectClass[] = [
  "send",
  "spend",
  "restart-own-system",
  "delete",
];

/** The owner's own chats. An agent writes the prompt of a subagent, job or reflection; anyone writes a group's. */
const OWNER_CHAT = /^agent:[^:]+:(?:tinker|dashboard|main)(?::|$)/;

/** One of the owner's own chats, by its session key. */
export function isOwnerChat(sessionKey: string): boolean {
  return OWNER_CHAT.test(sessionKey);
}

/**
 * A turn the owner started in his own chat (2026-10-30). Only there do his words release a step: a prompt an agent wrote
 * must not release the step it ordered, and a subagent's task reads as an owner turn.
 */
export function isOwnerTurn(s: Situation): boolean {
  return s.turnKind?.value === "owner" && OWNER_CHAT.test(s.sessionKey);
}

/** A cron run, a subagent or a background reflection: sessions no person types in. */
const NOBODY_TYPES_HERE = /:(?:cron|subagent|fractal):/;

/**
 * A turn nobody typed (2026-11-13): a job or an agent woke it (a Zen Mail card prompt and a finished long job arrive
 * this way), or it runs in a session no person types in. The owner is not reading that chat when it runs, so a
 * question put to him there is not seen: of the 20 scope asks on such turns from 10-23 to 11-13, none was answered.
 * A turn whose kind is unknown (no prompt seen since a restart) counts as typed, so nothing is loosened by a gap.
 */
export function isUnattendedTurn(s: Situation): boolean {
  const kind = s.turnKind?.value;
  return kind === "agent" || kind === "reflection" || NOBODY_TYPES_HERE.test(s.sessionKey);
}

/** His prompt says `allow <code>` for this step's goal, which is what the Allow under a held reply sends. No judge reads it. */
export function ownerAllowed(s: Situation): boolean {
  return isOwnerTurn(s) && requestAllows(s.request.value, proofGrantCode(goalFingerprint(s)));
}

/**
 * His prompt is an Allow button press. The code fits one step, but the press means "carry on with this work", so the
 * asks about scope stop for the rest of the turn: the next step of the same job is not a new question for him.
 */
export function ownerAllowTurn(s: Situation): boolean {
  return isOwnerTurn(s) && /\ballow\s+JEV-[0-9A-Z]{6}\b/i.test(s.request.value ?? "");
}

/** What a family returns when his Allow released the step it would stop. */
export const OWNER_RELEASE: FamilyResult = {
  response: { kind: "proceed" },
  drivers: [],
  reasonCode: "evidence-released-owner",
};

/** The verdict for a question, if it was asked and answered (not skipped). */
export function pick(verdicts: readonly Verdict[], id: string): Verdict | undefined {
  const v = verdicts.find((x) => x.questionId === id);
  return v && !v.skipped ? v : undefined;
}

export function isCannotTell(v: Verdict | undefined): boolean {
  return v !== undefined && v.type === "choice" && v.answer === CANNOT_TELL;
}

/** Probability of one option of a choice answer (the chosen option's `prob` when no distribution came back). */
export function optionProb(v: Verdict, option: string): number {
  if (v.probs && option in v.probs) return v.probs[option] ?? 0;
  return v.answer === option ? v.prob : 0;
}

/** Probability mass on every option except `option` and `cannot-tell`: "anything but X", faithfully. */
export function massOutside(v: Verdict, option: string): number {
  if (v.probs) {
    let m = 0;
    for (const [o, p] of Object.entries(v.probs)) if (o !== option && o !== CANNOT_TELL) m += p;
    return m;
  }
  return v.answer !== option && v.answer !== CANNOT_TELL ? v.prob : 0;
}

/** Numeric level of a score answer (0 when the answer is not a number). */
export function levelOf(v: Verdict | undefined): number {
  return v && typeof v.answer === "number" ? v.answer : 0;
}

/**
 * Does this answer reach the question's cut-off? Missing answers, skipped answers, `cannot-tell` and `none`
 * cut-offs never cross.
 */
export function crosses(q: Question | undefined, v: Verdict | undefined): boolean {
  if (!q || !v || v.skipped) return false;
  if (isCannotTell(v)) return false;
  const c = q.cutoff;
  switch (c.kind) {
    case "none":
      return false;
    case "prob":
      return v.prob >= c.at;
    case "level": {
      // Jev returns a score as an expected value (1.98, 0.08), not a whole level. A level cut-off asks "is the reading
      // at level N", so the answer is compared as its NEAREST level (half rounds up: 2.5 reads as 3). Comparing the raw
      // value made "at or below 0" unreachable for 0.08 and "at or above 2" unreachable for 1.98.
      const raw = typeof v.answer === "number" ? v.answer : Number.NaN;
      if (Number.isNaN(raw)) return false;
      const n = Math.round(raw);
      if (c.atOrAbove !== undefined) return n >= c.atOrAbove;
      if (c.atOrBelow !== undefined) return n <= c.atOrBelow;
      return false;
    }
    case "choice": {
      if (v.type !== "choice") return false;
      return (c.negate ? massOutside(v, c.option) : optionProb(v, c.option)) >= c.at;
    }
  }
}

/** Convenience: `crosses` looking the question and verdict up by id. */
export function crossesId(
  asked: AskedQuestions,
  verdicts: readonly Verdict[],
  id: string,
): boolean {
  return crosses(asked.get(id), pick(verdicts, id));
}

/** Truncate a value for a note slot: one short line, no newlines. */
export function clip(text: unknown, max = 80): string {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
