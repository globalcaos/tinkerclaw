// FORK 2026-10-22 (the architect: a Rewind next to a refusal "would remove the last response from context and chat, and put the
// prompt's message back in the input text box").
//
// WHAT THIS IS FOR. A Rewind takes the tab's LAST exchange out of what the model sees (the gateway forks the session).
// The page must take it out of what the architect sees too, and keep it out after a reload. Nothing is deleted: the gateway's
// transcript still holds the rows, so this is a record of "this prompt was rewound at this time" and a filter that
// swaps the exchange for a one-line placeholder with an Undo. Undo drops the record and the rows are back.
//
// WHY A FILTER AND NOT A DELETE. The chat is paper (chat-units.ts: "no rule here may drop a row"). A rewind is the one
// thing the owner asked to take rows off the page, so it is explicit, it leaves its trace, and it reverses.
//
// DOM-free and global-free (the client-rows.ts precedent): app.ts is a 24k-line browser entry with no unit-test harness.

// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Row = any;

/** The newest exchange of the page: the owner's words that opened it and where it sits. */
export interface Exchange {
  /** Hash of the words, the identity a button and a record share (the same words sent twice are told apart by time). */
  key: string;
  prompt: string;
  /** The prompt row's time in ms, when it has one. */
  at?: number;
  /** Index of the prompt row in the view it was found in. */
  index: number;
}

export interface RewoundExchange {
  id: string;
  sessionKey: string;
  key: string;
  prompt: string;
  at?: number;
  rewoundAt: number;
  /** What the gateway handed back for the composer, shown on hover. */
  restored?: string;
  /** How many exchanges went, from this prompt on (2026-10-22: a Rewind on an older turn takes the later ones too). */
  count?: number;
}

export interface ExchangeDeps {
  /** The owner's words of a real prompt row; null for every other row (replies, tool results, injected notes, placeholders). */
  promptOf(row: Row): string | null;
  timeOf(row: Row): number | undefined;
}

/** Two rows with the same words are the same prompt only when their times agree this closely (client and server clocks). */
const SAME_PROMPT_MS = 60_000;
const MAX_PER_SESSION = 20;
const MAX_SESSIONS = 24;
export const REWOUND_STORAGE_KEY = "tinker-rewound-exchanges";

/** A row's time in ms, from the same keys msg-order.ts and amygdala-ui.ts read. */
export function rowTimeMs(m: unknown): number | undefined {
  if (!m || typeof m !== "object") return undefined;
  const rec = m as Record<string, unknown>;
  for (const key of ["_promptStartedAt", "createdAtMs", "timestamp", "ts", "_arrivedAt"]) {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

export function exchangeKey(prompt: string): string {
  const s = prompt.replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `x${h.toString(16).padStart(8, "0")}${s.length.toString(36)}`;
}

/** The last real prompt of the view, and so the exchange a Rewind would take. Placeholders are transparent. */
export function newestExchange(view: readonly Row[], d: ExchangeDeps): Exchange | null {
  for (let i = view.length - 1; i >= 0; i--) {
    const p = d.promptOf(view[i]);
    if (p !== null) return { key: exchangeKey(p), prompt: p, at: d.timeOf(view[i]), index: i };
  }
  return null;
}

/**
 * The exchange whose prompt has this key (the newest such one), and how many real prompts come after it: a Rewind there
 * takes `1 + later` exchanges. Placeholders are transparent, as in `newestExchange`.
 */
export function exchangeByKey(
  view: readonly Row[],
  key: string,
  d: ExchangeDeps,
): (Exchange & { later: number }) | null {
  let later = 0;
  for (let i = view.length - 1; i >= 0; i--) {
    const p = d.promptOf(view[i]);
    if (p === null) continue;
    if (exchangeKey(p) === key) return { key, prompt: p, at: d.timeOf(view[i]), index: i, later };
    later++;
  }
  return null;
}

/**
 * The view with every rewound exchange swapped for one placeholder row: the prompt row through the row before the
 * next real prompt (or the end). The placeholder is a user-role row, so the run builder treats it as the boundary the
 * prompt was. A record that matches no prompt row (history reset, text changed) hides nothing.
 */
export function hideRewound(
  view: readonly Row[],
  records: readonly RewoundExchange[],
  d: ExchangeDeps,
): Row[] {
  if (records.length === 0) return view as Row[];
  const prompts: { index: number; key: string; at?: number }[] = [];
  view.forEach((row, index) => {
    const p = d.promptOf(row);
    if (p !== null) prompts.push({ index, key: exchangeKey(p), at: d.timeOf(row) });
  });
  const starts = new Map<number, { record: RewoundExchange; end: number }>();
  const used = new Set<number>();
  for (const record of records) {
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    prompts.forEach((p, n) => {
      if (used.has(n) || p.key !== record.key) return;
      const gap = p.at !== undefined && record.at !== undefined ? Math.abs(p.at - record.at) : 0;
      if (gap < bestGap) {
        best = n;
        bestGap = gap;
      }
    });
    if (best < 0 || bestGap > SAME_PROMPT_MS) continue;
    used.add(best);
    // A rewind to an older turn took the exchanges after it as well: one placeholder covers them all.
    const count = Math.max(1, record.count ?? 1);
    for (let k = 1; k < count; k++) used.add(best + k);
    starts.set(prompts[best]!.index, {
      record,
      end: prompts[best + count]?.index ?? view.length,
    });
  }
  if (starts.size === 0) return view as Row[];
  const out: Row[] = [];
  for (let i = 0; i < view.length; ) {
    const hit = starts.get(i);
    if (!hit) {
      out.push(view[i]);
      i++;
      continue;
    }
    out.push(placeholderRow(hit.record));
    i = hit.end;
  }
  return out;
}

/** The row that stands in for a rewound exchange; app.ts draws it (`_rewoundExchange` carries the record id). */
export function placeholderRow(r: RewoundExchange): Row {
  return {
    role: "user",
    _rewoundExchange: r.id,
    _rewoundKey: r.key,
    _rewoundAt: r.rewoundAt,
    _rewoundRestored: r.restored ?? "",
    _uid: `rewound:${r.id}`,
    // The prompt's own time, so the run windows around it (amygdala-ui turnsForRun) keep the edges they had.
    ts: r.at ?? r.rewoundAt,
    _rewoundCount: Math.max(1, r.count ?? 1),
    content: [
      {
        type: "text",
        text: (r.count ?? 1) > 1 ? `Rewound ${r.count} exchanges` : "Rewound 1 exchange",
      },
    ],
  };
}

// ─── the per-tab record, kept in localStorage ───────────────────────────────────────────────────────────────────────

type Store = Record<string, RewoundExchange[]>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export class RewoundStore {
  /** Parsed once: the page repaints on every streamed token, and most tabs have nothing rewound. */
  private cache: Store | null = null;

  constructor(private readonly storage: () => Storage | null) {}

  /** Another page changed the record (a `storage` event): read it again next time. */
  invalidate(): void {
    this.cache = null;
  }

  private read(): Store {
    if (this.cache) return this.cache;
    let all: Store = {};
    try {
      const raw = this.storage()?.getItem(REWOUND_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) all = parsed as Store;
    } catch {
      all = {}; // a corrupt record shows the exchange again, which loses nothing
    }
    this.cache = all;
    return all;
  }

  private write(all: Store): void {
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete all[k];
    this.cache = all;
    try {
      this.storage()?.setItem(REWOUND_STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      console.error("[rewound-exchanges] could not save", err);
    }
  }

  list(sessionKey: string): RewoundExchange[] {
    return this.read()[sessionKey] ?? [];
  }

  add(r: Omit<RewoundExchange, "id">): RewoundExchange {
    const all = this.read();
    const record: RewoundExchange = { ...r, id: `${r.rewoundAt.toString(36)}-${r.key}` };
    const list = (all[r.sessionKey] ?? []).filter((x) => x.id !== record.id);
    list.push(record);
    delete all[r.sessionKey]; // re-insert last: eviction drops the session touched longest ago
    all[r.sessionKey] = list.slice(-MAX_PER_SESSION);
    this.write(all);
    return record;
  }

  /** Undo: the newest record with these words in this tab goes, and its rows are back on the page. */
  removeNewest(sessionKey: string, key: string): boolean {
    const all = this.read();
    const list = all[sessionKey] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.key !== key) continue;
      list.splice(i, 1);
      all[sessionKey] = list;
      this.write(all);
      return true;
    }
    return false;
  }
}
