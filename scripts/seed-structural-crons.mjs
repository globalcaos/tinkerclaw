#!/usr/bin/env node
/**
 * FORK 2026-09-08 — seed the STRUCTURAL crons that ship with this repo.
 *
 * The problem this fixes: the fork's whole self-maintaining character (nightly
 * memory consolidation, workspace hygiene, a security sweep, a model-rank
 * refresh, an ecosystem scan) lived entirely in one machine's private
 * `~/.openclaw/cron/jobs.json` plus routine files under a personal workspace.
 * None of it travelled with a `git clone`, so every cloner got the engine and
 * none of the habits — and had no way to know they were missing.
 *
 * The job definitions now ship in
 * `extensions/tinkerclaw-tinker-bridge/crons/<id>/{job.json,routine.md}`.
 * This script installs the ones that are missing.
 *
 * DEFAULT IS ON (2026-09-08, the maintainer's explicit call after the opposite was
 * argued and overruled). A fork whose self-maintenance ships switched off is a fork
 * whose best feature nobody ever meets: a cloner does not know the jobs exist, so
 * "off by default" is functionally "absent". Seeded jobs are created ENABLED and
 * `--disabled` is the opt-out.
 *
 * The spend is real and is named out loud rather than hidden behind a safe default:
 * each job wakes an agent on a schedule and costs model tokens on the operator's
 * account (the whole nightly cycle is roughly one euro). setup.sh states that cost
 * in the question, and any job can be switched off with `openclaw cron disable`.
 *
 * Idempotent: matches existing jobs by id OR name and never edits or overwrites one
 * it did not create. Safe to re-run after every `git pull` — that is how a
 * cloner picks up crons added upstream later.
 *
 * Usage:
 *   node scripts/seed-structural-crons.mjs [--list] [--dry-run] [--disabled] [--json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(REPO_ROOT, "extensions", "tinkerclaw-tinker-bridge", "crons");
const CLI = path.join(REPO_ROOT, "openclaw.mjs");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const LIST = has("--list");
const DRY = has("--dry-run");
const ENABLE = !has("--disabled"); // ON by default; --disabled is the opt-out
const JSON_OUT = has("--json");

function readBundle() {
  if (!fs.existsSync(BUNDLE_DIR)) return [];
  return fs
    .readdirSync(BUNDLE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(BUNDLE_DIR, e.name, "job.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The message the cron agent receives. It does NOT inline the routine: it names
 * the resolution order, so an operator who has customised a routine keeps their
 * version across `git pull`, exactly like SOUL.md / BRIEFING.md overrides.
 */
function buildMessage(job) {
  const bundled = path.join(BUNDLE_DIR, job.id, "routine.md");
  return [
    `[${job.name}] Read the FIRST of these files that exists, in full, and execute it exactly as written:`,
    `  1. ~/.openclaw/workspace/crons/${job.id}/routine.md   (your override, if you made one)`,
    `  2. ~/.openclaw/workspace/scripts/cron-${job.id}-prompt.txt   (legacy override location)`,
    `  3. ${bundled}   (the default that ships with the repo)`,
    `Do the work directly in this isolated cron turn; do NOT spawn another agent.`,
    `Write the run report the routine requires before you finish — a partial report beats a silent night.`,
    `Return only a short delta summary as your final response (max 8 lines).`,
  ].join("\n");
}

// `cron list` hides DISABLED jobs unless `--all` is passed. Without it the
// seeder re-adds every job the operator has deliberately turned off, so a
// second `setup.sh` run silently fills their store with duplicates of the
// jobs they least wanted running. Found 2026-09-08 by seeding a throwaway job
// and watching the idempotent re-run try to add it again.
function listExisting() {
  try {
    const out = execFileSync("node", [CLI, "cron", "list", "--all", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const start = out.indexOf("[");
    const startObj = out.indexOf("{");
    const idx = start === -1 ? startObj : startObj === -1 ? start : Math.min(start, startObj);
    if (idx === -1) return { ok: true, jobs: [] };
    const parsed = JSON.parse(out.slice(idx));
    const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
    return { ok: true, jobs: Array.isArray(jobs) ? jobs : Object.values(jobs) };
  } catch (err) {
    return { ok: false, error: err?.stderr?.toString?.() || String(err) };
  }
}

const bundle = readBundle();
if (bundle.length === 0) {
  console.error(`seed-structural-crons: no bundled crons found under ${BUNDLE_DIR}`);
  process.exit(1);
}

const existing = listExisting();
if (!existing.ok) {
  console.error("seed-structural-crons: could not reach the gateway to list cron jobs.");
  console.error("The cron CLI talks to a running gateway, so start it first, then re-run:");
  console.error("  openclaw gateway start && pnpm tinker:crons");
  console.error(`\n(underlying error: ${String(existing.error).trim().split("\n")[0]})`);
  process.exit(2);
}

// Match on BOTH id and name. Name alone is not enough: a bundled job whose
// display name is later reworded would re-seed as a duplicate on a machine that
// already runs it. Id alone is not enough either, because `cron add` assigns a
// uuid, so jobs this script created carry no stable id to match on.
const existingIds = new Set(existing.jobs.map((j) => j?.id).filter(Boolean));
const existingNames = new Set(existing.jobs.map((j) => j?.name).filter(Boolean));
const isInstalled = (j) => existingIds.has(j.id) || existingNames.has(j.name);
const missing = bundle.filter((j) => !isInstalled(j));

if (LIST || DRY) {
  const rows = bundle.map((j) => ({
    id: j.id,
    name: j.name,
    schedule: j.schedule?.expr,
    installed: isInstalled(j),
  }));
  if (JSON_OUT) {
    console.log(JSON.stringify({ bundleDir: BUNDLE_DIR, jobs: rows }, null, 2));
  } else {
    console.log(`Structural crons bundled with this repo (${bundle.length}):\n`);
    for (const r of rows) {
      console.log(`  ${r.installed ? "installed" : "MISSING  "}  ${r.id.padEnd(24)} ${r.schedule}`);
    }
    if (DRY && missing.length > 0) {
      console.log(
        `\n--dry-run: would add ${missing.length} job(s) ${ENABLE ? "ENABLED" : "disabled"}.`,
      );
    }
  }
  process.exit(0);
}

if (missing.length === 0) {
  console.log(`All ${bundle.length} structural crons are already installed. Nothing to do.`);
  process.exit(0);
}

const added = [];
const failed = [];
for (const job of missing) {
  const args = [
    CLI,
    "cron",
    "add",
    "--name",
    job.name,
    "--description",
    job.description ?? "",
    "--cron",
    job.schedule.expr,
    "--session",
    job.sessionTarget ?? "isolated",
    "--message",
    buildMessage(job),
    "--thinking",
    job.payload?.thinking ?? "medium",
    "--no-deliver",
  ];
  const model = job.payload?.fallbacks?.[0];
  if (model) args.push("--model", model);
  if (!ENABLE) args.push("--disabled");
  try {
    execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    added.push(job.id);
  } catch (err) {
    failed.push({
      id: job.id,
      error: String(err?.stderr || err)
        .trim()
        .split("\n")
        .slice(-2)
        .join(" "),
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ added, failed, enabled: ENABLE }, null, 2));
} else {
  if (added.length > 0) {
    console.log(
      `Added ${added.length} structural cron job(s), ${ENABLE ? "ENABLED" : "disabled"}:`,
    );
    for (const id of added) console.log(`  - ${id}`);
  }
  if (added.length > 0 && ENABLE) {
    console.log(`\nThey are ON and will run on schedule. Each one wakes an agent and spends`);
    console.log(`model tokens on your account — the whole nightly cycle is roughly one euro.`);
    console.log(`Read what a job does:  less ${path.join(BUNDLE_DIR, added[0], "routine.md")}`);
    console.log(
      `Switch one off:        openclaw cron disable "<id from 'openclaw cron list --all'>"`,
    );
    console.log(`Install them off:      node scripts/seed-structural-crons.mjs --disabled`);
  }
  if (added.length > 0 && !ENABLE) {
    console.log(`\nThey are installed but OFF, as requested with --disabled.`);
    console.log(`Turn one on: openclaw cron enable "<id from 'openclaw cron list --all'>"`);
  }
  for (const f of failed) console.error(`  FAILED ${f.id}: ${f.error}`);
}
process.exit(failed.length > 0 ? 1 : 0);
