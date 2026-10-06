// FORK 2026-10-02 (the architect: "The parallel worker's chat history seems to not be loading") — a session
// that is RESET keeps one transcript path, and every reset renames what it held to
// `<transcript>.reset.<ISO time>` (session-transcript-files.fs.ts archiveSessionTranscriptsDetailed).
// chat.history served only the live file, so a tab whose session is reset before every turn (the
// worker of a master-worker build) showed only its current turn after any reload; its earlier turns
// sat in the archives, served by nothing. `chat.history {resetArchive: N}` now serves the N-th newest
// archive, and the Tinker page asks for them when the owner scrolls past the start of the live
// transcript (tinker-ui.md §5.8W).
//
// This module is the file half: which archives a transcript has, and which OpenClaw session each one
// was written under (its `session` header). The id is what the tinker-bridge session map keys a
// claude-cli transcript on, so the archive gets its imports exactly as the live session does.

import fs from "node:fs";
import path from "node:path";
import { parseSessionArchiveTimestamp } from "../config/sessions/artifacts.js";

export type ResetArchiveRef = {
  /** Absolute path of the archived transcript. */
  path: string;
  /** When the reset archived it (epoch ms), from the file name. */
  resetAt: number;
};

/**
 * The reset archives of the transcript at `transcriptPath`, newest first. Only siblings named
 * `<basename>.reset.<archive timestamp>` count (config/sessions/artifacts.ts is the one parser of
 * that timestamp); `.deleted.` and `.bak.` archives, other sessions' archives and unparseable
 * names are not reset archives of this transcript. An unreadable directory has none.
 */
export function listResetArchives(transcriptPath: string): ResetArchiveRef[] {
  const dir = path.dirname(transcriptPath);
  const prefix = `${path.basename(transcriptPath)}.reset.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ResetArchiveRef[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const resetAt = parseSessionArchiveTimestamp(name, "reset");
    if (resetAt === null) {
      continue;
    }
    out.push({ path: path.join(dir, name), resetAt });
  }
  return out.toSorted((a, b) => b.resetAt - a.resetAt);
}

// FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — a tab's
// history is not one file's archives. Main's `/new` at 2026-10-02 12:12 started it on a NEW
// transcript path (a reset keeps the path; that command does not), so every reset of the old path
// — 534 messages from 2026-08-22 to 09-22 — sat beside a file no store entry named, served by
// nothing. What ties a transcript to its tab is the session's trajectory: its first line names the
// session key and the transcript file (`session.started`). Earlier copies count too: a repair
// rewrites a transcript after saving `<file>.bak-<pid>-<ms>` (session-file-repair.ts), a
// compaction saves `<stem>.checkpoint.<uuid>.jsonl` (session-compaction-checkpoints.ts), and an
// eviction archives `<file>.bak.<time>` (session-eviction.ts). They overlap what the tab already
// shows, which is why chat.history serves a copy only to a page that names its floor.

/** `reset`: a reset archive. `earlier`: a transcript the tab left. `copy`: a backup or checkpoint. */
export type SessionArchiveKind = "reset" | "earlier" | "copy";

/** What made a copy: a repair backup, an eviction backup, or a compaction checkpoint. */
export type SessionCopyOrigin = "repair" | "eviction" | "checkpoint";

export type SessionArchiveRef = ResetArchiveRef & {
  kind: SessionArchiveKind;
  /** A copy's: the transcript it was taken from (absolute), and what took it. */
  copyOf?: { base: string; origin: SessionCopyOrigin };
};

const RESET_ARCHIVE_RE = /^(.+\.jsonl)\.reset\./;
const REPAIR_BACKUP_RE = /^(.+\.jsonl)\.bak-\d+-(\d{10,})$/;
const EVICTION_BACKUP_RE = /^(.+\.jsonl)\.bak\./;
const CHECKPOINT_RE = /^(.+)\.checkpoint\.[^.]+\.jsonl$/;

/**
 * Every earlier transcript of the tab whose live transcript is `transcriptPath`, newest first by
 * `resetAt` — when it was set aside: a reset's or a backup's time from its name, otherwise its last
 * row's timestamp. The tab's transcripts are the live one and every file a trajectory in the same
 * directory names under `sessionKey`. `.deleted.` archives are not listed: maintenance never drops
 * a tab's entry (store-maintenance.ts isProtectedSessionKey), so they belong to other sessions.
 */
export function listSessionArchives(params: {
  sessionKey: string;
  transcriptPath: string;
}): SessionArchiveRef[] {
  const dir = path.dirname(params.transcriptPath);
  const live = path.basename(params.transcriptPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const bases = transcriptBasesOfKey(dir, names, params.sessionKey);
  bases.add(live);
  const out: SessionArchiveRef[] = [];
  const add = (
    name: string,
    resetAt: number | null | undefined,
    kind: SessionArchiveKind,
    copyOf?: { base: string; origin: SessionCopyOrigin },
  ) => {
    if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
      out.push({
        path: path.join(dir, name),
        resetAt,
        kind,
        ...(copyOf ? { copyOf: { base: path.join(dir, copyOf.base), origin: copyOf.origin } } : {}),
      });
    }
  };
  for (const name of names) {
    const reset = RESET_ARCHIVE_RE.exec(name);
    if (reset) {
      if (bases.has(reset[1])) {
        add(name, parseSessionArchiveTimestamp(name, "reset"), "reset");
      }
      continue;
    }
    const repair = REPAIR_BACKUP_RE.exec(name);
    if (repair) {
      if (bases.has(repair[1])) {
        add(name, Number(repair[2]), "copy", { base: repair[1], origin: "repair" });
      }
      continue;
    }
    const evicted = EVICTION_BACKUP_RE.exec(name);
    if (evicted) {
      if (bases.has(evicted[1])) {
        add(name, parseSessionArchiveTimestamp(name, "bak"), "copy", {
          base: evicted[1],
          origin: "eviction",
        });
      }
      continue;
    }
    if (name.endsWith(".trajectory.jsonl")) {
      continue;
    }
    const checkpoint = CHECKPOINT_RE.exec(name);
    if (checkpoint) {
      const base = `${checkpoint[1]}.jsonl`;
      if (bases.has(base)) {
        add(name, readLastTimestamp(path.join(dir, name)), "copy", { base, origin: "checkpoint" });
      }
      continue;
    }
    if (name !== live && bases.has(name)) {
      add(name, readLastTimestamp(path.join(dir, name)), "earlier");
    }
  }
  return out.toSorted((a, b) => b.resetAt - a.resetAt);
}

// FORK 2026-10-05 (the architect: "Some tabs in tinkerclaw appear without history. I should be able to
// scroll back until the beginning") — a compaction checkpoint is a snapshot of an append-only
// transcript, so the transcript still holds every byte of it. AcmeVision's live file (23 MB) had 22
// checkpoints of 15-23 MB, every one a byte-prefix of it, and its three repair backups differed only
// in their last line, the entry the repair rewrote. An archive read parsed each copy whole (the
// legacy loader, the claude-cli merge, the projection: synchronous, 35-63 s per read on the loaded
// box) only to cut every row away at the page's floor, and the gateway answered nothing else
// meanwhile: every open tab's history and live stream waited. A copy its base transcript holds is
// passed over unread; a copy that is not PROVEN held is served exactly as before.

/** Bytes read per step when comparing a copy with its base. */
const PREFIX_COMPARE_CHUNK_BYTES = 1024 * 1024;
/** The longest last line a copy may end with and still be proven held (a tool result can be long). */
const COPY_LAST_LINE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Proven results by copy state and base inode. A copy never changes; its base only grows by appends,
 * which keep its inode, while a repair or an eviction replaces it through a rename, which does not.
 */
const copyHeldMemo = new Map<string, boolean>();
const COPY_HELD_MEMO_MAX = 512;

export function __resetCopyHeldMemoForTest(): void {
  copyHeldMemo.clear();
}

/**
 * Whether every row of the copy `ref` is in the transcript it was taken from, so serving the copy
 * could only repeat rows: its bytes up to its last line are the base's, and its last line is the
 * base's line at the same offset (byte for byte; for a repair backup, the same entry, because the
 * repair rewrites the line it fixes). A repair backup must also hold at least one line before that
 * one. False when anything cannot be read or does not match: the copy is then served as before.
 */
export async function copyHeldByBase(ref: SessionArchiveRef): Promise<boolean> {
  if (ref.kind !== "copy" || !ref.copyOf) {
    return false;
  }
  let copyStat: fs.Stats;
  let baseStat: fs.Stats;
  try {
    [copyStat, baseStat] = await Promise.all([
      fs.promises.stat(ref.path),
      fs.promises.stat(ref.copyOf.base),
    ]);
  } catch {
    return false;
  }
  const key = `${ref.path}|${copyStat.size}|${copyStat.mtimeMs}|${baseStat.dev}:${baseStat.ino}`;
  const memo = copyHeldMemo.get(key);
  if (memo !== undefined) {
    return memo;
  }
  const held = await proveCopyHeld(ref.path, ref.copyOf.base, ref.copyOf.origin, copyStat.size);
  copyHeldMemo.set(key, held);
  while (copyHeldMemo.size > COPY_HELD_MEMO_MAX) {
    const oldest = copyHeldMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    copyHeldMemo.delete(oldest);
  }
  return held;
}

async function proveCopyHeld(
  copyPath: string,
  basePath: string,
  origin: SessionCopyOrigin,
  copySize: number,
): Promise<boolean> {
  if (copySize === 0) {
    return false;
  }
  let copy: fs.promises.FileHandle | undefined;
  let base: fs.promises.FileHandle | undefined;
  try {
    copy = await fs.promises.open(copyPath, "r");
    base = await fs.promises.open(basePath, "r");
    const lastLineStart = await findLastLineStart(copy, copySize);
    if (lastLineStart === null) {
      return false;
    }
    if (!(await sameBytes(copy, base, 0, lastLineStart))) {
      return false;
    }
    const copyLine = await readRange(copy, lastLineStart, copySize - lastLineStart);
    const baseLine = await readRange(base, lastLineStart, copyLine.length);
    if (copyLine.equals(baseLine)) {
      return true;
    }
    if (origin !== "repair" || lastLineStart === 0) {
      return false;
    }
    // The repair rewrote this line: the base must hold the same entry where it stood.
    const baseWhole = await readLineAt(base, lastLineStart);
    const copyId = entryIdOf(copyLine);
    return copyId !== undefined && baseWhole !== null && copyId === entryIdOf(baseWhole);
  } catch {
    return false;
  } finally {
    await copy?.close().catch(() => {});
    await base?.close().catch(() => {});
  }
}

/** Where the copy's last non-empty line starts; null when it is longer than the limit. */
async function findLastLineStart(
  file: fs.promises.FileHandle,
  size: number,
): Promise<number | null> {
  const span = Math.min(size, COPY_LAST_LINE_MAX_BYTES);
  const tail = await readRange(file, size - span, span);
  let end = tail.length;
  while (end > 0 && (tail[end - 1] === 0x0a || tail[end - 1] === 0x0d)) {
    end--;
  }
  if (end === 0) {
    return null;
  }
  const nl = tail.lastIndexOf(0x0a, end - 1);
  if (nl >= 0) {
    return size - span + nl + 1;
  }
  return span === size ? 0 : null;
}

async function sameBytes(
  a: fs.promises.FileHandle,
  b: fs.promises.FileHandle,
  from: number,
  to: number,
): Promise<boolean> {
  for (let at = from; at < to; at += PREFIX_COMPARE_CHUNK_BYTES) {
    const len = Math.min(PREFIX_COMPARE_CHUNK_BYTES, to - at);
    const [x, y] = await Promise.all([readRange(a, at, len), readRange(b, at, len)]);
    if (x.length !== len || !x.equals(y)) {
      return false;
    }
  }
  return true;
}

async function readRange(
  file: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buf, read, length - read, position + read);
    if (bytesRead === 0) {
      break;
    }
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** The line that starts at `position`, without its newline; null when none ends within the limit. */
async function readLineAt(file: fs.promises.FileHandle, position: number): Promise<Buffer | null> {
  const chunk = await readRange(file, position, COPY_LAST_LINE_MAX_BYTES);
  const nl = chunk.indexOf(0x0a);
  return nl >= 0 ? chunk.subarray(0, nl) : null;
}

function entryIdOf(line: Buffer): string | undefined {
  try {
    const id = (JSON.parse(line.toString("utf-8")) as { id?: unknown }).id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A trajectory's first line, reduced to what lineage needs; null = it names no key or file. */
type TrajectoryHead = { sessionKey: string; base: string } | null;

/** By trajectory path. A first line never changes once written, so it is read once. */
const trajectoryHeadMemo = new Map<string, TrajectoryHead>();

/** The transcript file names (in `dir`) that the trajectories there name under `sessionKey`. */
function transcriptBasesOfKey(dir: string, names: string[], sessionKey: string): Set<string> {
  const out = new Set<string>();
  const present = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".trajectory.jsonl")) {
      continue;
    }
    const file = path.join(dir, name);
    present.add(file);
    let head = trajectoryHeadMemo.get(file);
    if (head === undefined) {
      const read = readTrajectoryHead(file, dir);
      if (read === undefined) {
        continue; // not readable yet (being written): asked again next time
      }
      head = read;
      trajectoryHeadMemo.set(file, head);
    }
    if (head !== null && head.sessionKey === sessionKey) {
      out.add(head.base);
    }
  }
  const prefix = `${dir}${path.sep}`;
  for (const file of trajectoryHeadMemo.keys()) {
    if (file.startsWith(prefix) && !present.has(file)) {
      trajectoryHeadMemo.delete(file);
    }
  }
  return out;
}

/** Undefined when the first line cannot be read or parsed yet; null when it names no key or file. */
function readTrajectoryHead(file: string, dir: string): TrajectoryHead | undefined {
  const first = readFirstLine(file);
  if (!first) {
    return undefined;
  }
  let parsed: { sessionKey?: unknown; sessionId?: unknown; data?: { sessionFile?: unknown } };
  try {
    parsed = JSON.parse(first);
  } catch {
    // A first line longer than the head read (2 of 3,914 on 2026-10-03, up to 101 KB): its leading
    // fields are still there, in the order the trajectory writer emits them. Without a key it is a
    // line still being written, asked again next time.
    const field = (name: string) => new RegExp(`"${name}":"([^"]+)"`).exec(first)?.[1];
    if (!field("sessionKey")) {
      return undefined;
    }
    parsed = {
      sessionKey: field("sessionKey"),
      sessionId: field("sessionId"),
      data: { sessionFile: field("sessionFile") },
    };
  }
  const sessionKey = typeof parsed?.sessionKey === "string" ? parsed.sessionKey : "";
  const sessionFile = parsed?.data?.sessionFile;
  const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
  const base =
    typeof sessionFile === "string" && path.resolve(path.dirname(sessionFile)) === path.resolve(dir)
      ? path.basename(sessionFile)
      : sessionId
        ? `${sessionId}.jsonl`
        : "";
  return sessionKey && base ? { sessionKey, base } : null;
}

/** Bytes read from a transcript's end for its last row's timestamp. */
const TAIL_READ_BYTES = 64 * 1024;
const ISO_TIMESTAMP_RE = /"timestamp":\s*"([^"]+)"/g;

/** The last `"timestamp":"<ISO>"` in the file's tail, as epoch ms; undefined when there is none. */
function readLastTimestamp(file: string): number | undefined {
  let tail: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_READ_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  let last: number | undefined;
  for (const m of tail.matchAll(ISO_TIMESTAMP_RE)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) {
      last = t;
    }
  }
  return last;
}

/** Test-only: forget the trajectory heads read so far. */
export function __resetTrajectoryHeadMemoForTest(): void {
  trajectoryHeadMemo.clear();
}

/** Bytes read to find the header: it is the first line, and a header is a few hundred bytes. */
const HEADER_READ_BYTES = 4096;

export type ArchiveHead = { sessionId?: string; startedAt?: number };

/**
 * The archive's `{"type":"session"}` header: the id it was written under and when the session
 * started. Empty when the file cannot be read or does not start with one.
 */
export function readArchiveHead(archivePath: string): ArchiveHead {
  const firstLine = readFirstLine(archivePath);
  if (firstLine === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown; timestamp?: unknown };
    if (parsed?.type !== "session") {
      return {};
    }
    const out: ArchiveHead = {};
    if (typeof parsed.id === "string" && parsed.id.trim()) {
      out.sessionId = parsed.id.trim();
    }
    const t = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
    if (Number.isFinite(t)) {
      out.startedAt = t;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The first `max` distinct tool-call ids of an archived transcript: tinker-bridge tool records
 * (`custom` / `tinker-bridge-tool`, `data.toolCallId`) and tool calls inside messages. They are what
 * ties an archive to its claude-cli transcript when the header's id is unknown to the bridge map.
 */
export function readArchiveToolCallIds(archivePath: string, max = 3): string[] {
  let text: string;
  try {
    text = fs.readFileSync(archivePath, "utf-8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v && !ids.includes(v)) {
      ids.push(v);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (ids.length >= max) {
      break;
    }
    if (!line.includes("toolCallId") && !line.includes('"id"')) {
      continue;
    }
    let row: { type?: unknown; customType?: unknown; data?: unknown; message?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "custom" && row.customType === "tinker-bridge-tool") {
      add((row.data as { toolCallId?: unknown } | undefined)?.toolCallId);
    } else if (row.type === "message") {
      const content = (row.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = block as { type?: unknown; id?: unknown } | null;
        if (b && (b.type === "toolCall" || b.type === "tool_use")) {
          add(b.id);
        }
      }
    }
  }
  return ids.slice(0, max);
}

/** Chunk size for scanning a candidate claude-cli transcript; the scan stops at the first match. */
const CLI_MATCH_CHUNK_BYTES = 1024 * 1024;
/** A candidate is scanned at most this far (a CLI transcript is a few MB; this bounds a stray one). */
const CLI_MATCH_MAX_BYTES = 64 * 1024 * 1024;
const TOOL_ID_RE = /toolu_[A-Za-z0-9_]+/g;

/** Every tool-call id an archived transcript holds (the set a CLI transcript's head is checked against). */
export function readArchiveToolCallIdSet(archivePath: string): Set<string> {
  return new Set(readArchiveToolCallIds(archivePath, Number.MAX_SAFE_INTEGER));
}

/** Matches already made: archives never change, so a match is made once per file state. */
const cliMatchMemo = new Map<string, string[]>();
const CLI_MATCH_MEMO_MAX = 64;

/**
 * The claude-cli transcripts (their session ids = file names, oldest first) whose turns an archive
 * holds: last written inside [fromMs, toMs], and holding a tool call the archive also holds. Each
 * candidate is read in 1 MB chunks until the first hit; the archive's set holds every tool call of
 * every CLI session it spans, so a session rebound mid-span is found too. Tool-call ids are unique.
 * NOT a head read: a CLI transcript opens with hook context and the prompt, and its first tool
 * call sat 370-390 KB in on the worker's transcripts (2026-10-02; a 256 KB head matched nothing).
 * Measured: one hit per single-session archive, 4–29 candidates with the window bounded by the
 * archive's own session start.
 */
export async function findArchiveCliSessionIds(params: {
  toolCallIds: Iterable<string>;
  fromMs: number;
  toMs: number;
  projectsDir: string;
  /** Memo key (archive path + size + mtime); omitted = no memo. */
  memoKey?: string;
}): Promise<string[]> {
  if (params.memoKey !== undefined) {
    const hit = cliMatchMemo.get(params.memoKey);
    if (hit !== undefined) {
      return hit;
    }
  }
  const ids = new Set(params.toolCallIds);
  if (ids.size === 0) {
    return [];
  }
  let projects: fs.Dirent[];
  try {
    projects = await fs.promises.readdir(params.projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const dir = path.join(params.projectsDir, project.name);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.mtimeMs >= params.fromMs && st.mtimeMs <= params.toMs) {
          candidates.push({ file, mtimeMs: st.mtimeMs });
        }
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const hits: string[] = [];
  const buf = Buffer.alloc(CLI_MATCH_CHUNK_BYTES);
  for (const c of candidates) {
    if (await fileHoldsAnyToolId(c.file, ids, buf)) {
      hits.push(path.basename(c.file, ".jsonl"));
    }
  }
  if (params.memoKey !== undefined) {
    cliMatchMemo.set(params.memoKey, hits);
    while (cliMatchMemo.size > CLI_MATCH_MEMO_MAX) {
      const oldest = cliMatchMemo.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cliMatchMemo.delete(oldest);
    }
  }
  return hits;
}

/** Scan `file` chunk by chunk for any id in `ids`; a short overlap keeps an id split by a chunk edge. */
async function fileHoldsAnyToolId(file: string, ids: Set<string>, buf: Buffer): Promise<boolean> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, "r");
  } catch {
    return false;
  }
  try {
    let carry = "";
    for (let pos = 0; pos < CLI_MATCH_MAX_BYTES; ) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) {
        return false;
      }
      const text = carry + buf.subarray(0, bytesRead).toString("utf-8");
      for (const m of text.matchAll(TOOL_ID_RE)) {
        if (ids.has(m[0])) {
          return true;
        }
      }
      carry = text.slice(-64);
      pos += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

/** Test-only: forget memoised matches. */
export function __resetArchiveCliMatchMemoForTest(): void {
  cliMatchMemo.clear();
}

function readFirstLine(filePath: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(HEADER_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
      head = buf.subarray(0, n).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return head.split(/\r?\n/, 1)[0] ?? "";
}

/**
 * The OpenClaw session id an archived transcript was written under: the `id` of its first line
 * when that line is a `{"type":"session"}` header. Undefined when the file cannot be read or does
 * not start with one.
 */
export function readArchiveSessionId(archivePath: string): string | undefined {
  return readArchiveHead(archivePath).sessionId;
}
