#!/usr/bin/env node
/**
 * One-shot: fill `anatomy_events.duration_ms` for historical SUBAGENT rows.
 *
 * Why this exists
 * ---------------
 * `duration_ms` has been in the anatomy schema from the start, but nothing ever wrote it —
 * every row was NULL. The Tinker EEG restores a subagent branch as an INTERVAL and decides
 * parallelism by true temporal overlap, so a NULL duration collapsed each branch to a single
 * instant, and instants can never overlap: a 10-way fan-out repainted as ten sequential ticks.
 * The writer was fixed 2026-08-17 (src/fork/attempt-hooks.ts), but rows already on disk stay
 * flat forever unless their duration is recovered.
 *
 * The recovery is MEASURED, never invented. The gateway journal logs
 *   [plugins] [prefrontal] Agent spawned: <label> (agent:main:subagent:<uuid>)
 * at the moment a subagent starts, and the anatomy row for that same key is stamped when its
 * turn completes. duration = row.timestamp_ms - spawn_ts. Rows with no matching spawn line
 * (outside journal retention) are left NULL — an unknown duration must stay unknown.
 *
 * Usage:
 *   node scripts/backfill-anatomy-durations.mjs            # dry run, prints what it would do
 *   node scripts/backfill-anatomy-durations.mjs --apply    # writes (backs the DB up first)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.ANATOMY_DB ?? join(homedir(), ".openclaw/data/anatomy-timeline.db");
const APPLY = process.argv.includes("--apply");
/** A subagent turn longer than this is almost certainly a mis-pairing, not a real run. */
const MAX_PLAUSIBLE_MS = 6 * 60 * 60 * 1000;
const SPAWN_RE = /^(\S+) .*Agent spawned: (.+?) \((agent:[^)]+:subagent:[^)]+)\)/;

if (!existsSync(DB)) {
  console.error(`anatomy DB not found: ${DB}`);
  process.exit(1);
}

/** spawn timestamps from the gateway journal, oldest first, keyed by subagent session key */
function readSpawnsFromJournal() {
  const out = execFileSync(
    "journalctl",
    ["--user", "-u", "openclaw-gateway.service", "--no-pager", "-o", "short-iso-precise"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const spawns = new Map(); // sessionKey -> [{ ts, label }]
  for (const line of out.split("\n")) {
    if (!line.includes("Agent spawned:")) continue;
    // the systemd stamp is the first field; the node line repeats its own ISO stamp, but the
    // systemd one is always present and always parseable.
    const m = line.match(/^(\S+)\s+\S+\s+\S+:\s+(.*)$/);
    const body = m ? m[2] : line;
    const stampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.,+-]+)/);
    const inner = body.match(/Agent spawned: (.+?) \((agent:[^)]+:subagent:[^)]+)\)/);
    if (!stampMatch || !inner) continue;
    const ts = Date.parse(stampMatch[1].replace(",", "."));
    if (!Number.isFinite(ts)) continue;
    const [, label, key] = inner;
    const list = spawns.get(key) ?? [];
    list.push({ ts, label });
    spawns.set(key, list);
  }
  for (const list of spawns.values()) list.sort((a, b) => a.ts - b.ts);
  return spawns;
}

const spawns = readSpawnsFromJournal();
console.log(`journal: ${spawns.size} subagent spawn line(s) with a session key`);

const db = new DatabaseSync(DB, { readOnly: !APPLY });
const candidates = db
  .prepare(
    `SELECT id, session_key, timestamp_ms FROM anatomy_events
      WHERE duration_ms IS NULL AND session_key LIKE '%:subagent:%'
      ORDER BY timestamp_ms ASC`,
  )
  .all();
console.log(`anatomy: ${candidates.length} subagent row(s) with duration_ms NULL`);

const updates = [];
const usedSpawn = new Set();
for (const row of candidates) {
  const list = spawns.get(row.session_key);
  if (!list) continue;
  // earliest unconsumed spawn at or before this row: a multi-turn subagent gets its FIRST
  // turn measured from the spawn; later turns have no measurable start and stay NULL.
  const hit = list.find(
    (s) =>
      !usedSpawn.has(s) && s.ts <= row.timestamp_ms && row.timestamp_ms - s.ts <= MAX_PLAUSIBLE_MS,
  );
  if (!hit) continue;
  usedSpawn.add(hit);
  updates.push({
    id: row.id,
    ms: row.timestamp_ms - hit.ts,
    label: hit.label,
    key: row.session_key,
    end: row.timestamp_ms,
  });
}

console.log(`matched ${updates.length} row(s):`);
for (const u of updates.slice(-25)) {
  const mins = (u.ms / 60000).toFixed(1);
  console.log(`  ${new Date(u.end).toISOString()}  ${String(mins).padStart(6)} min  ${u.label}`);
}
if (updates.length > 25) console.log(`  … and ${updates.length - 25} earlier row(s)`);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write these durations.");
  process.exit(0);
}

copyFileSync(DB, `${DB}.bak-durations-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const stmt = db.prepare(
  "UPDATE anatomy_events SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL",
);
let written = 0;
for (const u of updates) written += stmt.run(u.ms, u.id).changes;
console.log(`\nwrote duration_ms on ${written} row(s); DB backed up alongside ${DB}`);
