/**
 * FORK 2026-07-27 (the architect's session, after a 4-for-4 failure): verify `🌿 FRACTAL ACTION:`
 * claims against the filesystem.
 *
 * THE BUG THIS EXISTS FOR. The fractal reflection is composed in the same breath as the
 * answer, so its claims get drafted in prose mode — and prose is *asserted*, while actions
 * must be *executed*. On 2026-07-26/27 four consecutive reflections claimed durable artifacts
 * ("wrote X", "filed a repro in bug-log.md", "implemented the detector") and produced none of
 * them. Nothing detected it; two were caught only because an unrelated background task
 * happened to wake the turn. That is a straight honesty failure — the user was told files
 * existed that did not.
 *
 * WHAT THIS CHECKS, AND WHAT IT CANNOT. Two levels, because the first alone would have missed
 * half of tonight's failures:
 *   1. PATH — a backtick-wrapped path in the claim region must exist on disk.
 *   2. KEY — if the claim also names a bracketed key like `[some-slug]` (our bug-log entry
 *      convention), the named file must actually CONTAIN that key. "I appended an entry to
 *      bug-log.md" passes a path check trivially, since bug-log.md always exists; it is the
 *      key check that catches it.
 *
 * It is deliberately NOT a proof of work. A claim can still lie about *content* ("I rewrote
 * §6" when §6 is untouched), and a claim with no path in it is unverifiable by construction.
 * This closes the specific, repeated, mechanical failure — claiming a file that is not there —
 * and nothing more.
 *
 * WARNING-ONLY by design. It logs; it never blocks a turn or edits the reflection. A
 * false positive must cost the user nothing.
 */

/** One verified claim from a reflection block. */
export interface ActionClaimCheck {
  /** The path as written in the reflection (before ~ expansion). */
  path: string;
  /** Absolute path actually probed. */
  resolved: string;
  /** Did the file/dir exist? */
  exists: boolean;
  /** Bracketed keys named alongside this path, e.g. bug-log entry slugs. */
  keys: string[];
  /** Keys the file was expected to contain but does not (empty when exists=false). */
  missingKeys: string[];
}

/** Marker that opens a claim region. Kept as a constant so the test and the prompt agree. */
export const ACTION_MARKER = "🌿 FRACTAL ACTION:";
/** Any 🌿 line closes the previous region (e.g. a following `🌿 FRACTAL:` summary). */
const REGION_BREAK = /^\s*🌿/;

/**
 * Slice the reflection down to the text that belongs to FRACTAL ACTION claims.
 * A region runs from a line containing the marker until the next 🌿-led line or the end.
 */
export function actionClaimRegions(reflection: string): string[] {
  const lines = String(reflection ?? "").split("\n");
  const regions: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.includes(ACTION_MARKER)) {
      if (current) regions.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) {
      // a new 🌿 section (e.g. the plain `🌿 FRACTAL:` line) ends the claim region
      if (REGION_BREAK.test(line)) {
        regions.push(current.join("\n"));
        current = null;
        continue;
      }
      current.push(line);
    }
  }
  if (current) regions.push(current.join("\n"));
  return regions;
}

/** Backtick-wrapped tokens that look like paths (must contain a `/` — a bare `foo.md` or a
 *  code token like `EXPLORE_BONUS` is not a path claim and must not be flagged). */
function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim();
    if (!tok.includes("/")) continue;
    if (!tok.startsWith("/") && !tok.startsWith("~/")) continue;
    // strip trailing punctuation that belongs to the sentence, not the path
    out.push(tok.replace(/[.,;:)\]]+$/, ""));
  }
  return [...new Set(out)];
}

/** Bracketed kebab-case keys, our bug-log entry convention: `[some-entry-key]`. */
function keysIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[([a-z0-9]+(?:-[a-z0-9]+)+)\]/g)) {
    out.push(m[1]);
  }
  return [...new Set(out)];
}

export interface ClaimProbe {
  /** Does this path exist? */
  exists: (absPath: string) => boolean;
  /** Read a file for key checking; return "" when unreadable. */
  read: (absPath: string) => string;
  /** Absolute home dir, for ~ expansion. */
  home: string;
}

/**
 * Check every FRACTAL ACTION claim in a reflection. Returns one entry per claimed path;
 * callers warn on `!exists` or `missingKeys.length`.
 */
export function checkActionClaims(reflection: string, probe: ClaimProbe): ActionClaimCheck[] {
  const checks: ActionClaimCheck[] = [];
  for (const region of actionClaimRegions(reflection)) {
    const keys = keysIn(region);
    for (const p of pathsIn(region)) {
      const resolved = p.startsWith("~/") ? `${probe.home}/${p.slice(2)}` : p;
      const exists = probe.exists(resolved);
      let missingKeys: string[] = [];
      if (exists && keys.length) {
        const body = probe.read(resolved);
        missingKeys = keys.filter((k) => !body.includes(k));
      }
      checks.push({ path: p, resolved, exists, keys, missingKeys });
    }
  }
  return checks;
}

/** The one-line warnings a caller should log. Empty ⇒ every claim checked out. */
export function claimWarnings(checks: ActionClaimCheck[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (!c.exists) {
      out.push(`FRACTAL ACTION claimed ${c.path} — that path does not exist`);
    } else if (c.missingKeys.length) {
      out.push(
        `FRACTAL ACTION claimed ${c.missingKeys.map((k) => `[${k}]`).join(", ")} in ${c.path} — ` +
          `the file exists but does not contain ${c.missingKeys.length > 1 ? "those keys" : "that key"}`,
      );
    }
  }
  return out;
}
