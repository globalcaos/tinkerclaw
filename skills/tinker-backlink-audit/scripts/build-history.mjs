#!/usr/bin/env node
// build-history — write dated, cumulative "ours" backlink observations into the
// control-panel store so the Inbound-links graph shows real historical growth,
// not just today's snapshot.
//
// The dataset is YOURS and lives in a JSON file, never in this script. Which file
// (first match wins; the two explicit choices never fall back):
//   1. --series <path>
//   2. BACKLINK_AUDIT_SERIES=<path>
//   3. ~/.config/backlink-audit/history-series.json
//   4. assets/history-series.json beside this script (git-ignored; for a private install)
//   5. assets/history-series.example.json — placeholder shape; dry run only, --yes refuses
//
// File shape: { "series": { "<metric id>": [ { "date": "YYYY-MM-DD", "cumulative": N, "note": "…" } ] } }
// Metric ids follow graph.inbound.<target-key>.ours. The data must be DERIVED, not
// invented — see "_provenance" in the example file for the two mines that date each
// backlink (authored third-party threads; `git log -S "<your-domain>"`).
//
// OPT-IN BY DESIGN: this script writes to your control-panel store, so it does
// NOTHING without --yes. Run it bare (or with --dry-run) to print exactly what it
// would write, then re-run with --yes if you want it. Each point is sent with
//   <cli> gateway call control-panel.record --params {"id","value","ts"}
// (idempotent per ts). --cli <bin> picks the gateway CLI; the default is `openclaw`,
// and a TinkerClaw install also answers to `tinkerclaw`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_SERIES = path.join(os.homedir(), ".config", "backlink-audit", "history-series.json");
const LOCAL_SERIES = path.join(HERE, "..", "assets", "history-series.json");
const EXAMPLE_SERIES = path.join(HERE, "..", "assets", "history-series.example.json");

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) die(`unexpected argument "${t}"`);
    const k = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      a[k] = next;
      i++;
    } else a[k] = true;
  }
  return a;
}

function resolveSeries(args) {
  const explicit = [
    [args.series, "--series"],
    [process.env.BACKLINK_AUDIT_SERIES, "BACKLINK_AUDIT_SERIES"],
  ];
  for (const [val, label] of explicit) {
    if (val === true) die(`${label} needs a path`);
    if (val) {
      if (!fs.existsSync(val))
        die(`${label} points at ${val}, which does not exist. Nothing was written.`);
      return { file: val, example: false };
    }
  }
  if (fs.existsSync(USER_SERIES)) return { file: USER_SERIES, example: false };
  if (fs.existsSync(LOCAL_SERIES)) return { file: LOCAL_SERIES, example: false };
  return { file: EXAMPLE_SERIES, example: true };
}

function loadSeries(r) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(r.file, "utf8"));
  } catch (e) {
    die(`cannot read series file ${r.file}: ${e.message}`);
  }
  const series = raw.series ?? raw;
  const out = {};
  for (const [metric, points] of Object.entries(series)) {
    if (metric.startsWith("_")) continue; // notes
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metric))
      die(`series ${r.file}: bad metric id "${metric}"`);
    if (!Array.isArray(points)) die(`series ${r.file}: "${metric}" must be an array of points`);
    for (const p of points) {
      if (
        !p ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
        Number.isNaN(Date.parse(`${p.date}T12:00:00Z`))
      )
        die(`series ${r.file}: "${metric}" has a point with a bad date: ${JSON.stringify(p)}`);
      if (!Number.isFinite(p.cumulative))
        die(`series ${r.file}: "${metric}" ${p.date} needs a numeric "cumulative"`);
    }
    out[metric] = points;
  }
  return { series: out, example: r.example || raw._example === true };
}

const args = parseArgs(process.argv.slice(2));
const apply = args.yes === true && !args["dry-run"];
const cli = typeof args.cli === "string" ? args.cli : "openclaw";
if (args.cli === true) die("--cli needs a binary name or path");

const res = resolveSeries(args);
const { series: SERIES, example } = loadSeries(res);
const tsOf = (d) => Date.parse(`${d}T12:00:00Z`);
const total = Object.values(SERIES).reduce((n, pts) => n + pts.length, 0);

if (apply && example) {
  die(
    `✋ --yes refused: ${res.file} is the placeholder EXAMPLE (or still carries "_example": true).\n` +
      `   Writing it would put made-up history into your graph. Nothing was written.\n` +
      `   Copy it to ${USER_SERIES}, replace the points with your own derived data,\n` +
      `   delete "_example", then re-run — or pass --series <path> / set BACKLINK_AUDIT_SERIES.`,
  );
}

if (!apply) {
  console.log(`DRY RUN — nothing was written. This would send ${total} dated observations from`);
  console.log(`${res.file}`);
  console.log(`to your control-panel store via: ${cli} gateway call control-panel.record\n`);
}
let wrote = 0;
for (const [metric, points] of Object.entries(SERIES)) {
  for (const p of points) {
    const params = JSON.stringify({ id: metric, value: p.cumulative, ts: tsOf(p.date) });
    const note = p.note ? `  (${p.note})` : "";
    if (!apply) {
      console.log(`  would write  ${metric}  ${p.date} = ${p.cumulative}${note}`);
      continue;
    }
    try {
      execFileSync(cli, ["gateway", "call", "control-panel.record", "--params", params], {
        encoding: "utf8",
      });
      console.log(`  ${metric}  ${p.date} = ${p.cumulative}${note}`);
      wrote++;
    } catch (e) {
      console.error(`  FAILED ${metric} ${p.date}: ${String(e.message).slice(0, 120)}`);
    }
  }
}
if (!apply) {
  if (example)
    console.log(
      `\nThese are PLACEHOLDER numbers from the shipped example. Point --series at your own dataset first.`,
    );
  console.log(`Re-run with --yes to actually write them.`);
} else {
  console.log(
    `\nwrote ${wrote} of ${total} dated observations. The Inbound-links graph now shows the historical 'ours' growth curve.`,
  );
  if (wrote < total) process.exit(1);
}
