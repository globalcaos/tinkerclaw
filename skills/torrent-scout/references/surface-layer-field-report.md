# Alternative torrent discovery surfaces — verified field report

**Probed from:** this host (Linux, residential-class IP, Spain), `curl` + hand-written
Python clients for UDP/WSS/DHT.
**All probes executed:** 2026-09-06, ~12:00–12:25 UTC.
**Rule of this report:** every URL below was actually requested. Status codes and body
snippets are copied from real responses. Where something is dead, blocked, or was only
_partially_ verified, it says so. Nothing here is recalled from training.

Working files kept at `/tmp/nets/` (probe bodies, plus four reusable clients:
`udp_scrape.py`, `ws_tracker.py`, `dht_probe.py`, `dht_walk.py`).

---

## 0. Executive summary — what is actually worth building on

Ranked by (works right now × no anti-bot wall × structured output):

| #   | Surface                                                          | Endpoint                       | Format     | Verdict                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------ | ---------- | ---------------------------------------------------------- |
| 1   | **apibay** (TPB's own backend)                                   | `https://apibay.org/q.php?q=`  | JSON       | **Best search+firehose.** No key, no UA games, no CF       |
| 2   | **UDP tracker scrape** (BEP 15)                                  | 16 live trackers               | binary     | **Best popularity oracle.** 75 infohashes / round trip     |
| 3   | **DHT** (BEP 5)                                                  | `dht.transmissionbt.com:6881`  | KRPC       | **379 real peers, no tracker, no website**                 |
| 4   | **bitsearch / solidtorrents**                                    | `/api/v1/search?q=`            | JSON       | Rich (seed/leech/size/category + pagination). Rate-limited |
| 5   | **torrents-csv**                                                 | `/service/search?q=`           | JSON       | Small but clean, cursor pagination, open dataset           |
| 6   | **bt4g**                                                         | `/search?q=X&page=rss`         | RSS+magnet | DHT-derived, **the RSS path bypasses the CF wall**         |
| 7   | **snowfl**                                                       | `/{key}/{q}/{r}/0/SEED/NONE/0` | JSON       | Meta-aggregator (TPB+limetorrents), key is in the page     |
| 8   | **archive.org**                                                  | `advancedsearch.php`           | JSON       | **88,045,884** items with a `btih` field. Fully legal      |
| 9   | Per-site RSS (nyaa/EZTV/tokyotosho/limetorrents/torrentdownload) | various                        | RSS/JSON   | The genuine "uploaded right now" firehose                  |

**Dead or walled (do not build on these):** torrent-paradise.ml (domain repurposed into a
Hungarian casino site), idope.se / yts.mx / torrentgalaxy.to (NXDOMAIN on two independent
resolvers), btdig.com (429 + CAPTCHA on every search), 1337x.to (403 CF), anidex.info
(DDoS-Guard), knaben.eu (TLS completes, HTTP never answers), torrentz2.nz (500),
magnetdl (522), tordex.com (cert mismatch).

**Three findings that would otherwise bite you:**

1. **Several "different" trackers are one backend.** opentrackr, therarbg.to and
   publictracker.xyz returned _byte-identical_ seeder counts. Summing across trackers
   double-counts. (§4)
2. **UDP scrape silently truncates.** Ask for 80 infohashes, get 75 back with no error
   and no indication which were dropped. (§4)
3. **bitsearch "went down" mid-session and it was rate limiting, not an outage.** Six
   consecutive 500s; 75 s of quiet and every query returned 200 again. A naive liveness
   check would have marked a working API dead. (§1.3)

---

## 1. DHT-derived search engines with usable HTTP surfaces

### 1.1 apibay — The Pirate Bay's JSON backend ✅ THE BEST ONE

No API key, no browser challenge, no Cloudflare. This is the single most useful HTTP
surface found.

```
GET https://apibay.org/q.php?q=ubuntu&cat=0
→ HTTP 200, application/json, 27,773 B
[{"id":"59191690","name":"Ubuntu 22.04 LTS",
  "info_hash":"2C6B6858D61DA9543D4231A71DB4B1C9264B0685",
  "leechers":"4","seeders":"37","size":"3654957056","num_files":"1",
  "username":"rjaa","added":"1652877231","status":"vip","category":"303","imdb":""}, ...]
```

Detail endpoint (verified):

```
GET https://apibay.org/t.php?id=59191690
→ HTTP 200, 296 B
{"id":59191690,"category":303,"status":"vip","name":"Ubuntu 22.04 LTS",
 "num_files":1,"size":3654957056,"seeders":37,"leechers":4,...}
```

**Gotchas measured, not guessed:**

- Requires a browser `User-Agent`. Bare `python urllib` → **HTTP 403 Forbidden**. With
  `-A 'Mozilla/5.0'` → 200. (Reproduced both ways.)
- Pseudo-queries `q=top100:recent` and `q=category:303` are **NOT supported** — they
  return the sentinel row `[{"id":"0","name":"No results returned",
"info_hash":"0000...0000"}]`. Detect and discard that row; it is not an empty array.
- Empty results are that same sentinel, not `[]`. Handle it explicitly.

### 1.2 bt4g — DHT index, and the RSS path defeats its own Cloudflare wall ✅

`bt4g.org` 301s to `bt4gprx.com`. The HTML search is walled; the RSS is not:

| Path                                           | Result                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| `https://bt4gprx.com/search?q=ubuntu`          | **403** — CF "Just a moment..." interstitial   |
| `https://bt4gprx.com/search?q=ubuntu&page=rss` | **200**, `application/xml`, 24,515 B, 15 items |
| `https://bt4gprx.com/rss?q=ubuntu`             | 404                                            |
| `https://bt4gprx.com/search/ubuntu/rss`        | 301 → HTML (walled)                            |

Item shape (real, magnet truncated for readability):

```xml
<item>
 <title>Ubuntu-24.04</title>
 <link>magnet:?xt=urn:btih:30298aa0e8add718d47af71c564d1413c9f677da&amp;dn=Ubuntu-24.04
       &amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&amp;tr=... (15 trackers)</link>
 <guid isPermaLink="true">https://bt4gprx.com/magnet/WTUhIYBCTaN2lHmOd8BdHBfSeebAAAAAA</guid>
 <pubDate>Tue,1 Sep 2026 12:49:02 -0000</pubDate>
 <description><![CDATA[Ubuntu-24.04<br>5.56GB<br>Other<br>30298aa0e8add718d47af71c564d1413c9f677da]]></description>
</item>
```

Magnet arrives **complete with a tracker list** — no reconstruction needed. Size,
category and the raw infohash are `<br>`-delimited inside the CDATA description.
`&orderby=seeders` and `&category=movie` both accepted (200, differing payload sizes).
**No seeders/leechers field** — pair with §4 to get them.

### 1.3 bitsearch.eu / solidtorrents — richest JSON schema ✅ (rate-limited)

`solidtorrents.to`, `bitsearch.to` and `solidtorrents.net` all 301 to **bitsearch.eu**.
`solidtorrents.eu` serves on its own hostname but returns byte-identical payloads
(5,781 B / 5,963 B for the same queries) — **same index, two front doors**, not a
second source.

```
GET https://bitsearch.eu/api/v1/search?q=ubuntu
→ HTTP 200, application/json
{"success":true,"query":"ubuntu",
 "results":[{"id":"5cb8afc48700981f3e5b00c4",
   "infohash":"D540FC48EB12F2833163EED6421D449DD8F1CE1F",
   "title":"ubuntu-19.04-desktop-amd64.iso","size":2097152000,
   "category":1,"subCategory":7,"seeders":28,"leechers":41,
   "downloads":0,"verified":false,"updatedAt":"2026-09-06T10:30:17.098Z"}, ...],
 "pagination":{"page":1,"perPage":20,"total":5858,"totalPages":293,
               "hasNext":true,"hasPrev":false},
 "took":1}
```

Parameters **verified working**: `q`, `sort=seeders`, `limit=3` (honoured — returned
exactly 3), `page=2`, `category=1`. Not working: `/api/v1/latest` and `/api/v1/trending`
(both 500), and `q=` empty (500). There is no firehose here, only search.

⚠️ **The rate-limit trap.** Mid-session this API began returning 500/520 for every query
except `ubuntu` and `debian` (which stayed 200 — cached). It looked exactly like a
backend failure:

```
q=ubuntu 200 | q=debian 200 | q=sintel 520 | q=linux 500 | q=fedora 500 | q=blender 500
```

After a **75-second pause**, with no other change: `bitsearch.eu q=sintel → 200 5963B`,
`solidtorrents.eu q=ubuntu → 200 5781B`. It was throttling. Budget ≥1 req/s and treat
5xx as backoff-and-retry, never as "dead".

### 1.4 snowfl — meta-aggregator, key recoverable from the page ✅

`snowfl.com` is a JS app; the API key is a hardcoded constant in its bundle. Recovery
path, fully verified:

1. `GET https://snowfl.com/` → find `<script src="b.min.js?v=…">`
2. `GET https://snowfl.com/b.min.js?v=…` (150,871 B)
3. The key is the literal `var KZzXJDEtDOAcOR="WcRCzzUAZhbbjmSWuKfyLvSycKsyCymeqdiiyyXE"`
   — **note: the 498-char `?v=` value is a cache-buster, not the key.** The key is the
   40-char string.
4. URL shape from the minified source:
   `x="/"+KEY+("/"+a+"/"+u+"/"+f+"/"+m+"/"+g+"/"+b)`
   → `/{key}/{query}/{rand8}/{page}/{sort}/{filter}/{nsfw}`

```
GET https://snowfl.com/WcRCzzUAZhbbjmSWuKfyLvSycKsyCymeqdiiyyXE/ubuntu/VNDuaDyq/0/SEED/NONE/0
    (Referer: https://snowfl.com/)
→ HTTP 200, 150,944 B, 123 records
```

Fields: `magnet, age, name, size, seeder, leecher, type, site, url, trusted, nsfw`.
**Content-Type is `text/html` but the body is a JSON array** — do not gate your parser
on the content type. Sort values seen in use: `SEED`, `NONE`. `nsfw` is the trailing
`0|1`. Bonus: `/{key}/newsfeed` → 200, crypto-news JSON (unrelated to torrents).

**What it aggregates today:** `thepiratebay` (93 records) + `limetorrents` (30). That
is all — its historically wider source list has shrunk, so it is largely a convenience
wrapper over two sources you can query directly.

### 1.5 torrents-csv ✅ small, clean, open

```
GET https://torrents-csv.com/service/search?q=ubuntu
→ HTTP 200, application/json, 5,994 B
{"torrents":[{"infohash":"c9bc96d23542e5430f6bf8232b402a85172ca28b",
  "name":"The Ultimate Ubuntu Handbook ...","size_bytes":11513822,
  "created_unix":1788238728,"seeders":12,"leechers":0,"completed":15,
  "scraped_date":1788253648,"id":120814}, ...],
 "next": <cursor>}
```

- `size=` is **ignored**: `size=2`, `size=5` and `size=50` all returned exactly **25**
  records. Pagination is the `next` cursor, not a page size.
- `/service/list` → 404.
- The site root `https://torrents-csv.com/` returns **500** while `/service/search`
  returns 200 — the web UI is broken, the API is not. Don't health-check the root.
- Its dataset git host `git.torrents-csv.com` **no longer resolves**; mirrors of the
  server code exist on GitHub (`just5ky/torrents-csv`, `emtee40/torrents-csv-server`),
  but I could **not** verify a live download of the CSV dataset itself. Treat the "open
  dataset" claim as unconfirmed today.

### 1.6 Others probed in this tier

| Host                            | Result                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `btdig.com/`                    | 200 (landing page, Korean locale)                                                                                                                                                                    |
| `btdig.com/search?q=ubuntu`     | **429**, 56 KB anti-bot page containing `captcha`. Tried 4 URL variants + Referer + Accept-Language: 429 every time. **Unusable from this IP.**                                                      |
| `torrent-paradise.ml`           | **200 — but it is now a Hungarian online-casino site.** Domain repurposed. `/api/search?q=` returns the same casino HTML (89,834 B, identical byte size to the root) — a "200" here means nothing.   |
| `torrentproject2.net/?t=ubuntu` | 200, 52,840 B HTML (scrapable, no API found)                                                                                                                                                         |
| `torrentdownload.info`          | 200 + **has RSS**, see §2                                                                                                                                                                            |
| `idope.se`                      | NXDOMAIN (system resolver **and** Cloudflare DoH)                                                                                                                                                    |
| `tordex.com`                    | TLS cert subject mismatch — connection refused by verification                                                                                                                                       |
| `torrentz2.nz`                  | 500 (nginx)                                                                                                                                                                                          |
| `magnetdl.com`                  | 522 after 19.8 s (CF: origin unreachable)                                                                                                                                                            |
| `knaben.eu` / `api.knaben.eu`   | Resolves to 82.153.138.141, **TLS handshake completes**, then the server never sends an HTTP response. Both GET root and the documented `POST /v1` JSON search time out. Effectively dead from here. |
| `bitmagnet.io`                  | 200 — but this is the **self-hosted** DHT crawler's docs site, not a public index. Running it yourself is the only way to get a private, unwalled DHT index.                                         |

> **Methodological note.** Three domains failed to resolve on the system resolver. I
> re-resolved every one against Cloudflare DoH (1.1.1.1) to separate "dead domain" from
> "my ISP filters this". `torrentgalaxy.to`, `yts.mx` and `idope.se` returned no A
> record on **both**, while `thepiratebay.org`, `1337x.to`, `rarbg.to` and `nyaa.si`
> resolved fine on both. The failures are real, not local filtering.

---

## 2. RSS / Torznab — the "uploaded right now" firehose

### 2.1 The honest answer on Torznab

**There is no public Torznab endpoint, and there is not supposed to be one.** Torznab is
an adapter spec implemented by software _you host_ (Jackett, Prowlarr); the public
indexers speak plain RSS/HTML and the adapter normalises them. Verified:
`https://prowlarr.com/api/v1/indexer` returns **HTTP 200 but it is 35 KB of marketing
HTML** with Google Tag Manager — a catch-all route, not an API. Do not mistake that 200
for a working endpoint.

What _is_ publicly useful is the **definition corpus** — a machine-readable map of the
whole indexer ecosystem, including exact query paths and field selectors:

- `Prowlarr/Indexers` → `definitions/v11` = **549** YAML definitions (verified via
  GitHub API; sample: `0daykiev.yml`, `0magnet.yml`, `1337x.yml`, `1ptbar.yml`)
- `Jackett/Jackett` → `src/Jackett.Common/Definitions` = **555** Cardigann YAML definitions

Those are the highest-leverage artifacts in this whole report if you want breadth: they
encode how to query ~550 indexers without you reverse-engineering any of them.

### 2.2 Live public feeds (all verified in the final sweep)

| Source                     | Endpoint                                                 | Status | Payload               |
| -------------------------- | -------------------------------------------------------- | ------ | --------------------- |
| **apibay recent**          | `https://apibay.org/precompiled/data_top100_recent.json` | 200    | 50 recs               |
| **apibay 48h**             | `…/data_top100_48h.json`                                 | 200    | 100 recs, 30,556 B    |
| **apibay all/200/207/500** | `…/data_top100_{all,200,207,500}.json`                   | 200    | 100 recs each         |
| **nyaa.si**                | `https://nyaa.si/?page=rss`                              | 200    | 75 items, 77 KB       |
| **EZTV**                   | `https://eztvx.to/api/get-torrents?limit=3`              | 200    | JSON                  |
| **EZTV RSS**               | `https://eztvx.to/ezrss.xml`                             | 200    | 45,869 B              |
| **Tokyo Toshokan**         | `https://www.tokyotosho.info/rss.php`                    | 200    | **150 items**, 195 KB |
| **LimeTorrents**           | `https://www.limetorrents.lol/rss/16/` → `.fun`          | 200    | 50 items              |
| **torrentdownload.info**   | `https://www.torrentdownload.info/feed?q=ubuntu`         | 200    | 47 items              |
| **Academic Torrents**      | `https://academictorrents.com/rss.xml`                   | 200    | 30 items              |

**Freshness, measured (not assumed):** the apibay precompiled feeds are **cached, not
live**. At probe time `data_top100_recent.json`'s newest entry was **107.8 minutes old**
(median 131 min); `data_top100_48h.json` newest **100.0 min** (median 1,334 min). So the
precompiled JSON updates roughly hourly. For true real-time, poll `q.php` directly.

**EZTV** is the most structured of the RSS tier — it hands you a ready magnet:

```json
{
  "torrents_count": 1080106,
  "limit": 3,
  "page": 1,
  "torrents": [
    {
      "id": 3149778,
      "hash": "0ed348c776d278aa9dd33962fb7e39881cda3669",
      "filename": "Vigil.S03E03.XviD-AFG[EZTVx.to].avi",
      "magnet_url": "magnet:?xt=urn:btih:0ed348…&tr=udp://tracker.opentrackr.org:1337/announce&…"
    }
  ]
}
```

`torrents_count` rose from **1,080,103 → 1,080,106 during this session** — that is the
firehose visibly moving.

**nyaa is the closest public thing to a Torznab query surface.** All parameters verified:

| Query                                     | Result        |
| ----------------------------------------- | ------------- |
| `?page=rss`                               | 200, 75 items |
| `?page=rss&q=ubuntu`                      | 200, 1 item   |
| `?page=rss&c=1_2&f=0` (category + filter) | 200, 75 items |
| `?page=rss&q=&s=seeders&o=desc` (sort)    | 200, 75 items |
| `https://sukebei.nyaa.si/?page=rss`       | 200, 75 items |

It also emits a **custom XML namespace carrying the infohash directly** —
`<nyaa:infoHash>bee66812542d035a28262c85bc747d66025db2d3</nyaa:infoHash>` — no magnet
parsing needed. (I used exactly these hashes to drive the §4 scrape test.)

**torrentdownload.info** RSS puts everything in the description:

```xml
<title>Ubuntu 10 04 LTS x64</title>
<link>https://www.torrentdownload.info/Ubuntu-10-04-LTS-x64/A1425E0D6630336CDD9FB320F3FFF1030098975A</link>
<description>Size: 697.57 MB Seeds: 4341 , Peers: 2956 Hash: A1425E0D6630336CDD9FB320F3FFF1030098975A</description>
```

Infohash is in the URL **and** the description; seeds/peers are prose-formatted (regex,
not a field).

**Walled in this tier:** `anidex.info/rss/` → 403 DDoS-Guard JS challenge, later 502.
`torrentgalaxy.to` → NXDOMAIN (gone). One caution: `tokyotosho` returned a transient
**522** in one sweep, then 200 on three consecutive retries — single-probe liveness
checks lie; retry before declaring death.

---

## 3. IRC announce channels

### 3.1 What the layer actually is

The lowest-latency discovery layer in the ecosystem: an announce bot posts a line to an
IRC channel the instant a torrent is uploaded, and clients (`autodl-irssi`, Prowlarr's
IRC integration) regex it into a download. It beats RSS polling by minutes.

The public, verifiable artifact is **`autodl-community/autodl-trackers`** — 120
`.tracker` definition files (verified via GitHub API), each of which publishes the exact
IRC coordinates and parse contract. Real content of `AlphaRatio.tracker`:

```xml
<servers>
  <server network="AlphaRatio" serverNames="irc.alpharatio.cc"
          channelNames="#Announce" announcerNames="Voyager" />
</servers>
<extract>
  <regex value="\[New Release\]-\[(.*)\]-\[(.*)\]-\[URL\]-\[ (https?://.*)id=\d+ \]-\[ (\d+) \]…"/>
  <vars><var name="category"/><var name="torrentName"/>
        <var name="$baseUrl"/><var name="$torrentId"/><var name="preTime"/></vars>
</extract>
```

So the schema per tracker is: **network, server, channel, announcer nick, and a regex →
named-variable mapping.** 120 of these are public documentation.

### 3.2 Liveness — verified, with a deliberate limit

I ran a **read-only** probe: TCP+TLS connect, read the server's unprompted banner,
disconnect. **No registration, no NICK/USER, no JOIN, no messages sent to any channel.**

| Network               | Port | Result                                                                            |
| --------------------- | ---- | --------------------------------------------------------------------------------- |
| `irc.abjects.net`     | 6697 | **OPEN** — `:neptune.ny.us.abjects.net NOTICE * :*** Looking up your hostname...` |
| `irc.scenep2p.net`    | 6697 | **OPEN** — `:Quantum.SceneP2P.net NOTICE * :*** Looking up your hostname...`      |
| `irc.rizon.net`       | 6697 | **OPEN** — `:irc.mufff.in NOTICE * :*** Looking up your hostname...`              |
| `irc.libera.chat`     | 6697 | **OPEN** — `:molybdenum.libera.chat NOTICE …`                                     |
| `irc.alpharatio.cc`   | 6697 | **OPEN** — `:jupiter.alpharatio.cc NOTICE Auth :*** Looking up your hostname...`  |
| `irc.p2p-network.net` | 6697 | SSLV3_ALERT_HANDSHAKE_FAILURE (TLS config too old for modern OpenSSL)             |

**The blocker, stated plainly:** the networks are up, but essentially every announce
channel in the autodl corpus belongs to a **private tracker** and is gated behind an
account, a channel key, and usually a NickServ-registered nick bound to your tracker
profile. Verifying _channel contents_ would mean obtaining credentials on someone else's
private system — so I stopped at liveness and did not attempt it. **There is no public,
open-registration IRC announce channel that I was able to verify.**

The practical public equivalent of "the announce firehose" is §2: apibay's `q.php`, EZTV's
`torrents_count`, and nyaa's RSS. Latency is minutes rather than seconds — that is the
real cost of not being on IRC.

---

## 4. Tracker SCRAPE as a popularity oracle ⭐ the strongest result

### 4.1 The convention

Given an announce URL, the scrape URL is derived by replacing the **last path segment**
`announce` with `scrape` (BEP 48). If the path has no `announce` segment, the tracker
does not support scrape. Multiple infohashes go in **repeated `info_hash` parameters**,
each the raw 20 bytes percent-encoded (`sed 's/../%&/g'` over the hex is sufficient).

### 4.2 HTTP scrape — verified live

```
GET http://nyaa.tracker.wf:7777/scrape?info_hash=%be%e6…&info_hash=%bd%fb…&info_hash=… (5 hashes)
→ HTTP 200, 297 B, bencoded
d5:filesd
  20:<raw infohash> d8:completei13e 10:incompletei24e 10:downloadedi14ee
  20:<raw infohash> d8:completei13e 10:incompletei25e 10:downloadedi15ee
  20:<raw infohash> d8:completei1e  10:incompletei5e  10:downloadedi0ee
  20:<raw infohash> d8:completei2e  10:incompletei3e  10:downloadedi0ee
ee
```

**Five sent, four returned** — a tracker silently omits hashes it does not know. Match on
the returned key, never on request order. `complete`=seeders, `incomplete`=leechers,
`downloaded`=completed snatches.

Also live: `http://tracker.bt4g.com:2095/scrape` → 200, 117 B, valid bencode.
Failed to connect: `tracker.gbitt.info`, `tracker.tamersunion.org`, `open.acgnxtracker.com`,
`tracker.lilithraws.org`, `tracker.files.fm:6969`, `tr.burnabyhighstar.com` (HTTP over
443/80 all refused — these are UDP-only in practice).

Sending a foreign infohash to a private-index tracker returns the **empty** `d5:filesdee`
— correct behaviour, and a useful "this tracker doesn't cover that swarm" signal.

### 4.3 UDP scrape (BEP 15) — where the real coverage is

Implemented in `/tmp/nets/udp_scrape.py`. Two round trips: `connect` (action 0, magic
`0x41727101980`) → `connection_id`; then `scrape` (action 2) with N×20 raw bytes appended.
Response is 8 header bytes + N×12 (`seeders, completed, leechers` as big-endian uint32).

**Live result, 4 infohashes in ONE packet:**

```
tracker.opentrackr.org:1337   OK
  2C6B6858…0685 (Ubuntu 22.04)     seeders=39   completed=187    leechers=5
  611F7089…0328 (Ubuntu 24.04.2)   seeders=49   completed=1036   leechers=6
  08ADA5A7…5A10 (Sintel)           seeders=127  completed=2380   leechers=31
  DD8255EC…6D1C (Big Buck Bunny)   seeders=264  completed=2181   leechers=40
```

**Full sweep — 16 of 20 public UDP trackers answered** (seeders for the same 4 hashes):

| Tracker                               | Result                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `tracker.opentrackr.org:1337`         | OK — 39, 49, 128, 265                                             |
| `tracker.therarbg.to:6969`            | OK — 39, 49, 128, 265                                             |
| `tracker.publictracker.xyz:6969`      | OK — 39, 49, 128, 265                                             |
| `open.stealth.si:80`                  | OK — 27, 24, 13, 26                                               |
| `exodus.desync.com:6969`              | OK — 17, 15, 10, 15                                               |
| `tracker.torrent.eu.org:451`          | OK — 15, 24, 8, 14                                                |
| `tracker.auctor.tv:6969`              | OK — 13, 20, 5, 7                                                 |
| `tracker.qu.ax:6969`                  | OK — 13, 20, 5, 7                                                 |
| `open.demonii.com:1337`               | OK — 9, 14, 6, 11                                                 |
| `retracker01-msk-virt.corbina.net:80` | OK — 8, 10, 2, 5                                                  |
| `t.overflow.biz:6969`                 | OK — 7, 11, 1, 3                                                  |
| `tracker-udp.gbitt.info:80`           | OK — 7, 15, 5, 9                                                  |
| `ipv4announce.sktorrent.eu:6969`      | OK — 7, 7, 1, 3                                                   |
| `tracker.bittor.pw:1337`              | OK — 6, 9, 2, 2                                                   |
| `explodie.org:6969`                   | OK — 3, 7, 27, 74                                                 |
| `tracker.dler.org:6969`               | **ERROR: "Connection ID missmatch."** (rejects our connection_id) |
| `open.tracker.cl:1337`                | TIMEOUT                                                           |
| `tracker.internetwarriors.net:1337`   | TIMEOUT                                                           |
| `tracker.tiny-vps.com:6969`           | DNS: no address                                                   |
| `opentracker.i2p.rocks:6969`          | DNS: not known                                                    |

### 4.4 Limits — the part that matters

1. **Mirrors masquerade as independent sources.** opentrackr / therarbg / publictracker
   returned `39,49,128,265` — _identical across all three_. So did qu.ax and auctor.tv
   (`13,20,5,7`). **Never sum seeders across trackers.** Take the max, or dedupe by
   response fingerprint first. A naive sum here would have inflated Sintel by ~3×.
2. **Silent truncation at ~75 hashes.** Measured on opentrackr:

   | requested | rows returned                         |
   | --------- | ------------------------------------- |
   | 10        | 10                                    |
   | 40        | 40                                    |
   | 74        | 74                                    |
   | 75        | 75                                    |
   | **80**    | **75** ← 5 dropped, no error, no flag |

   BEP 15 specifies 74 as the max; opentrackr actually serves 75. Requesting more does
   **not** error — you silently lose the tail. Batch at 74 and verify the returned count.

3. **A scrape is a per-tracker view, not ground truth.** Same swarm, same instant:
   Sintel = 128 seeders on opentrackr, 27 on explodie, 13 on stealth, 1 on
   tracker.webtorrent.dev. The number you get is "peers _this tracker_ knows about".
   The union across trackers plus the DHT is the real swarm.
4. **No name, no metadata.** Scrape is infohash→counts only. You must already have the
   hash — this is a _ranking_ oracle bolted onto a discovery surface (§1/§2), never a
   discovery surface itself.
5. UDP is stateless and unauthenticated: connection_ids expire (~60 s), packets are
   silently dropped, and one tracker (`dler.org`) rejected ours outright. Retry logic is
   mandatory; treat a timeout as unknown, not as zero.

---

## 5. WebRTC / WebSocket tracker layer

Implemented in `/tmp/nets/ws_tracker.py` — JSON over WSS, `Origin: https://instant.io`.

| Tracker                                | Result                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| **`wss://tracker.openwebtorrent.com`** | **ALIVE** — `{"action":"announce","interval":120,"complete":24,"incomplete":3}` |
| **`wss://tracker.webtorrent.dev`**     | **ALIVE** — supports both scrape and announce                                   |
| `wss://tracker.files.fm:7073/announce` | 403 — rejects the WS upgrade                                                    |
| `wss://tracker.btorrent.xyz`           | Dead — **resolves to 127.0.0.1** (parked)                                       |
| `wss://tracker.novage.com.ua`          | Timeout during opening handshake                                                |
| `wss://tracker.magnetoo.io`            | Domain parked — 302 to `ww80.magnetoo.io/?subid1=…` ad landing                  |

`tracker.webtorrent.dev` answers the scrape verb:

```json
{"action":"scrape","files":{"\b­¥…":{"complete":1,"incomplete":0,"downloaded":0}}}
{"action":"announce","info_hash":"\b­¥…","complete":1,"incomplete":1,"interval":120}
```

**Protocol gotchas, measured:**

- **`openwebtorrent.com` closes the connection if you send `scrape` first.** Announce-only
  (`ConnectionClosedError` with scrape; clean 200-equivalent without it). webtorrent.dev
  accepts both. Do not assume the verb set is uniform.
- `info_hash` is sent as a **latin-1 binary string inside JSON**, not hex — it comes back
  the same way, so you must re-encode to compare.
- An announce with `"offers":[]` works on webtorrent.dev but openwebtorrent wanted a
  realistic offer array; sending one dummy SDP offer got the counts.

### What this layer actually adds — and it is not what you'd hope

**It is a separate, much smaller swarm, not a second view of the same one.** Same
infohash (Sintel), same minute:

| Layer                              | Seeders                |
| ---------------------------------- | ---------------------- |
| `tracker.opentrackr.org` (UDP)     | **127**                |
| `tracker.openwebtorrent.com` (WSS) | 24                     |
| `tracker.webtorrent.dev` (WSS)     | **1**                  |
| DHT iterative walk                 | **379 distinct peers** |

WebRTC peers are browser tabs — they exist only while someone has the page open, and they
are unreachable from a conventional TCP/uTP client. So for **discovery and popularity
ranking this layer adds close to nothing** (its counts are a rounding error against the
DHT). Its genuine value is different: it is the only layer reachable **from inside a
browser with no native client**, which matters if you ever want in-page playback or a
zero-install preview. For scouting purposes, deprioritise it.

---

## 6. Public datasets and dumps of infohashes

| Source                                    | Verified                           | Scale                                                           |
| ----------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| **archive.org** — `advancedsearch.php`    | **200, JSON**                      | **88,045,884** items                                            |
| **Academic Torrents** — `database.xml`    | **200, 2,905,895 B**               | 2,864 items, sanctioned full dump                               |
| **Academic Torrents** — `rss.xml`         | 200, 39,024 B                      | 30 newest                                                       |
| **apibay precompiled**                    | 200                                | 6 files × 50–100 recs, hourly                                   |
| `darksun-misc/piratebay-db-dump` (GitHub) | repo metadata 200                  | **276,637 KB**, TPB as of 2019-09-14, 26★, last push 2021-06-20 |
| `torrents-csv` dataset repo               | ❌ `git.torrents-csv.com` NXDOMAIN | unverified                                                      |

### 6.1 archive.org — the biggest _legal_ infohash corpus, with a real API

```
GET https://archive.org/advancedsearch.php?q=format%3A%22Archive+BitTorrent%22&rows=2&output=json
→ HTTP 200, application/json
{"response":{"numFound":88045884,"start":0,
  "docs":[{"btih":"8db27e54b03c7080670c29fdd908c58fdd4e1340",
           "collection":["wikimediadownloads","wikicollections"],
           "contributor":"Wikimedia Foundation", …}]}}
```

Every Internet Archive item with a torrent exposes a **`btih` field directly**, and you
can request it explicitly with `&fl[]=btih` (verified, 200). Paginate with
`rows` + `start`, or use the `scrape` API for deep cursors. 88 M infohashes, no auth, no
anti-bot, and entirely above-board — this is the one to build on if you need bulk.

### 6.2 Academic Torrents — the polite path is documented in the HTML

`browse.php` 302s to `checkb.htm`, whose HTML comment is an explicit instruction from the
operators:

> _"Hello if you are reading this you may be trying to scrape the browse page. This
> generates a lot of traffic for us so we instead ask you to search an XML file (in RSS
> format). These XML files are cached... The latest public entries:
> `https://academictorrents.com/rss.xml` The full database:
> `https://academictorrents.com/database.xml`"_

Both fetched successfully. Record shape:

```xml
<item><title>Advanced Data Structures (MIT 6.851) - Video lectures 2012</title>
 <category>Course</category>
 <infohash>a7ef136c1ad6c7924642a1ac399bc0800d9da4f4</infohash>
 <guid>https://academictorrents.com/details/a7ef136c1ad6c7924642a1ac399bc0800d9da4f4</guid></item>
```

Their `apiv2/collections/list` returns **404** — the XML files are the supported route.

---

## 7. The DHT itself — the surface underneath all the others ⭐

Everything in §1 is someone else's crawl of the DHT. You can query it directly. Verified
end to end with `/tmp/nets/dht_probe.py` and `/tmp/nets/dht_walk.py`.

**Bootstrap node liveness (BEP 5 `ping`):**

| Node                          | Result                                 |
| ----------------------------- | -------------------------------------- |
| `dht.transmissionbt.com:6881` | **PONG** — `node_id=7962b65813b697b1…` |
| `dht.libtorrent.org:25401`    | **PONG** — `node_id=1c11e01be8e78d76…` |
| `router.bittorrent.com:6881`  | timeout                                |
| `router.utorrent.com:6881`    | timeout                                |
| `dht.aelitis.com:6881`        | timeout                                |
| `router.bitcomet.com:6881`    | DNS: not known                         |

A single `get_peers` against a bootstrap node returns **`nodes` but no `values`** —
routers route, they don't store. Measured: `closer_nodes=8` and `closer_nodes=3`,
`values=0`, `token=no`. You must walk iteratively toward the infohash.

**The iterative walk, and it works:**

```
infohash 08ada5a7a6183aae1e09d831df6748d566095a10   (Sintel)
  nodes queried: 32          (~25 s, bounded budget)
  DISTINCT PEERS FOUND VIA DHT ALONE: 379
    103.219.21.51:56615   62.84.237.242:6881   159.192.33.138:12031
    87.199.197.250:25718  45.136.154.250:20310 83.76.232.169:22509 …
```

**379 live peers in 25 seconds with no tracker, no website, no API key, and nothing that
can 403, CAPTCHA or rate-limit you.** Compare: opentrackr reported 127 seeders for the
same hash. The DHT is both the most complete popularity oracle _and_ the only one with
no operator who can shut you out. Its one hard limit is that it is **keyed by infohash
only** — it cannot answer "find me X by name". That is exactly what §1/§2/§6 are for.

**The architecture this suggests:** discover by name via apibay/bt4g/archive.org →
rank by UDP scrape across 3–4 _deduplicated_ trackers → confirm real availability with a
bounded DHT walk. Each layer covers the previous one's failure mode.

---

## 8. Reusable artifacts left on disk

| File                      | What it does                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `/tmp/nets/probe.sh`      | Generic HTTP probe → status, size, content-type, body snippet   |
| `/tmp/nets/udp_scrape.py` | BEP 15 multi-infohash UDP scrape (`host:port hash [hash…]`)     |
| `/tmp/nets/ws_tracker.py` | WebTorrent WSS announce/scrape probe                            |
| `/tmp/nets/dht_probe.py`  | BEP 5 ping + single get_peers, with a pure-python bencode codec |
| `/tmp/nets/dht_walk.py`   | Bounded iterative DHT lookup → distinct peer list               |

All five ran successfully to produce the numbers above.

---

## 9. What I could not verify, stated plainly

- **btdig** — 429 + CAPTCHA on all 4 URL variants attempted. I did not try to defeat the
  challenge. Unusable from this IP; unknown whether it works from a residential proxy.
- **IRC announce channel contents** — networks verified up, but every announce channel in
  the 120-definition corpus is on a private tracker requiring an account and channel key.
  I stopped at TCP liveness rather than seek credentials on third-party systems.
- **torrents-csv's open dataset** — the API works, but its git host no longer resolves and
  I found no live CSV download. The "open dataset" property is currently unconfirmed.
- **knaben** — TLS completes but no HTTP response ever arrives, on both the root and the
  documented POST API. Cannot distinguish "down" from "blocking this IP/ASN".
- **Coverage/overlap sizes** — I measured which surfaces are alive and what they return
  per query, not how large or how disjoint their indexes are. bitsearch reports
  `total: 5,858` for "debian"; apibay and torrents-csv expose no total. Any claim about
  which index is _bigger_ would be a guess and I have not made one.
