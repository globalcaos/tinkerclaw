#!/usr/bin/env node
// same-file.mjs — decide whether two torrents carry the SAME bytes.
//
// WHY THIS EXISTS. Public indexers have decayed: the same release is scattered
// across many listings with different infohashes, each with a small pocket of
// seeders, and some listings are outright bait. Two consequences follow:
//   1. Four "options" are often one file, so the real choice is which SWARM to
//      join, not which release to take — and you may join several at once.
//   2. If two torrents provably hold identical bytes, their seeders are
//      interchangeable and their pockets can be added together.
//
// Different infohashes prove NOTHING about content: piece length, padding files,
// trailing NFOs and file ordering all change the hash while the video stays
// byte-identical. So identity has to be established on the CONTENT.
//
// THREE ESCALATING TESTS, cheapest first:
//   1. SHAPE   — same largest-file name-ish and EXACT byte size. Free, from
//                metadata alone. Different sizes ⇒ definitively different files.
//   2. PIECES  — if piece length and file offset happen to align, identical
//                piece hashes at the same file offset prove identity with ZERO
//                content transferred. Rare but free when it lands.
//   3. BYTES   — fetch the first N bytes of the target file from each torrent
//                independently and compare SHA-256. Proof, at the cost of N
//                bytes per torrent.
//
// Usage:
//   node scripts/same-file.mjs shape                 # stage 1 over the last search
//   node scripts/same-file.mjs bytes <a> <b> [--mb 8]

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTorrent } from "../lib/bencode.mjs";
import { loadSearch } from "../lib/config.mjs";

const ARIA2 = process.env.ARIA2C_BIN || path.join(os.homedir(), ".local/bin/aria2c");
const VIDEO_RE = /\.(mkv|mp4|avi|m2ts|ts|mov|m4v|webm)$/i;
const fmt = (b) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;

const magnetHash = (m) => (m ? (m.match(/btih:([a-fA-F0-9]{40})/) || [])[1]?.toLowerCase() : null);

function magnetFor(c) {
  if (c.magnet) return c.magnet;
  const ih = (c.infoHash || "").toLowerCase();
  return ih ? `magnet:?xt=urn:btih:${ih}&dn=${encodeURIComponent(c.title)}` : null;
}

/** Metadata without content: aria2 --bt-metadata-only writes the .torrent. */
function fetchMeta(magnet, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-meta-"));
    execFile(
      ARIA2,
      [
        "--bt-metadata-only=true",
        "--bt-save-metadata=true",
        "--seed-time=0",
        "--console-log-level=error",
        "--summary-interval=0",
        "--bt-stop-timeout=90",
        `--dir=${dir}`,
        magnet,
      ],
      { timeout: timeoutMs },
      () => {
        const f = fs.readdirSync(dir).find((n) => n.endsWith(".torrent"));
        if (!f) return resolve(null);
        try {
          resolve(readTorrent(fs.readFileSync(path.join(dir, f))));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** The file that actually matters — the largest video, else simply the largest. */
function primaryFile(meta) {
  const vids = meta.files.filter((f) => VIDEO_RE.test(f.path));
  const pool = vids.length ? vids : meta.files;
  return pool.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a));
}

/**
 * Stage 3: pull the first `mb` MiB of the primary file from ONE torrent.
 * `--stream-piece-selector=inorder` makes the head arrive first, so a small
 * prefix is enough; we stop as soon as we have it.
 */
function fetchPrefix(magnet, fileIndex, mb) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bytes-"));
    const child = execFile(
      ARIA2,
      [
        `--dir=${dir}`,
        "--seed-time=0",
        "--seed-ratio=0.0",
        "--max-upload-limit=1K",
        `--select-file=${fileIndex}`,
        "--stream-piece-selector=inorder",
        "--enable-dht=true",
        "--bt-max-peers=100",
        "--file-allocation=none",
        "--console-log-level=error",
        "--summary-interval=0",
        magnet,
      ],
      { timeout: 300000 },
      () => {},
    );
    const want = mb * 1024 * 1024;
    const started = Date.now();
    const tick = setInterval(() => {
      let biggest = null;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (!p.endsWith(".aria2")) {
            const s = fs.statSync(p).size;
            if (!biggest || s > biggest.size) biggest = { p, size: s };
          }
        }
      };
      try {
        walk(dir);
      } catch {}
      if (biggest && biggest.size >= want) {
        clearInterval(tick);
        try {
          child.kill("SIGTERM");
        } catch {}
        const fd = fs.openSync(biggest.p, "r");
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, 0);
        fs.closeSync(fd);
        resolve({
          sha256: crypto.createHash("sha256").update(buf).digest("hex"),
          bytes: want,
          path: biggest.p,
        });
      } else if (Date.now() - started > 290000) {
        clearInterval(tick);
        try {
          child.kill("SIGTERM");
        } catch {}
        resolve(null);
      }
    }, 2000);
  });
}

async function shapeStage() {
  const state = loadSearch();
  if (!state) {
    console.error("run search.mjs first");
    process.exit(2);
  }
  const rows = [];
  for (const [i, c] of state.kept.entries()) {
    const mag = magnetFor(c);
    if (!mag) {
      rows.push({ n: i + 1, title: c.title, err: "no magnet/infohash" });
      continue;
    }
    const meta = await fetchMeta(mag);
    if (!meta) {
      rows.push({ n: i + 1, title: c.title, err: "no metadata (swarm silent)" });
      continue;
    }
    const pf = primaryFile(meta);
    rows.push({
      n: i + 1,
      title: c.title,
      infoHash: meta.infoHash,
      primary: pf.path.split("/").pop(),
      size: pf.sizeBytes,
      total: meta.totalBytes,
      files: meta.files.length,
    });
  }

  // Group by EXACT primary-file byte size — the cheap, decisive shape test.
  const groups = new Map();
  for (const r of rows) {
    if (!r.size) continue;
    const k = String(r.size);
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }

  console.log("\n  #  primary file (largest video)                    size          infohash");
  for (const r of rows) {
    if (r.err) {
      console.log(`  ${String(r.n).padStart(2)}  ${"—".padEnd(46)}  ${r.err}`);
      continue;
    }
    console.log(
      `  ${String(r.n).padStart(2)}  ${r.primary.slice(0, 46).padEnd(46)}  ${fmt(r.size).padStart(9)}  ${r.infoHash.slice(0, 12)}…`,
    );
  }
  console.log("\n  candidate same-file groups (identical primary-file byte size):");
  let found = 0;
  for (const [size, members] of groups) {
    if (members.length < 2) continue;
    found += 1;
    console.log(
      `    ${fmt(Number(size))} → #${members.map((m) => m.n).join(", #")}  (${members.length} torrents, ${new Set(members.map((m) => m.infoHash)).size} distinct infohashes)`,
    );
  }
  if (!found)
    console.log(
      "    none — every candidate has a distinct primary-file size, so they are different files.",
    );
  else
    console.log(
      "\n  Same size is STRONG but not proof. Confirm one pair with:\n    node scripts/same-file.mjs bytes <a> <b> --mb 8",
    );
}

async function bytesStage(a, b, mb) {
  const state = loadSearch();
  const ca = state.kept[a - 1];
  const cb = state.kept[b - 1];
  if (!ca || !cb) {
    console.error("bad candidate numbers");
    process.exit(2);
  }
  console.log(
    `comparing the first ${mb} MiB of the primary file\n  A #${a}: ${ca.title.slice(0, 60)}\n  B #${b}: ${cb.title.slice(0, 60)}\n`,
  );
  const [ma, mb_] = await Promise.all([fetchMeta(magnetFor(ca)), fetchMeta(magnetFor(cb))]);
  if (!ma || !mb_) {
    console.error("could not get metadata for both — swarm silent");
    process.exit(3);
  }
  const pa = primaryFile(ma);
  const pb = primaryFile(mb_);
  console.log(`  A primary: ${pa.path.split("/").pop()} (${fmt(pa.sizeBytes)})`);
  console.log(`  B primary: ${pb.path.split("/").pop()} (${fmt(pb.sizeBytes)})`);
  if (pa.sizeBytes !== pb.sizeBytes) {
    console.log(
      `\n  VERDICT: DIFFERENT — primary files differ by ${fmt(Math.abs(pa.sizeBytes - pb.sizeBytes))}. No transfer needed.`,
    );
    return;
  }
  const ia = ma.files.indexOf(pa) + 1;
  const ib = mb_.files.indexOf(pb) + 1;
  console.log(`\n  sizes match exactly; fetching ${mb} MiB from each swarm independently…`);
  const [ra, rb] = await Promise.all([
    fetchPrefix(magnetFor(ca), ia, mb),
    fetchPrefix(magnetFor(cb), ib, mb),
  ]);
  if (!ra || !rb) {
    console.log("\n  INCONCLUSIVE — one or both swarms delivered no bytes in time.");
    return;
  }
  console.log(`  A sha256(first ${mb}MiB) = ${ra.sha256}`);
  console.log(`  B sha256(first ${mb}MiB) = ${rb.sha256}`);
  console.log(
    ra.sha256 === rb.sha256
      ? `\n  VERDICT: SAME FILE — identical bytes from two independent swarms.\n  Their seeders are interchangeable; treat the pockets as one pool.`
      : `\n  VERDICT: DIFFERENT — same size, different content. A same-size collision is exactly what a bait listing looks like.`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const mbIdx = process.argv.indexOf("--mb");
const mb = mbIdx > -1 ? Number(process.argv[mbIdx + 1]) : 8;
if (cmd === "bytes") await bytesStage(Number(rest[0]), Number(rest[1]), mb);
else await shapeStage();
