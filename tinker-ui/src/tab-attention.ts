// FORK 2026-10-27 (the architect: "When it finishes any turn, the tab should remain on a state that lets me
// think that there is an unread result, which should disappear when I click on the tab to read it").
//
// UNREAD, per chat session, from two stamps:
//   final — when the session last finished a turn. The SERVER's `endedAt` on the session row (every
//           turn of the chat's own session: a prompt, a cron or agent wake, a longjob wake), raised
//           by a stamp the page records itself for a turn that runs in ANOTHER session but answers
//           in this chat (the Fractal: its own `:fractal:` session, its card in this chat).
//   seen  — up to when the owner has seen it: raised whenever the chat is the active tab of a
//           visible window, and when he leaves it.
// Unread ⇔ final > seen. Both are persisted (ui-state choice TAB_SEEN_CHOICE), so a turn that ends
// while the page is closed is unread on the next load, and a reload does not forget an unread tab.
// A chat seen for the first time is seeded at "now": nothing that ended before it is news.
//
// Also the WINDOW TITLE, which shows both states: a spinner while the active chat is busy (a gear and
// the job's label when the busy state is a job), and "(n)" for the unread chats while the window is in
// the background. One writer of document.title, fed by app.ts's one activity clock.

/** ui-state choice holding the per-session stamps, as JSON. */
export const TAB_SEEN_CHOICE = "tab:seen";

/** `s` = seen up to (ms); `f` = a final this page recorded itself (the Fractal), if any. */
export type SeenRecord = { s: number; f?: number };
export type SeenMap = Record<string, SeenRecord>;

function stamp(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined;
}

/** The stored map; anything unreadable is dropped, never thrown. */
export function parseSeenMap(raw: string | null | undefined): SeenMap {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: SeenMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = value as { s?: unknown; f?: unknown } | null;
    const s = stamp(v?.s);
    if (!key || s === undefined) {
      continue;
    }
    const f = stamp(v?.f);
    out[key] = f === undefined ? { s } : { s, f };
  }
  return out;
}

/** The map to store: only the sessions `keep` names (the open tabs), sorted so equal maps are equal strings. */
export function serializeSeenMap(map: SeenMap, keep: (sessionKey: string) => boolean): string {
  const out: SeenMap = {};
  for (const key of Object.keys(map).toSorted()) {
    if (keep(key)) {
      out[key] = map[key];
    }
  }
  return JSON.stringify(out);
}

/** When the session last finished a turn: the row's `endedAt`, or the page's own stamp if newer. */
export function finalStampOf(
  row: { endedAt?: unknown } | null | undefined,
  rec: SeenRecord | undefined,
): number | undefined {
  const server = stamp(row?.endedAt);
  const own = stamp(rec?.f);
  if (server === undefined) {
    return own;
  }
  return own === undefined ? server : Math.max(server, own);
}

/** Unread ⇔ a turn finished after the owner last saw the chat. No record yet = nothing to say. */
export function isUnread(final: number | undefined, rec: SeenRecord | undefined): boolean {
  return rec !== undefined && final !== undefined && final > rec.s;
}

/**
 * The record after the owner saw the chat. With `now`: everything up to this instant (he is
 * looking at it, or just left it). Without: only up to the final he has on screen, so the record
 * moves only when there is something new to absorb. Null = unchanged, nothing to store.
 */
export function markSeen(
  rec: SeenRecord | undefined,
  final: number | undefined,
  now?: number,
): SeenRecord | null {
  const s = Math.max(rec?.s ?? 0, final ?? 0, now ?? 0);
  if (s <= 0 || (rec && s === rec.s)) {
    return null;
  }
  return rec?.f === undefined ? { s } : { s, f: rec.f };
}

/** The record after the page watched this chat finish a turn of another session (the Fractal). */
export function noteOwnFinal(rec: SeenRecord | undefined, at: number, now: number): SeenRecord {
  // A chat first heard of through its Fractal is seeded like any other: seen up to now, minus the
  // turn being reported, which must stay news.
  const base = rec ?? { s: Math.min(now, at - 1) };
  return { s: base.s, f: Math.max(base.f ?? 0, at) };
}

// ─── The window title ───

/** The spinner the window title turns while the active chat is busy (the old longjob card's). */
export const TITLE_SPINNER = ["◐", "◓", "◑", "◒"] as const;

export type TitleBusy =
  | { kind: "model" }
  | { kind: "job"; label: string; count: number }
  | null
  | undefined;

/**
 * document.title from its parts. `background` = the window is hidden or not focused, the only time
 * the unread count is in the title (in front of him, the tab strip says it).
 *   "Jarvis" · "◐ Jarvis" · "◓ ⚙ build +1 — Jarvis" · "(2) Jarvis" · "(1) ◑ Jarvis"
 */
export function composeWindowTitle(opts: {
  base: string;
  busy: TitleBusy;
  /** Seconds or any counter: picks the spinner frame. */
  frame: number;
  unread: number;
  background: boolean;
}): string {
  const { base, busy, frame, unread, background } = opts;
  const spin = TITLE_SPINNER[((Math.floor(frame) % 4) + 4) % 4];
  let title = base;
  if (busy?.kind === "job") {
    const more = busy.count > 1 ? ` +${busy.count - 1}` : "";
    title = `${spin} ⚙ ${busy.label}${more} — ${base}`;
  } else if (busy?.kind === "model") {
    title = `${spin} ${base}`;
  }
  return background && unread > 0 ? `(${unread}) ${title}` : title;
}
