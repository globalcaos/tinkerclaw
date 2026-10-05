// THALAMUS v4 — which enhancement to reach for (design doc section 13A; paper J19 v4.1 P§7).
//
// WHAT THIS IS FOR. An assistant collects enhancements: skills, recipes and plugins, each holding the lessons
// of earlier work, none of them helping if the agent does not reach for it. Jev already reads the task; the same
// call ranks the enhancements, and the agent gets a short list in order, with probabilities, and decides. This
// module holds the parts that are pure: the cards Jev reads, the grouping into families (a choice holds at most
// 255 options), the combination of the family and within-family answers, the calibration map, and the short-list
// builder. The asking is in `extensions/tinkerclaw-thalamus/src/reads/enhancement-reader.ts`.
//
// HOW IT WAS DERIVED. Straight from P§7.1 and P§7.2. The list is the shortest run of entries holding 80 per cent
// of the probability, at most six; one option always reads "none of these fits", and when it leads the list is not
// shown. A card has two lines that matter: what the enhancement was made for, and how it works without its
// subject, so a task of the same shape in another subject still finds it.
//
// THE LIST IS ADVICE. Nothing here forces, loads or runs an enhancement for the agent (charter, line not to
// cross). WORDING lives only in `questions/*.json`; a card's text is data, not question wording.
//
// PURE. No clock, no I/O.

import type { JevQuestion, JevVerdict } from "../infra/jev/types.js";
import type { Answered } from "./thalamus-v4-types.js";

// ─── types ──────────────────────────────────────────────────────────────────────────────────────

export type EnhancementKind = "skill" | "recipe" | "plugin";

export type EnhancementCard = {
  /** "<kind>:<name>", the option key Jev returns. */
  id: string;
  kind: EnhancementKind;
  name: string;
  path?: string;
  family: string;
  /** What it was made for: description plus triggers. */
  purpose: string;
  /** How it works, without its subject (P§7.2). Empty until the nightly writer or the owner writes it. */
  structure: string;
  /** Kinds of task it served that its author never had in mind; learned (P§7.4). */
  alsoServed: string[];
  version: number;
  status: "active" | "retired";
  origin: "seed" | "nightly" | "owner";
};

/** Every version of a card is kept, so one step back is always a pointer change. */
export type CardVersion = {
  card: EnhancementCard;
  createdAt: number;
  parent?: number;
  replay?: { before: number; after: number; n: number };
};

export type Family = { id: string; purpose: string; memberIds: string[] };

export type FitKind = "made-for" | "by-structure" | "covers-part";

export type ShortlistEntry = {
  cardId: string;
  rank: number;
  prob: number;
  fit?: Answered<FitKind>;
};

export type Shortlist = {
  entries: ShortlistEntry[];
  /** Probability that none of the listed enhancements fits. */
  noneFitsProb: number;
  shown: boolean;
  reason: "shown" | "none-leads" | "empty" | "not-asked";
  source: "jev" | "local";
  /** The top two both cover part of the task: they fit together. */
  together?: [string, string];
};

/** What a scan of skills, recipes and plugins gives; the seed of the cards. */
export type EnhancementListing = {
  kind: EnhancementKind;
  name: string;
  path?: string;
  description?: string;
  triggers?: readonly string[];
  structure?: string;
};

export const NONE_KEY = "none";
export const FAMILY_QUESTION_ID = "enh-family";
export const MEMBER_QUESTION_PREFIX = "enh-in-";
export const FIT_QUESTION_PREFIX = "enh-fit-";

/** Ids Jev sees are kebab-case only, like every id in the amygdala's book. */
export const safeId = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/** A choice holds at most 255 options; one is kept for "none". */
export const MAX_CHOICE_OPTIONS = 255;
/**
 * The flat question: one choice over every card plus "none fits". Families exist only because one question holds at most
 * 255 options (paper 7.1), so when the registry fits, ranking every card in one question is the paper's own design. A margin
 * of five under the limit keeps a registry that grows by a few cards from flipping the design mid-day.
 */
export const FLAT_MAX_OPTIONS = MAX_CHOICE_OPTIONS - 5;
export const FLAT_QUESTION_ID = "enh-flat";
export const MAX_MEMBERS_PER_QUESTION = MAX_CHOICE_OPTIONS - 1;

export const SHORTLIST_SHARE = 0.8;
export const SHORTLIST_MAX = 6;
/** How many of the top entries get a fit-kind read. */
export const FIT_READS = 3;

// ─── cards ──────────────────────────────────────────────────────────────────────────────────────

/** Keyword rules that put an enhancement in a family. The first match wins; `other` is the default. */
export const FAMILY_RULES: readonly { family: string; re: RegExp }[] = [
  {
    family: "coding",
    re: /\b(code|coding|refactor|debug|test|typescript|python|git|commit|merge|deploy|build|repo|orca|lint)\b/i,
  },
  {
    family: "messages",
    re: /\b(whatsapp|email|e-mail|gmail|outlook|teams|slack|message|reply|inbox|draft|sms)\b/i,
  },
  {
    family: "documents",
    re: /\b(pdf|docx|xlsx|pptx|document|spreadsheet|slides?|ocr|extract|paper|report)\b/i,
  },
  {
    family: "shopping",
    re: /\b(amazon|shopping|price|buy|wallapop|milanuncios|obramat|marketplace|torrent)\b/i,
  },
  {
    family: "writing",
    re: /\b(write|writing|humani[sz]e|voice|blog|post|copy|marketing|translate|seo)\b/i,
  },
  { family: "media", re: /\b(video|audio|image|youtube|music|tts|whisper|photo|gif|diagram)\b/i },
  {
    family: "research",
    re: /\b(research|search|investigate|review|analy[sz]e|memory|benchmark|model)\b/i,
  },
  {
    family: "operations",
    re: /\b(gateway|restart|cron|server|ssh|systemd|health|monitor|config|backup|freeze)\b/i,
  },
  {
    family: "work-systems",
    re: /\b(factorial|planner|sharepoint|erp|business central|dades|copilot|m365|acme)\b/i,
  },
];

export const OTHER_FAMILY = "other";

export function familyOf(l: EnhancementListing, rules: typeof FAMILY_RULES = FAMILY_RULES): string {
  const haystack = `${l.name} ${l.description ?? ""} ${(l.triggers ?? []).join(" ")}`;
  return rules.find((r) => r.re.test(haystack))?.family ?? OTHER_FAMILY;
}

export const cardId = (kind: EnhancementKind, name: string): string => `${kind}:${name}`;

/** Version 1 cards from a listing. A listing entry seen twice keeps its first occurrence. */
export function seedCards(
  listing: readonly EnhancementListing[],
  rules: typeof FAMILY_RULES = FAMILY_RULES,
): EnhancementCard[] {
  const seen = new Set<string>();
  const out: EnhancementCard[] = [];
  for (const l of listing) {
    const id = cardId(l.kind, l.name);
    if (seen.has(id) || !l.name.trim()) continue;
    seen.add(id);
    const triggers = (l.triggers ?? []).filter((t) => t.trim()).join("; ");
    out.push({
      id,
      kind: l.kind,
      name: l.name,
      ...(l.path ? { path: l.path } : {}),
      family: familyOf(l, rules),
      purpose:
        [l.description?.trim(), triggers && `Triggers: ${triggers}`].filter(Boolean).join(" ") ||
        l.name,
      structure: l.structure?.trim() ?? "",
      alsoServed: [],
      version: 1,
      status: "active",
      origin: "seed",
    });
  }
  return out;
}

/** About sixty tokens: the text Jev reads for one option. Bounded so a few hundred cards stay cheap. */
export const CARD_TEXT_CHARS = 320;

export function cardText(c: EnhancementCard): string {
  const parts = [c.purpose];
  if (c.structure) parts.push(`Works by: ${c.structure}`);
  if (c.alsoServed.length > 0) parts.push(`Also served: ${c.alsoServed.join("; ")}`);
  const text = parts.join(" ");
  return text.length <= CARD_TEXT_CHARS ? text : `${text.slice(0, CARD_TEXT_CHARS - 1)}…`;
}

// ─── families ───────────────────────────────────────────────────────────────────────────────────

export type FamilyGrouping = {
  families: Family[];
  /** Cards left out because there were more families than one question can hold. They rank locally. */
  spilled: string[];
};

/**
 * Group active cards into families, each small enough for one choice question. A family with more than
 * 254 members is split into `<family>-p1`, `<family>~2`, ...; each part is a family option of its own. If
 * that still leaves more than 254 families, the smallest are left to local matching.
 */
export function groupFamilies(
  cards: readonly EnhancementCard[],
  purposeOf: (family: string) => string = (f) => f,
): FamilyGrouping {
  const byFamily = new Map<string, string[]>();
  for (const c of cards) {
    if (c.status !== "active") continue;
    const list = byFamily.get(c.family) ?? [];
    list.push(c.id);
    byFamily.set(c.family, list);
  }
  let families: Family[] = [];
  for (const [id, ids] of [...byFamily].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ids.length <= MAX_MEMBERS_PER_QUESTION) {
      families.push({ id: safeId(id), purpose: purposeOf(id), memberIds: ids });
      continue;
    }
    const parts = Math.ceil(ids.length / MAX_MEMBERS_PER_QUESTION);
    for (let k = 0; k < parts; k++) {
      families.push({
        id: `${safeId(id)}-p${k + 1}`,
        purpose: purposeOf(id),
        memberIds: ids.slice(k * MAX_MEMBERS_PER_QUESTION, (k + 1) * MAX_MEMBERS_PER_QUESTION),
      });
    }
  }
  const spilled: string[] = [];
  if (families.length > MAX_MEMBERS_PER_QUESTION) {
    const keep = [...families]
      .sort((a, b) => b.memberIds.length - a.memberIds.length || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_MEMBERS_PER_QUESTION);
    const kept = new Set(keep.map((f) => f.id));
    for (const f of families) if (!kept.has(f.id)) spilled.push(...f.memberIds);
    families = families.filter((f) => kept.has(f.id));
  }
  return { families, spilled };
}

// ─── the questions Jev is asked ─────────────────────────────────────────────────────────────────

/** The wording, from `questions/enhancement.json`. This file holds none of it. */
export type EnhancementTemplate = {
  familyInstructions: string;
  memberInstructions: string;
  fitInstructions: string;
  familyNoneText: string;
  memberNoneText: string;
  fitOptions: Record<FitKind, string>;
};

/** A small stable hash of a question's option set and instructions: a changed card is a new version. */
export function questionVersionOf(criteria: unknown, instructions: string): number {
  const text = JSON.stringify([criteria, instructions]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_000_000_000 || 1;
}

export type EnhancementQuestions = {
  questions: JevQuestion[];
  /** The option set as asked, needed to read the answers back. */
  families: Family[];
  /** One number for the whole set: changes when any card or family changes. */
  version: number;
  /** One question over every card (the registry fits), not a family question and one per family. */
  flat: boolean;
};

/**
 * The enhancement question set, all reading the task's request.
 *
 * FLAT when the registry and "none" fit in one question (`flatMaxOptions`, default `FLAT_MAX_OPTIONS`): one choice over
 * every card, and the probabilities are the ranking. Otherwise the family question and one within-family question per
 * family; the joint probability of a card is then P(family) x P(card | family), so a registry of any size fits in one call.
 * The within-family wording is reused for the flat question: it asks the same thing, which of these fits.
 */
export function buildEnhancementQuestions(
  grouping: FamilyGrouping,
  cardsById: ReadonlyMap<string, EnhancementCard>,
  t: EnhancementTemplate,
  o: { flatMaxOptions?: number } = {},
): EnhancementQuestions {
  const { families } = grouping;
  const cardCount = families.reduce((n, f) => n + f.memberIds.length, 0);
  if (
    grouping.spilled.length === 0 &&
    cardCount > 0 &&
    cardCount + 1 <= (o.flatMaxOptions ?? FLAT_MAX_OPTIONS)
  ) {
    const criteria: Record<string, string | null> = {};
    for (const f of families) {
      for (const id of f.memberIds) {
        const card = cardsById.get(id);
        if (card) criteria[id] = cardText(card);
      }
    }
    criteria[NONE_KEY] = t.memberNoneText;
    const question: JevQuestion = {
      id: FLAT_QUESTION_ID,
      version: questionVersionOf(criteria, t.memberInstructions),
      type: "choice",
      criteria,
      instructions: t.memberInstructions,
      fields: ["request"],
    };
    return {
      questions: [question],
      families,
      version: questionVersionOf([[question.id, question.version]], "enhancement-set"),
      flat: true,
    };
  }
  const familyCriteria: Record<string, string | null> = { [NONE_KEY]: t.familyNoneText };
  for (const f of families) familyCriteria[f.id] = f.purpose;

  const questions: JevQuestion[] = [
    {
      id: FAMILY_QUESTION_ID,
      version: questionVersionOf(familyCriteria, t.familyInstructions),
      type: "choice",
      criteria: familyCriteria,
      instructions: t.familyInstructions,
      fields: ["request"],
    },
  ];
  for (const f of families) {
    const criteria: Record<string, string | null> = {};
    for (const id of f.memberIds) {
      const card = cardsById.get(id);
      if (card) criteria[id] = cardText(card);
    }
    criteria[NONE_KEY] = t.memberNoneText;
    questions.push({
      id: `${MEMBER_QUESTION_PREFIX}${f.id}`,
      version: questionVersionOf(criteria, t.memberInstructions),
      type: "choice",
      criteria,
      instructions: t.memberInstructions,
      fields: ["request"],
    });
  }
  const version = questionVersionOf(
    questions.map((q) => [q.id, q.version]),
    "enhancement-set",
  );
  return { questions, families, version, flat: false };
}

/**
 * The fit-kind question for one entry: made for this task, fits by its structure, or covers part of it. The
 * card's own text rides in the instructions, so the answer is about this enhancement and no other.
 */
export function buildFitQuestion(
  card: EnhancementCard,
  rank: number,
  t: EnhancementTemplate,
): JevQuestion {
  const instructions = t.fitInstructions.replace("{card}", cardText(card));
  const criteria: Record<string, string | null> = { ...t.fitOptions };
  return {
    id: `${FIT_QUESTION_PREFIX}${rank}`,
    version: questionVersionOf(criteria, instructions),
    type: "choice",
    criteria,
    instructions,
    fields: ["request"],
  };
}

// ─── from verdicts to probabilities ─────────────────────────────────────────────────────────────

export type Joint = {
  /** Joint probability per card id. */
  probs: Map<string, number>;
  /** Probability that none of the enhancements fits. */
  noneFits: number;
  /** false when a needed verdict was missing or skipped; the missing mass went to `noneFits`. */
  complete: boolean;
  /** The lowest confidence among the verdicts that were used. */
  confidence: number;
};

const positive = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

function normalised(probs: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!probs) return undefined;
  let total = 0;
  for (const v of Object.values(probs)) total += positive(v);
  if (total <= 0) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(probs)) out[k] = positive(v) / total;
  return out;
}

/**
 * Combine the family and within-family verdicts into one probability per card: the marginal, summed over every family
 * that lists the card. A family whose verdict is missing or skipped contributes nothing to any card, and its share goes to
 * "none fits": never a list built on an answer nobody gave. The result is NOT floored on confidence: how unsure the family
 * read is shows in how the mass is spread, and the list is built by share (paper 7.1).
 */
export function jointProbabilities(
  verdicts: readonly JevVerdict[],
  families: readonly Family[],
): Joint {
  const byId = new Map(verdicts.map((v) => [v.questionId, v]));
  const flat = byId.get(FLAT_QUESTION_ID);
  if (flat) {
    // One question over every card: the answer IS the ranking. A card id nobody listed is dropped when the listing is known.
    const p = !flat.skipped ? normalised(flat.probs) : undefined;
    if (!p) return { probs: new Map(), noneFits: 1, complete: false, confidence: 0 };
    const known = new Set(families.flatMap((f) => f.memberIds));
    const probs = new Map<string, number>();
    for (const [id, x] of Object.entries(p)) {
      if (id !== NONE_KEY && x > 0 && (known.size === 0 || known.has(id))) probs.set(id, x);
    }
    return { probs, noneFits: p[NONE_KEY] ?? 0, complete: true, confidence: flat.confidence };
  }
  const fam = byId.get(FAMILY_QUESTION_ID);
  const famProbs = fam && !fam.skipped ? normalised(fam.probs) : undefined;
  const probs = new Map<string, number>();
  if (!famProbs) return { probs, noneFits: 1, complete: false, confidence: 0 };

  let noneFits = positive(famProbs[NONE_KEY]);
  let complete = true;
  let confidence = fam!.confidence;
  for (const f of families) {
    const pFamily = positive(famProbs[f.id]);
    if (pFamily === 0) continue;
    const v = byId.get(`${MEMBER_QUESTION_PREFIX}${f.id}`);
    const inProbs = v && !v.skipped ? normalised(v.probs) : undefined;
    if (!inProbs) {
      complete = false;
      noneFits += pFamily;
      continue;
    }
    confidence = Math.min(confidence, v!.confidence);
    noneFits += pFamily * positive(inProbs[NONE_KEY]);
    for (const id of f.memberIds) {
      const p = pFamily * positive(inProbs[id]);
      if (p > 0) probs.set(id, (probs.get(id) ?? 0) + p);
    }
  }
  return { probs, noneFits, complete, confidence };
}

// ─── calibration ────────────────────────────────────────────────────────────────────────────────

/** A monotone map from the probability Jev gave to how often it turned out right. Empty = identity. */
export type CalibrationMap = readonly { p: number; mapped: number }[];

export function calibrate(p: number, map: CalibrationMap | undefined): number {
  const x = Math.min(1, Math.max(0, p));
  if (!map || map.length === 0) return x;
  if (x <= map[0].p) return map[0].mapped;
  const last = map[map.length - 1];
  if (x >= last.p) return last.mapped;
  for (let i = 1; i < map.length; i++) {
    if (x <= map[i].p) {
      const a = map[i - 1];
      const b = map[i];
      return b.p === a.p ? b.mapped : a.mapped + ((b.mapped - a.mapped) * (x - a.p)) / (b.p - a.p);
    }
  }
  return x;
}

/**
 * Fit the map from (probability, was it used) pairs: equal-width bins, then pool adjacent violators so the
 * map never decreases. "0.6" keeps its meaning while the cards change (P§7.4).
 */
export function fitCalibration(
  pairs: readonly { p: number; hit: boolean }[],
  bins = 10,
): CalibrationMap {
  if (pairs.length === 0) return [];
  const acc = Array.from({ length: bins }, () => ({ n: 0, hits: 0, sumP: 0 }));
  for (const { p, hit } of pairs) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, p)) * bins)));
    acc[b].n += 1;
    acc[b].hits += hit ? 1 : 0;
    acc[b].sumP += p;
  }
  const blocks = acc
    .filter((a) => a.n > 0)
    .map((a) => ({ n: a.n, hits: a.hits, sumP: a.sumP, count: 1 }));
  // Pool adjacent violators on the hit rate.
  const stack: typeof blocks = [];
  for (const b of blocks) {
    stack.push(b);
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      const prev = stack[stack.length - 2];
      if (prev.hits / prev.n <= top.hits / top.n) break;
      stack.splice(stack.length - 2, 2, {
        n: prev.n + top.n,
        hits: prev.hits + top.hits,
        sumP: prev.sumP + top.sumP,
        count: prev.count + top.count,
      });
    }
  }
  return stack.map((b) => ({ p: b.sumP / b.n, mapped: b.hits / b.n }));
}

// ─── the short list ─────────────────────────────────────────────────────────────────────────────

export type ShortlistOptions = {
  share?: number;
  max?: number;
  calibration?: CalibrationMap;
  source?: "jev" | "local";
};

/**
 * The shortest run of entries that together hold `share` of the probability, at most `max`, in order. "None
 * of these fits" is one of the options being ranked: when it leads, the list is not shown; when it appears
 * lower down, the list is cut where it appears.
 */
export function buildShortlist(
  joint: Pick<Joint, "probs" | "noneFits">,
  o: ShortlistOptions = {},
): Shortlist {
  const share = o.share ?? SHORTLIST_SHARE;
  const max = o.max ?? SHORTLIST_MAX;
  const source = o.source ?? "jev";
  const ranked: Array<{ id: string; p: number }> = [{ id: NONE_KEY, p: joint.noneFits }];
  for (const [id, p] of joint.probs) ranked.push({ id, p });
  ranked.sort(
    (a, b) => b.p - a.p || (a.id === NONE_KEY ? -1 : b.id === NONE_KEY ? 1 : a.id < b.id ? -1 : 1),
  );
  const total = ranked.reduce((s, r) => s + r.p, 0);

  const base = { noneFitsProb: total > 0 ? joint.noneFits / total : 1, source };
  if (total <= 0 || ranked.length === 1)
    return { ...base, entries: [], shown: false, reason: "empty" };
  if (ranked[0].id === NONE_KEY)
    return { ...base, entries: [], shown: false, reason: "none-leads" };

  const entries: ShortlistEntry[] = [];
  let cumulative = 0;
  for (const r of ranked) {
    if (r.id === NONE_KEY) break;
    if (entries.length >= max) break;
    entries.push({
      cardId: r.id,
      rank: entries.length + 1,
      prob: calibrate(r.p / total, o.calibration),
    });
    cumulative += r.p / total;
    if (cumulative >= share) break;
  }
  return {
    ...base,
    entries,
    shown: entries.length > 0,
    reason: entries.length > 0 ? "shown" : "empty",
  };
}

/** The top two both cover part of the task: the list says they fit together (P§7.2). */
export function withFits(list: Shortlist, fits: ReadonlyMap<string, Answered<FitKind>>): Shortlist {
  const entries = list.entries.map((e) => ({
    ...e,
    ...(fits.has(e.cardId) ? { fit: fits.get(e.cardId) } : {}),
  }));
  const [a, b] = entries;
  const together =
    a && b && a.fit?.value === "covers-part" && b.fit?.value === "covers-part"
      ? ([a.cardId, b.cardId] as [string, string])
      : undefined;
  return { ...list, entries, ...(together ? { together } : {}) };
}

/** A list Jev was never asked for: private source, no key, or Jev silent. Nothing is shown. */
export const notAsked = (source: "jev" | "local" = "local"): Shortlist => ({
  entries: [],
  noneFitsProb: 1,
  shown: false,
  reason: "not-asked",
  source,
});

// ─── local matching (private sources; Jev down) ─────────────────────────────────────────────────

const STOP = new Set(
  (
    "a an and are as at be by for from how i in is it of on or that the this to was with you your please can could would should do does not no " +
    "what when where which who whom whose why there here about into over under after before then than too very just also some any all each other " +
    "more most such only own same so out up down off again further once both few have has had been being were will shall may might must its my me we our they them their he she him her"
  ).split(" "),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** A registry smaller than this is weighed as if it had this many entries, so a rare word is not worth nothing in a tiny one. */
export const IDF_FLOOR_CORPUS = 50;

/**
 * Word matching of the request against each card's text, weighted by how rare a word is across the cards
 * (inverse document frequency). Weaker than Jev, on purpose: it is what private tasks get. `overlap` is how many
 * distinct request words the card shares; one shared word is a coincidence, not a match.
 */
export function localRank(
  text: string,
  cards: readonly EnhancementCard[],
): Array<{ cardId: string; score: number; overlap: number }> {
  const query = new Set(tokens(text));
  if (query.size === 0 || cards.length === 0) return [];
  const docs = cards
    .filter((c) => c.status === "active")
    .map((c) => ({ id: c.id, words: new Set(tokens(`${c.name} ${cardText(c)}`)) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.words) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(docs.length, IDF_FLOOR_CORPUS);
  return docs
    .map((d) => {
      let score = 0;
      let overlap = 0;
      for (const w of query) {
        if (!d.words.has(w)) continue;
        score += Math.log(1 + n / (df.get(w) ?? 1));
        overlap += 1;
      }
      return { cardId: d.id, score, overlap };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.cardId < b.cardId ? -1 : 1));
}

/**
 * A short list from local matching. Scores become probabilities by a softmax against a "none of these fits"
 * baseline, so a flat set of weak matches (a few generic words shared with many cards) loses to "none" and no list
 * is shown, while one clear match takes almost all the probability and is listed alone. An entry needs at least
 * `minScore` to be a candidate at all.
 */
export function localShortlist(
  text: string,
  cards: readonly EnhancementCard[],
  o: { minScore?: number; minOverlap?: number; max?: number; noneScore?: number } = {},
): Shortlist {
  const minScore = o.minScore ?? 2;
  const minOverlap = o.minOverlap ?? 2;
  const ranked = localRank(text, cards).filter(
    (r) => r.score >= minScore && r.overlap >= minOverlap,
  );
  if (ranked.length === 0) return { ...notAsked("local"), reason: "empty" };
  const noneScore = o.noneScore ?? minScore * 2;
  const peak = Math.max(noneScore, ranked[0].score);
  const probs = new Map(ranked.map((r) => [r.cardId, Math.exp(r.score - peak)]));
  return buildShortlist(
    { probs, noneFits: Math.exp(noneScore - peak) },
    { source: "local", max: o.max },
  );
}
