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

export type RewindCapability = "claude-fork" | "unsupported";

/** The backend capability the UI reads: the fork is verified; the tab hand-off to the fork is not wired here. */
export function rewindCapability(runner: string): RewindCapability {
  return runner === "cc-bridge" || runner === "claude-cli" ? "claude-fork" : "unsupported";
}

/** A transcript larger than this is refused (it is read whole once); the exchange to drop is near the end anyway. */
export const MAX_REWIND_BYTES = 256 * 1024 * 1024;

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
}

interface Entry {
  type?: string;
  sessionId?: string;
  isMeta?: boolean;
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

/**
 * Write a copy of the transcript truncated before its last user prompt, under a new session id, next to the source
 * (or in `destDir`). Never modifies the source. `newId` is injectable for tests.
 */
export function forkTruncatedTranscript(
  srcPath: string,
  o: { destDir?: string; newId?: string } = {},
): ForkResult {
  try {
    const size = statSync(srcPath).size;
    if (size > MAX_REWIND_BYTES) return { ok: false, reason: "transcript too large to rewind" };
    const lines = readFileSync(srcPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    const at = lastPromptIndex(lines);
    if (at < 0) return { ok: false, reason: "no user prompt found in the transcript" };
    if (at === 0 || !lines.slice(0, at).some((l) => /"(user|assistant)"/.test(l))) {
      // Nothing before the prompt: rewinding would leave an empty conversation, which is a reset, not a rewind.
      return { ok: false, reason: "the removed exchange is the whole conversation" };
    }
    const prompt = promptText(JSON.parse(lines[at]) as Entry) as string;
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
}

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

  if (o.turnId && o.newestTurnId && o.turnId !== o.newestTurnId) {
    return {
      ok: false,
      capability,
      reason: "only the newest exchange can be rewound; rewind the newer one first",
    };
  }
  const path = map.transcriptPathFor(o.sessionKey);
  if (!path) return { ok: false, capability, reason: "no transcript for this tab" };
  const fork = forkTruncatedTranscript(path);
  if (!fork.ok || !fork.forkPath || !fork.forkSessionId) {
    return { ok: false, capability, reason: fork.reason ?? "could not fork the transcript" };
  }
  const original = fork.originalSessionId ?? map.currentSessionId(o.sessionKey) ?? "";
  if (!map.point(o.sessionKey, fork.forkSessionId)) {
    try {
      unlinkSync(fork.forkPath); // our own unused copy; the original was never touched
    } catch {
      /* already gone */
    }
    return { ok: false, capability, reason: "could not point the tab at the fork" };
  }
  o.registry.add({
    sessionKey: o.sessionKey,
    turnId: o.turnId,
    originalSessionId: original,
    forkSessionId: fork.forkSessionId,
    forkPath: fork.forkPath,
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
  };
}
