import { describe, expect, it } from "vitest";
import { GIT_CACHE_DEFAULTS } from "../index.js";

/**
 * 2026-10-18 (bible bug-log `freeze-stuck-freezing`). The git cache's chokidar watcher used to watch
 * every file under ~/src (342,100 entries that day, mostly the 14 worktrees in ~/src/tinkerclaw-wt),
 * in every process that loads this plugin, until the user's inotify budget ran out: the gateway held
 * 291,747 watches and one terminal `openclaw` 226,771, of 524,288. Its error handler swallowed the
 * ENOSPC. systemd could then no longer watch new units, and a restart froze a chat's worker that
 * nothing thawed. The watcher only marked cached git counts stale sooner than the 300 s TTL does.
 *
 * Checked on the defaults, not by starting a watcher: on the old defaults that would crawl the real
 * ~/src and take the very watches this test exists to protect.
 */
describe("the git cache's filesystem watcher", () => {
  it("is off by default and watches no path; the TTL alone expires cached counts", () => {
    expect(GIT_CACHE_DEFAULTS.enabled).toBe(false);
    expect(GIT_CACHE_DEFAULTS.watch_paths).toEqual([]);
    expect(GIT_CACHE_DEFAULTS.ttl_seconds).toBe(300);
  });
});
