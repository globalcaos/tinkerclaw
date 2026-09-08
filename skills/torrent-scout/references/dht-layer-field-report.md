# BitTorrent DHT as a live-torrent discovery surface

**Author:** Jarvis (subagent `net-dht`) · **Date:** 2026-09-06 · **Host:** this machine, Node v22.23.1
**Status:** every claim below that could be measured **was measured on this host today**. Where I
recite spec rather than observation, I say so.

---

## 0. Executive summary — the leg works, end to end

I ran the whole chain live: bootstrap → walk the DHT → harvest infohashes that are active _right
now_ → find peers for one → pull its full file list over BEP 9. **No tracker, no indexer, no
Jackett, no API key.**

| stage                 | result (measured today)                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| Bootstrap             | 4/4 hostnames resolve; **44 nodes** in the routing table within seconds         |
| Walk                  | **176 nodes** after 240 s of random-target lookups                              |
| Passive harvest       | **37 inbound queries / 240 s** → 10 `get_peers` → **10 unique live infohashes** |
| BEP 51 active harvest | 60 nodes queried, **29 answered**, → **567 unique infohashes** in two bursts    |
| BEP 9 metadata        | 6 infohashes attempted, **2 fully resolved** to name + size + file list         |

**The headline: BEP 51 beat passive listening by ~50× per unit time.** Passive gave 10 infohashes
in 4 minutes; two `sample_infohashes` bursts gave 567. Build on BEP 51 first; treat passive
observation as a free bonus stream, not the engine.

---

## 1. Bootstrap nodes — resolved today

`dig +short`, 2026-09-06:

| host:port                                      | A (IPv4)                            | AAAA (IPv6)              |
| ---------------------------------------------- | ----------------------------------- | ------------------------ |
| `router.bittorrent.com:6881`                   | `67.215.246.10`                     | —                        |
| `dht.transmissionbt.com:6881`                  | `87.98.162.88`, `212.129.33.59`     | `2001:41d0:203:4cca:5::` |
| `router.utorrent.com:6881`                     | `82.221.103.244`                    | —                        |
| `dht.libtorrent.org:25401`                     | `185.157.221.247`                   | `2a02:752:0:18::128`     |
| `dht.aelitis.com:6881` (→ `dht.vuze.com`, AWS) | `34.203.221.232`                    | —                        |
| `router.bitcomet.com`                          | **NXDOMAIN — dead, do not ship it** | —                        |

Notes that matter for an implementation:

- **`router.bittorrent.com` and `router.utorrent.com` are the same operator** and historically the
  same box. Do not count them as two independent points of failure.
- **`dht.libtorrent.org` is on port 25401, not 6881.** Hardcoding 6881 for all four is the single
  most common bootstrap bug.
- **Resolve at runtime, never bake these IPs in.** `dht.aelitis.com` is a CNAME chain into an EC2
  instance whose IP will rotate. The table above is a snapshot for verification, not a constant.
- Bootstrap routers are _pure_ routers: they answer `find_node` and nothing else. They hold no
  peers, will not answer `get_peers` usefully, and must never be announced to.

---

## 2. KRPC (BEP 5) in implementable detail

### 2.1 Transport and envelope

UDP. Every message is a bencoded dict. Three keys are universal:

- `t` — transaction id, an opaque short binary string echoed in the reply. Your correlation key.
- `y` — `q` (query), `r` (response), or `e` (error).
- `v` — optional client version tag (e.g. `UT­3E`). Useful for fingerprinting who you're talking to.

Queries carry `q` (method name) and `a` (argument dict). Responses carry `r`. Errors carry `e`,
a list `[code, message]` — `201` generic, `202` server, `203` protocol, `204` unknown method.

### 2.2 Exact wire bytes (generated with the installed `bencode@4.0.1`, verified byte-identical to BEP 5's examples)

```
ping             (56B)  d1:ad2:id20:abcdefghij0123456789e1:q4:ping1:t2:aa1:y1:qe
find_node        (92B)  d1:ad2:id20:abcdefghij01234567896:target20:mnopqrstuvwxyz123456e1:q9:find_node1:t2:aa1:y1:qe
get_peers        (95B)  d1:ad2:id20:abcdefghij01234567899:info_hash20:mnopqrstuvwxyz123456e1:q9:get_peers1:t2:aa1:y1:qe
announce_peer   (147B)  d1:ad2:id20:abcdefghij012345678912:implied_porti1e9:info_hash20:mnopqrstuvwxyz1234564:porti6881e5:token8:aoeusnthe1:q13:announce_peer1:t2:aa1:y1:qe
sample_infohashes(101B) d1:ad2:id20:abcdefghij01234567896:target20:mnopqrstuvwxyz123456e1:q17:sample_infohashes1:t2:aa1:y1:qe
error            (51B)  d1:eli201e23:A Generic Error Ocurrede1:t2:aa1:y1:ee
```

Note bencode dicts are **sorted by key**, so `a` precedes `q` precedes `t` precedes `y`. Your
encoder must sort or peers will reject you. (The typo "Ocurred" is in the spec; it is not mine.)

### 2.3 The four core methods

**`ping`** — `a: {id}` → `r: {id}`. Liveness only. Use it to evict stale routing entries.

**`find_node`** — `a: {id, target}` → `r: {id, nodes}` where `nodes` is compact node info for the
8 nodes closest to `target` in that node's table. This is the walk primitive.

**`get_peers`** — `a: {id, info_hash}` → either `r: {id, token, values}` (peers known for that
swarm — this node is _in_ the swarm) or `r: {id, token, nodes}` (closer nodes to ask instead).
`token` is an opaque blob you must present back in a later `announce_peer`; it expires (~10 min)
and is bound to your IP. **This is the query a passive crawler harvests.**

**`announce_peer`** — `a: {id, info_hash, port, token, implied_port}` → `r: {id}`. Declares _you_
are a peer in that swarm. `implied_port: 1` tells the receiver to ignore your `port` field and use
the UDP source port instead — correct behaviour behind NAT.

> **For a discovery-only crawler: never send `announce_peer`.** It inserts you into swarms,
> advertises you as a source of the content, and invites inbound connections. Discovery needs
> `find_node` + `get_peers` + `sample_infohashes` only. This also keeps the tool aligned with
> torrent-scout's existing "never seeds" guarantee.

### 2.4 Node IDs and XOR distance

Node ids and infohashes share one 160-bit keyspace. Distance is **`XOR(a, b)` read as a big-endian
160-bit unsigned integer** — not a norm, not a hash comparison. Worked example from my run:

```
id  = "abcdefghij0123456789"
ih  = "mnopqrstuvwxyz123456"
XOR = 0c0c0c141414141c1c1c47494b49050705030d0f   → 4 leading zero bits
```

Properties you actually rely on: `d(a,a)=0`, symmetry, and the triangle inequality. In practice
you only need "count the leading zero bits of the XOR" — that's the k-bucket index. A routing
table is 160 buckets of ≤ K (=8) nodes each, bucket _i_ holding nodes sharing an _i_-bit prefix
with you.

**Iterative lookup** (the whole algorithm): take the α (=3) closest known nodes to your target,
send them `find_node`/`get_peers` in parallel, merge the returned `nodes` into your candidate set,
re-sort by XOR distance, repeat with the new closest α. Terminate when a full round returns
nothing closer. Each round roughly halves the distance → **O(log n)** hops, ~15–20 hops on today's
network.

### 2.5 Compact formats — the byte layouts

**Compact node info — 26 bytes**, concatenated with no separator:

```
[0 .. 19]  20 bytes  node id
[20 .. 23]  4 bytes  IPv4, network byte order
[24 .. 25]  2 bytes  port, network byte order (big-endian uint16)
```

So a `find_node` reply's `nodes` string is `26 × N` bytes; parse with a stride of 26. IPv6
(BEP 32) uses key `nodes6` with **38 bytes** (20 + 16 + 2).

**Compact peer info — 6 bytes**: 4-byte IPv4 + 2-byte port. Note `get_peers`' `values` is a
**list of 6-byte strings**, _not_ one concatenated blob — a real parsing difference from `nodes`.
IPv6 peers are 18 bytes.

Decoding in Node, no dependency:

```js
function decodeNodes(buf) {
  // 26-byte stride
  const out = [];
  for (let i = 0; i + 26 <= buf.length; i += 26) {
    out.push({
      id: buf.subarray(i, i + 20).toString("hex"),
      host: `${buf[i + 20]}.${buf[i + 21]}.${buf[i + 22]}.${buf[i + 23]}`,
      port: buf.readUInt16BE(i + 24),
    });
  }
  return out;
}
const decodePeer = (b) => ({ host: `${b[0]}.${b[1]}.${b[2]}.${b[3]}`, port: b.readUInt16BE(4) });
```

`compact2string` / `string2compact` (both installed) do exactly this if you'd rather not hand-roll.

### 2.6 Annotating every node you learn

The task asked for a walker that annotates each new node. Everything worth recording is available
at learn-time, for free:

| field                      | source                                                  |
| -------------------------- | ------------------------------------------------------- |
| `id`, `host`, `port`       | the 26-byte record                                      |
| `xorDistance`, `bucket`    | computed vs. your own id                                |
| `firstSeen` / `lastSeen`   | your clock                                              |
| `learnedFrom`              | the node whose reply contained it                       |
| `hop`                      | walk depth from bootstrap                               |
| `rtt`                      | measure on the first `ping`/`find_node` reply           |
| `version`                  | the `v` key if present — identifies client software     |
| `supportsBep51`            | did it answer `sample_infohashes`, or return error 204? |
| `storedInfohashes` (`num`) | BEP 51 tells you how many it holds — see §3             |

That last pair is the high-value annotation: **it tells you which nodes are worth re-querying.**
Measured today, `num` ranged 66–352 infohashes per node.

---

## 3. Crawling and infohash harvesting — two mechanisms, measured

### 3.1 Passive observation (the classic technique)

A DHT node receives queries addressed to the region of keyspace near its own id. Every inbound
`get_peers` **names an infohash somebody is actively trying to download right now**, and every
inbound `announce_peer` names one somebody is actively _sharing_. You harvest them by simply
answering honestly and logging what you were asked.

The classic amplifier is **node-id manipulation**: run many virtual nodes with ids spread across
the keyspace (or rotate your id toward busy regions), because your inbound query rate is
proportional to the fraction of keyspace you cover. This is what "sybil crawlers" do.

**Measured here (240 s, one node, 176 routing entries):**

```
INBOUND raw KRPC queries = 37
  ping = 3 · find_node = 26 · get_peers = 10 · announce_peer = 0
unique live infohashes from get_peers = 10
```

Sample of infohashes seen being _searched for_ at that moment:
`4bf5c23be399474753832893d705cc0d81b9c9d0`, `d6c2c4d145091d99df8963602afa2e56359425e0`,
`355ad30de0c981d4fc0028fd7466860935cb2455`, `becf1e99f10d32019ab5af8acbd8caac4838b79d`, …

So: **~2.5 live infohashes per minute from a single vanilla node.** Real but slow. Scaling is
linear in (virtual nodes × time).

> ### ⚠️ Implementation trap I hit — and it produces a convincing false negative
>
> My first probe reported **0 inbound queries** and I nearly wrote "this host is NAT-blocked."
> It wasn't. `bittorrent-dht@11` **does not emit a `'query'` event** — that event belongs to the
> underlying `k-rpc` socket. The package emits its own high-level events from inside its query
> handlers (`client.js:532/543/568`):
>
> ```js
> dht.on("get_peers", (infoHash) => {}); // someone asked US for peers
> dht.on("announce_peer", (infoHash, peer) => {}); // someone announced TO us
> dht.on("announce", (peer, infoHash, from) => {});
> dht.on("find_node", (target) => {});
> dht._rpc.on("query", (q, peer) => {}); // raw layer, if you want everything
> ```
>
> Listening on `dht.on('query')` silently yields zero forever and looks exactly like a firewall.
> Verify against the raw `_rpc` counter before concluding you're unreachable.

### 3.2 BEP 51 — `sample_infohashes`, the sanctioned way (and far better)

BEP 51 ("DHT Infohash Indexing") exists precisely so crawlers don't have to sybil the network. A
node returns a random sample of the infohashes **it is currently storing peers for**.

Query: `{q: 'sample_infohashes', a: {id, target}}` — `target` picks the keyspace region.

Response `r`:

| key           | meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `samples`     | **concatenated 20-byte infohashes**, stride 20 (like `nodes`, different width)     |
| `num`         | total infohashes this node holds — i.e. how much you're _missing_ from this sample |
| `interval`    | seconds until the node will have a fresh sample; **do not re-query sooner**        |
| `id`, `nodes` | as usual — so one query both samples _and_ advances your walk                      |

**Measured today:** 60 nodes queried → **29 returned samples**, 19 timed out, 1 replied
`204 Unknown query type` (an old client). Yield: **567 unique infohashes**, ~20 per responding
node. Reported `num` per node: **66, 103, 103, 128, 129, 352**. Every single node reported
`interval = 21600` (**6 hours**).

Two things follow directly, and they shape the crawler design:

1. **~48% of live nodes support BEP 51.** That's plenty — you don't need consent from the rest.
2. **`interval` is 6 hours everywhere.** So the loop is not "hammer a few nodes"; it is
   **breadth**: keep walking `find_node` to discover _new_ nodes, sample each one _once_, park it
   in a per-node cooldown table for 6 h, move on. A polite crawler's throughput is bounded by node
   discovery rate, not by query rate — which is also why it stays polite by construction.
3. `num` ≫ `samples.length` (e.g. 352 vs 20), so re-visiting a high-`num` node after its interval
   is genuinely productive. **Sort your revisit queue by `num` descending.**

### 3.3 Recommended architecture

```
                ┌─ bootstrap (4 hosts, resolved at runtime)
                ▼
   ┌───► iterative find_node walk (random targets)  ──► node table (annotated, §2.6)
   │              │                                        │
   │              │  every NEW node, once per 6h           ▼
   │              └──────────────► sample_infohashes ──► infohash pool ◄── passive get_peers
   │                                                        │            (free, always on)
   └──── nodes returned in replies ◄────────────────────────┘
                                                            ▼
                                        BEP 9 metadata fetch (§4) → name/size/files
```

Politeness / safety rules baked in: never `announce_peer`; honour `interval` per node; cap
in-flight queries; back off on timeouts; and remember every node you touch belongs to an
uninvolved stranger — sample once, don't camp on them.

---

## 4. BEP 9 — metadata from an infohash alone (verified working)

BEP 9 rides BEP 10 (extension protocol) over an ordinary TCP peer connection. Given only a
20-byte infohash you get the complete `info` dict — name, sizes, full file list, piece length —
**without downloading a single content byte and without any tracker or indexer.**

### Sequence

1. **DHT `get_peers`** on the infohash → compact 6-byte peers.
2. **TCP connect**, standard BitTorrent handshake:
   `<19>"BitTorrent protocol"<8 reserved><20-byte infohash><20-byte peer id>`.
   Set **reserved byte 5, bit `0x10`** to advertise extension-protocol support (and `0x01` in the
   last byte for DHT).
3. **Extended handshake** — send message id 20, extended id 0, bencoded
   `{m: {ut_metadata: 1}, metadata_size: 0}`. The peer replies with _its_ `m` mapping (its
   `ut_metadata` id, which may not be 1 — use theirs when sending) and, crucially,
   **`metadata_size`**.
4. **Request pieces.** Metadata is split into **16 KiB blocks**; `ceil(metadata_size / 16384)`
   of them. Send `{msg_type: 0, piece: i}` for each.
5. **Reassemble** the `data` payloads (which follow the bencoded header in the same message),
   concatenate, and **verify `SHA1(metadata) === infohash`** — this is the integrity check that
   makes the whole thing trustworthy; a lying peer cannot forge it.
6. `bencode.decode(metadata)` → the `info` dict. Note the fetched blob **is** the `info` dict, so
   to write a real `.torrent` you wrap it: `{info: <blob>, announce: ...}`.

`msg_type` values: `0` request, `1` data, `2` reject (peer has no metadata — drop it, try another).

### Measured result

Feeding it infohashes harvested minutes earlier, with **no tracker involved**:

```
harvested pool = 305 infohashes · peer connections attempted = 399
6 infohashes attempted → 2 fully resolved, 4 timed out
```

| infohash (first 16) | name                              | size                              | files     |
| ------------------- | --------------------------------- | --------------------------------- | --------- |
| `2057cf0d90d14396…` | `Солнцепек 2021 WEB-DL 1080p.mkv` | 5.29 GB                           | 1         |
| `23e1f7c83f129791…` | `Tokyo-Hot-n501-800` _(adult)_    | **1,011,974,587,627 B ≈ 1.01 TB** | **1,160** |

The second one is the proof that matters: **a full 1,160-entry file listing with per-file byte
sizes and a 32 MiB piece length, recovered from 20 bytes and nothing else.** That is exactly the
"inspect before you download" capability torrent-scout is built around.

**Expect ~33% success and design for it.** Most harvested infohashes fail, for mundane reasons:
peers are behind NAT, the swarm is dead, or the peer rejects metadata requests. Mitigation is
volume and parallelism — try many peers per infohash concurrently (I got 399 connection attempts
across 6 infohashes), set a 10–15 s per-peer timeout, and treat the first valid SHA1-verified
blob as the winner. **Success rate is a peer-availability property, not a bug in your code.**

---

## 5. npm packages — all seven present, offline-ready

`ls ~/.openclaw/workspace/skills/torrent-scout/node_modules` → **172 packages**. All seven
requested are installed; **nothing needs to be fetched.**

| requested           | installed version | role                                                                 |
| ------------------- | ----------------- | -------------------------------------------------------------------- |
| `bittorrent-dht`    | **11.0.12** ✅    | full DHT client — bootstrap, walk, `lookup`, passive events          |
| `k-rpc`             | **5.1.0** ✅      | the KRPC layer underneath; use `dht._rpc.query()` for custom methods |
| `bencode`           | **4.0.1** ✅      | encode/decode; verified byte-identical to BEP 5 examples             |
| `magnet-uri`        | **7.0.10** ✅     | parse/build `magnet:?xt=urn:btih:…`                                  |
| `ut_metadata`       | **4.0.3** ✅      | BEP 9 — verified working end-to-end above                            |
| `torrent-discovery` | **11.0.21** ✅    | combines DHT + tracker + LSD + PEX peer discovery                    |
| `webtorrent`        | **2.6.10** ✅     | full client (heavyweight; not needed for discovery)                  |

Also present and directly useful: `parse-torrent@11.0.18`, `bittorrent-protocol@4.1.21` (the wire

- extension protocol), `k-bucket@5.1.0` (routing table), `k-rpc-socket@1.11.1`,
  `compact2string@1.4.1` / `string2compact@2.0.2` (the §2.5 byte formats),
  `ut_pex@4.0.4` (peer exchange — another passive discovery stream), `bittorrent-tracker@11.2.3`,
  `create-torrent@6.1.3`, `bitfield`, `lru`, `record-cache`.

**Gap worth knowing: no installed package implements BEP 51.** `grep -rn sample_infohashes` across
`bittorrent-dht` and `k-rpc` returns nothing. You issue it yourself — which is a ~10-line addition,
exactly as I did:

```js
dht._rpc.query(
  { host, port },
  { q: "sample_infohashes", a: { id: dht._rpc.id, target: crypto.randomBytes(20) } },
  (err, res) => {
    const r = res && res.r;
    if (err || !r || !r.samples) return;
    for (let i = 0; i + 20 <= r.samples.length; i += 20)
      pool.add(Buffer.from(r.samples.slice(i, i + 20)).toString("hex"));
    cooldown.set(`${host}:${port}`, Date.now() + Number(r.interval) * 1000); // 21600s observed
    revisitQueue.push({ host, port, num: Number(r.num) }); // sort by num desc
  },
);
```

---

## 6. Findings that change the design

1. **BEP 51 is the engine; passive listening is the garnish.** 567 vs 10 infohashes for comparable
   effort. Anyone building "passive sybil crawler first" is doing it the 2012 way.
2. **Every node reported `interval = 21600` (6 h).** Throughput is therefore bounded by _node
   discovery_, not query rate. Optimise the `find_node` walk, not the sampling loop.
3. **~48% BEP 51 support** among live nodes — high enough to rely on, low enough that you must
   handle `204 Unknown query type` and silence gracefully.
4. **`bittorrent-dht` has no `'query'` event.** The false-negative trap of §3.1 costs an afternoon
   and looks identical to a firewall. Cross-check `dht._rpc.on('query')`.
5. **BEP 9 succeeds ~1 in 3.** Parallelism across peers, not retries against one, is the fix.
6. **Discovery never requires `announce_peer`.** The entire pipeline above is read-only with
   respect to the swarm — torrent-scout's "never seeds" guarantee survives intact.
7. **`router.bitcomet.com` is NXDOMAIN** and `dht.libtorrent.org` is on **25401**. Two bugs waiting
   in any copy-pasted bootstrap list.

## 7. Honest limitations

- Sampling window was ~4 minutes on one node from one IP; inbound-query rates vary with keyspace
  position, uptime and NAT. Treat "2.5 infohashes/min" as an order of magnitude, not a constant.
- I did **not** test IPv6 (BEP 32) transport, nor `announce_peer` (deliberately — see above), nor
  sustained multi-hour crawling. The 6 h `interval` means real throughput numbers need a run
  longer than this one.
- BEP 51's `num` is self-reported by each node; nothing verifies it.
- Infohashes are of whatever the network happens to be trading; the two samples in §4 are raw
  measurement output, reported as observed rather than curated.

**Artifacts:** probes left at `/tmp/dht-probe2.mjs` (harvest + BEP 51), `/tmp/bep9-probe.mjs`
(metadata fetch), `/tmp/wire.mjs` (KRPC byte dumps). All re-runnable.
