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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionMap } from "./rewind.js";

export interface SeenSession {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  ts: number;
}

/**
 * What the hooks told us about each tab: its Claude session id and transcript path (bounded, newest wins).
 *
 * FORK 2026-11-13: with `file`, kept on disk too (0600, rewritten only when a tab's session or transcript changes).
 * Memory only, every gateway restart emptied it, and every tab answered "this runner cannot rewind" until it ran a
 * new turn; a chat stuck on a refusal is the one that will not.
 */
export class SeenSessions {
  private readonly m = new Map<string, SeenSession>();

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, SeenSession>;
      for (const [k, v] of Object.entries(raw ?? {})) {
        if (v && typeof v.sessionId === "string" && v.sessionId) this.m.set(k, v);
      }
    } catch {
      /* a broken file starts empty: the next hook fills it again */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.m)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[amygdala] could not save the tab-to-session map", err);
    }
  }

  note(
    tabKey: string,
    hook: { session_id?: unknown; transcript_path?: unknown; cwd?: unknown },
    now: number,
  ): void {
    const id = typeof hook.session_id === "string" ? hook.session_id : "";
    if (!id) return;
    const before = this.m.get(tabKey);
    const path = typeof hook.transcript_path === "string" ? hook.transcript_path : null;
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
    if (!before || before.sessionId !== id || before.transcriptPath !== path) this.save();
  }

  get(tabKey: string): SeenSession | undefined {
    return this.m.get(tabKey);
  }

  set(tabKey: string, s: SeenSession): void {
    this.m.set(tabKey, s);
    this.save();
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

/**
 * FORK 2026-10-22 (Rewind): the tinker-bridge publishes this on globalThis (extensions cannot import each other).
 * Rewriting `session-map.json` alone changes nothing the bridge uses: it reads the file once into a cache and keeps
 * the warm worker (a live `claude` holding the whole conversation) for 15 minutes. The seam moves the cache and
 * retires the idle worker, so the next turn resumes the fork. Absent = no bridge loaded: the file rewrite below stays.
 */
export const BRIDGE_REWIND_SLOT = "openclaw.bridgeRewind";
interface BridgeRewindSeam {
  busy(claudeSessionId: string): boolean;
  rebind(from: string, to: string): { ok: boolean; reason?: string };
}
function bridgeSeam(): BridgeRewindSeam | undefined {
  const s = (globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_REWIND_SLOT)];
  return s && typeof s === "object" ? (s as BridgeRewindSeam) : undefined;
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

  /**
   * FORK 2026-11-13: the tab's earlier Claude sessions, newest first, from the bridge map: the entries that share the
   * OpenClaw session id of the tab's current entry. Only transcripts still on disk, the current one left out.
   */
  earlierTranscriptsFor(tabKey: string): string[] {
    const seen = this.o.seen.get(tabKey);
    if (!seen?.transcriptPath) return [];
    try {
      const map = JSON.parse(readFileSync(this.file(), "utf-8")) as Record<
        string,
        { sessionId?: string; updatedAt?: number; openclawSessionId?: string }
      >;
      const entries = Object.values(map).filter((e) => e && typeof e.sessionId === "string");
      const oc = entries.find((e) => e.sessionId === seen.sessionId)?.openclawSessionId;
      if (!oc) return [];
      const dir = dirname(seen.transcriptPath);
      const newest = new Map<string, number>();
      for (const e of entries) {
        if (e.openclawSessionId !== oc || !e.sessionId || e.sessionId === seen.sessionId) continue;
        newest.set(e.sessionId, Math.max(newest.get(e.sessionId) ?? 0, e.updatedAt ?? 0));
      }
      return [...newest.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => join(dir, `${id}.jsonl`))
        .filter((p) => existsSync(p));
    } catch (err) {
      console.error("[amygdala] could not read the bridge map for earlier sessions", err);
      return [];
    }
  }

  currentSessionId(tabKey: string): string | null {
    return this.o.seen.get(tabKey)?.sessionId ?? null;
  }

  busy(tabKey: string): boolean {
    const seen = this.o.seen.get(tabKey);
    if (!seen) return false;
    try {
      return bridgeSeam()?.busy(seen.sessionId) === true;
    } catch (err) {
      console.error("[amygdala] bridge busy check failed", err);
      return true; // cannot tell: do not cut under a live worker
    }
  }

  point(tabKey: string, sessionId: string): boolean {
    const seen = this.o.seen.get(tabKey);
    if (!seen) return false;
    const seam = bridgeSeam();
    if (seam) {
      try {
        if (!seam.rebind(seen.sessionId, sessionId).ok) return false;
      } catch (err) {
        console.error("[amygdala] bridge rebind failed", err);
        return false;
      }
      this.o.seen.set(tabKey, {
        ...seen,
        sessionId,
        transcriptPath: seen.transcriptPath
          ? join(dirname(seen.transcriptPath), `${sessionId}.jsonl`)
          : null,
        ts: this.now(),
      });
      return true;
    }
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
