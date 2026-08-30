/**
 * FORK 2026-08-18 (the architect: "Every cron should publish in its corresponding card
 * instead of here, in the main tab... If I don't click on the 'read' checkbox,
 * the cron should understand that I have not read it yet, and its nightly cron
 * should compound on top of what was there before").
 *
 * THE SHIFT THIS FILE ENCODES: the Crons tab was STATELESS — reports are
 * immutable `reports/<date>/<job>.md` files and the panel rendered the newest
 * one. Nothing survived a night, so nothing could compound, be dismissed, or be
 * marked read. This adds the missing layer: a per-job BOARD of items that carry
 * identity across runs.
 *
 * Board files live at `~/.openclaw/cron/board/<jobId>.json`. The report files
 * remain the immutable source of truth and are never written to — the board is
 * a derived, user-mutable view over them.
 *
 * IDENTITY IS THE WHOLE DESIGN. An item recurring on five consecutive nights
 * with a bumped counter ("Baileys #49 day 29" → "day 30") must be ONE item that
 * aged, not five items. `stableItemId` therefore hashes the text with volatile
 * counters stripped. Get this wrong and the board becomes the wall of
 * duplicates it exists to replace.
 */

/** Stored kind. New bullets use ask/act/watch/broke/found/fyi. Leftover
 *  FLAG/CHANGED/… stay as themselves so identity hashes do not fork. The card
 *  maps both families to the six skim tags at paint time. */
export type BoardItemKind =
  | "ask"
  | "act"
  | "watch"
  | "broke"
  | "found"
  | "fyi"
  | "flag"
  | "changed"
  | "realized"
  | "dead"
  | "failed"
  | "note";

/**
 * open      — live, shown on the card.
 * dismissed — the architect dismissed it WITH A REASON. Never auto-reopens; recurrence
 *             is still counted so "you dismissed this, it came back 3×" stays
 *             tellable. The reason is fed BACK to the cron (see boardDigest).
 * resolved  — stopped being reported for `RESOLVE_AFTER_MISSED_RUNS` runs, so
 *             the condition is presumed gone. Auto, reversible.
 */
export type BoardItemStatus = "open" | "dismissed" | "resolved";

export type BoardItem = {
  /** sha1(jobId + volatility-stripped text).slice(0,12) — see stableItemId. */
  id: string;
  kind: BoardItemKind;
  /** Newest phrasing wins: a recurring item shows today's wording, not day 1's. */
  text: string;
  /** YYYY-MM-DD of the report that first produced this item. */
  firstSeen: string;
  /** YYYY-MM-DD of the most recent report that carried it. */
  lastSeen: string;
  /** How many distinct report dates carried it. The age signal on the card. */
  runs: number;
  /** User-controlled position. Lower sorts first. Untouched items keep ingest order. */
  order: number;
  /** Pinned items sort above everything regardless of `order`. */
  pinned: boolean;
  status: BoardItemStatus;
  /** ISO. Set when status became "dismissed". */
  dismissedAt?: string;
  /** the architect's words. The instruction channel back to the cron — NOT decoration. */
  dismissReason?: string;
  /** Times the item recurred in a report AFTER being dismissed. */
  recurrencesSinceDismissal?: number;
  /** ISO. Set when auto-resolved by absence. */
  resolvedAt?: string;
  /**
   * True once a read-ack has covered this item. Acknowledged items that do NOT
   * recur are archived on the next ingest; ones that DO recur come back, because
   * they are still true.
   */
  acknowledged?: boolean;
};

export type CronBoard = {
  jobId: string;
  /**
   * Derived convenience: set only when EVERY open item is acknowledged.
   * Compounding is per-item (`acknowledged`), not per-card. Kept so older
   * callers of `cronpanel.board.read` still have a whole-card switch.
   */
  readAt: string | null;
  /** Newest report date already merged in. Makes ingest idempotent + resumable. */
  lastIngestedDate: string | null;
  items: BoardItem[];
  /** Cleared items, kept so nothing is ever silently destroyed. */
  archived: BoardItem[];
};

/** An open item must be absent from this many consecutive ingests to auto-resolve. */
export const RESOLVE_AFTER_MISSED_RUNS = 3;

export function emptyBoard(jobId: string): CronBoard {
  return { jobId, readAt: null, lastIngestedDate: null, items: [], archived: [] };
}

/**
 * Digit→letter cipher used to smuggle identifiers past the numeric sweep below.
 * Ten letters, none of which appear in the sentinel prefixes (`idhash`, `idbug`,
 * `idcve`), so an encoded run can never be confused with the prefix itself.
 */
const DIGIT_LETTERS = "qrstuvwxyz";

function encodeDigits(digits: string): string {
  return digits.replace(/\d/g, (c) => DIGIT_LETTERS[Number(c)]!);
}

/**
 * Strip the parts of a bullet that change every night while the ISSUE stays the
 * same, so recurrence merges instead of duplicating. Removes day/T-minus
 * counters, ordinals, dates, times, percentages, byte/size figures and bare
 * numbers, then collapses punctuation and case.
 *
 * Deliberately NOT stripped: identifiers like `#49`, `CVE-2026-53359`,
 * `B037` — those are what make two bullets the same issue in the first place.
 *
 * HOW IDENTIFIERS SURVIVE, and why the obvious version was wrong (2026-08-18):
 * the first cut protected them by rewriting `#49` → `ID49ID` and restoring after
 * the sweep. That is dead code — `[\d.,]+` eats the digits INSIDE the sentinel
 * before the restore ever matches, so `#49` and `#50` both flattened to `id id`
 * and **two unrelated issues merged into one board item**. That is the exact
 * inverse of the failure this function exists to prevent, and it is the more
 * dangerous direction: a duplicated item is visible noise, a wrongly-merged one
 * silently hides a real issue behind another one's text. Caught empirically by
 * the board-store unit while writing its tests; the collision is now a
 * regression test in board-store.test.ts.
 *
 * The fix encodes identifier digits as LETTERS, which the numeric sweep cannot
 * see, and never decodes them. Legitimate, because the output of this function
 * is ONLY ever a hash input (see stableItemId) — it is never displayed, so it
 * does not need to be readable, only stable and collision-free.
 */
export function volatilityStrippedText(text: string): string {
  return (
    text
      // markdown emphasis / code fences / links → their visible text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]+/g, "")
      // protect identifiers before the number sweep, digit-free so it survives it
      .replace(/#(\d+)/g, (_m, d: string) => ` idhash${encodeDigits(d)} `)
      .replace(/\bB(\d{3})\b/g, (_m, d: string) => ` idbug${encodeDigits(d)} `)
      .replace(
        /\bCVE-(\d{4})-(\d+)/gi,
        (_m, y: string, n: string) => ` idcve${encodeDigits(y)}x${encodeDigits(n)} `,
      )
      // volatile counters
      .replace(/\bday\s*\d+\b/gi, " ")
      .replace(/\bT[-+]\d+\b/gi, " ")
      .replace(/\b\d+(st|nd|rd|th)\b/gi, " ")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
      .replace(/\b\d{1,2}:\d{2}\b/g, " ")
      .replace(/[\d.,]+\s*%/g, " ")
      .replace(/[\d.,]+\s*(gb|mb|kb|b|d|h|m|s|days?|hours?|runs?)\b/gi, " ")
      .replace(/[\d.,]+/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9#-]+/g, " ")
      .trim()
  );
}

/**
 * Stable identity for a board item: job + KIND + volatility-stripped text.
 *
 * KIND IS PART OF IDENTITY. Without it the two tiers contradicted each other -
 * the fuzzy tier refuses to cross kinds, while the exact hash crossed them
 * freely, because the kind prefix is stripped out of `text` before hashing. A
 * FLAG asks the architect for something; a CHANGED tells him something. Same sentence,
 * different claims, and letting them share an id also let two items claim one
 * key inside a single board.
 */
export function stableItemId(
  jobId: string,
  kind: BoardItemKind,
  text: string,
  sha1: (input: string) => string,
): string {
  return sha1(`${jobId} ${kind} ${volatilityStrippedText(text)}`).slice(0, 12);
}

/**
 * MEASURED 2026-08-18, on the first real backfill of 20 report dates: exact
 * hashing merged **5 items out of 1317**. Every other item sat at `runs: 1`.
 * The board accumulated and then auto-resolved instead of compounding, which is
 * the whole feature failing silently while looking populated.
 *
 * The cause was an assumption, not a coding error. `stableItemId` assumed a
 * recurring bullet is a stable string with a bumped counter — the shape of my
 * own test fixture. Real cron reports do not work that way: an agent rewrites
 * its prose every night, so two bullets about the SAME issue share most of
 * their content words and almost never their exact wording. Hashing a whole
 * paragraph makes identity hostage to phrasing.
 *
 * So identity is now two-tier: exact hash first (fast, unchanged), then a
 * content-word overlap fallback. Tuned deliberately conservative — a missed
 * merge shows as a duplicate, which the architect can see and dismiss; a wrong merge
 * hides a real issue behind another one's text, which he cannot see at all.
 */

/** Words too common in these reports to carry identity. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "as",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "now",
  "new",
  "still",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "one",
  "two",
  "three",
  "first",
  "second",
  "third",
  "last",
  "next",
  "only",
  "also",
  "more",
  "most",
  "less",
  "least",
  "into",
  "over",
  "under",
  "after",
  "before",
  "since",
  "until",
  "while",
  "when",
  "which",
  "who",
  "what",
  "how",
  "day",
  "days",
  "run",
  "runs",
  "today",
  "yesterday",
  "night",
  "nightly",
  "cron",
  "job",
  "report",
]);

/** Content words of a bullet, volatility already stripped. Order-insensitive. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of volatilityStrippedText(text).split(/\s+/)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Identifier-ish tokens — the encoded `#49` / `B037` / CVE sentinels plus
 * path-like and dotted names. If two bullets each carry identifiers and share
 * NONE, they are about different things no matter how similar the prose reads.
 */
function identifierTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith("idhash") || t.startsWith("idbug") || t.startsWith("idcve")) out.add(t);
  }
  return out;
}

/** Overlap coefficient, not Jaccard: a short bullet fully contained in a long
 *  one is the same issue told briefly, and Jaccard would punish it for brevity. */
export function textSimilarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  const ia = identifierTokens(ta);
  const ib = identifierTokens(tb);
  if (ia.size > 0 && ib.size > 0) {
    let shared = false;
    for (const t of ia) if (ib.has(t)) shared = true;
    // Both name an identifier and they disagree ⇒ different issues, full stop.
    if (!shared) return 0;
  }

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

/**
 * Overlap at or above this ⇒ the same issue reworded. Conservative on purpose:
 * see the note above on which direction of error is recoverable.
 */
export const MERGE_SIMILARITY_THRESHOLD = 0.62;

/** Below this many content words a bullet is too short to match safely — the
 *  overlap coefficient gets trivially high on 3-word fragments. */
export const MIN_TOKENS_FOR_FUZZY_MERGE = 5;

/**
 * The card summary the Crons tab lists. One per registered job.
 */
export type CronBoardSummary = {
  jobId: string;
  unread: boolean;
  openCount: number;
  flagCount: number;
  /** Open items the architect has ticked — they leave All and live in Acknowledged. */
  ackedCount: number;
  /** Oldest firstSeen among open items — how stale the worst item is. */
  oldestOpenDate: string | null;
  dismissedCount: number;
  lastIngestedDate: string | null;
};
