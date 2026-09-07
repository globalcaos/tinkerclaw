/**
 * ENGRAM Phase 1.2: Retrieval pack assembly.
 *
 * Assembles a token-bounded string of relevant past events for injection
 * into the system prompt. Pipeline:
 *   FTS search → task-conditioned scoring → MMR dedup → token-bounded format.
 */

import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { estimateTokens } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import type { MemoryEvent } from "./event-types.js";
import { ftsSearch, type SearchFilters, type SearchResult } from "./search-index.js";
import { taskConditionedScore } from "./task-conditioned-scoring.js";
import { createDefaultTaskState } from "./task-state.js";

/** Default token budget for a retrieval pack (fits comfortably in system prompt). */
export const DEFAULT_RETRIEVAL_MAX_TOKENS = 4096;

/** MMR diversity weight: higher = more relevance-focused, lower = more diverse. */
const MMR_LAMBDA = 0.7;

/** How many FTS candidates to pull before scoring + MMR. */
const FTS_TOP_N = 50;

/** Section header token cost. */
const HEADER_TEXT = "## Retrieved Context";

// FORK 2026-09-03 — chunking parameters for `assembleRetrievalPackAsync`.
//
// The corpus scan inside `ftsSearch` is the ONLY unbounded per-event loop in this
// pipeline; every later stage is bounded by FTS_TOP_N (50) candidates. So the scan is the
// one that has to be cut into slices short enough that the gateway stays responsive.

/** Upper bound on how many events one synchronous scan slice may cover. */
const FTS_MAX_CHUNK_EVENTS = 200;
/** Floor, so a pathologically expensive corpus cannot degrade to one event per tick. */
const FTS_MIN_CHUNK_EVENTS = 16;
/** Target ceiling for a single synchronous stretch, in ms. The chunk size adapts to it. */
const MAX_SYNC_SLICE_MS = 50;

export interface AssembleOptions {
  /** Token budget for the assembled pack. Defaults to DEFAULT_RETRIEVAL_MAX_TOKENS. */
  maxTokens?: number;
  /** If set, filters to events from this task and applies task-conditioned scoring. */
  taskId?: string;
}

/**
 * The comparable word set of a piece of content: lowercased, whitespace-split,
 * words of 3+ characters.
 *
 * FORK 2026-08-19 — SPLIT OUT OF `wordJaccard` SO IT CAN BE BUILT ONCE PER CANDIDATE.
 * This used to live inside `wordJaccard`, which meant both operands were re-tokenised
 * on every single comparison. MMR over the default 50 candidates makes
 * Sum_{k=0..49} (50-k)*k = 20,825 comparisons, i.e. **41,650 set constructions from
 * full event text, for 50 distinct events**. Measured at 99.3% of the entire retrieval
 * pack build, which is itself the largest stage of a turn's pre-prompt wait.
 */
function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Word-level Jaccard similarity between two pre-built word sets.
 * Used for MMR redundancy estimation (faster than embedding cosine for this scale).
 *
 * Iterates the SMALLER set: the intersection count is symmetric, so this is the same
 * number with fewer hash probes.
 */
function jaccardOfSets(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const w of small) {
    if (large.has(w)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ScoredEvent {
  event: MemoryEvent;
  score: number;
}

/**
 * Maximal Marginal Relevance reranking (λ=0.7 by default).
 * Iteratively selects the candidate that best balances relevance against
 * redundancy with already-selected items.
 *
 * MMR(i) = λ · relevance(i) - (1-λ) · max_j∈S similarity(i, j)
 *
 * EXPORTED FOR TESTING ONLY (FORK 2026-08-19). `retrieval-integration.test.ts` pins it
 * against a naive reference implementation of the original algorithm — the optimisation
 * inside is an exact-equivalence claim, and an exact-equivalence claim needs a test that
 * can fail. Nothing in production imports it.
 */
export function mmrRerank(
  candidates: ScoredEvent[],
  lambda: number = MMR_LAMBDA,
  maxItems: number = FTS_TOP_N,
): ScoredEvent[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const selected: ScoredEvent[] = [];
  const remaining = [...candidates];
  // Both arrays are index-parallel to `remaining` and spliced with it, so index i
  // always describes the same candidate.
  //   remainingWords[i] — built exactly once per candidate (see `contentWords`).
  //   maxSimToSelected[i] — RUNNING max of sim(i, s) over every already-selected s.
  //
  // The running max is what makes this O(n^2) instead of O(n^2 * k). The original
  // recomputed `max over selected` from scratch inside the candidate loop, so the
  // similarity was evaluated Sum_{k=0..n-1} (n-k)*k times — 20,825 for n=50. Folding
  // each newly-selected item into the running max instead evaluates it n(n-1)/2 = 1,225
  // times. The value is identical: max is order-independent, and both start at 0.
  const remainingWords = remaining.map((c) => contentWords(c.event.content));
  const maxSimToSelected: number[] = new Array<number>(remaining.length).fill(0);

  while (remaining.length > 0 && selected.length < maxItems) {
    let bestScore = -Infinity;
    let bestIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      const mmr = lambda * remaining[i].score - (1 - lambda) * maxSimToSelected[i];
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    const chosenWords = remainingWords[bestIdx];
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
    remainingWords.splice(bestIdx, 1);
    maxSimToSelected.splice(bestIdx, 1);

    // Fold the just-selected item into every survivor's running max.
    for (let i = 0; i < remaining.length; i++) {
      const sim = jaccardOfSets(remainingWords[i], chosenWords);
      if (sim > maxSimToSelected[i]) {
        maxSimToSelected[i] = sim;
      }
    }
  }

  return selected;
}

/**
 * Format a single memory event as a compact, readable line.
 * Truncates long content to keep token cost predictable.
 */
function formatEvent(event: MemoryEvent): string {
  const ts = event.timestamp.slice(0, 19); // "2024-01-01T12:00:00" without ms/tz
  const preview = event.content.length > 300 ? `${event.content.slice(0, 300)}…` : event.content;
  return `[${ts}] [${event.kind}] ${preview}`;
}

/**
 * Stages 2-4: task-conditioned scoring, sort, MMR rerank.
 *
 * Extracted so the synchronous and the yielding assembler share ONE copy of the ranking
 * rules. A second copy is exactly how the vendored ENGRAM twin drifted for four months
 * (see src/plugin-sdk/memory-engram.ts).
 */
function rankCandidates(ftsResults: SearchResult[], taskId: string | undefined): ScoredEvent[] {
  // Task-conditioned scoring — amplify / discount by task context.
  const taskState = createDefaultTaskState(taskId ?? "default");
  const scored: ScoredEvent[] = ftsResults.map((r) => ({
    event: r.event,
    score: taskConditionedScore(r.event, r.score, taskState),
  }));
  // Sort by score descending before MMR so the greedy first pick is best.
  scored.sort((a, b) => b.score - a.score);
  // MMR deduplication — diversity-aware reranking (λ=0.7).
  return mmrRerank(scored);
}

/** Stage 5: token-bounded assembly. Shared by both assemblers, for the same reason. */
function formatPack(reranked: ScoredEvent[], maxTokens: number): string {
  const headerTokens = estimateTokens(`${HEADER_TEXT}\n`);
  if (headerTokens >= maxTokens) {
    return "";
  }

  const lines: string[] = [HEADER_TEXT];
  let tokensUsed = headerTokens;

  for (const { event } of reranked) {
    const line = formatEvent(event);
    const lineTokens = estimateTokens(`${line}\n`);
    if (tokensUsed + lineTokens > maxTokens) {
      break;
    }
    lines.push(line);
    tokensUsed += lineTokens;
  }

  // If only the header was added, return empty (nothing useful to inject)
  if (lines.length === 1) {
    return "";
  }

  return lines.join("\n");
}

/**
 * Assemble a retrieval pack: a token-bounded, relevance-ranked, deduplicated
 * string of past events ready for system prompt injection.
 *
 * Returns an empty string when the store is empty or no FTS matches exist.
 *
 * SYNCHRONOUS ON PURPOSE — still the right shape for callers that are not on the
 * gateway's event loop; `PushPackFn` in src/agents/pi-extensions/retrieval-runtime.ts is
 * typed `=> string`, so making this async would inject `[object Promise]` there. Anything
 * running INSIDE the gateway must call `assembleRetrievalPackAsync` instead.
 *
 * @param query   - The current user message or turn query.
 * @param eventStore - The ENGRAM event store for this session.
 * @param options - Optional token budget and task context.
 */
export function assembleRetrievalPack(
  query: string,
  eventStore: EventStore,
  options?: AssembleOptions,
): string {
  const maxTokens = options?.maxTokens ?? DEFAULT_RETRIEVAL_MAX_TOKENS;
  const taskId = options?.taskId;

  // Fast-path: nothing to retrieve
  if (eventStore.count() === 0) {
    return "";
  }

  // 1. FTS search — pull candidate events
  const ftsResults = ftsSearch(eventStore, query, FTS_TOP_N, taskId ? { taskId } : undefined);
  if (ftsResults.length === 0) {
    return "";
  }

  // 2-4. score, sort, MMR.  5. token-bounded assembly.
  return formatPack(rankCandidates(ftsResults, taskId), maxTokens);
}

/**
 * A read-only `EventStore` view over a fixed slice of events.
 *
 * `ftsSearch` reads the corpus exclusively through `readAll()`, so scanning a slice
 * through this view runs the REAL scorer over a subset. That is the whole reason it
 * exists: the alternative — re-implementing the TF/position scoring loop here so it could
 * be interrupted — would put a second copy of the ranking rules in the tree, which is the
 * failure this library was consolidated to end.
 *
 * The mutating members throw rather than delegate. A view handed to a scan has no business
 * appending, and a silent delegation would write to the base store's real file.
 */
function sliceView(base: EventStore, events: MemoryEvent[]): EventStore {
  const readOnly = (): never => {
    throw new Error("engram: retrieval slice view is read-only");
  };
  return {
    filePath: base.filePath,
    sessionKey: base.sessionKey,
    append: readOnly,
    appendRaw: readOnly,
    readAll: () => events,
    readByKind: (kind) => events.filter((e) => e.kind === kind),
    readRange: (startTurnId, endTurnId) =>
      events.filter((e) => e.turnId >= startTurnId && e.turnId <= endTurnId),
    readById: (id) => events.find((e) => e.id === id),
    count: () => events.length,
  };
}

/**
 * `ftsSearch` over the corpus in slices, handing the event loop back between them.
 *
 * EXACT-EQUIVALENCE CLAIM, not an approximation:
 *   - an event's FTS score depends only on (its own content, the query terms) — nothing in
 *     `ftsSearch` is cross-event — so scoring a partition and concatenating yields the same
 *     multiset of hits;
 *   - the per-slice `topN` is deliberately unbounded (`Number.MAX_SAFE_INTEGER`), so no hit
 *     is dropped before the global sort;
 *   - slices are concatenated in corpus order and `Array#sort` is stable, so tied scores end
 *     up in the same corpus order the single-pass version produces;
 *   - `applyFilters` is a per-event predicate, so filtering slices == filtering the whole.
 * Pinned by a byte-identity test, not by this paragraph.
 */
async function ftsSearchChunked(
  store: EventStore,
  query: string,
  topN: number,
  filters: SearchFilters | undefined,
): Promise<SearchResult[]> {
  const events = store.readAll();
  if (events.length <= FTS_MAX_CHUNK_EVENTS) {
    // Small corpus: one slice is already inside the budget, and routing it through the view
    // would only add allocations.
    return ftsSearch(store, query, topN, filters);
  }

  const merged: SearchResult[] = [];
  let chunkSize = FTS_MAX_CHUNK_EVENTS;
  let index = 0;

  while (index < events.length) {
    const end = Math.min(index + chunkSize, events.length);
    const startedAt = Date.now();
    const hits = ftsSearch(
      sliceView(store, events.slice(index, end)),
      query,
      Number.MAX_SAFE_INTEGER,
      filters,
    );
    // Deliberately a loop, not `push(...hits)` — a spread of a large array becomes an
    // argument list and blows the stack on a corpus where every event matches.
    for (const hit of hits) {
      merged.push(hit);
    }
    const tookMs = Date.now() - startedAt;
    index = end;

    if (index < events.length) {
      await yieldToEventLoop();
      // Adapt to the corpus actually in front of us. On the architect's live store a
      // 200-event slice of ~5KB events against a 1,300-term query is hundreds of ms, while
      // 200 short events are sub-millisecond. A fixed size is wrong for one of those two, so
      // measure and halve/double. `chunkSize` never drops below FTS_MIN_CHUNK_EVENTS, so
      // `end > index` always holds and the loop cannot stall.
      if (tookMs > MAX_SYNC_SLICE_MS && chunkSize > FTS_MIN_CHUNK_EVENTS) {
        chunkSize = Math.max(FTS_MIN_CHUNK_EVENTS, Math.floor(chunkSize / 2));
      } else if (tookMs * 4 < MAX_SYNC_SLICE_MS && chunkSize < FTS_MAX_CHUNK_EVENTS) {
        chunkSize = Math.min(FTS_MAX_CHUNK_EVENTS, chunkSize * 2);
      }
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, topN);
}

/**
 * The yielding twin of {@link assembleRetrievalPack}: identical output, but it never holds
 * the event loop for more than ~{@link MAX_SYNC_SLICE_MS}.
 *
 * PURPOSE. `assembleRetrievalPack` returns a `string`, so `await`-ing it hands the loop
 * back exactly never. The gateway's `before_prompt_build` hook did precisely that, and the
 * journal shows the result: 13-28s in which nothing else logged, no timer fired, and every
 * connected client was frozen — for ONE session's first turn.
 *
 * INVARIANT. `assembleRetrievalPackAsync(q, s, o)` resolves to the same string
 * `assembleRetrievalPack(q, s, o)` returns, for every input. Pinned by a test rather than
 * by this sentence (extensions/tinkerclaw-total-recall/index.cold-pack.test.ts).
 *
 * ALTERNATIVES REJECTED.
 *   - Make `assembleRetrievalPack` itself async: it has a synchronous caller whose type says
 *     `=> string` (`PushPackFn`), which would then inject `[object Promise]`.
 *   - A worker thread: the corpus is already parsed in this process; posting ~20MB of events
 *     across a port costs more than the search it would move.
 *   - Cap the corpus instead: that changes WHAT is retrieved, invisibly, and the cap has to
 *     keep shrinking as the store grows.
 */
export async function assembleRetrievalPackAsync(
  query: string,
  eventStore: EventStore,
  options?: AssembleOptions,
): Promise<string> {
  const maxTokens = options?.maxTokens ?? DEFAULT_RETRIEVAL_MAX_TOKENS;
  const taskId = options?.taskId;

  // Fast-path: nothing to retrieve
  if (eventStore.count() === 0) {
    return "";
  }

  // 1. FTS search — the only unbounded per-event loop, so the only one chunked.
  const ftsResults = await ftsSearchChunked(
    eventStore,
    query,
    FTS_TOP_N,
    taskId ? { taskId } : undefined,
  );
  if (ftsResults.length === 0) {
    return "";
  }
  await yieldToEventLoop();

  // 2-4. Scoring, sort and MMR are all bounded by FTS_TOP_N (50) candidates, so they get a
  // yield AROUND them rather than inside them.
  const reranked = rankCandidates(ftsResults, taskId);
  await yieldToEventLoop();

  // 5. Token-bounded assembly — at most 50 iterations of a 300-char format.
  return formatPack(reranked, maxTokens);
}
