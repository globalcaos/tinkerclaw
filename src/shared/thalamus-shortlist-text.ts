// THALAMUS v4 — what the agent reads when it is handed the short list (design doc section 13A.5; paper P§7.1).
//
// WHAT THIS IS FOR. The list is advice: a few lines the agent may use, ignore, or follow one entry down. This
// builds those lines from a `Shortlist` and the cards, in plain words. It is not Jev's wording (Jev never sees
// it); it is a note to the agent, which is why it lives here and not in `questions/*.json`.
//
// THE RULE IT KEEPS. Nothing forces, loads or runs an enhancement, and "none of these fits" is always said.
// A list that is not shown gives no text at all, so an agent is never pushed toward a tool for its own sake.
//
// MEMORY POINTERS (2026-10-25). The same note may also carry a few one-line pointers to a note or a past chat that may
// already hold what the task needs (`thalamus-pointers.ts` finds them). An exact address each, never the content, at
// most `POINTER_MAX` lines and `POINTER_CHARS` characters. With no pointers the note is byte for byte what it was.
//
// PURE. No clock, no I/O.

import type { EnhancementCard, FitKind, Shortlist } from "./thalamus-enhancements.js";
import type { PointerKind } from "./thalamus-pointers.js";

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

/** A note or a past chat that may already hold what the task needs: what it is about and its exact address. */
export type MemoryPointer = {
  kind: PointerKind;
  /** The note's use key or heading; the chat's title. */
  label: string;
  /** A note's path; a past chat's session id. */
  where: string;
  date?: string;
};

/** At most this many memory pointers, in at most this many characters: a few lines on the desk, never a document. */
export const POINTER_MAX = 3;
export const POINTER_CHARS = 600;
const POINTER_LABEL_CHARS = 90;
const POINTER_HEAD =
  "Earlier work that may already hold what this needs (a pointer, not a summary; open it only if it fits):";

function pointerLine(p: MemoryPointer): string {
  const label = clip(p.label, POINTER_LABEL_CHARS);
  if (p.kind === "note") {
    return `- note: ${label} (${p.where})`;
  }
  const when = p.date ? ` ${p.date}` : "";
  return `- past chat${when}: "${label}" (session ${p.where.slice(0, 8)}; the ask-session skill can ask it)`;
}

/** The pointer lines that fit the budget, in the order given. Empty when none does. */
export function pointerLines(pointers: readonly MemoryPointer[]): string[] {
  const out: string[] = [];
  let used = POINTER_HEAD.length + 1;
  for (const p of pointers.slice(0, POINTER_MAX)) {
    const line = pointerLine(p);
    if (used + line.length + 1 <= POINTER_CHARS) {
      out.push(line);
      used += line.length + 1;
    }
  }
  return out;
}

/**
 * The note for the agent, or undefined when there is nothing to say: the list is not shown or none of its cards is
 * known, and no memory pointer fits.
 */
export function shortlistContext(
  list: Shortlist,
  cards: ReadonlyMap<string, EnhancementCard>,
  pointers: readonly MemoryPointer[] = [],
): string | undefined {
  const memory = pointerLines(pointers);
  const lines: string[] = [];
  const position = new Map<string, number>();
  for (const e of list.shown ? list.entries : []) {
    const card = cards.get(e.cardId);
    if (!card) continue;
    const n = lines.length + 1;
    position.set(e.cardId, n);
    const fit = e.fit
      ? `; ${FIT_WORDS[e.fit.value]}`
      : e.mode === "INSPIRE"
        ? `; ${FIT_WORDS["by-structure"]}`
        : "";
    // A local entry has no probability of its own: recall's order is all it carries, so no percentage is printed for it.
    const pct = e.source === "local" && e.prob === 0 ? "" : `, ${Math.round(e.prob * 100)}%`;
    const part = e.mode === "INSPIRE" && e.section ? ` (the "${e.section}" part)` : "";
    const where = card.path ? ` (${card.path})` : "";
    lines.push(
      `${n}. ${card.kind} ${card.name}${pct}${fit}${part}: ${clip(card.purpose, PURPOSE_CHARS)}${where}`,
    );
  }
  if (lines.length === 0 && memory.length === 0) {
    return undefined;
  }
  const memoryBlock = memory.length > 0 ? [POINTER_HEAD, ...memory] : [];
  if (lines.length === 0) {
    return [...memoryBlock, "None of these may fit; use your own judgment."].join("\n");
  }

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
  // The memory pointers have their own budget and sit between the tools and the closing line.
  const build = (n: number): string =>
    [head, ...lines.slice(0, n), ...memoryBlock, ...tail(n)].join("\n");
  let n = lines.length;
  let text = build(n);
  while (text.length > MAX_CHARS + (memoryBlock.length > 0 ? POINTER_CHARS : 0) && n > 1) {
    n -= 1;
    text = build(n);
  }
  return text;
}
