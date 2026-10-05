#!/usr/bin/env node
import fs from "node:fs";
import { parseRelease, SOURCE_LADDER, REJECT_REASON } from "../lib/parse.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const asTable = args.includes("--table");
let names = [];
const fileIdx = args.indexOf("--file");
if (fileIdx > -1) names = fs.readFileSync(args[fileIdx + 1], "utf8").split("\n");
else if (args.includes("--stdin")) names = fs.readFileSync(0, "utf8").split("\n");
else names = args.filter((a) => !a.startsWith("--"));
names = names.map((n) => n.trim()).filter(Boolean);

if (!names.length) {
  console.error('usage: parse.mjs "<release name>" | --file <list> | --stdin  [--json] [--table]');
  process.exit(2);
}

const parsed = names.map((n) => parseRelease(n));
if (asJson) {
  console.log(JSON.stringify(parsed.length === 1 ? parsed[0] : parsed, null, 2));
  process.exit(0);
}

if (asTable) {
  const pad = (s, n) =>
    String(s ?? "—")
      .slice(0, n)
      .padEnd(n);
  console.log(
    `${pad("TITLE", 34)} ${pad("YEAR", 5)} ${pad("RES", 6)} ${pad("SOURCE", 10)} ${pad("VIDEO", 6)} ${pad("AUDIO", 10)} ${pad("GROUP", 12)} FLAG`,
  );
  for (const p of parsed) {
    console.log(
      `${pad(p.title, 34)} ${pad(p.year, 5)} ${pad(p.resolution ? p.resolution + "p" : null, 6)} ${pad(p.source, 10)} ${pad(p.videoCodec, 6)} ${pad([p.audioCodec, p.audioChannels].filter(Boolean).join(" "), 10)} ${pad(p.group, 12)} ${p.isCamcorder ? "PRE-RETAIL" : ""}`,
    );
  }
  process.exit(0);
}

for (const p of parsed) {
  console.log(`\n${p.raw}`);
  console.log(`  title      ${p.title}${p.year ? ` (${p.year})` : ""}`);
  if (p.isEpisodic)
    console.log(`  episode    S${p.season}${p.episode != null ? `E${p.episode}` : ""}`);
  console.log(
    `  picture    ${p.resolution ? p.resolution + "p" : "not stated"} · ${p.source || "source not stated"}${p.videoCodec ? ` · ${p.videoCodec}` : ""}${p.bitDepth ? ` · ${p.bitDepth}-bit` : ""}${p.hdr.length ? ` · ${p.hdr.join("/")}` : ""}`,
  );
  console.log(
    `  sound      ${p.audioCodec ? `${p.audioCodec}${p.audioChannels ? ` ${p.audioChannels}` : ""}` : "not stated"}`,
  );
  console.log(
    `  release    ${p.group || "no group"}${p.edition ? ` · ${p.edition}` : ""}${p.isProper ? " · PROPER/REPACK" : ""}`,
  );
  if (p.languages.length) console.log(`  languages  ${p.languages.join(", ")}`);
  console.log(
    `  rank       source ${p.sourceRank >= 0 ? `${p.sourceRank}/${SOURCE_LADDER.length - 1}` : "—"}`,
  );
  if (p.isCamcorder)
    console.log(`  ⚠ PRE-RETAIL: ${REJECT_REASON[p.source] || "pre-retail source"}`);
}
