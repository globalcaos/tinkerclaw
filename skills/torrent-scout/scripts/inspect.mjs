#!/usr/bin/env node
// inspect.mjs — VERIFY BEFORE DOWNLOADING.
//
// Fetches a torrent's METADATA ONLY (the file list, sizes, piece layout) and
// re-runs fake detection against the real contents rather than the name.
// Zero content bytes are transferred either way.
//
// Two paths, and the difference matters for privacy:
//   1. torrentUrl present -> plain HTTPS GET of the .torrent. No tracker, no
//      DHT, no peer ever learns you looked. This is the preferred path.
//   2. magnet only        -> the file list lives with the peers, so fetching it
//      means a brief DHT/tracker announce. You are visible in that swarm for
//      a few seconds. Requires the optional `webtorrent` dependency and is
//      only attempted with --swarm.
//
// Usage:
//   node scripts/inspect.mjs <n|infohash|title-fragment> [--swarm] [--json]

import { readTorrent } from "../lib/bencode.mjs";
import { resolveRef, loadConfig, loadSearch, saveSearch } from "../lib/config.mjs";
import { detectFlags, gate, score } from "../lib/score.mjs";

const fmt = (b) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;

async function fromHttp(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": "torrent-scout/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readTorrent(Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(t);
  }
}

async function fromSwarm(magnet, timeoutMs) {
  let WebTorrent;
  try {
    ({ default: WebTorrent } = await import("webtorrent"));
  } catch {
    throw new Error(
      "magnet-only result needs the optional `webtorrent` dependency.\n" +
        '  install:  npm i --prefix "$(dirname "$0")/.." webtorrent',
    );
  }
  const client = new WebTorrent({ uploadLimit: 0, maxConns: 30 });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("swarm metadata timeout")), timeoutMs);
      // No options: passing `store: undefined` makes webtorrent's store
      // resolution throw inside arr2hex before metadata is ever fetched.
      // Metadata-only is achieved by destroying the client on 'metadata',
      // which is why no content byte is ever requested.
      const t = client.add(magnet);
      t.on("metadata", () => {
        clearTimeout(timer);
        resolve({
          name: t.name,
          infoHash: t.infoHash,
          files: t.files.map((f) => ({ path: f.path, sizeBytes: f.length })),
          totalBytes: t.length,
          pieceLength: t.pieceLength,
          pieceCount: t.pieces?.length ?? null,
          private: Boolean(t.private),
          announce: t.announce || [],
          webSeeds: [],
          comment: t.comment || null,
          createdBy: t.createdBy || null,
          creationDate: t.created ? new Date(t.created).toISOString() : null,
        });
      });
      t.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  } finally {
    client.destroy();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith("--"));
  const useSwarm = args.includes("--swarm");
  const asJson = args.includes("--json");
  if (!ref) {
    console.error("usage: inspect.mjs <n|infohash|fragment> [--swarm] [--json]");
    process.exit(2);
  }

  const cfg = loadConfig();
  const state = loadSearch();
  const cand = resolveRef(ref);

  let meta;
  let route;
  let httpError = null;
  if (cand.torrentUrl) {
    try {
      route = "https (no swarm contact)";
      meta = await fromHttp(cand.torrentUrl, cfg.timeoutMs);
    } catch (e) {
      // Indexer download-proxy links rot constantly (dead 404s, expired tokens).
      // A dead .torrent URL is not a dead candidate when a magnet also exists —
      // fall through rather than abandoning a result the user can still get.
      httpError = e.message;
      meta = null;
    }
  }
  if (!meta && cand.magnet) {
    if (!useSwarm) {
      if (httpError)
        console.error(`The .torrent link failed (${httpError}); a magnet is available.`);
      console.error("Fetching a magnet's file list requires briefly");
      console.error("announcing to the swarm — your IP is visible to its peers for a few");
      console.error("seconds. Re-run with --swarm if that is acceptable.");
      process.exit(4);
    }
    route = "swarm DHT/tracker (you were visible to peers)";
    meta = await fromSwarm(cand.magnet, Math.max(cfg.timeoutMs, 45000));
  }
  if (!meta) {
    console.error(
      httpError
        ? `Could not read metadata: .torrent link failed (${httpError}) and no magnet is available.`
        : "Candidate has neither a .torrent URL nor a magnet link.",
    );
    process.exit(5);
  }

  // Re-evaluate against the REAL contents, not the advertised name.
  const enriched = {
    ...cand,
    files: meta.files,
    infoHash: cand.infoHash || meta.infoHash,
    sizeBytes: meta.totalBytes || cand.sizeBytes,
  };
  const opts = {
    wantedTitle: state?.query,
    kind: state?.kind || "auto",
    runtimeMin: state?.runtimeMin || 105,
    profile: state?.profile || "best",
  };
  enriched.flags = detectFlags(enriched, opts);
  const g = gate(enriched, opts);
  const sc = score(enriched, opts);
  enriched.score = sc.score;
  enriched.scoreWhy = sc.why;
  enriched.inspected = { at: new Date().toISOString(), route, meta: { ...meta, files: undefined } };
  enriched.verdict = g.rejected ? "rejected" : enriched.flags.length ? "ok" : "clean";
  enriched.rejectReasons = g.reasons;

  // Persist so a later fetch uses the verified record.
  if (state) {
    const idx = state.kept.findIndex((c) => c.id === cand.id);
    if (idx >= 0) state.kept[idx] = enriched;
    saveSearch(state);
  }

  if (asJson) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  const sizeDelta =
    cand.sizeBytes && meta.totalBytes
      ? ((meta.totalBytes - cand.sizeBytes) / cand.sizeBytes) * 100
      : 0;

  console.log(`\n${cand.title}`);
  console.log(`  route      ${route}`);
  console.log(`  infohash   ${enriched.infoHash || "(unknown)"}`);
  console.log(
    `  real size  ${fmt(meta.totalBytes)}${Math.abs(sizeDelta) > 5 ? `  (listing said ${fmt(cand.sizeBytes)} — ${sizeDelta > 0 ? "+" : ""}${sizeDelta.toFixed(0)}%)` : ""}`,
  );
  console.log(
    `  files      ${meta.files.length}   pieces ${meta.pieceCount ?? "?"} @ ${meta.pieceLength ? fmt(meta.pieceLength) : "?"}`,
  );
  if (meta.createdBy)
    console.log(
      `  created by ${meta.createdBy}${meta.creationDate ? ` on ${meta.creationDate.slice(0, 10)}` : ""}`,
    );
  if (meta.private) console.log("  private    yes (private tracker — DHT disabled)");

  console.log("\n  contents:");
  const sorted = [...meta.files].sort((a, b) => b.sizeBytes - a.sizeBytes);
  for (const f of sorted.slice(0, 25))
    console.log(`    ${fmt(f.sizeBytes).padStart(10)}  ${f.path}`);
  if (sorted.length > 25) console.log(`    … and ${sorted.length - 25} more`);

  console.log(`\n  score ${enriched.score}   verdict ${enriched.verdict.toUpperCase()}`);
  if (enriched.flags.length) console.log(`  flags  ${enriched.flags.join(", ")}`);
  if (g.rejected) {
    console.log("\n  DO NOT DOWNLOAD:");
    for (const r of g.reasons) console.log(`    - ${r}`);
  } else {
    console.log(`\n  next: fetch.mjs ${ref}   (downloads with seeding disabled)`);
  }
}

main().catch((e) => {
  console.error("inspect failed:", e.message);
  process.exit(1);
});
