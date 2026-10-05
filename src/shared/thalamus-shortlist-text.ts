// THALAMUS v4 — what the agent reads when it is handed the short list (design doc section 13A.5; paper P§7.1).
//
// WHAT THIS IS FOR. The list is advice: a few lines the agent may use, ignore, or follow one entry down. This
// builds those lines from a `Shortlist` and the cards, in plain words. It is not Jev's wording (Jev never sees
// it); it is a note to the agent, which is why it lives here and not in `questions/*.json`.
//
// THE RULE IT KEEPS. Nothing forces, loads or runs an enhancement, and "none of these fits" is always said.
// A list that is not shown gives no text at all, so an agent is never pushed toward a tool for its own sake.
//
// PURE. No clock, no I/O.

import type { EnhancementCard, FitKind, Shortlist } from "./thalamus-enhancements.js";

const FIT_WORDS: Record<FitKind, string> = {
  "made-for": "made for this task",
  "by-structure": "not made for this, but it works the same way",
  "covers-part": "covers part of the task",
};

/** Enough to name what an entry is for, and short enough that the whole note stays a few lines. */
export const PURPOSE_CHARS = 110;
export const MAX_CHARS = 1600;

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

/**
 * The note for the agent, or undefined when there is nothing to say: the list is not shown, or none of its
 * cards is known.
 */
export function shortlistContext(
  list: Shortlist,
  cards: ReadonlyMap<string, EnhancementCard>,
): string | undefined {
  if (!list.shown) return undefined;
  const lines: string[] = [];
  const position = new Map<string, number>();
  for (const e of list.entries) {
    const card = cards.get(e.cardId);
    if (!card) continue;
    const n = lines.length + 1;
    position.set(e.cardId, n);
    const fit = e.fit ? `; ${FIT_WORDS[e.fit.value]}` : "";
    const where = card.path ? ` (${card.path})` : "";
    lines.push(
      `${n}. ${card.kind} ${card.name}, ${Math.round(e.prob * 100)}%${fit}: ${clip(card.purpose, PURPOSE_CHARS)}${where}`,
    );
  }
  if (lines.length === 0) return undefined;

  const head =
    "These enhancements may fit this task, most likely first. It is advice: take one, take another, or take none.";
  const tail = (n: number): string[] => {
    const out: string[] = [];
    if (list.together) {
      const [a, b] = list.together.map((id) => position.get(id));
      // Only say it when both entries are still in the note.
      if (a && b && a <= n && b <= n)
        out.push(`${a} and ${b} each cover part of the task and fit together.`);
    }
    out.push("None of these may fit; use your own judgment.");
    return out;
  };
  // The closing line is never the thing that gets cut. If the note is too long, the weakest entries go first.
  let n = lines.length;
  let text = [head, ...lines.slice(0, n), ...tail(n)].join("\n");
  while (text.length > MAX_CHARS && n > 1) {
    n -= 1;
    text = [head, ...lines.slice(0, n), ...tail(n)].join("\n");
  }
  return text;
}
