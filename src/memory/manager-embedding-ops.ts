import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { EMBED_CEILINGS } from "../fork/embedder-fit.js";
import {
  EmbedderUnavailableError,
  governorFor,
  httpStatusOf,
  isEndpointFailure,
} from "../fork/embedder-governor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { estimateTokensFromChars } from "../utils/cjk-chars.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./batch-gemini.js";
import {
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
  runOpenAiEmbeddingBatches,
} from "./batch-openai.js";
import { type VoyageBatchRequest, runVoyageEmbeddingBatches } from "./batch-voyage.js";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "./embedding-input-limits.js";
import { type EmbeddingInput, hasNonTextEmbeddingParts } from "./embedding-inputs.js";
import { buildGeminiEmbeddingRequest } from "./embeddings-gemini.js";
import { supersedeContradictions, type SupersedeMode } from "./engram/supersede-writer.js";
import {
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  detectGranularity,
  detectTopicCluster,
  hashText,
  parseEmbedding,
  remapChunkLines,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { FTS_ONLY_MODEL } from "./manager-search.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";
import type { SessionFileEntry } from "./session-files.js";
import type { MemorySource } from "./types.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const BATCH_FAILURE_LIMIT = 2;
/**
 * Chunks persisted per SQLite transaction in indexFile(), and the event-loop yield cadence:
 * the persist loop awaits setImmediate BETWEEN committed batches, never inside one.
 *
 * Bounds two costs at once. The store runs journal_mode=delete, so every autocommit fsyncs —
 * batching 50 INSERTs into one transaction removes ~98% of those fsyncs. And a batch of 50 is
 * short enough that the main thread is never held for more than a few ms before the gateway's
 * event loop gets it back.
 */
const CHUNK_PERSIST_TXN_BATCH = 50;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const log = createSubsystemLogger("memory");

/**
 * FORK 2026-10-29: our own deadline on an UNGOVERNED provider expired (a test double, or anything
 * built outside createEmbeddingProvider). A governed provider never reaches it: its governor owns
 * the deadline and the abort, and reports both as EmbedderUnavailableError.
 */
class EmbeddingDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingDeadlineError";
  }
}

/**
 * FORK 2026-10-29: the provider's AbortError for a governed call (in the first three links of the
 * cause chain), which isEndpointFailure leaves out. Only the governor's deadline or the caller
 * aborts a governed call. Since 2026-10-30 the governor rethrows either as EmbedderUnavailableError
 * with the provider's error as its cause, so the AbortError sits one link down: the same outage.
 * An error with an HTTP status is the endpoint's answer, judged by isEndpointFailure alone.
 */
function isGovernedAbort(err: unknown): boolean {
  if (httpStatusOf(err) !== undefined) {
    return false;
  }
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    if ((current as { name?: unknown }).name === "AbortError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * FORK 2026-10-29: the embedder could not answer, so indexFile writes the file words only and the
 * sync goes on (TINKER_UI_DESIGN_BIBLE/embedder-fit.md): the governor refused or abandoned the
 * call, our own deadline on an ungoverned provider expired, or a governed endpoint failed
 * (isEndpointFailure, the governor's own predicate) or was aborted (isGovernedAbort). Any other
 * error is the endpoint, or this code, answering (a 4xx, a bad request, a missing model, a test
 * double's failure) and keeps today's behaviour: it fails the sync, so a configured fallback
 * provider can still take over.
 */
function isEmbedderOutage(err: unknown, governed: boolean): boolean {
  if (err instanceof EmbedderUnavailableError || err instanceof EmbeddingDeadlineError) {
    return true;
  }
  return governed && (isEndpointFailure(err) || isGovernedAbort(err));
}

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;

  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    // FORK 2026-10-29: a governed provider's batches are sized in tokens by its budget (the fit's
    // batch plan for this machine, else the ceiling), so one batch never holds a one-slot embedder
    // longer than a foreground query can wait. A structured (multimodal) input keeps its byte
    // estimate, which overcounts tokens and so errs small. An ungoverned provider keeps today's
    // 8,000-byte rule.
    const governor = governorFor(this.provider);
    const limit = governor ? governor.budget("index").batchTokens : EMBEDDING_BATCH_MAX_TOKENS;
    const estimateOf = (chunk: MemoryChunk): number => {
      if (!governor) {
        return chunk.embeddingInput
          ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput)
          : estimateUtf8Bytes(chunk.text);
      }
      return chunk.embeddingInput && hasNonTextEmbeddingParts(chunk.embeddingInput)
        ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput)
        : estimateTokensFromChars(chunk.text.length);
    };
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const estimate = estimateOf(chunk);
      const wouldExceed = current.length > 0 && currentTokens + estimate > limit;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > limit) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    if (!this.cache.enabled || !this.provider) {
      return new Map();
    }
    if (hashes.length === 0) {
      return new Map();
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const hash of hashes) {
      if (!hash) {
        continue;
      }
      if (seen.has(hash)) {
        continue;
      }
      seen.add(hash);
      unique.push(hash);
    }
    if (unique.length === 0) {
      return new Map();
    }

    const out = new Map<string, number[]>();
    const baseParams = [this.provider.id, this.provider.model, this.providerKey];
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        out.set(row.hash, parseEmbedding(row.embedding));
      }
    }
    return out;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.cache.enabled || !this.provider) {
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
        ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
        ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
        `   embedding=excluded.embedding,\n` +
        `   dims=excluded.dims,\n` +
        `   updated_at=excluded.updated_at`,
    );
    for (const entry of entries) {
      const embedding = entry.embedding ?? [];
      stmt.run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        entry.hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
    }
  }

  protected pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) {
      return;
    }
    const max = this.cache.maxEntries;
    if (!max || max <= 0) {
      return;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) {
      return;
    }
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);

    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((m) => m.chunk);
    const batches = this.buildEmbeddingBatches(missingChunks);
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let cursor = 0;
    for (const batch of batches) {
      const inputs = batch.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      if (hasStructuredInputs && !provider.embedBatchInputs) {
        throw new Error(
          `Embedding provider "${provider.id}" does not support multimodal memory inputs.`,
        );
      }
      const batchEmbeddings = hasStructuredInputs
        ? await this.embedBatchInputsWithRetry(inputs)
        : await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      // FORK 2026-10-29: cache each batch as soon as it is embedded, not once per file, so a
      // failure later in the file (or a deadline) keeps the work already paid for; the retry, or
      // the drain, embeds only what is still missing.
      const toCache: Array<{ hash: string; embedding: number[] }> = [];
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          toCache.push({ hash: item.chunk.hash, embedding });
        }
      }
      this.upsertEmbeddingCache(toCache);
      cursor += batch.length;
    }
    return embeddings;
  }

  protected computeProviderKey(): string {
    // FTS-only mode: no provider, use a constant key
    if (!this.provider) {
      return hashText(JSON.stringify({ provider: "none", model: "fts-only" }));
    }
    if (this.provider.id === "openai" && this.openAi) {
      const entries = Object.entries(this.openAi.headers)
        .filter(([key]) => key.toLowerCase() !== "authorization")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "openai",
          baseUrl: this.openAi.baseUrl,
          model: this.openAi.model,
          headers: entries,
        }),
      );
    }
    if (this.provider.id === "gemini" && this.gemini) {
      const entries = Object.entries(this.gemini.headers)
        .filter(([key]) => {
          const lower = key.toLowerCase();
          return lower !== "authorization" && lower !== "x-goog-api-key";
        })
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "gemini",
          baseUrl: this.gemini.baseUrl,
          model: this.gemini.model,
          outputDimensionality: this.gemini.outputDimensionality,
          headers: entries,
        }),
      );
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    if (!this.provider) {
      return this.embedChunksInBatches(chunks);
    }
    if (this.provider.id === "openai" && this.openAi) {
      return this.embedChunksWithOpenAiBatch(chunks, entry, source);
    }
    if (this.provider.id === "gemini" && this.gemini) {
      return this.embedChunksWithGeminiBatch(chunks, entry, source);
    }
    if (this.provider.id === "voyage" && this.voyage) {
      return this.embedChunksWithVoyageBatch(chunks, entry, source);
    }
    return this.embedChunksInBatches(chunks);
  }

  private collectCachedEmbeddings(chunks: MemoryChunk[]): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: MemoryChunk }>;
  } {
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    return { embeddings, missing };
  }

  private buildBatchCustomId(params: {
    source: MemorySource;
    entry: MemoryFileEntry | SessionFileEntry;
    chunk: MemoryChunk;
    index: number;
  }): string {
    return hashText(
      `${params.source}:${params.entry.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${params.index}`,
    );
  }

  private buildBatchRequests<T extends { custom_id: string }>(params: {
    missing: Array<{ index: number; chunk: MemoryChunk }>;
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    build: (chunk: MemoryChunk) => Omit<T, "custom_id">;
  }): { requests: T[]; mapping: Map<string, { index: number; hash: string }> } {
    const requests: T[] = [];
    const mapping = new Map<string, { index: number; hash: string }>();

    for (const item of params.missing) {
      const chunk = item.chunk;
      const customId = this.buildBatchCustomId({
        source: params.source,
        entry: params.entry,
        chunk,
        index: item.index,
      });
      mapping.set(customId, { index: item.index, hash: chunk.hash });
      const built = params.build(chunk);
      requests.push({ custom_id: customId, ...built } as T);
    }

    return { requests, mapping };
  }

  private applyBatchEmbeddings(params: {
    byCustomId: Map<string, number[]>;
    mapping: Map<string, { index: number; hash: string }>;
    embeddings: number[][];
  }): void {
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (const [customId, embedding] of params.byCustomId.entries()) {
      const mapped = params.mapping.get(customId);
      if (!mapped) {
        continue;
      }
      params.embeddings[mapped.index] = embedding;
      toCache.push({ hash: mapped.hash, embedding });
    }
    this.upsertEmbeddingCache(toCache);
  }

  private buildEmbeddingBatchRunnerOptions<TRequest>(params: {
    requests: TRequest[];
    chunks: MemoryChunk[];
    source: MemorySource;
  }): {
    agentId: string;
    requests: TRequest[];
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    debug: (message: string, data?: Record<string, unknown>) => void;
  } {
    const { requests, chunks, source } = params;
    return {
      agentId: this.agentId,
      requests,
      wait: this.batch.wait,
      concurrency: this.batch.concurrency,
      pollIntervalMs: this.batch.pollIntervalMs,
      timeoutMs: this.batch.timeoutMs,
      debug: (message, data) =>
        log.debug(
          message,
          data ? { ...data, source, chunks: chunks.length } : { source, chunks: chunks.length },
        ),
    };
  }

  private async embedChunksWithProviderBatch<TRequest extends { custom_id: string }>(params: {
    chunks: MemoryChunk[];
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    provider: "voyage" | "openai" | "gemini";
    enabled: boolean;
    buildRequest: (chunk: MemoryChunk) => Omit<TRequest, "custom_id">;
    runBatch: (runnerOptions: {
      agentId: string;
      requests: TRequest[];
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMs: number;
      debug: (message: string, data?: Record<string, unknown>) => void;
    }) => Promise<Map<string, number[]> | number[][]>;
  }): Promise<number[][]> {
    if (!params.enabled) {
      return this.embedChunksInBatches(params.chunks);
    }
    if (params.chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(params.chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const { requests, mapping } = this.buildBatchRequests<TRequest>({
      missing,
      entry: params.entry,
      source: params.source,
      build: params.buildRequest,
    });
    const runnerOptions = this.buildEmbeddingBatchRunnerOptions({
      requests,
      chunks: params.chunks,
      source: params.source,
    });
    const batchResult = await this.runBatchWithFallback({
      provider: params.provider,
      run: async () => await params.runBatch(runnerOptions),
      fallback: async () => await this.embedChunksInBatches(params.chunks),
    });
    if (Array.isArray(batchResult)) {
      return batchResult;
    }
    this.applyBatchEmbeddings({ byCustomId: batchResult, mapping, embeddings });
    return embeddings;
  }

  private async embedChunksWithVoyageBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const voyage = this.voyage;
    return await this.embedChunksWithProviderBatch<VoyageBatchRequest>({
      chunks,
      entry,
      source,
      provider: "voyage",
      enabled: Boolean(voyage),
      buildRequest: (chunk) => ({
        body: { input: chunk.text },
      }),
      runBatch: async (runnerOptions) =>
        await runVoyageEmbeddingBatches({
          client: voyage!,
          ...runnerOptions,
        }),
    });
  }

  private async embedChunksWithOpenAiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const openAi = this.openAi;
    return await this.embedChunksWithProviderBatch<OpenAiBatchRequest>({
      chunks,
      entry,
      source,
      provider: "openai",
      enabled: Boolean(openAi),
      buildRequest: (chunk) => ({
        method: "POST",
        url: OPENAI_BATCH_ENDPOINT,
        body: {
          model: openAi?.model ?? this.provider?.model ?? "text-embedding-3-small",
          input: chunk.text,
        },
      }),
      runBatch: async (runnerOptions) =>
        await runOpenAiEmbeddingBatches({
          openAi: openAi!,
          ...runnerOptions,
        }),
    });
  }

  private async embedChunksWithGeminiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const gemini = this.gemini;
    if (chunks.some((chunk) => hasNonTextEmbeddingParts(chunk.embeddingInput))) {
      return await this.embedChunksInBatches(chunks);
    }
    return await this.embedChunksWithProviderBatch<GeminiBatchRequest>({
      chunks,
      entry,
      source,
      provider: "gemini",
      enabled: Boolean(gemini),
      buildRequest: (chunk) => ({
        request: buildGeminiEmbeddingRequest({
          input: chunk.embeddingInput ?? { text: chunk.text },
          taskType: "RETRIEVAL_DOCUMENT",
          modelPath: this.gemini?.modelPath,
          outputDimensionality: this.gemini?.outputDimensionality,
        }),
      }),
      runBatch: async (runnerOptions) =>
        await runGeminiEmbeddingBatches({
          gemini: gemini!,
          ...runnerOptions,
        }),
    });
  }

  protected async embedBatchWithRetry(
    texts: string[],
    // FORK 2026-10-29: the governor lane. Index batches are background work; a check somebody is
    // waiting for (doctor's embedding probe) asks for the foreground lane.
    priority: "foreground" | "background" = "background",
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    const governor = governorFor(provider);
    const retries5xx = governor
      ? governor.budget("index").retries5xx
      : EMBEDDING_RETRY_MAX_ATTEMPTS;
    return await this.withEmbeddingRetry(retries5xx, "retrying", async () => {
      if (governor) {
        // FORK 2026-10-29: called directly; the governor owns the deadline and the abort.
        log.debug("memory embeddings: batch start", {
          provider: provider.id,
          items: texts.length,
          priority,
        });
        return await provider.embedBatch(texts, { priority });
      }
      const timeoutMs = EMBED_CEILINGS.batchDeadlineMs;
      log.debug("memory embeddings: batch start", {
        provider: provider.id,
        items: texts.length,
        timeoutMs,
      });
      return await this.withUngovernedDeadline(provider.embedBatch(texts), timeoutMs, "batch");
    });
  }

  /**
   * FORK 2026-10-29: today's retry loop, split by cause. A rate limit (429, quota) is retried up to
   * EMBEDDING_RETRY_MAX_ATTEMPTS times, as before. A server error (5xx) is retried only
   * `retries5xx` times: the governor's budget says 0 for a machine-local server (its breaker
   * decides, and a retry would queue behind the very work that is failing) and today's 3 for a
   * remote API; an ungoverned provider keeps 3. An EmbedderUnavailableError (deadline, abort,
   * breaker, busy, over budget) is never retried: the caller writes words instead.
   */
  private async withEmbeddingRetry<T>(
    retries5xx: number,
    action: string,
    run: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    let serverRetries = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        return await run();
      } catch (err) {
        if (err instanceof EmbedderUnavailableError || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRateLimitedEmbeddingError(message)) {
          if (!this.isServerEmbeddingError(message) || serverRetries >= retries5xx) {
            throw err;
          }
          serverRetries += 1;
        }
        await this.waitForEmbeddingRetry(delayMs, action);
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  protected async embedBatchInputsWithRetry(inputs: EmbeddingInput[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const provider = this.provider;
    if (!provider?.embedBatchInputs) {
      return await this.embedBatchWithRetry(inputs.map((input) => input.text));
    }
    const embedInputs = provider.embedBatchInputs.bind(provider);
    const governor = governorFor(provider);
    const retries5xx = governor
      ? governor.budget("index").retries5xx
      : EMBEDDING_RETRY_MAX_ATTEMPTS;
    return await this.withEmbeddingRetry(retries5xx, "retrying structured batch", async () => {
      if (governor) {
        // FORK 2026-10-29: called directly; the governor owns the deadline and the abort.
        log.debug("memory embeddings: structured batch start", {
          provider: provider.id,
          items: inputs.length,
        });
        return await embedInputs(inputs, { priority: "background" });
      }
      const timeoutMs = EMBED_CEILINGS.batchDeadlineMs;
      log.debug("memory embeddings: structured batch start", {
        provider: provider.id,
        items: inputs.length,
        timeoutMs,
      });
      return await this.withUngovernedDeadline(embedInputs(inputs), timeoutMs, "batch");
    });
  }

  private async waitForEmbeddingRetry(delayMs: number, action: string): Promise<void> {
    const waitMs = Math.min(
      EMBEDDING_RETRY_MAX_DELAY_MS,
      Math.round(delayMs * (1 + Math.random() * 0.2)),
    );
    log.warn(`memory embeddings rate limited; ${action} in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private isRateLimitedEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|tokens per day)/i.test(
      message,
    );
  }

  // FORK 2026-10-29: with isRateLimitedEmbeddingError, exactly what the old single retry rule
  // matched, split so a server error can be retried less than a rate limit.
  private isServerEmbeddingError(message: string): boolean {
    return /(5\d\d|cloudflare)/i.test(message);
  }

  /**
   * FORK 2026-10-29: an ungoverned provider keeps today's race against a deadline, now at the
   * EMBED_CEILINGS (10 min per batch, 60 s per query) instead of a rule keyed on the provider id.
   * The race abandons the call but cannot cancel it; only the governor's deadline aborts one. The
   * expiry is reported as EmbeddingDeadlineError, so indexFile writes the file words only.
   */
  private async withUngovernedDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    what: "batch" | "query",
  ): Promise<T> {
    const message = `memory embeddings ${what} timed out after ${Math.round(timeoutMs / 1000)}s`;
    try {
      return await this.withTimeout(promise, timeoutMs, message);
    } catch (err) {
      if (err instanceof Error && err.message === message) {
        throw new EmbeddingDeadlineError(message);
      }
      throw err;
    }
  }

  protected async embedQueryWithTimeout(text: string): Promise<number[]> {
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    const governor = governorFor(provider);
    if (governor) {
      // FORK 2026-10-29: the foreground lane under the query budget (the fit's break-even B_q, or
      // the 60 s ceiling). The governor refuses at once a query it cannot answer in time, and
      // aborts at its deadline one it took.
      const budgetMs = governor.budget("query").queryDeadlineMs;
      log.debug("memory embeddings: query start", { provider: provider.id, budgetMs });
      return await provider.embedQuery(text, { priority: "foreground", budgetMs });
    }
    const timeoutMs = EMBED_CEILINGS.queryDeadlineMs;
    log.debug("memory embeddings: query start", { provider: provider.id, timeoutMs });
    return await this.withUngovernedDeadline(provider.embedQuery(text), timeoutMs, "query");
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async withBatchFailureLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = this.batchFailureLock;
    this.batchFailureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async resetBatchFailureCount(): Promise<void> {
    await this.withBatchFailureLock(async () => {
      if (this.batchFailureCount > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      this.batchFailureCount = 0;
      this.batchFailureLastError = undefined;
      this.batchFailureLastProvider = undefined;
    });
  }

  private async recordBatchFailure(params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  }): Promise<{ disabled: boolean; count: number }> {
    return await this.withBatchFailureLock(async () => {
      if (!this.batch.enabled) {
        return { disabled: true, count: this.batchFailureCount };
      }
      const increment = params.forceDisable
        ? BATCH_FAILURE_LIMIT
        : Math.max(1, params.attempts ?? 1);
      this.batchFailureCount += increment;
      this.batchFailureLastError = params.message;
      this.batchFailureLastProvider = params.provider;
      const disabled = params.forceDisable || this.batchFailureCount >= BATCH_FAILURE_LIMIT;
      if (disabled) {
        this.batch.enabled = false;
      }
      return { disabled, count: this.batchFailureCount };
    });
  }

  private isBatchTimeoutError(message: string): boolean {
    return /timed out|timeout/i.test(message);
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isBatchTimeoutError(message)) {
        log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
        try {
          return await params.run();
        } catch (retryErr) {
          (retryErr as { batchAttempts?: number }).batchAttempts = 2;
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async runBatchWithFallback<T>(params: {
    provider: string;
    run: () => Promise<T>;
    fallback: () => Promise<number[][]>;
  }): Promise<T | number[][]> {
    if (!this.batch.enabled) {
      return await params.fallback();
    }
    try {
      const result = await this.runBatchWithTimeoutRetry({
        provider: params.provider,
        run: params.run,
      });
      await this.resetBatchFailureCount();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
      const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
      const failure = await this.recordBatchFailure({
        provider: params.provider,
        message,
        attempts,
        forceDisable,
      });
      const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
      log.warn(
        `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
      );
      return await params.fallback();
    }
  }

  protected getIndexConcurrency(): number {
    if (this.batch.enabled) {
      return this.batch.concurrency;
    }
    // FORK 2026-10-29: a governed provider runs at its endpoint's measured concurrency (1 per
    // local server, 2 only when the fit measured the gain beyond 2 sigma, the ceiling for a remote
    // API), capped by remote.nonBatchConcurrency when it is set. An ungoverned one keeps today's 4.
    const governor = governorFor(this.provider);
    if (!governor) {
      return EMBEDDING_INDEX_CONCURRENCY;
    }
    const derived = governor.budget("index").concurrency;
    const ceiling = this.settings.remote?.nonBatchConcurrency;
    return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 1
      ? Math.max(1, Math.min(derived, Math.floor(ceiling)))
      : derived;
  }

  private clearIndexedFileData(pathname: string, source: MemorySource): void {
    if (this.vector.enabled) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(pathname, source);
      } catch {}
    }
    // FORK 2026-10-29: the file's FTS rows are its provider model's and its word-only ones, so a
    // word-only file is cleared too, with or without a provider.
    if (this.fts.enabled && this.fts.available) {
      const fts = this.ftsModelFilter();
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND ${fts.sql}`)
          .run(pathname, source, ...fts.params);
      } catch {}
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathname, source);
    this.vectorRowsPresent = null;
  }

  /**
   * Does this (source, path) hold ANY chunk whose validity interval is still OPEN and whose
   * validity_start is STRICTLY EARLIER than `before`?
   *
   * SOUNDNESS — why one probe can replace ~2,800 per-chunk SELECTs. This predicate is the
   * supersede-writer's per-chunk predicate (engram/supersede-writer.ts findSupersededChunkIds)
   * with the start_line / end_line / model / hash<> / id<> conjuncts DROPPED — a strict
   * relaxation over the same source, path, `validity_start < ?` and `validity_end IS NULL`.
   * Every chunk of one indexFile pass is persisted with the same entry.path, options.source
   * and the single `now` computed in indexFile, which is also each candidate's validityStart.
   * So this result set is a SUPERSET of every per-chunk result set in the pass, and an empty
   * superset proves every subset is empty. Skipping is not usually-right, it is provably
   * equivalent whenever this returns false.
   *
   * And nothing written DURING the pass can re-populate it: persistChunk stamps
   * validity_start = now, and `now < now` is false. (That strict `<` is the FORK 2026-09-03
   * fix documented in supersede-writer.ts, which stops split fragments cannibalising their
   * own siblings.)
   *
   * In the live pipeline clearIndexedFileData() has just DELETEd every chunk at
   * (path, source), so this returns false and the whole per-chunk supersede pass is skipped.
   * The probe is kept rather than the skip being hard-coded so that any future path which
   * persists chunks WITHOUT clearing first still supersedes correctly — the optimisation
   * cannot silently rot.
   *
   * FAIL-SAFE DIRECTION: on any error this returns true (assume prior facts exist), so a
   * broken probe degrades to the old slow-but-correct behaviour, never to a silent skip.
   * Logged, never swallowed.
   */
  private hasPriorOpenInterval(pathname: string, source: MemorySource, before: number): boolean {
    try {
      const row = this.db
        .prepare(
          `SELECT 1 AS present FROM chunks
            WHERE source = ?
              AND path = ?
              AND validity_start < ?
              AND validity_end IS NULL
            LIMIT 1`,
        )
        .get(source, pathname, before) as { present?: number } | undefined;
      return row !== undefined;
    } catch (err) {
      log.warn(
        `memory embeddings: prior-open probe failed for ${pathname}; keeping per-chunk supersede: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }

  /**
   * Open one transaction for a persist batch. Returns false — LOUDLY, never silently — when
   * BEGIN is refused because an outer transaction is already open on this handle. The batch
   * then persists in autocommit exactly as it did before this optimisation instead of
   * aborting the whole index, so a refused BEGIN preserves today's failure point (the first
   * INSERT) rather than moving it earlier. VERIFICATION DISCIPLINE #4: an unobservable no-op
   * is the bug, so this logs rather than swallowing.
   */
  private beginChunkTransaction(db: DatabaseSync): boolean {
    try {
      db.exec("BEGIN");
      return true;
    } catch (err) {
      log.warn(
        `memory embeddings: chunk-persist BEGIN refused, falling back to autocommit: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private upsertFileRecord(entry: MemoryFileEntry | SessionFileEntry, source: MemorySource): void {
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  }

  private deleteFileRecord(pathname: string, source: MemorySource): void {
    this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathname, source);
  }

  private isStructuredInputTooLargeError(message: string): boolean {
    return /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
      message,
    );
  }

  /** FORK 2026-10-29: one warn per sync when the embedder fails; that sync's other files log at debug. */
  private warnWordOnlyOnce(pathname: string, reason: string): void {
    const message = `memory embeddings: embedding failed for ${pathname} (${reason}); the file is indexed words only and its vectors stay pending`;
    if (this.embedderFailedThisSync) {
      log.debug(message);
      return;
    }
    this.embedderFailedThisSync = true;
    log.warn(message);
  }

  /**
   * FORK 2026-10-29: the tokens this file holds in word-only chunks, its share of the governor's
   * pending backlog. During a safe reindex they are read from the index being replaced, so the
   * same backlog is not counted twice.
   */
  private pendingWordOnlyTokens(pathname: string, source: MemorySource): number {
    try {
      const row = (this.priorIndexDb ?? this.db)
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM chunks
            WHERE source = ? AND path = ? AND model = '${FTS_ONLY_MODEL}'`,
        )
        .get(source, pathname) as { chars?: number } | undefined;
      return estimateTokensFromChars(Number(row?.chars ?? 0));
    } catch (err) {
      log.debug(
        `memory embeddings: cannot read the word-only backlog of ${pathname}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  protected async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    // FORK 2026-10-29: a file is always indexed for word search. When no vector can be made (no
    // provider, background embedding not admitted, or the embedder could not answer) its chunks
    // and FTS rows are written under the model key 'fts-only', its vectors stay pending, and the
    // sync goes on; the drain in manager-sync-ops.ts vectorises it later
    // (TINKER_UI_DESIGN_BIBLE/embedder-fit.md). This used to return without a provider, writing
    // nothing, and an embedder failure threw the whole sync, and a safe reindex, away.
    const provider = this.provider;

    let chunks: MemoryChunk[];
    let structuredInputBytes: number | undefined;
    if ("kind" in entry && entry.kind === "multimodal") {
      const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
      if (!multimodalChunk) {
        this.clearIndexedFileData(entry.path, options.source);
        this.deleteFileRecord(entry.path, options.source);
        return;
      }
      structuredInputBytes = multimodalChunk.structuredInputBytes;
      chunks = [multimodalChunk.chunk];
    } else {
      const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
      const textChunks = chunkMarkdown(content, this.settings.chunking).filter(
        (chunk) => chunk.text.trim().length > 0,
      );
      // The input-size cap is the provider's; without one there is nothing to cap for.
      chunks = provider
        ? enforceEmbeddingMaxInputTokens(provider, textChunks, EMBEDDING_BATCH_MAX_TOKENS)
        : textChunks;
      if (options.source === "sessions" && "lineMap" in entry) {
        remapChunkLines(chunks, entry.lineMap);
      }
    }
    // FORK 2026-10-29: make the vectors when that is allowed and possible, else write the words.
    const governor = governorFor(provider);
    const pendingBefore = governor ? this.pendingWordOnlyTokens(entry.path, options.source) : 0;
    let embeddings: number[][] = [];
    let wordOnly = !provider;
    if (provider && chunks.length > 0) {
      const cached = this.collectCachedEmbeddings(chunks);
      if (cached.missing.length === 0) {
        // Every vector is cached: no embedder time is spent, so admission does not apply.
        embeddings = cached.embeddings;
      } else {
        const admission = governor?.admit("index", options.source);
        if (admission && !admission.ok) {
          wordOnly = true;
          log.debug("memory embeddings: background embedding not admitted; indexing words only", {
            path: entry.path,
            source: options.source,
            reason: admission.reason,
          });
        } else {
          try {
            embeddings = this.batch.enabled
              ? await this.embedChunksWithBatch(chunks, entry, options.source)
              : await this.embedChunksInBatches(chunks);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (isEmbedderOutage(err, governor !== undefined)) {
              wordOnly = true;
              this.warnWordOnlyOnce(entry.path, message);
            } else if (
              "kind" in entry &&
              entry.kind === "multimodal" &&
              this.isStructuredInputTooLargeError(message)
            ) {
              log.warn("memory embeddings: skipping multimodal file rejected as too large", {
                path: entry.path,
                bytes: structuredInputBytes,
                provider: provider.id,
                model: provider.model,
                error: message,
              });
              this.clearIndexedFileData(entry.path, options.source);
              this.upsertFileRecord(entry, options.source);
              return;
            } else {
              throw err;
            }
          }
        }
      }
    }
    if (wordOnly) {
      embeddings = [];
    }
    const modelKey = provider && !wordOnly ? provider.model : FTS_ONLY_MODEL;
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    const granularity = detectGranularity(entry.path);
    const topicCluster = detectTopicCluster(entry.path);

    this.clearIndexedFileData(entry.path, options.source);

    // PERF 2026-09-03 — hoist the supersede prior-open check to ONE indexed probe per file
    // (see hasPriorOpenInterval for the soundness proof). Deliberately placed AFTER
    // clearIndexedFileData, because that is the state persistChunk's own per-chunk SELECT
    // will actually see. Probing BEFORE the DELETE would report the rows we are about to
    // remove, so the skip would never fire on the hot path — a re-index of an
    // already-indexed session file, which is every pass after the first. The probe is
    // skipped entirely when the feature is off, so it costs nothing by default.
    const skipSupersede =
      process.env.ENGRAM_SUPERSEDE_ENABLED === "true" &&
      !this.hasPriorOpenInterval(entry.path, options.source, now);

    // PERF: persist in transactions of CHUNK_PERSIST_TXN_BATCH chunks, yielding to the event
    // loop BETWEEN committed batches.
    //
    // INVARIANT — THERE IS NO await BETWEEN BEGIN AND COMMIT. indexFile is fanned out at
    // getIndexConcurrency() (default EMBEDDING_INDEX_CONCURRENCY = 4) over ONE shared
    // DatabaseSync handle (manager-sync-ops.ts:844,957 -> runWithConcurrency; the handle is
    // `protected abstract db` at manager-sync-ops.ts:157), and node:sqlite transactions
    // belong to the HANDLE, not to this call. Until now the entire persist phase was
    // synchronous, and that is precisely what made the concurrent fan-out safe: workers could
    // only interleave at the embedding await. Yielding inside an OPEN transaction would
    // destroy that invariant two ways — a sibling indexFile resuming mid-transaction throws
    // "cannot start a transaction within a transaction" on its BEGIN, and any foreign write
    // that slipped in (the embedding-cache flush at manager-sync-ops.ts:395 runs its own
    // BEGIN/COMMIT on this same handle) would be silently discarded by our ROLLBACK.
    // Committing before every yield makes both impossible BY CONSTRUCTION rather than merely
    // unlikely, and means every point at which we hand the loop back exposes a consistent,
    // durable store. ALTERNATIVE REJECTED: a promise-chain mutex around the persist phase —
    // it serialises the fan-out for no gain once this invariant holds, and it would not even
    // cover the foreign-writer case, since that flush is not under any such lock.
    // manager-embedding-ops.supersede-perf.test.ts fails if a yield is ever observed while a
    // transaction is open, which is the gate that keeps this invariant true.
    //
    // WHAT THIS TRADES AWAY: whole-file atomicity, which this code never had. A throw leaves
    // earlier batches committed and skips upsertFileRecord below, so the stored hash stays
    // stale and the next sync re-indexes the file — the same recovery as today, from a
    // strictly better starting point (today each of ~2,800 INSERTs autocommits on its own).
    for (let start = 0; start < chunks.length; start += CHUNK_PERSIST_TXN_BATCH) {
      const end = Math.min(start + CHUNK_PERSIST_TXN_BATCH, chunks.length);
      const db = this.db;
      const inTransaction = this.beginChunkTransaction(db);
      try {
        for (let i = start; i < end; i++) {
          const chunk = chunks[i];
          const embedding = embeddings[i] ?? [];
          const chunkId = hashText(
            `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${modelKey}`,
          );
          this.persistChunk({
            chunk,
            embedding,
            chunkId,
            entry,
            source: options.source,
            now,
            granularity,
            topicCluster,
            vectorReady,
            modelKey,
            skipSupersede,
          });
        }
        if (inTransaction) {
          db.exec("COMMIT");
        }
      } catch (err) {
        if (inTransaction) {
          try {
            db.exec("ROLLBACK");
          } catch {}
        }
        throw err;
      }
      if (end < chunks.length) {
        // The line that stops the gateway event loop stalling 130-180 s on a large session
        // re-index. Reached only with every preceding batch COMMITted.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    this.upsertFileRecord(entry, options.source);

    // FORK 2026-10-29: the governor's backlog account, which feeds dormancy and keep-up. A
    // word-only write adds what is new since this file's last word-only write; vectorising a file
    // that was word-only drains what it held.
    if (governor) {
      if (wordOnly) {
        const tokens = estimateTokensFromChars(
          chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
        );
        if (tokens > pendingBefore) {
          governor.notePending(options.source, tokens - pendingBefore);
        }
      } else if (pendingBefore > 0) {
        governor.noteDrained(options.source, pendingBefore);
      }
    }
  }

  private deleteStaleChunkData(path: string, source: MemorySource, vectorReady: boolean): void {
    // Vectors must be removed before chunks because the vec table references chunk ids.
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(path, source);
      } catch {}
    }
    // FORK 2026-10-29: the same FTS model rule as clearIndexedFileData.
    if (this.fts.enabled && this.fts.available) {
      const fts = this.ftsModelFilter();
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND ${fts.sql}`)
          .run(path, source, ...fts.params);
      } catch {}
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(path, source);
    this.vectorRowsPresent = null;
  }

  private persistChunk(params: {
    chunk: MemoryChunk;
    embedding: number[];
    chunkId: string;
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    now: number;
    granularity: string;
    topicCluster: string;
    vectorReady: boolean;
    /**
     * FORK 2026-10-29: the model key of the chunk row, its FTS row and its id hash: the provider's
     * model, or 'fts-only' for a chunk written without a vector. Optional, defaulting to the
     * provider's model ('fts-only' without one), so a caller that predates it keeps its meaning.
     */
    modelKey?: string;
    /**
     * Set by indexFile when its once-per-file prior-open probe found nothing. The supersede
     * SELECT is then provably empty for every chunk of that pass (see hasPriorOpenInterval),
     * so running it per chunk only burns main-thread time — measured 56-66 ms each, ~2,800
     * times per session re-index.
     *
     * OPTIONAL, defaulting to false (run it), so any future caller that has not probed keeps
     * the original behaviour. The default direction is the safe one: silence degrades to
     * slow-but-correct, never to a silent skip.
     */
    skipSupersede?: boolean;
  }): void {
    // FORK 2026-10-29: no provider guard. A chunk without a vector is persisted under the word-only
    // key (chunk row and FTS row, no vector row), so word search works with no embedder at all.
    const {
      chunk,
      embedding,
      chunkId,
      entry,
      source,
      now,
      granularity,
      topicCluster,
      vectorReady,
      skipSupersede = false,
    } = params;
    const modelKey = params.modelKey ?? this.provider?.model ?? FTS_ONLY_MODEL;

    this.db
      .prepare(
        // Upgrade 3: bi-temporal columns. validity_start tracks the latest write;
        // ingestion_time is set once and must NOT be overwritten on conflict (preserve
        // first-seen). validity_end stays at its DEFAULT (NULL = currently valid) on insert
        // and is left untouched on update — closing an interval goes through invalidate().
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, granularity, topic_cluster, validity_start, ingestion_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hash=excluded.hash,
           model=excluded.model,
           text=excluded.text,
           embedding=excluded.embedding,
           updated_at=excluded.updated_at,
           granularity=excluded.granularity,
           topic_cluster=excluded.topic_cluster,
           validity_start=excluded.validity_start`,
      )
      .run(
        chunkId,
        entry.path,
        source,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        modelKey,
        chunk.text,
        JSON.stringify(embedding),
        now,
        granularity,
        topicCluster,
        now,
        now,
      );

    if (vectorReady && embedding.length > 0) {
      // Delete-then-insert avoids vec0 upsert limitations on some builds.
      try {
        this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(chunkId);
      } catch {}
      this.db
        .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
        .run(chunkId, vectorToBlob(embedding));
    }
    // FORK 2026-10-29: the vector half now has something to scan (a vec0 row, or without
    // sqlite-vec the chunk's own embedding); manager.ts skips the query embed while it has none.
    if (modelKey !== FTS_ONLY_MODEL && embedding.length > 0) {
      this.vectorRowsPresent = true;
    }

    if (this.fts.enabled && this.fts.available) {
      this.db
        .prepare(
          `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
            ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(chunk.text, chunkId, entry.path, source, modelKey, chunk.startLine, chunk.endLine);
    }

    // J14 SUPERSEDE-WRITER (Upgrade 3): the candidate chunk is now persisted (above), so
    // close the validity interval of any prior currently-valid chunk it supersedes (same
    // fact identity: source+path+span+model, different content hash). NON-LOSSY — stamps
    // validity_end + superseded_by, never deletes, so superseded rows stay queryable in
    // 'all'/'valid-at' mode. Gated default-OFF: fires ONLY when ENGRAM_SUPERSEDE_ENABLED
    // === "true", so memory-write behavior is unchanged until explicitly enabled (then it
    // is one env var to soak and one to revert). Never throws into the write path.
    //
    // 2026-10-09: no judge is passed here, so the writer HOLDS every closure it decides
    // (supersede-writer.ts SupersedeJudge). The env var alone no longer closes anything; the
    // chunk-identity trigger made 22,340 false sibling closures 08-04 → 09-03, reopened that day.
    //
    // skipSupersede (2026-09-03): indexFile already proved, with ONE indexed probe, that no
    // prior currently-valid row exists for this (source, path) strictly before `now`. That
    // probe's WHERE is this SELECT's WHERE minus the span/model/hash conjuncts, so an empty
    // probe means an empty result HERE for every chunk of the pass. Skipping is
    // behaviour-preserving, not merely cheaper: with no match decideSupersede returns
    // {action:'allow'} (supersede-writer.ts:153-155), applySupersede returns immediately for
    // a non-supersede decision (:189-191), and both the log line and the onClosed
    // trail-event hook sit inside `if (result.closed.length > 0)` (:203). No write, no log,
    // no emitAgentEvent — the only difference is the elapsed time.
    if (!skipSupersede && this.provider && process.env.ENGRAM_SUPERSEDE_ENABLED === "true") {
      try {
        supersedeContradictions(
          this.db,
          {
            id: chunkId,
            source,
            path: entry.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            model: modelKey,
            hash: chunk.hash,
            validityStart: now,
          },
          {
            mode: (process.env.ENGRAM_SUPERSEDE_MODE as SupersedeMode | undefined) ?? "supersede",
            log: (msg) => log.info(msg),
            // U3 producer: when an interval is actually closed, broadcast a
            // fork.prefrontal.trailEvent kind='recipe-supersede' (the UI's supersede
            // icon already exists). Mirrors the prefrontal-state-rpc trail-event shape
            // (phase="prefrontal-trail-event") so no UI change is needed. Best-effort —
            // the supersede-writer swallows any throw from this hook.
            onClosed: (closedIds, reason) => {
              emitAgentEvent({
                runId: "engram-supersede",
                stream: "lifecycle",
                data: {
                  phase: "prefrontal-trail-event",
                  kind: "recipe-supersede",
                  message: `superseded ${closedIds.length} prior fact(s) at ${entry.path}`,
                  icon: "🕰️",
                  label: "supersede",
                  payload: {
                    candidateId: chunkId,
                    supersededIds: closedIds,
                    path: entry.path,
                    source,
                    reason,
                  },
                  ts: Date.now(),
                },
              });
            },
          },
        );
      } catch (err) {
        // The chunk is already persisted; supersede is best-effort and must never break
        // the write path. Full object to devtools, real message to the structured log.
        console.error("[supersede-writer] non-fatal", err);
        log.warn(
          `[supersede-writer] skipped for ${chunkId} (devtools console has full error): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
