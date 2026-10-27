// FORK 2026-09-12 — `sessions.list` request hygiene.
//
// Two rules, both learned the hard way on 2026-09-12 (sessions panel showed only
// the open tabs; the rebuilt bundle sent `includeHive:false` to a gateway built
// 09-08 whose schema — `additionalProperties:false` — rejected the field; the
// client turned the rejection into `[]`, overwrote the localStorage snapshot
// with that `[]`, and every server-only row vanished):
//
//   1. OMIT A FILTER AT ITS DEFAULT. Production runs the UI and the gateway from
//      the same working tree but they are built at different moments, so the
//      bundle is routinely newer than the gateway. An optional field that is
//      only sent when the user turned it on keeps a newer client valid against
//      an older schema; a field sent at its default breaks every call for no
//      information gained.
//   2. A FAILED FETCH IS NOT AN EMPTY SERVER. The caller keeps the list it
//      already has (and its snapshot) and says so on the console. Only a
//      response that actually carries a `sessions` array replaces the list —
//      including a genuinely empty one.

export type SessionsListFilters = {
  includeHive?: boolean;
  operatorId?: string | null;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
};

export type SessionsListParams = {
  includeHive?: true;
  operatorId?: string;
  includeGlobal?: true;
  includeUnknown?: true;
};

export function buildSessionsListParams(filters: SessionsListFilters): SessionsListParams {
  const params: SessionsListParams = {};
  if (filters.includeGlobal === true) params.includeGlobal = true;
  if (filters.includeUnknown === true) params.includeUnknown = true;
  if (filters.includeHive === true) params.includeHive = true;
  const operatorId = typeof filters.operatorId === "string" ? filters.operatorId.trim() : "";
  if (operatorId) params.operatorId = operatorId;
  return params;
}

export type SessionsFetchOutcome<T> =
  | { ok: true; sessions: T[] | undefined }
  | { ok: false; error: unknown };

export function settleSessionsFetch<T>(
  previous: T[],
  outcome: SessionsFetchOutcome<T>,
): { sessions: T[]; fetched: boolean } {
  if (outcome.ok && Array.isArray(outcome.sessions)) {
    return { sessions: outcome.sessions, fetched: true };
  }
  return { sessions: previous, fetched: false };
}
