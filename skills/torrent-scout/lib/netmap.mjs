// netmap.mjs — the persistent map of the torrent network.
//
// The point of this file is MEMORY. A scan that only prints is a scan you have
// to run again; a scan that writes here gets cheaper every time, because the
// next run already knows which of 3,000 trackers answered last week and which
// have been dead for a month.
//
// Three record types, one file:
//
//   nodes       — anything you can send a request to: trackers, DHT nodes,
//                 indexer sites and their mirrors, JSON APIs. Keyed by a
//                 canonical id (`udp://host:port`, `dht://host:port`, an https
//                 origin) so the same thing found twice merges instead of
//                 duplicating.
//   infohashes  — torrents observed to be ALIVE, with when and by whom. This is
//                 the perishable part: a tracker list ages in months, an
//                 infohash sighting ages in hours.
//   sources     — where node lists themselves come from, so a list URL that
//                 rots is demoted like any other dead node.
//
// Provenance is a first-class field. `from` is an array, not a string: the same
// tracker turns up in four lists and being in four is evidence. `discoveredVia`
// answers "which node led me here", which is the whole point of walking a
// network rather than reading a list of it.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

export const MAP_PATH = path.join(STATE_DIR, "net-map.json");
// Names live in their own file, and that is not tidiness — it is correctness.
// The harvester holds the whole map in memory for minutes at a time; when the
// resolver also wrote the map, the harvester's next save silently reverted every
// name it had just added (observed 2026-09-06: 53 named -> 44). Two writers, one
// file, last-write-wins. Now each file has exactly ONE writer and readers merge.
export const NAMES_PATH = path.join(STATE_DIR, "names.json");

const EMPTY = {
  version: 1,
  updatedAt: null,
  nodes: {},
  infohashes: {},
  sources: {},
  runs: [],
};

export function loadNames() {
  try {
    return JSON.parse(fs.readFileSync(NAMES_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Merge the resolver's names onto an infohash table. Idempotent. */
export function applyNames(map, names = loadNames()) {
  for (const [hex, n] of Object.entries(names)) {
    const rec = map.infohashes[hex];
    if (rec) Object.assign(rec, n);
  }
  return map;
}

export function loadMap() {
  try {
    const m = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
    return applyNames({ ...EMPTY, ...m });
  } catch {
    return structuredClone(EMPTY);
  }
}

/** Resolver-owned. Never touches net-map.json. */
export function saveNames(entries) {
  const cur = loadNames();
  Object.assign(cur, entries);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${NAMES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 1));
  fs.renameSync(tmp, NAMES_PATH);
  return Object.keys(cur).length;
}

export function saveMap(map) {
  map.updatedAt = new Date().toISOString();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${MAP_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1));
  fs.renameSync(tmp, MAP_PATH);
  return MAP_PATH;
}

const nowIso = () => new Date().toISOString();

function pushUnique(arr, v, cap = 12) {
  if (!v) return arr;
  if (!arr.includes(v)) arr.push(v);
  return arr.length > cap ? arr.slice(-cap) : arr;
}

/** Add or merge a node. Never overwrites probe history with a bare re-sighting. */
export function upsertNode(map, node, { from = null, via = null } = {}) {
  const id = node.id;
  if (!id) throw new Error("upsertNode needs an id");
  const prev = map.nodes[id];
  const rec = prev || {
    id,
    kind: node.kind,
    host: node.host,
    port: node.port ?? null,
    scheme: node.scheme ?? null,
    ips: [],
    status: "unknown",
    latencyMs: null,
    probes: 0,
    fails: 0,
    firstSeen: nowIso(),
    lastSeen: nowIso(),
    lastProbe: null,
    lastAlive: null,
    from: [],
    discoveredVia: null,
    note: null,
  };
  rec.lastSeen = nowIso();
  if (node.kind && !rec.kind) rec.kind = node.kind;
  if (node.host && !rec.host) rec.host = node.host;
  if (node.port != null && rec.port == null) rec.port = node.port;
  if (from) rec.from = pushUnique(rec.from, from);
  // First node to lead us here keeps the credit — later sightings are not the
  // discovery, and overwriting would erase how the walk actually went.
  if (via && !rec.discoveredVia) rec.discoveredVia = via;
  if (!prev) map.nodes[id] = rec;
  return rec;
}

/** Fold one probe result into a node's history. */
export function recordProbe(map, id, { ok, latencyMs = null, note = null, ips = null }) {
  const rec = map.nodes[id];
  if (!rec) return null;
  rec.probes += 1;
  rec.lastProbe = nowIso();
  if (ips && ips.length) rec.ips = Array.from(new Set([...(rec.ips || []), ...ips])).slice(0, 8);
  if (ok) {
    rec.status = "alive";
    rec.lastAlive = rec.lastProbe;
    rec.latencyMs = latencyMs;
    rec.fails = 0;
  } else {
    rec.fails += 1;
    // One timeout is weather; three is a dead host. Anything that has never
    // once answered is not promoted to 'dead' either — it is just unproven,
    // and the distinction decides whether it is worth probing again.
    rec.status = rec.fails >= 3 ? "dead" : rec.lastAlive ? "flaky" : "unreachable";
    rec.latencyMs = null;
  }
  if (note) rec.note = note;
  return rec;
}

/** Record a torrent seen alive. `via` is the node that told us. */
export function noteInfohash(map, hex, { via = null, how = null, name = null, peers = null } = {}) {
  hex = String(hex).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  const rec = map.infohashes[hex] || {
    hash: hex,
    firstSeen: nowIso(),
    lastSeen: nowIso(),
    hits: 0,
    how: [],
    via: [],
    name: null,
    peers: null,
  };
  rec.lastSeen = nowIso();
  rec.hits += 1;
  if (how) rec.how = pushUnique(rec.how, how, 6);
  if (via) rec.via = pushUnique(rec.via, via, 6);
  if (name && !rec.name) rec.name = name;
  if (peers != null) rec.peers = peers;
  map.infohashes[hex] = rec;
  return rec;
}

export function noteSource(map, url, { ok, count = 0, note = null }) {
  const rec = map.sources[url] || { url, firstSeen: nowIso(), fetches: 0, fails: 0 };
  rec.fetches += 1;
  rec.lastFetch = nowIso();
  if (ok) {
    rec.ok = true;
    rec.count = count;
    rec.fails = 0;
  } else {
    rec.ok = false;
    rec.fails += 1;
  }
  if (note) rec.note = note;
  map.sources[url] = rec;
  return rec;
}

export function summary(map) {
  const nodes = Object.values(map.nodes);
  const by = (k) =>
    nodes.reduce((a, n) => {
      a[n[k]] = (a[n[k]] || 0) + 1;
      return a;
    }, {});
  const alive = nodes.filter((n) => n.status === "alive");
  return {
    nodes: nodes.length,
    byKind: by("kind"),
    byStatus: by("status"),
    alive: alive.length,
    infohashes: Object.keys(map.infohashes).length,
    sources: Object.keys(map.sources).length,
    updatedAt: map.updatedAt,
  };
}

/** Alive nodes of a kind, fastest first — what a downloader should actually use. */
export function aliveNodes(map, kind, limit = 100) {
  return Object.values(map.nodes)
    .filter((n) => n.kind === kind && n.status === "alive")
    .sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))
    .slice(0, limit);
}

/** Hosts that resolve to the same IP — one operator wearing several names. */
export function operatorClusters(map) {
  const byIp = {};
  for (const n of Object.values(map.nodes)) {
    for (const ip of n.ips || []) (byIp[ip] ||= []).push(n.id);
  }
  return Object.entries(byIp)
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
}
