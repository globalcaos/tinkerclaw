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

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { declareInstrument, noteInstrumentFired } from "openclaw/plugin-sdk/fork-instrumentation";
// The ENGRAM library is NOT vendored into this extension. It lives once, at
// src/memory/engram/, and reaches this plugin through the sanctioned SDK
// surface. A private copy used to live in ./src/ and drifted for four months —
// see src/plugin-sdk/memory-engram.ts and
// TINKER_UI_DESIGN_BIBLE/canonical-derivations.md.
import {
  assembleRetrievalPack,
  createEventStore,
  createIngestionPipeline,
  recall as recallSearch,
  type EventStore,
  type IngestionPipeline,
} from "openclaw/plugin-sdk/memory-engram";

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

// -- engram.search gateway handler (FORK 2026-08-02) --------------------------
//
// INVARIANT: a gateway RPC handler answers through the gateway's RespondFn, whose
// signature is `(ok: boolean, payload?: unknown, error?: ErrorShape, meta?)`
// (src/gateway/server-methods/shared-types.ts:33-38). The ws layer forwards those
// slots verbatim: `send({ type: "res", id: req.id, ok, payload, error })`
// (src/gateway/server/ws-connection/message-handler.ts:1531-1537), and `ok` is
// schema-typed as a boolean, so a non-boolean there does not survive as a usable
// response.
//
// This handler used to declare its OWN `respond: (data: unknown) => void` and call
// `respond({ results, ... })`. The results object landed in the `ok` slot and
// `payload` stayed undefined, so `engram.search` never produced a usable response
// frame -- every caller hung until its own timeout (measured: a 150 s client
// timeout, while an UNKNOWN method errored instantly, which is the tell that the
// method was found and simply never answered).
//
// The fix is structural, not cosmetic: the handler argument is derived from the
// LIVE `registerGatewayMethod` signature, so the real RespondFn is in scope and a
// single-argument `respond({...})` becomes a COMPILE error instead of a silent hang.

/** The exact argument the gateway hands a plugin-registered RPC handler. */
type GatewayMethodHandlerArg = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

/** One `engram.search` hit, as the Tinker UI consumes it. */
export type EngramSearchHit = {
  id: string;
  timestamp: string;
  kind: string;
  content: string;
  score: number;
  sessionKey: string;
};

export type EngramSearchPayload = {
  results: EngramSearchHit[];
  totalTokens: number;
  truncated: boolean;
};

/** Upper bound on `limit`, so a typo'd or hostile value cannot blow the token budget. */
const ENGRAM_SEARCH_MAX_LIMIT = 200;
const ENGRAM_SEARCH_DEFAULT_LIMIT = 20;
/** Rough tokens-per-result used to turn `limit` into a recall token budget. */
const ENGRAM_SEARCH_TOKENS_PER_RESULT = 400;

/**
 * `engram.search` gateway RPC. Exported (rather than inlined in `register`) so the
 * respond-arity contract can be asserted directly by a unit test with a stub respond.
 */
export async function handleEngramSearch({
  params,
  respond,
}: Pick<GatewayMethodHandlerArg, "params" | "respond">): Promise<void> {
  const p = (params ?? {}) as { query?: unknown; sessionKey?: unknown; limit?: unknown };
  const query = typeof p.query === "string" ? p.query : "";
  const sessionKey =
    typeof p.sessionKey === "string" && p.sessionKey.trim() ? p.sessionKey.trim() : "main";
  const limit = Math.max(
    1,
    Math.min(
      ENGRAM_SEARCH_MAX_LIMIT,
      Number(p.limit ?? ENGRAM_SEARCH_DEFAULT_LIMIT) || ENGRAM_SEARCH_DEFAULT_LIMIT,
    ),
  );

  if (!query.trim()) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "query is required" });
    return;
  }

  let payload: EngramSearchPayload;
  try {
    const store = getOrCreateStore(sessionKey);
    const result = await recallSearch(
      { query, maxTokens: limit * ENGRAM_SEARCH_TOKENS_PER_RESULT },
      store,
    );
    payload = {
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
    };
  } catch (err) {
    respond(false, undefined, {
      code: "UNAVAILABLE",
      message: `engram.search failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // Deliberately OUTSIDE the try: a throw from respond() itself must not fall into
  // the catch and emit a SECOND response frame for the same request id.
  respond(true, payload);
}

// -- Retrieval pack stability (FORK 2026-07-29) --------------------------------
//
// The Total Recall paper (§3) specifies a TASK-conditioned push pack: Task State,
// time-range markers and the hot tail, at ~2K tokens. Task-conditioned means it
// changes when the TASK changes, which is what makes principle (6) --
// "prompt-cache-friendly ordering" -- true by construction.
//
// What shipped is QUERY-conditioned: assembleRetrievalPack() runs FTS + vector
// search over the live user message every turn, and its "task-conditioned
// scoring" step calls createDefaultTaskState(taskId ?? "default")
// (src/retrieval-integration.ts:202) -- a blank default manufactured per call.
// The paper's Task State is never built, so nothing stabilises the pack.
//
// MEASURED COST (140 captured turns of agent:main:main, ~/.openclaw/forensic-dumps):
//   - the `retrieved_context` section: 7,796 chars, 126 DISTINCT values / 140 turns
//   - whole system prompt: 133 distinct hashes / 140 turns
//   - `deriveSessionKey` (tinker-bridge stream.ts:166-188) djb2-hashes the system
//     prompt into the claude-cli worker-pool key, so a per-turn-varying pack means
//     pool.getOrCreate MISSES every turn: 109 "spawning claude" events against ~101
//     turns on 2026-07-28. A cold subprocess per turn, each re-attaching with
//     --resume against a transcript of up to 8.9 MB.
//
// The fix is not to move the pack -- it is to make it behave as the paper says.
// We rebuild only when the task has plausibly moved (new events accumulated, or
// age), and otherwise return the SAME BYTES, so the prefix is stable across turns.
// Query-specific retrieval is not lost: it is exactly what the `recall` tool below
// is for, which is the paper's pull half and costs nothing when unused.
export interface CachedPack {
  pack: string;
  eventCount: number;
  ccEventCount: number;
  builtAtMs: number;
}
const packCache = new Map<string, CachedPack>();

// The CC-experience store is written by an EXTERNAL process — the jarvis-memory-bridge
// SessionEnd hook — but createEventStore() memoises the file on first read
// (`loadCache(): if (cache) return cache`) and only ever grows that cache from its own
// append(). A long-lived gateway therefore serves a snapshot frozen at first use.
//
// Measured: the pack kept reporting ccEvents=341 for hours after the bridge had written
// 680, because the store had been loaded before the sync. That makes the whole bus
// restart-gated, which defeats its purpose — what Claude Code learns should reach Jarvis
// without bouncing the gateway.
//
// Re-stat the file and drop the memoised store when it changes. Cost is one stat() per
// pack rebuild, and rebuilds are already throttled to 20 events / 30 min.
let ccStoreStamp = "";

function getCcExperienceStore(): EventStore {
  const p = join(ENGRAM_BASE_DIR, "events", `${CC_EXPERIENCE_SESSION_KEY}.jsonl`);
  let stamp = "absent";
  try {
    const st = statSync(p);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* not written yet — "absent" is a valid stamp and still detects first appearance */
  }
  if (stamp !== ccStoreStamp) {
    storeCache.delete(CC_EXPERIENCE_SESSION_KEY);
    ccStoreStamp = stamp;
  }
  return getOrCreateStore(CC_EXPERIENCE_SESSION_KEY);
}

// -- Claude Code experience (FORK 2026-07-29) ---------------------------------
//
// Jarvis is persistent; a Claude Code session is ephemeral. Everything a CC
// session learned used to die with it except what someone hand-wrote into a
// memory file. `plugins/jarvis-memory-bridge` (in the jarvis-icu repo) syncs that
// curated distillate — CC's memory/*.md and its cross-session handoff — into a
// DEDICATED engram store on SessionEnd.
//
// Kept in its own sessionKey rather than merged into Jarvis's session log, on
// purpose: the two must never be confused. Jarvis's own events are what IT did;
// these are what a different agent learned. They are retrieved together but
// scored separately and labelled distinctly in the pack, so provenance survives
// all the way to the prompt.
const CC_EXPERIENCE_SESSION_KEY = "cc-experience";
/** Share of the pack budget reserved for cross-session CC experience. */
const CC_EXPERIENCE_BUDGET_SHARE = 0.35;

/** Rebuild once this many new events have landed — the task has plausibly moved on. */
const PACK_REBUILD_EVENT_DELTA = 20;
/** Rebuild at least this often regardless, so a long quiet task still refreshes. */
const PACK_REBUILD_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Announce a pre-prompt stage to the UI.
 *
 * Everything between `chat.send` and the model being named is invisible to the client:
 * the gateway emits nothing, so the pill can only say "sending". Measured, that window
 * is 21-36s. These events give it something true to say.
 *
 * Contract (shared with the prefrontal plugin and tinker-ui):
 *   stream "turn-phase", data { phase, label }, sessionKey = the MAIN session key
 *   (UI consumers gate on it), runId from the ambient run context.
 *
 * Strictly best-effort: a telemetry event must never break a turn, and a missing run
 * context simply means there is nothing to attribute the phase to.
 */
/**
 * FORK 2026-08-23 (the architect: "expand 'total recall - engram' like you did with 'preparing
 * context'"). Total Recall is the largest single plugin on the pre-model path, and until now it
 * reported ONE number. Its two halves are fixed by completely different changes — `storeLoad` is
 * disk and JSON.parse, `packBuild` is search and ranking — so a single total hides which to
 * attack. Emitted on the same `turn-stage` stream the runner uses, so the breakdown TILES with
 * the runner stages instead of inventing a second nesting mechanism.
 */
function emitTurnStage(runId: string | undefined, sessionKey: string, stage: string, ms: number) {
  try {
    if (!runId || !sessionKey) {
      // FORK 2026-08-24 — this bail used to be silent, while the caller's `pack rebuilt …
      // tookMs=${emitBuildStage(...)}` log line printed either way. The log line was then read as
      // proof the stage had been emitted; it only proves the duration was computed. Log the drop.
      console.log(
        `[total-recall] [turn-stage] DROPPED stage=${stage} reason=${!runId ? "no-runId" : "no-sessionKey"}`,
      );
      return;
    }
    // `plugin` lets the UI attach this stage to the "Total Recall · ENGRAM" row instead of to the
    // generic "preparing context" bracket, which is where every stage landed before.
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "turn-stage",
      data: { stage, ms, plugin: "tinkerclaw-total-recall" },
    });
  } catch (err) {
    console.log(`[total-recall] [turn-stage] DROPPED stage=${stage} reason=threw ${String(err)}`);
  }
}

/** Emit the build stage AND return its duration, so the log line and the row cannot disagree. */
function emitBuildStage(runId: string | undefined, sessionKey: string, startedAt: number): number {
  const ms = Date.now() - startedAt;
  emitTurnStage(runId, sessionKey, "engram-search-rank", ms);
  return ms;
}

export function emitTurnPhase(
  runId: string | undefined,
  sessionKey: string,
  phase: string,
  label: string,
): void {
  try {
    // The run id comes from the HOOK CONTEXT. `getAgentRunContext(runId)` is a lookup by
    // id, not an ambient accessor — calling it bare returns undefined, which silently
    // skipped every emit on the first attempt at this.
    if (!runId || !sessionKey) {
      return;
    }
    emitAgentEvent({ runId, sessionKey, stream: "turn-phase", data: { phase, label } });
  } catch {
    /* never let telemetry break a turn */
  }
}

/**
 * True when the cached pack may be reused verbatim (the cache-preserving path).
 *
 * FORK 2026-08-19 — THE CC CLAUSE NOW TOLERATES THE SAME DRIFT AS THE SESSION CLAUSE.
 *
 * It used to be `ccEventCount !== cached.ccEventCount`, i.e. ANY change to the CC store
 * invalidated immediately. The stated intent was that a synced correction should reach
 * the next turn rather than wait out the 30-minute throttle. The effect was different in
 * two ways that make it a bad trade:
 *
 *   1. `cc-experience` is ONE store shared by every session, written by an out-of-process
 *      sync hook ~28x/day. So each write did not invalidate "the session that got a
 *      correction" — it invalidated EVERY cached pack in the gateway simultaneously.
 *   2. An invalidated pack is not merely a rebuild. The pack text goes into the system
 *      prompt, so a changed pack changes `deriveSessionKey`, which respawns the claude-cli
 *      worker (measured 2.3s p50 cold-vs-warm) and rewrites the provider's prompt-cache
 *      prefix instead of re-reading it. Measured fleet-wide: 89% of turns spawn cold
 *      (755 of 846 over 7 days), and one UI conversation produced 21 distinct prompt
 *      fingerprints across 31 turns.
 *
 * The freshness the old clause bought is mostly still there for free: `PACK_REBUILD_MAX_AGE_MS`
 * below caps ANY pack at 30 minutes old regardless of counts. So the real change is
 * worst-case CC-correction latency "next turn" -> "within 30 minutes", in exchange for
 * ~28 fleet-wide invalidation storms a day becoming ~1.4.
 */
export function packIsStillFresh(
  cached: CachedPack | undefined,
  eventCount: number,
  ccEventCount: number,
  nowMs: number,
): boolean {
  if (!cached) {
    return false;
  }
  if (eventCount - cached.eventCount >= PACK_REBUILD_EVENT_DELTA) {
    return false;
  }
  if (ccEventCount - cached.ccEventCount >= PACK_REBUILD_EVENT_DELTA) {
    return false;
  }
  return nowMs - cached.builtAtMs < PACK_REBUILD_MAX_AGE_MS;
}

/**
 * Sessions with a refresh already running. Without this, a burst of turns each fires its
 * own FTS + vector search over the same store — the thundering herd the synchronous path
 * was structurally immune to, because it blocked.
 */
const packRefreshInFlight = new Set<string>();

/**
 * Rebuild a session's retrieval pack OFF the critical path and update the cache for the
 * next turn. Never throws: this runs detached, so an unhandled rejection here would be an
 * unhandled rejection in the gateway.
 */
async function refreshPackInBackground(args: {
  sessionKey: string;
  query: string;
  store: EventStore;
  ccStore: EventStore;
  eventCount: number;
  ccCount: number;
  budgetTokens: number;
  logger: { info?: (m: string) => void; warn?: (m: string) => void };
}): Promise<void> {
  const { sessionKey, query, store, ccStore, eventCount, ccCount, budgetTokens, logger } = args;
  if (packRefreshInFlight.has(sessionKey)) {
    return;
  }
  packRefreshInFlight.add(sessionKey);
  const startedMs = Date.now();
  try {
    const ccBudget = ccCount > 0 ? Math.floor(budgetTokens * CC_EXPERIENCE_BUDGET_SHARE) : 0;
    const sessionBudget = budgetTokens - ccBudget;
    const [sessionPack, ccPack] = await Promise.all([
      eventCount > 0 && sessionBudget > 0
        ? assembleRetrievalPack(query, store, { maxTokens: sessionBudget })
        : Promise.resolve(""),
      ccBudget > 0
        ? assembleRetrievalPack(query, ccStore, { maxTokens: ccBudget })
        : Promise.resolve(""),
    ]);
    const sections: string[] = [];
    if (sessionPack) {
      sections.push("## Retrieved Memory Context\n\n" + sessionPack + "\n");
    }
    if (ccPack) {
      sections.push(
        "## Learned From Claude Code Sessions\n\n" +
          "(distilled experience synced from Claude Code; each row carries its " +
          "provenance tags)\n\n" +
          ccPack +
          "\n",
      );
    }
    const rendered = sections.join("\n");
    packCache.set(sessionKey, {
      pack: rendered,
      eventCount,
      ccEventCount: ccCount,
      builtAtMs: Date.now(),
    });
    logger.info?.(
      `[total-recall] pack refreshed OFF-PATH session=${sessionKey} events=${eventCount} ` +
        `ccEvents=${ccCount} chars=${rendered.length} tookMs=${Date.now() - startedMs}`,
    );
  } catch (err) {
    // The stale pack stays cached and keeps being served — degraded, not broken.
    logger.warn?.(`[total-recall] background refresh failed session=${sessionKey}: ${err}`);
  } finally {
    packRefreshInFlight.delete(sessionKey);
  }
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
        // FORK 2026-08-13 — `runId` was always present on the hook context at runtime
        // (PluginHookAgentContext declares it); the narrow type here just hid it. Needed
        // to attribute the turn-phase event to the run the UI is waiting on.
        context: { sessionKey?: string; runId?: string },
      ) => {
        const sessionKey = context.sessionKey ?? "main";

        // Skip automated sessions
        if (sessionKey.includes("heartbeat") || sessionKey.includes("cron")) {
          return;
        }

        const query = payload.query ?? payload.userMessage ?? payload.prompt ?? "";
        if (!query.trim()) {
          return;
        }

        // FORK 2026-08-22 — TIME THE STORE LOAD SEPARATELY FROM THE SEARCH.
        //
        // The per-plugin hook timing added the same day measured THIS handler at 14,717ms on a
        // real turn, while the pack build it contains benchmarks at ~1.1s and its own log line
        // reported a normal rebuild. So ~13.6s was inside this function and outside anything
        // instrumented — and two guesses about where (other plugins; plugin re-initialisation)
        // were both refuted by measurement. Stop guessing: `count()` is the call that forces
        // `loadCache()`, i.e. readFileSync of a 15.6MB + 6.2MB pair and a JSON.parse per line,
        // and it is the only unmeasured step before the freshness check.
        // FORK 2026-08-24 (the architect: "If a task is in average more than 1 second it should be
        // decomposed further") — THREE STAGES, NOT ONE.
        //
        // `engram-store-load` averaged 5.7s across 268 turns (gateway journal, 14 days) and was
        // the single largest measured unit on the pre-model path. It was also THREE unrelated
        // pieces of work under one name: opening the session store, and forcing a full read +
        // per-line JSON.parse of each of TWO files — a 15.6MB main store and a 6.2MB CC-experience
        // store. One number cannot say which file to attack, and the warm path (the common one)
        // spends essentially all of its time here, so this is where the second went.
        const openStartedAt = Date.now();
        const store = getOrCreateStore(sessionKey);
        emitTurnStage(context.runId, sessionKey, "engram-store-open", Date.now() - openStartedAt);
        // FORK 2026-07-29 — the CC-experience store (see below) is a SECOND source
        // for this pack, so the "nothing to retrieve" guard must consider both or a
        // fresh Jarvis session would never see anything Claude Code has learned.
        const ccStartedAt = Date.now();
        const ccStore = getCcExperienceStore();
        // `count()` is the call that forces `loadCache()`. Timed around the count, not around the
        // getter, because the getter is a map lookup and the READ is the cost.
        const ccCount = ccStore.count();
        const ccLoadMs = Date.now() - ccStartedAt;
        emitTurnStage(context.runId, sessionKey, "engram-cc-store-read", ccLoadMs);
        const mainStartedAt = Date.now();
        const eventCount = store.count();
        const mainLoadMs = Date.now() - mainStartedAt;
        emitTurnStage(context.runId, sessionKey, "engram-session-store-read", mainLoadMs);
        const storeLoadMs = Date.now() - openStartedAt;
        if (eventCount === 0 && ccCount === 0) {
          return;
        }

        // Reuse the previous pack VERBATIM while the task has not moved. Returning
        // byte-identical text is the whole point: an unchanged system prompt keeps
        // deriveSessionKey stable, so the claude-cli worker is reused instead of
        // respawned, and the prompt-cache prefix is re-read instead of rewritten.
        const nowMs = Date.now();
        const cached = packCache.get(sessionKey);
        if (cached && packIsStillFresh(cached, eventCount, ccCount, nowMs)) {
          // The WARM path, which is the common one and has never been timed. If the hook is
          // slow while this branch is taken, the cost is the store load above — nothing else
          // in this branch does work.
          api.logger.info(
            `[total-recall] pack served warm session=${sessionKey} storeLoadMs=${storeLoadMs}` +
              ` (ccReadMs=${ccLoadMs} sessionReadMs=${mainLoadMs})`,
          );
          return cached.pack ? { prependSystemContext: cached.pack } : undefined;
        }

        // FORK 2026-08-15 — STALE-WHILE-REVALIDATE. See TINKER_UI_DESIGN_BIBLE/turn-latency.md.
        //
        // This rebuild was the longest stage of the pre-prompt pipeline (measured ~16s with
        // engram, 2026-08-12) and it sat ON the critical path: the user waited for it before
        // a model could even be named. Worse, it paid that cost THREE times over, because of
        // the invariant stated 15 lines above — the pack text goes into the system prompt, so
        // a changed pack changes `deriveSessionKey`, which
        //   (a) respawns the claude-cli worker instead of reusing it (~2.6s p50), and
        //   (b) invalidates the prompt-cache prefix, so ~15k tokens of system prompt are
        //       re-WRITTEN instead of re-read.
        // Measured 185 rebuilds over the sample window, i.e. that happened most turns.
        //
        // So: if we hold ANY pack for this session, serve it and refresh in the background.
        // The turn keeps a byte-identical prompt (warm worker, warm cache, no wait) and the
        // NEXT turn gets the fresher pack.
        //
        // The honest cost: the pack is query-dependent, so a deferred rebuild means this turn
        // retrieves against the previous query. That is a real staleness increase — but the
        // design already tolerates PACK_REBUILD_EVENT_DELTA events / PACK_REBUILD_MAX_AGE_MS
        // of drift by construction, so one extra turn of lag is strictly fresher than the
        // reuse path this function has always taken. A session with NO pack at all still
        // builds synchronously, because serving nothing is worse than waiting once.
        if (cached) {
          void refreshPackInBackground({
            sessionKey,
            query,
            store,
            ccStore,
            eventCount,
            ccCount,
            budgetTokens,
            logger: api.logger,
          });
          return cached.pack ? { prependSystemContext: cached.pack } : undefined;
        }

        // Cold session: no pack exists, so this one turn pays for it.
        emitTurnPhase(context.runId, sessionKey, "recall", "searching memory (first turn)");

        // FORK 2026-08-22 — the SYNCHRONOUS path has never carried a timer, while its
        // off-path twin has had `tookMs=` since 2026-08-15. Measured consequence: 594 of 691
        // pack builds in a 7-day window had no recorded duration, so every statement about
        // "the pack build" was derived from the 14% of builds that happened to log one.
        const buildStartedAt = Date.now();
        try {
          // Two sources, separate budgets. Session recall answers "what were WE
          // doing"; CC experience answers "what has been learned, ever". They are
          // scored independently so a chatty session cannot crowd out a hard-won
          // correction, and vice versa.
          const ccBudget = ccCount > 0 ? Math.floor(budgetTokens * CC_EXPERIENCE_BUDGET_SHARE) : 0;
          const sessionBudget = budgetTokens - ccBudget;

          const [sessionPack, ccPack] = await Promise.all([
            eventCount > 0 && sessionBudget > 0
              ? assembleRetrievalPack(query, store, { maxTokens: sessionBudget })
              : Promise.resolve(""),
            ccBudget > 0
              ? assembleRetrievalPack(query, ccStore, { maxTokens: ccBudget })
              : Promise.resolve(""),
          ]);

          const sections: string[] = [];
          if (sessionPack) {
            sections.push("## Retrieved Memory Context\n\n" + sessionPack + "\n");
          }
          if (ccPack) {
            // Labelled distinctly and attributed. A row here was written by a
            // DIFFERENT agent, and Jarvis should weigh it knowing that.
            sections.push(
              "## Learned From Claude Code Sessions\n\n" +
                "(distilled experience synced from Claude Code; each row carries its " +
                "provenance tags)\n\n" +
                ccPack +
                "\n",
            );
          }
          const rendered = sections.join("\n");

          // Cache the EMPTY result too — otherwise a session whose store yields
          // nothing re-runs FTS + vector search on every single turn forever.
          packCache.set(sessionKey, {
            pack: rendered,
            eventCount,
            ccEventCount: ccCount,
            builtAtMs: nowMs,
          });
          api.logger.info(
            `[total-recall] pack rebuilt session=${sessionKey} events=${eventCount} ` +
              `ccEvents=${ccCount} chars=${rendered.length} ` +
              // storeLoadMs and tookMs are reported SEPARATELY rather than summed: the first is
              // disk and JSON.parse, the second is search and ranking, and they are fixed by
              // completely different changes. A single total would hide which one to attack.
              `storeLoadMs=${storeLoadMs} tookMs=${emitBuildStage(context.runId, sessionKey, buildStartedAt)} ` +
              `reuseUntil=+${PACK_REBUILD_EVENT_DELTA}events/` +
              `${PACK_REBUILD_MAX_AGE_MS / 60000}min`,
          );
          return rendered ? { prependSystemContext: rendered } : undefined;
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
    // FORK 2026-08-04 — TWO instruments, deliberately. ENGRAM stopped recording
    // conversation on 2026-07-28 and it took a week and a full bug hunt to notice,
    // because this hook is silent unless it THROWS. Declaring the pair separates the
    // two questions that were previously indistinguishable:
    //   engram:ingest-entry     — is the host calling us at all?
    //   engram:ingest-assistant — did a write actually complete?
    // entry firing while assistant stays silent means we are being called and bailing
    // (empty text, or a sessionKey filtered by the heartbeat/cron skip). Both silent
    // means the hook is never invoked — a registration or dispatch problem, not ours.
    // Per design-principles #20, an instrument goes where the work happens, never
    // behind the same condition that decides whether it is registered.
    declareInstrument({
      id: "engram:ingest-entry",
      kind: "producer",
      description: "llm_output reached total-recall's ingestion hook (before any early return)",
    });
    declareInstrument({
      id: "engram:ingest-assistant",
      kind: "producer",
      description: "an assistant message was actually written into the ENGRAM event store",
    });
    api.on(
      "llm_output",
      async (
        payload: { assistantTexts?: string[]; text?: string; content?: string },
        context: { sessionKey?: string },
      ) => {
        // FORK 2026-08-04 — ENTRY instrument. Ingestion has been dead since 2026-07-28
        // (per-session stores stop 2026-07-29; agent:main:main has no conversation rows
        // since 2026-07-28) and NOTHING said so, because this hook logs only on THROW.
        // A hook that never fires and a hook that fires and does nothing are
        // indistinguishable from the outside — so fire the instrument on ENTRY, before
        // any early return, and a separate one on a completed write.
        noteInstrumentFired("engram:ingest-entry", context.sessionKey ?? "(no sessionKey)");
        const sessionKey = context.sessionKey ?? "main";

        // Skip heartbeat and cron sessions
        if (sessionKey.includes("heartbeat") || sessionKey.includes("cron")) {
          return;
        }

        // FORK 2026-08-04 — THIS IS WHY ENGRAM STOPPED RECORDING ON 2026-07-28.
        //
        // The hook read `payload.text ?? payload.content`. Neither field exists on
        // PluginHookLlmOutputEvent: the emitter passes `assistantTexts: string[]`
        // (hook-types.ts:261; attempt.ts:3436 and the cli path both send it). So `text`
        // was ALWAYS "" and this function returned here on EVERY turn — silently,
        // because an empty assistant message is a legitimate no-op and there is nothing
        // to log about one.
        //
        // The hook signature took `{ text?, content? }`, so TypeScript could not catch
        // it either: optional fields that are simply never present type-check perfectly.
        // A contract change on the HOST side and an untyped OPTIONAL read on the plugin
        // side combine into permanent silence. That is the shape to watch for — see
        // failures.md, "Faults that surface as silence".
        //
        // Read the real field, keep the old ones as fallback for older hosts.
        const text = (
          payload.assistantTexts?.join("\n\n").trim() ||
          payload.text ||
          payload.content ||
          ""
        ).trim();
        if (!text) {
          return;
        }

        try {
          const pipeline = getOrCreatePipeline(sessionKey);
          pipeline.ingestAssistantMessage(text, Date.now());
          noteInstrumentFired("engram:ingest-assistant", sessionKey);
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
        async execute(_toolCallId: string, params: RecallInput, context?: { sessionKey?: string }) {
          const sessionKey = context?.sessionKey ?? "main";
          const store = getOrCreateStore(sessionKey);
          const limit = params.limit ?? 10;

          const result = await recallSearch({ query: params.query, maxTokens: limit * 400 }, store);

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
    api.registerGatewayMethod("engram.search", handleEngramSearch);

    api.logger.info(`[total-recall] ready (budget=${budgetTokens}, baseDir=${ENGRAM_BASE_DIR})`);
  },
});
