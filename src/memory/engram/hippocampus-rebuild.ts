/**
 * HIPPOCAMPUS Nightly Rebuild — Phase 2
 *
 * Provides `scheduleNightlyRebuild()` — a function safe to call from cron
 * (or any automation) that re-builds the HIPPOCAMPUS concept index.
 *
 * Two-phase approach:
 *   Phase 1 — Reflect: scan anchors for stale files (deleted / moved).
 *   Phase 2 — Re-index: incorporate new/changed files, apply importance
 *              scoring and deduplication via hippocampus-enhancement.
 *
 * Idempotent: skips files whose mtime has not changed since the last run
 * (tracked in a lightweight state file next to the index).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, extname } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  enhanceIndex,
  type HippocampusIndex,
  type IndexChunk,
  type EnhanceOptions,
} from "./hippocampus-enhancement.js";
import type { MemoryEvent } from "./event-types.js";

const log = createSubsystemLogger("hippocampus-rebuild");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RebuildOptions extends EnhanceOptions {
  /** Extensions to scan in workspaceDir. Default: [".md", ".ts", ".txt"]. */
  extensions?: string[];
  /** Max files to process per rebuild (safety cap). Default: 500. */
  maxFiles?: number;
  /** Path for the mtime state file. Default: indexPath + ".mtimes.json". */
  statePath?: string;
}

interface MtimeState {
  /** ISO timestamp of the last completed rebuild. */
  lastRun: string;
  /** Map of filePath → last-seen mtime (epoch ms). */
  files: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadState(statePath: string): MtimeState {
  if (!existsSync(statePath)) {
    return { lastRun: "", files: {} };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as MtimeState;
  } catch {
    return { lastRun: "", files: {} };
  }
}

function saveState(statePath: string, state: MtimeState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Collect all matching files under `dir` (non-recursive depth-first, capped). */
function collectFiles(
  dir: string,
  extensions: Set<string>,
  maxFiles: number,
): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    if (results.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = join(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          if (!entry.startsWith(".") && entry !== "node_modules") {
            walk(full);
          }
        } else if (extensions.has(extname(entry).toLowerCase())) {
          results.push(full);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }

  if (existsSync(dir)) walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Phase 1: Reflect — prune stale anchors
// ---------------------------------------------------------------------------

function reflectPhase(index: HippocampusIndex): {
  index: HippocampusIndex;
  pruned: number;
} {
  let pruned = 0;
  const clean: HippocampusIndex = {};

  for (const [anchor, chunks] of Object.entries(index)) {
    const live = chunks.filter((c) => {
      if (!c.path) return false;
      // Keep workspace-relative paths that still exist (best-effort)
      // Absolute paths are checked directly; relative paths skip check.
      if (c.path.startsWith("/") && !existsSync(c.path)) {
        pruned++;
        return false;
      }
      return true;
    });

    if (live.length > 0) {
      clean[anchor] = live;
    }
    // Anchors with zero live chunks are silently dropped (counted as pruned).
    if (live.length === 0 && chunks.length > 0) {
      pruned += chunks.length;
    }
  }

  return { index: clean, pruned };
}

// ---------------------------------------------------------------------------
// Phase 2: Re-index — detect changed files and inject new anchors
// ---------------------------------------------------------------------------

function buildAnchorFromFile(filePath: string): string {
  // Derive a simple anchor from the file name (without extension, lower-cased).
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.[^.]+$/, "").toLowerCase().replace(/[-_]/g, " ");
}

function previewFromContent(content: string): string {
  return content.slice(0, 120).replace(/\s+/g, " ").trim();
}

function reindexPhase(
  index: HippocampusIndex,
  changedFiles: string[],
  workspaceDir: string,
): HippocampusIndex {
  const updated = { ...index };

  for (const filePath of changedFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const anchor = buildAnchorFromFile(filePath);
    // Use relative path when possible for portability.
    const relPath = filePath.startsWith(workspaceDir)
      ? filePath.slice(workspaceDir.length).replace(/^\//, "")
      : filePath;

    const chunk = {
      path: relPath,
      line: 1,
      score: 0.5, // base score; importance weighting applied by enhanceIndex
      source: "workspace",
      preview: previewFromContent(content),
    };

    const existing = updated[anchor] ?? [];
    const alreadyIndexed = existing.findIndex((c) => c.path === relPath);

    if (alreadyIndexed >= 0) {
      // Replace stale chunk
      existing[alreadyIndexed] = chunk;
      updated[anchor] = existing;
    } else {
      updated[anchor] = [...existing, chunk];
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a two-phase nightly rebuild of the HIPPOCAMPUS index.
 *
 * Safe to call repeatedly — only re-indexes files whose mtime has changed
 * since the last successful run.
 *
 * @param indexPath    Path to hippocampus-index.json.
 * @param workspaceDir Root directory to scan for new/changed files.
 * @param options      Optional tuning knobs.
 */
export async function scheduleNightlyRebuild(
  indexPath: string,
  workspaceDir: string,
  options: RebuildOptions = {},
): Promise<{ pruned: number; reindexed: number; anchors: number }> {
  const exts = new Set(options.extensions ?? [".md", ".ts", ".txt"]);
  const maxFiles = options.maxFiles ?? 500;
  const statePath = options.statePath ?? indexPath.replace(/\.json$/, ".mtimes.json");

  log.info(`HIPPOCAMPUS rebuild start — index: ${indexPath}`);

  // Load existing index
  let index: HippocampusIndex = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf-8")) as HippocampusIndex;
    } catch {
      log.warn("Could not parse existing index; starting fresh.");
    }
  }

  // Load mtime state
  const state = loadState(statePath);

  // ── Phase 1: Reflect ──────────────────────────────────────────────────────
  const { index: reflected, pruned } = reflectPhase(index);
  log.debug(`Reflect phase: ${pruned} stale chunks removed.`);

  // ── Phase 2: Re-index ─────────────────────────────────────────────────────
  const allFiles = collectFiles(workspaceDir, exts, maxFiles);

  // Detect changed files (mtime differs from stored state)
  const changedFiles = allFiles.filter((fp) => {
    try {
      const mtime = statSync(fp).mtimeMs;
      return mtime !== state.files[fp];
    } catch {
      return false;
    }
  });

  const reindexed = changedFiles.length;
  log.debug(`Re-index phase: ${reindexed} changed files.`);

  let finalIndex = reindexPhase(reflected, changedFiles, workspaceDir);

  // Write intermediate index so enhanceIndex can read it
  writeFileSync(indexPath, JSON.stringify(finalIndex, null, 2));

  // ── Enhancement pass (importance + dedup) ─────────────────────────────────
  finalIndex = enhanceIndex(indexPath, {
    defaultImportance: options.defaultImportance,
    mergeThreshold: options.mergeThreshold,
    relatedThreshold: options.relatedThreshold,
  });

  // ── Persist mtime state ───────────────────────────────────────────────────
  const newFiles: Record<string, number> = { ...state.files };
  for (const fp of changedFiles) {
    try {
      newFiles[fp] = statSync(fp).mtimeMs;
    } catch {
      /* ignore */
    }
  }

  saveState(statePath, { lastRun: new Date().toISOString(), files: newFiles });

  const anchors = Object.keys(finalIndex).length;
  log.info(
    `HIPPOCAMPUS rebuild complete — pruned=${pruned} reindexed=${reindexed} anchors=${anchors}`,
  );

  return { pruned, reindexed, anchors };
}

// ---------------------------------------------------------------------------
// runHippocampusRebuild — ENGRAM event-driven nightly rebuild (Phase 2.4)
// ---------------------------------------------------------------------------

export interface RebuildFromEventsConfig {
  /** Path to hippocampus-index.json. */
  indexPath: string;
  /**
   * ENGRAM events to ingest.  Accepts either:
   *   - A direct array of MemoryEvent objects (useful in tests / embedding)
   *   - A path to a JSONL events file  (one JSON object per line)
   */
  events?: MemoryEvent[];
  eventsFilePath?: string;
  /**
   * How far back to scan for events (ms).  Default: 24 h.
   * Pass a different value in tests to control what's "recent".
   */
  maxAgeMs?: number;
  /** Enhancement options forwarded to enhanceIndex(). */
  enhanceOptions?: EnhanceOptions;
}

/** Stopwords excluded from anchor extraction. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "has", "had", "its", "not", "but",
  "with", "from", "this", "that", "have", "will", "been", "they", "them",
  "were", "our", "can", "you", "she", "his", "her", "him", "who",
]);

/**
 * Extract concept anchor tokens from free-form text.
 *
 * Strategy: tokenise, remove stopwords and short words, take the top-N most
 * frequent terms as the anchor label (joined with spaces).
 */
function extractAnchor(text: string, maxTerms = 3): string {
  const freq = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/\W+/)) {
    const w = raw.trim();
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  if (freq.size === 0) return "general";
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([w]) => w)
    .join(" ");
}

/** Load events from a JSONL file, one JSON object per line. */
function loadEventsFromFile(filePath: string): MemoryEvent[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MemoryEvent);
  } catch {
    return [];
  }
}

/** Convert a MemoryEvent into an IndexChunk for hippocampus storage. */
function eventToChunk(event: MemoryEvent): IndexChunk {
  return {
    path: `engram://events/${event.id}`,
    line: 1,
    // Base score from metadata importance (default 5 → 0.5 in [0,1] space)
    score: (event.metadata.importance ?? 5) / 10,
    source: "engram",
    preview: event.content.slice(0, 120).replace(/\s+/g, " ").trim(),
    importance: event.metadata.importance ?? 5,
    timestamp: event.timestamp,
  };
}

/**
 * Event-driven rebuild of the HIPPOCAMPUS concept index.
 *
 * Scans recent ENGRAM events (past `maxAgeMs`, default 24 h), extracts concept
 * anchors and links, merges them into hippocampus-index.json, then applies
 * importance scoring and deduplication via `enhanceIndex`.
 *
 * Safe to call from a cron job or heartbeat — idempotent when events haven't
 * changed (events are keyed by their ENGRAM id path).
 *
 * @returns `{ anchors, indexed }` — total anchors after rebuild and number
 *          of new chunks ingested.
 */
export async function runHippocampusRebuild(
  config: RebuildFromEventsConfig,
): Promise<{ anchors: number; indexed: number }> {
  const {
    indexPath,
    maxAgeMs = 24 * 60 * 60 * 1000,
    enhanceOptions,
  } = config;

  log.info(`HIPPOCAMPUS event-rebuild start — index: ${indexPath}`);

  // ── Resolve event source ──────────────────────────────────────────────────
  let allEvents: MemoryEvent[] = config.events ?? [];
  if (allEvents.length === 0 && config.eventsFilePath) {
    allEvents = loadEventsFromFile(config.eventsFilePath);
  }

  // Filter to the requested time window.
  const cutoff = Date.now() - maxAgeMs;
  const recentEvents = allEvents.filter(
    (e) => new Date(e.timestamp).getTime() >= cutoff,
  );

  log.debug(
    `Event rebuild: ${recentEvents.length} events within last ${Math.round(maxAgeMs / 3_600_000)}h`,
  );

  // ── Load existing index ───────────────────────────────────────────────────
  let index: HippocampusIndex = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf-8")) as HippocampusIndex;
    } catch {
      log.warn("Could not parse existing index; starting fresh.");
    }
  }

  // ── Ingest events → concept anchors ──────────────────────────────────────
  let indexed = 0;
  for (const event of recentEvents) {
    const anchor = extractAnchor(event.content);
    const chunk = eventToChunk(event);

    const existing = index[anchor] ?? [];
    // Dedup by the engram event path (id-based)
    if (!existing.some((c) => c.path === chunk.path)) {
      index[anchor] = [...existing, chunk];
      indexed++;
    }
  }

  log.debug(`Event rebuild: ${indexed} new chunks ingested across anchors.`);

  // ── Write intermediate index and apply enhancement pass ───────────────────
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  const enhanced = enhanceIndex(indexPath, enhanceOptions);

  const anchors = Object.keys(enhanced).length;
  log.info(
    `HIPPOCAMPUS event-rebuild complete — indexed=${indexed} anchors=${anchors}`,
  );

  return { anchors, indexed };
}
