// FORK 2026-11-03 — THALAMUS seat routing for Claude Code workers.
//
// WHAT THIS IS FOR. An install can hold more than one Claude subscription ("seat"). Each one has a
// 5-hour and a 7-day window with its own reset. Unspent quota is lost at the reset, so a worker
// should always run on the seat whose WEEKLY reset comes first, as long as neither of that seat's
// windows is spent. When it is, the worker moves to the next seat; when the 5-hour window resets,
// the first seat is again the soonest with room and the worker moves back.
//
// SEATS. `primary` is the login the CLI already has (its own ~/.claude, or a host-level
// CLAUDE_CODE_OAUTH_TOKEN); nothing is added to its spawn. Every other seat is a gateway auth
// profile `anthropic:seat-<name>` of type `token` (a one-year `claude setup-token`, inference
// scope, never refreshed, so it cannot rotate a refresh token another program also holds). With
// no such profile, the only seat is `primary` and nothing here changes a spawn: a fresh clone is
// unaffected.
//
// WHAT WE KNOW ABOUT A SEAT comes from its own workers: Claude Code prints a `rate_limit_event`
// after each request, with every window the account has (`unifiedWindows`). A seat nobody has used
// yet is unknown; it is used only when every known seat is blocked.

import fs from "node:fs";
import path from "node:path";
import { ensureAuthProfileStore, resolveApiKeyForProfile } from "openclaw/plugin-sdk/agent-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const PRIMARY_SEAT = "primary";
export const SEAT_PROFILE_PREFIX = "anthropic:seat-";

const HOUR = 3_600_000;
const WINDOW_MS: Record<"fiveHour" | "sevenDay", number> = {
  fiveHour: 5 * HOUR,
  sevenDay: 168 * HOUR,
};

export type SeatWindow = {
  /** 0..1, as Claude Code reports it. */
  utilization?: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** `allowed`, `allowed_warning`, `rejected`. */
  status?: string;
};

export type SeatState = { fiveHour?: SeatWindow; sevenDay?: SeatWindow; at: number };

/** Epoch ms until which the seat cannot take work, or undefined when it can. */
export function seatBlockedUntil(state: SeatState | undefined, now: number): number | undefined {
  if (!state) return undefined;
  let until: number | undefined;
  for (const key of ["fiveHour", "sevenDay"] as const) {
    const w = state[key];
    if (!w) continue;
    const spent = w.status === "rejected" || (w.utilization ?? 0) >= 1;
    if (!spent) continue;
    const end = w.resetsAt ?? state.at + WINDOW_MS[key];
    if (end > now) until = Math.max(until ?? 0, end);
  }
  return until;
}

/** The seat's next weekly reset, rolled forward past `now`; Infinity when unknown. */
function nextWeeklyReset(state: SeatState | undefined, now: number): number {
  let r = state?.sevenDay?.resetsAt;
  if (r == null) return Number.POSITIVE_INFINITY;
  while (r <= now) r += WINDOW_MS.sevenDay;
  return r;
}

/**
 * The seat a worker should spawn on. Among seats that can take work, the soonest weekly reset wins
 * (ties keep the order of `seats`, primary first). When all are blocked, the one free soonest.
 */
export function chooseSeat(
  seats: readonly string[],
  states: Readonly<Record<string, SeatState | undefined>>,
  now: number,
): string {
  if (seats.length <= 1) return seats[0] ?? PRIMARY_SEAT;
  const open = seats.filter((s) => seatBlockedUntil(states[s], now) === undefined);
  if (open.length > 0) {
    return open
      .map((s, i) => ({ s, i, r: nextWeeklyReset(states[s], now) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)[0].s;
  }
  return seats
    .map((s, i) => ({ s, i, u: seatBlockedUntil(states[s], now) ?? now }))
    .sort((a, b) => a.u - b.u || a.i - b.i)[0].s;
}

/** Reads one `rate_limit_event` line into a seat state; undefined for any other line. */
export function seatStateFromEvent(line: unknown, now: number): SeatState | undefined {
  const rec = line as { type?: unknown; rate_limit_info?: Record<string, unknown> };
  if (!rec || rec.type !== "rate_limit_event" || !rec.rate_limit_info) return undefined;
  const info = rec.rate_limit_info;
  const win = (v: unknown): SeatWindow | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    return {
      ...(typeof o.utilization === "number" ? { utilization: o.utilization } : {}),
      ...(typeof o.resetsAt === "number" ? { resetsAt: o.resetsAt * 1000 } : {}),
      ...(typeof o.status === "string" ? { status: o.status } : {}),
    };
  };
  const unified = info.unifiedWindows as Record<string, unknown> | undefined;
  if (unified && typeof unified === "object") {
    // The account lists every window it has; one it leaves out is not there (no 5h limit open).
    return { fiveHour: win(unified.five_hour), sevenDay: win(unified.seven_day), at: now };
  }
  const type = info.rateLimitType;
  const single = win({ status: info.status, resetsAt: info.resetsAt });
  if (type === "five_hour") return { fiveHour: single, at: now };
  if (type === "seven_day") return { sevenDay: single, at: now };
  return undefined;
}

// ── live state, persisted so a gateway restart remembers which seat is spent ─────────────────────

const SEATS_PATH_ENV = "OPENCLAW_TINKER_BRIDGE_SEATS";

function statePath(): string {
  return (
    process.env[SEATS_PATH_ENV] ||
    path.join(resolveStateDir(), "tinker-bridge", "claude-seats.json")
  );
}

let states: Record<string, SeatState> | undefined;

function loadStates(): Record<string, SeatState> {
  if (states) return states;
  try {
    states = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Record<string, SeatState>;
  } catch {
    states = {};
  }
  return states;
}

export function getSeatStates(): Readonly<Record<string, SeatState>> {
  return loadStates();
}

/** Records what a worker on `seat` just reported. Never throws. */
export function noteSeatLine(seat: string, line: unknown, now = Date.now()): void {
  try {
    const next = seatStateFromEvent(line, now);
    if (!next) return;
    const all = loadStates();
    const prev = all[seat];
    // A single-window event (no unifiedWindows) updates only the window it names.
    all[seat] = "fiveHour" in next && "sevenDay" in next ? next : { ...prev, ...next, at: now };
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 });
  } catch {
    // Counting only: a failed write costs a stale choice, never a turn.
  }
}

/** `primary` plus every `anthropic:seat-*` token profile in the gateway's auth store. */
export function listSeats(): string[] {
  try {
    const store = ensureAuthProfileStore();
    const extra = Object.entries(store.profiles ?? {})
      .filter(
        ([id, cred]) =>
          id.startsWith(SEAT_PROFILE_PREFIX) &&
          (cred as { type?: string } | undefined)?.type === "token",
      )
      .map(([id]) => id)
      .sort();
    return [PRIMARY_SEAT, ...extra];
  } catch {
    return [PRIMARY_SEAT];
  }
}

/** The seat a new worker should use now. */
export function seatForSpawn(now = Date.now()): string {
  return chooseSeat(listSeats(), loadStates(), now);
}

/** The token for a non-primary seat, or undefined (the worker then stays on primary). */
export async function seatToken(seat: string): Promise<string | undefined> {
  if (seat === PRIMARY_SEAT) return undefined;
  try {
    const res = await resolveApiKeyForProfile({ store: ensureAuthProfileStore(), profileId: seat });
    return res?.apiKey || undefined;
  } catch {
    return undefined;
  }
}
