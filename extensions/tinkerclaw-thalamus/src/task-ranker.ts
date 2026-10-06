// The one ranker both readers share (Broca retrieval v2, phase E).
//
// WHAT THIS IS FOR. At the start of an interactive task: decide whether the prompt is owed a recommendation at all, pick
// the text to rank (a context-free follow-up borrows the turn before it), recall up to 15 candidates from the catalogue,
// have Jev split them into USE and INSPIRE with the part to take (one request, privacy gate and budget as every other
// read), cap the lists, and hand the result to whoever asks. The short-list seam and Broca's matcher hook reach it through
// `requestTaskRanking`, which runs it once per run.
//
// IT NEVER FORCES ANYTHING. The ranking is advice; the agent decides what to use.

import { readFileSync } from "node:fs";
import {
  capResult,
  createRecall,
  docsFromCards,
  localShortlist,
  rankItems,
  rankTextFor,
  recommendable,
  type EnhancementCard,
  type HistoryItem,
  type RecallDoc,
  type TaskRankInput,
  type TaskRanking,
} from "openclaw/plugin-sdk/fork-thalamus";
import { sourceOfSessionKey } from "./context-view.js";
import type { RoutingReader } from "./reads/routing-reader.js";

/** A card file larger than this is read for its headings only up to here; a catalogue entry never needs more. */
const MAX_CARD_BYTES = 60_000;

export type TaskRankerDeps = {
  reader: RoutingReader;
  cards: () => readonly EnhancementCard[];
  /** The text of a card's file, or undefined when it cannot be read. Injected so tests need no disk. */
  readCard?: (path: string) => string | undefined;
  /** Earlier requests with the cards used on them (the replay set joined to the uses). */
  history: () => readonly HistoryItem[];
  /** Cards this chat used in earlier turns, newest first. */
  recent: (sessionKey: string) => readonly string[];
  budgetMs: () => number;
  now: () => number;
};

/** The text of a card's file, bounded; undefined when it cannot be read (a plugin card points at a folder). */
export const readCardFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").slice(0, MAX_CARD_BYTES);
  } catch {
    return undefined;
  }
};

export function createTaskRanker(d: TaskRankerDeps) {
  const read = d.readCard ?? readCardFile;
  let built:
    | { sig: string; docs: Map<string, RecallDoc>; recall: ReturnType<typeof createRecall> }
    | undefined;

  /** The catalogue, rebuilt only when a card is added, removed or reworded. */
  const catalogue = () => {
    const cards = d.cards();
    const sig = cards.map((c) => `${c.id}@${c.version}`).join("|");
    if (built?.sig === sig) return built;
    const list = docsFromCards(cards, read);
    const docs = new Map<string, RecallDoc>(list.map((d) => [d.id, d]));
    built = { sig, docs, recall: createRecall(list) };
    return built;
  };

  return async function rank(input: TaskRankInput): Promise<TaskRanking> {
    const gate = recommendable({
      text: input.text,
      sessionKey: input.sessionKey,
      trigger: input.trigger,
      provenanceKind: input.provenanceKind,
    });
    if (!gate.ok) return { ranked: false, runId: input.runId, why: gate.why };

    const cat = catalogue();
    const lower = (s: string): string => s.toLowerCase();
    const namesCard = (cleaned: string): boolean => {
      const t = lower(cleaned);
      return [...cat.docs.values()].some(
        (doc) => doc.slug.length >= 4 && t.includes(lower(doc.slug)),
      );
    };
    const text = rankTextFor(input.text, input.previousUserText, namesCard);
    if ("skip" in text) return { ranked: false, runId: input.runId, why: text.skip };

    const candidates = cat.recall.recall({
      text: text.text,
      history: d.history(),
      recent: d.recent(input.sessionKey),
    });
    const items = rankItems(candidates, cat.docs);
    if (items.length === 0) return { ranked: false, runId: input.runId, why: "no-candidates" };

    const result = await d.reader.rankCandidates(
      {
        id: input.runId,
        ts: d.now(),
        sessionKey: input.sessionKey,
        text: text.text,
        source: sourceOfSessionKey(input.sessionKey),
        ...(input.trigger ? { trigger: input.trigger } : {}),
      },
      items,
      { budgetMs: d.budgetMs() },
    );
    // Jev judged none of it (off, private, late, no key) and what is left is recall's order. In the replay 69% of interactive
    // requests use no card at all, and recall's top three were shown for every one of them, so that order is shown only where the
    // old local list (thresholds, and "none of these" as a rival) would show something too. Otherwise each reader does as before.
    if (result.source === "local" && !localShortlist(text.text, d.cards()).shown)
      return { ranked: false, runId: input.runId, why: "local-quiet" };
    return { ranked: true, runId: input.runId, basis: text.basis, result: capResult(result) };
  };
}

export type TaskRank = ReturnType<typeof createTaskRanker>;
