/**
 * The steps that wait for the owner, kept in one file another screen can read (2026-11-13).
 *
 * What it is for: a held step asks its question in the chat it ran in. When the owner works on another screen (Zen
 * Mail, where he types on a card and the work runs in a chat he is not looking at), he does not see the question, the
 * five-minute wait runs out and the work stops. On 2026-11-12 an Allow sat unseen for eight hours that way. This list
 * lets any screen he is on show the question and take his answer.
 * How it was derived: the wait registry knows only ids, and only while a hook is waiting; the question's words live
 * in the intervention event, in memory, and are gone after a restart. This list keeps both, on disk, for a day.
 * What would change it: a second reader with other needs. The file is the whole interface: `{updatedTs, entries}`.
 *
 * An entry is `waiting` while its hook long-polls (an answer releases the step at once), then `expired`: the turn
 * went on without the step and the owner's `allow <grant>` in that chat is what releases it, as with the Allow under
 * a reply. The words are the ones the chat card shows: a plain sentence and a question, never the command.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InterventionEvent } from "./events.js";

export interface WaitingEntry {
  /** The intervention id: what `amygdala2.answer` takes. */
  id: string;
  sessionKey: string;
  turnId: string;
  /** When the step was stopped. */
  ts: number;
  /** When the live wait ends. */
  expiresTs: number;
  state: "waiting" | "expired";
  kind: "hold" | "ask";
  /** The owner's question, e.g. "Allow publishing to the web?". */
  ask?: string;
  /** The step in plain words. */
  sentence?: string;
  rule?: string;
  options?: { id: string; label: string }[];
  /** What his prompt `allow <grant>` in that chat releases once the wait has run out. */
  grant?: string;
}

export const WAITING_FILE = "waiting.json";
/** An unanswered question is kept this long after its wait ran out. */
export const WAITING_KEEP_MS = 24 * 3_600_000;
const MAX_ENTRIES = 40;

export interface WaitingListOptions {
  path: string;
  now?: () => number;
  keepMs?: number;
  onError?: (err: unknown) => void;
}

export class WaitingList {
  private readonly entries = new Map<string, WaitingEntry>();
  private readonly path: string;
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly onError: (err: unknown) => void;
  private restored = false;

  constructor(o: WaitingListOptions) {
    this.path = o.path;
    this.now = o.now ?? Date.now;
    this.keepMs = o.keepMs ?? WAITING_KEEP_MS;
    this.onError = o.onError ?? ((err) => console.error("[amygdala] waiting list", err));
  }

  /**
   * Read the file back, once per process. A step that was still waiting when the last process ended has lost its
   * hook, so it comes back as expired: the question is still his to answer, through `allow <grant>`.
   */
  restore(): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    let rows: unknown;
    try {
      rows = (JSON.parse(readFileSync(this.path, "utf8")) as { entries?: unknown }).entries;
    } catch {
      return; // no file yet, or one cut short by a crash: start empty
    }
    if (!Array.isArray(rows)) {
      return;
    }
    for (const r of rows) {
      const e = r as Partial<WaitingEntry>;
      const whole =
        typeof e?.id === "string" &&
        typeof e.sessionKey === "string" &&
        typeof e.ts === "number" &&
        typeof e.expiresTs === "number" &&
        (e.kind === "hold" || e.kind === "ask");
      if (!whole || this.entries.has(e.id as string)) {
        continue;
      }
      this.entries.set(e.id, { ...(e as WaitingEntry), state: "expired" });
    }
    this.save();
  }

  /** A hook has started to wait on this intervention. An older question for the same goal in the same chat goes. */
  add(ev: InterventionEvent, expiresTs: number): void {
    if (ev.kind !== "hold" && ev.kind !== "ask") {
      return;
    }
    if (ev.grant) {
      this.dropGrant(ev.sessionKey, ev.grant);
    }
    this.entries.set(ev.id, {
      id: ev.id,
      sessionKey: ev.sessionKey,
      turnId: ev.turnId,
      ts: ev.ts,
      expiresTs,
      state: "waiting",
      kind: ev.kind,
      ...(ev.ask ? { ask: ev.ask } : {}),
      ...(ev.sentence ? { sentence: ev.sentence } : {}),
      ...(ev.rule ? { rule: ev.rule } : {}),
      ...(ev.options?.length
        ? { options: ev.options.map((o) => ({ id: o.id, label: o.label })) }
        : {}),
      ...(ev.grant ? { grant: ev.grant } : {}),
    });
    this.save();
  }

  /** The wait ran out with no answer. */
  expire(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.state === "expired") {
      return;
    }
    e.state = "expired";
    this.save();
  }

  /** He answered, or the step was released another way. */
  remove(id: string): boolean {
    if (!this.entries.delete(id)) {
      return false;
    }
    this.save();
    return true;
  }

  /** His `allow <grant>` reached that chat: the question is answered. Returns how many entries it settled. */
  removeGrant(sessionKey: string, grant: string): number {
    const n = this.dropGrant(sessionKey, grant);
    if (n > 0) {
      this.save();
    }
    return n;
  }

  get(id: string): WaitingEntry | undefined {
    this.prune();
    return this.entries.get(id);
  }

  /** Oldest first. */
  list(): WaitingEntry[] {
    this.prune();
    return [...this.entries.values()].toSorted((a, b) => a.ts - b.ts);
  }

  private dropGrant(sessionKey: string, grant: string): number {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (e.sessionKey === sessionKey && e.grant?.toUpperCase() === grant.toUpperCase()) {
        this.entries.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** A wait nobody closed (the hook died) is expired by the clock; an expired one leaves after `keepMs`. */
  private prune(): boolean {
    const t = this.now();
    let changed = false;
    for (const [id, e] of this.entries) {
      if (e.state === "waiting" && t > e.expiresTs + 5_000) {
        e.state = "expired";
        changed = true;
      }
      if (e.state === "expired" && t > e.expiresTs + this.keepMs) {
        this.entries.delete(id);
        changed = true;
      }
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
      changed = true;
    }
    return changed;
  }

  private save(): void {
    this.prune();
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      const body = { updatedTs: this.now(), entries: [...this.entries.values()] };
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      this.onError(err); // the chat card still works; only the other screen misses this change
    }
  }
}

const LISTS = Symbol.for("tinkerclaw.amygdala.waitingLists");

/**
 * One list per gateway process and data dir, for the reason `processTracker` gives in runtime.ts: the gateway runs
 * register() more than once, the hooks reach the first runtime's routes and a gateway method can reach a later one.
 */
export function processWaitingList(dataDir: string, now: () => number): WaitingList {
  const g = globalThis as { [LISTS]?: Map<string, WaitingList> };
  const lists = (g[LISTS] ??= new Map<string, WaitingList>());
  let l = lists.get(dataDir);
  if (!l) {
    l = new WaitingList({ path: join(dataDir, WAITING_FILE), now });
    lists.set(dataDir, l);
  }
  return l;
}
