// tinker-ui/src/model-recent-use.ts
//
// FORK 2026-10-02 (the architect: "sticky smart models that show me which models are currently in use, plus
// the ones recently used (which should have a way longer sticky time)" and "On mouseover on them, I
// would like to see the names of the tabs that are using them").
//
// Which models ran lately, and in which sessions. The collapsed SMART MODELS group shows a row only
// while it is `.model-live` or `.model-recent`. Before this, `.model-recent` was ONE model, the last
// one the viewed tab computed with, so a second model starting anywhere unpinned the first within
// seconds. Now every model seen live in the last RECENT_MODEL_STICKY_MS stays pinned, and the
// newest one stays pinned whatever its age (the 2026-06-14 bug #1 guarantee: a collapsed group is
// never left empty after work happened).
//
// The ledger is keyed by `modelCountKey`, the key the live count uses, and read through the same
// `catalogKeyIn` rule. So a row turns recent through exactly the key that lit it live; there is no
// second notion of "this model" here.
//
// Pure: the caller owns the map, the clock and the storage.

import { catalogKeyIn } from "./run-state.js";

/** How long a model stays pinned in the collapsed group after it last ran. */
export const RECENT_MODEL_STICKY_MS = 30 * 60_000;

/** Bound per model, so a busy cron model cannot grow the ledger (or localStorage) without limit. */
const MAX_SESSIONS_PER_MODEL = 12;

/** Lines a hover lists before it folds the rest into "+N more". */
const MAX_HINT_LINES = 8;

/** count key (`provider/model`, or a bare tail) → session key → last time seen live (ms). */
export type RecentModelLedger = Map<string, Map<string, number>>;

export type RecentModelUse = {
  /** When this model was last seen live, in any session. */
  lastAt: number;
  /** Sessions that ran it inside the sticky window ending at `lastAt`, newest first. */
  sessions: Array<{ key: string; at: number }>;
};

/**
 * Stamp every live model and the sessions running it with `now`.
 * Returns true when a model or a session is new to the ledger (worth persisting at once).
 */
export function recordLiveModels(
  ledger: RecentModelLedger,
  live: ReadonlyMap<string, readonly string[]>,
  now: number,
): boolean {
  let grew = false;
  for (const [model, sessions] of live) {
    if (sessions.length === 0) {
      continue;
    }
    let seen = ledger.get(model);
    if (!seen) {
      seen = new Map();
      ledger.set(model, seen);
      grew = true;
    }
    for (const key of sessions) {
      if (!seen.has(key)) {
        grew = true;
      }
      seen.set(key, now);
    }
  }
  return grew;
}

function lastSeen(seen: Map<string, number>): number {
  let last = -Infinity;
  for (const at of seen.values()) {
    if (at > last) {
      last = at;
    }
  }
  return last;
}

/** The model that ran last. It stays pinned past the window (bug #1). */
function newestModel(ledger: RecentModelLedger): string | undefined {
  let best: string | undefined;
  let bestAt = -Infinity;
  for (const [model, seen] of ledger) {
    const at = lastSeen(seen);
    if (at > bestAt) {
      best = model;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Drop what fell out of the window. Inside one model, a session older than the window ending at
 * that model's own last use goes; so the pinned newest model keeps the sessions of its last stretch.
 */
export function pruneRecentModels(
  ledger: RecentModelLedger,
  now: number,
  stickyMs: number = RECENT_MODEL_STICKY_MS,
): void {
  const keep = newestModel(ledger);
  for (const [model, seen] of ledger) {
    const last = lastSeen(seen);
    if (model !== keep && now - last > stickyMs) {
      ledger.delete(model);
      continue;
    }
    for (const [key, at] of seen) {
      if (last - at > stickyMs) {
        seen.delete(key);
      }
    }
    if (seen.size > MAX_SESSIONS_PER_MODEL) {
      const oldest = [...seen].sort((a, b) => a[1] - b[1]);
      for (const [key] of oldest.slice(0, seen.size - MAX_SESSIONS_PER_MODEL)) {
        seen.delete(key);
      }
    }
    if (seen.size === 0) {
      ledger.delete(model);
    }
  }
}

/** Recent use of catalog row `modelId`, or undefined when the row is not recent. */
export function recentUseForRow(
  ledger: RecentModelLedger,
  modelId: string,
  now: number,
  stickyMs: number = RECENT_MODEL_STICKY_MS,
): RecentModelUse | undefined {
  const key = catalogKeyIn(ledger, modelId);
  const seen = key ? ledger.get(key) : undefined;
  if (!key || !seen || seen.size === 0) {
    return undefined;
  }
  const lastAt = lastSeen(seen);
  if (now - lastAt > stickyMs && newestModel(ledger) !== key) {
    return undefined;
  }
  const sessions = [...seen]
    .filter(([, at]) => lastAt - at <= stickyMs)
    .map(([k, at]) => ({ key: k, at }))
    .sort((a, b) => b.at - a.at);
  return { lastAt, sessions };
}

export function serializeRecentModels(ledger: RecentModelLedger): string {
  const out: Record<string, Record<string, number>> = {};
  for (const [model, seen] of ledger) {
    out[model] = Object.fromEntries(seen);
  }
  return JSON.stringify(out);
}

/** Tolerant: anything malformed is skipped, never thrown. */
export function parseRecentModels(raw: string | null | undefined): RecentModelLedger {
  const ledger: RecentModelLedger = new Map();
  if (!raw) {
    return ledger;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ledger;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ledger;
  }
  for (const [model, sessions] of Object.entries(parsed as Record<string, unknown>)) {
    if (!model || !sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      continue;
    }
    const seen = new Map<string, number>();
    for (const [key, at] of Object.entries(sessions as Record<string, unknown>)) {
      if (key && typeof at === "number" && Number.isFinite(at)) {
        seen.set(key, at);
      }
    }
    if (seen.size > 0) {
      ledger.set(model, seen);
    }
  }
  return ledger;
}

export function agoLabel(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function bullets(lines: string[]): string {
  const shown = lines.slice(0, MAX_HINT_LINES).map((l) => `• ${l}`);
  if (lines.length > MAX_HINT_LINES) {
    shown.push(`+${lines.length - MAX_HINT_LINES} more`);
  }
  return shown.join("\n");
}

/**
 * The hover text of one model row: who is running it now, or, when idle, who ran it lately.
 * Empty when the row is neither live nor recent.
 *
 * A live row lists one line per session NAME with ×N when several runs share it, so the lines add
 * up to the count badge. An idle row lists each name once with the age of its newest run.
 */
export function modelRowHint(params: {
  live: readonly string[];
  recent?: RecentModelUse;
  nameOf: (sessionKey: string) => string;
  now: number;
}): string {
  const { live, recent, nameOf, now } = params;
  if (live.length > 0) {
    const tally = new Map<string, number>();
    for (const key of live) {
      const name = nameOf(key);
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    const lines = [...tally].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    return `Running now:\n${bullets(lines)}`;
  }
  if (recent && recent.sessions.length > 0) {
    const newestByName = new Map<string, number>();
    for (const { key, at } of recent.sessions) {
      const name = nameOf(key);
      if (!newestByName.has(name)) {
        newestByName.set(name, at);
      }
    }
    const lines = [...newestByName].map(([name, at]) => `${name} · ${agoLabel(at, now)}`);
    return `Used ${agoLabel(recent.lastAt, now)}:\n${bullets(lines)}`;
  }
  return "";
}
