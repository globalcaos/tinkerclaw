/**
 * FORK: Async git metadata cache for AMYGDALA.
 *
 * Caches git commit/author counts per file with lazy invalidation.
 * Uses chokidar for filesystem watching when available, falls back
 * to TTL-based invalidation. All git operations are async.
 *
 * Gracefully handles missing chokidar (TTL-only mode).
 */

import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

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

/**
 * Async git metadata cache with optional filesystem watcher invalidation.
 * Falls back to TTL-only invalidation if chokidar is not available.
 */
export class GitCache {
  private cache: Map<string, CacheEntry> = new Map();
  // FORK 2026-10-29: the git lookup in flight for each path, and the window (hours) it counts.
  // buildSituation reads the commits and the authors of one target in the same tick. Both reads
  // missed the cache and each started its own lookup; now the second joins the first. The slot
  // is emptied when the lookup settles.
  private inFlight: Map<string, { hours: number; lookup: Promise<CacheEntry> }> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private watchers: any[] = [];
  private staleKeys: Set<string> = new Set();
  private config: GitCacheConfig;

  constructor(config: GitCacheConfig) {
    this.config = config;
  }

  /**
   * Start filesystem watchers on configured directories.
   * Gracefully handles missing chokidar.
   */
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
    // FORK 2026-10-29: no read after stop() joins a lookup that began before it.
    this.inFlight.clear();
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
    // FORK 2026-10-29: the next read starts a fresh lookup, even while an older one runs.
    this.inFlight.delete(filePath);
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

    // FORK 2026-10-29: join the lookup already running for this path and window, unless the path
    // was marked stale after it started. Then this read starts a fresh one, the same rule the
    // cached entry above follows.
    const pending = this.inFlight.get(filePath);
    if (pending && pending.hours === hours && !this.staleKeys.has(filePath)) {
      return pending.lookup;
    }

    this.staleKeys.delete(filePath);
    const lookup: Promise<CacheEntry> = this.computeGitMetadata(filePath, hours)
      .then((entry) => {
        this.cache.set(filePath, entry);
        return entry;
      })
      .finally(() => {
        // A read for another window, or one after a stale mark, may hold the slot by now.
        if (this.inFlight.get(filePath)?.lookup === lookup) {
          this.inFlight.delete(filePath);
        }
      });
    this.inFlight.set(filePath, { hours, lookup });
    return lookup;
  }

  private async computeGitMetadata(filePath: string, hours: number): Promise<CacheEntry> {
    try {
      const dir = path.dirname(filePath);
      // FORK 2026-10-29: `git -C <dir>` fails when <dir> is missing or is not a directory, and the
      // catch below then answers 0/0. Many 'file' targets are shell command strings, since
      // classifyTargetType takes anything with a "." for a path. An async stat gives the same
      // answer without a spawn.
      const dirStat = await fs.stat(dir);
      if (!dirStat.isDirectory()) {
        return { recent_commits: 0, recent_authors: 0, updated_at: Date.now() };
      }
      const file = path.basename(filePath);
      const since = `--since=${hours} hours ago`;
      const opts = { encoding: "utf-8" as const, timeout: 5000 };

      // FORK 2026-10-29: one `git log` where there were two (`--oneline` for the commits,
      // `--format=%an` for the authors). Each spawn blocks the gateway's main thread: 49-53 ms at
      // 3.3 GB RSS, measured in a proxy process on 2026-10-29. %H is never empty and has no tab, so
      // each commit is still one non-empty line, the old --oneline count, and what follows the
      // first tab is the old %an line: a blank name counts as a commit but not as an author, as
      // before. A line without a tab, if git ever prints more than the format, counts whole, as it
      // did in both old outputs.
      const { stdout } = await execFileAsync(
        "git",
        ["-C", dir, "log", since, "--format=%H%x09%an", "--", file],
        opts,
      );

      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      const authors = new Set<string>();
      for (const line of lines) {
        const author = line.slice(line.indexOf("\t") + 1);
        if (author.trim().length > 0) {
          authors.add(author);
        }
      }

      return {
        recent_commits: lines.length,
        recent_authors: authors.size,
        updated_at: Date.now(),
      };
    } catch {
      return { recent_commits: 0, recent_authors: 0, updated_at: Date.now() };
    }
  }
}
