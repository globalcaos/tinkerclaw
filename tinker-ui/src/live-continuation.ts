// Pure, DOM-free: ONE WRITER PER RUN.
//
// FORK 2026-09-23 (the architect: "most of the time, the messages show repeated … if I refresh the page,
// the duplicate goes away … sometimes I see a thinking bubble up high being filled up with text,
// instead of appearing at the bottom like it should").
//
// THE DEFECT. The gateway streams a run as CUMULATIVE buffers: every text delta carries all the
// answer text of the run so far, every thinking event all the reasoning so far (cc-bridge
// concatenates across tool calls; server-chat.ts, tinker-bridge stream.ts). `chat.history`, on the
// other hand, serves a run as ROWS — and it serves the rows of a run that is STILL RUNNING (the
// claude-cli transcript is imported incrementally). So a page that gets history mid-run — a tab
// opened, switched to, reconnected or reloaded while Jarvis is working, and above all a background
// tab whose cache was hydrated from history — already shows part of the run when the next delta
// arrives. The writer then started the run from offset 0 and drew the whole run a second time.
// Measured on the saved page snapshots (~/.openclaw/data/tinker-ui-snapshot.*.html): 23 history
// rows of a turn, then one live bubble holding the whole 2,174-char answer buffer and one holding
// the whole 7,262-char reasoning buffer. A refresh shows only history, so the copy "went away".
//
// THE RULE. A run is written to the page exactly once. Whatever the page already shows of a run —
// history rows or bubbles this client wrote before a reset — is a prefix of that run's cumulative
// buffer, so the writer CONTINUES after it instead of restarting. This is a cursor, not a dedup:
// it never removes, hides or compares anything already on the page, it only decides where the
// next write begins, and it is scoped to the run's own turn so two answers that happen to be equal
// can never meet.
//
// The same cursor rule also gives thinking its place in the sequence. Reasoning used to live in ONE
// bubble per run, created at the run's first thought and grown in place for the whole run while
// text and tool rows were appended below it — the "thinking bubble up high being filled". Thinking
// now segments exactly like text: a text delta, a tool call or a block break closes the open
// segment, and the next thought opens a new bubble at the bottom.

/** A message as this module needs to see it: a bag of ad-hoc client fields. */
type Row = Record<string, unknown>;

function asRow(m: unknown): Row | null {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Row) : null;
}

function roleOf(r: Row): string {
  return typeof r.role === "string" ? r.role.toLowerCase() : "";
}

/** Client-only notes and foreign bubbles: never part of a run's streamed text. */
function isClientNote(r: Row): boolean {
  return (
    r._isWarning === true ||
    r._isError === true ||
    r._isOverloadRetry === true ||
    r._isPrefrontal === true ||
    r._isPhaseTiming === true ||
    (typeof r._subagentId === "string" && r._subagentId.length > 0)
  );
}

function blocksOf(r: Row): Array<Record<string, unknown>> {
  if (typeof r.content === "string") {
    return [{ type: "text", text: r.content }];
  }
  return Array.isArray(r.content)
    ? (r.content as unknown[]).filter((b): b is Record<string, unknown> => asRow(b) !== null)
    : [];
}

/** Does this row carry the run's identity (the prompt that started it)? `runId` is the
 *  chat.send idempotencyKey, which is also the client's `_clientMsgId` and the key the gateway
 *  stamps on the served user row. */
function isKeyedTo(r: Row, runId: string): boolean {
  if (r._clientMsgId === runId || r.idempotencyKey === runId) {
    return true;
  }
  const superseded = r.supersededIdempotencyKeys;
  return Array.isArray(superseded) && superseded.includes(runId);
}

/**
 * Index of the prompt row that opened this run's turn, or -1 when the page shows no prompt.
 *
 * The earliest of: the first row keyed to the run, and the last real prompt on the page. The
 * keyed row wins when present — it is identity. The last-prompt fallback covers a run the page did
 * not start (history rows of cc-bridge imports carry no key), and taking the EARLIER of the two
 * means a copy of the prompt appended at the bottom of the page (the outbox's re-drawn UNSENT or
 * LOST bubble) can never cut the run's own rows out of its turn.
 *
 * "A real prompt" is whatever `isPrompt` says, and that predicate OWNS the exclusion of a prompt
 * only this browser holds (being sent, unsent, lost): no run has started from it, so it is no turn
 * boundary. app.ts passes `isPromptRow`, which refuses one through msg-order.ts
 * `isBrowserOnlyPrompt`. This function reads no prompt state of its own. It used to read the
 * `_undelivered` flag, which prompt-queue.md step U2 retired, so that read could no longer fail.
 */
export function runTurnStart(
  page: readonly unknown[],
  runId: string,
  isPrompt: (m: unknown) => boolean,
): number {
  let keyed = -1;
  let lastPrompt = -1;
  for (let i = 0; i < page.length; i++) {
    const r = asRow(page[i]);
    if (r === null || roleOf(r) !== "user") {
      continue;
    }
    if (keyed < 0 && runId && isKeyedTo(r, runId)) {
      keyed = i;
    }
    if (isPrompt(r)) {
      lastPrompt = i;
    }
  }
  if (keyed < 0) {
    return lastPrompt;
  }
  return lastPrompt < 0 ? keyed : Math.min(keyed, lastPrompt);
}

export type RunStream = "text" | "reasoning";

/**
 * Whose rows count as "what this run shows": the run's own (`runId`) and, for a run that took over
 * a frozen turn, that turn's run (`alsoRunId`), whose replay it re-sends. A row this client stamped
 * for any OTHER run is not this run's text; a row with no stamp (history) may be, unless it was
 * stamped before the run started (`notBefore`, read with `timeOf`), which the caller knows only for
 * a run whose start this page saw. A row with no readable time is kept.
 */
export type RunScope = {
  runId: string;
  alsoRunId?: string;
  notBefore?: number;
  timeOf?: (m: unknown) => number | null;
};

/** The run a row was written for by this client (`_runId`, else `_reasoningRunId`), or null. */
function stampOf(r: Row): string | null {
  const s = typeof r._runId === "string" && r._runId ? r._runId : r._reasoningRunId;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/**
 * The texts the page already shows for one stream of the run whose turn starts at `turnStart`,
 * in page order. `text` = assistant answer/narration text blocks; `reasoning` = thinking bubbles
 * (live `_isReasoning` rows and history thinking rows, which loadChat normalises into the same
 * shape) plus raw `thinking` blocks a mixed history row still carries.
 *
 * FORK 2026-10-03 (review round 1) — with a `scope`, rows stamped for another run are skipped. Two
 * runs with no prompt of their own share the last prompt's turn, and a second one whose body
 * repeated the first one's words found the first run's bubble here, credited its body as shown and
 * wrote nothing: the answer missing until a reload. Identity, not text: history rows still count,
 * except those stamped before the run started (the same miss against an answer loaded from history).
 */
export function runShownTexts(
  page: readonly unknown[],
  turnStart: number,
  stream: RunStream,
  scope?: RunScope,
): string[] {
  const out: string[] = [];
  for (let i = Math.max(0, turnStart + 1); i < page.length; i++) {
    const r = asRow(page[i]);
    if (r === null || roleOf(r) !== "assistant" || isClientNote(r)) {
      continue;
    }
    if (scope) {
      const stamp = stampOf(r);
      if (stamp !== null && stamp !== scope.runId && stamp !== scope.alsoRunId) {
        continue;
      }
      if (stamp === null && scope.notBefore !== undefined && scope.timeOf) {
        const t = scope.timeOf(r);
        if (t !== null && t < scope.notBefore) {
          continue;
        }
      }
    }
    const reasoningRow = r._isReasoning === true;
    for (const b of blocksOf(r)) {
      const type = typeof b.type === "string" ? b.type : "";
      if (stream === "text" && !reasoningRow && type === "text") {
        out.push(typeof b.text === "string" ? b.text : "");
      } else if (stream === "reasoning" && reasoningRow && type === "text") {
        out.push(typeof b.text === "string" ? b.text : "");
      } else if (stream === "reasoning" && !reasoningRow && type === "thinking") {
        const t = typeof b.thinking === "string" ? b.thinking : b.text;
        out.push(typeof t === "string" ? t : "");
      }
    }
  }
  return out;
}

/** `raw` with whitespace runs collapsed to one space (edges dropped), plus the raw index each
 *  normalised character came from; `map[norm.length] === raw.length`. */
function normalizeWithMap(raw: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < raw.length) {
    if (/\s/.test(raw[i])) {
      const runStart = i;
      while (i < raw.length && /\s/.test(raw[i])) {
        i++;
      }
      if (chars.length > 0 && i < raw.length) {
        chars.push(" ");
        map.push(runStart);
      }
      continue;
    }
    chars.push(raw[i]);
    map.push(i);
    i++;
  }
  map.push(raw.length);
  return { norm: chars.join(""), map };
}

/**
 * A shown text that does not sit right at the cursor may still be found further on (a block the
 * page skipped, a history row whose joins differ) — but only when it is long enough that finding it
 * elsewhere is not a coincidence. A short "Done." must never make the cursor leap.
 */
export const MIN_DETACHED_MATCH = 24;

/**
 * How far into `buffer` (a run's cumulative stream) the page already shows, as a raw index into
 * `buffer`. 0 when the page shows none of it.
 *
 * `shown` are the run's on-page texts in page order (runShownTexts). Each is matched forward from
 * a cursor, whitespace-insensitively (history rows are trimmed and re-joined; the stream is raw):
 * a text that starts right at the cursor always advances it, a text found further on advances it
 * only when it is at least MIN_DETACHED_MATCH characters, and a text found nowhere is skipped.
 *
 * The FIRST match must be at the very start of the buffer. That is what makes the result mean
 * "the page shows the beginning of this run": texts the stream never carried (a stream restarted by
 * a bridge resume starts at a later row) are skipped until one opens the buffer, and texts of a
 * neighbouring turn — the previous answer, when a run with no prompt of its own (a reflection)
 * falls back to the previous prompt's turn — can never anchor on a sentence the new run quotes.
 */
export function shownPrefixEnd(buffer: string, shown: readonly string[]): number {
  if (typeof buffer !== "string" || buffer.length === 0 || shown.length === 0) {
    return 0;
  }
  const { norm, map } = normalizeWithMap(buffer);
  let cursor = 0;
  let anchored = false;
  for (const raw of shown) {
    const piece = normalizeWithMap(typeof raw === "string" ? raw : "").norm;
    if (piece === "") {
      continue;
    }
    // Adjacent: at the cursor, or after the single separator space between two pieces.
    const gap = norm[cursor] === " " ? 1 : 0;
    if (norm.startsWith(piece, cursor + gap)) {
      cursor += gap + piece.length;
      anchored = true;
      continue;
    }
    if (anchored && piece.length >= MIN_DETACHED_MATCH) {
      const at = norm.indexOf(piece, cursor);
      if (at >= 0) {
        cursor = at + piece.length;
      }
    }
  }
  if (cursor === 0) {
    return 0;
  }
  return cursor >= norm.length ? buffer.length : (map[cursor] ?? buffer.length);
}

/**
 * The write cursor of one stream of one run.
 *   `uid`   — the bubble currently being written into, or null when the segment is closed.
 *   `start` — where that bubble's slice begins in the cumulative buffer.
 *   `seen`  — the buffer as of the last write: everything in it is already on the page.
 */
export type SegmentCursor = { uid: string | null; start: number; seen: string };

export type SegmentWrite =
  /** Nothing new to put on the page. */
  | { kind: "none" }
  /** Set the open bubble's text to `text` — always an extension of what it shows. */
  | { kind: "grow"; text: string }
  /** Push a new bubble holding `text`, sliced from `start`. */
  | { kind: "open"; start: number; text: string };

/**
 * Decide the next write for one cumulative buffer. `openText` is the open bubble's current text,
 * or null when the cursor has no live bubble (closed segment, or the bubble is not on this page).
 *
 * The law: text on the page is never rewritten into something else. A buffer that extends what the
 * cursor has seen grows the open bubble or opens a new one at the first unshown character. A buffer
 * that does NOT extend it means the provider restarted the stream (a fallback model): the old
 * bubbles stay exactly as they are and the restarted stream is written as a new bubble.
 */
export function nextSegmentWrite(
  cur: SegmentCursor,
  buffer: string,
  openText: string | null,
): SegmentWrite {
  if (typeof buffer !== "string" || buffer.length === 0) {
    return { kind: "none" };
  }
  if (!buffer.startsWith(cur.seen)) {
    return buffer.trim() ? { kind: "open", start: 0, text: buffer } : { kind: "none" };
  }
  if (openText !== null && cur.uid !== null) {
    const text = buffer.slice(cur.start);
    if (text === openText || !text.startsWith(openText)) {
      return { kind: "none" };
    }
    return { kind: "grow", text };
  }
  const start = cur.seen.length;
  const text = buffer.slice(start);
  // Never open a bubble that would render as nothing; the whitespace stays unseen and leads the
  // next segment instead of being lost.
  return text.trim() ? { kind: "open", start, text } : { kind: "none" };
}

/** Apply a write's effect to the cursor (the caller has already applied it to the page). */
export function advanceCursor(
  cur: SegmentCursor,
  write: SegmentWrite,
  buffer: string,
  openedUid: string | null,
): SegmentCursor {
  if (write.kind === "grow") {
    return { uid: cur.uid, start: cur.start, seen: buffer };
  }
  if (write.kind === "open") {
    return { uid: openedUid, start: write.start, seen: buffer };
  }
  return cur;
}

/** Close the open segment: the next write opens a new bubble below whatever came in between. */
export function closeSegment(cur: SegmentCursor): SegmentCursor {
  return cur.uid === null ? cur : { uid: null, start: cur.start, seen: cur.seen };
}

// ─── A turn a gateway restart froze, taken over by a run with a NEW id ────────────────────────────
//
// FORK 2026-10-01 (TINKER_UI_DESIGN_BIBLE/bug-log.md [chat-divergence], cause 4: "the seamless
// restart repeats an answer"). A cc-bridge turn a restart froze is taken after the restart by a run
// with a NEW id (boot recovery's promptless continue, or a prompt that reached the held worker
// first), and the worker replays the turn's output from its first byte under that id. No row on the
// page is keyed to the new id, or only a prompt sent after the restart is, so the run's turn start
// resolved to no prompt or to a late one: the replay was written again from its first character
// below that prompt, its bubbles got no `_watchedFrom` or one after the restart, and the older-page
// / hole-fill writer wrote the frozen turn's served rows above it. The same answer twice; a reload
// showed one.
//
// The run now NAMES the turn it takes over, on its events (cc-bridge stream.ts: lifecycle start,
// text-block breaks, effort: `resumesRunId`, `resumesTurnStartedAt`). Identity, never inference: a
// run that names no turn (an announce, a cron, a heartbeat, every ordinary turn) is anchored exactly
// as before, because a wrong anchor would HIDE real rows, which is worse than a duplicate. Nothing
// here compares text, and an anchor only ever moves EARLIER, to where the replay really begins.

/** The turn a run says it takes over (named on its events, read by resumedTurnOf). */
export type ResumedTurn = {
  /** The frozen turn's run id: the key that turn's prompt carries on the page. */
  runId?: string;
  /** When the frozen turn started, in ms (the gateway's clock): where the replay begins. */
  startedAt?: number;
};

/** The turn an agent event's `data` says its run takes over, or null when it names none. */
export function resumedTurnOf(data: unknown): ResumedTurn | null {
  const d = asRow(data);
  if (d === null) {
    return null;
  }
  const runId =
    typeof d.resumesRunId === "string" && d.resumesRunId.length > 0 ? d.resumesRunId : undefined;
  const startedAt =
    typeof d.resumesTurnStartedAt === "number" && Number.isFinite(d.resumesTurnStartedAt)
      ? d.resumesTurnStartedAt
      : undefined;
  if (runId === undefined && startedAt === undefined) {
    return null;
  }
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

/** Index of the first user row keyed to `runId` (the prompt that opened that run), or -1. Identity
 *  only: unlike runTurnStart there is no last-prompt fallback, so a key the page lacks finds none. */
export function keyedRowIndex(page: readonly unknown[], runId: string): number {
  if (!runId) {
    return -1;
  }
  for (let i = 0; i < page.length; i++) {
    const r = asRow(page[i]);
    if (r !== null && roleOf(r) === "user" && isKeyedTo(r, runId)) {
      return i;
    }
  }
  return -1;
}

/** Index of the real prompt (`isPrompt`) with the latest time at or before `at`, or -1: the prompt
 *  that opened the turn running at `at`. Compared by time, not by page order, so a row a fill
 *  appended out of order cannot win by its position. */
function promptOpenAt(
  page: readonly unknown[],
  at: number,
  isPrompt: (m: unknown) => boolean,
  timeOf: (m: unknown) => number | null,
): number {
  let found = -1;
  let foundAt = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < page.length; i++) {
    const r = asRow(page[i]);
    if (r === null || roleOf(r) !== "user" || !isPrompt(r)) {
      continue;
    }
    const t = timeOf(r);
    if (t !== null && t <= at && t >= foundAt) {
      found = i;
      foundAt = t;
    }
  }
  return found;
}

/**
 * The turn start (runTurnStart's index) of a run that takes over a frozen turn: the frozen turn's
 * own prompt, found BY KEY (resumed.runId) or, without one on the page, as the prompt that opened
 * the turn running at the carried start (resumed.startedAt), whichever sits earliest, and only when
 * it sits EARLIER than `own`, the run's own turn start. Never later: the replay re-sends the frozen
 * turn from its first byte, and shownPrefixEnd anchors only on text that opens the replay's buffer.
 * `own` < 0 is returned as is: it already scans the whole page, the widest start there is, and any
 * index would only narrow it (a prompt copy redrawn below the turn would cut the replay off it).
 */
export function resumedTurnStart(
  page: readonly unknown[],
  own: number,
  resumed: ResumedTurn | undefined,
  isPrompt: (m: unknown) => boolean,
  timeOf: (m: unknown) => number | null,
): number {
  if (own < 0 || resumed === undefined) {
    return own;
  }
  let start = own;
  if (resumed.runId) {
    const keyed = keyedRowIndex(page, resumed.runId);
    if (keyed >= 0 && keyed < start) {
      start = keyed;
    }
  }
  if (resumed.startedAt !== undefined) {
    const opened = promptOpenAt(page, resumed.startedAt, isPrompt, timeOf);
    if (opened >= 0 && opened < start) {
      start = opened;
    }
  }
  return start;
}

/**
 * Where a run's live bubbles cover the page from (`_watchedFrom`) when it takes over a frozen turn:
 * the earliest of `own` (what the run's own turn start gives), the frozen turn's keyed prompt's
 * time on the page and the start time the bridge carried. Combined, never preferred: a keyed row
 * with a late time must not push the anchor past the carried start. The replay re-sends that turn
 * from its first byte, so every row the turn wrote from there on is on the page in the replay, and
 * a history fill must skip it as watched (history-reconcile.ts). A run that names no turn keeps
 * `own`.
 */
export function resumedRunWatchedFrom(
  page: readonly unknown[],
  own: number | undefined,
  resumed: ResumedTurn | undefined,
  timeOf: (m: unknown) => number | null,
): number | undefined {
  if (resumed === undefined) {
    return own;
  }
  const candidates: Array<number | null | undefined> = [own, resumed.startedAt];
  if (resumed.runId) {
    const keyed = keyedRowIndex(page, resumed.runId);
    if (keyed >= 0) {
      candidates.push(timeOf(page[keyed]));
    }
  }
  let from: number | undefined;
  for (const t of candidates) {
    if (typeof t === "number" && Number.isFinite(t) && (from === undefined || t < from)) {
      from = t;
    }
  }
  return from;
}
