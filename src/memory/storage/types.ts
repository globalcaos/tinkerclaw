// Upgrade 6: trust dimension on indexed code chunks.
export type VerificationStatus = "unverified" | "partial" | "verified" | "failed";

// Upgrade 9: Zettelkasten link vocabulary. v1 similarity only emits duplicate/related;
// the richer semantic types are populated by the reflection layer.
export type LinkType = "duplicate" | "related" | "reference" | "supports" | "contradicts";

// Upgrade 9: a referrer/neighbour edge surfaced alongside a search result.
export type Backlink = {
  id: string;
  linkType: LinkType;
  linkStrength: number;
  snippet: string;
};

export type StoredChunk = {
  id: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  hash: string;
  model: string;
  text: string;
  embedding: number[];
  updatedAt: number;
  // Upgrade 3: bi-temporal validity interval + ingestion clock.
  // validityStart defaults to updatedAt at insert; validityEnd === null means
  // currently-valid/unbounded; ingestionTime is stamped once at first insert.
  validityStart?: number;
  validityEnd?: number | null;
  ingestionTime?: number;
  supersededBy?: string | null;
  // Upgrade 6: verification metadata (defaults to 'unverified' at index time).
  verificationStatus?: VerificationStatus;
  testCoveragePercent?: number | null;
  verifiedBy?: string | null;
  verificationTimestamp?: number | null;
  // Upgrade 9: denormalized cache of the durable backlinks (the backlinks table is
  // authoritative; this JSON is a rebuildable convenience copy).
  relatedChunks?: string[];
};

// Upgrade 6 (J5 Voyager skill-library-as-code): a named, reusable, versioned
// PROCEDURE distilled from a successful episode. Granularity is one skill per
// worthy episode (REM-clustering of many episodes into a higher-order skill is
// deferred). A Skill is a STRUCTURED PROCEDURE (named steps + prerequisites +
// successMetrics) with an OPTIONAL `verifiedCode` field — it is "skill-as-code"
// only when the extractor synthesized a runnable snippet, otherwise it is a
// steps[] procedure the Prefrontal kit-runner consumes like a recipe. Stored in
// a never-delete library: supersession bumps `version` and `deprecated` marks an
// obsolete entry while its body stays readable.
export type SkillTestCase = {
  input: Record<string, unknown>;
  expect: string;
};

export type SkillSuccessMetrics = {
  invocations: number;
  successes: number;
  /** Laplace-smoothed success rate: (successes + 1) / (invocations + 2). */
  successRate: number;
  /** ISO timestamp of the most recent recordOutcome, or null if never invoked. */
  lastInvoked?: string | null;
};

export type Skill = {
  skillId: string;
  version: number;
  name: string; // e.g. "merge-conflict-resolution"
  description: string;
  prerequisites: string[];
  steps: string[]; // language-agnostic procedure
  testCases: SkillTestCase[];
  successMetrics: SkillSuccessMetrics;
  sourceEpisodeIds: string[];
  created: string; // ISOString
  deprecated: boolean;
  /**
   * OPTIONAL true-Voyager "skill-as-code": a runnable snippet the extractor
   * synthesized + verified for this skill. Absent for pure structured-procedure
   * skills (the default). Its presence is what distinguishes a skill from a
   * plain auto-generated recipe.
   */
  verifiedCode?: string;
};

/** Lightweight handle to a stored Skill (the search/rank return shape). */
export type SkillRef = {
  skillId: string;
  version: number;
  name: string;
  description: string;
  successRate: number;
  deprecated: boolean;
  /** Relevance score when returned from a search; absent for rank(). */
  score?: number;
};

export type SearchResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  // Upgrade 6: surface trust so callers can see why a result ranked where it did.
  verificationStatus?: VerificationStatus;
  testCoveragePercent?: number | null;
  // Upgrade 9: opt-in hydrated neighbours (only present when SearchParams.backlinks).
  backlinks?: Backlink[];
};

export type SearchParams = {
  queryVec?: number[];
  queryText?: string;
  limit: number;
  providerModel: string; // for filtering chunks by model
  sources: string[];
  snippetMaxChars: number;
  minScore?: number;
  hybridWeights?: {
    vector: number;
    text: number;
  };
  // Upgrade 3: which temporal slice to query. 'current' (default) returns only facts
  // whose validity interval is open or extends past now; 'valid-at' returns the slice
  // that was true at asOfTime; 'all' ignores the temporal predicate.
  temporalMode?: "current" | "valid-at" | "all";
  asOfTime?: number;
  // Upgrade 6: trust filters/boost knobs.
  verificationRequired?: boolean;
  minTestCoverage?: number;
  // Upgrade 9: opt-in backlink hydration (off by default to avoid N+1 on every search).
  backlinks?: boolean;
};

export type EmbeddingCacheKey = {
  provider: string;
  model: string;
  hash: string;
  providerKey?: string;
};

export interface MemoryStore {
  // Initialization
  init(): Promise<void>;
  close(): Promise<void>;

  // Metadata
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;

  // File Tracking
  getFileHash(path: string, source: string): Promise<string | null>;
  listFilePaths(source: string): Promise<string[]>;
  setFile(path: string, source: string, hash: string, mtime: number, size: number): Promise<void>;

  // Removes file record AND its chunks
  removeFile(path: string, source: string): Promise<void>;

  // Chunk Management
  // Inserts chunks. Implementation should handle transaction/batching.
  insertChunks(chunks: StoredChunk[]): Promise<void>;

  // Search
  // Should handle vector search, keyword search, or hybrid depending on capabilities and params
  search(params: SearchParams): Promise<SearchResult[]>;

  // Embedding Cache
  getCachedEmbedding(key: EmbeddingCacheKey): Promise<number[] | null>;
  setCachedEmbedding(key: EmbeddingCacheKey, embedding: number[]): Promise<void>;

  // Maintenance
  // e.g. optimize, vacuum, cleanup
  maintenance?(): Promise<void>;

  getStats(sources: string[]): Promise<{
    files: number;
    chunks: number;
    sourceCounts: Array<{ source: string; files: number; chunks: number }>;
    cacheEntries: number;
  }>;
}
