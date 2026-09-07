// FORK 2026-08-24 (the architect: "when a tinkerclaw tab/session is unfocused, it sometimes does
// not show its thinking indicator, and it also disappears from the SESSIONS panel" — reported
// against a NEW context while an older session, NeuroCoin, kept working).
//
// THE LAST STALE INPUT. The three previous passes each fixed a different half of this same report:
//   run-state.ts             gave the four surfaces ONE PREDICATE
//   repaintActivitySurfaces  gave them ONE TRIGGER
//   pre-model-window.ts      gave them ONE STATE SET {live, pending}
// All three read the same array, `sessions[]` — and `sessions[]` has exactly ONE writer,
// `loadSessions()`, which runs on connect, on the first message in a tab, at turn END and on abort.
// Never DURING a turn. So the lane that actually knows the answer (`row.run`, which the gateway
// populates on 100% of rows) is a snapshot taken BEFORE the turn began, and every mid-turn verdict
// for a tab that is not on screen falls through to the client lane instead.
//
// background-runs.ts covered that gap from the client side, by catching the broadcast lifecycle
// frames as they went past. Measured on the wire 2026-08-24 (scripts/tinker-probe.mjs, 431 frames
// captured for one turn): a whole turn can carry as few as FOUR `lifecycle` frames — start,
// context-anatomy, end. The other 400+ are assistant/thinking/item/turn-stage, and NONE of them
// names a model, which is the gate that feeds `backgroundRuns`. So the client lane hangs on this
// browser receiving ONE frame at one instant. Miss it — the page was frozen by Chrome (app.ts
// already documents that failure at gwConnect), the socket reconnected mid-turn, or the run simply
// began before this browser connected — and the tab is dark for the WHOLE turn, with no correction
// path, because nothing ever re-reads the lane that knows better.
//
// THE GATEWAY WAS ALREADY OFFERING THE ANSWER. `sessions.subscribe` + the `sessions.changed` event
// push a FULL session row — `run:{live,…}`, `status`, model and all — and tinker-ui subscribed to
// neither (verified 2026-08-24: `sessions.changed` appeared nowhere under tinker-ui/src). Measured
// on the wire the same day, subscribed and watching a real turn:
//   reason:"start"   run:{live:true,count:1,since:…}   status:"running"
//   reason:"message" run:{live:true,…}
//   reason:"end"     run:{live:false,count:0}          status:"done"
// — delivered for EVERY session, including ones this client is not viewing. That is precisely the
// row shape `resolveSessionRunState` consumes, arriving at precisely the two moments a surface has
// to change. This module merges such a push into the snapshot so the authoritative lane is LIVE
// rather than a memory of the moment before the turn.
//
// Deliberately NOT a second opinion about liveness: nothing here decides whether a session is
// running. It only keeps `sessions[]` current so run-state.ts — still the ONE PREDICATE — is
// answering from fresh data. And it deliberately does NOT touch `sessionsFetchedAt`: that stamp
// means "when the WHOLE list was fetched", and bumping it on a single-session push would tell the
// resolver that every OTHER row is current too, retiring the client evidence that is currently the
// only thing lighting those tabs. That would fix one tab by breaking the rest.

/** A session row as the UI holds it. Only `key` is load-bearing here; the rest is passed through. */
export type LiveSessionRow = Record<string, unknown> & { key?: string };

/** Matches a candidate key against a reference key. app.ts passes `sessionKeyMatches`, which
 *  tolerates the canonical/short drift (`agent:main:tinker:abc` vs `tinker:abc`). */
export type KeyMatcher = (candidateKey: string, refKey: string) => boolean;

/** Envelope fields the broadcast adds around the row; never part of the row itself. */
const ENVELOPE_KEYS = new Set([
  "sessionKey",
  "phase",
  "reason",
  "ts",
  "runId",
  "messageId",
  "messageSeq",
  "session",
  "parentSessionKey",
  "label",
]);

/**
 * Pull the session row out of a `sessions.changed` payload.
 *
 * TWO SHAPES on the wire, both observed 2026-08-24 and both handled:
 *   • run-bearing pushes (reason start/message/end) nest the full row under `session`;
 *   • bookkeeping pushes (reason create/send) carry no `session` and spread a partial row
 *     (updatedAt, model, modelProvider, …) across the envelope itself.
 * Returns null when there is no usable key — a row we cannot attribute is not evidence about any
 * particular tab, and dropping it is strictly better than merging it onto the wrong one.
 */
export function extractChangedRow(
  payload: Record<string, unknown> | null | undefined,
): { key: string; row: LiveSessionRow } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const key = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  if (!key) {
    return null;
  }
  const nested = payload.session;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { key, row: { ...(nested as LiveSessionRow) } };
  }
  const row: LiveSessionRow = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!ENVELOPE_KEYS.has(k)) {
      row[k] = v;
    }
  }
  return { key, row };
}

/**
 * The fields a governed surface actually renders. Used to decide whether a push is worth a repaint.
 *
 * `sessions.changed` fires on every persisted message, so a long tool-using turn pushes steadily.
 * Repainting all four surfaces on each one would put updateBudgetPanel (which walks every session
 * row) on the message cadence. Comparing what is DISPLAYED keeps the repaint on the events that
 * change the picture — the same reasoning as `activityFingerprint` in app.ts.
 */
function livenessSignature(row: LiveSessionRow | undefined): string {
  if (!row) {
    return "-";
  }
  const run = row.run as { live?: unknown; count?: unknown } | undefined;
  const live = run && typeof run.live === "boolean" ? String(run.live) : "?";
  const count = run && typeof run.count === "number" ? String(run.count) : "?";
  const status = typeof row.status === "string" ? row.status : "?";
  const model = typeof row.model === "string" ? row.model : "?";
  const provider = typeof row.modelProvider === "string" ? row.modelProvider : "?";
  return `${live}|${count}|${status}|${model}|${provider}`;
}

/**
 * Merge one pushed row into the snapshot.
 *
 * MERGE, never replace: a push carries the row the gateway just rebuilt, but the surfaces also read
 * fields a given push may omit (cookiePhrase, token totals). Overwriting the row wholesale would
 * blank them until the next full `loadSessions()`, which is a visible regression in the panel this
 * change exists to fix.
 *
 * The EXISTING key wins on a match. The store's canonical key (`agent:main:tinker:abc`) and a tab's
 * short key (`tinker:abc`) both name the same session, and every other consumer already resolved
 * against whichever form the list handed it; re-keying the row underneath them would strand those
 * lookups. A session with no row yet is APPENDED — that is a tab whose first turn started between
 * two full fetches, exactly the case the panel used to render only via the open-tab injection.
 */
export function mergeChangedRow(params: {
  rows: readonly LiveSessionRow[] | null | undefined;
  key: string;
  row: LiveSessionRow;
  matches: KeyMatcher;
}): { rows: LiveSessionRow[]; changed: boolean } {
  const { key, row, matches } = params;
  const rows = Array.isArray(params.rows) ? [...params.rows] : [];
  if (!key) {
    return { rows, changed: false };
  }

  let idx = rows.findIndex((r) => r && typeof r.key === "string" && r.key === key);
  if (idx < 0) {
    idx = rows.findIndex((r) => r && typeof r.key === "string" && matches(r.key as string, key));
  }

  if (idx < 0) {
    rows.push({ ...row, key });
    return { rows, changed: true };
  }

  const existing = rows[idx];
  const merged: LiveSessionRow = { ...existing, ...row, key: existing.key as string };
  const changed = livenessSignature(existing) !== livenessSignature(merged);
  rows[idx] = merged;
  return { rows, changed };
}
