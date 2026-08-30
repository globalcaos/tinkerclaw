#!/usr/bin/env node
/**
 * Is the gateway running code older than the source on disk?
 *
 * Written 2026-08-22 after the Crons panel served destroyed data for three
 * nights. The `tinkerclaw-cron-panel` bundle was built 08-19 10:50, ten hours
 * before the parser fix landed, so every cron report body was discarded at
 * ingest — and nothing alarmed, because the panel still rendered a plausible
 * one-line card. The same stale bundle is named as a suspected cause in three
 * other open bug-log entries from the same week.
 *
 * The check is deliberately dumb: newest source mtime vs the built artifact's
 * mtime. It cannot prove a bundle is correct; it only catches the one condition
 * that has now bitten four times — source edited, never rebuilt.
 *
 *   node scripts/check-runtime-staleness.mjs          # report, exit 0
 *   node scripts/check-runtime-staleness.mjs --strict # exit 1 if anything stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Newest mtime of any buildable source file under `dir`, or 0. */
function newestSource(dir) {
  let newest = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!/\.(ts|mts|tsx|js|mjs)$/.test(e.name)) continue;
      if (/\.(test|spec)\./.test(e.name)) continue;
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return newest;
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

const targets = [
  { name: "core runtime", src: path.join(ROOT, "src"), built: path.join(ROOT, "dist", "entry.js") },
];

const extDir = path.join(ROOT, "extensions");
for (const e of fs.existsSync(extDir) ? fs.readdirSync(extDir, { withFileTypes: true }) : []) {
  if (!e.isDirectory()) continue;
  const built = path.join(ROOT, "dist", "extensions", e.name, "index.js");
  if (!fs.existsSync(built)) continue;
  targets.push({ name: e.name, src: path.join(extDir, e.name), built });
}

const HOURS = 1000 * 60 * 60;
const stale = [];
for (const t of targets) {
  const src = newestSource(t.src);
  const built = mtime(t.built);
  if (src > built && built > 0) stale.push({ ...t, gapH: (src - built) / HOURS, built });
}

if (stale.length === 0) {
  console.log(`runtime is current — ${targets.length} build targets, none behind their source.`);
  process.exit(0);
}

stale.sort((a, b) => b.gapH - a.gapH);
console.log(
  `STALE: ${stale.length} of ${targets.length} build targets are older than their source.`,
);
for (const s of stale) {
  console.log(
    `  ${s.name.padEnd(34)} built ${new Date(s.built).toISOString().slice(0, 16)}  ` +
      `source is ${s.gapH.toFixed(1)}h newer`,
  );
}
console.log(
  `\nThe gateway runs the BUILT artifact. Rebuild + restart, or these fixes are not live.`,
);
process.exit(STRICT ? 1 : 0);
