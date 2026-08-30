// FORK 2026-08-23 (the architect: "the chat should be immutable, meaning that once something is written
// it should not be erased ... make them stick (no disappearences allowed)").
//
// WHY THE ROWS VANISHED, precisely.
//
// `loadChat` already preserves client-only bubbles across a RECONNECT: `_isPhaseTiming` has been
// in `CLIENT_ONLY_FLAGS` since 2026-08-15 and `reinsertByTurnAnchor` puts them back. That half
// works, and it is why the defect looked intermittent.
//
// The half that does not: **the message list is persisted NOWHERE.** The UI writes tabs, the
// composer draft, the outbox and the prompt journal to localStorage, and nothing else. So a
// browser reload — or the clean-exit site-data wipe this profile performs — starts with an empty
// `messages`, `loadChat` fills it from SERVER history, and every row the server never had
// (phase timings, warnings, retries, stop notices) has no source to come back from. Preserving
// something in memory cannot survive the memory going away.
//
// This module is the missing store: the same shape of answer as `outbox.ts`, for the same reason.
// A prompt the gateway never received exists only in the browser, and so does a measurement the
// gateway never stored.
//
// DOM-free and global-free, the outbox.ts / msg-order.ts precedent: app.ts is a 24k-line browser
// entry with no unit-test harness, so a rule left inlined there is a rule with no test.

/** localStorage key. Distinct from `tinker-outbox`: that store is DELIVERY state and every removal
 *  from it is a judgement. This one is a transcript and nothing may remove from it but eviction. */
const STORAGE_KEY = "tinker-client-rows";

/**
 * Per-session cap. A long session is exactly the one whose history matters, so this is generous —
 * but it is a cap, because localStorage is a few MB shared with drafts, tabs, the outbox and
 * months of EEG samples, and a quota failure would take the OUTBOX down with it.
 */
export const MAX_ROWS_PER_SESSION = 400;

/** Sessions retained. Oldest-touched evicted first. */
export const MAX_SESSIONS = 24;

export type StoredClientRow = {
  /** Stable identity, so re-injection is idempotent across repeated loadChat calls. */
  id: string;
  /** The message object, exactly as the UI pushed it. */
  row: Record<string, unknown>;
  /** Turn anchor at capture time, so it can be put back where it belongs, not at the tail. */
  turn: number;
  /** Capture time — the eviction order and nothing else. */
  ts: number;
};

type Store = Record<string, StoredClientRow[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return foldLegacyKeys(parsed as Store);
  } catch {
    // A corrupt store is not worth a crash and not worth a silent wipe either: returning empty
    // means this load shows fewer rows, and the next write rebuilds it.
    return {};
  }
}

/**
 * FORK 2026-08-24 — ONE session, TWO keys, and the rows split between them.
 *
 * The architect: "One with a fresh window only shows 'sending', nothing else."
 *
 * A new tab mints its own short key (`tinker:mt6w3ltz`) and sends under it. The gateway answers
 * with the canonical form (`agent:main:tinker:mt6w3ltz`) and the tab rebinds — MID-TURN. So the
 * `sending` row, written the moment `chat.send` resolves, lands in one bucket, and every row after
 * the rebind lands in another. `sessionKeyMatches` has always tolerated both forms; this store
 * indexed the raw string, so it did not. A restore then reads one bucket and shows exactly the
 * rows that happened to be on that side of the rename.
 *
 * Normalising on READ rather than only on write also migrates what is already on disk: an existing
 * profile has months of rows under both spellings, and a write-side-only fix would strand them.
 */
function normalizeSessionKey(key: string): string {
  const trimmed = (key ?? "").trim();
  // `agent:<agentId>:<rest>` and `<rest>` are the same session. Only this one prefix is stripped —
  // guessing more aggressively would merge genuinely different sessions, and a merged transcript
  // is a worse failure than a split one.
  const match = /^agent:[^:]+:(.+)$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function foldLegacyKeys(store: Store): Store {
  const out: Store = {};
  for (const [key, rows] of Object.entries(store)) {
    if (!Array.isArray(rows)) {
      continue;
    }
    const canonical = normalizeSessionKey(key);
    out[canonical] = out[canonical] ? [...out[canonical], ...rows] : [...rows];
  }
  for (const key of Object.keys(out)) {
    // Ids embed the key they were minted under, so the same row cannot appear twice — but a
    // future re-fold could, and a duplicated timing row reads as a duplicated turn.
    const seen = new Set<string>();
    out[key] = out[key]
      .filter((r) => {
        const id = r?.id;
        if (typeof id !== "string" || seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      })
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }
  return out;
}

/**
 * Write, shedding the oldest half on a quota failure and retrying ONCE.
 *
 * Verbatim the lesson from `writeOutbox`: a full localStorage turned that whole feature into a
 * silent no-op, and this origin holds months of drafts, tabs and EEG stores. Returns whether the
 * write landed, because a caller that cannot persist should know rather than assume.
 */
function writeStore(store: Store): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    try {
      for (const key of Object.keys(store)) {
        const rows = store[key];
        if (Array.isArray(rows) && rows.length > 1) {
          store[key] = rows.slice(Math.floor(rows.length / 2));
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }
}

/** Evict least-recently-touched sessions. Recency is the newest row in each session. */
function pruneSessions(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_SESSIONS) {
    return;
  }
  const newestTs = (k: string): number => {
    const rows = store[k];
    return Array.isArray(rows) && rows.length > 0 ? (rows[rows.length - 1]?.ts ?? 0) : 0;
  };
  keys
    .sort((a, b) => newestTs(a) - newestTs(b))
    .slice(0, keys.length - MAX_SESSIONS)
    .forEach((k) => delete store[k]);
}

/**
 * Persist one client-only row for a session.
 *
 * Returns the id it was stored under, or null when it could not be persisted — a caller that
 * silently assumes success is how the outbox bug survived its first fix.
 */
export function recordClientRow(
  sessionKey: string,
  row: Record<string, unknown>,
  turn: number,
  now: number = Date.now(),
): string | null {
  const key = normalizeSessionKey(sessionKey);
  if (!key || !row) {
    return null;
  }
  const store = readStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];
  // Monotonic within a session and stable across reloads: the id must survive being written,
  // read back and compared, so it cannot be a random value regenerated on restore.
  const id = `${key}:${now}:${rows.length}`;
  rows.push({ id, row: { ...row, _clientRowId: id }, turn, ts: now });
  // Oldest-first eviction INSIDE a session. The newest rows are the ones being looked at.
  store[key] = rows.length > MAX_ROWS_PER_SESSION ? rows.slice(-MAX_ROWS_PER_SESSION) : rows;
  pruneSessions(store);
  return writeStore(store) ? id : null;
}

/**
 * Overwrite an already-stored row in place.
 *
 * FORK 2026-08-24 — the timing block MUTATES. It is created when the turn's first stage starts and
 * keeps being filled for the next half-minute, so `recordClientRow` alone would persist the empty
 * first version and a reload would restore a block with one running stage in it forever. Appending
 * a fresh row per update would restore N partial copies of the same block, which is the crawl this
 * whole change exists to remove — hence an UPDATE, not another append.
 *
 * Returns false when the id is unknown (evicted, or another origin's store): the caller must not
 * assume a write landed. Nothing here removes a row — an unknown id is left alone, not re-added,
 * because eviction is the only sanctioned way a row leaves this store.
 */
export function updateClientRow(
  sessionKey: string,
  id: string,
  row: Record<string, unknown>,
): boolean {
  const key = normalizeSessionKey(sessionKey);
  if (!key || !id || !row) {
    return false;
  }
  const store = readStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const idx = rows.findIndex((r) => r && typeof r === "object" && r.id === id);
  if (idx < 0) {
    return false;
  }
  rows[idx] = { ...rows[idx], row: { ...row, _clientRowId: id } };
  store[key] = rows;
  return writeStore(store);
}

/** Every stored row for a session, oldest first. */
export function readClientRows(sessionKey: string): StoredClientRow[] {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return [];
  }
  const rows = readStore()[key];
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object" && r.row) : [];
}

/**
 * The rows for `sessionKey` that are NOT already on screen.
 *
 * Idempotent by `_clientRowId`, because `loadChat` runs on every reconnect and a row re-injected
 * twice is a worse failure than one missing: a doubled measurement reads as two events.
 */
export function missingClientRows(
  sessionKey: string,
  present: readonly unknown[],
): StoredClientRow[] {
  const seen = new Set<string>();
  for (const m of present) {
    const id = (m as Record<string, unknown> | null)?._clientRowId;
    if (typeof id === "string" && id) {
      seen.add(id);
    }
  }
  return readClientRows(sessionKey).filter((r) => !seen.has(r.id));
}

/** Test seam. Never called in production — nothing in the delivery path may clear this store. */
export function clearClientRowsForTest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
