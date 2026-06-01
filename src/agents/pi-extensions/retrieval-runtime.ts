/**
 * ENGRAM Phase 1.2: Retrieval pack runtime registry.
 *
 * Holds per-session retrieval dependencies keyed by SessionManager identity,
 * following the same WeakMap registry pattern as ingestion-runtime.ts.
 * Phase 1.2+ calls getRetrievalRuntime(sessionManager) to inject
 * the assembled retrieval pack into each agent turn.
 */

import {
  hasWriteIntent,
  findContradictions,
  formatContradictionWarnings,
} from "../../memory/engram/contradiction-gate.js";
import { loadTodayDailyLog } from "../../memory/engram/daily-log-cache.js";
import type { EmbeddingCache } from "../../memory/engram/embedding-cache.js";
import type { EmbedFn } from "../../memory/engram/embedding-worker.js";
import { extractEntities, entitiesToQueries } from "../../memory/engram/entity-extraction.js";
import type { EventStore } from "../../memory/engram/event-store.js";
import { estimateTokens } from "../../memory/engram/event-store.js";
import { globalFtsMultiSearch } from "../../memory/engram/global-fts-bridge.js";
import { parseMentions } from "../../memory/engram/mention-parser.js";
import type { SearchResult, SearchFilters } from "../../memory/engram/search-index.js";
import { ftsSearch, vectorSearch } from "../../memory/engram/search-index.js";
import type { MMRItem } from "../../memory/mmr.js";
import { mmrRerank } from "../../memory/mmr.js";
import type { LinkBuilder } from "./link-builder-runtime.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

/**
 * Optional FTS search override — defaults to ftsSearch from search-index.
 * Provided as a field to enable clean injection in tests.
 */
export type SearchIndexFn = (
  store: EventStore,
  query: string,
  topN?: number,
  filters?: SearchFilters,
) => SearchResult[];

/**
 * Optional pack assembly override — defaults to assembleRetrievalPack
 * from retrieval-integration. Provided to enable clean test injection.
 */
export type PushPackFn = (
  query: string,
  store: EventStore,
  opts?: { maxTokens?: number; taskId?: string },
) => string;

export interface RetrievalRuntime {
  /** Live event store for this session. */
  eventStore: EventStore;
  /** Optional FTS search override; falls back to module-level ftsSearch. */
  searchIndex?: SearchIndexFn;
  /** Optional pack assembly override; falls back to assembleRetrievalPack. */
  pushPack?: PushPackFn;
  /** FORK: Embedding cache for vector search (Phase 2). */
  embeddingCache?: EmbeddingCache;
  /** FORK: Embedding function for vector search queries. */
  embedFn?: EmbedFn;
  /**
   * U9: Zettelkasten link builder for 1-hop backlink expansion. When present,
   * the assembled pack is augmented with events that co-mention the same
   * targets as the primary hits. Absent ⇒ retrieval behavior is unchanged.
   */
  linkBuilder?: LinkBuilder;
  /**
   * Per-turn retrieval: assemble a bounded text pack of relevant past events.
   * Uses FTS search + vector search (when available) + recency boost + MMR deduplication.
   * Auto-injected by setRetrievalRuntime when not provided.
   */
  assemble?: (query: string, budgetTokens: number) => Promise<string | null>;
}

/**
 * U9: 1-hop Zettelkasten backlink expansion.
 *
 * Given the contents of the primary retrieval hits, parse each for mentions,
 * resolve the backlinks for every distinct target (events that co-mention the
 * same note/entity), resolve those source ids back to live events, and format a
 * bounded secondary section. Events already in the primary pack are skipped.
 * Returns null when nothing new fits or no backlinks resolve.
 */
function expandViaBacklinks(args: {
  linkBuilder: LinkBuilder;
  eventStore: EventStore;
  sourceContents: string[];
  alreadyPacked: Set<string>;
  budget: number;
}): string | null {
  const { linkBuilder, eventStore, sourceContents, alreadyPacked, budget } = args;

  // Collect distinct target keys mentioned by the primary hits.
  const targetKeys = new Set<string>();
  for (const content of sourceContents) {
    for (const mention of parseMentions(content)) {
      targetKeys.add(mention.normalized);
    }
  }
  if (targetKeys.size === 0) {
    return null;
  }

  // For each target, pull backlinks and resolve their source ids to events.
  const seen = new Set<string>(alreadyPacked);
  const neighbors: { id: string; timestamp: string; kind: string; content: string }[] = [];
  for (const targetKey of targetKeys) {
    for (const link of linkBuilder.getBacklinks(targetKey)) {
      if (seen.has(link.sourceId)) {
        continue;
      }
      seen.add(link.sourceId);
      const event = eventStore.readById(link.sourceId);
      if (!event) {
        continue;
      }
      neighbors.push({
        id: event.id,
        timestamp: event.timestamp,
        kind: event.kind,
        content: event.content,
      });
    }
  }
  if (neighbors.length === 0) {
    return null;
  }

  const header = "## Linked Memory (1-hop)\n";
  const lines: string[] = [header];
  let tokensUsed = estimateTokens(header);
  for (const ev of neighbors) {
    const line = `[${ev.timestamp}] [${ev.kind}] ${ev.content}`;
    const lineTokens = estimateTokens(line);
    if (tokensUsed + lineTokens > budget) {
      break;
    }
    lines.push(line);
    tokensUsed += lineTokens;
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Build a default assemble function bound to a RetrievalRuntime.
 *
 * Algorithm:
 *   1. FTS search for up to 40 candidate events matching the query.
 *   2. Apply a recency boost (exponential decay, half-life ~1 day).
 *   3. MMR deduplication (λ=0.7) to balance relevance and diversity.
 *   4. Pack events into text until the token budget is reached.
 *   5. U9: 1-hop backlink expansion when a link builder is registered.
 */
function buildDefaultAssemble(
  runtime: Pick<
    RetrievalRuntime,
    "eventStore" | "searchIndex" | "embeddingCache" | "embedFn" | "linkBuilder"
  >,
): (query: string, budgetTokens: number) => Promise<string | null> {
  return async (query: string, budgetTokens: number): Promise<string | null> => {
    let remainingBudget = budgetTokens;
    const sections: string[] = [];

    // Daily log hot cache — prepend as context, counts against budget
    const workspaceDir = (process.env.HOME ?? "~") + "/.openclaw/workspace";
    const dailyLog = loadTodayDailyLog(workspaceDir);
    if (dailyLog) {
      const dailySection = "## Todays Context\n" + dailyLog + "\n";
      const dailyTokens = estimateTokens(dailySection);
      if (dailyTokens < remainingBudget) {
        sections.push(dailySection);
        remainingBudget -= dailyTokens;
      }
    }

    // Contradiction gate: if write-intent detected, check for state conflicts
    if (hasWriteIntent(query)) {
      const contradictions = findContradictions(query, runtime.eventStore, workspaceDir);
      if (contradictions.length > 0) {
        const warningSection = formatContradictionWarnings(contradictions);
        const warningTokens = estimateTokens(warningSection);
        if (warningTokens < remainingBudget) {
          sections.push(warningSection);
          remainingBudget -= warningTokens;
        }
      }
    }

    // Entity-aware multi-query retrieval (FTS)
    const entities = extractEntities(query);
    const entityQueries = entitiesToQueries(entities);

    let candidates: SearchResult[];
    if (entityQueries.length > 0) {
      candidates = globalFtsMultiSearch(runtime.eventStore, entityQueries, 20, 40);
    } else {
      const searchFn = runtime.searchIndex ?? ftsSearch;
      candidates = searchFn(runtime.eventStore, query, 40);
    }

    // FORK: Merge vector search results when embedding provider is available.
    // Vector search catches semantically related events that FTS misses (synonyms,
    // paraphrases, conceptual matches). Results are deduplicated by event ID.
    if (runtime.embeddingCache && runtime.embedFn) {
      try {
        const vecResults = await vectorSearch(
          runtime.eventStore,
          query,
          20,
          undefined,
          runtime.embeddingCache,
          runtime.embedFn,
        );
        if (vecResults.length > 0) {
          const seenIds = new Set(candidates.map((c) => c.event.id));
          for (const vr of vecResults) {
            if (!seenIds.has(vr.event.id)) {
              candidates.push(vr);
              seenIds.add(vr.event.id);
            }
          }
        }
      } catch {
        // Vector search failure is non-fatal — FTS results are sufficient
      }
    }

    if (candidates.length === 0 && sections.length === 0) {
      return null;
    }

    if (candidates.length > 0) {
      // Recency boost: exponential decay with ~1 day half-life
      const now = Date.now();
      const boosted = candidates.map((r) => {
        const ageMs = now - new Date(r.event.timestamp).getTime();
        const recencyBoost = Math.exp(-ageMs / (24 * 60 * 60 * 1000)) * 0.5;
        return { ...r, score: r.score + recencyBoost };
      });

      // MMR re-ranking: λ=0.7 balances relevance with content diversity
      const mmrItems: MMRItem[] = boosted.map((r) => ({
        id: r.event.id,
        score: r.score,
        content: r.event.content,
      }));
      const reranked = mmrRerank(mmrItems, { enabled: true, lambda: 0.7 });

      // Fast lookup by event id
      const byId = new Map(boosted.map((r) => [r.event.id, r]));

      // Pack events into the remaining token budget
      const header = "## Retrieved Memory Context\n";
      const lines: string[] = [header];
      let tokensUsed = estimateTokens(header);
      // Track the primary hits so 1-hop expansion can dedup against them.
      const packedIds = new Set<string>();
      const packedContents: string[] = [];

      for (const item of reranked) {
        const result = byId.get(item.id);
        if (!result) {
          continue;
        }
        const { event } = result;
        const line = `[${event.timestamp}] [${event.kind}] ${event.content}`;
        const lineTokens = estimateTokens(line);
        if (tokensUsed + lineTokens > remainingBudget) {
          break;
        }
        lines.push(line);
        tokensUsed += lineTokens;
        packedIds.add(event.id);
        packedContents.push(event.content);
      }

      if (lines.length > 1) {
        sections.push(lines.join("\n"));
        remainingBudget -= tokensUsed;
      }

      // U9: 1-hop Zettelkasten backlink expansion. For each primary hit, parse
      // its mentions and pull the backlinks (other events that co-mention the
      // same target) as a secondary candidate set. Additive + flag-safe: only
      // runs when a link builder is registered and we have leftover budget.
      if (runtime.linkBuilder && packedContents.length > 0 && remainingBudget > 0) {
        const expansion = expandViaBacklinks({
          linkBuilder: runtime.linkBuilder,
          eventStore: runtime.eventStore,
          sourceContents: packedContents,
          alreadyPacked: packedIds,
          budget: remainingBudget,
        });
        if (expansion) {
          sections.push(expansion);
        }
      }
    }

    if (sections.length === 0) {
      return null;
    }

    return sections.join("\n");
  };
}

const registry = createSessionManagerRuntimeRegistry<RetrievalRuntime>();

/**
 * Store a retrieval runtime for a given session manager instance.
 * Automatically injects a default `assemble` implementation when none is provided.
 */
export const setRetrievalRuntime = (
  sessionManager: unknown,
  value: (Omit<RetrievalRuntime, "assemble"> & Partial<Pick<RetrievalRuntime, "assemble">>) | null,
): void => {
  if (value !== null && !value.assemble) {
    registry.set(sessionManager, {
      ...value,
      assemble: buildDefaultAssemble(value),
    });
    return;
  }
  registry.set(sessionManager, value);
};

/** Retrieve the retrieval runtime for a given session manager instance, or null. */
export const getRetrievalRuntime = registry.get;
