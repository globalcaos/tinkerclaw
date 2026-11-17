import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { readRawMemorySearchProvider } from "../fork/embedder-fit.js";
import {
  EmbedderUnavailableError,
  governorFor,
  type EmbedQueryCaller,
} from "../fork/embedder-governor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import {
  getBacklinks,
  getBreadthFirstNeighbors,
  hydrateBacklinks,
  rankByVerification,
  searchKeyword,
  searchVector,
  type TemporalMode,
} from "./manager-search.js";
import { extractKeywords } from "./query-expansion.js";
import { readMemoryFile } from "./read-file.js";
import type { Backlink, SearchResult } from "./storage/types.js";
import { invalidate as invalidateChunk } from "./temporal-invalidation.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;
const HYBRID_CANDIDATES_MAX = 200;
/**
 * FORK 2026-10-29: how often a degraded search may say so. Objective: one log line per minute
 * while the vector half fails, not one per turn (search runs on every turn); the governor's
 * snapshot keeps the per-call counts. Source: the design's "at most once a minute". Changes if
 * degraded periods need finer visibility in the log.
 */
const VECTOR_SKIP_WARN_INTERVAL_MS = 60_000;
/**
 * FORK 2026-10-29: the minScore cut needs bm25 to rank keyword hits. FTS5 floors a term's IDF,
 * ln((N - n + 0.5) / (n + 0.5)), to 1e-6 unless n < N/2; a hit's term has n >= 1, so below 3 rows
 * every hit scores about 1e-6 per term. Re-derive it for another tokenizer or ranking function.
 */
const BM25_MIN_RANKABLE_ROWS = 3;

const MEMORY_INDEX_MANAGER_CACHE_KEY = "__openclawMemoryIndexManagerCache";
type MemoryIndexManagerCacheStore = {
  indexCache: Map<string, MemoryIndexManager>;
  indexCachePending: Map<string, Promise<MemoryIndexManager>>;
};

function getMemoryIndexManagerCacheStore(): MemoryIndexManagerCacheStore {
  const globalCache = globalThis as typeof globalThis & {
    [MEMORY_INDEX_MANAGER_CACHE_KEY]?: MemoryIndexManagerCacheStore;
  };
  // Keep manager caches reachable across `vi.resetModules()` so cleanup still reaches older managers.
  globalCache[MEMORY_INDEX_MANAGER_CACHE_KEY] ??= {
    indexCache: new Map<string, MemoryIndexManager>(),
    indexCachePending: new Map<string, Promise<MemoryIndexManager>>(),
  };
  return globalCache[MEMORY_INDEX_MANAGER_CACHE_KEY];
}

const log = createSubsystemLogger("memory");

/**
 * Search is best-effort by design: one failing retrieval stage must not take the whole query
 * down. But a THROWN query is a BUG, not an empty result set. The bare `.catch(() => [])` that
 * used to guard the stages below hid a broken FTS5 statement (`bm25(f)` / `f MATCH ?` against a
 * table addressed by its JOIN alias — SQLite rejects that at PREPARE time with
 * "no such column: f") for months, because here a throw and a genuine miss looked identical.
 * (SQLiteMemoryStore.search() calls the same helper with no catch at all, so that path did
 * surface the throw; it is simply not wired into fork.memory.search.)
 *
 * INVARIANT for this file: every retrieval stage that degrades to [] logs WHY first.
 * Deliberately `error` rather than the `warn` used by the other degraded paths here — a query
 * that cannot even prepare is a defect, and silence about it is what cost us the months.
 * The stack goes in `meta`, never in the message, so a persistent failure cannot flood the
 * console on every turn (search runs per turn).
 */
function logSearchStageFailure(stage: string, err: unknown): void {
  const summary = err instanceof Error ? err.message : String(err);
  log.error(`memory search: ${stage} stage failed, degrading to 0 results: ${summary}`, {
    stage,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
}

const { indexCache: INDEX_CACHE, indexCachePending: INDEX_CACHE_PENDING } =
  getMemoryIndexManagerCacheStore();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  const pending = Array.from(INDEX_CACHE_PENDING.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const managers = Array.from(INDEX_CACHE.values());
  INDEX_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close();
    } catch (err) {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    }
  }
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  /** FORK 2026-10-29: agent + workspace + store path + purpose: the index this manager owns. */
  private readonly slotKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider: EmbeddingProviderRequest;
  private providerInitPromise: Promise<void> | null = null;
  private providerInitialized = false;
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected fallbackReason?: string;
  private providerUnavailableReason?: string;
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedSessionFiles = new Set<string>();
  private queuedSessionSync: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;
  private lastVectorSkipWarnAt = Number.NEGATIVE_INFINITY;
  /**
   * FORK 2026-10-29: the word index's row count, read up to BM25_MIN_RANKABLE_ROWS; null until a
   * search needs it. It lasts one sync generation: a sync's end clears it, and a search during a
   * sync counts again, because syncs are what write the index.
   */
  private ftsRowsUpToRankable: number | null = null;

  private static async loadProviderResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
  }): Promise<EmbeddingProviderResult> {
    return await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      provider: params.settings.provider,
      remote: params.settings.remote,
      model: params.settings.model,
      outputDimensionality: params.settings.outputDimensionality,
      fallback: params.settings.fallback,
      local: params.settings.local,
      // FORK 2026-10-29: the index's batches go to the governor's background lane, and a provider
      // the fit chose (memorySearch.provider unset or 'auto') may sleep while demand is below its
      // break-even; a pinned provider is only protected (TINKER_UI_DESIGN_BIBLE/embedder-fit.md).
      consumer: "memory-index",
      fitDecided: readRawMemorySearchProvider(params.cfg, params.agentId) === "auto",
    });
  }

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const purpose = params.purpose === "status" ? "status" : "default";
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}:${purpose}`;
    // FORK 2026-10-29: the index this manager owns. A cached manager of the same slot under
    // another key was built for settings that have since changed (a re-fit changed the provider):
    // it is closed and evicted before the new one opens the same file.
    const slotKey = `${agentId}:${workspaceDir}:${settings.store.path}:${purpose}`;
    const statusOnly = params.purpose === "status";
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const pending = INDEX_CACHE_PENDING.get(key);
    if (pending) {
      return pending;
    }
    if (statusOnly) {
      await MemoryIndexManager.retireSupersededManagers(slotKey, key);
      const cached = INDEX_CACHE.get(key);
      if (cached) {
        return cached;
      }
      const manager = new MemoryIndexManager({
        cacheKey: key,
        slotKey,
        cfg,
        agentId,
        workspaceDir,
        settings,
        purpose: params.purpose,
      });
      INDEX_CACHE.set(key, manager);
      return manager;
    }
    const createPromise = (async () => {
      const providerResult = await MemoryIndexManager.loadProviderResult({
        cfg,
        agentId,
        settings,
      });
      const refreshed = INDEX_CACHE.get(key);
      if (refreshed) {
        return refreshed;
      }
      await MemoryIndexManager.retireSupersededManagers(slotKey, key);
      const manager = new MemoryIndexManager({
        cacheKey: key,
        slotKey,
        cfg,
        agentId,
        workspaceDir,
        settings,
        providerResult,
        purpose: params.purpose,
      });
      INDEX_CACHE.set(key, manager);
      return manager;
    })();
    INDEX_CACHE_PENDING.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      if (INDEX_CACHE_PENDING.get(key) === createPromise) {
        INDEX_CACHE_PENDING.delete(key);
      }
    }
  }

  /**
   * FORK 2026-10-29: close and evict the cached managers of this index whose settings changed (a
   * re-fit changed the provider). Their watchers and listeners stop and their database handle
   * closes; a sync still running finishes first, and the caller does not wait for it.
   */
  private static async retireSupersededManagers(slotKey: string, key: string): Promise<void> {
    for (const [cachedKey, manager] of [...INDEX_CACHE]) {
      if (cachedKey === key || manager.slotKey !== slotKey) {
        continue;
      }
      INDEX_CACHE.delete(cachedKey);
      log.info("memory index: its settings changed; closing the manager built for the old ones");
      const closing = manager.close().catch((err: unknown) => {
        log.warn(`failed to close a superseded memory index manager: ${String(err)}`);
      });
      if (!manager.syncing) {
        await closing;
      }
    }
  }

  private constructor(params: {
    cacheKey: string;
    slotKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult?: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.slotKey = params.slotKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = null;
    this.requestedProvider = params.settings.provider;
    if (params.providerResult) {
      this.applyProviderResult(params.providerResult);
    }
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    const statusOnly = params.purpose === "status";
    if (!statusOnly) {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
    }
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
    this.batch = this.resolveBatchConfig();
  }

  private applyProviderResult(providerResult: EmbeddingProviderResult): void {
    this.provider = providerResult.provider;
    this.fallbackFrom = providerResult.fallbackFrom;
    this.fallbackReason = providerResult.fallbackReason;
    this.providerUnavailableReason = providerResult.providerUnavailableReason;
    this.openAi = providerResult.openAi;
    this.gemini = providerResult.gemini;
    this.voyage = providerResult.voyage;
    this.mistral = providerResult.mistral;
    this.ollama = providerResult.ollama;
    this.providerInitialized = true;
  }

  private async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        const providerResult = await MemoryIndexManager.loadProviderResult({
          cfg: this.cfg,
          agentId: this.agentId,
          settings: this.settings,
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      // Upgrade 3: bi-temporal slice. 'current' (default) | 'valid-at' | 'all'.
      temporalMode?: TemporalMode;
      asOfTime?: number;
      // Upgrade 6: trust filtering/boost.
      verificationRequired?: boolean;
      minTestCoverage?: number;
      // Upgrade 9: opt-in backlink hydration.
      backlinks?: boolean;
      // FORK 2026-10-29: who asks (TINKER_UI_DESIGN_BIBLE/embedder-fit.md). 'probe' (the bible's
      // self-test) searches words only, warms nothing, starts no sync and is never demand. 'agent'
      // and 'rpc' are real searches, the demand that arms a dormant embedder; 'internal', the
      // default, is counted apart and is not demand either.
      caller?: EmbedQueryCaller;
    },
  ): Promise<MemorySearchResult[]> {
    const caller: EmbedQueryCaller = opts?.caller ?? "internal";
    const probe = caller === "probe";
    await this.ensureProviderInitialized();
    if (!probe) {
      void this.warmSession(opts?.sessionKey);
      if (
        this.settings.sync.onSearch &&
        (this.dirty || this.sessionsDirty || this.wordOnlyDrainDue())
      ) {
        void this.sync({ reason: "search" }).catch((err) => {
          log.warn(`memory sync failed (search): ${String(err)}`);
        });
      }
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const temporalMode = opts?.temporalMode;
    const asOfTime = opts?.asOfTime;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      HYBRID_CANDIDATES_MAX,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );
    // Upgrade 6/9: post-rank by verification trust + (optionally) hydrate backlinks before
    // returning. Applied to whatever the underlying pipeline produced.
    const finalize = (results: MemorySearchResult[]): MemorySearchResult[] => {
      let out: MemorySearchResult[] = results;
      if (opts?.verificationRequired || opts?.minTestCoverage != null) {
        out = rankByVerification(out as Array<MemorySearchResult & { score: number }>, {
          verificationRequired: opts?.verificationRequired,
          minTestCoverage: opts?.minTestCoverage,
        }) as MemorySearchResult[];
      }
      if (opts?.backlinks) {
        out = hydrateBacklinks(
          this.db,
          out as unknown as SearchResult[],
        ) as unknown as MemorySearchResult[];
      }
      return out;
    };

    // FORK 2026-10-29: the keyword path when the vector half has nothing to do: no provider, a
    // probe, no vectors stored yet (a word-only or dormant index), or a query the governor would
    // refuse. Real searches still count as demand, so a dormant embedder can arm.
    const provider = this.provider;
    const governor = probe ? undefined : governorFor(provider);
    if (!provider || probe || !(await this.vectorHalfReady(provider))) {
      const results = finalize(
        await this.searchFtsOnly(cleaned, minScore, maxResults, candidates, {
          temporalMode,
          asOfTime,
        }),
      );
      governor?.noteQuery(caller);
      return results;
    }

    // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates, { temporalMode, asOfTime }).catch((err) => {
            logSearchStageFailure("keyword", err);
            return [];
          })
        : [];

    // FORK 2026-10-29: the query embed can fail (a deadline, an open breaker, a budget the queue
    // cannot meet, an endpoint error). The keyword results computed above are then served, under
    // the same score rules as any keyword-only hit below. scanMs is the vector scan's own time,
    // t_scan in the governor's demand account.
    let vectorResults: Array<MemorySearchResult & { id: string }> = [];
    let scanMs: number | undefined;
    try {
      const queryVec = await this.embedQueryWithTimeout(cleaned);
      if (queryVec.some((v) => v !== 0)) {
        const scanStart = performance.now();
        vectorResults = await this.searchVector(queryVec, candidates, {
          temporalMode,
          asOfTime,
        }).catch((err) => {
          logSearchStageFailure("vector", err);
          return [];
        });
        scanMs = performance.now() - scanStart;
      }
    } catch (err) {
      this.warnVectorHalfSkipped(err);
    }
    governor?.noteQuery(caller, scanMs);

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return finalize(
        vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults),
      );
    }

    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    const isKeywordHit = (entry: MemorySearchResult) =>
      keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`);
    // FORK 2026-10-29: in a word index too small for bm25 to rank (BM25_MIN_RANKABLE_ROWS), the
    // keyword hits stay without the cut, in the merge's order; vector-only entries keep it.
    const uncutKeywordHits = keywordResults.length > 0 && !this.bm25CanRank();
    const strict = merged.filter(
      (entry) => entry.score >= minScore || (uncutKeywordHits && isKeywordHit(entry)),
    );
    if (strict.length > 0 || keywordResults.length === 0) {
      return finalize(strict.slice(0, maxResults));
    }

    // Hybrid defaults can produce keyword-only matches with max score equal to
    // textWeight (for example 0.3). If minScore is higher (for example 0.35),
    // these exact lexical hits get filtered out even when they are the only
    // relevant results.
    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    return finalize(
      merged
        .filter((entry) => isKeywordHit(entry) && entry.score >= relaxedMinScore)
        .slice(0, maxResults),
    );
  }

  // ---------------------------------------------------------------------------
  // Upgrade 3: bi-temporal invalidation (supersede, never delete).
  // ---------------------------------------------------------------------------

  /**
   * Close the validity interval of a chunk as of `validAt` (default now), recording the
   * chunk that superseded it. Preserves history: the row is not deleted, and a "valid-at"
   * query for the old window still returns it. Returns true if a currently-open interval
   * was closed.
   */
  invalidate(
    chunkId: string,
    opts?: { supersededBy?: string | null; reason?: string; validAt?: number },
  ): boolean {
    const result = invalidateChunk(
      this.db,
      chunkId,
      opts?.supersededBy ?? null,
      opts?.reason ?? "manual",
      { validAt: opts?.validAt, log: (msg) => log.info(msg) },
    );
    return result.closed;
  }

  // ---------------------------------------------------------------------------
  // Upgrade 9: Zettelkasten retrieval (backlinks + k-hop neighbourhood).
  // ---------------------------------------------------------------------------

  /** Chunks that link TO `chunkId`, ordered by link strength (descending). */
  getBacklinks(chunkId: string, limit = 10): Backlink[] {
    return getBacklinks(this.db, chunkId, limit);
  }

  /**
   * Breadth-first walk of the link graph from `chunkId`, both directions, cycle-safe,
   * capped at `maxDepth`. Returns each reachable neighbour with the depth it was found at.
   */
  getBreadthFirstNeighbors(
    chunkId: string,
    maxDepth: number,
    opts?: { limit?: number },
  ): Array<{ id: string; depth: number }> {
    return getBreadthFirstNeighbors(this.db, chunkId, maxDepth, opts);
  }

  private computeSourceCounts(sourceFilter: {
    sql: string;
    params: MemorySource[];
  }): Array<{ source: MemorySource; files: number; chunks: number }> {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return [];
    }
    const bySource = new Map<MemorySource, { files: number; chunks: number }>();
    for (const source of sources) {
      bySource.set(source, { files: 0, chunks: 0 });
    }
    const fileRows = this.db
      .prepare(
        `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
      )
      .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
    for (const row of fileRows) {
      const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
      entry.files = row.c ?? 0;
      bySource.set(row.source, entry);
    }
    const chunkRows = this.db
      .prepare(
        `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
      )
      .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
    for (const row of chunkRows) {
      const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
      entry.chunks = row.c ?? 0;
      bySource.set(row.source, entry);
    }
    return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
  }

  private async searchFtsOnly(
    query: string,
    minScore: number,
    maxResults: number,
    candidates: number,
    temporal?: { temporalMode?: TemporalMode; asOfTime?: number },
  ): Promise<MemorySearchResult[]> {
    if (!this.fts.enabled || !this.fts.available) {
      log.warn(
        this.provider
          ? "memory search: keyword path taken but FTS is unavailable"
          : "memory search: no provider and FTS unavailable",
      );
      return [];
    }

    // FORK 2026-10-29: buildFtsQuery ORs the query's keywords (src/memory/hybrid.ts), so ONE query
    // ranks every chunk that shares any of them, BM25 putting chunks that match more terms first.
    // The one-search-per-keyword loop below is kept as the fallback for when it finds nothing.
    const ranked = await this.searchKeyword(query, candidates, temporal).catch((err) => {
      logSearchStageFailure("keyword", err);
      return [];
    });
    if (ranked.length > 0) {
      return this.cutKeywordHits(ranked, minScore).slice(0, maxResults);
    }

    // Conversational queries like "that API thing we discussed" perform poorly
    // with literal FTS; extract meaningful keywords to get better recall.
    const keywords = extractKeywords(query);
    const searchTerms = keywords.length > 0 ? keywords : [query];

    const resultSets = await Promise.all(
      searchTerms.map((term) =>
        this.searchKeyword(term, candidates, temporal).catch((err) => {
          logSearchStageFailure(`keyword(${JSON.stringify(term)})`, err);
          return [];
        }),
      ),
    );

    // Merge across keyword sets, keeping the best score per chunk.
    const bestByChunkId = new Map<string, (typeof resultSets)[0][0]>();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = bestByChunkId.get(result.id);
        if (!existing || result.score > existing.score) {
          bestByChunkId.set(result.id, result);
        }
      }
    }

    const best = [...bestByChunkId.values()].toSorted((a, b) => b.score - a.score);
    return this.cutKeywordHits(best, minScore).slice(0, maxResults);
  }

  /**
   * FORK 2026-10-29: the minScore cut for keyword hits. It is skipped while the word index is too
   * small for bm25 to rank (BM25_MIN_RANKABLE_ROWS), where it would drop every real match; the
   * hits keep their order either way.
   */
  private cutKeywordHits<T extends { score: number }>(hits: T[], minScore: number): T[] {
    if (hits.length === 0 || !this.bm25CanRank()) {
      return hits;
    }
    return hits.filter((entry) => entry.score >= minScore);
  }

  /**
   * FORK 2026-10-29: does the word index hold BM25_MIN_RANKABLE_ROWS rows or more? N counts every
   * row of the FTS table (all models, sources and validity windows), as bm25's IDF does. Counting
   * stops at the bound, so a large index costs a few rows; the count is kept for the sync
   * generation. A count that fails answers yes, and the cut applies as it always did.
   */
  private bm25CanRank(): boolean {
    if (this.ftsRowsUpToRankable !== null && !this.syncing) {
      return this.ftsRowsUpToRankable >= BM25_MIN_RANKABLE_ROWS;
    }
    let rows: number;
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${FTS_TABLE} LIMIT ?)`)
        .get(BM25_MIN_RANKABLE_ROWS) as { n: number } | undefined;
      rows = Number(row?.n ?? 0);
    } catch (err) {
      log.warn(
        `memory search: cannot count the word index's rows, so keyword hits keep the score cut: ${err instanceof Error ? err.message : String(err)}`,
      );
      rows = BM25_MIN_RANKABLE_ROWS;
    }
    if (!this.syncing) {
      this.ftsRowsUpToRankable = rows;
    }
    return rows >= BM25_MIN_RANKABLE_ROWS;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    temporal?: { temporalMode?: TemporalMode; asOfTime?: number },
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
      temporalMode: temporal?.temporalMode,
      asOfTime: temporal?.asOfTime,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  /**
   * FORK 2026-10-29: should this search embed its query? Only when there are vectors to scan and
   * the governor would answer a query now (its breaker is closed, the fit still names the model).
   */
  private async vectorHalfReady(provider: EmbeddingProvider): Promise<boolean> {
    if (!(await this.hasVectorsToScan(provider))) {
      return false;
    }
    const admission = governorFor(provider)?.admit("query");
    return !admission || admission.ok;
  }

  /**
   * FORK 2026-10-29: does the vector half have anything to scan? With sqlite-vec loaded that is a
   * row in chunks_vec; without it, a chunk embedded under the provider's model (searchVector then
   * scores the chunks' own embeddings). Cached in vectorRowsPresent until a write changes it. A
   * probe that fails answers yes, so a broken check costs one query embed, never the vector half.
   */
  private async hasVectorsToScan(provider: EmbeddingProvider): Promise<boolean> {
    if (this.vectorRowsPresent !== null) {
      return this.vectorRowsPresent;
    }
    let present: boolean;
    try {
      if (await this.ensureVectorReady()) {
        const table = this.db
          .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(VECTOR_TABLE);
        present =
          table !== undefined &&
          this.db.prepare(`SELECT 1 AS present FROM ${VECTOR_TABLE} LIMIT 1`).get() !== undefined;
      } else {
        present =
          this.db
            .prepare(`SELECT 1 AS present FROM chunks WHERE model = ? LIMIT 1`)
            .get(provider.model) !== undefined;
      }
    } catch (err) {
      log.debug(
        `memory search: the vector-row probe failed, trying the vector half: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
    this.vectorRowsPresent = present;
    return present;
  }

  /** FORK 2026-10-29: say, at most once a minute, that the vector half failed and words answered. */
  private warnVectorHalfSkipped(err: unknown): void {
    const reason =
      err instanceof EmbedderUnavailableError
        ? err.reason
        : err instanceof Error
          ? err.message
          : String(err);
    const message = `memory search: vector half skipped (${reason}), keyword results served`;
    const now = Date.now();
    if (now - this.lastVectorSkipWarnAt < VECTOR_SKIP_WARN_INTERVAL_MS) {
      log.debug(message);
      return;
    }
    this.lastVectorSkipWarnAt = now;
    log.warn(message);
  }

  /**
   * FORK 2026-10-29: a search also starts the background sync when word-only files are waiting
   * for vectors and the governor would admit their embedding now (the drain runs in that sync).
   */
  private wordOnlyDrainDue(): boolean {
    if (!this.provider) {
      return false;
    }
    for (const source of this.sources) {
      if (this.hasPendingFtsOnlyChunks(source) && this.indexAdmitted(source)) {
        return true;
      }
    }
    return false;
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
    temporal?: { temporalMode?: TemporalMode; asOfTime?: number },
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    // In FTS-only mode (no provider), search all models; otherwise filter by current provider's model
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      temporalMode: temporal?.temporalMode,
      asOfTime: temporal?.asOfTime,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.ensureProviderInitialized();
    if (this.syncing) {
      if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
        return this.enqueueTargetedSessionSync(params.sessionFiles);
      }
      return this.syncing;
    }
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
      // FORK 2026-10-29: the sync wrote the word index; the next search counts its rows again.
      this.ftsRowsUpToRankable = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(sessionFiles?: string[]): Promise<void> {
    for (const sessionFile of sessionFiles ?? []) {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        this.queuedSessionFiles.add(trimmed);
      }
    }
    if (this.queuedSessionFiles.size === 0) {
      return this.syncing ?? Promise.resolve();
    }
    if (!this.queuedSessionSync) {
      this.queuedSessionSync = (async () => {
        try {
          await this.syncing?.catch(() => undefined);
          while (!this.closed && this.queuedSessionFiles.size > 0) {
            const queuedSessionFiles = Array.from(this.queuedSessionFiles);
            this.queuedSessionFiles.clear();
            await this.sync({
              reason: "queued-session-files",
              sessionFiles: queuedSessionFiles,
            });
          }
        } finally {
          this.queuedSessionSync = null;
        }
      })();
    }
    return this.queuedSessionSync;
  }

  private isReadonlyDbError(err: unknown): boolean {
    const readonlyPattern =
      /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
    const messages = new Set<string>();

    const pushValue = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = value.trim();
      if (!normalized) {
        return;
      }
      messages.add(normalized);
    };

    pushValue(err instanceof Error ? err.message : String(err));
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      pushValue(record.message);
      pushValue(record.code);
      pushValue(record.name);
      if (record.cause && typeof record.cause === "object") {
        const cause = record.cause as Record<string, unknown>;
        pushValue(cause.message);
        pushValue(cause.code);
        pushValue(cause.name);
      }
    }

    return [...messages].some((value) => readonlyPattern.test(value));
  }

  private extractErrorReason(err: unknown): string {
    if (err instanceof Error && err.message.trim()) {
      return err.message;
    }
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
      if (typeof record.code === "string" && record.code.trim()) {
        return record.code;
      }
    }
    return String(err);
  }

  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    try {
      await this.runSync(params);
      return;
    } catch (err) {
      if (!this.isReadonlyDbError(err) || this.closed) {
        throw err;
      }
      const reason = this.extractErrorReason(err);
      this.readonlyRecoveryAttempts += 1;
      this.readonlyRecoveryLastError = reason;
      log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
      try {
        this.db.close();
      } catch {}
      this.db = this.openDatabase();
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      const meta = this.readMeta();
      this.vector.dims = meta?.vectorDims;
      this.vectorRowsPresent = null;
      try {
        await this.runSync(params);
        this.readonlyRecoverySuccesses += 1;
      } catch (retryErr) {
        this.readonlyRecoveryFailures += 1;
        throw retryErr;
      }
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return await readMemoryFile({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = this.computeSourceCounts(sourceFilter);

    const searchMode = this.provider || !this.providerInitialized ? "hybrid" : "fts-only";
    const providerInfo = this.provider
      ? { provider: this.provider.id, model: this.provider.model }
      : this.providerInitialized
        ? { provider: "none", model: undefined }
        : { provider: this.requestedProvider, model: this.settings.model || undefined };

    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: vector search not available
    if (!this.provider) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.ensureProviderInitialized();
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      };
    }
    try {
      // FORK 2026-10-29: someone is waiting for this answer (doctor), so it asks for the governor's
      // foreground lane; an index batch's background lane is refused while the CPU is busy.
      await this.embedBatchWithRetry(["ping"], "foreground");
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingSync = this.syncing;
    const pendingProviderInit = this.providerInitPromise;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    if (pendingSync) {
      try {
        await pendingSync;
      } catch {}
    }
    if (pendingProviderInit) {
      try {
        await pendingProviderInit;
      } catch {}
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}
