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
import { ftsSearchOffThread } from "./fts-worker-client.js";
import { beginFtsScan, ftsSearch, type SearchFilters, type SearchResult } from "./search-index.js";
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

/** A corpus this small is scanned in one synchronous go — it fits the slice budget anyway. */
const FTS_SINGLE_SLICE_MAX_EVENTS = 200;
/** Ceiling for a single synchronous stretch of the scan, in ms (checked per event). */
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
 * `ftsSearch` in time slices, handing the event loop back between them.
 *
 * FORK 2026-09-23 (plan task 14) — it drives the same resumable, trigram-prefiltered scan that
 * `ftsSearch` runs in one go (`beginFtsScan`), pausing whenever a slice has held the loop for
 * `maxSliceMs`. It used to call `ftsSearch` on a read-only view per slice of events, halving
 * or doubling the slice size after measuring the last one. The index now lives per store, so a
 * view per slice would have built a throwaway index per slice; and a time check per event
 * bounds a slice directly instead of correcting it one slice late.
 *
 * EXACT-EQUIVALENCE CLAIM: pausing only returns control between two events (or two index
 * appends); the scan visits the same events in the same order either way, and re-verifies the
 * shared index against its own snapshot when it resumes. So the hits, scores and stable tie
 * order are those of `ftsSearch`, which is itself pinned to the linear oracle. Pinned by
 * search-index.prefilter-parity.test.ts, not by this paragraph.
 *
 * EXPORTED FOR TESTING (`maxSliceMs` = 0 pauses after every event); production passes nothing.
 */
export async function ftsSearchChunked(
  store: EventStore,
  query: string,
  topN: number,
  filters: SearchFilters | undefined,
  maxSliceMs: number = MAX_SYNC_SLICE_MS,
): Promise<SearchResult[]> {
  if (store.count() <= FTS_SINGLE_SLICE_MAX_EVENTS) {
    return ftsSearch(store, query, topN, filters);
  }
  const scan = beginFtsScan(store, query, filters);
  if (!scan) {
    return [];
  }
  for (;;) {
    const deadline = performance.now() + maxSliceMs;
    if (scan.step(() => performance.now() >= deadline)) {
      return scan.results(topN);
    }
    await yieldToEventLoop();
  }
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
 * FORK 2026-09-23 (plan task 16) — THE FTS NOW RUNS IN A WORKER THREAD when it can, via
 * `ftsSearchOffThread` (fts-worker-client.ts): the worker reads the store's own file and keeps it
 * parsed, so no events cross the port, and it answers only for the exact snapshot this thread
 * holds. Otherwise — the `OPENCLAW_TOTAL_RECALL_FTS_WORKER=0` kill switch, or any worker failure —
 * the scan runs here in slices, as before. Either way the same `ftsSearch` scoring code runs over
 * the same events, so the invariant below still holds. Everything after the FTS stays here.
 *
 * ALTERNATIVES REJECTED.
 *   - Make `assembleRetrievalPack` itself async: it has a synchronous caller whose type says
 *     `=> string` (`PushPackFn`), which would then inject `[object Promise]`.
 *   - Post the parsed events to a worker: ~70M chars for cc-experience, per search. (The worker
 *     that shipped reads the file itself instead.)
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
  const eventCount = eventStore.count();
  if (eventCount === 0) {
    return "";
  }

  // 1. FTS search — the only unbounded per-event loop. In the worker thread when it can answer
  // for this snapshot (plan task 16); otherwise here, in time slices. A corpus small enough for
  // one slice is not worth the round trip.
  const filters = taskId ? { taskId } : undefined;
  const offThread =
    eventCount > FTS_SINGLE_SLICE_MAX_EVENTS
      ? await ftsSearchOffThread(eventStore, query, FTS_TOP_N, filters)
      : undefined;
  const ftsResults = offThread ?? (await ftsSearchChunked(eventStore, query, FTS_TOP_N, filters));
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
