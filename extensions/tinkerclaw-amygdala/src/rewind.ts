/**
 * One-turn rewind backend (design doc §3, paper §6.3): remove the last exchange from what the model sees on its
 * next turn, and hand the prompt back so the UI can put it in the composer.
 *
 * MECHANISM, verified on a throwaway session on 2026-09-29 (Claude Code 2.1.284, Haiku, a scratch folder): a Claude
 * Code session is a JSONL file of `uuid`/`parentUuid` entries. A COPY of that file truncated just before the last
 * user prompt, written under a new session id with `sessionId` rewritten, resumes with `claude --resume <new id>`
 * and the model no longer knows the exchange (it listed only the code word of the first exchange). The original
 * file is never modified, so Undo is "resume the original id". Nothing in this module touches a live session:
 * the caller chooses the source path, and the bridge that re-points a tab at the fork is NOT part of this build.
 *
 * Only the Claude Code (cc-bridge) runner is supported. For anything else the capability is "unsupported" and the
 * UI hides the button.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ownerWords, withoutLeadingPromptBlocks } from "openclaw/plugin-sdk/fork-prompt-envelope";

export type RewindCapability = "claude-fork" | "unsupported";

/** The backend capability the UI reads: the fork is verified; the tab hand-off to the fork is not wired here. */
export function rewindCapability(runner: string): RewindCapability {
  return runner === "cc-bridge" || runner === "claude-cli" ? "claude-fork" : "unsupported";
}

/** A transcript larger than this is refused (it is read whole once); the exchange to drop is near the end anyway. */
export const MAX_REWIND_BYTES = 256 * 1024 * 1024;

/**
 * FORK 2026-11-13: the id a tab is pointed at when a Rewind takes its WHOLE conversation (the first exchange of its
 * Claude session, and so everything). No transcript is ever written under such an id: the bridge reads the prefix and
 * starts the tab's next turn on a fresh session (tinker-bridge worker.ts), and Undo can still point the tab back at the
 * session it had. Must equal `REWOUND_ALL_PREFIX` in extensions/tinkerclaw-tinker-bridge/src/rewind-seam.ts; a test
 * there compares them (extensions cannot import each other).
 */
export const REWOUND_ALL_PREFIX = "rewound-";

/** With no words to compare, a page row and a transcript entry are the same prompt only this close in time. */
export const SAME_PROMPT_MS = 60_000;

export interface ForkResult {
  ok: boolean;
  reason?: string;
  forkPath?: string;
  forkSessionId?: string;
  originalSessionId?: string;
  keptEntries?: number;
  droppedEntries?: number;
  /** The text of the prompt that was removed, to put back in the composer. */
  restoredPrompt?: string;
  /** Nothing was left before the cut: no copy was written and `forkSessionId` is a `REWOUND_ALL_PREFIX` marker. */
  whole?: boolean;
  /** When the prompt at the cut was sent (ms), so the page can hide every row of that exchange. */
  cutAt?: number;
}

interface Entry {
  type?: string;
  sessionId?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
}

/** The text of a real user prompt, or null for tool results, meta entries and everything else. */
export function promptText(e: Entry): string | null {
  if (e.type !== "user" || e.isMeta) return null;
  const c = e.message?.content;
  if (typeof c === "string") return c.trim() ? c : null;
  if (!Array.isArray(c)) return null;
  const texts: string[] = [];
  for (const b of c as Array<Record<string, unknown>>) {
    if (b?.type === "tool_result") return null;
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  const t = texts.join("\n");
  return t.trim() ? t : null;
}

/** Index of the last real user prompt in the entries, or -1. */
export function lastPromptIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry;
    try {
      e = JSON.parse(lines[i]) as Entry;
    } catch {
      continue;
    }
    if (promptText(e) !== null) return i;
  }
  return -1;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The owner's words of a prompt entry (the bridge's header, date stamp and contract stripped), or "" for none. */
function ownerWordsOf(line: string): string {
  try {
    const t = promptText(JSON.parse(line) as Entry);
    return t === null ? "" : (ownerWords(withoutLeadingPromptBlocks(t)) ?? "");
  } catch {
    return "";
  }
}

interface PromptEntry {
  index: number;
  /** When the transcript says it was sent (ms). */
  ts?: number;
}

/** The prompt sent nearest to `at`; a later one wins a tie, and one with no time loses to any that has one. */
function nearest(list: PromptEntry[], at: number): PromptEntry {
  let best = list[list.length - 1]!;
  let gap = Number.POSITIVE_INFINITY;
  for (const p of list) {
    if (p.ts === undefined) continue;
    const g = Math.abs(p.ts - at);
    if (g <= gap) {
      best = p;
      gap = g;
    }
  }
  return best;
}

/**
 * Index of the prompt the page means, or -1. The page names an exchange by the words its row shows and, since
 * 2026-11-13, the time of that row; a row and a transcript line are matched by content, never by counting prompts
 * (agent-written prompts and injected notes would shift a count).
 *
 *  - WORDS: the owner's words of the entry, or its whole text. A prompt nobody typed (a background-task notice, an
 *    agent's wake) has no owner words, and the page shows such a row by its text.
 *  - TIME, among those: the same words sent twice are two exchanges, and the one sent at `at` is meant. With no time
 *    given it is the last one, as before.
 *  - TIME alone, when no entry has the words: the page can hold a row the transcript words differently (the gateway's
 *    own line for a turn the CLI started by itself). The entry sent within `SAME_PROMPT_MS` of the row is that turn.
 */
export function promptIndexFor(lines: string[], words: string, at?: number): number {
  const want = norm(words);
  const prompts: PromptEntry[] = [];
  const named: PromptEntry[] = [];
  lines.forEach((l, index) => {
    let e: Entry;
    try {
      e = JSON.parse(l) as Entry;
    } catch {
      return;
    }
    const text = promptText(e);
    if (text === null) return;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
    const entry: PromptEntry = Number.isFinite(ts) ? { index, ts } : { index };
    prompts.push(entry);
    if (!want) return;
    if (norm(ownerWords(withoutLeadingPromptBlocks(text)) ?? "") === want || norm(text) === want) {
      named.push(entry);
    }
  });
  if (named.length > 0) return (at === undefined ? named.at(-1)! : nearest(named, at)).index;
  if (at === undefined) return -1;
  const near = prompts.filter((p) => p.ts !== undefined && Math.abs(p.ts - at) <= SAME_PROMPT_MS);
  return near.length > 0 ? nearest(near, at).index : -1;
}

/** Index of the last real user prompt with these words, or -1 (`promptIndexFor` with no time). */
export function promptIndexByWords(lines: string[], words: string): number {
  return promptIndexFor(lines, words);
}

/** When a transcript line says it was written (ms), or undefined. */
function lineTime(line: string): number | undefined {
  try {
    const ts = Date.parse(String((JSON.parse(line) as Entry).timestamp ?? ""));
    return Number.isFinite(ts) ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a copy of the transcript truncated before its last user prompt, under a new session id, next to the source
 * (or in `destDir`). With `fromPrompt` (and `fromPromptAt`, the time of the page's row), truncated before the prompt
 * the page means instead (`promptIndexFor`), so that exchange and every later one go (2026-10-22: remove more than one
 * turn from history at once). `orLast`: the page says its exchange is the newest one, so when the transcript cannot
 * name it the last prompt is cut. Never modifies the source. `newId` is injectable for tests.
 *
 * When nothing is left before the cut (2026-11-13) no copy is written: the result is `whole`, and its id is a
 * `REWOUND_ALL_PREFIX` marker for the caller to point the tab at.
 */
export function forkTruncatedTranscript(
  srcPath: string,
  o: {
    destDir?: string;
    newId?: string;
    fromPrompt?: string;
    fromPromptAt?: number;
    orLast?: boolean;
  } = {},
): ForkResult {
  try {
    const size = statSync(srcPath).size;
    if (size > MAX_REWIND_BYTES) return { ok: false, reason: "transcript too large to rewind" };
    const lines = readFileSync(srcPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    let at = o.fromPrompt
      ? promptIndexFor(lines, o.fromPrompt, o.fromPromptAt)
      : lastPromptIndex(lines);
    if (at < 0 && o.fromPrompt && o.orLast) at = lastPromptIndex(lines);
    if (at < 0) {
      return {
        ok: false,
        reason: o.fromPrompt
          ? "that prompt is not in the model's transcript"
          : "no user prompt found in the transcript",
      };
    }
    // What goes back to the composer is the owner's words. The transcript copy of a Tinker prompt also carries the
    // bridge's `<turn_context>` header, the date stamp and the chat-row contract (11.5 KB around a 60-character
    // prompt, measured 2026-10-22); an agent-written prompt has no owner words, so nothing is returned for it.
    const prompt = ownerWordsOf(lines[at]);
    const cutAt = lineTime(lines[at]);
    let originalId: string | undefined;
    for (const l of lines) {
      try {
        const id = (JSON.parse(l) as Entry).sessionId;
        if (id) {
          originalId = id;
          break;
        }
      } catch {
        /* skip a garbled line */
      }
    }
    const forkId = o.newId ?? randomUUID();
    if (at === 0 || !lines.slice(0, at).some((l) => /"(user|assistant)"/.test(l))) {
      // FORK 2026-11-13: nothing is said before this prompt, so the exchange is the whole conversation. Until today
      // that was refused as a reset. A tab whose session began with a refused prompt (the bridge starts a fresh
      // session when the old transcript is too large to resume) then had no Rewind at all. An empty context has no
      // transcript to resume, so no copy is written: the marker id tells the bridge to start fresh.
      return {
        ok: true,
        whole: true,
        forkSessionId: `${REWOUND_ALL_PREFIX}${forkId}`,
        originalSessionId: originalId,
        keptEntries: 0,
        droppedEntries: lines.length,
        restoredPrompt: prompt,
        ...(cutAt !== undefined ? { cutAt } : {}),
      };
    }
    const kept = lines.slice(0, at).map((l) => {
      try {
        const e = JSON.parse(l) as Entry & Record<string, unknown>;
        if (e.sessionId !== undefined) e.sessionId = forkId;
        return JSON.stringify(e);
      } catch {
        return l;
      }
    });
    const dir = o.destDir ?? dirname(srcPath);
    mkdirSync(dir, { recursive: true });
    const forkPath = join(dir, `${forkId}.jsonl`);
    writeFileSync(forkPath, `${kept.join("\n")}\n`, { mode: 0o600 });
    return {
      ok: true,
      forkPath,
      forkSessionId: forkId,
      originalSessionId: originalId,
      keptEntries: at,
      droppedEntries: lines.length - at,
      restoredPrompt: prompt,
      ...(cutAt !== undefined ? { cutAt } : {}),
    };
  } catch (err) {
    console.error("[amygdala] rewind fork failed", err);
    return { ok: false, reason: "could not read the transcript" };
  }
}

// ---- the method: rewind / undo against an injected session map -----------------------------------------------------

/**
 * What the rewind method needs from whoever owns the chat tabs. Phase F wires the bridge's real session map to this;
 * until then no map is given and the method reports "unsupported" and touches nothing (inert while the plugin is off).
 */
export interface SessionMap {
  /** The transcript file of the session a tab currently runs, or null when unknown. */
  transcriptPathFor(sessionKey: string): string | null;
  /** The runner behind a tab ("cc-bridge", "native", ...). */
  runnerFor(sessionKey: string): string;
  /** The session id a tab currently runs. */
  currentSessionId(sessionKey: string): string | null;
  /** Re-point a tab at another session id (the fork, or the original for Undo). True when applied. */
  point(sessionKey: string, sessionId: string): boolean;
  /** True while a reply runs in the tab: a rewind then would cut the transcript under a live worker. */
  busy?(sessionKey: string): boolean;
  /**
   * FORK 2026-11-13: transcripts of the tab's EARLIER Claude sessions, newest first (the bridge starts a new session
   * when a transcript grows past its resume limit; the page still shows the older turns). Absent = none known.
   */
  earlierTranscriptsFor?(sessionKey: string): string[];
}

/** The bridge resumes a transcript up to this size (tinker-bridge defaults.ts RESUME_MAX_TRANSCRIPT_BYTES). */
export const RESUME_LIMIT_BYTES = 8_000_000;

export interface RewindRecord {
  sessionKey: string;
  turnId: string;
  originalSessionId: string;
  forkSessionId: string;
  forkPath: string;
  prompt: string;
  ts: number;
  undone: boolean;
}

/** Remembers which fork replaced which session, so Undo can point back. Persisted atomically (0600) when a file is given. */
export class RewindRegistry {
  private records: RewindRecord[] = [];

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
        if (Array.isArray(raw)) this.records = raw as RewindRecord[];
      } catch {
        this.records = [];
      }
    }
  }

  add(r: RewindRecord): void {
    this.records.push(r);
    this.records = this.records.slice(-200);
    this.save();
  }

  /** The newest rewind of this tab that has not been undone. */
  latestFor(sessionKey: string): RewindRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.sessionKey === sessionKey && !r.undone) return r;
    }
    return undefined;
  }

  /** Turns of this tab whose exchange is currently rewound (not undone). */
  rewoundTurns(sessionKey: string): Set<string> {
    return new Set(
      this.records.filter((r) => r.sessionKey === sessionKey && !r.undone).map((r) => r.turnId),
    );
  }

  markUndone(forkSessionId: string): void {
    for (const r of this.records) if (r.forkSessionId === forkSessionId) r.undone = true;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export interface RewindMethodResult {
  ok: boolean;
  capability: RewindCapability;
  reason?: string;
  forkSessionId?: string;
  originalSessionId?: string;
  restoredSessionId?: string;
  restoredPrompt?: string;
  /** The exchange was the whole conversation: the tab was released from its session, no copy exists. */
  whole?: boolean;
  /** When the prompt at the cut was sent (ms). */
  cutAt?: number;
}

/**
 * `amygdala2.rewind`: with `undo` false, drop the last exchange of a tab (fork + re-point); with `undo` true, point the
 * tab back at the session it had before its newest rewind. The original transcript is never modified, and with no
 * session map the method does nothing at all.
 */
export function rewindTurn(o: {
  sessionMap?: SessionMap;
  registry: RewindRegistry;
  sessionKey: string;
  turnId: string;
  undo?: boolean;
  /**
   * The newest exchange of the tab that is not rewound yet. A fork always drops the LAST exchange, so a Rewind pressed
   * on an older turn would silently drop a newer one (2026-09-30, two refusals in a row): refuse it instead.
   */
  newestTurnId?: string;
  /** Rewind to this prompt (the words the page shows for it): it and every later exchange go. Lifts the newest-only rule. */
  fromPrompt?: string;
  /** The time of the page's row for that prompt (ms): tells apart two prompts with the same words. */
  fromPromptAt?: number;
  /** The page says the named exchange is its newest: when the transcript cannot name it, the last prompt is cut. */
  orLast?: boolean;
  now: number;
}): RewindMethodResult {
  const map = o.sessionMap;
  if (!map)
    return {
      ok: false,
      capability: "unsupported",
      reason: "no session map is wired (plugin inert)",
    };
  const capability = rewindCapability(map.runnerFor(o.sessionKey));
  if (capability === "unsupported") {
    return { ok: false, capability, reason: "this runner cannot rewind" };
  }
  if (map.busy?.(o.sessionKey)) {
    return { ok: false, capability, reason: "a reply is still running in this tab" };
  }

  if (o.undo) {
    const rec = o.registry.latestFor(o.sessionKey);
    if (!rec) return { ok: false, capability, reason: "nothing to undo" };
    if (!map.point(o.sessionKey, rec.originalSessionId)) {
      return {
        ok: false,
        capability,
        reason: "could not point the tab back at the original session",
      };
    }
    o.registry.markUndone(rec.forkSessionId);
    return {
      ok: true,
      capability,
      restoredSessionId: rec.originalSessionId,
      restoredPrompt: rec.prompt,
    };
  }

  if (!o.fromPrompt && o.turnId && o.newestTurnId && o.turnId !== o.newestTurnId) {
    return {
      ok: false,
      capability,
      reason: "only the newest exchange can be rewound; rewind the newer one first",
    };
  }
  const path = map.transcriptPathFor(o.sessionKey);
  // FORK 2026-11-13: a named prompt the current session does not hold may sit in an earlier session of this tab.
  if (o.fromPrompt) {
    if (!path || !holdsPrompt(path, o.fromPrompt, o.fromPromptAt)) {
      const earlier = earlierFork(map, o.sessionKey, o.fromPrompt, o.fromPromptAt);
      if (earlier)
        return finishFork(map, o, capability, earlier, map.currentSessionId(o.sessionKey) ?? "");
    }
  }
  if (!path) {
    // A tab released by a whole-conversation rewind points at a marker id, which has no transcript.
    const released = map.currentSessionId(o.sessionKey)?.startsWith(REWOUND_ALL_PREFIX) === true;
    return {
      ok: false,
      capability,
      reason: released
        ? "the model's context is already empty in this tab"
        : "no transcript for this tab",
    };
  }
  const fork = forkTruncatedTranscript(
    path,
    o.fromPrompt
      ? {
          fromPrompt: o.fromPrompt,
          ...(o.fromPromptAt !== undefined ? { fromPromptAt: o.fromPromptAt } : {}),
          ...(o.orLast ? { orLast: true } : {}),
        }
      : {},
  );
  if (!fork.ok || !fork.forkSessionId || (!fork.whole && !fork.forkPath)) {
    return { ok: false, capability, reason: fork.reason ?? "could not fork the transcript" };
  }
  return finishFork(
    map,
    o,
    capability,
    fork,
    fork.originalSessionId ?? map.currentSessionId(o.sessionKey) ?? "",
  );
}

/** Does this transcript hold the named prompt? A read only; an unreadable file answers no. */
function holdsPrompt(path: string, words: string, at?: number): boolean {
  try {
    if (statSync(path).size > MAX_REWIND_BYTES) return false;
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    return promptIndexFor(lines, words, at) >= 0;
  } catch {
    return false;
  }
}

/** The newest earlier session of the tab that holds the named prompt, cut before it; null when none does. */
function earlierFork(
  map: SessionMap,
  sessionKey: string,
  words: string,
  at?: number,
): ForkResult | null {
  for (const p of map.earlierTranscriptsFor?.(sessionKey) ?? []) {
    const f = forkTruncatedTranscript(p, {
      fromPrompt: words,
      ...(at !== undefined ? { fromPromptAt: at } : {}),
    });
    if (!f.ok) continue;
    if (f.forkPath) {
      try {
        if (statSync(f.forkPath).size > RESUME_LIMIT_BYTES) {
          unlinkSync(f.forkPath);
          return {
            ok: false,
            reason: `the copy from that earlier session would be over the ${RESUME_LIMIT_BYTES / 1_000_000} MB the bridge resumes`,
          };
        }
      } catch {
        continue;
      }
    }
    return f;
  }
  return null;
}

/** Point the tab at a fork (or a released marker) and record it, so Undo returns the tab to `original`. */
function finishFork(
  map: SessionMap,
  o: { sessionKey: string; turnId: string; registry: RewindRegistry; now: number },
  capability: RewindCapability,
  fork: ForkResult,
  original: string,
): RewindMethodResult {
  if (!fork.ok || !fork.forkSessionId || (!fork.whole && !fork.forkPath)) {
    return { ok: false, capability, reason: fork.reason ?? "could not fork the transcript" };
  }
  if (!map.point(o.sessionKey, fork.forkSessionId)) {
    if (fork.forkPath) {
      try {
        unlinkSync(fork.forkPath); // our own unused copy; the original was never touched
      } catch {
        /* already gone */
      }
    }
    return {
      ok: false,
      capability,
      reason: fork.whole
        ? "could not release the tab from its session"
        : "could not point the tab at the fork",
    };
  }
  o.registry.add({
    sessionKey: o.sessionKey,
    turnId: o.turnId,
    originalSessionId: original,
    forkSessionId: fork.forkSessionId,
    forkPath: fork.forkPath ?? "",
    prompt: fork.restoredPrompt ?? "",
    ts: o.now,
    undone: false,
  });
  return {
    ok: true,
    capability,
    forkSessionId: fork.forkSessionId,
    originalSessionId: original,
    restoredPrompt: fork.restoredPrompt,
    ...(fork.whole ? { whole: true } : {}),
    ...(fork.cutAt !== undefined ? { cutAt: fork.cutAt } : {}),
  };
}
