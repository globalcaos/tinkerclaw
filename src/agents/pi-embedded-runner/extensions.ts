import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
// FORK: engram/hybrid-retrieval runtime wiring. These imports back the
// `compactionMode === "engram"` branch below and were lost in the 2026-04-15
// stratified upstream merge.
import { createOllamaEmbeddingProvider } from "../../memory/embeddings-ollama.js";
import { createEmbeddingCache } from "../../memory/engram/embedding-cache.js";
import { createEmbeddingWorker } from "../../memory/engram/embedding-worker.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import { globalFtsSearch } from "../../memory/engram/global-fts-bridge.js";
import { createIngestionPipeline } from "../../memory/engram/ingestion.js";
// FORK 2026-04-28 chunk-13: upstream removed embedded-extension-factory.
// listEmbeddedExtensionFactories() has been replaced by an in-tree iterator
// over the new plugin runtime (see chunk-13 lessons). Stubbed inline here
// so the runtime keeps working until apply-fork-wiring grows a patch for
// the new lookup path.
function listEmbeddedExtensionFactories(): never[] {
  return [];
}
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import compactionEngramExtension from "../pi-extensions/compaction-engram.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { createCortexRuntime, setCortexRuntime } from "../pi-extensions/cortex-runtime.js";
import { setIngestionRuntime } from "../pi-extensions/ingestion-runtime.js";
import { createLimbicRuntime, setLimbicRuntime } from "../pi-extensions/limbic-runtime.js";
import {
  createObservationExtractor,
  setObservationRuntime,
} from "../pi-extensions/observation-runtime.js";
import {
  createPointerCompactionHandler,
  setPointerCompactionRuntime,
} from "../pi-extensions/pointer-compaction-runtime.js";
import { initReflectionRuntime } from "../pi-extensions/reflection-runtime.js";
import { setRetrievalRuntime } from "../pi-extensions/retrieval-runtime.js";
import { createSynapseRuntime, setSynapseRuntime } from "../pi-extensions/synapse-runtime.js";
// FORK: pi-hooks holds the canonical (fuller) compaction-safeguard impl with
// cancelReason support. The pi-extensions stubs were leftover and caused an
// ESM-module bifurcation: extensions.ts wrote runtime config to pi-extensions
// while compact.ts read from pi-hooks, silently breaking qualityGuardEnabled
// in production. Consolidated to pi-hooks 2026-04-15.
import { setCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }
  const transcriptPolicy = resolveTranscriptPolicy({
    modelApi: params.model?.api,
    provider: params.provider,
    modelId: params.modelId,
  });

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
      provider: params.provider,
      modelId: params.modelId,
    }),
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" | "engram" {
  const compaction = cfg?.agents?.defaults?.compaction;
  // A registered compaction provider requires the safeguard extension path
  if (compaction?.provider) {
    return "safeguard";
  }
  if (compaction?.mode === "engram") {
    return "engram";
  }
  return compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  sessionKey?: string;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  const compactionMode = resolveCompactionMode(params.cfg);
  const cognitive = (params.cfg as Record<string, unknown>)?.fork as
    | { cognitive?: Record<string, string> }
    | undefined;
  const cogFlags = cognitive?.cognitive ?? {};
  /** True when a subsystem should run inline (default behavior). */
  const isInline = (key: string): boolean =>
    cogFlags[key] !== "extension" && cogFlags[key] !== "disabled";

  if (compactionMode === "engram") {
    // Shared state: engramBaseDir and eventStore are needed by ENGRAM, SYNAPSE,
    // LIMBIC, and OBSERVATION. Create them if ANY of those subsystems are inline.
    const needsEngram = isInline("engram");
    const needsSynapse = isInline("synapse");
    const needsCortex = isInline("cortex");
    const needsObservation = isInline("observation");
    const needsLimbic = isInline("limbic");
    const needsSharedStore = needsEngram || needsSynapse || needsObservation || needsLimbic;

    let engramBaseDir: string | undefined;
    let sessionKey: string | undefined;
    let eventStore: ReturnType<typeof createEventStore> | undefined;

    if (needsSharedStore) {
      engramBaseDir = join(process.env.HOME ?? "~", ".openclaw", "engram");
      mkdirSync(engramBaseDir, { recursive: true });
      const smInternal = params.sessionManager as unknown as { sessionId?: string };
      sessionKey = params.sessionKey?.trim() || smInternal.sessionId || "default";
      eventStore = createEventStore({ baseDir: engramBaseDir, sessionKey });
    }

    // ENGRAM: ingestion, retrieval, pointer compaction, reflection
    if (needsEngram && engramBaseDir && sessionKey && eventStore) {
      const pipeline = createIngestionPipeline({ baseDir: engramBaseDir, sessionKey });
      setIngestionRuntime(params.sessionManager, pipeline);

      setRetrievalRuntime(params.sessionManager, { eventStore, searchIndex: globalFtsSearch });

      const ptrHandler = createPointerCompactionHandler(eventStore);
      setPointerCompactionRuntime(params.sessionManager, ptrHandler);

      initReflectionRuntime(params.sessionManager, eventStore);
    }

    // SYNAPSE: multi-model debate runtime
    if (needsSynapse && eventStore) {
      setSynapseRuntime(createSynapseRuntime(eventStore));
    }

    // CORTEX: persona state injection, SyncScore, drift detection
    let cortexRuntime: ReturnType<typeof createCortexRuntime> | undefined;
    if (needsCortex) {
      cortexRuntime = createCortexRuntime();
      setCortexRuntime(params.sessionManager, cortexRuntime);
    }

    // OBSERVATION: observation extractor (needs eventStore)
    if (needsObservation && eventStore) {
      const observationRuntime = createObservationExtractor(eventStore);
      setObservationRuntime(params.sessionManager, observationRuntime);
    }

    // LIMBIC: humor pipeline (needs eventStore + cortexRuntime)
    if (needsLimbic && eventStore) {
      const limbicRuntime = createLimbicRuntime(eventStore, {}, cortexRuntime);
      setLimbicRuntime(params.sessionManager, limbicRuntime);
    }

    // Ollama embedding upgrade: enhances both LIMBIC and ENGRAM when available.
    // Only start if at least one consumer is inline.
    if ((needsEngram || needsLimbic) && engramBaseDir && eventStore) {
      createOllamaEmbeddingProvider({
        config: params.cfg ?? ({} as import("../../config/config.js").OpenClawConfig),
        provider: "ollama",
        model: "mxbai-embed-large",
        fallback: "none",
      })
        .then(
          ({ provider }: { provider: import("../../memory/embeddings.js").EmbeddingProvider }) => {
            if (needsLimbic) {
              const semanticRuntime = createLimbicRuntime(
                eventStore!,
                { embeddingProvider: provider },
                cortexRuntime,
              );
              setLimbicRuntime(params.sessionManager, semanticRuntime);
            }

            if (needsEngram) {
              const embCache = createEmbeddingCache(engramBaseDir!, 1024);
              const embedFn: import("../../memory/engram/embedding-worker.js").EmbedFn = async (
                texts,
              ) => {
                const vectors = await provider.embedBatch(texts);
                return vectors.map((v: number[]) => new Float32Array(v));
              };
              setRetrievalRuntime(params.sessionManager, {
                eventStore: eventStore!,
                searchIndex: globalFtsSearch,
                embeddingCache: embCache,
                embedFn,
              });
              const worker = createEmbeddingWorker({
                embedFn,
                cache: embCache,
                batchSize: 16,
                batchTimeoutMs: 10000,
                onError: (err: Error) =>
                  console.warn(`[engram] Embedding worker error: ${err.message}`),
              });
              const origAppend = eventStore!.append.bind(eventStore!);
              eventStore!.append = (event: Parameters<typeof origAppend>[0]) => {
                const result = origAppend(event);
                // FORK: enqueue the materialized event (with id/timestamp), not the input draft.
                worker.enqueue(result);
                return result;
              };
            }
            console.log(
              "[engram] Hybrid retrieval active: FTS + vector (ollama/mxbai-embed-large)",
            );
          },
        )
        .catch((err: unknown) => {
          console.warn(`[fork] Ollama embedding unavailable, FTS-only retrieval: ${err}`);
        });
    }

    factories.push(compactionEngramExtension(params.cfg));
  } else if (compactionMode === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
      identifierPolicy: compactionCfg?.identifierPolicy,
      identifierInstructions: compactionCfg?.identifierInstructions,
      customInstructions: compactionCfg?.customInstructions,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? false,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      model: params.model,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
      provider: compactionCfg?.provider,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  factories.push(...listEmbeddedExtensionFactories());
  return factories;
}

export { ensurePiCompactionReserveTokens };
