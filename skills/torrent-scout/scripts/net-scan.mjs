#!/usr/bin/env node
import crypto from "node:crypto";
// net-scan.mjs — cast the net wide, then remember what answered.
//
// Four surfaces, one map (lib/netmap.mjs):
//
//   trackers  the announce layer. Fetch the curated lists, resolve every
//             hostname, probe every endpoint with a real handshake, and keep
//             the ones that answer FROM HERE.
//   sites     the indexer layer. Jackett already ships 554 site definitions
//             with their mirror histories; probing them turns a static file
//             into a live "which door is open today" table.
//   dht       the peer layer, and the only one that answers "what is alive
//             RIGHT NOW". Every node hands you more nodes; every incoming
//             get_peers is a stranger telling you what they are downloading
//             at this second.
//   scrape    the popularity oracle. Given an infohash, ask every alive
//             tracker how big the swarm is.
//
// The design bias throughout: a list is a hypothesis, a probe is evidence.
// Nothing enters the map as "working" because a README said so.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadMap,
  saveMap,
  upsertNode,
  recordProbe,
  noteInfohash,
  noteSource,
  summary,
  aliveNodes,
  operatorClusters,
  MAP_PATH,
} from "../lib/netmap.mjs";
import {
  parseTrackerUrl,
  udpConnect,
  udpScrape,
  httpAnnounce,
  httpSite,
  resolveHost,
  pool,
} from "../lib/probe.mjs";

/* ------------------------------------------------------------------ */
/* Sources. Every URL here is a claim that gets demoted when it 404s.  */
/* Counts in comments are the 2026-09-06 measurement — shape, not law. */
/* ------------------------------------------------------------------ */
const TRACKER_LISTS = [
  // ngosang: rebuilt daily ~22:10 UTC. best.txt probed 15/15 alive.
  [
    "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
    "ngosang/best",
  ],
  ["https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt", "ngosang/all"],
  // XIU2: wider, still curated, ~80% alive.
  ["https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt", "xiu2/best"],
  ["https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt", "xiu2/all"],
  // hezhijie0327: aggregates several upstreams, committed daily.
  [
    "https://raw.githubusercontent.com/hezhijie0327/Trackerslist/main/trackerslist_tracker.txt",
    "hezhijie/all",
  ],
  // newTrackon: the only source with MEASURED uptime history rather than a snapshot.
  ["https://newtrackon.com/api/stable", "newtrackon/stable"],
  ["https://newtrackon.com/api/live", "newtrackon/live"],
  ["https://newtrackon.com/api/all", "newtrackon/all"],
];

// Community list PAGES. These are HTML, not text files — the extractor below
// pulls announce URLs out of any markup, because a tracker list published in a
// <table> is still a tracker list. Verified reachable 2026-09-06 via search.
const TRACKER_PAGES = [
  ["https://www.torrenttracker.org/stable-torrent-trackers", "page:torrenttracker.org"],
  ["https://tinytorrent.net/best-torrent-tracker-list-updated/", "page:tinytorrent"],
  ["https://torrends.to/torrent-tracker-list/", "page:torrends"],
  ["https://anonymiz.com/blog/best-public-torrent-trackers-2026", "page:anonymiz"],
];

// ngosang publishes its own rejects. A tracker on this list has already been
// judged and dropped by someone who probes daily — cheaper than rediscovering it.
const BLACKLIST_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/master/blacklist.txt";

// BEP 5 bootstrap nodes. The whole DHT unfolds from these four addresses.
const DHT_BOOTSTRAP = [
  "router.bittorrent.com:6881",
  "dht.transmissionbt.com:6881",
  "router.utorrent.com:6881",
  "dht.libtorrent.org:25401",
  "dht.aelitis.com:6881", // Vuze, CNAME into EC2 — resolve at runtime, never bake the IP
];

// Structured search backends — JSON/RSS surfaces that answer without a browser,
// a key or a Cloudflare challenge. Each entry is a live query, because "the
// domain resolves" and "the API answers" are different questions.
const SEARCH_APIS = [
  [
    "apibay",
    "https://apibay.org/q.php?q=ubuntu&cat=0",
    "json",
    "The Pirate Bay's own backend — no key, no CF",
  ],
  [
    "bitsearch",
    "https://bitsearch.to/api/v1/search?q=ubuntu",
    "json",
    "seed/leech/size/category; rate-limits with 500s",
  ],
  [
    "torrents-csv",
    "https://torrents-csv.com/service/search?q=ubuntu&size=20",
    "json",
    "small, clean, open dataset",
  ],
  [
    "bt4g-rss",
    "https://bt4g.org/search/ubuntu/1?page=rss",
    "rss",
    "DHT-derived; the RSS path avoids the CF wall",
  ],
  [
    "archive.org",
    "https://archive.org/advancedsearch.php?q=btih%3A*&rows=1&output=json",
    "json",
    "fully legal, 88M items carry a btih",
  ],
  ["nyaa-rss", "https://nyaa.si/?page=rss", "rss", "the uploaded-right-now firehose"],
  ["eztv-rss", "https://eztvx.to/ezrss.xml", "rss", "TV firehose"],
  [
    "solidtorrents",
    "https://solidtorrents.to/api/v1/search?q=ubuntu",
    "json",
    "sibling of bitsearch",
  ],
];

const JACKETT_DEFS = [
  path.join(os.homedir(), ".local/share/jackett/Jackett/Definitions"),
  path.join(os.homedir(), ".config/Jackett/Definitions"),
  "/opt/Jackett/Definitions",
];

const log = (...a) => console.log(...a);
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? true) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

async function getText(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": "torrent-scout/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ================================================================== */
/* trackers                                                            */
/* ================================================================== */
/** Announce URLs out of anything — a plain list, or a page that renders one. */
function extractAnnounces(body) {
  if (!body.includes("<")) return body.split("\n");
  const hits = body.match(/\b(?:udp|https?):\/\/[^\s"'<>()\\]+/gi) || [];
  return hits.filter((u) => /\/announce|:\d{2,5}\/?$/.test(u));
}

async function cmdTrackers(map) {
  const limit = Number(arg("limit", 0));
  log("· fetching tracker lists");
  let blacklist = new Set();
  try {
    const bl = await getText(BLACKLIST_URL);
    blacklist = new Set(
      bl
        .split("\n")
        .map((l) => parseTrackerUrl(l)?.host)
        .filter(Boolean),
    );
    log(`  blacklist: ${blacklist.size} hosts already judged dead upstream`);
  } catch {
    log("  blacklist: unavailable");
  }

  let found = 0;
  const sources = has("no-pages") ? TRACKER_LISTS : [...TRACKER_LISTS, ...TRACKER_PAGES];
  for (const [url, label] of sources) {
    try {
      const txt = await getText(url);
      const entries = extractAnnounces(txt).map(parseTrackerUrl).filter(Boolean);
      noteSource(map, url, { ok: true, count: entries.length, note: label });
      let added = 0;
      for (const e of entries) {
        if (blacklist.has(e.host)) continue;
        const before = !!map.nodes[e.id];
        upsertNode(
          map,
          { id: e.id, kind: "tracker", host: e.host, port: e.port, scheme: e.scheme },
          { from: `list:${label}` },
        );
        map.nodes[e.id].path = e.path;
        if (!before) added++;
      }
      found += entries.length;
      log(`  ${label.padEnd(20)} ${String(entries.length).padStart(5)} entries, ${added} new`);
    } catch (e) {
      noteSource(map, url, { ok: false, note: `${label}: ${e.message}` });
      log(`  ${label.padEnd(20)} FAILED — ${e.message}`);
    }
  }

  let targets = Object.values(map.nodes).filter((n) => n.kind === "tracker");
  if (has("only-unknown")) targets = targets.filter((n) => n.status === "unknown");
  if (limit) targets = targets.slice(0, limit);
  log(`· resolving ${targets.length} hostnames`);
  const ipMap = await pool(targets, 60, async (n) => resolveHost(n.host));

  log(`· probing ${targets.length} trackers (announce handshake, from HERE)`);
  const t0 = Date.now();
  let alive = 0;
  await pool(targets, 40, async (n, i) => {
    const ips = ipMap[i] || [];
    let r;
    if (n.scheme === "udp") r = await udpConnect(n.host, n.port);
    else if (n.scheme === "http" || n.scheme === "https") r = await httpAnnounce(n);
    else r = { ok: false, error: `${n.scheme} not probed` }; // ws/wss need a WS client
    recordProbe(map, n.id, {
      ok: r.ok,
      latencyMs: r.latencyMs ?? null,
      ips,
      note: r.error || null,
    });
    if (r.ok) alive++;
  });
  log(`  ${alive}/${targets.length} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const clusters = operatorClusters(map);
  log(`· ${clusters.length} shared-IP clusters — hostnames that are one machine`);
  for (const [ip, ids] of clusters.slice(0, 5)) log(`  ${ip.padEnd(16)} ${ids.length} hostnames`);
  return { found, alive };
}

/* ================================================================== */
/* sites — the indexer layer, from Jackett's own definitions           */
/* ================================================================== */
function readJackettDefs() {
  const dir = JACKETT_DEFS.find((d) => fs.existsSync(d));
  if (!dir) return { dir: null, defs: [] };
  const defs = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    const id = txt.match(/^id:\s*(\S+)/m)?.[1] || f.replace(/\.yml$/, "");
    const type = txt.match(/^type:\s*(\S+)/m)?.[1] || "unknown";
    // Deliberately a line scanner, not a YAML parse: these files carry inline
    // comments on the very lines we want ("# keyword search not working"),
    // and the comment is information worth keeping.
    const grab = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\n((?:\\s+-\\s+\\S+.*\\n)+)`, "m"));
      if (!m) return [];
      return m[1]
        .split("\n")
        .map((l) => {
          const mm = l.match(/^\s+-\s+(\S+)\s*(?:#\s*(.*))?$/);
          return mm ? { url: mm[1], note: mm[2] || null } : null;
        })
        .filter(Boolean);
    };
    defs.push({ id, type, file: f, links: grab("links"), legacy: grab("legacylinks") });
  }
  return { dir, defs };
}

async function cmdSites(map) {
  const { dir, defs } = readJackettDefs();
  if (!dir) {
    log("· no Jackett definitions found — skipping sites");
    return { found: 0, alive: 0 };
  }
  const wantAll = has("all-types");
  const chosen = defs.filter((d) => wantAll || d.type === "public");
  log(
    `· ${defs.length} definitions at ${dir} — ${chosen.length} ${wantAll ? "(all types)" : "public"}`,
  );

  const targets = [];
  for (const d of chosen) {
    for (const { url, note } of d.links) targets.push({ url, def: d, kind: "primary", note });
    if (!has("no-legacy"))
      for (const { url, note } of d.legacy) targets.push({ url, def: d, kind: "legacy", note });
  }
  for (const t of targets) {
    let origin;
    try {
      origin = new URL(t.url).origin;
    } catch {
      continue;
    }
    upsertNode(
      map,
      {
        id: origin,
        kind: "site",
        host: new URL(t.url).hostname,
        scheme: new URL(t.url).protocol.replace(":", ""),
      },
      { from: `jackett:${t.def.id}:${t.kind}` },
    );
    if (t.note) map.nodes[origin].note = t.note;
    map.nodes[origin].indexer = t.def.id;
    map.nodes[origin].mirrorOf = t.kind === "legacy" ? t.def.id : null;
  }

  let list = Object.values(map.nodes).filter((n) => n.kind === "site");
  if (has("only-unknown")) list = list.filter((n) => n.status === "unknown");
  const limit = Number(arg("limit", 0));
  if (limit) list = list.slice(0, limit);
  log(`· probing ${list.length} site origins`);
  const t0 = Date.now();
  let alive = 0;
  await pool(list, 20, async (n) => {
    const ips = await resolveHost(n.host);
    const r = await httpSite(n.id + "/");
    recordProbe(map, n.id, {
      ok: r.ok,
      latencyMs: r.latencyMs ?? null,
      ips,
      note: r.error || r.title || null,
    });
    if (r.finalUrl) {
      try {
        const fin = new URL(r.finalUrl).origin;
        // A redirect to another origin is the site TELLING you its current
        // address — the single most valuable thing a dead mirror can say.
        if (fin !== n.id) {
          upsertNode(
            map,
            { id: fin, kind: "site", host: new URL(fin).hostname, scheme: "https" },
            { from: `redirect:${n.id}`, via: n.id },
          );
          map.nodes[fin].indexer = n.indexer;
        }
      } catch {}
    }
    if (r.ok) alive++;
  });
  log(`  ${alive}/${list.length} reachable in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { found: list.length, alive };
}

/* ================================================================== */
/* apis — structured backends that answer without a browser            */
/* ================================================================== */
async function cmdApis(map) {
  log(`· probing ${SEARCH_APIS.length} search backends with a REAL query`);
  let alive = 0;
  await pool(SEARCH_APIS, 6, async ([name, url, fmt, note]) => {
    const origin = new URL(url).origin;
    upsertNode(
      map,
      { id: origin, kind: "api", host: new URL(url).hostname, scheme: "https" },
      { from: `api:${name}` },
    );
    map.nodes[origin].note = note;
    map.nodes[origin].probeUrl = url;
    map.nodes[origin].format = fmt;
    const ips = await resolveHost(new URL(url).hostname);
    const started = Date.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    let ok = false;
    let why = null;
    let items = null;
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        },
      });
      const body = await res.text();
      if (!res.ok) why = `HTTP ${res.status}`;
      else if (fmt === "json") {
        const j = JSON.parse(body);
        // An API that answers 200 with zero rows is not a working search
        // backend; count the rows or you are testing DNS, not the service.
        const arr = Array.isArray(j) ? j : j.torrents || j.results || j.response?.docs || [];
        items = Array.isArray(arr) ? arr.length : null;
        ok = items != null && items > 0;
        why = ok ? null : "answered but returned no rows";
      } else {
        items = (body.match(/<item[\s>]/g) || []).length;
        ok = items > 0;
        why = ok ? null : "no <item> elements";
      }
    } catch (e) {
      why = e.name === "AbortError" ? "timeout" : e.cause?.code || e.message;
    } finally {
      clearTimeout(t);
    }
    recordProbe(map, origin, { ok, latencyMs: ok ? Date.now() - started : null, ips, note: why });
    if (ok) alive++;
    log(
      `  ${name.padEnd(14)} ${ok ? "OK  " : "FAIL"}  ${String(items ?? "-").padStart(5)} rows  ${why || note}`,
    );
  });
  log(`  ${alive}/${SEARCH_APIS.length} backends answering`);
  return { found: SEARCH_APIS.length, alive };
}

/* ================================================================== */
/* dht — the live layer                                                */
/* ================================================================== */
async function cmdDht(map) {
  const { default: DHT } = await import("bittorrent-dht");
  const seconds = Number(arg("seconds", 90));
  const dht = new DHT({ bootstrap: DHT_BOOTSTRAP, maxTables: 2000 });
  const stats = { nodes: 0, getPeers: 0, announces: 0, samples: 0, sampled: 0, buckets: 0 };
  const seenNodes = new Set();
  // Our OWN pool of every node the walk has ever seen.
  //
  // Measured 2026-09-06: sampling from `dht._rpc.nodes` reached only 35 of 256
  // keyspace buckets however hard the walk was pushed — but the nodes actually
  // DISCOVERED spanned 175 of 256, evenly (the top three buckets held 7% of
  // them). The ceiling was never discovery. A Kademlia routing table is built
  // to retain nodes NEAR our own id and evict the rest, so it was throwing away
  // exactly the far-keyspace nodes that BEP 51 coverage depends on. Keeping our
  // own copy costs a few MB and is the difference between reading one
  // neighbourhood and reading the network.
  const nodePool = new Map();

  for (const b of DHT_BOOTSTRAP) {
    const [h, p] = b.split(":");
    upsertNode(
      map,
      { id: `dht://${h}:${p}`, kind: "dht", host: h, port: Number(p) },
      { from: "bep5:bootstrap" },
    );
  }

  dht.on("node", (n) => {
    const id = `dht://${n.host}:${n.port}`;
    if (seenNodes.has(id)) return;
    seenNodes.add(id);
    stats.nodes++;
    // Only the first ~4000 go to disk. The DHT is effectively unbounded; the
    // map is for nodes worth calling again, not a census of the internet.
    if (n.id && nodePool.size < 30000) nodePool.set(id, { host: n.host, port: n.port, id: n.id });
    if (stats.nodes <= 4000) {
      upsertNode(
        map,
        { id, kind: "dht", host: n.host, port: n.port },
        { from: "dht:walk", via: "dht" },
      );
      map.nodes[id].status = "alive";
      map.nodes[id].lastAlive = new Date().toISOString();
      map.nodes[id].nodeId = n.id?.toString?.("hex")?.slice(0, 12) || null;
    }
  });
  // A stranger asking us for peers on an infohash is a stranger downloading it
  // right now. This is the freshest signal in the whole system.
  dht.on("get_peers", (ih) => {
    stats.getPeers++;
    noteInfohash(map, ih.toString("hex"), { how: "get_peers", via: "dht" });
  });
  dht.on("announce_peer", (ih, peer) => {
    stats.announces++;
    noteInfohash(map, ih.toString("hex"), {
      how: "announce_peer",
      via: `${peer.host}:${peer.port}`,
    });
  });

  await new Promise((res) => {
    dht.listen(0, res);
  });
  log(`· DHT listening on :${dht.address().port}, crawling for ${seconds}s`);

  // Two engines run at once. The lookups churn our routing table and get us
  // into other peers' tables (which is what makes the passive get_peers stream
  // start flowing at all). sample_infohashes is BEP 51 — the sanctioned way to
  // ASK a node what it has seen instead of waiting to be told.
  const stop = Date.now() + seconds * 1000;
  // Node discovery is the measured bottleneck, not query rate: a 150 s crawl
  // reached only 34 of 256 keyspace buckets, and every node reports a 6 h
  // sampling interval. One sequential lookup at a time wastes the wait. These
  // run concurrently, each walking toward a different random target, so the
  // routing table fills from many directions at once.
  const LANES = Number(arg("lanes", 8));
  const churn = async () => {
    await Promise.all(
      Array.from({ length: LANES }, async () => {
        while (Date.now() < stop) {
          await new Promise((r) => dht.lookup(crypto.randomBytes(20), () => r()));
        }
      }),
    );
  };
  const sample = async () => {
    while (Date.now() < stop) {
      // Sample from OUR pool, not the routing table — see nodePool above.
      const nodes = nodePool.size ? [...nodePool.values()] : dht._rpc?.nodes?.toArray?.() || [];
      if (!nodes.length) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // Stratify by keyspace. A DHT node stores infohashes NEAR ITS OWN ID, so
      // BEP 51 samples are local by construction — measured here on 2026-09-06:
      // node 203a0574… returned 14 hashes all starting 203a0, node 52881b87…
      // returned hashes starting 5288. Sampling whichever nodes the routing
      // table happens to hold therefore re-reads one neighbourhood over and
      // over. Bucketing by the first id byte and taking one per bucket spreads
      // the same number of queries across the whole 160-bit space.
      const buckets = new Map();
      for (const n of nodes) {
        const b = n.id?.[0] ?? 0;
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(n);
      }
      const keys = [...buckets.keys()].sort(() => Math.random() - 0.5);
      const batch = keys.slice(0, 24).map((k) => {
        const arr = buckets.get(k);
        return arr[Math.floor(Math.random() * arr.length)];
      });
      stats.buckets = buckets.size;
      await pool(
        batch,
        12,
        (node) =>
          new Promise((res) => {
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
                  const samples = reply?.r?.samples;
                  if (samples && samples.length >= 20) {
                    stats.sampled++;
                    for (let i = 0; i + 20 <= samples.length; i += 20) {
                      stats.samples++;
                      noteInfohash(map, samples.subarray(i, i + 20).toString("hex"), {
                        how: "bep51:sample",
                        via: `${node.host}:${node.port}`,
                      });
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
          }),
      );
    }
  };
  const tick = setInterval(() => {
    log(
      `  nodes ${stats.nodes} · get_peers ${stats.getPeers} · announces ${stats.announces}` +
        ` · bep51 ${stats.samples} from ${stats.sampled} nodes · keyspace buckets ${stats.buckets}/256`,
    );
  }, 15000);

  await Promise.all([churn(), sample()]);
  clearInterval(tick);
  dht.destroy();
  log(
    `· crawl done — ${stats.nodes} nodes, ${Object.keys(map.infohashes).length} infohashes in map`,
  );
  return stats;
}

/* ================================================================== */
/* scrape — how big is this swarm, according to everyone               */
/* ================================================================== */
async function cmdScrape(map) {
  let hashes = process.argv
    .slice(3)
    .filter((a) => /^[0-9a-f]{40}$/i.test(a))
    .map((h) => h.toLowerCase());
  if (!hashes.length) {
    // No argument: ask about whatever the DHT most recently saw. That is the
    // "what is hot right now" question, answered from our own observations.
    hashes = Object.values(map.infohashes)
      .sort((a, b) => b.hits - a.hits || (b.lastSeen < a.lastSeen ? -1 : 1))
      .slice(0, Number(arg("top", 20)))
      .map((h) => h.hash);
  }
  if (!hashes.length) {
    log("· nothing to scrape — run `dht` first");
    return {};
  }
  const trackers = aliveNodes(map, "tracker", Number(arg("trackers", 12))).filter(
    (n) => n.scheme === "udp",
  );
  log(`· scraping ${hashes.length} infohashes across ${trackers.length} alive UDP trackers`);
  const totals = {};
  await pool(trackers, 8, async (t) => {
    const r = await udpScrape(t.host, t.port, hashes);
    if (!r.ok) return;
    for (const [h, s] of Object.entries(r.swarms)) {
      const cur = totals[h] || { seeders: 0, leechers: 0, sources: 0 };
      // Trackers see overlapping slices of one swarm, so summing would inflate.
      // The max is the honest floor: at least this many peers exist.
      cur.seeders = Math.max(cur.seeders, s.seeders);
      cur.leechers = Math.max(cur.leechers, s.leechers);
      if (s.seeders || s.leechers) cur.sources++;
      totals[h] = cur;
    }
  });
  const rows = Object.entries(totals).sort((a, b) => b[1].seeders - a[1].seeders);
  log("");
  log("  seeders  leech  trkrs  infohash");
  for (const [h, s] of rows.slice(0, 40)) {
    if (s.seeders || s.leechers) noteInfohash(map, h, { peers: s.seeders + s.leechers });
    log(
      `  ${String(s.seeders).padStart(7)}  ${String(s.leechers).padStart(5)}  ${String(s.sources).padStart(5)}  ${h}`,
    );
  }
  return totals;
}

/* ================================================================== */
/* map — what do we know                                               */
/* ================================================================== */
function cmdMap(map) {
  const s = summary(map);
  log(`\nNET MAP  ${MAP_PATH}`);
  log(`updated ${s.updatedAt || "never"}`);
  log(
    `\n  nodes ${s.nodes}   alive ${s.alive}   infohashes ${s.infohashes}   sources ${s.sources}`,
  );
  log(`  by kind   ${JSON.stringify(s.byKind)}`);
  log(`  by status ${JSON.stringify(s.byStatus)}`);

  for (const kind of ["tracker", "site", "dht"]) {
    const alive = aliveNodes(map, kind, 12);
    if (!alive.length) continue;
    log(`\n  fastest ${kind}s:`);
    for (const n of alive) {
      log(
        `    ${String(n.latencyMs ?? "—").padStart(6)}ms  ${n.id.slice(0, 58).padEnd(58)}` +
          `  ${(n.from[0] || "").slice(0, 26)}`,
      );
    }
  }
  const hot = Object.values(map.infohashes)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 15);
  if (hot.length) {
    log("\n  most-seen infohashes (live demand, this observer):");
    for (const h of hot) {
      log(
        `    ${String(h.hits).padStart(4)}x  ${h.hash}  ${h.how.join(",").padEnd(22)}` +
          `${h.peers != null ? h.peers + " peers" : ""}`,
      );
    }
  }
  const cl = operatorClusters(map);
  if (cl.length) {
    log(`\n  shared-IP clusters (one operator, many names): ${cl.length}`);
    for (const [ip, ids] of cl.slice(0, 6))
      log(`    ${ip.padEnd(16)} ${ids.length}  ${ids.slice(0, 3).join(" ")}`);
  }
  log("");
}

/* ================================================================== */
async function main() {
  const cmd = process.argv[2] || "map";
  const map = loadMap();
  const started = Date.now();
  try {
    if (cmd === "trackers") await cmdTrackers(map);
    else if (cmd === "sites") await cmdSites(map);
    else if (cmd === "apis") await cmdApis(map);
    else if (cmd === "dht") await cmdDht(map);
    else if (cmd === "scrape") await cmdScrape(map);
    else if (cmd === "all") {
      await cmdTrackers(map);
      saveMap(map);
      await cmdSites(map);
      saveMap(map);
      await cmdApis(map);
      saveMap(map);
      await cmdDht(map);
      saveMap(map);
      await cmdScrape(map);
    } else if (cmd === "map") {
      cmdMap(map);
      return;
    } else {
      log(
        "usage: net-scan.mjs <trackers|sites|dht|scrape|all|map> [--seconds N] [--limit N] [--only-unknown]",
      );
      return;
    }
  } finally {
    if (cmd !== "map") {
      map.runs = [
        ...(map.runs || []),
        { cmd, at: new Date().toISOString(), ms: Date.now() - started },
      ].slice(-40);
      saveMap(map);
      log(`\n· map saved → ${MAP_PATH}`);
      cmdMap(map);
    }
  }
}
main().catch((e) => {
  console.error("net-scan failed:", e);
  process.exit(1);
});
