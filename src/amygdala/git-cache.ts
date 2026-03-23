// ============================================================
// src/amygdala/git-cache.ts
// Async git metadata cache with chokidar file watching and cache invalidation.
// ALL git operations are async — never execSync, never statSync.
// ============================================================

import * as path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import chokidar, { type FSWatcher } from 'chokidar';

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
  updated_at: number; // Date.now()
}

/**
 * Async git metadata cache with filesystem watcher invalidation.
 *
 * Strategy:
 *   1. On startup, start chokidar watchers on configured directories.
 *      (chokidar is used instead of fs.watch for cross-platform reliability —
 *       fs.watch hits ENOSPC on Linux with large directories and is flaky
 *       across platforms. chokidar handles this gracefully.)
 *   2. On file change event, mark the cached entry as stale.
 *   3. On next read, re-compute from git (lazy invalidation).
 *   4. Fallback: TTL-based invalidation if watchers fail.
 *
 * IMPORTANT: All git operations use async exec (never execSync).
 * Blocking the Node event loop for git log calls would freeze the agent.
 *
 * This reduces hot-path latency from ~15ms (git log per call) to ~2ms (cache hit).
 */
export class GitCache {
  private cache: Map<string, CacheEntry> = new Map();
  private watchers: FSWatcher[] = [];
  private staleKeys: Set<string> = new Set();
  private config: GitCacheConfig;

  constructor(config: GitCacheConfig) {
    this.config = config;
  }

  /**
   * Start filesystem watchers on configured directories.
   * Safe to call multiple times — guards against double-start.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {return;}
    if (this.watchers.length > 0) {return;} // Already started

    for (const watchPath of this.config.watch_paths) {
      try {
        const watcher = chokidar.watch(watchPath, {
          ignoreInitial: true,
          persistent: true,
          // Avoid watching node_modules, .git, dist, etc.
          ignored: /(^|[/\\])(\.|node_modules|dist|dist-runtime)/,
          // Use polling as fallback for network filesystems
          usePolling: false,
          // Stabilize events (wait for writes to finish before firing)
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
        });

        watcher.on('all', (_event: string, filePath: string) => {
          this.staleKeys.add(filePath);
        });

        watcher.on('error', (err: unknown) => {
          // Non-fatal: log and continue. TTL fallback will handle staleness.
          console.warn(`[GitCache] Watcher error on ${watchPath}:`, err);
        });

        this.watchers.push(watcher);
      } catch (err) {
        // Watcher failed — fall back to TTL-only invalidation.
        console.warn(`[GitCache] Failed to watch ${watchPath}:`, err);
      }
    }
  }

  /**
   * Stop all filesystem watchers and clear internal state.
   */
  async stop(): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];
    this.cache.clear();
    this.staleKeys.clear();
  }

  /**
   * Get number of commits touching this file in the last `hours` hours.
   * Uses cache with lazy invalidation on file change events.
   * Falls back to 0 if the file is not in a git repo.
   */
  async getRecentCommits(filePath: string, hours: number = 72): Promise<number> {
    const entry = await this.getOrCompute(filePath, hours);
    return entry.recent_commits;
  }

  /**
   * Get number of distinct authors for this file in the last `hours` hours.
   * Uses cache with lazy invalidation on file change events.
   * Falls back to 0 if the file is not in a git repo.
   */
  async getRecentAuthors(filePath: string, hours: number = 72): Promise<number> {
    const entry = await this.getOrCompute(filePath, hours);
    return entry.recent_authors;
  }

  /**
   * Invalidate cache entry for a specific file path.
   * Useful when an action is about to modify a file and fresh data is needed.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
    this.staleKeys.delete(filePath);
  }

  /**
   * Get cache entry, recomputing if stale or expired.
   */
  private async getOrCompute(filePath: string, hours: number): Promise<CacheEntry> {
    const cached = this.cache.get(filePath);
    const now = Date.now();

    if (cached && !this.staleKeys.has(filePath)) {
      const ageSeconds = (now - cached.updated_at) / 1000;
      if (ageSeconds < this.config.ttl_seconds) {
        return cached; // Cache hit — fast path
      }
    }

    // Cache miss or stale — recompute from git
    this.staleKeys.delete(filePath);
    const entry = await this.computeGitMetadata(filePath, hours);
    this.cache.set(filePath, entry);
    return entry;
  }

  /**
   * Compute git metadata for a file path via async shell commands.
   *
   * IMPORTANT: Uses promisify(exec), never execSync — must not block the event loop.
   * Runs both git commands in parallel with Promise.all for minimal latency.
   *
   * Returns zeroed entry if:
   *   - File is not in a git repository
   *   - File does not exist
   *   - Git is not installed
   *   - Command times out (5s limit)
   */
  private async computeGitMetadata(filePath: string, hours: number): Promise<CacheEntry> {
    try {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      const escapedDir = dir.replace(/"/g, '\\"');
      const escapedFile = file.replace(/"/g, '\\"');

      // Run both git queries in parallel — never block sequentially
      const [commitResult, authorResult] = await Promise.all([
        execAsync(
          `git -C "${escapedDir}" log --since="${hours} hours ago" --oneline -- "${escapedFile}" 2>/dev/null | wc -l`,
          { encoding: 'utf-8', timeout: 5000 },
        ),
        execAsync(
          `git -C "${escapedDir}" log --since="${hours} hours ago" --format="%an" -- "${escapedFile}" 2>/dev/null | sort -u | wc -l`,
          { encoding: 'utf-8', timeout: 5000 },
        ),
      ]);

      return {
        recent_commits: parseInt(commitResult.stdout.trim(), 10) || 0,
        recent_authors: parseInt(authorResult.stdout.trim(), 10) || 0,
        updated_at: Date.now(),
      };
    } catch {
      // Not a git repo, file not tracked, or git not available
      return { recent_commits: 0, recent_authors: 0, updated_at: Date.now() };
    }
  }
}
