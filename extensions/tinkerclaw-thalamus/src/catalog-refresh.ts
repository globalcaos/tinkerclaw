// The past-chat catalogue keeps itself (2026-10-25, memory post: "every night a scheduled job adds the day's new chats
// to the catalogue").
//
// WHAT THIS IS FOR. The ask-session skill builds the catalogue the past-chat pointers and the wakes read, but only a
// systemd timer the owner installs by hand (`install-timer.sh`) kept it fresh, so a fresh clone had no catalogue at all
// and the past-chat leg stayed silent. With `anticipate.refreshCatalog` (on by default) the gateway runs the skill's own
// incremental `sessions.py catalog` once a night, in the 02:00-06:00 window, when the last run is older than
// `STALE_MS`; at any hour when it is older than `OVERDUE_MS` (a machine that is off at night); and once, a few minutes
// after start, when there is no catalogue yet. No model, no wake, no network: it reads `~/.claude/projects` and writes
// the catalogue file. An installed timer is left alone; whichever runs first refreshes the stamp and the other one finds
// nothing to do but a quick incremental scan.
//
// A custom `anticipate.chatCatalog` is the owner's own file: the gateway never refreshes it (the script writes only the
// default path).

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";

export const STALE_MS = 20 * 3_600_000;
export const OVERDUE_MS = 48 * 3_600_000;
/** After a failed run, wait this long before trying again. */
export const RETRY_MS = 3_600_000;
/** A run that takes longer than this is stopped (the first full scan of a big history takes minutes, not hours). */
export const RUN_LIMIT_MS = 30 * 60_000;
const NIGHT_FROM = 2;
const NIGHT_TO = 6;

export type CatalogRun = { code: number | null; out: string };

export type RefreshDue = { why: "first" | "nightly" | "overdue"; args: string[] };

/**
 * Whether a refresh is due now and with which arguments; undefined when not. Pure: the times come in.
 * `stampAt` is the end of the last `catalog` run (the script's `catalog.stamp`); a catalogue built by an older script
 * has none and counts as stale.
 */
export function refreshDue(o: {
  now: number;
  localHour: number;
  catalogExists: boolean;
  stampAt: number | undefined;
}): RefreshDue | undefined {
  if (!o.catalogExists) {
    return { why: "first", args: ["catalog"] };
  }
  const age = o.stampAt === undefined ? Number.POSITIVE_INFINITY : o.now - o.stampAt;
  // Only the files touched since the last run need reading; a day of margin covers a clock or timezone step.
  const days = Number.isFinite(age)
    ? Math.min(30, Math.max(2, Math.ceil(age / 86_400_000) + 1))
    : 3;
  const args = ["catalog", "--since", String(days)];
  if (age >= OVERDUE_MS) {
    return { why: "overdue", args };
  }
  if (age >= STALE_MS && o.localHour >= NIGHT_FROM && o.localHour < NIGHT_TO) {
    return { why: "nightly", args };
  }
  return undefined;
}

export function createCatalogRefresh(d: {
  enabled: () => boolean;
  /** The ask-session script; undefined: nothing to run. */
  script: () => string | undefined;
  /** The catalogue the pointers read (`anticipate.chatCatalog`). */
  catalogPath: () => string;
  /** Where the script writes (`$OPENCLAW_STATE_DIR/ask-session/catalog.sqlite`): only that file is refreshed. */
  defaultPath: () => string;
  now: () => number;
  localHour?: (t: number) => number;
  python?: string;
  exists?: (p: string) => boolean;
  mtime?: (p: string) => number | undefined;
  /** Runs the script with these arguments; injectable so tests start nothing. */
  run?: (python: string, args: string[]) => Promise<CatalogRun>;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}) {
  const exists = d.exists ?? existsSync;
  const mtime =
    d.mtime ??
    ((p: string) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return undefined;
      }
    });
  const localHour = d.localHour ?? ((t: number) => new Date(t).getHours());
  const run =
    d.run ??
    ((python: string, args: string[]) =>
      new Promise<CatalogRun>((resolve) => {
        let out = "";
        let child: ReturnType<typeof nodeSpawn>;
        try {
          child = nodeSpawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
          resolve({ code: null, out: String(err) });
          return;
        }
        if (child.pid) {
          try {
            setPriority(child.pid, 10);
          } catch {
            /* lower priority is a courtesy */
          }
        }
        const keep = (b: Buffer) => {
          out = (out + b.toString("utf8")).slice(-2000);
        };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        const limit = setTimeout(() => child.kill("SIGTERM"), RUN_LIMIT_MS);
        limit.unref?.();
        child.on("error", (err) => {
          clearTimeout(limit);
          resolve({ code: null, out: String(err) });
        });
        child.on("close", (code) => {
          clearTimeout(limit);
          resolve({ code, out });
        });
      }));

  let running = false;
  let lastAttempt = 0;
  let last: { at: number; why: string; ok: boolean; line: string } | undefined;

  return {
    /** Start a refresh if one is due. Never throws, never waits: the run goes on in the background. */
    tick(): Promise<void> | undefined {
      if (running || !d.enabled()) {
        return undefined;
      }
      const path = d.catalogPath();
      if (!path || path !== d.defaultPath()) {
        return undefined;
      }
      const script = d.script();
      if (!script) {
        return undefined;
      }
      const t = d.now();
      if (lastAttempt && t - lastAttempt < RETRY_MS) {
        return undefined;
      }
      const due = refreshDue({
        now: t,
        localHour: localHour(t),
        catalogExists: exists(path),
        stampAt: mtime(join(dirname(path), "catalog.stamp")),
      });
      if (!due) {
        return undefined;
      }
      running = true;
      lastAttempt = t;
      return run(d.python ?? "python3", ["-I", script, ...due.args])
        .then((r) => {
          const line = r.out.trim().split("\n").at(-1) ?? "";
          last = { at: d.now(), why: due.why, ok: r.code === 0, line };
          if (r.code === 0) {
            d.logger?.info(`[thalamus] past-chat catalogue refreshed (${due.why}): ${line}`);
          } else {
            d.logger?.warn(
              `[thalamus] past-chat catalogue refresh failed (exit ${r.code}): ${line}`,
            );
          }
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    },

    stats: () => ({ running, ...(last ? { last } : {}) }),
  };
}

export type CatalogRefresh = ReturnType<typeof createCatalogRefresh>;
