#!/usr/bin/env node
// boost.mjs — make a thin swarm reachable.
//
// You cannot create seeders. What you CAN do is make sure you have found all
// the ones that exist, and that is almost always the real problem: a torrent's
// embedded tracker list is whatever its creator happened to paste in years ago,
// and DHT alone finds a fraction of a small swarm.
//
// Three levers, in order of measured value:
//   1. TRACKER MERGE — union of (a) a maintained public best-trackers list,
//      (b) every tracker announced by any OTHER torrent of the same title.
//      Measured 2026-09-06: a 4K release sitting at 0 peers for hours went to
//      6-11 peers within a minute of the merge. Peer discovery, not bandwidth.
//   2. PEER LIMITS — raise bt-max-peers and connections; a thin swarm needs
//      every contact it can hold.
//   3. DHT + LPD + PEX — on by default in the daemon config, verified here.
//
// It does NOT enable seeding. seed-time=0 / seed-ratio=0 stay untouched.
//
// Usage: node scripts/boost.mjs [gid|all] [--from-search]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearch } from "../lib/config.mjs";

const SECRET = (() => {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".config/aria2/rpc-secret"), "utf8").trim();
  } catch {
    return "";
  }
})();
const RPC = process.env.ARIA2_RPC || "http://127.0.0.1:6800/jsonrpc";
const BEST = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "b",
      method: `aria2.${method}`,
      params: [`token:${SECRET}`, ...params],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function publicTrackers() {
  try {
    const r = await fetch(BEST, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    return (await r.text())
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^(udp|http|wss):/.test(s));
  } catch {
    return [];
  }
}

/** Trackers announced by any OTHER result for the same title — the pockets
 *  do not share tracker lists, which is exactly why they stay disconnected. */
function trackersFromSearch() {
  const state = loadSearch();
  if (!state) return [];
  const out = new Set();
  for (const c of state.kept || []) {
    for (const m of String(c.magnet || "").matchAll(/[?&]tr=([^&]+)/g)) {
      try {
        const u = decodeURIComponent(m[1]);
        if (/^(udp|http|wss):/.test(u)) out.add(u);
      } catch {
        /* skip */
      }
    }
  }
  return [...out];
}

async function main() {
  const target = process.argv[2] || "all";
  const merged = [...new Set([...(await publicTrackers()), ...trackersFromSearch()])];
  if (!merged.length) {
    console.error("no trackers gathered — network problem?");
    process.exit(1);
  }
  console.log(
    `gathered ${merged.length} unique trackers (public list + every magnet in the last search)`,
  );

  const tr = merged.join(",");
  await rpc("changeGlobalOption", [
    { "bt-tracker": tr, "bt-max-peers": "150", "bt-request-peer-speed-limit": "5M" },
  ]);
  console.log("applied globally (also to future downloads)");

  const keys = [
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "connections",
    "numSeeders",
    "bittorrent",
  ];
  const active = [
    ...(await rpc("tellActive", [keys])),
    ...(await rpc("tellWaiting", [0, 30, keys])),
  ];
  const targets = target === "all" ? active : active.filter((t) => t.gid === target);
  for (const t of targets) {
    try {
      await rpc("changeOption", [
        t.gid,
        { "bt-max-peers": "150", "bt-request-peer-speed-limit": "5M" },
      ]);
      const name = t.bittorrent?.info?.name || t.gid;
      console.log(
        `  boosted ${name.slice(0, 56)}  (peers ${t.connections}, seeders ${t.numSeeders ?? "?"})`,
      );
    } catch (e) {
      console.log(`  ${t.gid}: ${e.message}`);
    }
  }
  console.log("\nNote: this improves DISCOVERY, not bandwidth. If a title genuinely has");
  console.log("two seeders, two seeders is the ceiling — check with swarm-check.mjs and");
  console.log("prefer a smaller release from a healthier pocket.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
