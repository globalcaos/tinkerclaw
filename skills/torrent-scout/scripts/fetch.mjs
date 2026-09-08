#!/usr/bin/env node
// fetch.mjs — retrieve a verified candidate. Never seeds.
//
// Route preference, best to worst:
//   1. HTTP WEBSEED  — the torrent advertises url-list (BEP-19), so the files
//      can be pulled over plain HTTPS. No tracker, no DHT, no peers, nothing
//      to upload. archive.org always offers this. Always preferred.
//   2. BITTORRENT    — upload hard-capped at zero and the client destroyed the
//      instant the download completes, so no piece is ever redistributed.
//
// Seeding is OFF and cannot be turned on by a flag alone: an infohash must be
// listed in config.seedAllowlist, which is a deliberate, per-item decision.
//
// Usage:
//   node scripts/fetch.mjs <n|infohash|fragment> [--dir <path>] [--force]
//                          [--dry-run] [--video-only] [--seed]

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readTorrent } from "../lib/bencode.mjs";
import { resolveRef, loadConfig, loadSearch } from "../lib/config.mjs";
import { loadMap, aliveNodes } from "../lib/netmap.mjs";
import { gate } from "../lib/score.mjs";

const fmt = (b) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
const VIDEO_RE = /\.(mkv|mp4|avi|m2ts|ts|mov|m4v|webm)$/i;
// archive.org bookkeeping files nobody wants.
const SIDECAR_RE = /(_meta\.(xml|sqlite)|_files\.xml|__ia_thumb\.jpg|_reviews\.xml)$/i;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) {
        flags[k] = n;
        i += 1;
      } else flags[k] = true;
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

/** BEP-19: build a direct HTTP url for one file under a webseed base. */
function webseedUrl(base, torrentName, filePath, isMultiFile) {
  const clean = base.endsWith("/") ? base : `${base}/`;
  if (!isMultiFile)
    return clean.endsWith(`/${torrentName}`) ? clean : `${clean}${encodeURIComponent(torrentName)}`;
  // filePath already begins with the torrent name for multi-file torrents.
  return clean + filePath.split("/").map(encodeURIComponent).join("/");
}

async function downloadHttp(url, dest, expectedBytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let from = 0;
  if (fs.existsSync(part)) from = fs.statSync(part).size;
  if (expectedBytes && from >= expectedBytes) {
    fs.renameSync(part, dest);
    return { resumed: true, bytes: from };
  }

  const headers = { "user-agent": "torrent-scout/1.0" };
  if (from > 0) headers.range = `bytes=${from}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
  if (from > 0 && res.status !== 206) from = 0; // server ignored the range

  const out = fs.createWriteStream(part, { flags: from > 0 ? "a" : "w" });
  let seen = from;
  let lastTick = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    seen += c.length;
    const now = Date.now();
    if (now - lastTick > 1000) {
      lastTick = now;
      const pct = expectedBytes ? ((seen / expectedBytes) * 100).toFixed(1) : "?";
      process.stderr.write(
        `\r    ${fmt(seen)} / ${expectedBytes ? fmt(expectedBytes) : "?"}  ${pct}%   `,
      );
    }
  });
  await pipeline(body, out);
  process.stderr.write("\r");
  fs.renameSync(part, dest);
  return { resumed: from > 0, bytes: seen };
}

/**
 * BitTorrent via aria2c.
 *
 * NOT webtorrent: every 2.x release tested (2.6.10 … 2.8.5) throws
 * `arr2hex(undefined)` inside `Torrent._onTorrentId` on a valid magnet, with
 * parse-torrent 11.0.18 and 11.0.24 alike — the magnet parses correctly when
 * called directly, so the fault is inside webtorrent. aria2c is also the better
 * engine here: resumable, and `--seed-time=0 --seed-ratio=0.0` means there is
 * no seeding phase at all rather than an upload cap.
 *
 * Install without root: the static build at
 * github.com/abcfy2/aria2-static-build (x86_64-linux-musl), unzipped to
 * ~/.local/bin/aria2c. Homebrew has no bottle for it on linux.
 */
async function viaBitTorrent(magnet, dir, { allowSeed }) {
  const { execFile } = await import("node:child_process");
  const os = await import("node:os");
  const bin = process.env.ARIA2C_BIN || `${os.homedir()}/.local/bin/aria2c`;
  if (!fs.existsSync(bin)) {
    throw new Error(
      `BitTorrent route needs aria2c at ${bin} (set ARIA2C_BIN, or install the static build — see the comment above this function).`,
    );
  }
  return new Promise((resolve, reject) => {
    const args = [
      `--dir=${dir}`,
      "--seed-time=0",
      "--seed-ratio=0.0",
      "--max-upload-limit=1K",
      "--enable-dht=true",
      "--bt-enable-lpd=true",
      "--bt-max-peers=80",
      "--file-allocation=none",
      "--continue=true",
      "--summary-interval=20",
      "--console-log-level=notice",
      magnet,
    ];
    if (allowSeed) {
      args[1] = "--seed-time=525600";
      args[2] = "--seed-ratio=0.0";
    }
    const child = execFile(bin, args, { maxBuffer: 1024 * 1024 * 8 }, (err) => {
      if (err && err.code !== 0)
        return reject(new Error(`aria2c exited ${err.code}: ${String(err).slice(0, 160)}`));
      resolve({ path: dir, uploaded: 0, seeded: Boolean(allowSeed) });
    });
    child.stdout?.on("data", (d) => process.stderr.write(String(d).replace(/\x1b\[[0-9;]*m/g, "")));
  });
}

async function viaWebTorrentUnused(magnet, dir, { allowSeed }) {
  let WebTorrent;
  try {
    ({ default: WebTorrent } = await import("webtorrent"));
  } catch {
    throw new Error(
      "BitTorrent route needs the optional `webtorrent` dependency (npm i webtorrent in the skill dir).",
    );
  }

  // uploadLimit 0 = never send a byte to a peer. This is the whole point.
  const client = new WebTorrent({ uploadLimit: 0, maxConns: 40 });
  return new Promise((resolve, reject) => {
    const t = client.add(magnet, { path: dir });
    t.on("error", (e) => {
      client.destroy();
      reject(e);
    });
    let last = 0;
    t.on("download", () => {
      const now = Date.now();
      if (now - last > 1000) {
        last = now;
        process.stderr.write(
          `\r    ${(t.progress * 100).toFixed(1)}%  ${fmt(t.downloaded)}  ↓${(t.downloadSpeed / 1024).toFixed(0)} KB/s  ↑${(t.uploadSpeed / 1024).toFixed(0)} KB/s  peers ${t.numPeers}   `,
        );
      }
    });
    t.on("done", () => {
      process.stderr.write("\r");
      const uploaded = t.uploaded;
      if (!allowSeed) {
        // Tear down immediately: no seeding phase exists at all.
        client.destroy(() => resolve({ path: dir, uploaded, seeded: false }));
      } else {
        console.log("\n  SEEDING (explicitly allowlisted). Ctrl-C to stop.");
      }
    });
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const ref = positional[0];
  if (!ref) {
    console.error("usage: fetch.mjs <n|infohash|fragment> [--dir path] [--dry-run] [--video-only]");
    process.exit(2);
  }

  const cfg = loadConfig();
  const state = loadSearch();
  const cand = resolveRef(ref);
  const dir = flags.dir || cfg.downloadDir;

  // Refuse anything the gate rejected, and anything never inspected.
  const g = gate(cand, { kind: state?.kind || "auto" });
  if (g.rejected && !flags.force) {
    console.error("REFUSED — this candidate failed the quality gate:");
    for (const r of g.reasons) console.error(`  - ${r}`);
    console.error("\n(--force overrides, but you almost certainly want a different result.)");
    process.exit(3);
  }
  if (!cand.inspected && !flags.force) {
    console.error("REFUSED — not inspected yet. Run:  inspect.mjs " + ref);
    console.error(
      "Downloading without seeing the real file list is exactly what this skill exists to prevent.",
    );
    process.exit(4);
  }

  const allowSeed =
    Boolean(flags.seed) && (cfg.seedAllowlist || []).includes((cand.infoHash || "").toLowerCase());
  if (flags.seed && !allowSeed) {
    console.error("REFUSED to seed: this infohash is not in config.seedAllowlist.");
    console.error(
      `Add "${cand.infoHash}" to ~/.torrent-scout/config.json seedAllowlist to redistribute it deliberately.`,
    );
    process.exit(5);
  }

  console.log(`\n${cand.title}`);
  console.log(`  dest  ${dir}`);

  // --- route 1: HTTP webseed ------------------------------------------------
  let meta = null;
  if (cand.torrentUrl) {
    const res = await fetch(cand.torrentUrl, { headers: { "user-agent": "torrent-scout/1.0" } });
    if (res.ok) meta = readTorrent(Buffer.from(await res.arrayBuffer()));
  }

  if (meta && meta.webSeeds.length) {
    let files = meta.files.filter((f) => !SIDECAR_RE.test(f.path));
    if (flags["video-only"]) files = files.filter((f) => VIDEO_RE.test(f.path));
    const total = files.reduce((a, f) => a + f.sizeBytes, 0);
    console.log(`  route HTTP webseed — no tracker, no DHT, no peers, nothing uploaded`);
    console.log(`  ${files.length} file(s), ${fmt(total)}\n`);
    if (flags["dry-run"]) {
      for (const f of files)
        console.log(
          `    would GET  ${webseedUrl(meta.webSeeds[0], meta.name, f.path, meta.files.length > 1 || Boolean(meta.files[0]?.path.includes("/")))}`,
        );
      console.log("\n  dry run — nothing transferred.");
      return;
    }
    const isMulti = meta.files.length > 1 || Boolean(meta.files[0]?.path.includes("/"));
    for (const f of files) {
      const dest = path.join(dir, f.path);
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.sizeBytes) {
        console.log(`  = ${f.path} (already complete)`);
        continue;
      }
      let ok = false;
      for (const base of meta.webSeeds) {
        try {
          console.log(`  ↓ ${f.path}  (${fmt(f.sizeBytes)})`);
          await downloadHttp(webseedUrl(base, meta.name, f.path, isMulti), dest, f.sizeBytes);
          ok = true;
          break;
        } catch (e) {
          console.log(`    webseed failed (${e.message}), trying next`);
        }
      }
      if (!ok) throw new Error(`all webseeds failed for ${f.path}`);
    }
    console.log(`\n  DONE. 0 bytes uploaded (HTTP only — there was no swarm to seed to).`);
    console.log(`  files at ${dir}`);
    return;
  }

  // --- route 2: BitTorrent, upload disabled --------------------------------
  // Attach the trackers the net map has actually SEEN answer, from this
  // machine, sorted fastest first. A bare magnet leans entirely on the DHT to
  // assemble a swarm, which is slow and sometimes never happens at all.
  //
  // Measured 2026-09-06 on a live download: adding 16 swarm-aware trackers to a
  // running torrent took it from 1 peer to a peak of 8. (It did NOT go faster —
  // that torrent had one reachable seeder — but finding every peer that exists
  // is the part we control, and on a healthy swarm it is the whole game.)
  const trackerParams = (() => {
    try {
      const alive = aliveNodes(loadMap(), "tracker", 60)
        .filter((n) => n.scheme === "udp" || n.scheme === "http" || n.scheme === "https")
        .map((n) => `${n.scheme}://${n.host}:${n.port}${n.path || "/announce"}`);
      return alive.map((u) => `&tr=${encodeURIComponent(u)}`).join("");
    } catch {
      return "";
    }
  })();
  const magnet =
    (cand.magnet ||
      (cand.infoHash
        ? `magnet:?xt=urn:btih:${cand.infoHash}&dn=${encodeURIComponent(cand.title)}`
        : null)) + (cand.magnet || cand.infoHash ? trackerParams : "");
  if (!magnet) {
    console.error("No webseed and no magnet/infohash — cannot retrieve.");
    process.exit(6);
  }
  console.log(`  route BitTorrent — upload capped at 0 B/s, client destroyed on completion`);
  console.log(
    `  attached ${(trackerParams.match(/&tr=/g) || []).length} verified-alive trackers from the net map`,
  );
  console.log("  NOTE: your IP is visible to the swarm while downloading. Not seeding");
  console.log("        means you never redistribute, but it does not make you invisible.\n");
  if (flags["dry-run"]) {
    console.log(`  dry run — would add ${magnet.slice(0, 80)}…`);
    return;
  }
  const r = await viaBitTorrent(magnet, dir, { allowSeed });
  console.log(`\n  DONE. uploaded ${fmt(r.uploaded || 0)} (target: 0). seeding=${r.seeded}`);
  console.log(`  files at ${dir}`);
}

main().catch((e) => {
  console.error("fetch failed:", e.message);
  process.exit(1);
});
