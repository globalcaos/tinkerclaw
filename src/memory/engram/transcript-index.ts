/**
 * FORK 2026-10-09 — J1 TOTAL RECALL: `recall` searches the session TRANSCRIPTS.
 *
 * WHY. The pull tool used to search the per-session engram store, which keeps assistant text
 * only: 123 of 1,901 transcript messages for one Tinker chat, 51 of 6,211 for another, and no
 * user message or tool output at all (J1 gap note §2, M1/M6). A recall that cannot return what
 * the architect said, or what a command printed, cannot replace a turn that compaction evicted.
 *
 * WHAT. The gateway transcripts (`<agent>/sessions/<sessionId>.jsonl`, the files `chat.history`
 * and therefore `sessions_history` read) already hold every user turn, every assistant reply and,
 * on the cc-bridge lane, every worker tool call and result (`tinker-bridge-tool` entries). This
 * module keeps a SQLite FTS5 index of them, synced incrementally by byte offset.
 *
 * WHY AN INDEX AND NOT A SCAN. Measured 2026-10-09: a lower-cased substring scan of the 30-day
 * transcripts (258 files, 418 MB) took 6.1–7.5 s on the main thread. The gateway is one event loop,
 * so that is a 7 s freeze per call. The index answers in milliseconds, and keeping it current costs
 * only the bytes appended since the last sync.
 *
 * COST BOUNDS (measured 2026-10-09 on 3,557 transcripts, 668 MB). First build: 54 s in the
 * background, in slices, worst slice 188 ms. After that an incremental sync costs p50 0.4 ms,
 * p99 1.4 ms, and a search 1-10 ms (464 ms for a word as common as "the"). Every sync takes a
 * deadline and works in chunks. Checkpoint copies (`*.checkpoint.*.jsonl`, 2.6 GB) and prompt dumps
 * (`*.trajectory.jsonl`) are not transcripts and are never read. Records are capped at
 * MAX_RECORD_CHARS so one 50 MB tool result cannot dominate the index.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { emitJRecallResolve } from "../../infra/events/j-rows.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";

export type TranscriptRole = "user" | "assistant" | "tool";

export interface TranscriptRecord {
  role: TranscriptRole;
  /** ISO timestamp of the transcript entry ("" when the entry carried none). */
  ts: string;
  text: string;
}

export interface TranscriptHit {
  /** Absolute transcript path. */
  path: string;
  role: TranscriptRole;
  ts: string;
  /**
   * FTS5 snippet around the match (64 tokens, FTS5's maximum), matched terms wrapped in « ».
   * It is the payload: `sessions_history` returns a chat's last messages and cannot reach back
   * to an old hit.
   */
  snippet: string;
  /** bm25 score; lower is better. */
  score: number;
}

export type TranscriptSyncOutcome = "done" | "partial";

export interface TranscriptIndex {
  /** Bring one transcript up to date. Returns "partial" when `deadline` (epoch ms) cut it short. */
  syncFile(path: string, deadline: number): TranscriptSyncOutcome;
  /** True when the file is indexed up to its current size. */
  isCurrent(path: string): boolean;
  /** Every transcript path the index holds rows for. */
  indexedPaths(): string[];
  search(query: string, opts?: { limit?: number; paths?: readonly string[] }): TranscriptHit[];
  /**
   * Drop every row of one transcript, zeroing the freed pages (`secure_delete`), so a file that was
   * redacted in place is read again from byte 0 on its next sync. FORK 2026-10-25 (forget).
   */
  forgetFile(path: string): void;
  /**
   * Merge the full-text index and truncate the WAL, so the terms of dropped rows leave no copy in
   * the index segments or the log. 1.6 s on a 423 MB index (measured 2026-10-25): run it once after
   * a batch of forgetFile calls, never per sync.
   */
  compact(): void;
  close(): void;
}

/** Where the transcript index of one agent lives under the engram base dir. */
export function transcriptIndexPath(engramBaseDir: string, agentId: string): string {
  return join(engramBaseDir, `transcripts-${agentId}.sqlite`);
}

/** Longest text kept per record. Tool results beyond it are cut, not dropped. */
export const MAX_RECORD_CHARS = 4000;
/**
 * Bytes read (and committed) per chunk while syncing. A deadline is checked between chunks, and
 * FTS5's automerge work after each commit grows with the commit, so this bounds one slice.
 * Measured 2026-10-09 on the full 668 MB first build: 1 MB chunks stalled up to 618 ms, 256 KB
 * chunks 188 ms (24 of 4,028 slices over 100 ms), same 54 s total.
 */
const SYNC_CHUNK_BYTES = 256 * 1024;
/** A line longer than a chunk is read whole up to this size (19 of 250,554 lines on 2026-10-09). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Bytes compared to detect a transcript rewritten in place. */
const HEAD_BYTES = 256;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_TERMS = 12;

// The two blocks appended after the architect's own words in a Tinker prompt. Same patterns as the
// amygdala's `stripWrapper` (extensions/tinkerclaw-amygdala/src/situation.ts APPENDED_BLOCKS):
// indexing the Fractal doctrine would make every prompt before 2026-10-08 match its words.
const USER_APPENDED_BLOCKS = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*<!-- TINKERCLAW chat-row contract -->/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function stripAppendedBlocks(text: string): string {
  let s = text;
  for (const re of USER_APPENDED_BLOCKS) {
    const m = re.exec(s);
    if (m) {
      s = s.slice(0, m.index);
    }
  }
  return s;
}

function record(role: TranscriptRole, ts: string, text: string): TranscriptRecord | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return {
    role,
    ts,
    text: trimmed.length > MAX_RECORD_CHARS ? trimmed.slice(0, MAX_RECORD_CHARS) : trimmed,
  };
}

/**
 * One transcript line → the searchable record it carries, or null. Kept: user turns (wrapper
 * blocks stripped), assistant text, tool results, and the cc-bridge worker's tool calls and
 * results. Everything else (model snapshots, cache stamps, runtime-context headers) is noise.
 */
export function extractTranscriptRecord(line: string): TranscriptRecord | null {
  // Cheap pre-filter: most lines are bookkeeping, and JSON.parse is the sync's main cost.
  if (!line.includes('"message"') && !line.includes('"tinker-bridge-tool"')) {
    return null;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry)) {
    return null;
  }
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
  if (entry.type === "message" && isRecord(entry.message)) {
    const m = entry.message;
    const text = contentText(m.content);
    if (m.role === "user") {
      return record("user", ts, stripAppendedBlocks(text));
    }
    if (m.role === "assistant") {
      return record("assistant", ts, text);
    }
    if (m.role === "toolResult") {
      return record("tool", ts, text);
    }
    return null;
  }
  if (
    entry.type === "custom" &&
    entry.customType === "tinker-bridge-tool" &&
    isRecord(entry.data)
  ) {
    const d = entry.data;
    if (d.phase === "start" && typeof d.name === "string") {
      return record("tool", ts, `${d.name} ${JSON.stringify(d.args ?? {})}`);
    }
    if (d.phase === "result") {
      return record("tool", ts, typeof d.result === "string" ? d.result : JSON.stringify(d.result));
    }
  }
  return null;
}

/** True for a gateway transcript; false for checkpoint copies, prompt dumps and archives. */
export function isTranscriptFileName(name: string): boolean {
  return (
    name.endsWith(".jsonl") && !name.includes(".trajectory.") && !name.includes(".checkpoint.")
  );
}

/** Transcripts in `sessionsDir`, newest first. A missing directory is an empty list. */
export function listTranscriptFiles(sessionsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!isTranscriptFileName(name)) {
      continue;
    }
    const path = join(sessionsDir, name);
    try {
      files.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* deleted between readdir and stat */
    }
  }
  return files.toSorted((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

function readHead(fd: number, size: number): string {
  const len = Math.min(HEAD_BYTES, size);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, 0);
  return buf.toString("hex");
}

/** Same leading bytes over the length both heads cover (a file that grew keeps its old head). */
function sameHead(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** FTS5 query terms: letters, digits and `_` only, so quoting each term is always safe. */
function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const m of query.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (m[0].length >= 2) {
      terms.add(m[0]);
    }
    if (terms.size >= MAX_QUERY_TERMS) {
      break;
    }
  }
  return [...terms];
}

type FileRow = { offset: number; size: number; mtime_ms: number; head: string };

export function openTranscriptIndex(dbPath: string): TranscriptIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db: DatabaseSync = new DatabaseSync(dbPath);
  // synchronous = OFF: the index is a cache of files that stay on disk. A crash can at worst lose
  // the last commits, and the offsets in `files` roll back with them, so the next sync re-reads
  // those bytes. It halved the first build (97 s → 54 s, measured 2026-10-09).
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = OFF;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      head TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      offset INTEGER NOT NULL,
      role TEXT NOT NULL,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      UNIQUE (path, offset)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      text, content = 'records', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
      INSERT INTO records_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
      INSERT INTO records_fts (records_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
  `);

  const getFile = db.prepare("SELECT offset, size, mtime_ms, head FROM files WHERE path = ?");
  const putFile = db.prepare(
    "INSERT OR REPLACE INTO files (path, offset, size, mtime_ms, head) VALUES (?, ?, ?, ?, ?)",
  );
  const listFiles = db.prepare("SELECT path FROM files");
  const dropFile = db.prepare("DELETE FROM files WHERE path = ?");
  const dropRecords = db.prepare("DELETE FROM records WHERE path = ?");
  // OR IGNORE: two processes syncing the same file insert each line once (UNIQUE path+offset).
  const putRecord = db.prepare(
    "INSERT OR IGNORE INTO records (path, offset, role, ts, text) VALUES (?, ?, ?, ?, ?)",
  );
  const searchStatements = new Map<number, StatementSync>();

  function forget(path: string): void {
    db.exec("BEGIN");
    try {
      dropRecords.run(path);
      dropFile.run(path);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function indexChunk(path: string, buf: Buffer, end: number, baseOffset: number): void {
    db.exec("BEGIN");
    try {
      let start = 0;
      while (start < end) {
        let nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl > end) {
          nl = end;
        }
        // A "\n" byte never occurs inside a multi-byte UTF-8 sequence, so slicing on it is safe.
        const rec = extractTranscriptRecord(buf.toString("utf8", start, nl));
        if (rec) {
          putRecord.run(path, baseOffset + start, rec.role, rec.ts, rec.text);
        }
        start = nl + 1;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function syncFile(path: string, deadline: number): TranscriptSyncOutcome {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      forget(path);
      return "done";
    }
    let row = getFile.get(path) as FileRow | undefined;
    if (row && row.size === size && row.mtime_ms === mtimeMs && row.offset === size) {
      return "done";
    }
    const fd = openSync(path, "r");
    try {
      const head = readHead(fd, size);
      // Shrunk, or the first bytes changed: the file was rewritten, so its offsets mean nothing.
      if (row && (size < row.offset || !sameHead(row.head, head))) {
        forget(path);
        row = undefined;
      }
      let offset = row?.offset ?? 0;
      while (offset < size) {
        const len = Math.min(SYNC_CHUNK_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, offset);
        const lastNl = buf.lastIndexOf(0x0a, read - 1);
        if (lastNl < 0) {
          if (read < SYNC_CHUNK_BYTES) {
            break; // an unterminated last line: still being written, take it next time
          }
          // One line longer than a chunk (a huge tool result): read it whole, or step over it.
          const lineEnd = nextLineEnd(fd, offset + read, size);
          if (lineEnd < 0) {
            break;
          }
          if (lineEnd - offset <= MAX_LINE_BYTES) {
            const whole = Buffer.alloc(lineEnd - offset);
            readSync(fd, whole, 0, whole.length, offset);
            indexChunk(path, whole, whole.length - 1, offset);
          }
          offset = lineEnd;
        } else {
          indexChunk(path, buf, lastNl, offset);
          offset += lastNl + 1;
        }
        putFile.run(path, offset, size, mtimeMs, head);
        if (Date.now() >= deadline && offset < size) {
          return "partial";
        }
      }
      putFile.run(path, offset, size, mtimeMs, head);
      return "done";
    } finally {
      closeSync(fd);
    }
  }

  function isCurrent(path: string): boolean {
    const row = getFile.get(path) as FileRow | undefined;
    if (!row) {
      return false;
    }
    try {
      const st = statSync(path);
      return row.size === st.size && row.mtime_ms === st.mtimeMs;
    } catch {
      return false;
    }
  }

  function runSearch(
    match: string,
    limit: number,
    paths: readonly string[] | undefined,
  ): TranscriptHit[] {
    const n = paths?.length ?? 0;
    let stmt = searchStatements.get(n);
    if (!stmt) {
      const pathFilter = n > 0 ? `AND records.path IN (${Array(n).fill("?").join(", ")})` : "";
      stmt = db.prepare(
        `SELECT records.path AS path, records.role AS role, records.ts AS ts,
                snippet(records_fts, 0, '«', '»', '…', 64) AS snippet,
                bm25(records_fts) AS score
           FROM records_fts JOIN records ON records.id = records_fts.rowid
          WHERE records_fts MATCH ? ${pathFilter}
          ORDER BY score
          LIMIT ?`,
      );
      searchStatements.set(n, stmt);
    }
    return stmt.all(match, ...(paths ?? []), limit) as unknown as TranscriptHit[];
  }

  function search(
    query: string,
    opts?: { limit?: number; paths?: readonly string[] },
  ): TranscriptHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts?.limit ?? DEFAULT_LIMIT)));
    const quoted = terms.map((t) => `"${t}"`);
    // Every term first; when that finds nothing, any term (bm25 still ranks multi-term hits up).
    const hits = runSearch(quoted.join(" "), limit, opts?.paths);
    if (hits.length > 0 || quoted.length === 1) {
      return hits;
    }
    return runSearch(quoted.join(" OR "), limit, opts?.paths);
  }

  function forgetFile(path: string): void {
    db.exec("PRAGMA secure_delete = ON");
    try {
      forget(path);
    } finally {
      db.exec("PRAGMA secure_delete = OFF");
    }
  }

  function compact(): void {
    db.exec("PRAGMA secure_delete = ON");
    try {
      db.exec("INSERT INTO records_fts (records_fts) VALUES ('optimize')");
    } finally {
      db.exec("PRAGMA secure_delete = OFF");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  return {
    syncFile,
    isCurrent,
    indexedPaths: () => (listFiles.all() as Array<{ path: string }>).map((r) => r.path),
    search,
    forgetFile,
    compact,
    close: () => db.close(),
  };
}

/** Offset just past the next "\n" at or after `from`, or -1 when the file has none yet. */
function nextLineEnd(fd: number, from: number, size: number): number {
  const buf = Buffer.alloc(64 * 1024);
  let pos = from;
  while (pos < size) {
    const read = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    const nl = buf.indexOf(0x0a);
    if (nl >= 0 && nl < read) {
      return pos + nl + 1;
    }
    pos += read;
  }
  return -1;
}

/** A macrotask yield, so prompts and RPCs run between two sync slices. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export interface TranscriptCatchUp {
  /** Start a background pass over every transcript, unless one is running. */
  kick(): void;
  /** Transcripts not yet indexed to their current size, as of the last listing. */
  pending(): number;
  /** Resolves when the current pass ends (immediately when idle). Tests and shutdown use it. */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * Background sync of every transcript in `sessionsDir`, newest first, in slices of `sliceMs`
 * with a macrotask yield between slices so prompts and RPCs interleave. The first pass over a
 * fresh index is the only long one; later passes only read appended bytes.
 */
export function createTranscriptCatchUp(params: {
  index: TranscriptIndex;
  sessionsDir: string;
  sliceMs?: number;
  /** A kick within this long after the last pass ended is ignored (the listing stats every file). */
  minPassIntervalMs?: number;
}): TranscriptCatchUp {
  const sliceMs = params.sliceMs ?? 50;
  const minPassIntervalMs = params.minPassIntervalMs ?? 60_000;
  let running: Promise<void> | null = null;
  let stopped = false;
  let pendingCount = 0;
  let lastPassEndMs = Number.NEGATIVE_INFINITY;

  async function pass(): Promise<void> {
    const files = listTranscriptFiles(params.sessionsDir);
    // A transcript gone from disk (deleted, or renamed to `*.jsonl.reset.*` by /new) leaves the
    // index too; syncFile forgets a path it cannot stat. Recall answers from what is on disk.
    const listed = new Set(files);
    for (const path of params.index.indexedPaths()) {
      if (!listed.has(path) && !existsSync(path)) {
        params.index.syncFile(path, 0);
      }
    }
    const todo = files.filter((f) => !params.index.isCurrent(f));
    pendingCount = todo.length;
    for (const file of todo) {
      for (;;) {
        if (stopped) {
          return;
        }
        const outcome = params.index.syncFile(file, Date.now() + sliceMs);
        await yieldToEventLoop();
        if (outcome === "done") {
          break;
        }
      }
      pendingCount -= 1;
    }
  }

  return {
    kick() {
      if (running || stopped || Date.now() - lastPassEndMs < minPassIntervalMs) {
        return;
      }
      running = pass()
        .catch(() => {
          /* a failed pass leaves offsets where they were; the next kick resumes from there */
        })
        .finally(() => {
          running = null;
          lastPassEndMs = Date.now();
        });
    },
    pending: () => pendingCount,
    idle: () => running ?? Promise.resolve(),
    stop() {
      stopped = true;
    },
  };
}

export interface TranscriptRecallResult {
  hits: TranscriptHit[];
  /** False when the caller's own transcript was not fully synced within the budget. */
  sessionSynced: boolean;
  tookMs: number;
}

/**
 * One `recall` call: sync the caller's own transcript (so this chat is always current), search,
 * and write one `j.recall.resolve` row. `scope: "session"` searches only `sessionFile`.
 *
 * The own-transcript sync runs in 50 ms slices with a yield between them: a first call in a large
 * chat (the biggest live transcript was 42 MB on 2026-10-09) must not hold the gateway's event
 * loop for the whole budget.
 */
export async function recallTranscripts(params: {
  index: TranscriptIndex;
  query: string;
  scope: "session" | "all";
  sessionFile?: string;
  sessionKey?: string;
  limit?: number;
  syncBudgetMs?: number;
}): Promise<TranscriptRecallResult> {
  const startedMs = Date.now();
  let sessionSynced = true;
  if (params.sessionFile && existsSync(params.sessionFile)) {
    const endMs = startedMs + (params.syncBudgetMs ?? 2000);
    for (;;) {
      sessionSynced = params.index.syncFile(params.sessionFile, Date.now() + 50) === "done";
      if (sessionSynced || Date.now() >= endMs) {
        break;
      }
      await yieldToEventLoop();
    }
  }
  const hits =
    params.scope === "session" && !params.sessionFile
      ? []
      : params.index.search(params.query, {
          limit: params.limit,
          paths: params.scope === "session" ? [params.sessionFile as string] : undefined,
        });
  const oldestMs = hits.reduce<number | null>((oldest, hit) => {
    const at = Date.parse(hit.ts);
    return Number.isFinite(at) && (oldest === null || at < oldest) ? at : oldest;
  }, null);
  emitJRecallResolve({
    outcome: hits.length > 0 ? "hit" : "miss",
    pointerAgeMs: oldestMs === null ? null : Math.max(0, Date.now() - oldestMs),
    eventsReturned: hits.length,
    sessionKey: params.sessionKey ?? null,
  });
  return { hits, sessionSynced, tookMs: Date.now() - startedMs };
}

/** Session id a transcript path belongs to (its file name without `.jsonl`). */
export function transcriptSessionId(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}
