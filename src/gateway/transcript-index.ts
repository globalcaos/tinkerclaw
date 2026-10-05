import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emitEvent } from "../infra/events/emit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * Incremental index over one append-only transcript JSONL file (`<sessionId>.jsonl`): a
 * `{type:"session",...}` header line followed by pi session entries `{type, id, parentId, ...}`.
 *
 * `refresh()` re-reads only bytes appended since the last call when it can prove the previously
 * ingested region is untouched, and falls back to a full rebuild (new `epoch`) otherwise. See
 * Ruling R2 in the task-3 brief for why the rewrite probe reads from the START of the last
 * ingested line (where `id` lives) rather than the file's trailing bytes.
 */

const PROBE_BYTES = 4096;

// Ruling R19: an epoch is a cursor identity, so it must never repeat — not across two instances
// on the same path (registry eviction, then a rebuild after an in-place rewrite that kept the root
// entry), and not across gateway restarts. The generation counter is shared by every instance;
// the nonce separates this process from every earlier one.
const EPOCH_NONCE = randomBytes(4).toString("hex");
let epochGeneration = 0;

export type IndexedEntry = {
  id: string;
  parentId: string | null;
  /** `"parentId" in <parsed line>` — Task 4's legacy tree-transcript probe needs the KEY, not the value. */
  hasParentKey: boolean;
  type: string;
  raw: unknown;
};

/** root → leaf; seq = index + 1. */
export type BranchView = { epoch: string; entries: readonly IndexedEntry[] };

/**
 * Where this index and pi's `SessionManager.open` would disagree about the same bytes. A reader
 * that must match pi row-for-row serves a file from the index only when the header is current and
 * every divergence below is absent; anything else goes to pi. The one exception is
 * `parentCycleAt`: see there.
 */
export type IndexFidelity = {
  /** Parsed JSON of the line at byte 0 (the session header when well-formed); undefined if blank or not JSON. */
  header: unknown;
  /**
   * JSON lines that became neither an entry nor a `type:"session"` line: null, primitives, arrays,
   * objects without a string `id`. pi keeps them in `getEntries()` and moves its leaf onto them.
   */
  unindexedLines: number;
  /**
   * Entries whose `id` was already indexed. The index resolves them as pi does (the last copy wins
   * the id; allEntries() keeps every copy, as pi's `getEntries()` does), but an ACYCLIC file with
   * one still goes to pi: that routing predates the per-line allEntries and has not been re-proven
   * row-for-row. A looping one does not (see parentCycleAt).
   */
  duplicateIds: number;
  /** The file ends in a line with no newline that parses as JSON: pi reads it, the index waits for the newline. */
  unterminatedTail: boolean;
  /**
   * FORK 2026-09-24 (fix-cycle-hang) — the id at which the parent walk from the leaf first comes
   * back to an entry it already walked (walkParentChain), or null when the walk ends at a root or a
   * missing parent. pi's `getBranch()` is the same walk with no visited set: on such a chain it
   * never returns, a synchronous infinite loop on the caller's thread. When the index and pi read
   * the same graph (header current, no unindexed line, no unterminated tail, so a duplicated id,
   * the usual way a loop is made, is the only divergence) the reader serves the file from this
   * index's walk instead of sending it to pi on the duplicate-ids gap. Only the LEAF's chain is
   * checked: it is the only chain getBranch() walks, and findStrandedPromptRows carries its own
   * visited set for the fork-point walks it makes elsewhere.
   */
  parentCycleAt: string | null;
};

export class TranscriptIndex {
  readonly stats = { fullBuilds: 0, tailParses: 0, noops: 0 };

  private ino = -1;
  private size = -1;
  private mtimeMs = -1;
  /** Byte offset up to which the file has been ingested (never includes a torn trailing line). */
  private offset = 0;
  /** First ≤4096 bytes of the header line, captured on the last full rebuild. */
  private headerProbe = Buffer.alloc(0);
  /** Start offset (in the file) of the last complete line ingested, and its first ≤4096 bytes. */
  private lastLineStart = 0;
  private lastLineProbe = Buffer.alloc(0);
  private byId = new Map<string, IndexedEntry>();
  /**
   * Every indexed entry line in file order, a duplicated id once per line (pi's getEntries()). One
   * more pointer per entry; the entries themselves are the objects byId holds.
   */
  private entryLines: IndexedEntry[] = [];
  private leafId: string | null = null;
  private branch: IndexedEntry[] = [];
  private epoch = "";
  private header: unknown = undefined;
  private unindexedLines = 0;
  private duplicateIds = 0;
  private unterminatedTail = false;
  private parentCycleAt: string | null = null;
  private lastRefreshMs = 0;

  constructor(private readonly filePath: string) {}

  refresh(): BranchView {
    this.lastRefreshMs = Date.now();
    const st = fs.statSync(this.filePath);
    if (st.ino === this.ino && st.size === this.size && st.mtimeMs === this.mtimeMs) {
      this.stats.noops++;
      return { epoch: this.epoch, entries: this.branch };
    }
    // A file that disappears between this stat and the open below throws ENOENT to the caller;
    // it is intentionally not caught here.
    const fd = fs.openSync(this.filePath, "r");
    try {
      const isGrowthCandidate = st.ino === this.ino && this.offset > 0 && st.size >= this.offset;
      const canTailParse =
        isGrowthCandidate && this.headerProbeMatches(fd) && this.lastLineProbeMatches(fd);
      if (canTailParse) {
        this.stats.tailParses++;
        const prevLeaf = this.leafId;
        this.ingest(this.readRange(fd, this.offset, st.size), this.offset);
        this.rebuildBranch();
        if (prevLeaf && !this.branch.some((e) => e.id === prevLeaf)) {
          this.bumpEpoch(st.ino);
        }
      } else {
        // logging.md §4.4 transcript.index.build. The cause is read BEFORE the state is cleared.
        // `first` is "nothing was ever ingested", not "never refreshed": a file that held only a
        // header (or nothing) leaves `offset` at 0 with an inode already recorded, and calling the
        // build that finally reads content a "rewrite" would put a first build in the bucket meant
        // for in-place edits. One Date.now() pair per FULL build only — the tail-parse path, which
        // is the common one, is untouched.
        const buildStartedMs = Date.now();
        const cause =
          this.ino === -1 || this.offset === 0
            ? "first"
            : st.ino === this.ino
              ? "rewrite"
              : "inode";
        this.stats.fullBuilds++;
        this.byId.clear();
        this.entryLines = [];
        this.leafId = null;
        this.offset = 0;
        this.headerProbe = Buffer.alloc(0);
        this.lastLineStart = 0;
        this.lastLineProbe = Buffer.alloc(0);
        this.header = undefined;
        this.unindexedLines = 0;
        this.duplicateIds = 0;
        this.parentCycleAt = null; // rebuildBranch below re-derives it; reset here like its siblings
        this.ingest(this.readRange(fd, 0, st.size), 0);
        this.rebuildBranch();
        this.bumpEpoch(st.ino);
        emitEvent("transcript.index.build", {
          label: cause,
          durMs: Date.now() - buildStartedMs,
          n1: st.size,
          n2: this.entryLines.length,
          n3: this.unindexedLines,
          n4: this.duplicateIds,
        });
      }
    } finally {
      fs.closeSync(fd);
    }
    this.ino = st.ino;
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return { epoch: this.epoch, entries: this.branch };
  }

  /** The file's byte size as of the last successful refresh() (0 before one) — R20's memory proxy. */
  get indexedBytes(): number {
    return Math.max(0, this.size);
  }

  /** Date.now() of the last refresh() call (0 before one) — the registry's thrash signal. */
  get lastRefreshAtMs(): number {
    return this.lastRefreshMs;
  }

  /**
   * Every indexed entry line in file order (a duplicated id once per line, as pi's `getEntries()`
   * has it) for stranded-row splicing. FORK 2026-09-24 (fix-cycle-hang): this was one entry per
   * id (first position, last copy), which silently dropped a prompt-key marker whose id a later line
   * reused, once a looping duplicated-id file began to be served from here.
   */
  allEntries(): readonly IndexedEntry[] {
    return this.entryLines.slice();
  }

  /** As of the last refresh(); see IndexFidelity. */
  fidelity(): IndexFidelity {
    return {
      header: this.header,
      unindexedLines: this.unindexedLines,
      duplicateIds: this.duplicateIds,
      unterminatedTail: this.unterminatedTail,
      parentCycleAt: this.parentCycleAt,
    };
  }

  private headerProbeMatches(fd: number): boolean {
    if (this.headerProbe.length === 0) return true;
    return this.readRange(fd, 0, this.headerProbe.length).equals(this.headerProbe);
  }

  private lastLineProbeMatches(fd: number): boolean {
    if (this.lastLineProbe.length === 0) return true;
    return this.readRange(
      fd,
      this.lastLineStart,
      this.lastLineStart + this.lastLineProbe.length,
    ).equals(this.lastLineProbe);
  }

  private readRange(fd: number, start: number, end: number): Buffer {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    if (len) fs.readSync(fd, buf, 0, len, start);
    return buf;
  }

  /** Consume complete lines only; a torn trailing line is left unconsumed for the next refresh. */
  private ingest(chunk: Buffer, chunkStart: number) {
    let cursor = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, cursor);
      if (nl < 0) break;
      this.processLine(chunk.subarray(cursor, nl), chunkStart + cursor);
      cursor = nl + 1;
    }
    this.offset = chunkStart + cursor;
    // Re-derived on every non-noop refresh: the unconsumed remainder is re-read from `offset`.
    this.unterminatedTail = cursor < chunk.length && parsesAsJson(chunk.subarray(cursor));
  }

  private processLine(lineBuf: Buffer, lineStart: number) {
    // Track rewrite-detection probes for every complete line consumed, regardless of whether it
    // parses: the header (always at byte 0) and the most recently ingested line.
    if (lineStart === 0) {
      this.headerProbe = Buffer.from(lineBuf.subarray(0, Math.min(PROBE_BYTES, lineBuf.length)));
    }
    this.lastLineStart = lineStart;
    this.lastLineProbe = Buffer.from(lineBuf.subarray(0, Math.min(PROBE_BYTES, lineBuf.length)));

    const text = lineBuf.toString("utf8");
    if (!text.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // corrupt line: skipped, offset/probes already advanced past it
    }
    if (lineStart === 0) this.header = raw;
    if (raw === null || typeof raw !== "object") {
      this.unindexedLines++;
      return;
    }
    const obj = raw as Record<string, unknown>;
    if (obj.type === "session") return; // header line, not an entry
    if (typeof obj.id !== "string") {
      this.unindexedLines++;
      return;
    }
    if (this.byId.has(obj.id)) this.duplicateIds++;
    const entry: IndexedEntry = {
      id: obj.id,
      parentId: typeof obj.parentId === "string" ? obj.parentId : null,
      hasParentKey: "parentId" in obj,
      type: String(obj.type),
      raw,
    };
    this.byId.set(obj.id, entry);
    this.entryLines.push(entry);
    this.leafId = obj.id;
  }

  /** Parent walk from the leaf, root → leaf; cycle-safe (walkParentChain documents what a loop serves). */
  private rebuildBranch() {
    const walked = walkParentChain(this.leafId, (id) => this.byId.get(id));
    this.branch = walked.branch;
    this.parentCycleAt = walked.cycleAt;
  }

  private bumpEpoch(ino: number) {
    epochGeneration++;
    this.epoch = `${EPOCH_NONCE}:${ino}:${epochGeneration}:${this.branch[0]?.id ?? "-"}`;
  }
}

function parsesAsJson(buf: Buffer): boolean {
  try {
    JSON.parse(buf.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * FORK 2026-09-24 (fix-cycle-hang) — THE parent walk: from `leafId` through `parentId` links,
 * returned root → leaf. It ends at a falsy parentId (a root), at an id `get` does not know (a
 * dangling parent), or at the first id it has already walked — a loop, reported as `cycleAt`. On a
 * loop the branch is the leaf's chain up to, not including, that second visit: root-most first it
 * starts at the entry whose parent is `cycleAt`, and ends at the leaf.
 *
 * pi's `getBranch()` is this walk minus the `walked` set (`while (current) { path.unshift(current);
 * current = current.parentId ? byId.get(current.parentId) : undefined }`), so wherever the chain
 * ends the two return the same entries in the same order, and where it loops pi never returns: an
 * infinite loop on the gateway main thread (a probe also ignored SIGTERM). Loops come from a
 * duplicated id whose last copy points back down its own chain, or two entries naming each other.
 * Keyed on the id LOOKED UP, never on the returned object, so a `get` that wraps or copies entries
 * cannot defeat it. Used by TranscriptIndex.rebuildBranch and, over pi's own index, by
 * session-utils.fs.ts readSessionBranchCycleSafe: one walk, one key, two callers.
 */
export function walkParentChain<E extends { parentId: string | null }>(
  leafId: string | null | undefined,
  get: (id: string) => E | undefined,
): { branch: E[]; cycleAt: string | null } {
  const leafToRoot: E[] = [];
  const walked = new Set<string>();
  let id = leafId;
  while (id) {
    if (walked.has(id)) {
      return { branch: leafToRoot.reverse(), cycleAt: id };
    }
    const entry = get(id);
    if (!entry) break;
    walked.add(id);
    leafToRoot.push(entry);
    id = entry.parentId;
  }
  return { branch: leafToRoot.reverse(), cycleAt: null };
}

// Ruling R20: an index holds every parsed entry (measured ~2-4x the file's size on the heap), so a
// count cap alone does not bound memory — sixteen 20 MB transcripts would pin ~1 GB. The registry
// also caps the summed byte size of the indexed files as of each index's last refresh.
// Ruling R31: 192 MiB sat at the real open-tab set (~170 MB) and thrashed, so the default is
// 512 MiB, overridable in bytes by OPENCLAW_TRANSCRIPT_INDEX_MAX_BYTES.
export const TRANSCRIPT_INDEX_REGISTRY_MAX_ENTRIES = 16;
export const TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES = 512 * 1024 * 1024;
export const TRANSCRIPT_INDEX_MAX_BYTES_ENV = "OPENCLAW_TRANSCRIPT_INDEX_MAX_BYTES";
/** Evicting an index refreshed this recently means the working set does not fit the cap. */
export const TRANSCRIPT_INDEX_THRASH_WINDOW_MS = 60_000;
const THRASH_WARN_INTERVAL_MS = 60_000;

/** The byte cap from the environment; an unset, non-numeric or non-positive value → the default. */
export function resolveTranscriptIndexMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TRANSCRIPT_INDEX_MAX_BYTES_ENV]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES;
}

const defaultRegistryLimits = () => ({
  maxEntries: TRANSCRIPT_INDEX_REGISTRY_MAX_ENTRIES,
  maxBytes: resolveTranscriptIndexMaxBytes(),
});
let registryLimits = defaultRegistryLimits();
const registry = new Map<string, TranscriptIndex>();

const log = createSubsystemLogger("gateway/transcript-index");
let thrashLog: ((message: string) => void) | undefined;
let lastThrashWarnMs = Number.NEGATIVE_INFINITY;
let thrashEvictionsSinceWarn = 0;

// ─── transcript.index.minute (logging.md §4.4) ──────────────────────────────
//
// Each TranscriptIndex counts its own noops, tail parses and full builds, and those counters DIE
// WITH THE INSTANCE when the LRU evicts it. The row is a DELTA, so an evicted index's totals are
// folded into `retired*` before the instance is dropped; without that the next window's delta
// would go negative, which is the exact failure a cumulative-minus-last-reported scheme invites.
// `reported*` is the cumulative total already emitted.
//
// The window is aligned to the MINUTE GRID, like the other rollups in this wave: a lazily-closed
// window that merely started at the first event would let a row stamped T0 cover a ten-minute idle
// gap, and a consumer reading a row named `.minute` would be wrong by that factor.
const TRANSCRIPT_ROLLUP_WINDOW_MS = 60_000;
let indexWindowStartMs = 0;
let retiredNoops = 0;
let retiredTailParses = 0;
let retiredFullBuilds = 0;
let reportedNoops = 0;
let reportedTailParses = 0;
let reportedFullBuilds = 0;
let windowEvictions = 0;
let windowThrashEvictions = 0;

function transcriptMinuteSlot(nowMs: number): number {
  return Math.floor(nowMs / TRANSCRIPT_ROLLUP_WINDOW_MS) * TRANSCRIPT_ROLLUP_WINDOW_MS;
}

/**
 * Emit the open window's row and open the next. Exported so the gateway's close prelude (and a
 * test) can close the last window deterministically. OWED: that wiring lives in server.impl.ts,
 * which this unit does not own, so today the window is closed only by a later registry call.
 *
 * `registry_entries`, `registry_bytes` and `cap_bytes` are GAUGES read at flush time and written
 * under the closing window's timestamp: they describe the state at the END of the minute the row
 * is stamped with, which is the only sampling point a lazily-closed rollup has.
 */
export function flushTranscriptIndexRollup(nowMs: number = Date.now()): void {
  let noops = retiredNoops;
  let tailParses = retiredTailParses;
  let fullBuilds = retiredFullBuilds;
  let bytes = 0;
  for (const held of registry.values()) {
    noops += held.stats.noops;
    tailParses += held.stats.tailParses;
    fullBuilds += held.stats.fullBuilds;
    bytes += held.indexedBytes;
  }
  emitEvent("transcript.index.minute", {
    tsMs: indexWindowStartMs === 0 ? transcriptMinuteSlot(nowMs) : indexWindowStartMs,
    n1: noops - reportedNoops,
    n2: tailParses - reportedTailParses,
    n3: fullBuilds - reportedFullBuilds,
    n4: windowEvictions,
    fields: {
      thrash_evictions: windowThrashEvictions,
      registry_entries: registry.size,
      registry_bytes: bytes,
      cap_bytes: registryLimits.maxBytes,
    },
  });
  reportedNoops = noops;
  reportedTailParses = tailParses;
  reportedFullBuilds = fullBuilds;
  windowEvictions = 0;
  windowThrashEvictions = 0;
  indexWindowStartMs = transcriptMinuteSlot(nowMs);
}

function noteEviction(evicted: TranscriptIndex, key: string) {
  const now = Date.now();
  const age = now - evicted.lastRefreshAtMs;
  if (evicted.lastRefreshAtMs <= 0 || age >= TRANSCRIPT_INDEX_THRASH_WINDOW_MS) return;
  thrashEvictionsSinceWarn++;
  // logging.md §4.4: the exact COUNT rides transcript.index.minute (thrash_evictions), which is
  // why the per-occurrence mark below may be throttled without losing the volume signal. It is
  // throttled on the SAME clock as the journal warning, deliberately: a registry over its cap
  // evicts a recently-read index on essentially every chat.history poll, and an unthrottled mark
  // would fill the writer's bounded 20,000-record queue — which drops the NEWEST record — so one
  // pathological registry would blind every other subsystem's events for the duration.
  windowThrashEvictions++;
  if (now - lastThrashWarnMs < THRASH_WARN_INTERVAL_MS) return;
  emitEvent("transcript.index.thrash", {
    n1: age,
    n2: registryLimits.maxBytes,
    n3: registry.size,
  });
  lastThrashWarnMs = now;
  const count = thrashEvictionsSinceWarn;
  thrashEvictionsSinceWarn = 0;
  const capMiB = Math.round(registryLimits.maxBytes / (1024 * 1024));
  (thrashLog ?? log.warn)(
    `transcript index registry is thrashing: evicted ${path.basename(key)} ` +
      `${Math.round(age / 1000)}s after its last read (${count} such eviction(s) since the last ` +
      `warning; cap ${capMiB} MiB / ${registryLimits.maxEntries} files; raise ` +
      `${TRANSCRIPT_INDEX_MAX_BYTES_ENV} if this repeats)`,
  );
}

/**
 * LRU registry of `TranscriptIndex` instances, keyed by file path. Evicts least-recently-used
 * indexes while the count exceeds TRANSCRIPT_INDEX_REGISTRY_MAX_ENTRIES or the summed
 * `indexedBytes` exceeds TRANSCRIPT_INDEX_REGISTRY_MAX_BYTES — never the index being returned,
 * which alone may exceed the byte cap. Sizes are as of each index's last refresh, so the index
 * handed out here is counted from the next call on.
 */
export function getTranscriptIndex(filePath: string): TranscriptIndex {
  // The window is advanced FIRST, before this call changes anything: the registry is the one seam
  // every history read passes through, so riding it beats a timer (nothing to unref, and a quiet
  // gateway emits nothing rather than a run of zeroes). Advancing after the eviction loop would
  // fold this call's evictions into the window that is closing while its refresh counters land in
  // the next one — one call of skew, in opposite directions, at every boundary.
  const nowMs = Date.now();
  const slot = transcriptMinuteSlot(nowMs);
  if (indexWindowStartMs === 0) {
    indexWindowStartMs = slot;
  } else if (slot !== indexWindowStartMs) {
    flushTranscriptIndexRollup(nowMs);
  }
  const ix = registry.get(filePath) ?? new TranscriptIndex(filePath);
  registry.delete(filePath);
  registry.set(filePath, ix);
  let bytes = 0;
  for (const held of registry.values()) bytes += held.indexedBytes;
  for (const [key, held] of registry) {
    if (registry.size <= registryLimits.maxEntries && bytes <= registryLimits.maxBytes) break;
    if (held === ix) continue;
    registry.delete(key);
    bytes -= held.indexedBytes;
    // Fold the evicted index's counters in before the instance is dropped, or the next window's
    // delta goes negative (logging.md §4.4).
    retiredNoops += held.stats.noops;
    retiredTailParses += held.stats.tailParses;
    retiredFullBuilds += held.stats.fullBuilds;
    windowEvictions++;
    noteEviction(held, key);
  }
  return ix;
}

// FORK 2026-09-24 (final whole-branch review item 10) — a tree transcript the index cannot serve
// row-for-row (session-utils.fs.ts loadTreeTranscriptFromIndex) goes to the legacy loader, which
// re-reads and re-parses the whole file on every cache miss: the M20 cost this branch removes,
// silently back for that file. Logged once per file per process, with the reason and the basename.
const legacyFallbackLogged = new Set<string>();
let legacyFallbackLog: ((message: string) => void) | undefined;

/**
 * logging.md L1/L4: a label is ONE categorical dimension, so the reason is folded to a lowercase
 * token. `indexFidelityGap` returns prose for two of its five cases ("no session header", "header
 * version 3"), and those contain spaces — the writer's label rule would NULL them rather than
 * reject them, so the row would land looking valid and saying nothing. That silent shape is the
 * failure mode this optic exists to end, which is why the fold is mechanical and not a convention.
 */
function fallbackReasonLabel(reason: string): string {
  const folded = reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return folded === "" ? "unknown" : folded;
}

export function noteLegacyLoaderFallback(filePath: string, reason: string): void {
  if (legacyFallbackLogged.has(filePath)) {
    return;
  }
  legacyFallbackLogged.add(filePath);
  // AFTER the dedupe guard, so the cadence is §4.4's "once per file per boot". Before it, a
  // transcript with a fidelity gap — i.e. one already paying the whole-file re-read — would emit
  // on every poll. KNOWN GAP: the row says WHY but not WHICH transcript, because its catalog row
  // declares no field that could carry a file identity and this unit does not own catalog.ts.
  emitEvent("transcript.legacy_fallback", { label: fallbackReasonLabel(reason) });
  (legacyFallbackLog ?? log.info)(
    `transcript ${path.basename(filePath)} is read by the legacy loader (${reason}): ` +
      "every change re-reads the whole file (logged once per file)",
  );
}

/** Test hook: capture the legacy-loader fallback line instead of logging it. */
export function __setLegacyLoaderFallbackLogForTest(sink: (message: string) => void): void {
  legacyFallbackLog = sink;
}

// FORK 2026-09-24 (fix-cycle-hang) — a transcript whose leaf chain loops is served from a
// cycle-safe walk (walkParentChain: this index's, or the legacy loader's over pi's own index)
// instead of pi's getBranch(), which never returns on it. Same once-per-file-per-process pattern as
// the legacy-loader note above, but a WARN: a loop means the file is damaged, and the rows served
// stop at the first repeated id. Basename only, never the directory.
const parentCycleLogged = new Set<string>();
let parentCycleLog: ((message: string) => void) | undefined;

export function noteTranscriptParentCycle(
  filePath: string,
  cycleAtId: string,
  walk: "index" | "legacy",
): void {
  if (parentCycleLogged.has(filePath)) {
    return;
  }
  parentCycleLogged.add(filePath);
  (parentCycleLog ?? log.warn)(
    `transcript ${path.basename(filePath)} has a parentId cycle at entry ${cycleAtId} ` +
      `(${walk} walk): serving the leaf's chain up to the first repeated id instead of pi's ` +
      "getBranch(), which never returns on a cycle (logged once per file)",
  );
}

/** Test hook: capture the parent-cycle warning instead of logging it. */
export function __setTranscriptParentCycleLogForTest(sink: (message: string) => void): void {
  parentCycleLog = sink;
}

/**
 * Also restores the default registry limits (re-reading the env), the thrash-warning state, the
 * legacy-loader fallback log, the parent-cycle log and the `transcript.index.minute` rollup.
 * The rollup MUST be reset here: `registry.clear()` drops instances without folding their stats
 * into `retired*`, so a surviving `reported*` would make the next window's delta negative.
 */
export function __resetTranscriptIndexRegistryForTest(): void {
  registry.clear();
  registryLimits = defaultRegistryLimits();
  thrashLog = undefined;
  lastThrashWarnMs = Number.NEGATIVE_INFINITY;
  thrashEvictionsSinceWarn = 0;
  legacyFallbackLogged.clear();
  legacyFallbackLog = undefined;
  parentCycleLogged.clear();
  parentCycleLog = undefined;
  indexWindowStartMs = 0;
  retiredNoops = 0;
  retiredTailParses = 0;
  retiredFullBuilds = 0;
  reportedNoops = 0;
  reportedTailParses = 0;
  reportedFullBuilds = 0;
  windowEvictions = 0;
  windowThrashEvictions = 0;
}

/** Test hook: capture the thrash warning instead of logging it. */
export function __setTranscriptIndexThrashLogForTest(sink: (message: string) => void): void {
  thrashLog = sink;
}

/** Test hook: shrink the registry limits so eviction can be exercised with tiny files. */
export function __setTranscriptIndexRegistryLimitsForTest(limits: {
  maxEntries?: number;
  maxBytes?: number;
}): void {
  registryLimits = { ...registryLimits, ...limits };
}

/** Test hook: registry keys, least- to most-recently used, without touching LRU order. */
export function __transcriptIndexRegistryKeysForTest(): string[] {
  return [...registry.keys()];
}
