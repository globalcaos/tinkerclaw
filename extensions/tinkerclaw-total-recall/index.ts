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

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  assembleRetrievalPackAsync,
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
  /**
   * FORK 2026-09-03 — set ONLY on the placeholder a cold session installs before its
   * background rebuild has produced anything. It marks an entry that is worth nothing to
   * serve, so a FAILED rebuild can drop it and let the next turn retry, instead of pinning
   * an empty pack in the cache for the whole PACK_REBUILD_MAX_AGE_MS window.
   *
   * A rebuild that legitimately yields "" is NOT seeded and stays cached — that is the
   * behaviour which stops an unproductive store re-running FTS on every single turn.
   */
  seeded?: true;
}
const packCache = new Map<string, CachedPack>();

// -- Persisted pack (FORK 2026-09-03) -----------------------------------------
//
// `packCache` is process memory, so every gateway restart made every session cold again —
// and a cold session is what used to freeze the loop for 20-28s. Writing the last built
// pack to disk turns "cold" into "one turn of extra staleness" instead of "one turn of
// nothing", for one ~8KB file per session.
//
// Deliberately the WHOLE CachedPack, not just the text: `builtAtMs` and the two counts are
// what `packIsStillFresh` reasons about, and re-stamping them to "now" on load would claim
// a pack from last week was minutes old and suppress the 30-minute rebuild.
const PACK_CACHE_DIR = join(ENGRAM_BASE_DIR, "packs");

/**
 * A persisted pack older than this is not served at all. A pack from the previous run is a
 * fair seed for one turn; a pack from last week is just wrong text in the prompt, and the
 * rebuild is scheduled either way.
 */
const PERSISTED_PACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type PersistedPack = CachedPack & { sessionKey: string };

function packCachePath(sessionKey: string): string {
  // Session keys carry ':' (agent:main:main) and could in principle carry '/'. Sanitise for
  // the filename and keep the REAL key inside the file, so two keys that collapse to the
  // same filename are detected on read instead of silently swapping packs.
  return join(PACK_CACHE_DIR, `${sessionKey.replace(/[^A-Za-z0-9._-]+/gu, "_")}.json`);
}

function loadPersistedPack(sessionKey: string): CachedPack | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packCachePath(sessionKey), "utf-8")) as
      | Partial<PersistedPack>
      | undefined;
    if (
      !parsed ||
      parsed.sessionKey !== sessionKey ||
      typeof parsed.pack !== "string" ||
      typeof parsed.eventCount !== "number" ||
      typeof parsed.ccEventCount !== "number" ||
      typeof parsed.builtAtMs !== "number"
    ) {
      return undefined;
    }
    return {
      pack: parsed.pack,
      eventCount: parsed.eventCount,
      ccEventCount: parsed.ccEventCount,
      builtAtMs: parsed.builtAtMs,
    };
  } catch {
    // Absent, truncated or half-written: a cold start with no seed is the correct
    // degradation, and it is exactly what happened before this file existed.
    return undefined;
  }
}

function persistPack(sessionKey: string, entry: CachedPack): void {
  try {
    ensureDir(PACK_CACHE_DIR);
    const target = packCachePath(sessionKey);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionKey, ...entry }), "utf-8");
    // Write-then-rename: a reader never sees a half-written pack.
    renameSync(tmp, target);
  } catch (err) {
    // Never fatal — the only thing lost is the NEXT cold start's warm seed.
    console.log(`[total-recall] pack persist failed session=${sessionKey}: ${String(err)}`);
  }
}

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
      // FORK 2026-08-24 — this bail used to be silent, while the caller's
      // `pack cold-start … coldMs=${emitBuildStage(...)}` log line printed either way. The log
      // line was then read as proof the stage had been emitted; it only proves the duration was
      // computed. Log the drop.
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

/**
 * Emit a stage AND return its duration, so the log line and the row cannot disagree.
 *
 * FORK 2026-09-03 — the stage NAME is a parameter now. The cold path no longer runs
 * search+rank on the hook, so reporting its on-path time as `engram-search-rank` would have
 * put a ~0ms row in the UI for a stage that had merely moved off the loop, and the real
 * search cost would have vanished from the breakdown entirely.
 */
function emitBuildStage(
  runId: string | undefined,
  sessionKey: string,
  startedAt: number,
  stage: string,
): number {
  const ms = Date.now() - startedAt;
  emitTurnStage(runId, sessionKey, stage, ms);
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
    // FORK 2026-09-03 — the YIELDING assembler. `assembleRetrievalPack` is synchronous (it
    // returns a string, not a promise), so awaiting it handed the loop back exactly never:
    // "OFF-PATH" named where the call sat in the source, not where it ran. The journal shows
    // the price — `pack refreshed OFF-PATH … tookMs=24130` with nothing interleaved, i.e. 24s
    // of dead event loop for every connected client.
    const [sessionPack, ccPack] = await Promise.all([
      eventCount > 0 && sessionBudget > 0
        ? assembleRetrievalPackAsync(query, store, { maxTokens: sessionBudget })
        : Promise.resolve(""),
      ccBudget > 0
        ? assembleRetrievalPackAsync(query, ccStore, { maxTokens: ccBudget })
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
    const entry: CachedPack = {
      pack: rendered,
      eventCount,
      ccEventCount: ccCount,
      builtAtMs: Date.now(),
    };
    packCache.set(sessionKey, entry);
    // Survive a gateway restart — this is what makes the NEXT cold session warm.
    persistPack(sessionKey, entry);
    logger.info?.(
      `[total-recall] pack refreshed OFF-PATH session=${sessionKey} events=${eventCount} ` +
        `ccEvents=${ccCount} chars=${rendered.length} tookMs=${Date.now() - startedMs}`,
    );
  } catch (err) {
    // The stale pack stays cached and keeps being served — degraded, not broken. But a cold
    // session's PLACEHOLDER is not a stale pack, it is nothing: leaving it cached would make
    // ONE failed rebuild suppress retrieval for the whole 30-minute freshness window. Drop it
    // so the next turn takes the cold path again — which is what the pre-2026-09-03 code did
    // implicitly, by never caching anything when the build threw.
    if (packCache.get(sessionKey)?.seeded) {
      packCache.delete(sessionKey);
    }
    logger.warn?.(`[total-recall] background refresh failed session=${sessionKey}: ${err}`);
  } finally {
    packRefreshInFlight.delete(sessionKey);
  }
}

/**
 * Schedule a background refresh for the NEXT tick.
 *
 * `void refreshPackInBackground(...)` on its own still executes the function body
 * synchronously up to its first `await`, which is one corpus slice of scanning on the
 * caller's tick. That is bounded now (MAX_SYNC_SLICE_MS in retrieval-integration.ts) but it
 * is not zero, and the point of both call sites is that the hook returns having done no
 * search work at all. `setImmediate` moves even the first slice past the current tick.
 */
function schedulePackRefresh(args: Parameters<typeof refreshPackInBackground>[0]): void {
  setImmediate(() => {
    void refreshPackInBackground(args);
  });
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
        // FORK 2026-08-24 (the user: "If a task is in average more than 1 second it should be
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
          schedulePackRefresh({
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

        // FORK 2026-09-03 — A COLD SESSION NO LONGER BLOCKS THE PROMPT (OR THE GATEWAY).
        //
        // This branch used to build the pack inline. The build is SYNCHRONOUS — the
        // `await Promise.all([...])` was resolving strings that had already been computed — so
        // the whole gateway event loop stopped for it. Proven from the journal: nothing at all
        // logs between `[hook-span] hook=before_prompt_build plugin=tinkerclaw-identity-
        // persistence` and `[total-recall] pack rebuilt … tookMs=20312 / 22496 / 24516 /
        // 28392`. Four cold sessions, 20-28s each, during which no timer fired and no socket
        // was read. "This one turn pays for it" was never the price: EVERY session paid.
        //
        // The warm path above already has the right shape — serve what we hold, refresh off
        // the critical path. A cold session has nothing in memory to serve, so it serves the
        // closest thing: the pack this session last persisted to disk, or nothing at all.
        // Either way the hook returns in the SAME TICK and the rebuild is scheduled, so the
        // next turn gets the full pack. That is the identical one-turn lag the warm path has
        // accepted by design since 2026-08-15.
        const coldStartedAt = Date.now();
        emitTurnPhase(context.runId, sessionKey, "recall", "warming memory (background)");
        try {
          const persistedRaw = loadPersistedPack(sessionKey);
          const persisted =
            persistedRaw && nowMs - persistedRaw.builtAtMs <= PERSISTED_PACK_MAX_AGE_MS
              ? persistedRaw
              : undefined;
          const seed: CachedPack = persisted ?? {
            pack: "",
            eventCount,
            ccEventCount: ccCount,
            builtAtMs: nowMs,
            seeded: true,
          };

          // Cache BEFORE scheduling. Two reasons: the refresh overwrites this entry when it
          // finishes (so it must not be able to land first and then be clobbered), and caching
          // even an EMPTY seed is what stops the next turn re-entering this branch and queueing
          // a second rebuild — the same reason the old code cached empty rebuilds. The `seeded`
          // flag is what lets a FAILED rebuild drop the empty entry again.
          packCache.set(sessionKey, seed);
          schedulePackRefresh({
            sessionKey,
            query,
            store,
            ccStore,
            eventCount,
            ccCount,
            budgetTokens,
            logger: api.logger,
          });

          const coldMs = emitBuildStage(
            context.runId,
            sessionKey,
            coldStartedAt,
            "engram-pack-coldstart",
          );
          // storeLoadMs and coldMs stay SEPARATE rather than summed: the first is disk and
          // JSON.parse (and is now by far the larger of the two — it is the next thing to
          // attack), the second is this branch's own work. A single total would hide which.
          api.logger.info(
            `[total-recall] pack cold-start session=${sessionKey} events=${eventCount} ` +
              `ccEvents=${ccCount} ` +
              `source=${persisted ? "persisted" : persistedRaw ? "expired" : "empty"} ` +
              `chars=${seed.pack.length} storeLoadMs=${storeLoadMs} coldMs=${coldMs} ` +
              `rebuild=scheduled`,
          );
          return seed.pack ? { prependSystemContext: seed.pack } : undefined;
        } catch (err) {
          api.logger.warn(`[total-recall] cold-start seed failed: ${err}`);
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
