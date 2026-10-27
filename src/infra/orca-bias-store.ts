// src/infra/orca-bias-store.ts
//
// THE BIAS DIAL, READ FROM THE GATEWAY.
//
// FORK 2026-09-02 (the architect): "make sure … Thalamus actually automatically switches
// among them smartly, following the BIAS selected in the slider". The dial already
// existed and already persisted: `prefrontal.orcaBias`
// (extensions/tinkerclaw-prefrontal/index.ts:906) writes `{biasIdx, ts}` to
// `~/.openclaw/orca-bias.json` on every drag. What was missing is a READER on the
// reply path — the ORCA Conductor was the only consumer, so on a normal chat turn
// the slider was a control with no effect.
//
// A FILE, NOT A MODULE-LEVEL NUMBER, because the writer is a different process
// (the gateway extension) from some of the readers (the out-of-process conductor
// CLI), and it has to survive a gateway restart. That is the producer's own stated
// reason; this module simply agrees with it instead of inventing a second channel.
//
// CACHED BY (mtimeMs, size), so a turn costs ONE `stat` and not a parse. Size is in
// the key alongside mtime on purpose: two writes inside the same millisecond are
// possible on a coarse-granularity filesystem, and the dial's payload changes length
// when `ts` does, so the pair catches what either alone can miss. `clearOrcaBiasCache`
// exists for tests, which write the same path repeatedly and faster than any clock.
//
// NEVER THROWS, AND A MISS IS `undefined`, NEVER A NUMBER. Absent, unreadable and
// corrupt all mean "the architect has expressed no preference", which the router
// turns into the balanced default via `clampBiasIdx`. Returning 3 from here instead
// would make "no file" indistinguishable from "deliberately set to balanced" at
// every call site — the routing disclosure could then claim a dial position nobody
// chose.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Lowest dial position — "fast". Mirrors THALAMUS_BIAS_GAP's index range. */
const MIN_BIAS_IDX = 0;
/** Highest dial position — "smart". */
const MAX_BIAS_IDX = 6;

/**
 * Where the dial lives.
 *
 * `OPENCLAW_ORCA_BIAS_FILE` is a TEST SEAM first and an operator escape hatch
 * second: without it a unit test either touches the architect's real dial or has to
 * thread an option through every intermediate caller. Explicit `opts.file` still
 * wins over the env var, so a test that passes a path cannot be surprised by an
 * env var another test forgot to clear.
 */
export function orcaBiasFilePath(file?: string): string {
  if (file) {
    return file;
  }
  const fromEnv = process.env.OPENCLAW_ORCA_BIAS_FILE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), ".openclaw", "orca-bias.json");
}

type CacheEntry = { mtimeMs: number; size: number; value: number | undefined };

const cache = new Map<string, CacheEntry>();

/** Drop the mtime cache. Tests rewrite one path faster than a filesystem clock ticks. */
export function clearOrcaBiasCache(): void {
  cache.clear();
}

/**
 * The dial position the architect last set, 0 (fast) … 6 (smart), or `undefined`
 * when nothing has been written or what is there cannot be read as a position.
 *
 * Non-integer and out-of-range values are ROUNDED and CLAMPED rather than rejected:
 * the writer already clamps to the same range, so a value outside it means the file
 * was hand-edited or written by an older build, and the nearest legal stop is a
 * better answer than silently falling back to balanced.
 */
export function readOrcaBias(opts?: { file?: string }): number | undefined {
  const file = orcaBiasFilePath(opts?.file);
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(file);
  } catch {
    // Missing (or unreadable) is a MISS, and the cache must not keep serving a
    // value for a file that has since been deleted.
    cache.delete(file);
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value;
  }
  let value: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { biasIdx?: unknown } | null;
    const raw = parsed?.biasIdx;
    // `Number(null)` is 0 and `Number("")` is 0 — both would read as the "fast" stop.
    // Only a real number, or a non-blank numeric string, counts as a position.
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim()
          ? Number(raw)
          : Number.NaN;
    value = Number.isFinite(n)
      ? Math.max(MIN_BIAS_IDX, Math.min(MAX_BIAS_IDX, Math.round(n)))
      : undefined;
  } catch {
    value = undefined;
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}
