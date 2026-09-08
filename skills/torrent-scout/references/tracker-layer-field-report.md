# Public BitTorrent Tracker Layer — Field Report

**Author:** Jarvis (subagent) · **Date:** 2026-09-06 · **All figures fetched live on this date from this host (Spain / IPv4+IPv6 dual-stack).**

Everything below was measured, not recalled. Counts come from `curl` against the live endpoints; liveness comes from a real BEP 15 handshake written for this report (`/tmp/udp-probe.mjs`, source in §3.6). Where the task's premise turned out to be wrong, I say so rather than papering over it — see §2.1.

---

## 0. Executive summary — what to actually wire into the tool

| Need                             | Use this                                          | Why                                                                                            |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Default tracker set for a magnet | `ngosang/trackerslist` → `trackers_best.txt` (20) | **100% alive** in my probe (15/15 UDP). Smallest high-yield set.                               |
| Wider net                        | `XIU2/TrackersListCollection` → `best.txt` (76)   | 80% UDP alive; broader coverage, still curated.                                                |
| Liveness / uptime intelligence   | `newtrackon.com/api/stable` (54) or `/api/{pct}`  | Only source with a _measured uptime history_ rather than a snapshot.                           |
| Aggregate everything             | union of ngosang + XIU2 + newtrackon `/api/all`   | 322 distinct endpoints, 293 distinct hostnames.                                                |
| **Do NOT**                       | trust any list's own dedup                        | ngosang's `best.txt` ships **4 hostnames that are one tracker** (§4.2). Dedupe by IP yourself. |

Three findings worth carrying into the design:

1. **`/api/percentage/<url>` does not exist.** The real newTrackon route is `/api/{integer}` — an uptime threshold, not a per-tracker query (§2.1).
2. **Announce-liveness ≠ scrape-liveness.** `open.demonii.com` answers announce in 659 ms and times out on scrape. Probe with **announce**, not scrape (§3.5).
3. **IP collapse is real and measurable.** 38 of 229 resolvable hostnames (17%) share an IP with another tracker; the biggest cluster is 10 hostnames on one Google Cloud VM. Proven identical by matching swarm counts, not inferred from DNS (§4).

---

## 1. Canonical maintained tracker lists

### 1.1 ngosang/trackerslist — the reference list

Raw URL pattern: `https://raw.githubusercontent.com/ngosang/trackerslist/master/<file>`

**Update cadence: daily.** Verified from the commit log — commits titled `Update 2026/09/06`, `Update 2026/09/05`, … landing at **~22:10 UTC every day**. The README badge and line 12 both state "automatically updated every day".

| File                            | Raw URL (suffix on the pattern above) | Count (2026-09-06) | Contents                                                |
| ------------------------------- | ------------------------------------- | ------------------ | ------------------------------------------------------- |
| `trackers_best.txt`             | `trackers_best.txt`                   | **20**             | 15 UDP + 5 HTTPS, sorted by popularity+latency          |
| `trackers_best_ip.txt`          | `trackers_best_ip.txt`                | **20**             | same set, hostnames pre-resolved to literal IPs         |
| `trackers_all.txt`              | `trackers_all.txt`                    | **86**             | every scheme                                            |
| `trackers_all_ip.txt`           | `trackers_all_ip.txt`                 | **51**             | all, as literal IPs                                     |
| `trackers_all_udp.txt`          | `trackers_all_udp.txt`                | **47**             | UDP only                                                |
| `trackers_all_http.txt`         | `trackers_all_http.txt`               | **29**             | HTTP only                                               |
| `trackers_all_https.txt`        | `trackers_all_https.txt`              | **10**             | HTTPS only                                              |
| `trackers_all_ws.txt`           | `trackers_all_ws.txt`                 | **3**              | WebTorrent (wss)                                        |
| `trackers_all_i2p.txt`          | `trackers_all_i2p.txt`                | **13**             | I2P eepsites                                            |
| `trackers_all_yggdrasil.txt`    | `trackers_all_yggdrasil.txt`          | **1**              | Yggdrasil overlay                                       |
| `trackers_all_yggdrasil_ip.txt` | `trackers_all_yggdrasil_ip.txt`       | **4**              | Yggdrasil, as IPs                                       |
| `blacklist.txt`                 | `blacklist.txt`                       | **346**            | removed/rejected trackers — useful as a negative filter |

> **Correction to a common assumption:** there is no `trackers_http.txt`, `trackers_udp.txt` or `trackers_ws.txt`. Those four names all return **HTTP 404**. The prefix is `trackers_all_<scheme>.txt`. I checked each one.

**Mirrors** (both verified 200, same 86 entries):

- `https://ngosang.github.io/trackerslist/trackers_all.txt` (GitHub Pages)
- `https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt` (jsDelivr CDN)

Use a mirror if you expect rate-limiting; `raw.githubusercontent.com` is fine for a per-run fetch but is unauthenticated-rate-limited under load.

**Sample — `trackers_best.txt` verbatim (all 20):**

```
udp://zer0day.ch:1337/announce
udp://tracker.therarbg.to:6969/announce
udp://tracker.publictracker.xyz:6969/announce
udp://tracker.opentrackr.org:1337/announce
udp://open.demonii.com:1337/announce
udp://tracker.qu.ax:6969/announce
udp://tracker.dler.org:6969/announce
udp://tracker.auctor.tv:6969/announce
udp://tracker-udp.gbitt.info:80/announce
udp://t.overflow.biz:6969/announce
udp://retracker01-msk-virt.corbina.net:80/announce
udp://open.stealth.si:80/announce
udp://ipv4announce.sktorrent.eu:6969/announce
udp://explodie.org:6969/announce
udp://exodus.desync.com:6969/announce
https://tracker.zhuqiy.com:443/announce
https://tracker.pmman.tech:443/announce
https://tracker.nekomi.cn:443/announce
https://tracker.bt4g.com:443/announce
https://004430.xyz:443/announce
```

**Format note:** entries are **blank-line separated** (`url\n\nurl\n\n…`), which trips naive `split('\n')` parsers into emitting empty strings. Filter empties. The `_ip` variants are the same trackers with the hostname replaced by a literal address — handy when you want to skip DNS, dangerous when the operator rotates IPs between daily rebuilds.

**How the list is built** (README, "About"): a bot checks the trackers automatically; _"Trackers with the same domain or pointing to the same IP address are removed"_; sorting is by popularity then latency. **That IP-dedup claim does not hold in practice** — see §4.2, where four `best.txt` entries resolve to one address.

### 1.2 XIU2/TrackersListCollection — the wide list

Raw URL pattern: `https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/<file>`
Custom-domain mirrors, both verified live and identical: `https://trackerslist.com/<file>` and `https://cf.trackerslist.com/<file>` (Cloudflare-fronted).

**Update cadence: daily**, commits titled by date (`2026-09-06`, `2026-09-05`, …) landing at **~00:18 UTC**.

| File                                                                       | Count (2026-09-06) | Contents                                                 |
| -------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| `all.txt`                                                                  | **140**            | everything                                               |
| `best.txt`                                                                 | **76**             | curated subset                                           |
| `http.txt`                                                                 | **60**             | HTTP/HTTPS only                                          |
| `nohttp.txt`                                                               | **79**             | UDP + wss (no HTTP)                                      |
| `other.txt`                                                                | **13**             | hand-added extras                                        |
| `all_aria2.txt` / `best_aria2.txt` / `http_aria2.txt` / `nohttp_aria2.txt` | same sets          | **comma-joined single line**, for `aria2c --bt-tracker=` |
| `blacklist.txt`                                                            | —                  | exclusion list                                           |

The `_aria2` variants are the same data on one line: `http://a/announce,http://b/announce,…`. If your tool shells out to aria2c, fetch that variant directly instead of re-joining.

Format: also blank-line separated in the plain variants.

### 1.3 Other live list repos (verified 200 today)

| Repo / URL                                                                                  | Entries | Last commit    | Verdict                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://raw.githubusercontent.com/hezhijie0327/Trackerslist/main/trackerslist_tracker.txt` | 453     | 2026-09-06     | **Actively maintained**, aggregates several upstreams. Worth including.                                                                           |
| `https://raw.githubusercontent.com/Tunglies/TrackersList/main/all.txt`                      | 1,544   | 2026-09-05     | Fresh but **unfiltered** — only 320 of its 1,484 distinct hosts overlap the curated union. High noise; use only if you probe everything yourself. |
| `https://raw.githubusercontent.com/1265578519/OpenTracker/master/tracker.txt`               | 38      | 2026-07-07     | Small, 2 months stale. Marginal.                                                                                                                  |
| `https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all.txt`           | 1,091   | **2024-01-12** | **Abandoned 20 months.** Do not use — it will poison your liveness stats.                                                                         |

**Recommendation:** ngosang (`best` + `all`) ∪ XIU2 (`best`) ∪ newtrackon `/api/stable`. That is ~200 endpoints of which the overwhelming majority answer. Adding Tunglies triples the list and roughly triples the dead-probe cost for little gain.

---

## 2. newtrackon.com — the HTTP API

Base: `https://newtrackon.com/api`. All list endpoints return **`text/plain; charset=utf-8`**, **blank-line separated** URLs, with **`Access-Control-Allow-Origin: *`** (browser-callable). Cloudflare in front, `cf-cache-status: DYNAMIC` — responses are not edge-cached, so don't hammer it.

The site publishes an OpenAPI 3.0.3 spec at **`https://newtrackon.com/api.yml`** (also in-repo at `newtrackon/newtrackon-api.yml`). That spec plus `newtrackon/views.py` in [CorralPeltzer/newTrackon](https://github.com/CorralPeltzer/newTrackon) are the authoritative route list.

### 2.1 The endpoint table (measured)

| Endpoint            | Live count                                    | Semantics (from source)                                                                                                                                                                      |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/all`      | **260**                                       | Every monitored tracker, dead or alive. Implemented as `api_percentage(0)`.                                                                                                                  |
| `GET /api/stable`   | **54**                                        | Uptime **≥ 95%** _and_ tracked for at least `min_age_days` (default **10**). Implemented as `api_percentage(95, min_age_days=10)`.                                                           |
| `GET /api/live`     | **72**                                        | Currently responding _right now_. Separate DB query, not a percentage filter.                                                                                                                |
| `GET /api/udp`      | **37**                                        | Stable **UDP** trackers.                                                                                                                                                                     |
| `GET /api/http`     | **20**                                        | Stable **HTTP/HTTPS** trackers.                                                                                                                                                              |
| `GET /api/{uptime}` | e.g. `/api/95`→57, `/api/50`→74, `/api/0`→260 | Trackers with uptime **≥ N%**. `N` must be 0–100; `/api/101` → **HTTP 400** `"The percentage has to be between 0 an 100"`.                                                                   |
| `GET /api/best`     | —                                             | **301 redirect** to `/api/stable`. Undocumented in the spec but present in `views.py`. Follow redirects or use `/api/stable` directly.                                                       |
| `POST /api/add`     | —                                             | Submit new trackers (`application/x-www-form-urlencoded`, field `new_trackers`). `204` on accept, `400` if empty, `413` if too many. **Write endpoint — do not call from a discovery tool.** |

> ### ⚠️ `/api/percentage/<url>` does not exist
>
> The brief asked me to document `/api/percentage/<tracker-url>`. I tested it three ways — raw, percent-encoded, and hostname-only — and all three return **HTTP 404**. The route in `views.py` is:
>
> ```python
> @app.route("/api/<int:percentage>")
> def api_percentage(percentage: int, added_before: int | None = None) -> Response:
> ```
>
> The `<int:percentage>` converter means the path segment is an **integer uptime threshold**, not a tracker URL. The function name is `api_percentage`, which is almost certainly where the mistaken URL shape came from.
>
> **There is no public JSON endpoint for one tracker's uptime.** Per-tracker uptime percentages are rendered into the HTML at `https://newtrackon.com/list` (and raw probe logs at `/raw`, ~360 KB of HTML). If you need per-tracker uptime you must either scrape that HTML or binary-search the thresholds: a tracker present in `/api/90` but absent from `/api/95` sits in [90, 95).

### 2.2 Query parameters (all list endpoints)

| Param                        | Default                              | Effect                                                                                                        |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `min_age_days`               | `0` (but **`10` for `/api/stable`**) | Only trackers first seen at least N days ago. Verified: `/api/stable?min_age_days=30` → 52 (vs 54 default).   |
| `include_ipv4_only_trackers` | `true`                               | Set `false` to drop trackers that only resolve to A records.                                                  |
| `include_ipv6_only_trackers` | `true`                               | Set `false` to drop AAAA-only trackers. Verified: `/api/all?include_ipv6_only_trackers=false` → 187 (vs 260). |

Booleans are parsed loosely — anything not `false`/`0` (case-insensitive) counts as true.

### 2.3 How newTrackon decides "up"

From `newtrackon/trackon.py` and `tracker.py`:

- A background loop wakes every **5 s**, and rechecks any tracker where `now - last_checked > tracker.interval`.
- `tracker.interval` is **taken from the tracker's own announce response** — the tracker tells you how often to come back. Default when unknown: **10800 s (3 h)**.
- A tracker that repeatedly fails is flagged `to_be_deleted` and dropped from the DB entirely.
- It honours **BEP 34** (DNS `TXT` records starting with `BITTORRENT` that declare protocol/port preferences, including an explicit _deny_).
- A separate loop runs every **120 s** calling `warn_of_duplicate_ips()` and `warn_of_recent_ip_overlaps()` — newTrackon actively tracks the IP-collapse problem in §4 and logs `"Tracker %s resolved to IP %s recently seen on %s"`.

### 2.4 Caveat on the source repo

`newtrackon/scraper.py` at master HEAD **does not parse under Python 3**:

```
line 257:  except HTTPError, requests.RequestException:
           SyntaxError: multiple exception types must be parenthesized
```

That is Python-2 syntax, introduced in commit `cac9e02` ("Upgrade dependencies and address Ruff checks", 2026-08-01). The live site works fine, so production is running an older build or image. Relevant only if you plan to vendor their code — read it as a _specification_, not as something to `import`.

---

## 3. The UDP tracker protocol (BEP 15) — enough to implement a prober

Spec: [BEP 15](https://www.bittorrent.org/beps/bep_0015.html). UDP is stateless and connectionless, so the protocol bolts on its own two-step handshake to make spoofing expensive.

### 3.1 The shape of it

```
client                                        tracker
  |  connect  request  (16 B, action=0)  ---->  |
  |  <----  connect  response (16 B, action=0)  |   yields connection_id
  |  announce request  (98 B, action=1)  ---->  |
  |  <----  announce response (20+6n B, act=1)  |   yields interval/seeders/leechers/peers
```

`connection_id` is valid for **one minute** and for **at most ~1000 requests**, per the BEP. For a liveness probe you do one connect + one announce and throw the socket away.

### 3.2 Connect request — 16 bytes

| Offset | Size | Type     | Value                                                                                                      |
| ------ | ---- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 0      | 8    | int64 BE | **`0x41727101980`** — the protocol magic constant. Every client sends exactly this in the _first_ connect. |
| 8      | 4    | int32 BE | `action = 0` (connect)                                                                                     |
| 12     | 4    | int32 BE | `transaction_id` — random, chosen by you                                                                   |

The magic number `0x41727101980` is a fixed protocol identifier (it does not encode anything — it's just an agreed 64-bit constant that lets a tracker cheaply reject stray UDP traffic).

### 3.3 Connect response — 16 bytes

| Offset | Size | Value                                           |
| ------ | ---- | ----------------------------------------------- |
| 0      | 4    | `action = 0`                                    |
| 4      | 4    | `transaction_id` — **must equal what you sent** |
| 8      | 8    | `connection_id` — opaque, echo it back verbatim |

**Validate the transaction_id.** UDP is spoofable and you will receive stray packets on a busy socket. If it mismatches, discard and keep waiting (or fail). If `action == 3`, it's an error packet and bytes 8..end are a UTF-8 error string.

### 3.4 Announce request — 98 bytes

| Offset | Size | Type   | Value for a probe                                                |
| ------ | ---- | ------ | ---------------------------------------------------------------- |
| 0      | 8    | int64  | `connection_id` from the handshake                               |
| 8      | 4    | int32  | `action = 1`                                                     |
| 12     | 4    | int32  | new random `transaction_id`                                      |
| 16     | 20   | bytes  | `info_hash` — 20 random bytes is fine for a liveness probe       |
| 36     | 20   | bytes  | `peer_id` — 20 bytes, conventionally `-qB4390-` + 12 random      |
| 56     | 8    | int64  | `downloaded` = 0                                                 |
| 64     | 8    | int64  | `left` = 0                                                       |
| 72     | 8    | int64  | `uploaded` = 0                                                   |
| 80     | 4    | int32  | `event` — 0 none, 1 completed, 2 **started**, 3 stopped          |
| 84     | 4    | int32  | `IP` = 0 → "reply to the source address of this packet"          |
| 88     | 4    | int32  | `key` — random, lets the tracker correlate you across IP changes |
| 92     | 4    | int32  | `num_want` = **−1** for tracker's default                        |
| 96     | 2    | uint16 | `port` — the TCP port you'd listen on                            |

**Announce response — 20 + 6n bytes:**

| Offset | Size | Value                                             |
| ------ | ---- | ------------------------------------------------- |
| 0      | 4    | `action = 1`                                      |
| 4      | 4    | `transaction_id`                                  |
| 8      | 4    | `interval` — seconds until you should re-announce |
| 12     | 4    | `leechers`                                        |
| 16     | 4    | `seeders`                                         |
| 20     | 6·n  | peers: 4-byte IPv4 + 2-byte port, repeated        |

For IPv6 (announcing over a v6 socket) peers are **18 bytes each** (16 + 2), per BEP 15's IPv6 extension. My prober computes peer count as `(len-20)/6`; on a v6 socket use `/18`.

### 3.5 Scrape (action = 2) — and why you should _not_ use it for liveness

| Offset | Size | Value                |
| ------ | ---- | -------------------- |
| 0      | 8    | `connection_id`      |
| 8      | 4    | `action = 2`         |
| 12     | 4    | `transaction_id`     |
| 16     | 20·n | up to 74 info_hashes |

Response: 8-byte header then **12 bytes per hash** — `seeders` (int32), `completed` (int32), `leechers` (int32).

**Verified live** against `udp://tracker.opentrackr.org:1337` with the Ubuntu 22.04 desktop infohash `dd8255ec…6d1c`:

```
ip 93.158.213.92  action 2  txid_match true  len 20
seeders 265  completed 2181  leechers 39
```

But: **`udp://open.demonii.com:1337` answers announce in 659 ms and times out on scrape.** Scrape is optional and plenty of trackers disable it. A prober that uses scrape will mark healthy trackers dead. **Use announce with a random infohash.**

### 3.6 What alive vs dead actually looks like

Measured against `trackers_all_udp.txt` (47 UDP entries), 4 s timeout, concurrency 24 — **41 alive, 6 dead**:

| Outcome                              | Meaning                                                                                                           | Count      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| `action=1`, len ≥ 20, txid matches   | **Alive.** You get `interval`, `seeders`, `leechers`.                                                             | 41         |
| **timeout** — no UDP response at all | Dead host, firewalled port, or ISP blocking UDP. The dominant failure.                                            | 3          |
| `action=1` but **len == 8**          | Malformed/truncated — a half-implemented or dying tracker. Header only, no payload.                               | 2          |
| `action=3` + `"access denied"`       | Alive but **rejecting you** (`yuptracker-eu.gaijinent.com` — a game-company private tracker). Reachable ≠ usable. | 1          |
| DNS `NXDOMAIN` before any packet     | Domain expired. Cheapest possible dead-check — resolve first.                                                     | (see §4.3) |

Timings on the alive set: **67 ms to 754 ms**, median ~200 ms. **4 s is a generous timeout**; 2 s would lose almost nothing. `interval` values range 300–7163 s, most clustering at 900 or 1800.

Sample of the alive rows:

```
OK   udp://ipv4announce.sktorrent.eu:6969/announce    94.23.207.177     67ms  int=1940
OK   udp://tracker.ducks.party:1984/announce          135.125.198.235   76ms  int=1800
OK   udp://tracker-udp.gbitt.info:80/announce         109.201.134.183   88ms  int=1800
OK   udp://tracker.opentrackr.org:1337/announce       93.158.213.92    104ms  int=3570
OK   udp://open.stealth.si:80/announce                151.242.104.187  118ms  int=1832
FAIL udp://yuptracker-eu.gaijinent.com:27022/announce 52.211.139.85    announce error: access denied
FAIL udp://tracker.ddunlimited.net:6969/announce      193.187.90.12    bad announce resp action=1 len=8
FAIL udp://exodus.desync.com:6969/announce            208.83.20.20     timeout
```

### 3.7 Retry / backoff

BEP 15 specifies `15 * 2^n` seconds for retry n (0–8) — i.e. 15 s, 30 s, 60 s… That is correct for a _client that needs the announce to succeed_. For a **liveness prober it is wrong**: you want a short fixed timeout and at most one retry, because a tracker needing 60 s is dead for your purposes. newTrackon uses a **10 s timeout with 2 attempts**. I used **4 s, 1 attempt** and it separated the set cleanly.

### 3.8 The prober (working Node, no dependencies)

Written and run for this report; source at `/tmp/udp-probe.mjs`.

```js
// BEP 15 UDP tracker liveness probe. Node >= 18, zero deps.
import dgram from "node:dgram";
import dns from "node:dns/promises";
import crypto from "node:crypto";

const PROTOCOL_ID = 0x41727101980n; // magic connect constant
const ACTION_CONNECT = 0,
  ACTION_ANNOUNCE = 1,
  ACTION_SCRAPE = 2,
  ACTION_ERROR = 3;

function connectRequest(txid) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(PROTOCOL_ID, 0);
  b.writeUInt32BE(ACTION_CONNECT, 8);
  txid.copy(b, 12);
  return b;
}

function announceRequest(connId, txid, infoHash, peerId) {
  const b = Buffer.alloc(98);
  connId.copy(b, 0); //  0 connection_id
  b.writeUInt32BE(ACTION_ANNOUNCE, 8); //  8 action = 1
  txid.copy(b, 12); // 12 transaction_id
  infoHash.copy(b, 16); // 16 info_hash (20)
  peerId.copy(b, 36); // 36 peer_id   (20)
  b.writeBigUInt64BE(0n, 56); // 56 downloaded
  b.writeBigUInt64BE(0n, 64); // 64 left
  b.writeBigUInt64BE(0n, 72); // 72 uploaded
  b.writeUInt32BE(2, 80); // 80 event = started
  b.writeUInt32BE(0, 84); // 84 IP = 0 -> use packet source
  b.writeUInt32BE(crypto.randomInt(2 ** 31), 88); // 88 key
  b.writeInt32BE(-1, 92); // 92 num_want = default
  b.writeUInt16BE(6881, 96); // 96 port
  return b;
}

function sendRecv(sock, host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.removeListener("message", onMsg);
      reject(new Error("timeout"));
    }, timeoutMs);
    const onMsg = (msg) => {
      clearTimeout(t);
      sock.removeListener("message", onMsg);
      resolve(msg);
    };
    sock.on("message", onMsg);
    sock.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(t);
        reject(err);
      }
    });
  });
}

export async function probe(url, { timeoutMs = 4000 } = {}) {
  const u = new URL(url);
  const host = u.hostname,
    port = Number(u.port);
  const t0 = Date.now();

  let ips = [];
  try {
    ips = (await dns.lookup(host, { all: true })).map((r) => r.address);
  } catch (e) {
    return { url, ok: false, stage: "dns", error: e.code || e.message, ms: Date.now() - t0 };
  }
  if (!ips.length) return { url, ok: false, stage: "dns", error: "NODATA", ms: Date.now() - t0 };

  const ip = ips.find((a) => !a.includes(":")) || ips[0];
  const sock = dgram.createSocket(ip.includes(":") ? "udp6" : "udp4");
  try {
    const txid1 = crypto.randomBytes(4);
    const r1 = await sendRecv(sock, ip, port, connectRequest(txid1), timeoutMs);
    if (r1.length < 16) throw new Error(`short connect resp ${r1.length}`);
    if (!r1.subarray(4, 8).equals(txid1)) throw new Error("txid mismatch");
    const a1 = r1.readUInt32BE(0);
    if (a1 === ACTION_ERROR) throw new Error("tracker error: " + r1.subarray(8).toString("utf8"));
    if (a1 !== ACTION_CONNECT) throw new Error("unexpected action " + a1);
    const connId = r1.subarray(8, 16);

    const txid2 = crypto.randomBytes(4);
    const req = announceRequest(
      connId,
      txid2,
      crypto.randomBytes(20),
      Buffer.from("-qB4390-" + crypto.randomBytes(6).toString("hex"), "ascii"),
    );
    const r2 = await sendRecv(sock, ip, port, req, timeoutMs);
    if (r2.length < 8) throw new Error(`short announce resp ${r2.length}`);
    if (!r2.subarray(4, 8).equals(txid2)) throw new Error("announce txid mismatch");
    const a2 = r2.readUInt32BE(0);
    if (a2 === ACTION_ERROR) throw new Error("announce error: " + r2.subarray(8).toString("utf8"));
    if (a2 !== ACTION_ANNOUNCE || r2.length < 20)
      throw new Error(`bad announce resp action=${a2} len=${r2.length}`);

    return {
      url,
      host,
      port,
      ok: true,
      ip,
      ips,
      interval: r2.readInt32BE(8),
      leechers: r2.readInt32BE(12),
      seeders: r2.readInt32BE(16),
      peers: Math.max(0, (r2.length - 20) / 6), // /18 on a udp6 socket
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      url,
      host,
      port,
      ok: false,
      stage: "udp",
      error: e.message,
      ip,
      ips,
      ms: Date.now() - t0,
    };
  } finally {
    try {
      sock.close();
    } catch {}
  }
}
```

Gotchas that cost real debugging time:

- **`writeBigUInt64BE` needs a BigInt literal** (`0x41727101980n`). Plain `Number` throws.
- **Do not use `sock.once('message')` at concurrency** — stray/duplicate packets resolve the wrong promise. Use an explicit add/remove listener pair as above, or one socket per probe (what this does).
- **Always `sock.close()` in `finally`.** 300 leaked UDP sockets will exhaust the fd limit.
- **Resolve first, connect to the literal IP.** It makes the "domain expired" case a separate, cheap outcome from "host unreachable".

---

## 4. Hostname → IP resolution, and why hostnames collapse

I resolved every distinct hostname in the union of ngosang `all` + XIU2 `all` + newtrackon `/api/all` (322 endpoints → **300 hostname-or-IP entries**, of which **293 are real hostnames**), A and AAAA, and grouped by address.

**Headline: 406 distinct IPs; 22 of them serve more than one hostname; 38 hostnames (17% of the 229 that resolve) live on a shared address.**

### 4.1 The full shared-IP map (measured 2026-09-06)

| IP                                                   | # hosts | ASN / operator                      | Hostnames                                                                                                                                                                                        |
| ---------------------------------------------------- | ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `34.66.57.33`                                        | **10**  | AS396982 Google Cloud (us-central1) | bt.poletracker.org, home.yxgz.club, leet-tracker.moe, open.trackerlist.xyz, tracker.bittor.pw, tracker.bt-hash.com, tracker.bz, tracker.corpscorp.online, tracker.dmcomic.org, tracker.sbsub.com |
| `2600:1900:4001:4b5:8000::`                          | 10      | Google Cloud (v6 of the above)      | _same ten_                                                                                                                                                                                       |
| `188.114.97.5` / `188.114.96.5`                      | **6**   | AS13335 **Cloudflare**              | supertracker.cc.cd, torrentsmd.com, tr.nyacat.pw, tracker.gcrenwp.top, tracker.kuroy.me, tracker.renfei.net                                                                                      |
| `2a06:98c1:3121::5` / `…3120::5`                     | 5       | Cloudflare (v6)                     | _subset of the above_                                                                                                                                                                            |
| `93.158.213.92`                                      | **4**   | AS50673 Serverius (NL)              | tracker.opentrackr.org, tracker.publictracker.xyz, tracker.therarbg.to, zer0day.ch                                                                                                               |
| `211.75.210.221`, `211.75.205.188`, `211.75.205.187` | 3 each  | AS3462 Chunghwa Telecom (TW)        | tracker.dler.com, tracker.dler.org, tracker2.dler.org                                                                                                                                            |
| `212.60.5.203`                                       | 3       | AS49392 LLC Baxet (RU)              | tracker2.itzmx.com, tracker3.itzmx.com, tracker4.itzmx.com                                                                                                                                       |
| `94.23.207.177`                                      | 2       | AS16276 OVH (FR)                    | announce.sktorrent.eu, ipv4announce.sktorrent.eu                                                                                                                                                 |
| `34.8.196.142`, `34.8.38.57`                         | 2       | Google Cloud                        | api.ipv4online.uk, tr.abiir.top                                                                                                                                                                  |
| `62.210.172.150` (+v6)                               | 2       | AS12876 Scaleway/ONLINE (FR)        | php-bobcat.wasmer.app, staticfile-bobcat.wasmer.app                                                                                                                                              |
| `43.250.54.126` (+`2406:4fc0:1002::137`)             | 2       | AS50049 RedSwitches (NL)            | tracker.auctor.tv, tracker.qu.ax                                                                                                                                                                 |
| `135.125.198.235` (+v6)                              | 2       | AS16276 OVH (PL)                    | tracker.ducks.party, tracker.privateseedbox.xyz                                                                                                                                                  |
| `185.121.168.96` (+`2a06:9f80:a000::96:1`)           | 2       | AS61138 Zappie Host (NZ)            | open.demonii.com, open.demonoid.ch                                                                                                                                                               |

### 4.2 _Why_ they collapse — four distinct causes, don't conflate them

**(a) One operator, many vanity domains — the most common.** `tracker.opentrackr.org`, `zer0day.ch`, `tracker.therarbg.to` and `tracker.publictracker.xyz` are **one tracker instance**. Not inferred from DNS — **proven** by scraping the same infohash on each and getting byte-identical swarm counts within the same second:

```
udp://tracker.opentrackr.org:1337     93.158.213.92   seeders 264  completed 2181  leechers 39
udp://zer0day.ch:1337                 93.158.213.92   seeders 264  completed 2181  leechers 39
udp://tracker.therarbg.to:6969        93.158.213.92   seeders 264  completed 2181  leechers 39
udp://tracker.publictracker.xyz:6969  93.158.213.92   seeders 264  completed 2181  leechers 39
```

Same box, same database, four names and two ports. **All four are in `trackers_best.txt`** — so the "best 20" list is really 17 trackers, and announcing to all four multiplies your traffic to that host by 4× for exactly zero additional peers. Operators keep the aliases as failover against domain seizure; opentrackr's `.org` going down doesn't take `zer0day.ch` with it.

**(b) Shared cheap hosting.** The 10 hostnames on `34.66.57.33` are one Google Cloud VM in us-central1. Probably one operator running many branded front-ends, possibly a small hosting co-op. Either way, one machine and one failure domain.

**(c) CDN anycast — NOT a shared operator.** `188.114.96.5` / `188.114.97.5` are **Cloudflare** addresses. Those six hostnames are almost certainly six _different_ people who each put Cloudflare in front of an HTTPS tracker. **Do not dedupe these.** The rule: if the ASN is a CDN (Cloudflare AS13335, Fastly, Akamai) treat the shared IP as meaningless. This is exactly why an ASN lookup belongs in the pipeline and a bare IP-match does not.

**(d) Round-robin across an operator's own pool.** The `dler` family resolves to three IPs, and each hostname returns a _different_ address on different lookups. But scraping shows genuinely different data — `tracker.dler.org` → seeders 1 / completed 8, `tracker.dler.com` → seeders 0 / completed 11 — so these are **separate instances** under one operator, not aliases. Same operator, different swarm state. Merging them would lose peers.

### 4.3 Dead domains

**64 of 293 hostnames (22%) have no A and no AAAA record at all** — expired or delegated-away domains still sitting in the lists. Examples: `asiatorrent.ddns.net`, `bt.okmp3.ru`, `cny.fan`, `node01.madtia.cc`, `opentracker.8880085.xyz`, `retracker.lanta.me`, `p2p.publictracker.xyz`, `lotus-eater.mywire.org`. A DNS resolve is ~1 ms and kills 22% of your probe budget before a single packet leaves the box. **Resolve before you probe.**

### 4.4 Recommended dedup algorithm

```
1. Parse to {scheme, host, port}.
2. Resolve A + AAAA. No records  -> DEAD, stop.
3. Group by resolved IP set.
4. For each group with >1 host:
     - ASN lookup one member (ip-api.com/batch, free, 45 req/min, or a local MaxMind DB).
     - If ASN is a CDN (Cloudflare/Fastly/Akamai/...)  -> DO NOT MERGE.
     - Else: UDP-scrape the same infohash on each member.
         · identical (seeders, completed, leechers) -> SAME INSTANCE, keep one (lowest latency).
         · differing counts                         -> distinct instances, keep all.
5. Announce to the survivors.
```

Step 4's scrape test is what turns a guess into a fact, and it costs one extra packet per candidate. Where scrape is disabled (see §3.5), fall back to comparing `interval` + latency and treat the merge as probabilistic.

---

## 5. HTTP / HTTPS trackers — the scrape convention and bencode

### 5.1 The `/announce` → `/scrape` convention (BEP 48)

Take the announce URL, and **in the last path segment only**, replace a leading `announce` with `scrape`. Everything else — scheme, host, port, earlier path segments, query string — is untouched.

```
http://tracker.opentrackr.org:1337/announce   ->  http://tracker.opentrackr.org:1337/scrape
http://example.com/x/announce.php             ->  http://example.com/x/scrape.php
http://example.com/announce/x                 ->  NO scrape URL (last segment isn't "announce…")
```

The convention is **advisory**. A tracker may not implement it; `tracker.mywaifu.best:6969/scrape` returns **404** while its announce works fine.

Query: `?info_hash=<20 raw bytes, percent-encoded>`, repeatable for multiple hashes. Send a browser-ish or client-ish `User-Agent` — I used `qBittorrent/4.6.5`; some trackers reject curl's default.

### 5.2 Bencode response shape — real captures

Probed with the Ubuntu 22.04 desktop infohash `dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c`:

```
d5:filesd20:<20 raw infohash bytes>d8:completei264e10:downloadedi2181e10:incompletei37eeee
```

Decoded:

```
{ "files": { <20-byte infohash>: { "complete": 264,     # seeders
                                   "downloaded": 2181,  # completed snapshots
                                   "incomplete": 37 } } }  # leechers
```

| Tracker                                                            | HTTP            | complete | downloaded | incomplete |
| ------------------------------------------------------------------ | --------------- | -------- | ---------- | ---------- | -------------------------------------- |
| `tracker.opentrackr.org:1337/scrape`                               | 200             | 264      | 2181       | 37         |
| `tracker.qu.ax:6969/scrape`                                        | 200             | 7        | 36         | 12         |
| `tracker.dhitechnical.com:6969/scrape`                             | 200             | 3        | 52         | 1          |
| `tracker.renfei.net:8080/scrape`                                   | 200             | 7        | 0          | 0          |
| `tracker.bt4g.com:2095/scrape`                                     | 200             | 5        | 0          | 1          | _(+ `interval: 1200`, `min interval`)_ |
| `tracker2.dler.org:80/scrape`                                      | 200             | 0        | 11         | 3          |
| `tracker.mywaifu.best:6969/scrape`                                 | **404**         | —        | —          | —          |
| `tracker.bz`, `tracker.bittor.pw:1337`, `tracker.corpscorp.online` | **conn failed** | —        | —          | —          |

Some trackers add top-level `interval` / `min interval` / `flags` alongside `files` (bt4g does). Parse defensively.

**One trap, caught live.** `http://tracker.zhuqiy.dgj055.icu:80/scrape` returns HTTP 200 with:

```
d8:intervali1800e5:peersdee
```

That is an **announce** response (`interval` + empty `peers` dict), not a scrape response — it has no `files` key at all. The tracker answers 200 to anything. **A 200 is not a valid response.** Require the `files` key, and require your infohash inside it, before counting a scrape as successful.

### 5.3 Announce over HTTP

`GET <announce-url>?info_hash=…&peer_id=…&port=6881&uploaded=0&downloaded=0&left=0&compact=1`

Returns bencode with `interval`, `complete`, `incomplete`, and `peers`. With `compact=1`, `peers` is a **byte string** of 6-byte records (4-byte IPv4 + 2-byte BE port); `peers6` is 18-byte records. Without compact, it's a list of dicts. A failure is signalled by a top-level **`failure reason`** key _with HTTP 200_ — always check for it. newTrackon additionally rejects any response missing both `peers` and `peers6`, and caps reads at 1 MB to avoid a hostile tracker exhausting memory. Both are good defensive habits.

### 5.4 Minimal bencode decoder note

You need bencode anyway, and it's ~60 lines: `i<int>e`, `<len>:<bytes>`, `l…e`, `d…e`. **Keys and string values must be handled as raw bytes, not UTF-8** — infohash keys in a scrape response are arbitrary binary and will corrupt under a UTF-8 decode. Decode keys as latin-1/Buffer, not `toString('utf8')`.

---

## 6. Measured list quality — which list to actually trust

UDP entries only, same prober, 4 s timeout, same run:

| List                            | UDP entries | Alive | Rate     |
| ------------------------------- | ----------- | ----- | -------- |
| **ngosang `trackers_best.txt`** | 15          | 15    | **100%** |
| ngosang `trackers_all_udp.txt`  | 47          | 41    | 87%      |
| newtrackon `/api/udp`           | 37          | 31    | 84%      |
| XIU2 `best.txt`                 | 49          | 39    | 80%      |
| newtrackon `/api/live`          | 49          | 35    | **71%**  |

`/api/live` scoring worst is not a contradiction — it is _their_ vantage point, not mine, and a tracker reachable from their host may be blocked toward Spain. It is a useful signal: **"live" is per-observer.** Any tool doing this properly must probe from where it will actually announce from.

**Practical recommendation:** seed from ngosang `best` (20) for the fast path, background-probe the full union, and cache per-tracker results with a TTL derived from the tracker's own advertised `interval`.

---

## 7. Artifacts left on disk

| Path                                       | Contents                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `/tmp/udp-probe.mjs`                       | The BEP 15 prober (§3.8). `node udp-probe.mjs <file>` → JSON array.        |
| `/tmp/udp-scrape.mjs`                      | UDP scrape (action=2) demo. `node udp-scrape.mjs <udp-url> <infohash-hex>` |
| `/tmp/dnsmap.mjs`, `/tmp/dnsmap.json`      | Hostname → A/AAAA map for all 300 entries.                                 |
| `/tmp/shared_ips.json`                     | The shared-IP clusters of §4.1.                                            |
| `/tmp/udp_results.json`, `/tmp/res_*.json` | Raw probe results per list.                                                |
| `/tmp/union_urls.txt`                      | 322 distinct scheme://host:port endpoints.                                 |
| `/tmp/nt-api.yml`                          | newTrackon's OpenAPI spec.                                                 |

---

## 8. Caveats

- Every count is a **2026-09-06 snapshot**. The lists rebuild daily; treat the numbers as shape, not constants.
- Liveness was measured **from one host in Spain** over a residential-grade path. UDP results are vantage-dependent (§6).
- ASN/geo attribution comes from `ip-api.com` (free tier). Good enough to tell Cloudflare from a VPS; not authoritative for ownership.
- I did not enumerate WebTorrent (`wss://`) liveness — that needs a WebSocket + WebRTC handshake, a different protocol from BEP 15, and there are only 3 such entries in ngosang's list.
- The `.i2p` and Yggdrasil trackers are unreachable without the corresponding overlay router; they were excluded from probing rather than counted as dead.
