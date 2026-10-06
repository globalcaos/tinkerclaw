// Learning trigger phrases from the tasks a card served off its list (Broca retrieval v2, phase F).
//
// WHAT THIS IS FOR. When the agent opens a card the list did not offer, the words of that task were not reaching the card.
// The nightly card loop already has the means to change what a card is matched on: a small, versioned edit of its text
// (`alsoServed`, "kinds of task it served that its author never had in mind"), scored on tasks it was not derived from, kept
// only when it helps. This module adds one more source of such an edit that needs no model: the key phrases that several of
// those off-list tasks share. It writes them as an `also-served` line, which Jev's card text, local matching and the recall
// catalogue (as trigger tags) all read. It builds no second loop and no second store.
//
// BOUNDED. At most `MAX_PHRASES` phrases of `PHRASE_CHARS` each in one line of at most `MAX_EDIT_CHARS`; a phrase must come
// from at least `MIN_TASKS` different tasks, so one odd request cannot teach a card its wording; `alsoServed` keeps its last
// eight lines, so a card never accumulates without end; at most `MAX_CARDS_PER_NIGHT` cards change in a night.
//
// NO LEAKAGE. The cases are split by time. Phrases come from the earlier part only (`train`); a candidate edit is kept or
// dropped on the later part (`validation`), with the rule the loop already has (the weighted mean reciprocal rank must rise
// and no pinned case may lose its rank). A caller that wants an untouched report holds a third, later part back and scores it
// once with the before and after cards (the replay script does).
//
// REVERSIBLE. Every card version is kept; going back is a pointer change (`ThalamusStore.setActiveVersion`).
//
// DERIVED FROM the 2026-10-06 build charter, phase F. WHAT WOULD CHANGE IT: a replay showing learned phrases stealing rank from
// other cards (the held-out rule would then refuse them already, but the thresholds here would be tightened), or a week of
// nights in which no edit is kept (the phrase test is too strict).
//
// PURE. No clock, no I/O.

import { isStopWord } from "./enhancement-recall.js";
import { taskText } from "./enhancement-text.js";
import {
  applyEdit,
  evaluateEdit,
  MAX_EDIT_CHARS,
  type CardEdit,
  type EditVerdict,
  type Ranker,
  type ReplayTask,
} from "./thalamus-card-loop.js";
import type { EnhancementCard } from "./thalamus-enhancements.js";

export const MAX_PHRASES = 3;
export const PHRASE_CHARS = 48;
/** A phrase must be in this many different off-list tasks of the card. */
export const MIN_TASKS = 2;
export const MAX_CARDS_PER_NIGHT = 5;
/** Share of the cases (the earlier ones) that phrases may be taken from; the rest decide whether an edit is kept. */
export const TRAIN_FRACTION = 0.6;
/** The longest phrase tried, in words. */
const MAX_WORDS = 3;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const trimmed = (w: string): string => w.replace(/['’-]+$/, "");
const words = (text: string): string[] =>
  (taskText(text).toLowerCase().match(WORD) ?? []).map(trimmed);

/**
 * Words that look like a person's or a place's name: written with a capital letter every time they appear, and never as the
 * first word of a request. A learned phrase is written into a card's text and kept in every version, so a bare name is never
 * taught (it would also be wrong as a trigger: the next task about someone else shares nothing with it). A word seen once in
 * lower case is an ordinary word, whatever else it is.
 */
export function nameLikeWords(texts: readonly string[]): Set<string> {
  const capitalised = new Set<string>();
  const ordinary = new Set<string>();
  for (const text of texts) {
    (taskText(text).match(WORD) ?? []).forEach((raw, i) => {
      const w = trimmed(raw).toLowerCase();
      const isCap = raw[0] !== raw[0].toLowerCase() && raw !== raw.toUpperCase();
      if (i > 0 && isCap) capitalised.add(w);
      else if (i > 0 || !isCap) ordinary.add(w);
    });
  }
  return new Set([...capitalised].filter((w) => !ordinary.has(w)));
}

/** Every run of 1..3 consecutive words in `text` that starts and ends on a word with a subject, as strings. */
function phrasesOf(text: string, names: ReadonlySet<string> = new Set()): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= MAX_WORDS && i + n <= w.length; n++) {
      const run = w.slice(i, i + n);
      const first = run[0];
      const last = run[run.length - 1];
      if (isStopWord(first) || isStopWord(last)) continue;
      // a lone word must be long enough to mean something and not a number; a longer run must hold at least one real word
      if (n === 1 && (first.length < 5 || /^\d+$/.test(first))) continue;
      if (n > 1 && run.every((x) => /^\d+$/.test(x))) continue;
      if (run.some((x) => names.has(x))) continue;
      const phrase = run.join(" ");
      if (phrase.length > PHRASE_CHARS) continue;
      out.add(phrase);
    }
  }
  return out;
}

export type Example = { taskId: string; text: string };

/**
 * The key phrases that several tasks of one card share and the rest of the tasks do not: up to `MAX_PHRASES`, each from at
 * least `MIN_TASKS` different examples. A phrase scores its examples count times how rare it is in `background` (the other
 * tasks), longer phrases a little more; a phrase inside a chosen longer one is dropped.
 */
export function keyPhrases(examples: readonly Example[], background: readonly string[]): string[] {
  if (examples.length < MIN_TASKS) return [];
  const names = nameLikeWords([...examples.map((e) => e.text), ...background]);
  const inExamples = new Map<string, number>();
  for (const e of examples)
    for (const p of phrasesOf(e.text, names)) inExamples.set(p, (inExamples.get(p) ?? 0) + 1);
  const inBackground = new Map<string, number>();
  for (const t of background)
    for (const p of phrasesOf(t, names)) inBackground.set(p, (inBackground.get(p) ?? 0) + 1);
  const total = Math.max(1, background.length);
  const scored = [...inExamples.entries()]
    .filter(([, n]) => n >= MIN_TASKS)
    .map(([phrase, n]) => {
      const rarity = Math.log(1 + total / (1 + (inBackground.get(phrase) ?? 0)));
      const length = phrase.split(" ").length;
      return { phrase, score: n * rarity * (1 + 0.5 * (length - 1)) };
    })
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || (a.phrase < b.phrase ? -1 : 1));
  const chosen: string[] = [];
  for (const { phrase } of scored) {
    if (chosen.some((c) => c.includes(phrase) || phrase.includes(c))) continue;
    chosen.push(phrase);
    if (chosen.length === MAX_PHRASES) break;
  }
  return chosen;
}

/** The edit: one `also-served` line of the phrases, or undefined when there are none or the line would be too long. */
export function triggerEdit(cardId: string, phrases: readonly string[]): CardEdit | undefined {
  if (phrases.length === 0) return undefined;
  const text = phrases.join(", ");
  return text.length > MAX_EDIT_CHARS ? undefined : { cardId, kind: "also-served", text };
}

// ─── the cases and the learning pass ────────────────────────────────────────────────────────────────────────

export type TriggerCase = {
  taskId: string;
  ts: number;
  /** Redacted text from a source Jev may read: the only content this ever holds. */
  text: string;
  /** The task's cards (house rules left out by the caller) and whether the list offered each. */
  used: ReadonlyArray<{ cardId: string; onList: boolean }>;
  /** The owner said this card fits this task. */
  pinned?: ReadonlyArray<string>;
};

export type TriggerAttempt = {
  cardId: string;
  phrases: string[];
  /** Different off-list tasks the phrases came from, and how many tasks in the training part had the card off its list. */
  examples: number;
  kept: boolean;
  why: EditVerdict["why"] | "invalid-edit" | "no-phrases";
  before: number;
  after: number;
  /** Validation tasks scored. */
  n: number;
  /** Validation tasks whose used card ranked in the first 3: with the old cards and with the new. */
  hit3Before: number;
  hit3After: number;
};

export type TriggerResult = {
  /** Validation tasks whose used card ranked in the first 3, with the cards as given and as they end: what the pass did in all. */
  hit3: { before: number; after: number; n: number };
  attempts: TriggerAttempt[];
  /** The cards after every kept edit (the version number is the card's next version). */
  cards: EnhancementCard[];
  kept: number;
  train: number;
  validation: number;
};

const rankOfIn = (order: readonly string[], cardId: string): number | undefined => {
  const i = order.indexOf(cardId);
  return i < 0 ? undefined : i + 1;
};

/** The earlier `TRAIN_FRACTION` of the cases (by time) train; the later ones validate. Never share a timestamp. */
export function splitCases<T extends { ts: number }>(
  cases: readonly T[],
  trainFraction = TRAIN_FRACTION,
): { train: T[]; validation: T[] } {
  const sorted = cases.toSorted((a, b) => a.ts - b.ts);
  if (sorted.length < 2) return { train: sorted, validation: [] };
  const cut =
    sorted[Math.min(sorted.length - 1, Math.max(1, Math.floor(sorted.length * trainFraction)))].ts;
  return { train: sorted.filter((c) => c.ts < cut), validation: sorted.filter((c) => c.ts >= cut) };
}

/**
 * One pass: for each card that served at least `MIN_TASKS` training tasks off its list (heaviest first, at most
 * `MAX_CARDS_PER_NIGHT`), take their shared key phrases as an edit, score it on the validation tasks with `rank` and `weight`,
 * and keep it when the loop's rule says so. Kept edits accumulate: the next card is judged against the cards as already edited.
 * `rank` is the retriever (recall over the cards in production), so what is scored is what a prompt is ranked by.
 */
export function learnTriggers(p: {
  cases: readonly TriggerCase[];
  cards: readonly EnhancementCard[];
  rank: Ranker;
  /** What a use counts, as the loop weighs it (1 when absent). */
  weight?: (taskId: string, cardId: string, onList: boolean) => number;
  maxCards?: number;
}): TriggerResult {
  const { train, validation } = splitCases(p.cases);
  const weight = p.weight ?? (() => 1);
  const byCard = new Map<string, TriggerCase[]>();
  for (const c of train)
    for (const u of c.used)
      if (!u.onList) byCard.set(u.cardId, [...(byCard.get(u.cardId) ?? []), c]);
  const order = [...byCard.entries()]
    .filter(([id, cs]) => cs.length >= MIN_TASKS && p.cards.some((c) => c.id === id))
    .toSorted((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, p.maxCards ?? MAX_CARDS_PER_NIGHT);

  const replay: ReplayTask[] = validation.flatMap((c) =>
    c.used.map((u) => ({
      taskId: c.taskId,
      text: c.text,
      usedCardId: u.cardId,
      weight: weight(c.taskId, u.cardId, u.onList),
      pinned: (c.pinned ?? []).includes(u.cardId),
    })),
  );
  // a pin the owner set on a training task also guards every edit, so it cannot be lost
  for (const c of train)
    for (const id of c.pinned ?? [])
      replay.push({ taskId: c.taskId, text: c.text, usedCardId: id, weight: 1, pinned: true });

  const inFirst3 = (set: readonly EnhancementCard[]): number =>
    replay.filter((t) => {
      const r = rankOfIn(p.rank(t.text, set), t.usedCardId);
      return r !== undefined && r <= 3;
    }).length;

  let cards = [...p.cards];
  const attempts: TriggerAttempt[] = [];
  let kept = 0;
  for (const [cardId, examples] of order) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) continue;
    const exampleIds = new Set(examples.map((e) => e.taskId));
    const phrases = keyPhrases(
      examples.map((e) => ({ taskId: e.taskId, text: e.text })),
      train.filter((t) => !exampleIds.has(t.taskId)).map((t) => t.text),
    );
    const base = { cardId, phrases, examples: examples.length };
    const empty = { before: 0, after: 0, n: 0, hit3Before: 0, hit3After: 0 };
    const edit = triggerEdit(cardId, phrases);
    if (!edit) {
      attempts.push({ ...base, kept: false, why: "no-phrases", ...empty });
      continue;
    }
    const next = applyEdit(card, edit);
    if (!next) {
      attempts.push({ ...base, kept: false, why: "invalid-edit", ...empty });
      continue;
    }
    const after = cards.map((c) => (c.id === cardId ? next : c));
    const v = evaluateEdit({ tasks: replay, before: cards, after, rank: p.rank });
    const hit3 = inFirst3;
    attempts.push({
      ...base,
      kept: v.keep,
      why: v.why,
      before: v.before,
      after: v.after,
      n: v.n,
      hit3Before: hit3(cards),
      hit3After: hit3(after),
    });
    if (v.keep) {
      kept += 1;
      cards = after;
    }
  }
  return {
    hit3: { before: inFirst3(p.cards), after: inFirst3(cards), n: replay.length },
    attempts,
    cards,
    kept,
    train: train.length,
    validation: validation.length,
  };
}
