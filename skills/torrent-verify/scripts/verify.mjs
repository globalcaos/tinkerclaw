#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// verify.mjs — read a torrent's real contents before downloading anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTorrent } from "../lib/bencode.mjs";

const EXEC_RE = /\.(exe|msi|scr|bat|cmd|com|apk|dmg|lnk|vbs|ps1|jar|pkg|deb|run)$/i;
const DECOY_RE =
  /(password|passwort|contrase|how[ _-]?to[ _-]?(download|play|watch)|crack|keygen|serial|activate)/i;
const VIDEO_RE = /\.(mkv|mp4|avi|m2ts|ts|mov|wmv|mpg|mpeg|m4v|webm|iso|vob)$/i;
const ARCHIVE_RE = /\.(rar|r\d{2}|zip|7z|tar|gz)$/i;
const MODEL_RE = /\.(stl|3mf|obj|step|stp|f3d|dxf|dwg|scad|gcode|blend|fbx|iges|igs)$/i;
const DOC_RE = /\.(pdf|epub|djvu|mobi|azw3|cbz|cbr)$/i;

const fmt = (b) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;

async function load(src, useSwarm, client) {
  if (src.startsWith("magnet:")) {
    if (!useSwarm) {
      console.error("This is a magnet. Its file list lives with the peers, so reading it means");
      console.error("announcing to that swarm — your IP is visible to everyone in it for a few");
      console.error("seconds. Re-run with --swarm to accept that.");
      process.exit(4);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-"));
    execFileSync(
      client,
      [
        "--bt-metadata-only=true",
        "--bt-save-metadata=true",
        "--seed-time=0",
        "--console-log-level=error",
        "--summary-interval=0",
        `--dir=${dir}`,
        src,
      ],
      { stdio: "ignore", timeout: 180000 },
    );
    const f = fs.readdirSync(dir).find((n) => n.endsWith(".torrent"));
    if (!f) throw new Error("no metadata retrieved from the swarm within 180s");
    return readTorrent(fs.readFileSync(path.join(dir, f)));
  }
  if (/^https?:/.test(src)) {
    const res = await fetch(src, {
      headers: { "user-agent": "torrent-verify/1.0" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readTorrent(Buffer.from(await res.arrayBuffer()));
  }
  return readTorrent(fs.readFileSync(src));
}

function flagsFor(meta) {
  const paths = meta.files.map((f) => f.path);
  const flags = [];
  if (paths.some((p) => EXEC_RE.test(p))) flags.push("executable-payload");
  if (paths.some((p) => DECOY_RE.test(p))) flags.push("decoy-files");
  if (paths.some((p) => ARCHIVE_RE.test(p))) flags.push("archive-payload");
  const hasVideo = paths.some((p) => VIDEO_RE.test(p));
  if (paths.some((p) => MODEL_RE.test(p))) flags.push("has-3d-models");
  if (paths.some((p) => DOC_RE.test(p))) flags.push("has-documents");
  const largest = Math.max(...meta.files.map((f) => f.sizeBytes || 0));
  if (hasVideo && meta.totalBytes && largest / meta.totalBytes < 0.6) flags.push("fragmented");
  if (meta.files.length > 300) flags.push("file-count-anomaly");
  if (!hasVideo && /\b(1080p|2160p|720p|bluray|web-?dl|x26[45])\b/i.test(meta.name || ""))
    flags.push("no-video-file");
  return flags;
}

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("usage: verify.mjs <url|path|magnet> [--swarm] [--client aria2c] [--json]");
  process.exit(2);
}
const clientIdx = args.indexOf("--client");
const client = clientIdx > -1 ? args[clientIdx + 1] : `${os.homedir()}/.local/bin/aria2c`;

const meta = await load(src, args.includes("--swarm"), client);
const flags = flagsFor(meta);
const severe = ["executable-payload", "decoy-files", "no-video-file"];
const verdict = flags.some((f) => severe.includes(f))
  ? "DO NOT DOWNLOAD"
  : flags.filter((f) => !f.startsWith("has-")).length
    ? "CAUTION"
    : "CLEAN";

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...meta, flags, verdict }, null, 2));
  process.exit(0);
}

console.log(`\n${meta.name}`);
console.log(`  infohash   ${meta.infoHash || "(unknown)"}`);
console.log(`  size       ${fmt(meta.totalBytes)} across ${meta.files.length} file(s)`);
console.log(
  `  pieces     ${meta.pieceCount ?? "?"} @ ${meta.pieceLength ? fmt(meta.pieceLength) : "?"}`,
);
if (meta.createdBy)
  console.log(
    `  created by ${meta.createdBy}${meta.creationDate ? ` on ${meta.creationDate.slice(0, 10)}` : ""}`,
  );
if (meta.private) console.log("  private    yes — private tracker, DHT disabled");
if (meta.webSeeds.length)
  console.log(`  webseeds   ${meta.webSeeds.length} (HTTP download possible — no swarm needed)`);
console.log(`  trackers   ${meta.announce.length}`);
console.log("\n  contents:");
for (const f of [...meta.files].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 25)) {
  console.log(`    ${fmt(f.sizeBytes).padStart(10)}  ${f.path}`);
}
if (meta.files.length > 25) console.log(`    … and ${meta.files.length - 25} more`);
console.log(`\n  verdict    ${verdict}`);
if (flags.length) console.log(`  flags      ${flags.join(", ")}`);
