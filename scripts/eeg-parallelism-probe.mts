/**
 * Probe (not a unit test): render the REAL anatomy rows of the NeuroCoin tab through the real
 * EEG renderer and measure whether the 2026-08-16 ten-way research fan-out now paints as
 * parallel. Reasoning about the geometry is what got this wrong before — measure the emitted
 * strokes instead (same method as the 2026-06-25 "white threads" hunt).
 *
 *   pnpm exec tsx scripts/eeg-parallelism-probe.mts
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { EegTraceStore, type EegSample } from "../tinker-ui/src/panels/eeg-trace.js";

const SK = process.argv.find((a) => a.startsWith("agent:")) ?? "agent:main:tinker:msricppx";
// --flat reproduces the PRE-FIX state: every branch a zero-length instant.
const FLAT = process.argv.includes("--flat");
const db = new DatabaseSync(join(homedir(), ".openclaw/data/anatomy-timeline.db"), {
  readOnly: true,
});

// querySessionTree(): the viewed session + every subagent under its agent root.
const root = SK.split(":").slice(0, 2).join(":");
const rows = db
  .prepare(
    `SELECT * FROM (
       SELECT session_key, run_id, timestamp_ms, duration_ms, model, provider, turn
         FROM anatomy_events WHERE session_key = ? OR session_key LIKE ?
        ORDER BY timestamp_ms DESC LIMIT 500
     ) ORDER BY timestamp_ms ASC`,
  )
  .all(SK, `${root}:subagent:%`) as Array<Record<string, any>>;

// …mapped exactly as app.ts's EEG backfill maps it.
const isSub = (r: any) => String(r.session_key).includes(":subagent:");
const mainTs = rows.filter((r) => !isSub(r)).map((r) => Number(r.timestamp_ms));
const minMainTs = mainTs.length ? Math.min(...mainTs) : 0;
const maxMainTs = mainTs.length ? Math.max(...mainTs) + 3600_000 : Infinity;

const samples: EegSample[] = [];
for (const r of rows) {
  const ts = Number(r.timestamp_ms);
  const sub = isSub(r);
  if (sub && (ts < minMainTs || ts > maxMainTs)) continue;
  const dur = FLAT ? 0 : typeof r.duration_ms === "number" ? Math.max(0, r.duration_ms) : 0;
  samples.push({
    runId: String(r.run_id ?? `${r.session_key}:${ts}`),
    model: String(r.model ?? ""),
    provider: String(r.provider ?? ""),
    chosenLevel: "",
    subagent: sub,
    startedAt: sub ? ts - dur : ts,
    ...(sub ? { endedAt: ts } : {}),
  });
}

const subs = samples.filter((s) => s.subagent);
const withDur = subs.filter((s) => (s.endedAt ?? 0) > s.startedAt);
console.log(`rows=${rows.length} samples=${samples.length} subagent=${subs.length} with-interval=${withDur.length}`);

// peak concurrency by sweep line over the subagent intervals
const evs: Array<[number, number]> = [];
for (const s of withDur) {
  evs.push([s.startedAt, +1], [s.endedAt as number, -1]);
}
evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0;
let peak = 0;
let peakAt = 0;
for (const [t, d] of evs) {
  cur += d;
  if (cur > peak) {
    peak = cur;
    peakAt = t;
  }
}
console.log(`peak concurrent subagent strands: ${peak} at ${new Date(peakAt).toISOString()}`);

// the renderer's own verdict: distinct x positions = the depth fan actually paints
const store = new EegTraceStore();
store.backfill(samples, []);
const svg = store.renderSvg({ width: 320 });
const parallelTips = (svg.match(/× parallel here/g) ?? []).length;
const branchPaths = (svg.match(/<path /g) ?? []).length;
console.log(`svg: ${svg.length} chars, ${branchPaths} path(s), ${parallelTips} "N× parallel here" tooltip(s)`);
const nx = [...svg.matchAll(/(\d+)× parallel here/g)].map((m) => Number(m[1]));
if (nx.length) console.log(`max multiplicity reported by a strand tooltip: ${Math.max(...nx)}`);
