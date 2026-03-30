/**
 * FORK: Async git metadata cache for AMYGDALA.
 *
 * Caches git commit/author counts per file with lazy invalidation.
 * Uses chokidar for filesystem watching when available, falls back
 * to TTL-based invalidation. All git operations are async.
 *
 * Gracefully handles missing chokidar (TTL-only mode).
 */

import { exec as execCb } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

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
      const escapedDir = dir.replace(/"/g, '\\"');
      const escapedFile = file.replace(/"/g, '\\"');

      const [commitResult, authorResult] = await Promise.all([
        execAsync(
          `git -C "${escapedDir}" log --since="${hours} hours ago" --oneline -- "${escapedFile}" 2>/dev/null | wc -l`,
          { encoding: "utf-8", timeout: 5000 },
        ),
        execAsync(
          `git -C "${escapedDir}" log --since="${hours} hours ago" --format="%an" -- "${escapedFile}" 2>/dev/null | sort -u | wc -l`,
          { encoding: "utf-8", timeout: 5000 },
        ),
      ]);

      return {
        recent_commits: parseInt(commitResult.stdout.trim(), 10) || 0,
        recent_authors: parseInt(authorResult.stdout.trim(), 10) || 0,
        updated_at: Date.now(),
      };
    } catch {
      return { recent_commits: 0, recent_authors: 0, updated_at: Date.now() };
    }
  }
}
