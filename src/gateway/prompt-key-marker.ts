// FORK 2026-09-08 (durable prompt key): the WRITE-ONCE proof that chat.send accepted a prompt.
//
// THE DEFECT (measured 2026-09-08: 93 re-dispatches across 45 sessions). A prompt the client could
// not PROVE was persisted is re-sent by the durable outbox (tinker-ui/src/outbox.ts) with its
// ORIGINAL idempotencyKey, and the gateway runs it AGAIN as a fresh turn — two different answers to
// one prompt. The only guards were `context.dedupe` (in-memory, DEDUPE_TTL_MS = 5 min,
// server-constants.ts:26, swept in server-maintenance.ts) and the in-flight controller map. Neither
// survives five minutes or a restart, and the transcript could not settle it either: chat.send only
// ever stamped the key onto the in-memory event (chat.ts emitUserTranscriptUpdate ->
// sessions/transcript-events.ts, listeners only, no file write), while the user row pi persists
// carries NO key (corpus: 46 of 5,480 branch user rows keyed; 0 of 546 on the work tab).
//
// THE FIX IS WRITE-ONCE AT THE SOURCE, NOT A COMPARISON AT THE BOUNDARY. Nothing here reads what a
// prompt SAYS — see the "dedup REMOVED" tombstone above `chatHandlers` in chat.ts for what deciding
// identity by content cost. ONE pi `custom` entry names the key, written before the prompt's user
// row: by chat.send before it dispatches, or, where chat.send could not write it, by the embedded
// runner just before pi persists the row (appendMissingPromptKeyMarkers below). Two readers
// consume it:
//   - chat.send: a key that misses both in-memory guards but has a marker on disk is a replay ->
//     echo the completed-run ack, start no second run;
//   - readSessionMessages (session-utils.fs.ts): stamp the key onto the user row chat.history
//     serves, which is what lets tinker-ui's reconcileWithHistory PROVE delivery and retire the
//     outbox entry. An ack never retires one (app.ts, resendOutboxEntry) — only the transcript may.
//
// A pi CustomEntry is the right carrier: "Does NOT participate in LLM context (ignored by
// buildSessionContext)" (session-manager.d.ts), so it costs zero tokens and cannot leak into a
// prompt; `openclaw.*` custom types are already the house convention (openclaw.cache-ttl).
//
// ORDER ON DISK IS FORWARD: [marker] ... [user row]. The marker is appended synchronously before
// dispatchInboundMessage is called; pi persists the user row at `message_end` INSIDE the run
// (pi-coding-agent agent-session.js, _processAgentEvent), and the runner opens the session file
// fresh per attempt (embedded-agent-runner/run/attempt.ts, SessionManager.open) so the marker is
// already the leaf and becomes the user row's parent. Live transcripts show the same shape for the
// pre-run `model-snapshot` custom entry. Attaching BACKWARDS would stamp turn N's key onto turn
// N-1's prompt, and because historyMatchesEntry (outbox.ts) trusts a keyed match unconditionally,
// the outbox would retire — delete — a prompt that was never persisted.
//
// FORK 2026-10-01 (`[chat-divergence]` cause 1, TINKER_UI_DESIGN_BIBLE/bug-log.md): THE FIRST
// PROMPT. chat.send can only write on a transcript that already holds an assistant row: until then
// pi buffers every append and the buffer dies with chat.send's SessionManager
// (sessionManagerPersistsAppends in chat.ts). Nothing wrote the key later, so a brand-new
// session's first prompt was never keyed and the outbox redrew it LOST beside its served row (6 of
// the owner's 10 bug reports). The runner holds the SessionManager that WILL flush, so it writes
// the marker itself, just before activeSession.prompt() (run/attempt.ts): on a cold session pi's
// first flush lands it right before the user row, where the pre-run `model-snapshot` entry lands
// too; on an established session chat.send's marker is already there and nothing is added. The
// order on disk stays forward.
//
// Pure module: no fs, no gateway context. chat.ts owns the transcript path and the file read;
// session-utils.fs.ts owns the walk that positions markers among the served rows; run/attempt.ts
// hands appendMissingPromptKeyMarkers the attempt's own SessionManager.

export const PROMPT_KEY_CUSTOM_TYPE = "openclaw.prompt-key";

/** The `data` payload of a prompt-key custom entry. */
export type PromptKeyMarkerData = {
  idempotencyKey: string;
  sessionKey: string;
  /**
   * Gateway clock when the marker was written (ms since epoch): chat.send's acceptance, or the
   * runner's write just before pi persisted the prompt (appendMissingPromptKeyMarkers).
   */
  ts: number;
};

/**
 * A marker positioned among the messages a transcript walk emitted. `messageIndex` is
 * `messages.length` at the moment the walk met the marker, i.e. the index of the first served row
 * that can belong to this prompt. Carried rather than re-derived because only the walker knows the
 * interleaving: markers never enter the served list.
 */
export type PromptKeyMarkerRef = {
  idempotencyKey: string;
  ts?: number;
  messageIndex: number;
};

export function buildPromptKeyMarker(params: {
  idempotencyKey: string;
  sessionKey: string;
  ts: number;
}): PromptKeyMarkerData {
  return {
    idempotencyKey: params.idempotencyKey,
    sessionKey: params.sessionKey,
    ts: params.ts,
  };
}

/** Is this parsed transcript entry one of our markers? */
export function isPromptKeyMarkerEntry(
  entry: unknown,
): entry is { type: "custom"; customType: string; data?: unknown } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; customType?: unknown };
  return record.type === "custom" && record.customType === PROMPT_KEY_CUSTOM_TYPE;
}

/** Read a marker's `data` into a positioned ref, or null when it carries no usable key. */
export function readPromptKeyMarkerRef(
  data: unknown,
  messageIndex: number,
): PromptKeyMarkerRef | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const { idempotencyKey, ts } = data as { idempotencyKey?: unknown; ts?: unknown };
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return null;
  }
  return {
    idempotencyKey,
    ...(typeof ts === "number" && Number.isFinite(ts) ? { ts } : {}),
    messageIndex,
  };
}

/**
 * Does the transcript already hold a marker for `idempotencyKey`?
 *
 * A whole-file LINE scan, deliberately not a SessionManager tree walk: this runs on the send path
 * for every key that misses both in-memory guards, `SessionManager.open` costs ~99 ms on a big
 * transcript (attempt.ts measures it), and a key is unique per prompt — if it appears anywhere in
 * the file, including an abandoned branch, that prompt WAS accepted. The substring gate comes
 * before JSON.parse so the common case (a genuinely new prompt) is one scan with zero parses.
 * Never throws: a malformed line is skipped, and the caller must degrade to "not found".
 */
export function findPromptKeyMarker(
  transcriptLines: readonly string[],
  idempotencyKey: string,
): { found: boolean; ts?: number } {
  if (!idempotencyKey) {
    return { found: false };
  }
  for (const line of transcriptLines) {
    if (!line.includes(idempotencyKey)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPromptKeyMarkerEntry(parsed)) {
      continue;
    }
    const ref = readPromptKeyMarkerRef(parsed.data, 0);
    if (ref?.idempotencyKey === idempotencyKey) {
      return ref.ts === undefined ? { found: true } : { found: true, ts: ref.ts };
    }
  }
  return { found: false };
}

/**
 * The two SessionManager methods the runner's write needs. pi's SessionManager has both; this
 * module names only their shape, so it stays free of pi and fs.
 */
export type PromptKeyMarkerWriter = {
  getEntries(): readonly unknown[];
  appendCustomEntry(customType: string, data?: unknown): unknown;
};

export type AppendPromptKeyMarkersResult =
  | { ok: true; appended: string[] }
  | { ok: false; appended: string[]; error: unknown };

/**
 * FORK 2026-10-01 (`[chat-divergence]` cause 1): the embedded runner's write. For each of
 * `promptKeys` the session holds no marker for yet, append one, in order; return the keys written.
 *
 * run/attempt.ts calls it with the attempt's own SessionManager just before activeSession.prompt(),
 * so each marker becomes the parent of the user row pi persists next. On a cold session that is
 * pi's first flush, the one write chat.send cannot make. Two placement rules are the caller's:
 * AFTER prepareSessionManagerForRun, which resets a transcript with no assistant row to its header
 * and so drops anything appended before it; and never after the reply, because a marker written
 * after its row keys the NEXT prompt (ORDER ON DISK above).
 *
 * A key with a marker ANYWHERE in the session is skipped: chat.send wrote it before dispatch, or an
 * earlier attempt of this run flushed it. One marker per prompt, the same "anywhere in the file"
 * rule findPromptKeyMarker reads by. Empty and repeated keys are skipped; no keys means no read and
 * no write. Never throws: a failed append returns `ok: false` with the keys written before it.
 */
export function appendMissingPromptKeyMarkers(
  sessionManager: PromptKeyMarkerWriter,
  params: {
    promptKeys: readonly string[] | undefined;
    sessionKey: string;
    /** Gateway clock at the write (ms since epoch). */
    ts: number;
  },
): AppendPromptKeyMarkersResult {
  const wanted: string[] = [];
  for (const key of params.promptKeys ?? []) {
    if (typeof key === "string" && key.length > 0 && !wanted.includes(key)) {
      wanted.push(key);
    }
  }
  const appended: string[] = [];
  if (wanted.length === 0) {
    return { ok: true, appended };
  }
  try {
    const held = new Set<string>();
    for (const entry of sessionManager.getEntries()) {
      if (!isPromptKeyMarkerEntry(entry)) {
        continue;
      }
      const ref = readPromptKeyMarkerRef(entry.data, 0);
      if (ref) {
        held.add(ref.idempotencyKey);
      }
    }
    for (const key of wanted) {
      if (held.has(key)) {
        continue;
      }
      sessionManager.appendCustomEntry(
        PROMPT_KEY_CUSTOM_TYPE,
        buildPromptKeyMarker({ idempotencyKey: key, sessionKey: params.sessionKey, ts: params.ts }),
      );
      held.add(key);
      appended.push(key);
    }
    return { ok: true, appended };
  } catch (error) {
    return { ok: false, appended, error };
  }
}

/**
 * FORK 2026-10-05 (bug-log `failover-reprompt`) — the prompt row an earlier attempt of THIS run
 * already wrote. A run can make several attempts (a provider failover, run.ts's thinking-level
 * retry), and each one used to end in activeSession.prompt(), which persisted the prompt again,
 * unkeyed, after the failed attempt's rows: one prompt shown twice on the served branch, 34 extra
 * copies in 31 runs between 09-23 and 10-05. A key is unique per prompt, so the user row this run's
 * marker claims on the branch IS that prompt, and the attempt continues from it instead.
 *
 * Walks the branch from root to leaf with attachPromptKeysToUserRows' bound: a marker for one of
 * `promptKeys` arms the claim, any other marker disarms it, and the first user message met while
 * armed is the claimed row. Undefined when nothing is claimed, or when a compaction follows the row
 * (a retry after a compaction keeps the prompt path).
 */
export function findPromptRowClaimedOnBranch(
  branchEntries: readonly unknown[],
  promptKeys: readonly string[] | undefined,
): { entryId: string; idempotencyKey: string } | undefined {
  const keys = new Set((promptKeys ?? []).filter((key) => typeof key === "string" && key !== ""));
  if (keys.size === 0) {
    return undefined;
  }
  let armed: string | undefined;
  let claimed: { entryId: string; idempotencyKey: string } | undefined;
  for (const raw of branchEntries) {
    const entry = (raw ?? {}) as TreeEntryLike;
    if (claimed) {
      if (entry.type === "compaction") {
        return undefined;
      }
      continue;
    }
    if (isPromptKeyMarkerEntry(entry)) {
      const ref = readPromptKeyMarkerRef(entry.data, 0);
      armed = ref && keys.has(ref.idempotencyKey) ? ref.idempotencyKey : undefined;
      continue;
    }
    const role = (entry.message as { role?: unknown } | undefined)?.role;
    if (armed && entry.type === "message" && role === "user" && typeof entry.id === "string") {
      claimed = { entryId: entry.id, idempotencyKey: armed };
    }
  }
  return claimed;
}

/**
 * A prompt row, as opposed to the synthetic rows readSessionMessages fabricates from non-message
 * entries — a tinker-bridge tool_result wears role:"user" too, and was never a prompt.
 */
function isPromptUserRow(row: unknown): row is Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return false;
  }
  const record = row as { role?: unknown; __openclaw?: { kind?: unknown } };
  if (record.role !== "user") {
    return false;
  }
  const kind = record.__openclaw?.kind;
  return kind !== "tinker-bridge-tool" && kind !== "cc-bridge-tool" && kind !== "compaction";
}

/**
 * Stamp each marker's key onto the user row it belongs to.
 *
 * Each marker claims the FIRST prompt user row at or after its `messageIndex` and BEFORE the next
 * marker's. That bound is the safety argument: a turn that died before pi wrote its user row leaves
 * a marker with an empty region, and it attaches NOTHING rather than reaching forward into the next
 * turn's prompt (which would make the outbox retire the wrong entry). A row that already carries a
 * key is left alone and still consumes the marker: the key on disk outranks the marker.
 *
 * Copy-on-write: returns a new array in which only the rows that gained a key are new objects, so
 * the input is never mutated and a second application is a no-op.
 */
export function attachPromptKeysToUserRows(
  messagesInOrder: readonly unknown[],
  markersInOrder: readonly PromptKeyMarkerRef[],
): unknown[] {
  const out = [...messagesInOrder];
  // FORK 2026-09-14 — orphan markers are reported, not silently dropped. A marker whose region
  // holds no prompt row is a send the gateway ACCEPTED whose run died before pi persisted the
  // user row (a restart, an abort, a supersede). The client's outbox entry for that key can
  // never be retired by a keyed match, so it sits under "NOT DELIVERED — WILL RETRY" forever
  // even when the user re-sent the same text and THAT run answered (another agent's tab, 2026-09-14:
  // markers 85f0278d… and 8e1a3742… back to back, one user row, answered at 12:28). The row the
  // NEXT marker claims therefore also carries the orphaned keys as `supersededIdempotencyKeys`,
  // so a client can retire an entry whose key is listed there AND whose text matches the row —
  // the text check stays on the client, which is the only side that has the entry's text. The
  // primary `idempotencyKey` is unchanged: the safety argument above still holds for it.
  let orphanedKeys: string[] = [];
  for (let m = 0; m < markersInOrder.length; m += 1) {
    const marker = markersInOrder[m];
    const start = Math.max(0, marker.messageIndex);
    const limit = Math.min(out.length, markersInOrder[m + 1]?.messageIndex ?? out.length);
    let claimed = false;
    for (let i = start; i < limit; i += 1) {
      const row = out[i];
      if (!isPromptUserRow(row)) {
        continue;
      }
      const keyed = typeof row.idempotencyKey === "string" && row.idempotencyKey.length > 0;
      if (!keyed || orphanedKeys.length > 0) {
        out[i] = {
          ...row,
          ...(keyed ? {} : { idempotencyKey: marker.idempotencyKey }),
          ...(orphanedKeys.length > 0 ? { supersededIdempotencyKeys: orphanedKeys } : {}),
        };
      }
      orphanedKeys = [];
      claimed = true;
      break;
    }
    if (!claimed) {
      orphanedKeys = [...orphanedKeys, marker.idempotencyKey];
    }
  }
  return out;
}

// FORK 2026-09-23 — STRANDED PROMPTS (the architect: "lingering messages in the ui that chase me, never
// actually engage, and they had already entered as prompt").
//
// A prompt sent WHILE a turn is running is written — marker, then user row — onto the leaf the
// file has at that moment. The running turn's SessionManager was opened before that and still
// holds the OLD leaf, so its reply is appended as a sibling of the marker. The prompt is now on a
// dead fork: it reached the run (it was steered in) but `getBranch()` never walks it, chat.history
// never serves it, and its key never comes back — so the client's outbox entry cannot be retired
// by anything and sits under "not delivered · will retry" for good. Measured 2026-09-23 over the
// 40 newest transcripts: 185 of 595 markers never keyed a served row; 116 of those were exactly
// this shape (marker + user row off-branch, reply on-branch).
//
// The fix serves the stranded row, keyed, at its place in time. It is identity-backed, not a text
// guess: the row is the marker's own child on disk. Guard against a DELIBERATE branch (a rewind /
// regenerate), which must stay hidden: the branch has to have moved on AFTER the stranded row was
// written — a later sibling that ignored it is the race, an earlier one is a real fork.

type TreeEntryLike = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
};

export type StrandedPromptRow = {
  idempotencyKey: string;
  /** The raw user message, as pi persisted it (the caller strips/decorates it like any other). */
  message: unknown;
  /** Entry id of the user row, for __openclaw.id. */
  entryId: string;
  /** Transcript time of the user row (ms). */
  ts: number;
};

function entryMs(entry: TreeEntryLike | undefined): number {
  if (!entry) {
    return Number.NaN;
  }
  if (typeof entry.timestamp === "number") {
    return entry.timestamp;
  }
  return typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
}

/**
 * Prompts that chat.send accepted and pi persisted, but that a concurrent append forked off the
 * served branch. Pure: takes every entry in the file and the served branch, returns the rows.
 */
export function findStrandedPromptRows(
  allEntries: readonly TreeEntryLike[],
  branchEntries: readonly TreeEntryLike[],
): StrandedPromptRow[] {
  const branchIds = new Set<string>();
  const branchChildOf = new Map<string, TreeEntryLike>();
  for (const e of branchEntries) {
    if (typeof e.id === "string") {
      branchIds.add(e.id);
    }
    if (typeof e.parentId === "string") {
      branchChildOf.set(e.parentId, e);
    }
  }
  const byId = new Map<string, TreeEntryLike>();
  const firstChildOf = new Map<string, TreeEntryLike>();
  for (const e of allEntries) {
    if (typeof e.id === "string") {
      byId.set(e.id, e);
    }
    if (typeof e.parentId === "string" && !firstChildOf.has(e.parentId)) {
      firstChildOf.set(e.parentId, e);
    }
  }
  const out: StrandedPromptRow[] = [];
  for (const marker of allEntries) {
    // Read the id BEFORE the guard: isPromptKeyMarkerEntry narrows `marker` to the custom
    // entry type, which does not declare `id`, so `marker.id` after it fails tsc/dts.
    const markerId = marker.id;
    if (!isPromptKeyMarkerEntry(marker) || typeof markerId !== "string") {
      continue;
    }
    if (branchIds.has(markerId)) {
      continue;
    }
    const ref = readPromptKeyMarkerRef(marker.data, 0);
    if (!ref) {
      continue;
    }
    const row = firstChildOf.get(markerId);
    const msg = row?.message as { role?: unknown } | undefined;
    if (!row || row.type !== "message" || msg?.role !== "user" || typeof row.id !== "string") {
      continue; // the run died before pi wrote the row — nothing was persisted, nothing to serve
    }
    // Nearest ancestor that IS on the served branch = the fork point.
    let fork: TreeEntryLike | undefined = marker;
    const seen = new Set<string>();
    while (fork && typeof fork.id === "string" && !branchIds.has(fork.id)) {
      if (seen.has(fork.id)) {
        fork = undefined;
        break;
      }
      seen.add(fork.id);
      fork = typeof fork.parentId === "string" ? byId.get(fork.parentId) : undefined;
    }
    if (!fork || typeof fork.id !== "string") {
      continue;
    }
    const rowTs = entryMs(row);
    const continuation = branchChildOf.get(fork.id);
    if (!continuation || !(entryMs(continuation) > rowTs)) {
      continue; // the branch moved on BEFORE this row existed: a deliberate fork, keep it hidden
    }
    out.push({
      idempotencyKey: ref.idempotencyKey,
      message: row.message,
      entryId: row.id,
      ts: rowTs,
    });
  }
  return out;
}

function rowMs(row: unknown): number {
  const t = (row as { timestamp?: unknown } | null)?.timestamp;
  if (typeof t === "number") {
    return t;
  }
  return typeof t === "string" ? Date.parse(t) : Number.NaN;
}

/**
 * Insert stranded rows (already built into served shape) at their place in time. Runs AFTER
 * attachPromptKeysToUserRows, whose marker positions are indices into the un-spliced list. A key
 * already served on any row is skipped, so a replayed prompt is never shown twice. Copy-on-write.
 */
export function spliceStrandedPromptRows(
  messagesInOrder: readonly unknown[],
  stranded: ReadonlyArray<{ row: Record<string, unknown>; ts: number }>,
): unknown[] {
  const out = [...messagesInOrder];
  const served = new Set<string>();
  for (const r of out) {
    const k = (r as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    if (typeof k === "string") {
      served.add(k);
    }
  }
  for (const s of [...stranded].sort((a, b) => a.ts - b.ts)) {
    const key = s.row.idempotencyKey;
    if (typeof key !== "string" || served.has(key)) {
      continue;
    }
    served.add(key);
    let at = out.findIndex((r) => rowMs(r) > s.ts);
    if (at < 0) {
      at = out.length;
    }
    out.splice(at, 0, s.row);
  }
  return out;
}
