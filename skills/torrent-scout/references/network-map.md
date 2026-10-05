# The network layer — casting the net wider than a search box

_Measured 2026-09-06 from one residential connection in Spain. Every count below
came from a probe run on this machine, not from a README. Counts are shape, not
constants: the lists rebuild daily and the DHT changes by the minute._

## Why this exists

A torrent search that only queries indexers inherits every one of their outages,
blocks and dead mirrors. The network underneath them is bigger, older and does
not go down: ~500 public trackers, ~500 indexer origins with their mirror
histories, and a DHT with millions of nodes that will tell you what is being
downloaded **right now** if you ask it properly.

`net-scan.mjs` walks all of it and writes what answered to `~/.torrent-scout/net-map.json`.
The map is the point — a scan that only prints is a scan you have to run again.

## The four surfaces

| command                 | what it walks                                        | measured 2026-09-06                              |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `net-scan.mjs trackers` | 8 curated lists + newTrackon + 4 HTML list pages     | 574 endpoints, **115 answered**                  |
| `net-scan.mjs sites`    | Jackett's 554 definitions (87 public) + every mirror | 485 origins, **250 reachable**                   |
| `net-scan.mjs dht`      | BEP 5 walk + BEP 51 sampling                         | 724 nodes, **2,383 live infohashes**             |
| `net-resolve.mjs`       | BEP 9 metadata from peers                            | **25–50%** of infohashes resolved to real titles |
| `net-scan.mjs apis`     | 8 keyless JSON/RSS search backends                   | **8/8 answering with real rows**                 |
| `net-scan.mjs scrape`   | UDP scrape across alive trackers                     | swarm size per infohash                          |

`net-scan.mjs map` prints what is known without touching the network.

## Findings that shaped the code

**1. Probe with the request a downloader actually makes.** `open.demonii.com`
answers `announce` in 659 ms and times out on `scrape`. Liveness measured by
scrape would file a working tracker as dead. The probers here use announce.

**2. Liveness is per-observer.** newTrackon's `/api/live` scored _worst_ of five
lists when probed from here (71%), while ngosang's `trackers_best.txt` scored
100%. That is not a contradiction — a tracker reachable from their vantage point
may be unreachable from yours. Any tool that matters must probe from where it
will actually announce from, which is why the map stores our own results rather
than importing someone's verdict.

**3. Hostnames collapse onto machines.** 71 shared-IP clusters found: 25
hostnames on `34.66.57.33`, 10 on `93.158.213.92`, and — the useful one — **10
hostnames resolving to `127.0.0.1`**, which is a dead domain sinkholed, not a
tracker. Deduplicate by IP before counting "coverage", or four names for one box
will read as four points of failure that are really one.

**4. BEP 51 samples are KEYSPACE-LOCAL, and this looks exactly like fraud.**
A first crawl produced infohashes clumping hard on 5-hex prefixes — 14 hashes
starting `203a0`, 15 starting `52883`. That is astronomically improbable for
SHA-1 outputs, and the obvious reading is a sybil node injecting fakes. It is
not. Checking each clump against the _supplying node's own DHT id_ settled it:
the `203a0…` hashes came from node `203a0574…`, the `5288…` hashes from
`52881b87…`. A DHT node stores infohashes near its own id, so its samples are
local **by construction**.

The consequence is a design change, not a filter: sampling whichever nodes the
routing table happens to hold re-reads one neighbourhood. `cmdDht` now buckets
nodes by the first byte of their id and takes one per bucket.

**5. Never sample from Kademlia's routing table — keep your own pool.**
_(This entry replaces an earlier conclusion in this same file, corrected
2026-09-06 by measurement rather than by argument.)_

The first read was "coverage is bound by node discovery": stratified sampling
reached only **34-35 of 256** keyspace buckets no matter how hard the walk was
pushed, and parallelising the `find_node` lanes 10× moved it to 35. Wrong
diagnosis. Counting the ids of every node actually **discovered** settled it —
they spanned **175 of 256** first bytes, evenly, with the top three buckets
holding just 7% of nodes.

Discovery was never the problem. `dht._rpc.nodes` is a Kademlia routing table,
and a Kademlia routing table is _built_ to retain nodes near your own id and
evict the rest. It was throwing away precisely the far-keyspace nodes BEP 51
coverage depends on. Keeping our own `nodePool` of every node seen and sampling
from that instead, same 260 s and same 10 lanes:

|                          | routing table | own node pool |
| ------------------------ | ------------- | ------------- |
| keyspace buckets reached | 35 / 256      | **113 / 256** |
| BEP 51 samples           | 7,260         | **12,783**    |
| new unique infohashes    | +835          | **+4,406**    |

**5.3× the unique yield for the same budget, from deleting one data source.**
The generalisable form: when a library hands you a collection, ask what it is
_optimised to forget_. A routing table is a cache with an eviction policy, not
an inventory — and an eviction policy tuned for lookup latency is actively
hostile to enumeration.

**6. The metadata check is what makes this evidence.** BEP 9 returns the
torrent's `info` dict, and the infohash is its SHA-1 — so `net-resolve.mjs`
recomputes the hash and drops any mismatch. A peer cannot lie about what it is
sending. Without that check you have hearsay from an anonymous stranger.

**7. Discovery never needs `announce_peer`.** The whole pipeline is read-only
with respect to the swarm, so torrent-scout's never-seed guarantee survives.

**8. Several "different" trackers are one backend.** opentrackr, therarbg.to and
publictracker.xyz returned byte-identical seeder counts for the same infohash.
Summing swarm sizes across trackers therefore double-counts; `cmdScrape` takes
the **max**, which is an honest floor ("at least this many peers exist") rather
than an inflated total.

**9. UDP scrape truncates silently.** Ask for 80 infohashes and 75 come back,
with no error and no indication which were dropped. The batch cap here is 74.

**10. A 500 is not always an outage.** bitsearch returned six consecutive 500s
mid-session and was fine 75 seconds later — that was rate limiting. This is why
`recordProbe` needs three consecutive failures before it will call a node dead,
and why a node that has answered before is marked `flaky`, not `dead`.

## Always-on: the map as a clock, not a snapshot

Every command above is a snapshot. Two systemd **user** units keep the map live,
because the perishable half of this data (what is being downloaded _right now_)
is worthless an hour late:

| unit                          | what it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `torrent-net-harvest.service` | long-lived DHT node: walks, samples BEP 51, writes the map every 60 s |
| `torrent-net-resolve.timer`   | every 15 min, names 40 more infohashes over BEP 9                     |

They are `Nice=10` and `IOSchedulingClass=idle` — background citizens.

`systemctl --user stop torrent-net-harvest.service torrent-net-resolve.timer`
stops both. They are **started but not `enable`d**, so they do not survive a
reboot until someone says so.

**Why a daemon and not a repeated run.** BEP 51's own spec claims a single node
can survey the whole DHT in a few hours, and what makes that true is a routing
table and node pool that keep _growing_. A cold 260 s run reached 113/256
keyspace buckets. The daemon, warm, climbed 49 → 69 → 86 in its first three
minutes and kept going — because it is querying thousands of nodes it already
knows instead of re-bootstrapping from four routers every time.

Second reason, learned the hard way: a process spawned from an agent turn is
reaped when the turn ends. If it is worth saying "this is running", it is worth
a unit file.

## The search backends worth having

Probed 2026-09-06, all eight returned real rows:

| backend                   | endpoint                                  | why                                                                                                                |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **apibay**                | `apibay.org/q.php?q=`                     | The Pirate Bay's own JSON backend. No key, no user-agent games, no Cloudflare. The best single HTTP surface found. |
| nyaa / eztv RSS           | `nyaa.si/?page=rss`, `eztvx.to/ezrss.xml` | the genuine "uploaded right now" firehose                                                                          |
| torrents-csv              | `torrents-csv.com/service/search?q=`      | small, clean, open dataset, cursor pagination                                                                      |
| bt4g                      | `bt4g.org/search/<q>/1?page=rss`          | DHT-derived; the RSS path avoids the CF wall the HTML path hits                                                    |
| bitsearch / solidtorrents | `/api/v1/search?q=`                       | seeders, leechers, size, category                                                                                  |
| archive.org               | `advancedsearch.php`                      | fully legal; ~88M items carry a `btih`                                                                             |

**Dead or walled as of 2026-09-06** — do not build on these: torrent-paradise.ml
(domain now a casino site), idope.se / yts.mx / torrentgalaxy.to (NXDOMAIN on two
resolvers), btdig.com (429 + CAPTCHA), 1337x.to (403 Cloudflare), anidex.info
(DDoS-Guard), knaben.eu (TLS completes, HTTP never answers), torrentz2.nz (500),
magnetdl (522), tordex.com (cert mismatch).

## Gotchas that cost time

- `dht.libtorrent.org` is on port **25401**, not 6881. Hardcoding 6881 for all
  bootstraps is the most common bootstrap bug.
- `router.bitcomet.com` is **NXDOMAIN** — do not ship it in a bootstrap list.
- `router.bittorrent.com` and `router.utorrent.com` are the same operator. Two
  entries, one point of failure.
- newTrackon has **no** `/api/percentage/<url>` route. It is `/api/<integer>`,
  an uptime threshold. There is no public per-tracker uptime endpoint.
- ngosang has no `trackers_udp.txt`; the prefix is `trackers_all_<scheme>.txt`.
- `bittorrent-dht` exposes no `'query'` event — use the documented
  `get_peers` / `announce_peer` events, or `dht._rpc.on('query')`.
- A site returning HTTP 200 may be a captcha wall or a parked domain. `httpSite`
  reads the `<title>` to tell those apart from a live index.

## Provenance is a field, not a comment

Every node records `from` (which list or definition named it) and
`discoveredVia` (which node led us to it). A mirror that 301s to a new origin
gets the new origin added with `from: redirect:<old>` — a dead mirror telling
you the current address is the most valuable thing it can say.

## Tracker list PAGES, not just files

Four community pages publish tracker lists as HTML tables rather than raw text.
`extractAnnounces()` pulls announce URLs out of any markup, so these count as
sources like any other: `torrenttracker.org/stable-torrent-trackers`,
`tinytorrent.net`, `torrends.to`, `anonymiz.com`. They contributed **64 endpoints
the GitHub lists did not have**, of which 18 answered — a ~28% hit rate against
~19% for the raw union, so curated-by-a-human is still worth something.

Every source is itself a node in the map (`map.sources`), with its own fetch
count and failure streak. A list that starts 404ing gets demoted exactly like a
dead tracker.
