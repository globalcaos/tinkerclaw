#!/usr/bin/env node
// net-resolve.mjs — turn harvested infohashes into NAMES.
//
// The DHT hands you 20 anonymous bytes. This asks the swarm what those bytes
// are, over BEP 9 (metadata exchange), and writes the answer into the map. No
// tracker, no indexer, no API key — the peers themselves are the catalogue.
//
// Why it is trustworthy: the metadata blob IS the torrent's `info` dict, and
// the infohash IS its SHA-1. So a peer cannot lie about what it is sending —
// we recompute the hash and drop anything that does not match. That check is
// the difference between "a peer told me" and "I know".
//
// Why it is only ~1 in 3: most harvested infohashes have no reachable peer
// right now — NAT, a dead swarm, a peer that rejects metadata requests. That is
// a property of the network, not a bug, so this fans out across many hashes and
// many peers at once instead of retrying one.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { loadMap, saveNames, loadNames } from "../lib/netmap.mjs";

const require = createRequire(import.meta.url);
const DHT = (await import("bittorrent-dht")).default;
const Wire = (await import("bittorrent-protocol")).default;
const utMetadata = (await import("ut_metadata")).default;
const bencode = (await import("bencode")).default;

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const WANT = Number(arg("count", 24));
const PER_HASH_MS = Number(arg("timeout", 45)) * 1000;
const MAX_PEERS = Number(arg("peers", 30));
const log = (...a) => console.log(...a);

const map = loadMap();
let pool = process.argv
  .slice(2)
  .filter((a) => /^[0-9a-f]{40}$/i.test(a))
  .map((h) => h.toLowerCase());
if (!pool.length) {
  pool = Object.values(map.infohashes)
    .filter((h) => !h.name)
    .sort((a, b) => b.hits - a.hits || (a.lastSeen < b.lastSeen ? 1 : -1))
    .slice(0, WANT)
    .map((h) => h.hash);
}
if (!pool.length) {
  log("nothing unnamed to resolve — run `net-scan.mjs dht` first");
  process.exit(0);
}

const dht = new DHT({
  bootstrap: [
    "router.bittorrent.com:6881",
    "dht.transmissionbt.com:6881",
    "router.utorrent.com:6881",
    "dht.libtorrent.org:25401",
    "dht.aelitis.com:6881",
  ],
});
const peerId = Buffer.concat([Buffer.from("-TS0001-"), crypto.randomBytes(12)]);
const results = new Map();
const tried = new Map();

function attempt(hex, peer) {
  const seen = tried.get(hex) || new Set();
  const key = `${peer.host}:${peer.port}`;
  if (seen.has(key) || seen.size >= MAX_PEERS || results.has(hex)) return;
  seen.add(key);
  tried.set(hex, seen);

  const ih = Buffer.from(hex, "hex");
  const sock = net.connect(peer.port, peer.host);
  sock.setTimeout(12000);
  const kill = () => {
    try {
      sock.destroy();
    } catch {}
  };
  sock.on("error", kill);
  sock.on("timeout", kill);
  sock.on("connect", () => {
    const wire = new Wire();
    wire.use(utMetadata());
    sock.pipe(wire).pipe(sock);
    wire.on("error", kill);
    wire.handshake(ih, peerId, { dht: true });
    wire.on("handshake", () => {
      try {
        wire.ut_metadata.fetch();
      } catch {
        kill();
      }
    });
    wire.ut_metadata.on("metadata", (raw) => {
      if (results.has(hex)) return kill();
      try {
        const d = bencode.decode(raw);
        const info = d.info || d;
        // The integrity check that makes this evidence rather than hearsay.
        const blob = d.info ? bencode.encode(d.info) : raw;
        const check = crypto.createHash("sha1").update(blob).digest("hex");
        if (check !== hex) {
          kill();
          return;
        }
        const name = Buffer.from(info.name).toString();
        let size = 0;
        let nfiles = 1;
        const sample = [];
        if (info.files) {
          nfiles = info.files.length;
          for (const f of info.files) {
            size += Number(f.length);
            if (sample.length < 5)
              sample.push(f.path.map((p) => Buffer.from(p).toString()).join("/"));
          }
        } else {
          size = Number(info.length);
          sample.push(name);
        }
        results.set(hex, { name, size, nfiles, sample, from: `${peer.host}:${peer.port}` });
        log(
          `  ✓ ${hex.slice(0, 12)}…  ${(size / 1073741824).toFixed(2)} GB  ${nfiles} file(s)  ${name.slice(0, 62)}`,
        );
      } catch {
        /* a malformed blob is just another dead peer */
      }
      kill();
    });
  });
}

dht.on("peer", (peer, hash) => attempt(hash.toString("hex"), peer));
dht.listen(0, () => {
  log(
    `· resolving ${pool.length} infohashes over BEP 9 (${PER_HASH_MS / 1000}s budget, up to ${MAX_PEERS} peers each)`,
  );
  for (const h of pool) dht.lookup(h);
  // Re-look-up midway: peers arrive continuously, and a second sweep costs
  // nothing while the process is already sitting there waiting.
  setTimeout(() => {
    for (const h of pool) if (!results.has(h)) dht.lookup(h);
  }, PER_HASH_MS / 2);
});

setTimeout(() => {
  const batch = {};
  for (const [hex, r] of results) {
    batch[hex] = {
      name: r.name,
      size: r.size,
      nfiles: r.nfiles,
      sample: r.sample,
      metaFrom: r.from,
      resolvedAt: new Date().toISOString(),
    };
  }
  // Write ONLY names.json — the harvester owns net-map.json and would otherwise
  // revert these on its next save.
  const named = saveNames(batch);
  log(
    `\n· resolved ${results.size}/${pool.length} this run (${((results.size / pool.length) * 100).toFixed(0)}%)`,
  );
  log(`· ${named} named torrents on record, of ${Object.keys(map.infohashes).length} infohashes`);
  dht.destroy();
  process.exit(0);
}, PER_HASH_MS);
