/**
 * The rewind method's `SessionMap` over the bridge's real session map (design doc §9, Phase F item 5).
 *
 * The bridge keeps `~/.openclaw/tinker-bridge/session-map.json`: worker-pool key → `{sessionId, updatedAt}`, where
 * `sessionId` is the Claude Code session a fresh worker resumes with `--resume`. The gateway learns each chat tab's
 * Claude session id and transcript path from the hooks (`SeenSessions`), so a tab's session is found by matching that id
 * to the map's entries. Pointing a tab at a fork rewrites THOSE entries' `sessionId`, atomically, and only when the user
 * presses Rewind or Undo: nothing here runs on its own and the file is never read or written unless the plugin is enabled.
 *
 * UNVERIFIED LIVE: the bridge also caches this map in memory and writes it back; whether a rewritten entry survives and
 * is picked up at the tab's next worker spawn has not been observed. Tests use temp copies only.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionMap } from "./rewind.js";

export interface SeenSession {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  ts: number;
}

/** What the hooks told us about each tab: its Claude session id and transcript path (bounded, newest wins). */
export class SeenSessions {
  private readonly m = new Map<string, SeenSession>();

  note(
    tabKey: string,
    hook: { session_id?: unknown; transcript_path?: unknown; cwd?: unknown },
    now: number,
  ): void {
    const id = typeof hook.session_id === "string" ? hook.session_id : "";
    if (!id) return;
    this.m.set(tabKey, {
      sessionId: id,
      transcriptPath: typeof hook.transcript_path === "string" ? hook.transcript_path : null,
      cwd: typeof hook.cwd === "string" ? hook.cwd : null,
      ts: now,
    });
    if (this.m.size > 200) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
  }

  get(tabKey: string): SeenSession | undefined {
    return this.m.get(tabKey);
  }

  set(tabKey: string, s: SeenSession): void {
    this.m.set(tabKey, s);
  }
}

/** The path the bridge itself uses (same env override), resolved at call time. */
export function defaultBridgeMapPath(): string {
  return (
    process.env.OPENCLAW_TINKER_BRIDGE_SESSION_MAP ||
    join(homedir(), ".openclaw", "tinker-bridge", "session-map.json")
  );
}

export interface BridgeSessionMapOptions {
  mapFile?: string | (() => string);
  seen: SeenSessions;
  now?: () => number;
}

export class BridgeSessionMap implements SessionMap {
  private readonly file: () => string;
  private readonly now: () => number;

  constructor(private readonly o: BridgeSessionMapOptions) {
    const f = o.mapFile;
    this.file = typeof f === "function" ? f : () => f ?? defaultBridgeMapPath();
    this.now = o.now ?? Date.now;
  }

  transcriptPathFor(tabKey: string): string | null {
    const s = this.o.seen.get(tabKey);
    return s?.transcriptPath && existsSync(s.transcriptPath) ? s.transcriptPath : null;
  }

  /** Only tabs whose hooks we have heard from are Claude Code (bridge) tabs. */
  runnerFor(tabKey: string): string {
    return this.o.seen.get(tabKey) ? "cc-bridge" : "unknown";
  }

  currentSessionId(tabKey: string): string | null {
    return this.o.seen.get(tabKey)?.sessionId ?? null;
  }

  point(tabKey: string, sessionId: string): boolean {
    const seen = this.o.seen.get(tabKey);
    if (!seen) return false;
    const file = this.file();
    try {
      const map = JSON.parse(readFileSync(file, "utf-8")) as Record<
        string,
        { sessionId?: string; updatedAt?: number }
      >;
      let changed = false;
      for (const entry of Object.values(map)) {
        if (entry && entry.sessionId === seen.sessionId) {
          entry.sessionId = sessionId;
          entry.updatedAt = this.now();
          changed = true;
        }
      }
      if (!changed) return false;
      const tmp = `${file}.amygdala.tmp`;
      writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
      renameSync(tmp, file);
      this.o.seen.set(tabKey, {
        ...seen,
        sessionId,
        transcriptPath: seen.transcriptPath
          ? join(dirname(seen.transcriptPath), `${sessionId}.jsonl`)
          : null,
        ts: this.now(),
      });
      return true;
    } catch (err) {
      console.error("[amygdala] could not re-point the bridge session map", basename(file), err);
      return false;
    }
  }
}
