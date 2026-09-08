#!/usr/bin/env node
// net-harvest.mjs — the map, kept alive.
//
// Every other script here is a snapshot. This one is the clock.
//
// The reason it must be a long-lived PROCESS rather than a repeated run: BEP 51
// says a single node can survey the whole DHT in a few hours, and the thing that
// makes that true is a routing table and node pool that keep GROWING. A fresh
// 4-minute run throws all of that away and re-bootstraps from four routers; an
// hour-old process is querying thousands of nodes it already knows. Measured
// here: 260 s from cold reached 113 of 256 keyspace buckets. Warm, it climbs.
//
// It also matters that this is a systemd unit and not something spawned from a
// chat turn. A subprocess launched by an agent turn dies when the turn ends —
// which is how you end up reporting that something is "running" when it was
// reaped minutes ago.
import crypto from "node:crypto";
import { loadMap, saveMap, upsertNode, noteInfohash, summary } from "../lib/netmap.mjs";
import { pool } from "../lib/probe.mjs";

const DHT = (await import("bittorrent-dht")).default;

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const LANES = Number(arg("lanes", 8));
const SAVE_EVERY_MS = Number(arg("save", 60)) * 1000;
const BATCH = Number(arg("batch", 24));

const BOOTSTRAP = [
  "router.bittorrent.com:6881",
  "dht.transmissionbt.com:6881",
  "router.utorrent.com:6881",
  "dht.libtorrent.org:25401",
  "dht.aelitis.com:6881",
];

let map = loadMap();
const nodePool = new Map();
const stats = { nodes: 0, samples: 0, sampled: 0, getPeers: 0, announces: 0, saves: 0 };
const startedAt = Date.now();
let dirty = false;

const dht = new DHT({ bootstrap: BOOTSTRAP, maxTables: 4000 });

dht.on("node", (n) => {
  const id = `dht://${n.host}:${n.port}`;
  if (nodePool.has(id)) return;
  stats.nodes++;
  if (n.id) nodePool.set(id, { host: n.host, port: n.port, id: n.id });
  // Only a bounded sample of nodes reaches disk. The pool is the working set;
  // the map is the part worth reloading tomorrow.
  if (stats.nodes <= 6000) {
    upsertNode(
      map,
      { id, kind: "dht", host: n.host, port: n.port },
      { from: "harvest", via: "dht" },
    );
    map.nodes[id].status = "alive";
    map.nodes[id].nodeId = n.id?.toString?.("hex")?.slice(0, 12) || null;
    dirty = true;
  }
});
dht.on("get_peers", (ih) => {
  stats.getPeers++;
  noteInfohash(map, ih.toString("hex"), { how: "get_peers", via: "dht" });
  dirty = true;
});
dht.on("announce_peer", (ih, peer) => {
  stats.announces++;
  noteInfohash(map, ih.toString("hex"), { how: "announce_peer", via: `${peer.host}:${peer.port}` });
  dirty = true;
});

function sampleFrom(node) {
  return new Promise((res) => {
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        res();
      }
    }, 3000);
    try {
      dht._rpc.query(
        node,
        { q: "sample_infohashes", a: { id: dht._rpc.id, target: crypto.randomBytes(20) } },
        (err, reply) => {
          clearTimeout(to);
          if (done) return;
          done = true;
          const s = reply?.r?.samples;
          if (s && s.length >= 20) {
            stats.sampled++;
            for (let i = 0; i + 20 <= s.length; i += 20) {
              stats.samples++;
              noteInfohash(map, s.subarray(i, i + 20).toString("hex"), {
                how: "bep51:sample",
                via: `${node.host}:${node.port}`,
              });
              dirty = true;
            }
          }
          res();
        },
      );
    } catch {
      clearTimeout(to);
      if (!done) {
        done = true;
        res();
      }
    }
  });
}

/** Spread queries across the id space — never sample the routing table, which
 *  evicts far-keyspace nodes by design. See references/network-map.md §5. */
function stratifiedBatch() {
  const buckets = new Map();
  for (const n of nodePool.values()) {
    const b = n.id[0];
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(n);
  }
  const keys = [...buckets.keys()].sort(() => Math.random() - 0.5).slice(0, BATCH);
  return {
    batch: keys.map((k) => {
      const a = buckets.get(k);
      return a[Math.floor(Math.random() * a.length)];
    }),
    coverage: buckets.size,
  };
}

let coverage = 0;
async function walk() {
  await Promise.all(
    Array.from({ length: LANES }, async () => {
      for (;;) await new Promise((r) => dht.lookup(crypto.randomBytes(20), () => r()));
    }),
  );
}
async function harvest() {
  for (;;) {
    if (!nodePool.size) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const { batch, coverage: c } = stratifiedBatch();
    coverage = c;
    await pool(batch, 12, sampleFrom);
  }
}

function persist() {
  if (!dirty) return;
  saveMap(map);
  dirty = false;
  stats.saves++;
  const s = summary(map);
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(
    `[${new Date().toISOString()}] +${mins}min  nodes=${s.nodes} alive=${s.alive} ` +
      `infohashes=${s.infohashes} | pool=${nodePool.size} coverage=${coverage}/256 ` +
      `bep51=${stats.samples} getpeers=${stats.getPeers} announces=${stats.announces}`,
  );
}

// A crash must not cost an hour of harvesting.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    persist();
    console.log("harvester stopped, map saved");
    process.exit(0);
  });
}
process.on("uncaughtException", (e) => {
  console.error("uncaught:", e.message);
  persist();
});

dht.listen(0, () => {
  console.log(
    `net-harvest up on :${dht.address().port} — ${LANES} lanes, saving every ${SAVE_EVERY_MS / 1000}s`,
  );
  setInterval(persist, SAVE_EVERY_MS);
  walk();
  harvest();
});
