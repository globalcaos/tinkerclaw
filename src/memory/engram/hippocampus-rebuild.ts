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
  type EnhanceOptions,
} from "./hippocampus-enhancement.js";

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
