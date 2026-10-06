// The ranking stage: which of the recalled candidates to USE, which to take INSPIRATION from, and from which part
// (Broca retrieval v2, phase C).
//
// WHAT THIS IS FOR. Recall (enhancement-recall.ts) casts a wide net of up to fifteen cards. Jev reads the task and says,
// for each, whether the agent would use it as it stands, take inspiration from one part of it, or has no use for it.
// This file builds those questions, checks every answer against the finite set Jev was offered, and turns the answers
// into two sorted groups. It calls nothing: the caller asks Jev (RoutingReader.rankCandidates does) and hands back the
// verdicts, so the whole stage is testable without a network.
//
// WHAT JEV CAN DO. Choice, score and none verdicts only (charter correction 3). So there is no free text: the mode is one
// of USE / INSPIRE / NO, and the part is one of the candidate's real section ids (`s1`..`sN`, mapped here to the real
// section titles) or "none". An answer outside those sets is invalid and is treated as no answer.
//
// WHAT "LOCAL" MEANS. An entry Jev did not answer validly keeps its recall position and is labelled `local`, with the
// mode recall can honestly claim (INSPIRE with its section when recall found it through a section, USE otherwise). A
// local entry is never presented as Jev's. When nothing was answered the whole list is local, and `skip` says why.
//
// HOW IT IS SORTED. Jev entries first, then local entries in recall order. In the USE group the sort key is the share
// Jev gave the candidate in ONE comparative question (the candidates compete for a single answer, "none fits" among
// them); when that answer is missing or malformed it is the probability of USE. The INSPIRE group sorts by the probability
// of INSPIRE: partial fits are not alternatives to each other, and the comparative question gives them about nothing
// to sort on (live sample, 2026-10-06: 0.00 to 0.01 for every one). Ties go to the mode probability, then to recall order. Why a comparative key: asked one by one, Jev says USE to anything plausibly related
// (live sample, 2026-10-06: an unrelated skill at 0.94, a supervisor recipe at 0.90 for a translation loop), while the
// comparative question kept the same cards at 0.02 and answered "none" at 1.00 for a prompt nothing fits. A candidate Jev
// answers NO is dropped from the lists and counted. House rules are not candidates here (recall already excludes
// them); they stay mandatory elsewhere.
//
// WHAT WOULD CHANGE IT. A live sample showing the 30-question request too slow (then: the comparative question plus a
// mode question for the top few only), or a replay in which this order loses to recall order.

import type { JevQuestion, JevVerdict } from "../infra/jev/types.js";
import type { Candidate, RecallDoc } from "./enhancement-recall.js";
import { questionVersionOf } from "./thalamus-enhancements.js";

export type RankMode = "USE" | "INSPIRE";
export type RankSource = "jev" | "local";
/** Why the list is not wholly Jev's. The first four are Jev's own skip reasons; `invalid` is an answer outside the set. */
export type SkipReason = "timeout" | "breaker-open" | "not-allowed" | "error" | "invalid";

/** One recalled candidate with the text Jev reads and the real sections it may point at. */
export type RankItem = {
  cardId: string;
  kind: RecallDoc["kind"];
  /** The catalogue text Jev reads (title and purpose), bounded. */
  text: string;
  /** Real section titles, bounded; `s1` is the first. */
  sections: string[];
  /** The section recall found the card through, when it did. */
  recallSection?: string;
};

export type RankedEntry = {
  cardId: string;
  source: RankSource;
  mode: RankMode;
  /** The part to take inspiration from, when there is one. */
  section?: string;
  /** Who chose the section. Absent when there is none. */
  sectionSource?: RankSource;
  /** The sort key: a USE entry's share of the comparative answer (the mode probability when there was none), an INSPIRE entry's probability of INSPIRE. 0 for a local entry. */
  score: number;
  /** The probability Jev gave the chosen mode; 0 for a local entry. */
  modeScore: number;
  /** Position in the recall order, 0-based. */
  recallRank: number;
};

export type RankResult = {
  use: RankedEntry[];
  inspire: RankedEntry[];
  /** `jev` when every kept entry is Jev's, `local` when none is, `mixed` otherwise. */
  source: "jev" | "mixed" | "local";
  /** Set whenever the list is not wholly Jev's. */
  skip?: SkipReason;
  /** Gate detail behind a `not-allowed` skip (`private-source`, `real-not-allowed`, `jev-off`, `no-key`). */
  skipDetail?: string;
  /** What the USE group's `score` is: the comparative share, or the mode probability when there was no usable comparative answer. INSPIRE entries always sort by the mode probability. Absent when Jev gave none. */
  useScoreBasis?: "comparative" | "mode";
  asked: number;
  /** Candidates whose mode answer was valid. */
  answered: number;
  /** Candidates Jev answered NO and that were left out. */
  dropped: number;
  /** Wall time of the Jev call; absent when none was made. */
  jevMs?: number;
};

export const MAX_CANDIDATES = 15;
export const MAX_SECTIONS = 8;
const TEXT_CHARS = 320;
const SECTION_CHARS = 80;

export const MODE_QUESTION_PREFIX = "rank-mode-";
export const PART_QUESTION_PREFIX = "rank-part-";
export const NO_PART = "none";
export const FLAT_RANK_QUESTION_ID = "rank-flat";
const flatKey = (i: number): string => `c${i + 1}`;

export type RankTemplate = {
  modeInstructions: string;
  partInstructions: string;
  flatInstructions: string;
  flatNoneText: string;
  modeOptions: Record<"USE" | "INSPIRE" | "NO", string>;
  noPartText: string;
};

export const DEFAULT_RANK_TEMPLATE: RankTemplate = {
  modeInstructions:
    "Read the request. An agent is about to do this task. The enhancement is: {card} " +
    "Would the agent USE it as it stands (the task is what it was made for), take INSPIRATION from one part of it " +
    "or from how it is built, for a task on a different subject, or has it NO use here?",
  partInstructions:
    "Read the request. The agent takes inspiration from this enhancement: {card} " +
    "Which one part of it helps most with this task?",
  flatInstructions:
    "Read the request. An agent is about to do this task. Which ONE of these enhancements would help it most? " +
    "Answer none if none of them fits.",
  flatNoneText: "None of these enhancements fits this task.",
  modeOptions: {
    USE: "The task is what this enhancement was made for; the agent would use it as it stands.",
    INSPIRE:
      "A different subject, but one part or the structure of this enhancement would help the task.",
    NO: "This enhancement does not help with this task.",
  },
  noPartText: "No single part helps more than the rest.",
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * The items Jev ranks, from recall's candidates and the catalogue. Sections are the card's real headings, bounded; the one
 * recall matched on is always among them so the local fallback can name it.
 */
export function rankItems(
  candidates: readonly Candidate[],
  docs: ReadonlyMap<string, RecallDoc>,
  max = MAX_CANDIDATES,
): RankItem[] {
  const out: RankItem[] = [];
  for (const c of candidates.slice(0, max)) {
    const doc = docs.get(c.cardId);
    if (!doc) continue;
    const titles = [
      ...new Set(doc.sections.map((s) => clip(s.trim(), SECTION_CHARS)).filter(Boolean)),
    ];
    const recallSection = c.section ? clip(c.section.trim(), SECTION_CHARS) : undefined;
    const ordered =
      recallSection && !titles.slice(0, MAX_SECTIONS).includes(recallSection)
        ? [recallSection, ...titles.filter((t) => t !== recallSection)]
        : titles;
    out.push({
      cardId: c.cardId,
      kind: doc.kind,
      text: clip([doc.title, doc.summary].filter(Boolean).join(": "), TEXT_CHARS),
      sections: ordered.slice(0, MAX_SECTIONS),
      ...(recallSection ? { recallSection } : {}),
    });
  }
  return out;
}

export type RankQuestions = {
  questions: JevQuestion[];
  /** For item i (0-based): the question ids and the section ids offered. */
  byItem: Array<{ mode: string; part?: string; sectionIds: string[] }>;
};

const sectionId = (k: number): string => `s${k + 1}`;

/**
 * One mode question per item, one part question for each item that has sections, and one comparative question over all
 * of them. All in one request.
 */
export function buildRankQuestions(
  items: readonly RankItem[],
  t: RankTemplate = DEFAULT_RANK_TEMPLATE,
): RankQuestions {
  const questions: JevQuestion[] = [];
  const byItem: RankQuestions["byItem"] = [];
  items.forEach((item, i) => {
    const n = i + 1;
    const modeCriteria: Record<string, string | null> = { ...t.modeOptions };
    const modeInstructions = t.modeInstructions.replace("{card}", item.text);
    const mode = `${MODE_QUESTION_PREFIX}${n}`;
    questions.push({
      id: mode,
      version: questionVersionOf(modeCriteria, modeInstructions),
      type: "choice",
      criteria: modeCriteria,
      instructions: modeInstructions,
      fields: ["request"],
    });
    const sectionIds = item.sections.map((_, k) => sectionId(k));
    let part: string | undefined;
    if (item.sections.length > 0) {
      const partCriteria: Record<string, string | null> = {};
      item.sections.forEach((title, k) => {
        partCriteria[sectionId(k)] = title;
      });
      partCriteria[NO_PART] = t.noPartText;
      const partInstructions = t.partInstructions.replace("{card}", item.text);
      part = `${PART_QUESTION_PREFIX}${n}`;
      questions.push({
        id: part,
        version: questionVersionOf(partCriteria, partInstructions),
        type: "choice",
        criteria: partCriteria,
        instructions: partInstructions,
        fields: ["request"],
      });
    }
    byItem.push({ mode, ...(part ? { part } : {}), sectionIds });
  });
  if (items.length > 0) {
    const criteria: Record<string, string | null> = {};
    items.forEach((item, i) => {
      criteria[flatKey(i)] = item.text;
    });
    criteria[NO_PART] = t.flatNoneText;
    questions.push({
      id: FLAT_RANK_QUESTION_ID,
      version: questionVersionOf(criteria, t.flatInstructions),
      type: "choice",
      criteria,
      instructions: t.flatInstructions,
      fields: ["request"],
    });
  }
  return { questions, byItem };
}

/** A verdict Jev answered: not skipped, a choice, with a string answer. */
const answered = (v: JevVerdict | undefined): v is JevVerdict =>
  v !== undefined && v.skipped === undefined && v.type === "choice" && typeof v.answer === "string";

const asMode = (s: string | undefined): RankMode | "NO" | undefined =>
  s === "USE" || s === "INSPIRE" || s === "NO" ? s : undefined;

const probOf = (v: JevVerdict, key: string): number => {
  const p = v.probs?.[key];
  if (typeof p === "number" && Number.isFinite(p) && p >= 0) return p;
  return v.answer === key && Number.isFinite(v.prob) ? v.prob : 0;
};

/** What recall alone can claim for an item: INSPIRE through its section when it was found through one, USE otherwise. */
function localEntry(item: RankItem, recallRank: number): RankedEntry {
  const section = item.recallSection;
  return {
    cardId: item.cardId,
    source: "local",
    mode: section ? "INSPIRE" : "USE",
    ...(section ? { section, sectionSource: "local" as const } : {}),
    score: 0,
    modeScore: 0,
    recallRank,
  };
}

const bySort = (a: RankedEntry, b: RankedEntry): number =>
  b.score - a.score || b.modeScore - a.modeScore || a.recallRank - b.recallRank;

/**
 * Each candidate's share of the comparative answer, or undefined when there is no usable one: missing, skipped, an answer
 * Jev was not offered, or a probability that is not a finite number. "None fits" leaves every candidate its own (small) share.
 */
function comparativeShares(
  items: readonly RankItem[],
  byId: ReadonlyMap<string, JevVerdict>,
): number[] | undefined {
  const v = byId.get(FLAT_RANK_QUESTION_ID);
  if (!answered(v) || !v.probs) return undefined;
  const keys = items.map((_, i) => flatKey(i));
  if (![...keys, NO_PART].includes(String(v.answer))) return undefined;
  const shares: number[] = [];
  for (const k of keys) {
    const p = v.probs[k];
    if (p === undefined) {
      shares.push(0);
    } else if (typeof p === "number" && Number.isFinite(p) && p >= 0) {
      shares.push(p);
    } else {
      return undefined;
    }
  }
  return shares;
}

function arrange(entries: RankedEntry[]): Pick<RankResult, "use" | "inspire" | "source"> {
  const group = (mode: RankMode) => {
    const of = entries.filter((e) => e.mode === mode);
    return [
      ...of.filter((e) => e.source === "jev").toSorted(bySort),
      ...of.filter((e) => e.source === "local").toSorted((a, b) => a.recallRank - b.recallRank),
    ];
  };
  const jev = entries.filter((e) => e.source === "jev").length;
  return {
    use: group("USE"),
    inspire: group("INSPIRE"),
    source: entries.length === 0 || jev === 0 ? "local" : jev === entries.length ? "jev" : "mixed",
  };
}

/** The list when Jev was not asked or gave nothing usable: recall order, every entry local. `skip` says why. */
export function localRanking(
  items: readonly RankItem[],
  skip: SkipReason,
  extra: { skipDetail?: string; jevMs?: number } = {},
): RankResult {
  const entries = items.map((it, i) => localEntry(it, i));
  return {
    ...arrange(entries),
    skip,
    ...(extra.skipDetail ? { skipDetail: extra.skipDetail } : {}),
    asked: 0,
    answered: 0,
    dropped: 0,
    ...(extra.jevMs !== undefined ? { jevMs: extra.jevMs } : {}),
  };
}

/** The reason to report when no answer was usable: the verdicts' own skip reason (the commonest), else `invalid`, else `error`. */
export function skipReasonOf(verdicts: readonly JevVerdict[]): SkipReason {
  if (verdicts.length === 0) return "error";
  const reasons = verdicts.map((v) => v.skipped).filter((s): s is NonNullable<typeof s> => !!s);
  if (reasons.length === 0) return "invalid";
  const count = new Map<string, number>();
  for (const r of reasons) count.set(r, (count.get(r) ?? 0) + 1);
  return [...count.entries()].toSorted((a, b) => b[1] - a[1])[0][0] as SkipReason;
}

/**
 * Turn Jev's verdicts into the two groups. Every answer is checked against the finite set it was offered: a mode must be
 * USE, INSPIRE or NO; a part must be one of the item's section ids or "none". An invalid or missing answer leaves that
 * candidate local, in recall order. Nothing Jev did not answer is ever labelled `jev`.
 */
export function interpretRanking(
  items: readonly RankItem[],
  built: RankQuestions,
  verdicts: readonly JevVerdict[],
  extra: { jevMs?: number } = {},
): RankResult {
  const byId = new Map(verdicts.map((v) => [v.questionId, v] as const));
  const shares = comparativeShares(items, byId);
  const entries: RankedEntry[] = [];
  let validModes = 0;
  let dropped = 0;
  let invalid = 0;
  items.forEach((item, i) => {
    const q = built.byItem[i];
    const mv = byId.get(q.mode);
    const mode = asMode(answered(mv) ? String(mv.answer) : undefined);
    if (mv && mode) {
      validModes += 1;
      if (mode === "NO") {
        dropped += 1;
        return;
      }
      const modeScore = probOf(mv, mode);
      const base = {
        cardId: item.cardId,
        source: "jev" as const,
        mode,
        score: shares && mode === "USE" ? shares[i] : modeScore,
        modeScore,
        recallRank: i,
      };
      if (mode === "USE") {
        entries.push(base);
        return;
      }
      // INSPIRE: a part among the real section ids, or none. A missing or invalid part keeps recall's own section, if any.
      const pv = q.part ? byId.get(q.part) : undefined;
      const part = answered(pv) ? String(pv.answer) : undefined;
      if (part !== undefined && q.sectionIds.includes(part)) {
        entries.push({
          ...base,
          section: item.sections[q.sectionIds.indexOf(part)],
          sectionSource: "jev",
        });
      } else {
        if (pv && answered(pv) && part !== NO_PART) invalid += 1;
        entries.push({
          ...base,
          ...(item.recallSection
            ? { section: item.recallSection, sectionSource: "local" as const }
            : {}),
        });
      }
      return;
    }
    if (answered(mv)) invalid += 1;
    entries.push(localEntry(item, i));
  });
  if (validModes === 0) {
    return localRanking(items, skipReasonOf(verdicts), {
      ...(extra.jevMs !== undefined ? { jevMs: extra.jevMs } : {}),
    });
  }
  const arranged = arrange(entries);
  // Nothing left after Jev said NO to every candidate is Jev's answer, not a fallback.
  if (entries.length === 0) arranged.source = "jev";
  const localLeft = entries.some((e) => e.source === "local");
  return {
    ...arranged,
    ...(localLeft || invalid > 0 ? { skip: "invalid" as const } : {}),
    useScoreBasis: shares ? ("comparative" as const) : ("mode" as const),
    asked: items.length,
    answered: validModes,
    dropped,
    ...(extra.jevMs !== undefined ? { jevMs: extra.jevMs } : {}),
  };
}

/** USE first, then INSPIRE: the one list a hit@k is scored on and a short note is written from. */
export const rankedList = (r: Pick<RankResult, "use" | "inspire">): RankedEntry[] => [
  ...r.use,
  ...r.inspire,
];
