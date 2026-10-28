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
 *   - gateway_stop: end the FTS worker thread the pack refreshes use, and the transcript catch-up
 *
 * Tool:  recall (query + optional limit/scope) — searches the session transcripts (FORK 2026-10-09);
 *        recall (id + optional offset/length) — one evicted tool result or entry back (FORK 2026-10-25)
 * Gateway method: engram.search (Tinker UI search)
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/total-recall.json`
 * so other extensions (e.g. Round Table) can detect Total Recall availability.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { declareInstrument, noteInstrumentFired } from "openclaw/plugin-sdk/fork-instrumentation";
import { isSlashCommandPrompt } from "openclaw/plugin-sdk/fork-prompt-envelope";
// The ENGRAM library is NOT vendored into this extension. It lives once, at
// src/memory/engram/, and reaches this plugin through the sanctioned SDK
// surface. A private copy used to live in ./src/ and drifted for four months —
// see src/plugin-sdk/memory-engram.ts and
// TINKER_UI_DESIGN_BIBLE/canonical-derivations.md.
import {
  assembleRetrievalPackAsync,
  createEventStore,
  createIngestionPipeline,
  createTranscriptCatchUp,
  findTranscriptItem,
  openTranscriptIndex,
  estimateTokens,
  recall as recallSearch,
  recallTranscripts,
  RECALL_BY_ID_MAX_LENGTH,
  shutdownFtsWorker,
  sliceTranscriptItem,
  transcriptIndexPath,
  transcriptSessionId,
  type EventStore,
  type IngestionPipeline,
  type RecallByIdOutput,
  type TranscriptCatchUp,
  type TranscriptIndex,
} from "openclaw/plugin-sdk/memory-engram";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

// -- Constants --

const ENGRAM_BASE_DIR = join(homedir(), ".openclaw", "engram");
const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");

// -- Tool Schema (TypeBox) --

const RecallParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Words to look for: a name, a path, a decision, an error message.",
    }),
  ),
  id: Type.Optional(
    Type.String({
      description:
        "Fetch one item of this chat back whole instead of searching: the toolCallId an " +
        "[Evicted ...] marker names, or a transcript entry id.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({ description: "With id: the char to start from, for a long item (default 0)." }),
  ),
  length: Type.Optional(
    Type.Number({
      description: `With id: how many chars to return (default 20000, max ${RECALL_BY_ID_MAX_LENGTH}).`,
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results to return (default 10, max 50)." }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("session"), Type.Literal("all")], {
      description:
        'Where to look: "session" = this chat only; "all" = every chat (default; owner only, ' +
        "other callers always get this chat only).",
    }),
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
  /** Present and true when `content` was cut at ENGRAM_SEARCH_MAX_CONTENT_CHARS. */
  clipped?: boolean;
  score: number;
  sessionKey: string;
};

export type EngramSearchPayload = {
  results: EngramSearchHit[];
  totalTokens: number;
  truncated: boolean;
};

/**
 * Upper bound on `limit`. FORK 2026-10-09 — 20, was 200: `recall` selects at most 20 events (its
 * MMR pass runs at k=20), so anything above 20 promised results that could never arrive.
 */
const ENGRAM_SEARCH_MAX_LIMIT = 20;
const ENGRAM_SEARCH_DEFAULT_LIMIT = 20;
/** Characters of one result's content an engram.search answer carries; longer content is cut and marked. */
const ENGRAM_SEARCH_MAX_CONTENT_CHARS = 4_000;
/**
 * FORK 2026-10-09 — the store searched when the caller names no session: the main chat's. It
 * used to be "main", which names a different store (2 stale events on the live gateway), so a
 * search without a key came back empty whatever it asked. A key the caller passes still wins.
 */
const MAIN_CHAT_SESSION_KEY = "agent:main:main";

/** `limit` clamped to [1, ENGRAM_SEARCH_MAX_LIMIT]; a missing or unusable value is `fallback`. */
function clampSearchLimit(raw: unknown, fallback: number): number {
  return Math.max(
    1,
    Math.min(ENGRAM_SEARCH_MAX_LIMIT, Math.floor(Number(raw ?? fallback) || fallback)),
  );
}

/**
 * FORK 2026-10-09 — ask `recall` for everything it ranks, then cut by COUNT, not by tokens.
 *
 * Both callers (engram.search and the agent `recall` tool) used to turn `limit` into a token
 * budget, `limit * 400`. recall's packer walks its ranked hits in order and STOPS at the first
 * one that does not fit, so a single long top hit (a pasted log, a whole memory file) emptied the
 * answer. Measured on copies of the live stores: 16, 5 and 3 of 24 real queries came back empty
 * at limit 5, 10 and 20, with matching events in the store; cut by count, none of the 24 did.
 *
 * A caller asking for N results wants the N best, whatever their size. A token budget belongs to
 * whoever puts text into a prompt, and neither caller does: the UI lists hits, and the tool trims
 * each one to 500 chars. Unbounded is safe because recall selects at most 20 events BEFORE it
 * packs, so its budget only ever decided how many of those 20 survived.
 *
 * Independent of how recall's packer treats an oversized hit, on purpose: correct either way.
 * `truncated` now means "recall ranked more than `limit`", and `totalTokens` is measured over the
 * hits returned, with recall's own per-event measure.
 */
async function recallTopEvents(query: string, store: EventStore, limit: number) {
  const result = await recallSearch({ query, maxTokens: Number.POSITIVE_INFINITY }, store);
  const events = result.events.slice(0, limit);
  return {
    events,
    totalTokens: events.reduce(
      (sum, e) => sum + (e.event.tokens || estimateTokens(e.event.content)),
      0,
    ),
    truncated: result.events.length > limit,
    queryCount: result.queryCount,
  };
}

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
    typeof p.sessionKey === "string" && p.sessionKey.trim()
      ? p.sessionKey.trim()
      : MAIN_CHAT_SESSION_KEY;
  const limit = clampSearchLimit(p.limit, ENGRAM_SEARCH_DEFAULT_LIMIT);

  if (!query.trim()) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "query is required" });
    return;
  }

  let payload: EngramSearchPayload;
  try {
    const store = getOrCreateStore(sessionKey);
    const top = await recallTopEvents(query, store, limit);
    // FORK 2026-10-09: with no token budget the answer is bounded by count (<= 20) AND by
    // clipping each result's content, so one call can never carry twenty whole transcripts.
    // totalTokens describes what is DELIVERED: a clipped result counts its clipped text.
    let totalTokens = 0;
    const results = top.events.map((e) => {
      const content = String(e.event.content ?? "");
      const clipped = content.length > ENGRAM_SEARCH_MAX_CONTENT_CHARS;
      const delivered = clipped ? `${content.slice(0, ENGRAM_SEARCH_MAX_CONTENT_CHARS)}…` : content;
      totalTokens += clipped
        ? estimateTokens(delivered)
        : e.event.tokens || estimateTokens(content);
      return {
        id: e.event.id,
        timestamp: e.event.timestamp,
        kind: e.event.kind,
        content: delivered,
        ...(clipped ? { clipped: true } : {}),
        score: Math.round(e.score * 1000) / 1000,
        sessionKey: e.event.sessionKey,
      };
    });
    payload = { results, totalTokens, truncated: top.truncated };
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

// -- Transcript recall (FORK 2026-10-09, J1) ----------------------------------
//
// `recall` searches the gateway transcripts — the files `chat.history` / `sessions_history`
// read — through engram's transcript index (src/memory/engram/transcript-index.ts), not the
// per-session event store, which holds assistant text only (J1 gap note §2: 1-6% of messages,
// no user turn, no tool output).
//
// Scope: other chats can hold other people's words (WhatsApp groups), so only an owner caller
// that is not sandboxed reaches past its own chat. Everyone else is held to "session".

/** How long a call waits for the background catch-up before searching what is indexed. */
const TRANSCRIPT_CATCHUP_WAIT_MS = 1500;

const transcriptIndexes = new Map<string, { index: TranscriptIndex; catchUp: TranscriptCatchUp }>();

function transcriptIndexFor(agentId: string, sessionsDir: string) {
  let entry = transcriptIndexes.get(agentId);
  if (!entry) {
    // resolveStateDir(), not ENGRAM_BASE_DIR: os.homedir() ignores a test's HOME inside a vitest
    // worker thread (measured 2026-10-09), so a homedir()-based path wrote test rows into the
    // real ~/.openclaw/engram. In the gateway both resolve to ~/.openclaw/engram.
    const dbPath = transcriptIndexPath(join(resolveStateDir(), "engram"), agentId);
    const index = openTranscriptIndex(dbPath);
    entry = { index, catchUp: createTranscriptCatchUp({ index, sessionsDir }) };
    transcriptIndexes.set(agentId, entry);
  }
  return entry;
}

function closeTranscriptIndexes(): void {
  for (const { index, catchUp } of transcriptIndexes.values()) {
    catchUp.stop();
    index.close();
  }
  transcriptIndexes.clear();
}

export type TranscriptRecallOutput = {
  scope: "session" | "all";
  results: Array<{
    sessionKey?: string;
    sessionId: string;
    when: string;
    role: string;
    text: string;
    thisSession: boolean;
  }>;
  coverage: { thisSessionCurrent: boolean; transcriptsPending: number };
  tookMs: number;
};

/** The calling chat's session store and transcript, resolved the way the gateway resolves them. */
function resolveRecallSession(ctx: OpenClawPluginToolContext) {
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const agentId = ctx.agentId ?? /^agent:([^:]+):/.exec(ctx.sessionKey ?? "")?.[1] ?? "main";
  const storePath = resolveStorePath(cfg?.session?.store, { agentId });
  const sessionsDir = dirname(storePath);
  const store = loadSessionStore(storePath);
  const fileOf = (e: { sessionId?: string; sessionFile?: string } | undefined) => {
    if (e?.sessionFile) {
      return isAbsolute(e.sessionFile) ? e.sessionFile : join(sessionsDir, e.sessionFile);
    }
    return e?.sessionId ? join(sessionsDir, `${e.sessionId}.jsonl`) : undefined;
  };
  const sessionFile = ctx.sessionKey ? fileOf(store[ctx.sessionKey]) : undefined;
  return { agentId, sessionsDir, store, fileOf, sessionFile };
}

/** `recall({ id })`: one item of THIS chat's transcript, whole or a slice (engram transcript-item.ts). */
export function runRecallById(
  ctx: OpenClawPluginToolContext,
  params: RecallInput & { id: string },
): RecallByIdOutput {
  const { sessionFile } = resolveRecallSession(ctx);
  if (!sessionFile) {
    return { id: params.id, found: false, reason: "this chat has no transcript to look in" };
  }
  const item = findTranscriptItem(sessionFile, params.id);
  if (!item) {
    return {
      id: params.id,
      found: false,
      reason: "no tool result or entry with this id in this chat's transcript",
    };
  }
  return sliceTranscriptItem(params.id, item, params.offset, params.length);
}

export async function runTranscriptRecall(
  ctx: OpenClawPluginToolContext,
  params: RecallInput & { query: string },
): Promise<TranscriptRecallOutput> {
  const startedMs = Date.now();
  const { agentId, sessionsDir, store, fileOf, sessionFile } = resolveRecallSession(ctx);
  const mayReachAll = ctx.senderIsOwner === true && ctx.sandboxed !== true;
  const scope: "session" | "all" = mayReachAll && params.scope !== "session" ? "all" : "session";

  const { index, catchUp } = transcriptIndexFor(agentId, sessionsDir);
  if (scope === "all") {
    // Warm index: only appended bytes, done in milliseconds. Cold index (first call ever): the
    // pass keeps running in the background and this call searches what is indexed by then.
    catchUp.kick();
    await Promise.race([
      catchUp.idle(),
      new Promise<void>((resolve) => setTimeout(resolve, TRANSCRIPT_CATCHUP_WAIT_MS).unref?.()),
    ]);
  }
  const result = await recallTranscripts({
    index,
    query: params.query,
    scope,
    sessionFile,
    sessionKey: ctx.sessionKey,
    limit: params.limit ?? 10,
  });

  const keyOf = new Map<string, string>();
  for (const [key, entry] of Object.entries(store)) {
    const file = fileOf(entry);
    if (file) {
      keyOf.set(file, key);
    }
  }
  return {
    scope,
    results: result.hits.map((hit) => ({
      sessionKey: keyOf.get(hit.path),
      sessionId: transcriptSessionId(hit.path),
      when: hit.ts,
      role: hit.role,
      text: hit.snippet,
      thisSession: hit.path === sessionFile,
    })),
    coverage: {
      thisSessionCurrent: result.sessionSynced,
      transcriptsPending: scope === "all" ? catchUp.pending() : 0,
    },
    tookMs: Date.now() - startedMs,
  };
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
   * background rebuild has produced anything. It marks an entry that is not this session's own
   * pack, so a FAILED rebuild can drop it and let the next turn retry, instead of pinning a
   * placeholder in the cache for the whole PACK_REBUILD_MAX_AGE_MS window. FORK 2026-10-09 —
   * the placeholder is empty, or the latest shared-bank section (see SharedBankSeed).
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

// -- Shared-bank seed (FORK 2026-10-09) -----------------------------------------
//
// MEASURED: 190 of 230 empty retrieval packs were the first turn of a brand-new session. Such a
// session has no store and no persisted pack, so the cold path served nothing, although the
// shared memory bank (the cc-experience store, below) is the SAME for every session and the last
// refresh of any session had just rendered a section of it.
//
// So each committed refresh that renders a bank section keeps it, in memory and on disk (the
// first sessions after a restart are exactly the cold ones), and a cold session with no usable
// pack of its own is seeded with it instead of nothing. The seed is still the cold PLACEHOLDER
// (`seeded: true`): the scheduler skips the interval for it, any real pack replaces it
// (packWriter), and a failed rebuild drops it, exactly as for the empty placeholder. It adds no
// prompt change either: the session's prompt changes once, seed -> own pack, where it used to
// change once, nothing -> own pack.
//
// The section was ranked against another session's query, so it is a fair seed and no more.
// Alternatives rejected:
//   - Build a bank-only pack on the cold path: that is the 20-28 s event-loop freeze the
//     2026-09-03 change took off the hook.
//   - Serve another session's whole persisted pack: its first section is that session's own
//     conversation, which is not this session's to see. Only the bank is shared.
type SharedBankSeed = { section: string; builtAtMs: number };

/**
 * Beside the per-session packs. A session pack never carries `section` and this file never
 * carries `sessionKey`, so a session key that sanitises to the same name cannot be misread as
 * either; the worst it can do is overwrite the other, which costs one cold start its seed.
 */
const SHARED_BANK_SEED_PATH = join(PACK_CACHE_DIR, "_shared-bank.json");

let sharedBankSeed: SharedBankSeed | undefined;
/** True once the disk has been read, or a refresh has recorded a newer seed than it holds. */
let sharedBankSeedLoaded = false;

/**
 * The bank section of a pack, heading included: one renderer for the pack and its seed.
 *
 * FORK 2026-10-09: this store holds the shared memory bank (auto-memory files and notes, synced
 * from disk by the memory bridge), which chat workers and plain Claude Code sessions both write.
 * The old heading, "Learned From Claude Code Sessions", read as another agent's report once the
 * chat worker itself became a Claude Code process; memory is knowledge, with no author to name
 * (owner decision, 2026-10-09).
 */
/**
 * FORK 2026-10-10 — no CJK text reaches the owner's chat. The bank indexed upstream's `docs/zh-CN`
 * translations and a Chinese hooks page surfaced in his prompt; the owner asked for no Chinese text in the chat.
 * The indexer now skips locale folders (jarvis-icu c5dba13); this drops any retrieved entry that
 * still carries Han, kana or Hangul, whatever store it came from.
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
export function dropCjkEntries(pack: string): string {
  if (!CJK_RE.test(pack)) {
    return pack;
  }
  const kept = pack.split(/\n(?=\[\d{4}-\d\d-\d\dT)/).filter((entry) => !CJK_RE.test(entry));
  return kept.some((entry) => /^\[\d{4}-\d\d-\d\dT/.test(entry)) ? kept.join("\n") : "";
}

function renderSharedBankSection(ccPack: string): string {
  return (
    "## From the Shared Memory Bank\n\n" +
    "(memory files and notes every session shares, synced from disk)\n\n" +
    ccPack +
    "\n"
  );
}

function loadSharedBankSeed(): SharedBankSeed | undefined {
  try {
    const parsed = JSON.parse(readFileSync(SHARED_BANK_SEED_PATH, "utf-8")) as
      | Partial<SharedBankSeed>
      | undefined;
    if (
      !parsed ||
      typeof parsed.section !== "string" ||
      !parsed.section ||
      typeof parsed.builtAtMs !== "number"
    ) {
      return undefined;
    }
    return { section: parsed.section, builtAtMs: parsed.builtAtMs };
  } catch {
    // Absent, truncated or half-written: no seed, which is the cold start this replaced.
    return undefined;
  }
}

/**
 * The latest bank section. Read from disk once, on the first cold start that asks, unless a
 * refresh in this process has already recorded a newer one.
 */
function currentSharedBankSeed(): SharedBankSeed | undefined {
  if (!sharedBankSeedLoaded) {
    sharedBankSeedLoaded = true;
    sharedBankSeed = loadSharedBankSeed();
  }
  return sharedBankSeed;
}

/** Keep the section a refresh just rendered: in memory, then on disk. */
function recordSharedBankSeed(seed: SharedBankSeed): void {
  sharedBankSeed = seed;
  sharedBankSeedLoaded = true;
  try {
    ensureDir(PACK_CACHE_DIR);
    const tmp = `${SHARED_BANK_SEED_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(seed), "utf-8");
    // Write-then-rename, like the session packs: a reader never sees a half-written seed.
    renameSync(tmp, SHARED_BANK_SEED_PATH);
  } catch (err) {
    // Never fatal: this process still serves the seed from memory.
    console.log(`[total-recall] shared-bank seed persist failed: ${String(err)}`);
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
 * FORK 2026-08-23: break down the Total Recall stage the way the context-preparation stage was.
 * Total Recall is the largest single plugin on the pre-model path, and until now it
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

// -- Pack refresh scheduler (FORK 2026-09-23, plan task 14) --------------------
//
// MEASURED (two 20 s `diagnostic.cpuProfile` runs on the live gateway): ~35-42% of the main
// thread was FTS self time under `refreshPackInBackground`, logged at `tookMs=15240` and
// `tookMs=238676` per refresh — and refreshes from several tabs OVERLAPPED, because every stale
// tab's turn started its own full-corpus scan the next tick. Each scan yields between slices, so
// no single one froze the loop; together they pinned a core. The per-session in-flight set this
// replaces only stopped a session racing ITSELF.
//
// So, process-wide: ONE refresh at a time; FIFO across sessions; a queued session's newer request
// REPLACES its args (the latest query wins) and keeps its place; a running session's newer
// requests fold into ONE follow-up; and a session is refreshed at most once per
// PACK_REFRESH_MIN_INTERVAL_MS, measured from the END of one run to the START of the next.
// The stale pack keeps being served meanwhile — the hook never waits on any of this.
//
// The one exemption from the interval is a cold placeholder (`seeded`): it holds nothing of the
// session's own (it is empty, or the shared-bank seed), so its first pack must not wait out a
// timer.

/** Minimum time between the END of one refresh of a session and the START of its next. */
export const PACK_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * FORK 2026-09-24 (ruling R38) — a refresh still unsettled this long is abandoned FOR QUEUE
 * PURPOSES: its slot is freed and the queue moves on. It cannot be cancelled, so it may keep
 * burning CPU until it ends; when it does, the scheduler ignores it (and logs that once), and its
 * pack reaches the cache only if no newer refresh of the session has started (`packWriter`). Without
 * this, one hung refresh held the single-flight slot and no session's pack was refreshed again.
 * Above the FTS worker's own 120 s timeout (R34), so a timed-out worker falls back first.
 */
export const PACK_REFRESH_WATCHDOG_MS = 180_000;

export interface PackRefreshScheduler<A> {
  /** Ask for a refresh. Never runs it on the caller's tick. */
  request(sessionKey: string, args: A): void;
}

export function createPackRefreshScheduler<A>(options: {
  run: (args: A) => Promise<void>;
  /** True when the session's cached pack is the cold placeholder: it skips the interval. */
  isCold: (sessionKey: string) => boolean;
  minIntervalMs?: number;
  /** `run` should not throw; if it does, the error lands here and the queue moves on. */
  onError?: (sessionKey: string, err: unknown) => void;
  watchdogMs?: number;
  /** A run exceeded the watchdog and was abandoned for queue purposes. */
  onAbandoned?: (sessionKey: string, watchdogMs: number) => void;
  /** An abandoned run settled after all; ignored beyond this call (once per abandoned run). */
  onLateSettle?: (sessionKey: string, tookMs: number) => void;
}): PackRefreshScheduler<A> {
  const minIntervalMs = options.minIntervalMs ?? PACK_REFRESH_MIN_INTERVAL_MS;
  const watchdogMs = options.watchdogMs ?? PACK_REFRESH_WATCHDOG_MS;
  /** Queued session keys in arrival order; each appears at most once. */
  const order: string[] = [];
  const queuedArgs = new Map<string, A>();
  const lastEndedAt = new Map<string, number>();
  let running: string | undefined;
  let followUp: { args: A } | undefined;
  let pumpPending = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;

  const enqueue = (sessionKey: string, args: A): void => {
    if (!queuedArgs.has(sessionKey)) {
      order.push(sessionKey);
    }
    queuedArgs.set(sessionKey, args);
  };

  // setImmediate, not a direct call: the hook must return having done no search work at all,
  // and a run executes synchronously up to its first await.
  const schedulePump = (): void => {
    if (pumpPending) {
      return;
    }
    pumpPending = true;
    setImmediate(() => {
      pumpPending = false;
      pump();
    });
  };

  const dueAt = (sessionKey: string): number => {
    const ended = lastEndedAt.get(sessionKey);
    return ended === undefined || options.isCold(sessionKey) ? 0 : ended + minIntervalMs;
  };

  /** The run holding the slot: its end (or its abandonment) frees the slot exactly once. */
  let current: object | undefined;

  const execute = async (sessionKey: string, args: A): Promise<void> => {
    running = sessionKey;
    const run = {};
    current = run;
    const startedAt = Date.now();
    const end = (): void => {
      if (current !== run) {
        return;
      }
      current = undefined;
      lastEndedAt.set(sessionKey, Date.now());
      running = undefined;
      if (followUp) {
        enqueue(sessionKey, followUp.args);
        followUp = undefined;
      }
      schedulePump();
    };
    let abandoned = false;
    const watchdog = setTimeout(() => {
      abandoned = true;
      options.onAbandoned?.(sessionKey, watchdogMs);
      end();
    }, watchdogMs);
    watchdog.unref?.();
    try {
      await options.run(args);
    } catch (err) {
      if (!abandoned) {
        options.onError?.(sessionKey, err);
      }
    } finally {
      clearTimeout(watchdog);
      if (abandoned) {
        options.onLateSettle?.(sessionKey, Date.now() - startedAt);
      } else {
        end();
      }
    }
  };

  function pump(): void {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }
    if (running !== undefined) {
      return; // the run's `finally` pumps again
    }
    const now = Date.now();
    for (const [key, ended] of lastEndedAt) {
      if (now - ended >= minIntervalMs) {
        lastEndedAt.delete(key); // no longer constrains anything; keeps the map bounded
      }
    }
    let earliest = Infinity;
    for (let i = 0; i < order.length; i++) {
      const sessionKey = order[i];
      const due = dueAt(sessionKey);
      if (due <= now) {
        order.splice(i, 1);
        const args = queuedArgs.get(sessionKey) as A;
        queuedArgs.delete(sessionKey);
        void execute(sessionKey, args);
        return;
      }
      earliest = Math.min(earliest, due);
    }
    if (earliest !== Infinity) {
      wakeTimer = setTimeout(pump, earliest - now);
      wakeTimer.unref?.();
    }
  }

  return {
    request(sessionKey, args) {
      if (running === sessionKey) {
        followUp = { args };
        return;
      }
      enqueue(sessionKey, args);
      schedulePump();
    },
  };
}

type PackRefreshArgs = {
  sessionKey: string;
  query: string;
  /** Called when the refresh RUNS, never when it is requested: see packRefreshInputs. */
  resolveStores: () => { store: EventStore; ccStore: EventStore };
  budgetTokens: number;
  logger: { info?: (m: string) => void; warn?: (m: string) => void };
};

/**
 * FORK 2026-09-24 (ruling R38) — the stores a refresh searches, and their event counts, taken
 * when it STARTS. A request can wait in the queue (behind other sessions, or its interval) past a
 * CC-experience reload — getCcExperienceStore drops its memoised store when the file changes — and
 * args captured at request time pinned the superseded store, which the refresh then indexed for
 * nothing. The counts go into the rebuilt pack's freshness stamp, so they are read here too.
 */
export function packRefreshInputs(resolveStores: PackRefreshArgs["resolveStores"]): {
  store: EventStore;
  ccStore: EventStore;
  eventCount: number;
  ccCount: number;
} {
  const { store, ccStore } = resolveStores();
  return { store, ccStore, eventCount: store.count(), ccCount: ccStore.count() };
}

// -- Pack writes (FORK 2026-09-24, R38 follow-up) ------------------------------
//
// The R38 watchdog abandons a refresh FOR QUEUE PURPOSES only; it cannot cancel it. An abandoned
// refresh (FTS worker timeout + in-thread fallback: 120 s, then 15-239 s) therefore settles LATE,
// and it used to write unconditionally: the OLDER query's pack, with its older freshness stamp,
// went into the cache and onto disk over the pack a NEWER refresh of the session had built. A late
// FAILURE likewise dropped the cold placeholder the newer refresh was about to replace, sending the
// next turn down the cold path to queue yet another refresh.
//
// Rule: a SUPERSEDED refresh — one whose session has started a newer refresh since it began — may
// not replace a real cached pack, and may not drop the cold placeholder. A refresh nothing newer
// has superseded writes as before, abandoned or not: its pack is the freshest there is. (A warm
// session's successor is not due until PACK_REFRESH_MIN_INTERVAL_MS after the abandonment, and
// only once the queue reaches it, so there this bites a refresh running past ~240 s — which the
// worker timeout plus the in-thread fallback reaches. A cold session's successor is due at once.)
//
// Two choices, and what each buys:
//   - Superseded means a newer refresh STARTED, not that a newer pack was WRITTEN. Otherwise a
//     superseded run settling while the newer one is still scanning would change the pack moments
//     before the newer one changes it again, and every pack change respawns the claude-cli worker
//     and rewrites the prompt-cache prefix (see packIsStillFresh). Prompt stability over a pack
//     that is already superseded. (Ordering by `builtAtMs` instead would be worse: the stale run
//     writes first, and the NEWER run's write is the one refused.)
//   - The exception is an entry that is not the session's own pack — absent, or the cold
//     placeholder (`seeded`: empty, or the shared-bank seed): any real pack beats it, superseded
//     or not, even at the price of that second change. Content over stability, because the
//     alternative is serving none of the session's memory until the newer run lands.
// Runs are numbered by a process-local counter, not Date.now(): the order must not depend on the
// wall clock, and the number never leaves the process (it is not part of CachedPack or the file).

export interface PackWriter {
  /** Number a refresh as it STARTS, before it reads its inputs; it becomes its session's latest. */
  begin(sessionKey: string): number;
  /**
   * Cache the refreshed pack, then persist it — unless the run is superseded and the cache holds a
   * real pack. Returns whether it wrote; a refused write is logged, once (a run commits once).
   */
  commit(sessionKey: string, runSeq: number, entry: CachedPack): boolean;
  /**
   * The refresh failed: drop the session's cold placeholder so the next turn retries the cold
   * path — unless the run is superseded, in which case the placeholder is the newer refresh's to
   * replace (logged). Returns whether it dropped.
   */
  dropFailedPlaceholder(sessionKey: string, runSeq: number): boolean;
}

export function createPackWriter(options: {
  cache: Map<string, CachedPack>;
  persist: (sessionKey: string, entry: CachedPack) => void;
  log: (message: string) => void;
}): PackWriter {
  let lastSeq = 0;
  /**
   * Each session's latest-started refresh, while it is in flight. A run that finds anything else
   * here — a newer number, or nothing because the newer run already settled — is superseded.
   * Released when the latest run settles, so the map only ever holds sessions mid-refresh.
   */
  const latest = new Map<string, number>();
  const superseded = (sessionKey: string, runSeq: number): boolean =>
    latest.get(sessionKey) !== runSeq;
  const release = (sessionKey: string, runSeq: number): void => {
    if (latest.get(sessionKey) === runSeq) {
      latest.delete(sessionKey);
    }
  };
  return {
    begin(sessionKey) {
      lastSeq += 1;
      latest.set(sessionKey, lastSeq);
      return lastSeq;
    },
    commit(sessionKey, runSeq, entry) {
      const cached = options.cache.get(sessionKey);
      const refused = cached !== undefined && !cached.seeded && superseded(sessionKey, runSeq);
      release(sessionKey, runSeq);
      if (refused) {
        options.log(
          `[total-recall] superseded pack refresh NOT written session=${sessionKey}: a newer ` +
            "refresh of this session started after it (the cached pack is kept)",
        );
        return false;
      }
      options.cache.set(sessionKey, entry);
      options.persist(sessionKey, entry);
      return true;
    },
    dropFailedPlaceholder(sessionKey, runSeq) {
      const isPlaceholder = options.cache.get(sessionKey)?.seeded === true;
      const wasSuperseded = superseded(sessionKey, runSeq);
      release(sessionKey, runSeq);
      if (!isPlaceholder) {
        return false;
      }
      if (wasSuperseded) {
        options.log(
          `[total-recall] superseded pack refresh failed session=${sessionKey}: the cold ` +
            "placeholder is kept for the newer refresh to replace",
        );
        return false;
      }
      options.cache.delete(sessionKey);
      return true;
    },
  };
}

/** Every refresh writes through this: the only path by which a refresh changes `packCache`. */
const packWriter = createPackWriter({
  cache: packCache,
  // Survive a gateway restart — this is what makes the NEXT cold session warm.
  persist: persistPack,
  // The same sink as the scheduler's onAbandoned/onLateSettle, so one incident reads as one story.
  log: (message) => {
    console.log(message);
  },
});

// -- Pack query (FORK 2026-10-09) ----------------------------------------------
//
// MEASURED on the 93 MB shared bank: ~1K chars of full-text query search in ~3 s, 4K in 11 s,
// 12K in 32 s and 45K in 71-85 s, because the search costs more the more distinct terms the query
// has (search-index.ts, parseQuery). The hook hands over the whole prompt, preamble included, and
// Tinker refreshes had a 20 s journal median. So a refresh searches with the prompt's TAIL: that
// is where the newest message sits, i.e. what the task is now, while the preamble is much the
// same every turn and pulls much the same events every turn.
//
// Alternatives rejected:
//   - The head of the prompt: that is the preamble, the same query every turn.
//   - Capping terms inside the library's search: that changes the ranking for every caller; this
//     changes only what this plugin asks.
// The cost: a long message is searched by its last ~2,000 chars only. The `recall` tool remains
// the full-query path, at no cost until the model asks.

/** How much of the prompt, from its end, a pack refresh searches with. */
export const PACK_QUERY_MAX_CHARS = 2_000;

/** How far into the window the first whitespace may sit and still count as near the cut. */
const PACK_QUERY_WORD_SLACK_CHARS = 64;

/**
 * The full-text query a pack refresh searches with: the last {@link PACK_QUERY_MAX_CHARS}
 * characters of `prompt`, trimmed. When the cut lands inside a word and a whitespace is near,
 * the query starts after it instead, so it does not open with the back half of a word (which
 * matches nothing, or the wrong events).
 */
export function packQuery(prompt: string): string {
  const text = prompt.trim();
  if (text.length <= PACK_QUERY_MAX_CHARS) {
    return text;
  }
  const cut = text.length - PACK_QUERY_MAX_CHARS;
  let window = text.slice(cut);
  if (!/\s/u.test(text.charAt(cut - 1))) {
    const space = window.search(/\s/u);
    if (space !== -1 && space <= PACK_QUERY_WORD_SLACK_CHARS) {
      window = window.slice(space);
    }
  }
  return window.trim();
}

/**
 * Rebuild a session's retrieval pack OFF the critical path and update the cache for the
 * next turn. Never throws: this runs detached, so an unhandled rejection here would be an
 * unhandled rejection in the gateway. Only ever called by `packRefreshScheduler`, which
 * guarantees no two of these START at once — not that no two RUN at once: one the R38 watchdog
 * abandoned keeps running and can settle after a newer one has started. So every change this
 * makes to the cache goes through `packWriter`.
 */
async function refreshPackInBackground(args: PackRefreshArgs): Promise<void> {
  const { sessionKey, budgetTokens, logger } = args;
  // FORK 2026-10-09 — the hook hands over the whole prompt; this is the one place it is cut to
  // what is worth searching with (packQuery).
  const query = packQuery(args.query);
  const startedMs = Date.now();
  // Numbered before the inputs are read, so a refresh numbered later took NEWER inputs.
  const runSeq = packWriter.begin(sessionKey);
  try {
    const { store, ccStore, eventCount, ccCount } = packRefreshInputs(args.resolveStores);
    const ccBudget = ccCount > 0 ? Math.floor(budgetTokens * CC_EXPERIENCE_BUDGET_SHARE) : 0;
    const sessionBudget = budgetTokens - ccBudget;
    // FORK 2026-09-03 — the YIELDING assembler. `assembleRetrievalPack` is synchronous (it
    // returns a string, not a promise), so awaiting it handed the loop back exactly never:
    // "OFF-PATH" named where the call sat in the source, not where it ran. The journal shows
    // the price — `pack refreshed OFF-PATH … tookMs=24130` with nothing interleaved, i.e. 24s
    // of dead event loop for every connected client.
    const [rawSessionPack, rawCcPack] = await Promise.all([
      eventCount > 0 && sessionBudget > 0
        ? assembleRetrievalPackAsync(query, store, { maxTokens: sessionBudget })
        : Promise.resolve(""),
      ccBudget > 0
        ? assembleRetrievalPackAsync(query, ccStore, { maxTokens: ccBudget })
        : Promise.resolve(""),
    ]);
    const sessionPack = dropCjkEntries(rawSessionPack);
    const ccPack = dropCjkEntries(rawCcPack);
    const sections: string[] = [];
    if (sessionPack) {
      sections.push("## Retrieved Memory Context\n\n" + sessionPack + "\n");
    }
    // Rendered once, used twice: in this pack, and as the seed the next brand-new session
    // starts from (SharedBankSeed).
    const bankSection = ccPack ? renderSharedBankSection(ccPack) : "";
    if (bankSection) {
      sections.push(bankSection);
    }
    let rendered = sections.join("\n");
    // FORK 2026-10-09 — a rebuild that finds nothing for THIS query (a "hello" ranks nothing) keeps
    // the latest shared-bank section instead of emptying the pack. Seen live: a new session's first
    // turn was served the bank seed (2,773 chars), and its second turn was served chars=0 because
    // the empty rebuild replaced it. Same rule as the cold start: only while the bank has events now,
    // under the same 24 h cap. The entry is a real pack (not `seeded`), so the interval applies.
    let bankFallback = false;
    if (!rendered && ccCount > 0) {
      const latest = currentSharedBankSeed();
      if (latest && Date.now() - latest.builtAtMs <= PERSISTED_PACK_MAX_AGE_MS) {
        rendered = latest.section;
        bankFallback = true;
      }
    }
    const entry: CachedPack = {
      pack: rendered,
      eventCount,
      ccEventCount: ccCount,
      builtAtMs: Date.now(),
    };
    // Cache, then disk — refused if a newer refresh of this session has started (packWriter).
    if (!packWriter.commit(sessionKey, runSeq, entry)) {
      return;
    }
    // FORK 2026-10-09 — only a COMMITTED refresh updates the shared-bank seed: a refused one is
    // superseded, so a refresh with newer inputs is already running and will record its own.
    if (bankSection) {
      recordSharedBankSeed({ section: bankSection, builtAtMs: entry.builtAtMs });
    }
    logger.info?.(
      `[total-recall] pack refreshed OFF-PATH session=${sessionKey} events=${eventCount} ` +
        `ccEvents=${ccCount} chars=${rendered.length} queryChars=${query.length} ` +
        `${bankFallback ? "source=shared-bank " : ""}tookMs=${Date.now() - startedMs}`,
    );
  } catch (err) {
    // The stale pack stays cached and keeps being served — degraded, not broken. But a cold
    // session's PLACEHOLDER is not a stale pack, it is none of the session's memory (empty, or
    // the shared-bank seed): leaving it cached would make ONE failed rebuild suppress the
    // session's own retrieval for the whole 30-minute freshness window. Drop it
    // so the next turn takes the cold path again — which is what the pre-2026-09-03 code did
    // implicitly, by never caching anything when the build threw. Not if a newer refresh of this
    // session has started, though: the placeholder is then that refresh's to replace (packWriter).
    packWriter.dropFailedPlaceholder(sessionKey, runSeq);
    logger.warn?.(`[total-recall] background refresh failed session=${sessionKey}: ${err}`);
  }
}

const packRefreshScheduler = createPackRefreshScheduler<PackRefreshArgs>({
  run: refreshPackInBackground,
  isCold: (sessionKey) => packCache.get(sessionKey)?.seeded === true,
  onError: (sessionKey, err) => {
    console.log(`[total-recall] pack refresh threw session=${sessionKey}: ${String(err)}`);
  },
  onAbandoned: (sessionKey, ms) => {
    console.log(
      `[total-recall] pack refresh session=${sessionKey} still running after ${ms} ms: ` +
        "abandoned for the queue (it may still finish)",
    );
  },
  onLateSettle: (sessionKey, tookMs) => {
    console.log(
      `[total-recall] abandoned pack refresh session=${sessionKey} settled after ${tookMs} ms ` +
        "(ignored by the queue)",
    );
  },
});

/**
 * Hand a background refresh to the process-wide scheduler (single-flight, coalesced,
 * rate-limited per session). Nothing runs on the caller's tick: the point of both call sites
 * is that the hook returns having done no search work at all.
 */
function schedulePackRefresh(args: PackRefreshArgs): void {
  packRefreshScheduler.request(args.sessionKey, args);
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
    // Injects the retrieval pack in front of the turn's prompt (prependContext). FORK 2026-10-10
    // (J-series Phase 1.5): it used to go into the system prompt, where a warm Claude Code worker
    // saw it only at spawn and every new pack moved the whole cached prefix.
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
        if (!query.trim() || isSlashCommandPrompt(query)) {
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
        // FORK 2026-08-24: a stage averaging more than 1 second is split further — THREE STAGES, NOT ONE.
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
        // byte-identical text was the whole point while the pack sat in the system prompt
        // (an unchanged prompt kept the claude-cli worker and the cached prefix). Since
        // 2026-10-10 it rides the turn, so reuse now saves the rebuild, not the cache.
        const nowMs = Date.now();
        const cached = packCache.get(sessionKey);
        if (cached && packIsStillFresh(cached, eventCount, ccCount, nowMs)) {
          // The WARM path, which is the common one and has never been timed. If the hook is
          // slow while this branch is taken, the cost is the store load above — nothing else
          // in this branch does work.
          // FORK 2026-10-09 — `chars` and `placeholder` say WHAT was served: a seeded entry here is
          // the cold placeholder (empty, or the shared-bank seed) whose rebuild has not landed yet.
          api.logger.info(
            `[total-recall] pack served warm session=${sessionKey} chars=${cached.pack.length}` +
              `${cached.seeded ? " placeholder" : ""} storeLoadMs=${storeLoadMs}` +
              ` (ccReadMs=${ccLoadMs} sessionReadMs=${mainLoadMs})`,
          );
          return cached.pack ? { prependContext: cached.pack } : undefined;
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
        // reuse path this function has always taken. A session with NO pack at all takes the
        // cold path below, which since 2026-09-03 never builds on the hook either.
        if (cached) {
          schedulePackRefresh({
            sessionKey,
            query,
            resolveStores: () => ({
              store: getOrCreateStore(sessionKey),
              ccStore: getCcExperienceStore(),
            }),
            budgetTokens,
            logger: api.logger,
          });
          // FORK 2026-10-09 — one line, like the warm and cold branches: this branch used to log
          // nothing, so a turn served from a stale pack left no trace in the journal.
          api.logger.info(
            `[total-recall] pack served stale session=${sessionKey} chars=${cached.pack.length}` +
              `${cached.seeded ? " placeholder" : ""} storeLoadMs=${storeLoadMs}` +
              " rebuild=requested",
          );
          return cached.pack ? { prependContext: cached.pack } : undefined;
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
        // closest thing: the pack this session last persisted to disk; failing that, the latest
        // shared-bank section (FORK 2026-10-09); failing that, nothing at all.
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
          // FORK 2026-10-09 — no usable pack of its own (mostly: a brand-new session), so start
          // from the latest shared-bank section instead of nothing (SharedBankSeed). Only while
          // the bank has events NOW (no bank, no seed: nothing is invented), and under the same
          // 24 h cap as a persisted pack.
          const bankSeedRaw = !persisted && ccCount > 0 ? currentSharedBankSeed() : undefined;
          const bankSeed =
            bankSeedRaw && nowMs - bankSeedRaw.builtAtMs <= PERSISTED_PACK_MAX_AGE_MS
              ? bankSeedRaw
              : undefined;
          const seed: CachedPack = persisted ?? {
            // Still the cold PLACEHOLDER when it carries the bank section, so the scheduler's cold
            // exemption, packWriter's "any real pack replaces it" and a failed rebuild's drop all
            // apply to it unchanged.
            pack: bankSeed?.section ?? "",
            eventCount,
            ccEventCount: ccCount,
            builtAtMs: nowMs,
            seeded: true,
          };
          const seedSource = persisted
            ? "persisted"
            : bankSeed
              ? "shared-bank"
              : persistedRaw
                ? "expired"
                : "empty";

          // Cache BEFORE scheduling. Two reasons: the refresh overwrites this entry when it
          // finishes (so it must not be able to land first and then be clobbered), and caching
          // even an EMPTY seed is what stops the next turn re-entering this branch and queueing
          // a second rebuild — the same reason the old code cached empty rebuilds. The `seeded`
          // flag is what lets a FAILED rebuild drop the empty entry again.
          packCache.set(sessionKey, seed);
          schedulePackRefresh({
            sessionKey,
            query,
            resolveStores: () => ({
              store: getOrCreateStore(sessionKey),
              ccStore: getCcExperienceStore(),
            }),
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
              `source=${seedSource} ` +
              `chars=${seed.pack.length} storeLoadMs=${storeLoadMs} coldMs=${coldMs} ` +
              `rebuild=scheduled`,
          );
          return seed.pack ? { prependContext: seed.pack } : undefined;
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
    // Hook 4: gateway_stop -- end the engram FTS worker thread (plan task 16)
    // Pack refreshes run their FTS in a worker. It is unref'd while idle, so this only
    // changes a shutdown that lands mid-scan: the worker is terminated and its request
    // rejected ("shutdown"), and that refresh then finishes its FTS on the main thread (the
    // in-thread fallback, assembleRetrievalPackAsync) while the gateway stops — the scan is
    // moved, not abandoned. Skipping it would need a stop signal threaded into engram's
    // fallback, so it is left as is (final fix wave, T16 minor).
    // -------------------------------------------------------------------
    api.on("gateway_stop", async () => {
      await shutdownFtsWorker();
      closeTranscriptIndexes();
    });

    // -------------------------------------------------------------------
    // Tool: recall -- search the session transcripts (FORK 2026-10-09, J1)
    // -------------------------------------------------------------------
    // The factory receives the gateway's trusted context (session key, agent, owner flag);
    // `execute`'s third argument is NOT a context object, which is why the old body always
    // searched the "main" store. Optional: an agent sees it only when `tools.alsoAllow` (or
    // `tools.allow`) names `recall` or `tinkerclaw-total-recall`.
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => ({
        name: "recall",
        label: "Memory Recall",
        description:
          "Search past conversations: what was said, decided, or printed by a tool, in this chat " +
          "and (for the owner) every other chat, including turns compaction has dropped from " +
          "context. Returns the matching passages with their chat's session key, role and time. " +
          "For more of a passage, search again with its exact words. Pass id instead of query to " +
          "get one item of this chat back whole: an evicted tool result by the toolCallId its " +
          "[Evicted ...] marker names, or a transcript entry by its id (offset/length page " +
          "through a long one).",
        parameters: RecallParams,
        async execute(_toolCallId: string, params: RecallInput) {
          const id = params.id?.trim();
          const query = params.query?.trim();
          if (id) {
            const byId = runRecallById(ctx, { ...params, id });
            api.logger.info(
              `[total-recall] recall id=${id} found=${byId.found}` +
                (byId.found ? ` chars=${byId.text.length}/${byId.totalChars}` : ""),
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(byId, null, 2) }],
              details: byId,
            };
          }
          if (!query) {
            const missing = { error: "recall needs a query (words to search for) or an id" };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(missing) }],
              details: missing,
            };
          }
          const out = await runTranscriptRecall(ctx, { ...params, query });
          api.logger.info(
            `[total-recall] recall scope=${out.scope} hits=${out.results.length} ` +
              `tookMs=${out.tookMs} pending=${out.coverage.transcriptsPending}`,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
            details: out,
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
