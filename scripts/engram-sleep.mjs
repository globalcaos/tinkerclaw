#!/usr/bin/env node
/**
 * ENGRAM Sleep Consolidation runner — step 1 of the nightly memory-consolidation
 * cron (`cd ~/src/tinkerclaw && node scripts/engram-sleep.mjs`, no args).
 *
 * Uses jiti to load TypeScript source directly (same approach as the main CLI).
 *
 * Usage:
 *   node scripts/engram-sleep.mjs [--base-dir <dir>] [--session-key <key>] [--dry-run]
 *
 * ── THE BUG THIS REPLACED: 83 consecutive silent nights ──────────────────────────────
 * The old version defaulted `--session-key` to the literal string "live" and built a
 * single event store from it. <base-dir>/events/live.jsonl has NEVER existed:
 * createEventStore mkdir's the parent but never creates the file, readAll() on a missing
 * file returns [], so runSleepConsolidation truthfully reported "0 episodes / 0 events /
 * 0 summaries" and exited 0 — indistinguishable from a healthy quiet night, for 83 nights,
 * while 575 real stores sat unconsolidated.
 *
 * So the contract here is: NOTHING-TO-DO MUST NOT LOOK LIKE SUCCESS.
 *   exit 1  ENGRAM exists but is unusable — no events/ dir, zero *.jsonl stores, an
 *           explicit --session-key with no store on disk, every store empty, or every
 *           selected store failed to read.
 *   exit 0  status "not-configured" — no ENGRAM base dir at all. A fresh clone of the
 *           public fork that never enabled ENGRAM must not red-alarm a cron every night.
 *   exit 0  a real pass. The report always carries storesAvailable / sessionsProcessed /
 *           eventsProcessed, so a genuine quiet night (stores present, no NEW events) is
 *           legible as such and can never again be confused with a dead code path.
 *
 * ── ONE CURSOR PER STORE, NOT ONE CURSOR TOTAL ───────────────────────────────────────
 * runSleepConsolidation takes ONE store and ONE ConsolidationState whose
 * `lastConsolidatedEventId` is a cursor into THAT store's stream. So this script loops the
 * discovered stores and keeps a cursor per store, persisted in consolidation-state.json as
 * Record<sessionKey, ConsolidationState> — the SAME file and SAME schema that
 * src/cron/jobs/engram-consolidate.ts (loadConsolidationState) and
 * src/memory/engram/consolidate-cli.ts already read and write.
 *
 * Do NOT "simplify" this into one merged, timestamp-sorted stream with a single cursor.
 * That was tried and rejected: the shared cursor is a position in TIME, so every event
 * older than it in any other store becomes permanently unreachable (measured on the live
 * store: 7,471 of 14,940 events across 373 of 575 stores), and merging concurrently-written
 * sessions destroys episode detection — `isBoundary` splits on a >30min gap between
 * CONSECUTIVE events, and in a merged stream some session is always active. Measured on the
 * same events: 160 merged episodes vs 459 per-store, with 56% of the merged ones fusing
 * multiple sessions into one summary. Artifacts are never deleted, so that corruption is
 * permanent. Per-store cursors have neither problem.
 *
 * ── SCOPE LIMIT (deliberate) ─────────────────────────────────────────────────────────
 * This runner imports only the four leaf ENGRAM modules. It does NOT wire the opt-in
 * lanes (U1 recipe-evolution, U4 strategy-switch, U6 skill-extraction, U8 reconciliation);
 * `runEngramConsolidate` in src/cron/jobs/engram-consolidate.ts does. That function cannot
 * be called from here: it awaits `resolveSkillEmbedFn()`, which dynamically imports
 * config/io, agent-scope and gateway/embeddings-http — booting the whole plugin runtime,
 * writing to ~/.openclaw at import time, and leaving file watchers open so the process
 * NEVER EXITS (verified: a delegated run had to be killed). The lane-wired path belongs
 * in-process behind the `fork.engram.consolidate.run` RPC, where that runtime is already
 * up. Until the cron is pointed at that RPC, this script does the safe subset — the same
 * subset the old script did, minus the bug.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

const USAGE = `ENGRAM sleep consolidation runner

Usage: node scripts/engram-sleep.mjs [options]

Options:
  --base-dir <dir>     ENGRAM base directory (default: $HOME/.openclaw/engram)
  --session-key <key>  Consolidate ONLY the store <base-dir>/events/<key>.jsonl.
                       Omit to consolidate every discovered store (the nightly default).
  --dry-run            Report each store's event count and cursor, then exit without
                       consolidating, writing artifacts, or moving any cursor.
  -h, --help           Show this help.

Cursors are kept per store in <base-dir>/consolidation-state.json as
Record<sessionKey, ConsolidationState> — the same file and schema the in-repo
engram-consolidate job and consolidate-cli read.

Exits non-zero, loudly, whenever ENGRAM exists but there is nothing usable to read: no
events/ directory, zero *.jsonl stores, a --session-key with no store on disk, or every
store empty/unreadable. A run that finds nothing must never again look like a quiet night.
`;

function fail(msg) {
  console.error(`[engram-sleep] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing. STRICT on flag NAMES as well as values: an unrecognised or
// misspelled flag used to fall through to the full nightly default, so `--dryrun`
// silently performed a real run and `--session-key=foo` silently consolidated
// every store. Every argv entry must now be understood.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const VALUE_FLAGS = new Set(["--base-dir", "--session-key"]);
const SWITCHES = new Set(["--dry-run"]);
const opts = new Map();

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (SWITCHES.has(arg)) {
    opts.set(arg, true);
    continue;
  }
  if (VALUE_FLAGS.has(arg)) {
    if (opts.has(arg)) {
      fail(`${arg} given more than once`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      fail(`${arg} requires a value`);
    }
    if (value.length === 0) {
      fail(`${arg} must not be empty`);
    }
    opts.set(arg, value);
    i++;
    continue;
  }
  // Includes the --flag=value form, which this parser deliberately REJECTS rather
  // than silently ignore (silently ignoring it selected the full nightly run).
  fail(`unrecognised argument ${JSON.stringify(arg)}\n\n${USAGE}`);
}

const dryRun = opts.get("--dry-run") === true;
const baseDir = opts.get("--base-dir") ?? join(process.env.HOME ?? "~", ".openclaw", "engram");
const sessionKey = opts.get("--session-key") ?? null;

// The key is matched against readdirSync results so it can never contain a separator;
// reject one anyway so a typo'd path is never read as a store name.
if (sessionKey !== null && /[/\\]/.test(sessionKey)) {
  fail(`--session-key must be a bare store name, got ${JSON.stringify(sessionKey)}`);
}

// ---------------------------------------------------------------------------
// Resolve what exists on disk. "ENGRAM was never set up" and "ENGRAM is broken"
// are different states and must not share an exit code. All of this runs BEFORE
// the TypeScript loader, so every loud path is fast and needs no deps installed.
// ---------------------------------------------------------------------------
if (!existsSync(baseDir)) {
  console.error(
    `[engram-sleep] no ENGRAM base directory at ${baseDir} — ENGRAM is not configured on ` +
      `this host, so there is nothing to consolidate (this is not a failure).`,
  );
  console.log(JSON.stringify({ status: "not-configured", baseDir }, null, 2));
  process.exit(0);
}

const eventsDir = join(baseDir, "events");
if (!existsSync(eventsDir)) {
  fail(
    `ENGRAM base dir ${baseDir} exists but has no events/ directory.\n` +
      `  Expected ${eventsDir}. ENGRAM is configured but its event stores are missing.`,
  );
}

const stores = readdirSync(eventsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => f.slice(0, -".jsonl".length))
  .sort();

if (stores.length === 0) {
  fail(
    `no *.jsonl stores under ${eventsDir} — nothing to consolidate.\n` +
      `  This is NOT a quiet night: ENGRAM has no event stores at all.`,
  );
}

if (sessionKey !== null && !stores.includes(sessionKey)) {
  const shown = stores
    .slice(0, 10)
    .map((k) => `    ${k}.jsonl`)
    .join("\n");
  fail(
    `--session-key ${JSON.stringify(sessionKey)} has no store on disk.\n` +
      `  looked for: ${join(eventsDir, `${sessionKey}.jsonl`)}\n` +
      `  ${stores.length} store(s) DO exist:\n${shown}` +
      (stores.length > 10 ? `\n    … and ${stores.length - 10} more` : ""),
  );
}

const selected = sessionKey === null ? stores : [sessionKey];

// ---------------------------------------------------------------------------
// TypeScript loader. ONLY the four leaf ENGRAM modules — see the SCOPE LIMIT note
// in the header before adding an import here; engram-consolidate.ts drags in the
// plugin runtime and never exits.
// ---------------------------------------------------------------------------
let jiti;
try {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  jiti = createJiti(import.meta.url, { interopDefault: true });
} catch (err) {
  console.error("[engram-sleep] jiti not available — install deps first: pnpm install\n", err);
  process.exit(1);
}

const { createEventStore } = jiti(join(repoRoot, "src/memory/engram/event-store.ts"));
const { createArtifactStore } = jiti(join(repoRoot, "src/memory/engram/artifact-store.ts"));
const { createInitialConsolidationState } = jiti(
  join(repoRoot, "src/memory/engram/episode-detection.ts"),
);
const { runSleepConsolidation } = jiti(join(repoRoot, "src/memory/engram/sleep-consolidation.ts"));

// ---------------------------------------------------------------------------
// Per-store cursors: Record<sessionKey, ConsolidationState>.
// ---------------------------------------------------------------------------
const stateFile = join(baseDir, "consolidation-state.json");
let allState = {};
if (existsSync(stateFile)) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      allState = parsed;
    } else {
      console.error(
        `[engram-sleep] WARNING: ${stateFile} is valid JSON but not an object — ` +
          `every session starts from a fresh cursor.`,
      );
    }
  } catch (err) {
    console.error(
      `[engram-sleep] WARNING: ${stateFile} is unparseable — every session starts from a ` +
        `fresh cursor. Underlying error:`,
      err,
    );
  }
}

// The pre-fix script wrote a BARE ConsolidationState here instead of a Record. Those three
// top-level keys are not session cursors, and left in place they masquerade as sessions.
// Drop them — but only once we have PROVEN no store is actually named after them.
const LEGACY_STATE_KEYS = ["lastConsolidatedEventId", "lastConsolidatedAt", "episodeCount"];
const legacyKeys = LEGACY_STATE_KEYS.filter((k) => k in allState && !stores.includes(k));
if (legacyKeys.length > 0) {
  console.error(
    `[engram-sleep] WARNING: ${stateFile} carried top-level ${legacyKeys.join(", ")} from the ` +
      `pre-fix single-cursor script; dropping them (they are not session cursors).`,
  );
  for (const k of legacyKeys) {
    delete allState[k];
  }
}

// ---------------------------------------------------------------------------
// Consolidate, one store at a time, each against its own cursor.
// ---------------------------------------------------------------------------
const MAX_REPORTED_EPISODES = 25;

let sessionsProcessed = 0;
let sessionsEmpty = 0;
let episodes = 0;
let eventsProcessed = 0;
const reportedEpisodes = [];
const storeFailures = [];
const dryRunPlan = [];

const artifactStore = dryRun ? null : createArtifactStore({ baseDir });

for (const key of selected) {
  try {
    const store = createEventStore({ baseDir, sessionKey: key });
    const eventCount = store.count();
    if (eventCount === 0) {
      sessionsEmpty++;
      continue;
    }

    const sessionState = allState[key] ?? createInitialConsolidationState();

    if (dryRun) {
      dryRunPlan.push({
        sessionKey: key,
        events: eventCount,
        lastConsolidatedEventId: sessionState.lastConsolidatedEventId ?? null,
      });
      sessionsProcessed++;
      continue;
    }

    const result = await runSleepConsolidation(store, artifactStore, sessionState);
    allState[key] = sessionState;
    sessionsProcessed++;
    episodes += result.newEpisodes.length;
    eventsProcessed += result.eventsProcessed;
    for (const ep of result.newEpisodes) {
      if (reportedEpisodes.length < MAX_REPORTED_EPISODES) {
        reportedEpisodes.push({
          sessionKey: key,
          id: ep.id,
          topic: ep.topic,
          turnCount: ep.turnCount,
          outcome: ep.outcome,
        });
      }
    }
  } catch (err) {
    // One corrupt store (createEventStore JSON.parses every line) must not throw away
    // every other store's consolidation — but it must be reported, not swallowed.
    storeFailures.push({
      sessionKey: key,
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`[engram-sleep] store ${key} failed:`, err);
  }
}

if (!dryRun) {
  // Atomic cursor write — a crash mid-write must not leave an unparseable cursor file.
  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(allState, null, 2), "utf-8");
  renameSync(tmpFile, stateFile);
}

const report = {
  ...(dryRun ? { dryRun: true, plan: dryRunPlan } : {}),
  baseDir,
  eventsDir,
  stateFile,
  sessionKey,
  storesAvailable: stores.length,
  storesSelected: selected.length,
  sessionsProcessed,
  sessionsEmpty,
  sessionsFailed: storeFailures.length,
  ...(storeFailures.length > 0 ? { storeFailures } : {}),
  ...(dryRun
    ? {}
    : {
        episodes,
        eventsProcessed,
        newEpisodes: reportedEpisodes,
        ...(episodes > reportedEpisodes.length
          ? { newEpisodesOmitted: episodes - reportedEpisodes.length }
          : {}),
      }),
};

// Consolidating NONE of the stores we just proved exist is the exact silhouette of the
// 83-night bug. Never report it as a successful quiet night.
if (sessionsProcessed === 0) {
  console.error(JSON.stringify(report, null, 2));
  fail(
    `consolidated 0 of ${selected.length} selected store(s) — ` +
      `${sessionsEmpty} empty, ${storeFailures.length} unreadable.\n` +
      `  This is NOT a quiet night: ENGRAM has stores but nothing usable in them.`,
  );
}

console.log(JSON.stringify(report, null, 2));
