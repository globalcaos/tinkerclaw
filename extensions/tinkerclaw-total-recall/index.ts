/**
 * FORK: Total Recall extension entry point -- ENGRAM episodic memory system.
 *
 * Provides event store, ingestion pipeline, FTS + vector retrieval, pointer
 * compaction, sleep consolidation, entity extraction, contradiction gate,
 * and recall tool. Wired into the OpenClaw plugin SDK as a memory extension.
 *
 * Hooks:
 *   - before_prompt_build (priority 50): retrieval pack injection
 *   - llm_output: assistant response ingestion (fire-and-forget)
 *   - before_compaction: persist messages being compacted
 *
 * Tool:  recall (query + optional limit)
 * Gateway method: engram.search (Tinker UI search)
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/total-recall.json`
 * so other extensions (e.g. Round Table) can detect Total Recall availability.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { Type, type Static } from "@sinclair/typebox";
import { createIngestionPipeline, type IngestionPipeline } from "./src/ingestion.js";
import { createEventStore, type EventStore } from "./src/event-store.js";
import { assembleRetrievalPack } from "./src/retrieval-integration.js";
import { recall as recallSearch } from "./src/recall-tool.js";

// -- Constants --

const ENGRAM_BASE_DIR = join(homedir(), ".openclaw", "engram");
const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");

// -- Tool Schema (TypeBox) --

const RecallParams = Type.Object({
  query: Type.String({ description: "Search query for memory retrieval." }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results to return (default 10)." }),
  ),
});

type RecallInput = Static<typeof RecallParams>;

// -- Cross-extension state helpers --

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeSharedState(): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    TOTAL_RECALL_STATE_PATH,
    JSON.stringify(
      {
        active: true,
        baseDir: ENGRAM_BASE_DIR,
        version: "1.0.0",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

// -- Per-session pipeline cache --

const pipelineCache = new Map<string, IngestionPipeline>();
const storeCache = new Map<string, EventStore>();

function getOrCreatePipeline(sessionKey: string): IngestionPipeline {
  let pipeline = pipelineCache.get(sessionKey);
  if (!pipeline) {
    pipeline = createIngestionPipeline({
      baseDir: ENGRAM_BASE_DIR,
      sessionKey,
    });
    pipelineCache.set(sessionKey, pipeline);
    storeCache.set(sessionKey, pipeline.eventStore);
  }
  return pipeline;
}

function getOrCreateStore(sessionKey: string): EventStore {
  let store = storeCache.get(sessionKey);
  if (!store) {
    store = createEventStore({ baseDir: ENGRAM_BASE_DIR, sessionKey });
    storeCache.set(sessionKey, store);
  }
  return store;
}

// -- Plugin Entry --

export default definePluginEntry({
  id: "tinkerclaw-total-recall",
  name: "Total Recall",
  description:
    "ENGRAM -- Episodic memory with FTS + vector retrieval, pointer compaction, " +
    "sleep consolidation, and artifact externalization.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const budgetTokens = (cfg.budgetTokens as number) ?? 2000;
    const _embeddingProvider = (cfg.embeddingProvider as string) ?? "ollama";
    const _embeddingModel = (cfg.embeddingModel as string) ?? "mxbai-embed-large";

    // Bootstrap engram directory
    try {
      ensureDir(ENGRAM_BASE_DIR);
    } catch (err) {
      api.logger.warn(`[total-recall] failed to create engram dir: ${err}`);
    }

    // Write cross-extension state for discovery
    try {
      writeSharedState();
    } catch (err) {
      api.logger.warn(`[total-recall] failed to write shared state: ${err}`);
    }

    // -------------------------------------------------------------------
    // Hook 1: before_prompt_build (priority 50)
    // Injects retrieval pack into system prompt. Lower priority than
    // Identity Persistence (100) so persona block comes first.
    // -------------------------------------------------------------------
    api.on(
      "before_prompt_build",
      async (
        payload: { prompt?: string; query?: string; userMessage?: string },
        context: { sessionKey?: string },
      ) => {
        const sessionKey = context.sessionKey ?? "main";

        // Skip automated sessions
        if (sessionKey.includes("heartbeat") || sessionKey.includes("cron")) {
          return;
        }

        const query =
          payload.query ?? payload.userMessage ?? payload.prompt ?? "";
        if (!query.trim()) {
          return;
        }

        const store = getOrCreateStore(sessionKey);
        if (store.count() === 0) {
          return;
        }

        try {
          const pack = assembleRetrievalPack(query, store, {
            maxTokens: budgetTokens,
          });
          if (!pack) {
            return;
          }

          return {
            prependSystemContext:
              "## Retrieved Memory Context\n\n" + pack + "\n",
          };
        } catch (err) {
          api.logger.warn(`[total-recall] retrieval failed: ${err}`);
          return;
        }
      },
      { priority: 50 },
    );

    // -------------------------------------------------------------------
    // Hook 2: llm_output -- event ingestion (fire-and-forget)
    // Captures assistant response text as an event in the store.
    // -------------------------------------------------------------------
    api.on(
      "llm_output",
      async (
        payload: { text?: string; content?: string },
        context: { sessionKey?: string },
      ) => {
        const sessionKey = context.sessionKey ?? "main";

        // Skip heartbeat and cron sessions
        if (sessionKey.includes("heartbeat") || sessionKey.includes("cron")) {
          return;
        }

        const text = payload.text ?? payload.content ?? "";
        if (!text.trim()) {
          return;
        }

        try {
          const pipeline = getOrCreatePipeline(sessionKey);
          pipeline.ingestAssistantMessage(text, Date.now());
        } catch (err) {
          api.logger.warn(`[total-recall] ingestion failed: ${err}`);
        }
      },
    );

    // -------------------------------------------------------------------
    // Hook 3: before_compaction -- persist messages being compacted
    // Ingests messages into event store before they are lost to compaction.
    // -------------------------------------------------------------------
    api.on(
      "before_compaction",
      async (
        payload: {
          messages?: ReadonlyArray<{
            role: string;
            content?: unknown;
            toolName?: string;
            isError?: boolean;
          }>;
        },
        context: { sessionKey?: string },
      ) => {
        const sessionKey = context.sessionKey ?? "main";
        const messages = payload.messages;

        if (!messages || messages.length === 0) {
          return;
        }

        try {
          const pipeline = getOrCreatePipeline(sessionKey);
          await pipeline.ingest(messages);
          api.logger.info(
            `[total-recall] compaction: ingested ${messages.length} messages (session=${sessionKey})`,
          );
        } catch (err) {
          api.logger.warn(`[total-recall] compaction ingestion failed: ${err}`);
        }
      },
    );

    // -------------------------------------------------------------------
    // Tool: recall -- memory search
    // -------------------------------------------------------------------
    api.registerTool(
      () => ({
        name: "recall",
        label: "Memory Recall",
        description:
          "Search ENGRAM episodic memory for relevant past events, conversations, " +
          "and tool results. Returns scored, deduplicated results within a token budget.",
        parameters: RecallParams,
        async execute(
          _toolCallId: string,
          params: RecallInput,
          context?: { sessionKey?: string },
        ) {
          const sessionKey = context?.sessionKey ?? "main";
          const store = getOrCreateStore(sessionKey);
          const limit = params.limit ?? 10;

          const result = await recallSearch(
            { query: params.query, maxTokens: limit * 400 },
            store,
          );

          const formatted = result.events.map((e) => ({
            id: e.event.id,
            timestamp: e.event.timestamp,
            kind: e.event.kind,
            content:
              e.event.content.length > 500
                ? e.event.content.slice(0, 500) + "..."
                : e.event.content,
            score: Math.round(e.score * 1000) / 1000,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    results: formatted,
                    totalTokens: result.totalTokens,
                    truncated: result.truncated,
                    queryCount: result.queryCount,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      }),
      { optional: true },
    );

    // -------------------------------------------------------------------
    // Gateway method: engram.search -- Tinker UI search endpoint
    // -------------------------------------------------------------------
    api.registerGatewayMethod(
      "engram.search",
      async ({ params, respond }: {
        params: Record<string, unknown>;
        respond: (data: unknown) => void;
      }) => {
        const query = (params.query as string) ?? "";
        const sessionKey = (params.sessionKey as string) ?? "main";
        const limit = (params.limit as number) ?? 20;

        if (!query.trim()) {
          respond({ results: [], error: "empty query" });
          return;
        }

        try {
          const store = getOrCreateStore(sessionKey);
          const result = await recallSearch(
            { query, maxTokens: limit * 400 },
            store,
          );

          respond({
            results: result.events.map((e) => ({
              id: e.event.id,
              timestamp: e.event.timestamp,
              kind: e.event.kind,
              content: e.event.content,
              score: Math.round(e.score * 1000) / 1000,
              sessionKey: e.event.sessionKey,
            })),
            totalTokens: result.totalTokens,
            truncated: result.truncated,
          });
        } catch (err) {
          respond({ results: [], error: String(err) });
        }
      },
    );

    api.logger.info(
      `[total-recall] ready (budget=${budgetTokens}, baseDir=${ENGRAM_BASE_DIR})`,
    );
  },
});
