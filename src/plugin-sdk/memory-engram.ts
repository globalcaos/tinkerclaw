/**
 * FORK: focused plugin-SDK surface for the ENGRAM episodic-memory library.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ENGRAM library lives once, at `src/memory/engram/`. Extensions may not
 * import the repo `src/` tree directly (`pnpm lint:plugins:no-extension-src-imports`),
 * and `tinkerclaw-total-recall` instead carried a private 26-file copy of the whole
 * library for four months. That copy drifted exactly as you would expect: a second
 * `vectorSearch` beside the one its own byte-identical `search-index.ts` already
 * exported, a `temporal-decay.ts` whose header described a wiring that did not
 * exist, a `knowledge-compiler.ts` that never executed on any path, and the
 * `engram:retrieval-pack-inject` instrument welded to whichever copy was dead — so
 * the liveness registry reported the inverse of the truth.
 *
 * WHY A SUBPATH AND NOT THE ALLOWLIST. `check-no-extension-src-imports.ts` carries a
 * FORK_EXTENSION_ALLOWLIST, and it predates this plugin by eight days (013711df4c4,
 * 2026-03-22, vs 7220c637582, 2026-03-30). Adding total-recall to it was available
 * the whole time — and would have been WRONG. An allowlist entry is a lint exemption
 * and nothing more. This plugin is `publishToNpm: true`, ships `files: ["index.ts",
 * "src/", ...]`, and declares `openclaw` only as an OPTIONAL peerDependency, so a
 * relative `../../src/**` reach is unresolvable inside the published tarball no
 * matter what the linter has been told to ignore. The lint would have gone green and
 * the package would have thrown ERR_MODULE_NOT_FOUND on first recall.
 *
 * A subpath is the only crossing that survives packaging: it resolves through the
 * `openclaw` peer's generated `exports` map. It is also the fix the rule's own error
 * message prescribes ("Publish a focused openclaw/plugin-sdk/<subpath> surface"), and
 * the one upstream shipped the rule WITH — a0aba7302a4 added the checker and
 * `channel-runtime`, `config-runtime`, `agent-runtime` and four `*-core` subpaths in
 * the same commit. The boundary was never "don't touch core"; it is "cross through a
 * versioned surface."
 *
 * The decision rule, for the next person: published (npm or ClawHub) -> SUBPATH,
 * always. Bundled-only and in the unified build graph -> the allowlist is fine.
 * Bundled-only but `stageRuntimeDependencies: true` -> the extension gets its own
 * rolldown graph and a relative `src/` import INLINES A SECOND COPY of core into the
 * plugin bundle (tsdown.config.ts:288-341); allowlist only if that module is
 * globalThis-hardened or stateless, and check rather than assume.
 *
 * NOT CLAIMED: that the lint rule is why the copy was made. Nothing in the history
 * says so — `git log -S '"../../src/'` over this extension is empty, and it was never
 * on the allowlist. The library predates the copy by 2h29m on 2026-03-30, so it is
 * genuinely a copy; the motive is unrecorded.
 *
 * SCOPE
 * -----
 * Deliberately narrow: the symbols a memory *plugin* needs to store events,
 * ingest turns, answer a recall query, and build a retrieval pack. It is NOT a
 * re-export of the library. Widening it is a design decision — add the symbol
 * here on purpose, never `export *`, and never so a caller can reach past the
 * library's own public functions into its internals.
 *
 * see also: TINKER_UI_DESIGN_BIBLE/canonical-derivations.md,
 *           TINKER_UI_DESIGN_BIBLE/memory-layout.md
 */

export {
  createEventStore,
  estimateTokens,
  generateULID,
  type EventStore,
  type EventStoreOptions,
} from "../memory/engram/event-store.js";

export {
  createIngestionPipeline,
  type IngestableMessage,
  type IngestionPipeline,
  type IngestionPipelineConfig,
} from "../memory/engram/ingestion.js";

export {
  recall,
  createRecallLimiter,
  type RecallDeps,
  type RecallOptions,
  type RecallResult,
  type ScoredRecallEvent,
} from "../memory/engram/recall-tool.js";

export {
  assembleRetrievalPack,
  DEFAULT_RETRIEVAL_MAX_TOKENS,
  type AssembleOptions,
} from "../memory/engram/retrieval-integration.js";

export {
  NON_EVICTABLE_KINDS,
  type EventKind,
  type EventMetadata,
  type MemoryEvent,
} from "../memory/engram/event-types.js";
