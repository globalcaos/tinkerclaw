/**
 * FORK 2026-08-18 — the STATE layer under the cron cards.
 *
 * `cron-data.ts` reads the immutable truth: `reports/<YYYY-MM-DD>/<job>.md`, one
 * file per run, never written to. That is a LOG, and a log cannot answer the two
 * questions the architect actually asks a card — "have I read this yet?" and "I already
 * told you why I don't care about that one". This file adds the missing mutable
 * projection over the log: `~/.openclaw/cron/board/<jobId>.json`.
 *
 * THREE INVARIANTS, ordered by how expensive they are to get wrong:
 *
 * 1. IDENTITY. A bullet that recurs nightly with a bumped counter is ONE aging
 *    item, not N duplicates. Every merge routes through `stableItemId`
 *    (board-types.ts), which hashes the text with volatile counters stripped.
 *    Break this and the board becomes the wall of noise it exists to replace.
 *
 * 2. A DISMISSAL IS NEVER SILENTLY OVERRIDDEN. Once the architect dismisses an item with
 *    a reason, a recurrence does NOT reopen it: it bumps
 *    `recurrencesSinceDismissal`, and the reason is fed BACK to the cron agent
 *    through `boardDigest` so the cron stops re-raising a settled matter. The
 *    reason is an instruction channel, not decoration.
 *
 * 3. UNREAD COMPOUNDS, PER ITEM. An item with `acknowledged !== true` stays on
 *    the card across nights whether or not it recurred. Only an item the architect has
 *    ticked as read is retired (moved to `archived`, never deleted) when it
 *    stops recurring. A ticked item that DOES recur comes back un-acked,
 *    because it is still true. `readAt` is a derived convenience
 *    ("every open item is acked") and never drives this decision.
 *
 * Report files are NEVER written. Board writes are atomic (tmp + rename) because
 * a torn board JSON would lose dismiss reasons, and those are human input that
 * cannot be regenerated from the reports.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  contentTokens,
  emptyBoard,
  MERGE_SIMILARITY_THRESHOLD,
  MIN_TOKENS_FOR_FUZZY_MERGE,
  textSimilarity,
  RESOLVE_AFTER_MISSED_RUNS,
  stableItemId,
  type BoardItem,
  type BoardItemKind,
  type BoardItemStatus,
  type CronBoard,
  type CronBoardSummary,
} from "./board-types.js";
import { readReportsForJob, type CronPanelResolvedConfig, type CronReport } from "./cron-data.js";

/** Sort weight when two items share an `order`. Flags shout loudest. */
const KIND_PRIORITY: Record<BoardItemKind, number> = {
  ask: 0,
  act: 0,
  flag: 0,
  watch: 1,
  broke: 1,
  failed: 1,
  found: 2,
  realized: 2,
  dead: 2,
  fyi: 3,
  changed: 3,
  note: 3,
};

/** Incoming tokens. Leftover FLAG stays `flag` so identity hashes do not fork. */
const KIND_BY_TOKEN: Record<string, BoardItemKind | undefined> = {
  ask: "ask",
  query: "ask",
  question: "ask",
  act: "act",
  flag: "flag",
  watch: "watch",
  warn: "watch",
  warning: "watch",
  broke: "broke",
  failed: "failed",
  fail: "failed",
  found: "found",
  realized: "realized",
  dead: "dead",
  discovery: "found",
  fyi: "fyi",
  changed: "changed",
  note: "note",
  shipped: "note",
};

/**
 * Report-date folders scanned per ingest. Generous on purpose: ingest is
 * idempotent, and the auto-resolve rule needs the FULL list of dates this job
 * has ever reported on, not just the unmerged tail.
 */
const REPORT_LOOKBACK_DAYS = 400;

/** Soft ceiling for `boardDigest` — it is prepended to a cron prompt. */
const DIGEST_MAX_CHARS = 2000;

/** Longest single bullet reproduced in the digest before elision. */
const DIGEST_TEXT_CLIP = 200;

/** `**FLAG:**`, `` `DEAD:` ``, `CHANGED:` — markdown around the token tolerated. */
const BULLET_PREFIX = /^[\s*_`~]*([A-Za-z]+)[\s*_`~]*:[\s*_`~]*([\s\S]*)$/;

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(text: string): string {
  // Keep a title/body split (a newline). Flatten only runs of spaces/tabs.
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * jobIds arrive from gateway params and this is the panel's only WRITE path:
 * a job id of `../../config` must not escape the board directory.
 */
function boardFileName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return `${safe || "unnamed"}.json`;
}

export function boardDir(cfg: CronPanelResolvedConfig): string {
  return path.join(cfg.cronDir, "board");
}

export function boardPath(cfg: CronPanelResolvedConfig, jobId: string): string {
  return path.join(boardDir(cfg), boardFileName(jobId));
}

/**
 * `CHANGED: text` → `{kind:"changed", text:"text"}`. An unrecognised or absent
 * prefix is a "note" that keeps its FULL text — stripping an unknown
 * `Something: value` prefix would silently destroy half the bullet.
 */
export function parseBullet(raw: string): { kind: BoardItemKind; text: string } {
  const trimmed = raw.trim();
  const m = BULLET_PREFIX.exec(trimmed);
  if (m) {
    const kind = KIND_BY_TOKEN[m[1].toLowerCase()];
    if (kind) return { kind, text: normalizeText(m[2]) };
  }
  return { kind: "note", text: normalizeText(trimmed) };
}

/** Display order for every consumer: pinned, then `order`, then kind, then age. */
export function sortBoardItems(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    const byKind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (byKind !== 0) return byKind;
    if (a.firstSeen !== b.firstSeen) return a.firstSeen < b.firstSeen ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function cloneItem(item: BoardItem): BoardItem {
  return { ...item };
}

function cloneBoard(board: CronBoard): CronBoard {
  return {
    jobId: board.jobId,
    readAt: board.readAt,
    lastIngestedDate: board.lastIngestedDate,
    items: board.items.map(cloneItem),
    archived: board.archived.map(cloneItem),
  };
}

/** Defensive read of one persisted item; returns null for anything unusable. */
function normalizeItem(raw: unknown): BoardItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.text !== "string") return null;
  const kind: BoardItemKind =
    typeof r.kind === "string"
      ? (KIND_BY_TOKEN[r.kind.toLowerCase()] ??
        (r.kind in KIND_PRIORITY ? (r.kind as BoardItemKind) : "fyi"))
      : "fyi";
  const status: BoardItemStatus =
    r.status === "dismissed" || r.status === "resolved" ? r.status : "open";
  const firstSeen = typeof r.firstSeen === "string" ? r.firstSeen : "";
  const item: BoardItem = {
    id: r.id,
    kind,
    text: r.text,
    firstSeen,
    lastSeen: typeof r.lastSeen === "string" ? r.lastSeen : firstSeen,
    runs:
      typeof r.runs === "number" && Number.isFinite(r.runs) ? Math.max(1, Math.floor(r.runs)) : 1,
    order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : 0,
    pinned: r.pinned === true,
    status,
  };
  if (typeof r.dismissedAt === "string") item.dismissedAt = r.dismissedAt;
  if (typeof r.dismissReason === "string") item.dismissReason = r.dismissReason;
  if (typeof r.recurrencesSinceDismissal === "number") {
    item.recurrencesSinceDismissal = r.recurrencesSinceDismissal;
  }
  if (typeof r.resolvedAt === "string") item.resolvedAt = r.resolvedAt;
  if (typeof r.acknowledged === "boolean") item.acknowledged = r.acknowledged;
  return item;
}

function normalizeBoard(raw: unknown, jobId: string): CronBoard {
  if (!raw || typeof raw !== "object") return emptyBoard(jobId);
  const r = raw as Record<string, unknown>;
  const readItems = (value: unknown): BoardItem[] =>
    Array.isArray(value) ? value.map(normalizeItem).filter((i): i is BoardItem => i !== null) : [];
  return {
    jobId,
    readAt: typeof r.readAt === "string" ? r.readAt : null,
    lastIngestedDate: typeof r.lastIngestedDate === "string" ? r.lastIngestedDate : null,
    items: readItems(r.items),
    archived: readItems(r.archived),
  };
}

/** Never throws: a missing OR corrupt board reads as an empty one. */
export function readBoard(cfg: CronPanelResolvedConfig, jobId: string): CronBoard {
  const p = boardPath(cfg, jobId);
  try {
    if (!fs.existsSync(p)) return emptyBoard(jobId);
    return normalizeBoard(JSON.parse(fs.readFileSync(p, "utf8")) as unknown, jobId);
  } catch {
    return emptyBoard(jobId);
  }
}

/** Atomic: a half-written board would lose dismiss reasons, which are user input. */
export function writeBoard(cfg: CronPanelResolvedConfig, board: CronBoard): void {
  const dir = boardDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const target = boardPath(cfg, board.jobId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * The ordered set of report dates considered "already ingested" as of `date`.
 * `ingestBoard` passes the real list (it knows every report folder for the job);
 * the fallback reconstructs a best-effort list from the board itself so the pure
 * function stays callable on its own.
 */
function ingestedDateUniverse(
  board: CronBoard,
  date: string,
  provided?: readonly string[],
): string[] {
  const seen = new Set<string>(provided ?? []);
  if (!provided) {
    for (const item of board.items) seen.add(item.lastSeen);
    if (board.lastIngestedDate) seen.add(board.lastIngestedDate);
  }
  seen.add(date);
  return [...seen].filter((d) => Boolean(d) && d <= date).sort();
}

/**
 * PURE. Fold one report into a board and return a NEW board.
 *
 * `ingestedDates` is the full ordered list of report dates ingested up to and
 * including `date`; it exists because auto-resolve counts MISSED RUNS, and a
 * board that only remembers `lastIngestedDate` cannot count them on its own.
 */
/**
 * Best same-kind item whose wording overlaps `text` enough to be the same issue.
 *
 * Guards, all load-bearing:
 *  - same `kind` only — a FLAG and a CHANGED that read alike are different claims;
 *  - never matches an item already seen on THIS date, or one report emitting two
 *    related bullets would collapse them into one and lose a fact;
 *  - dismissed items ARE matchable, so a recurrence still lands on the dismissal
 *    (invariant 2) instead of reappearing as a brand-new open item;
 *  - short bullets are excluded — overlap is trivially high on 3-word fragments;
 *  - best score wins, so a bullet does not attach to whichever item happened to
 *    be scanned first.
 */
function findSimilarItem(
  items: readonly BoardItem[],
  kind: BoardItemKind,
  text: string,
  date: string,
): BoardItem | undefined {
  if (contentTokens(text).size < MIN_TOKENS_FOR_FUZZY_MERGE) return undefined;
  let best: BoardItem | undefined;
  let bestScore = MERGE_SIMILARITY_THRESHOLD;
  for (const item of items) {
    if (item.kind !== kind) continue;
    if (item.lastSeen === date) continue;
    if (contentTokens(item.text).size < MIN_TOKENS_FOR_FUZZY_MERGE) continue;
    const score = textSimilarity(item.text, text);
    if (score >= bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

export function mergeReportIntoBoard(
  board: CronBoard,
  report: CronReport,
  date: string,
  ingestedDates?: readonly string[],
): CronBoard {
  const next = cloneBoard(board);
  const byId = new Map(next.items.map((item) => [item.id, item] as const));
  let maxOrder = next.items.reduce((max, item) => Math.max(max, item.order), -1);

  for (const raw of report.deltas) {
    const { kind, text } = parseBullet(raw);
    if (!text) continue;
    const id = stableItemId(next.jobId, kind, text, sha1);
    // Tier 1: exact identity. Tier 2: the same issue reworded — see the measured
    // note in board-types.ts on why hashing whole paragraphs merged 5/1317.
    // Only OPEN/RESOLVED items are fuzzy-matched against, and only within the
    // same kind: a FLAG and a CHANGED that read alike are still different claims.
    const existing = byId.get(id) ?? findSimilarItem(next.items, kind, text, date);
    if (existing) {
      const isNewDate = existing.lastSeen !== date;
      // Newest phrasing wins: the card shows tonight's wording, not day 1's.
      existing.text = text;
      existing.kind = kind;
      existing.lastSeen = date;
      if (date < existing.firstSeen) existing.firstSeen = date;
      if (isNewDate) existing.runs += 1;
      if (existing.status === "resolved") {
        // The condition came back — un-resolve, it was only presumed gone.
        existing.status = "open";
        delete existing.resolvedAt;
      } else if (existing.status === "dismissed" && isNewDate) {
        // INVARIANT 2: recurrence is recorded, never used to reopen.
        existing.recurrencesSinceDismissal = (existing.recurrencesSinceDismissal ?? 0) + 1;
      }
      continue;
    }
    maxOrder += 1;
    const item: BoardItem = {
      id,
      kind,
      text,
      firstSeen: date,
      lastSeen: date,
      runs: 1,
      order: maxOrder,
      pinned: false,
      status: "open",
    };
    next.items.push(item);
    byId.set(id, item);
  }

  // Auto-resolve by absence. Dismissed items are the architect's call, pinned items are
  // his too — neither is ever retired behind his back.
  const universe = ingestedDateUniverse(board, date, ingestedDates);
  const resolvedAt = nowIso();
  for (const item of next.items) {
    if (item.status !== "open" || item.pinned) continue;
    const missed = universe.filter((d) => d > item.lastSeen).length;
    if (missed >= RESOLVE_AFTER_MISSED_RUNS) {
      item.status = "resolved";
      item.resolvedAt = resolvedAt;
    }
  }

  next.lastIngestedDate =
    next.lastIngestedDate && next.lastIngestedDate > date ? next.lastIngestedDate : date;
  return next;
}

/**
 * Lazily fold every report date newer than `lastIngestedDate` into the board and
 * persist it. Idempotent: calling it twice with no new report is a no-op.
 */
export function ingestBoard(cfg: CronPanelResolvedConfig, jobId: string): CronBoard {
  const board = readBoard(cfg, jobId);
  const reports = readReportsForJob(cfg, jobId, REPORT_LOOKBACK_DAYS)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (reports.length === 0) return board;

  const allDates = reports.map((r) => r.date);
  const pending = reports.filter((r) => !board.lastIngestedDate || r.date > board.lastIngestedDate);
  if (pending.length === 0) return board;

  let next = board;
  for (const report of pending) {
    next = mergeReportIntoBoard(
      next,
      report,
      report.date,
      allDates.filter((d) => d <= report.date),
    );
  }

  // "Did it recur in this ingest?" is derived from the MERGED board, not from
  // re-hashing the raw bullets. Re-hashing only ever finds tier-1 matches, so an
  // item that recurred under reworded prose (tier 2) looked absent and a ticked
  // item would be archived for coming back — the exact opposite of the rule.
  // After merging, an item recurred iff its lastSeen is one of the dates just
  // folded in, which is true however it matched.
  const pendingDates = new Set(pending.map((r) => r.date));
  const recurred = new Set(next.items.filter((i) => pendingDates.has(i.lastSeen)).map((i) => i.id));

  // INVARIANT 3, per item: a ticked issue that stopped recurring is retired;
  // a ticked issue that came back is still true, so it stays and goes unread.
  // Unticked issues always compound — that is the whole point of the checkbox.
  const keep: BoardItem[] = [];
  const archived = [...next.archived];
  for (const item of next.items) {
    if (item.status === "open" && item.acknowledged === true && !recurred.has(item.id)) {
      archived.push(item);
      continue;
    }
    if (item.acknowledged === true && recurred.has(item.id)) item.acknowledged = false;
    keep.push(item);
  }
  const openLeft = keep.filter((i) => i.status === "open");
  const allAcked = openLeft.length > 0 && openLeft.every((i) => i.acknowledged === true);
  next = {
    ...next,
    items: keep,
    archived,
    readAt: allAcked ? (next.readAt ?? nowIso()) : null,
  };

  writeBoard(cfg, next);
  return next;
}

function mutateBoard(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  fn: (board: CronBoard) => void,
): CronBoard {
  const board = readBoard(cfg, jobId);
  fn(board);
  writeBoard(cfg, board);
  return board;
}

function requireItem(board: CronBoard, itemId: string): BoardItem {
  const item = board.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`unknown board item: ${itemId}`);
  return item;
}

/** true = "I've seen this page"; false = put it back in the unread pile. */
export function markRead(cfg: CronPanelResolvedConfig, jobId: string, read: boolean): CronBoard {
  return mutateBoard(cfg, jobId, (board) => {
    if (read) {
      board.readAt = nowIso();
      for (const item of board.items) {
        if (item.status === "open") item.acknowledged = true;
      }
      return;
    }
    board.readAt = null;
    for (const item of board.items) item.acknowledged = false;
  });
}

/** Per-issue read checkbox. This is what the card UI writes — not markRead. */
export function acknowledgeItem(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  itemId: string,
  acknowledged: boolean,
): CronBoard {
  return mutateBoard(cfg, jobId, (board) => {
    requireItem(board, itemId).acknowledged = acknowledged;
    const open = board.items.filter((i) => i.status === "open");
    board.readAt =
      open.length > 0 && open.every((i) => i.acknowledged === true)
        ? (board.readAt ?? nowIso())
        : null;
  });
}

/** The reason IS the feature — it is replayed to the cron agent by boardDigest. */
export function dismissItem(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  itemId: string,
  reason: string,
): CronBoard {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) {
    throw new Error("dismissing an item requires a reason — it is fed back to the cron agent");
  }
  return mutateBoard(cfg, jobId, (board) => {
    const item = requireItem(board, itemId);
    item.status = "dismissed";
    item.dismissedAt = nowIso();
    item.dismissReason = trimmed;
    item.recurrencesSinceDismissal = 0;
    item.acknowledged = false;
    delete item.resolvedAt;
  });
}

/** Undo a dismissal or a resolution; also pulls an item back out of `archived`. */
export function restoreItem(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  itemId: string,
): CronBoard {
  return mutateBoard(cfg, jobId, (board) => {
    let item = board.items.find((i) => i.id === itemId);
    if (!item) {
      const idx = board.archived.findIndex((i) => i.id === itemId);
      if (idx >= 0) {
        item = board.archived.splice(idx, 1)[0];
        board.items.push(item);
      }
    }
    if (!item) throw new Error(`unknown board item: ${itemId}`);
    item.status = "open";
    item.acknowledged = false;
    delete item.dismissedAt;
    delete item.dismissReason;
    delete item.recurrencesSinceDismissal;
    delete item.resolvedAt;
  });
}

/** Listed ids take positions 0..n-1; everything else keeps its relative order after them. */
export function reorderItems(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  itemIds: string[],
): CronBoard {
  return mutateBoard(cfg, jobId, (board) => {
    const wanted = new Map<string, number>();
    itemIds.forEach((id, index) => {
      if (!wanted.has(id)) wanted.set(id, index);
    });
    const listed = board.items
      .filter((i) => wanted.has(i.id))
      .sort((a, b) => (wanted.get(a.id) ?? 0) - (wanted.get(b.id) ?? 0));
    const rest = board.items.filter((i) => !wanted.has(i.id)).sort((a, b) => a.order - b.order);
    [...listed, ...rest].forEach((item, index) => {
      item.order = index;
    });
  });
}

export function pinItem(
  cfg: CronPanelResolvedConfig,
  jobId: string,
  itemId: string,
  pinned: boolean,
): CronBoard {
  return mutateBoard(cfg, jobId, (board) => {
    requireItem(board, itemId).pinned = pinned;
  });
}

export function summarizeBoard(board: CronBoard): CronBoardSummary {
  const open = board.items.filter((i) => i.status === "open");
  let oldestOpenDate: string | null = null;
  for (const item of open) {
    if (!oldestOpenDate || item.firstSeen < oldestOpenDate) oldestOpenDate = item.firstSeen;
  }
  return {
    jobId: board.jobId,
    unread: open.some((i) => i.acknowledged !== true),
    openCount: open.length,
    flagCount: open.filter((i) => i.kind === "ask" || i.kind === "act" || i.kind === "flag").length,
    ackedCount: open.filter((i) => i.acknowledged === true).length,
    oldestOpenDate,
    dismissedCount: board.items.filter((i) => i.status === "dismissed").length,
    lastIngestedDate: board.lastIngestedDate,
  };
}

/**
 * The channel BACK to the cron agent: a plain-text block it reads at the top of
 * its run so it stops re-raising matters the architect has already settled.
 *
 * READ-ONLY on purpose. It does NOT ingest: generating a digest must never
 * consume the unread page as a side effect. Call `ingestBoard` first.
 *
 * The open list is truncated to stay near DIGEST_MAX_CHARS; the DISMISSED list
 * never is, because that is the part the agent must obey.
 */
export function boardDigest(cfg: CronPanelResolvedConfig, jobId: string): string {
  const board = readBoard(cfg, jobId);
  const open = sortBoardItems(board.items.filter((i) => i.status === "open"));
  const dismissed = board.items.filter((i) => i.status === "dismissed");

  const header =
    `CRON BOARD — ${jobId} (carried over; last ingest: ${board.lastIngestedDate ?? "never"})\n` +
    "These items are ALREADY on the architect's card. Re-report a bullet only if it is still true,\n" +
    "and never re-explain an item that is merely still open.";

  const dismissedLines: string[] = [];
  if (dismissed.length > 0) {
    dismissedLines.push("");
    dismissedLines.push(
      `DISMISSED BY OSCAR — DO NOT RE-RAISE unless something materially new happened (${dismissed.length}):`,
    );
    for (const item of dismissed) {
      dismissedLines.push(`- ${clip(item.text, DIGEST_TEXT_CLIP)}`);
      dismissedLines.push(`  reason: ${item.dismissReason ?? "(none recorded)"}`);
      dismissedLines.push(`  recurred ${item.recurrencesSinceDismissal ?? 0}x since the dismissal`);
    }
  }
  const dismissedBlock = dismissedLines.join("\n");

  const openHeader = open.length > 0 ? `\n\nOPEN (${open.length}):` : "\n\nOPEN: none.";
  let budget = DIGEST_MAX_CHARS - header.length - openHeader.length - dismissedBlock.length - 64;
  const openLines: string[] = [];
  for (const item of open) {
    const age = `since ${item.firstSeen}, ${item.runs} run${item.runs === 1 ? "" : "s"}`;
    const line = `\n- [${item.kind.toUpperCase()}] ${age}${item.pinned ? ", pinned" : ""} — ${clip(item.text, DIGEST_TEXT_CLIP)}`;
    if (line.length > budget) break;
    budget -= line.length;
    openLines.push(line);
  }
  const hidden = open.length - openLines.length;
  const more =
    hidden > 0 ? `\n(+${hidden} more open item${hidden === 1 ? "" : "s"} not shown)` : "";

  return `${header}${openHeader}${openLines.join("")}${more}${dismissedBlock ? `\n${dismissedBlock}` : ""}`;
}
