#!/usr/bin/env -S node --import tsx
/**
 * Seed the safe structural cron habits bundled with this fork.
 *
 * This runs before the Gateway starts, so it uses the same cron store helpers
 * as the scheduler instead of the Gateway-backed cron CLI. Existing jobs are
 * matched by stable bundle id or display name and are never edited.
 *
 * Usage:
 *   node --import tsx scripts/seed-structural-crons.mjs
 *   node --import tsx scripts/seed-structural-crons.mjs --disabled
 *   node --import tsx scripts/seed-structural-crons.mjs --list|--dry-run [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCronJobCreate } from "../src/cron/normalize.ts";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "../src/cron/store.ts";
import { withFileLock } from "../src/infra/file-lock.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(REPO_ROOT, "extensions", "tinkerclaw-tinker-bridge", "crons");
const STORE_PATH = resolveCronStorePath();
const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 1.5,
    minTimeout: 25,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
};

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const LIST = has("--list");
const DRY = has("--dry-run");
const DISABLED = has("--disabled");
const LEGACY_ENABLE = has("--enable");
const JSON_OUT = has("--json");
const SUPPORTED_FLAGS = new Set(["--list", "--dry-run", "--disabled", "--enable", "--json"]);
const unknownFlags = argv.filter((arg) => !SUPPORTED_FLAGS.has(arg));

if (unknownFlags.length > 0) {
  console.error(`seed-structural-crons: unknown option(s): ${unknownFlags.join(", ")}`);
  process.exit(2);
}
if (DISABLED && LEGACY_ENABLE) {
  console.error("seed-structural-crons: --disabled and --enable cannot be used together");
  process.exit(2);
}

function readBundle() {
  if (!fs.existsSync(BUNDLE_DIR)) {
    return [];
  }
  return fs
    .readdirSync(BUNDLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(BUNDLE_DIR, entry.name, "job.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function buildMessage(job) {
  const bundled = path.join(BUNDLE_DIR, job.id, "routine.md");
  return [
    `[${job.name}] Read the FIRST of these files that exists, in full, and execute it exactly as written:`,
    `  1. ~/.openclaw/workspace/crons/${job.id}/routine.md   (your override, if you made one)`,
    `  2. ~/.openclaw/workspace/scripts/cron-${job.id}-prompt.txt   (legacy override location)`,
    `  3. ${bundled}   (the default that ships with the repo)`,
    "Do the work directly in this isolated cron turn; do NOT spawn another agent.",
    "Write the run report the routine requires before you finish — a partial report beats a silent night.",
    "Return only a short delta summary as your final response (max 8 lines).",
  ].join("\n");
}

function createPersistedJob(bundleJob, enabled, nowMs) {
  const normalized = normalizeCronJobCreate({
    name: bundleJob.name,
    description: bundleJob.description,
    enabled,
    schedule: bundleJob.schedule,
    sessionTarget: bundleJob.sessionTarget ?? "isolated",
    wakeMode: bundleJob.wakeMode ?? "now",
    payload: {
      kind: "agentTurn",
      message: buildMessage(bundleJob),
      thinking: bundleJob.payload?.thinking ?? "medium",
    },
    delivery: bundleJob.delivery ?? { mode: "none" },
  });
  if (!normalized) {
    throw new Error(`invalid bundled cron definition: ${String(bundleJob.id)}`);
  }
  return {
    ...normalized,
    id: bundleJob.id,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    state: {},
  };
}

function inspect(bundle, jobs) {
  const existingIds = new Set(jobs.map((job) => job?.id).filter(Boolean));
  const existingNames = new Set(jobs.map((job) => job?.name).filter(Boolean));
  const isInstalled = (job) => existingIds.has(job.id) || existingNames.has(job.name);
  return {
    isInstalled,
    missing: bundle.filter((job) => !isInstalled(job)),
  };
}

function printInventory(bundle, jobs, missing) {
  const missingIds = new Set(missing.map((job) => job.id));
  const rows = bundle.map((job) => ({
    id: job.id,
    name: job.name,
    schedule: job.schedule?.expr,
    installed: !missingIds.has(job.id),
  }));
  if (JSON_OUT) {
    console.log(
      JSON.stringify({ bundleDir: BUNDLE_DIR, storePath: STORE_PATH, jobs: rows }, null, 2),
    );
    return;
  }
  console.log(`Structural crons bundled with this repo (${bundle.length}):\n`);
  for (const row of rows) {
    console.log(
      `  ${row.installed ? "installed" : "MISSING  "}  ${row.id.padEnd(24)} ${row.schedule}`,
    );
  }
  if (DRY && missing.length > 0) {
    console.log(
      `\n--dry-run: would add ${missing.length} job(s) ${DISABLED ? "disabled" : "ENABLED"}.`,
    );
  }
  if (jobs.length > 0 && missing.length === 0) {
    console.log("\nAll bundled structural crons are already installed.");
  }
}

const bundle = readBundle();
if (bundle.length === 0) {
  console.error(`seed-structural-crons: no bundled crons found under ${BUNDLE_DIR}`);
  process.exit(1);
}

if (LIST || DRY) {
  const store = await loadCronStore(STORE_PATH);
  const { missing } = inspect(bundle, store.jobs);
  printInventory(bundle, store.jobs, missing);
  process.exit(0);
}

const enabled = !DISABLED;
const result = await withFileLock(STORE_PATH, STORE_LOCK_OPTIONS, async () => {
  const store = await loadCronStore(STORE_PATH);
  const { missing } = inspect(bundle, store.jobs);
  if (missing.length === 0) {
    return { added: [], skipped: bundle.map((job) => job.id) };
  }

  const nowMs = Date.now();
  store.jobs.push(...missing.map((job) => createPersistedJob(job, enabled, nowMs)));
  await saveCronStore(STORE_PATH, store);
  return {
    added: missing.map((job) => job.id),
    skipped: bundle.filter((job) => !missing.includes(job)).map((job) => job.id),
  };
});

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { storePath: STORE_PATH, added: result.added, skipped: result.skipped, enabled },
      null,
      2,
    ),
  );
} else if (result.added.length === 0) {
  console.log(`All ${bundle.length} structural crons are already installed. Nothing to do.`);
} else {
  console.log(
    `Added ${result.added.length} structural cron job(s), ${enabled ? "ENABLED" : "disabled"}:`,
  );
  for (const id of result.added) {
    console.log(`  - ${id}`);
  }
  if (enabled) {
    console.log(
      "\nThese safe maintenance jobs use your configured/default model and normal inference budget.",
    );
    console.log("They never deliver messages or take irreversible actions.");
    console.log("Opt out before first run: pnpm tinker:crons:disable");
  }
}
