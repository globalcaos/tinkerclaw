/**
 * Async git metadata cache for the digital amygdala (ported from tinkerclaw-learned-intuition).
 *
 * Caches per-file git commit/author counts with lazy invalidation and adds `historyFor`,
 * which turns a path into the TargetHistory the situation record carries. Uses chokidar for
 * filesystem watching when available and falls back to TTL invalidation. All git work is async.
 */

import { execFile as execFileCb } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { TargetHistory } from "./types.js";

/**
 * execFile, NOT exec: arguments are passed as an argv array with no shell in
 * between. A filePath containing backticks or $(...) would otherwise be command
 * substitution — on 2026-08-05 that launched the GNOME Orca screen reader and
 * the machine started reading the user's screen aloud.
 */
const execFileAsync = promisify(execFileCb);

export interface GitCacheConfig {
  /** Enable filesystem watchers */
  enabled: boolean;
  /** Directories to watch */
  watch_paths: string[];
  /** Cache TTL in seconds (fallback if watchers fail) */
  ttl_seconds: number;
}

interface CacheEntry {
  recent_commits: number;
  recent_authors: number;
  updated_at: number;
}

const GIT_OPTS = { encoding: "utf-8" as const, timeout: 5000 };

export class GitCache {
  private cache: Map<string, CacheEntry> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chokidar is an optional dependency, loaded dynamically
  private watchers: any[] = [];
  private staleKeys: Set<string> = new Set();
  private config: GitCacheConfig;

  constructor(config: GitCacheConfig) {
    this.config = config;
  }

  /** Start filesystem watchers on configured directories. Gracefully handles missing chokidar. */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (this.watchers.length > 0) {
      return;
    }

    let chokidar;
    try {
      chokidar = await import("chokidar");
    } catch {
      // chokidar not available -- TTL-only mode
      return;
    }

    for (const watchPath of this.config.watch_paths) {
      try {
        const watcher = chokidar.watch(watchPath, {
          ignoreInitial: true,
          persistent: true,
          ignored: /(^|[/\\])(\.|node_modules|dist|dist-runtime)/,
          usePolling: false,
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
        });

        watcher.on("all", (_event: string, filePath: string) => {
          this.staleKeys.add(filePath);
        });

        watcher.on("error", (_err: unknown) => {
          // Non-fatal: TTL fallback handles staleness
        });

        this.watchers.push(watcher);
      } catch {
        // Watcher failed -- fall back to TTL-only invalidation
      }
    }
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];
    this.cache.clear();
    this.staleKeys.clear();
  }

  async getRecentCommits(filePath: string, hours: number = 72): Promise<number> {
    const entry = await this.getOrCompute(filePath, hours);
    return entry.recent_commits;
  }

  async getRecentAuthors(filePath: string, hours: number = 72): Promise<number> {
    const entry = await this.getOrCompute(filePath, hours);
    return entry.recent_authors;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
    this.staleKeys.delete(filePath);
  }

  /**
   * What the situation record knows about a target: age, size and 72 h of git activity.
   * null when the path is missing or not inside a git work tree (the field stays missing).
   */
  async historyFor(filePath: string, nowMs: number = Date.now()): Promise<TargetHistory | null> {
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      return null;
    }
    const dir = st.isDirectory() ? filePath : path.dirname(filePath);
    try {
      await execFileAsync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], GIT_OPTS);
    } catch {
      return null;
    }
    const entry = await this.getOrCompute(filePath, 72);
    return {
      ageH: Math.max(0, (nowMs - st.mtimeMs) / 3_600_000),
      sizeB: st.size,
      edits72h: entry.recent_commits,
      authors72h: entry.recent_authors,
      lastMentionedByUser: null,
    };
  }

  private async getOrCompute(filePath: string, hours: number): Promise<CacheEntry> {
    const cached = this.cache.get(filePath);
    const now = Date.now();

    if (cached && !this.staleKeys.has(filePath)) {
      const ageSeconds = (now - cached.updated_at) / 1000;
      if (ageSeconds < this.config.ttl_seconds) {
        return cached;
      }
    }

    this.staleKeys.delete(filePath);
    const entry = await this.computeGitMetadata(filePath, hours);
    this.cache.set(filePath, entry);
    return entry;
  }

  private async computeGitMetadata(filePath: string, hours: number): Promise<CacheEntry> {
    try {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      const since = `--since=${hours}.hours`;

      const [commitResult, authorResult] = await Promise.all([
        execFileAsync("git", ["-C", dir, "log", since, "--oneline", "--", file], GIT_OPTS),
        execFileAsync("git", ["-C", dir, "log", since, "--format=%an", "--", file], GIT_OPTS),
      ]);

      const lines = (out: string): string[] =>
        out.split("\n").filter((line) => line.trim().length > 0);

      return {
        recent_commits: lines(commitResult.stdout).length,
        recent_authors: new Set(lines(authorResult.stdout)).size,
        updated_at: Date.now(),
      };
    } catch {
      return { recent_commits: 0, recent_authors: 0, updated_at: Date.now() };
    }
  }
}

const defaultCache = new GitCache({ enabled: false, watch_paths: [], ttl_seconds: 30 });

/** Convenience wrapper over a shared TTL-only cache. */
export function historyFor(filePath: string, nowMs?: number): Promise<TargetHistory | null> {
  return defaultCache.historyFor(filePath, nowMs);
}
