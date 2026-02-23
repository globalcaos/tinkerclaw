import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionEngramExtension from "../pi-extensions/compaction-engram.js";
import {
  createPointerCompactionHandler,
  setPointerCompactionRuntime,
} from "../pi-extensions/pointer-compaction-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { createIngestionPipeline } from "../../memory/engram/ingestion.js";
import { createEventStore } from "../../memory/engram/event-store.js";
import { setIngestionRuntime } from "../pi-extensions/ingestion-runtime.js";
import { setRetrievalRuntime } from "../pi-extensions/retrieval-runtime.js";
import { createCortexRuntime, setCortexRuntime } from "../pi-extensions/cortex-runtime.js";
import {
  createObservationExtractor,
  setObservationRuntime,
} from "../pi-extensions/observation-runtime.js";
import {
  createLimbicRuntime,
  setLimbicRuntime,
} from "../pi-extensions/limbic-runtime.js";
import { initReflectionRuntime } from "../pi-extensions/reflection-runtime.js";
import {
  createSynapseRuntime,
  setSynapseRuntime,
} from "../pi-extensions/synapse-runtime.js";

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

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" | "engram" {
  const mode = cfg?.agents?.defaults?.compaction?.mode;
  if (mode === "engram") {
    return "engram";
  }
  if (mode === "safeguard") {
    return "safeguard";
  }
  return "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  const compactionMode = resolveCompactionMode(params.cfg);
  if (compactionMode === "engram") {
    // Initialise the ENGRAM ingestion pipeline for this session.
    // Phase 1.1b will call getIngestionRuntime(sessionManager) from
    // agent-runner-execution.ts to hook every turn event.
    const engramBaseDir = join(process.env.HOME ?? "~", ".openclaw", "engram");
    mkdirSync(engramBaseDir, { recursive: true });
    const smInternal = params.sessionManager as unknown as { sessionId?: string };
    const sessionKey = smInternal.sessionId ?? "default";
    const pipeline = createIngestionPipeline({ baseDir: engramBaseDir, sessionKey });
    setIngestionRuntime(params.sessionManager, pipeline);

    // Phase 1.2: wire retrieval runtime alongside ingestion pipeline.
    // getRetrievalRuntime(sessionManager) will be called by retrieval-aware
    // turn hooks to inject the assembled pack into each turn's system prompt.
    const eventStore = createEventStore({ baseDir: engramBaseDir, sessionKey });
    setRetrievalRuntime(params.sessionManager, { eventStore });

    // Phase 1.3: register pointer compaction handler as a feature-flagged
    // alternative to narrative compaction. Works alongside compaction-engram.ts;
    // accessible via getPointerCompactionRuntime(sessionManager).
    const ptrHandler = createPointerCompactionHandler(eventStore);
    setPointerCompactionRuntime(params.sessionManager, ptrHandler);

    // Phase 1.5: wire compaction self-reflection loop.
    // After every compact() call, invoke getReflectionRuntime(sessionManager)?.reflect(...)
    // to produce a structured learning record stored as a system_event.
    initReflectionRuntime(params.sessionManager, eventStore);

    // Phase 5: wire SYNAPSE multi-model debate runtime using the same event
    // store so debate traces land in the ENGRAM event log automatically.
    setSynapseRuntime(createSynapseRuntime(eventStore));

    // Phase 3 (CORTEX): wire persona state injection, SyncScore, drift detection,
    // and observation extraction into the engram runtime.
    const cortexRuntime = createCortexRuntime();
    setCortexRuntime(params.sessionManager, cortexRuntime);

    const observationRuntime = createObservationExtractor(eventStore);
    setObservationRuntime(params.sessionManager, observationRuntime);

    // Phase 4 (LIMBIC): wire humor pipeline using CORTEX for audience modeling.
    const limbicRuntime = createLimbicRuntime(eventStore, {}, cortexRuntime);
    setLimbicRuntime(params.sessionManager, limbicRuntime);

    factories.push(compactionEngramExtension(params.cfg));
  } else if (compactionMode === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
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
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
