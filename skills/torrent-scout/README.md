# Torrent Scout

**A torrent search engine where verification is the product.**

Anyone can return sixty results. The work is proving which one is the thing you
actually wanted — before you spend two hours and forty gigabytes finding out it
was a 400 MB re-encode with an installer bolted on.

```
$ node scripts/search.mjs "dune part two" --kind movie --runtime 166

 +  1. [219] Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.7.1-FraMeSToR
         2160p · REMUX · Atmos 7.1 · DolbyVision/HDR10 · -FraMeSToR
         82.0G · 41 seed / 6 leech
 +  2. [158] Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX
         1080p · WEB-DL · H264 · Atmos 5.1 · -FLUX
         8.0G · 920 seed / 44 leech
 !! 3. [102] Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.HDR.H.265-NAISU
         2160p · WEB-DL · HEVC · EAC3 5.1 · HDR10
         0.4G · 14 seed / 2 leech
         flags: size-implausible-low, resolution-claim-unsupported

  (3 rejected — 2 camcorder, 1 dead swarm)
```

The 2,200-seeder camcorder rip was the single most popular result. It is not in
the list, because it never will be.

## What it does that other tools do not

**Reads the real file list before you download anything.** `inspect` fetches the
torrent's _metadata_ — file names, exact sizes, piece layout — and re-scores the
candidate against its actual contents rather than its advertised name. When the
indexer provides a `.torrent` URL this is a plain HTTPS GET: no tracker, no DHT,
no peer ever learns you looked. Zero content bytes are transferred either way.

**Catches fakes with two independent stages.** From the name: title mismatch,
dead swarms, sizes that cannot support the claimed resolution, and a bitrate
floor that flags the clip-wearing-a-feature-film's-title case. From the file
list: executables in a video torrent, `password.txt` decoys, RAR-split payloads,
missing video, absurd file counts.

**Refuses the camcorder tiers outright.** `CAM`, `TS`, `TC`, `SCR`, `R5` and
`WORKPRINT` are gated before ranking. If they are all that exists, the answer is
_"not available yet"_ — not _"here is a bad one"_. Bare two-letter tags are only
honoured inside a scene-style release name, so the 2018 film literally titled
_Cam_ is not mistaken for a camrip.

**Never seeds.** Not throttled — off. Torrents advertising HTTP webseeds are
downloaded over plain HTTPS with no BitTorrent involvement at all. Otherwise
upload is capped at zero and the client is torn down the moment the download
completes; there is no seeding phase in the code. Redistribution requires adding
an infohash to an allowlist by hand.

**Ranks on picture and sound, not on popularity.** Resolution, then source tier,
then audio tier, then HDR and channel layout, with swarm health folded in
because a perfect release nobody seeds is worth nothing.

## Install

```bash
git clone <this skill> ~/.openclaw/workspace/skills/torrent-scout
cd ~/.openclaw/workspace/skills/torrent-scout
npm install          # optional: only needed for magnet-only results
```

Node 18+. No other dependencies for the primary path — the bencode decoder is
included, so reading a `.torrent` needs nothing but `node`.

## Sources

Ships with **archive.org** (public domain, legal everywhere, HTTP-webseeded) and
a **generic Torznab client**. It contains no third-party indexer list, by design:
which indexes to query is your decision and lives in your own config. Point it at
[Prowlarr](https://prowlarr.com/) or [Jackett](https://github.com/Jackett/Jackett)
and it inherits whatever you have configured there — see `references/indexers.md`.

It is also genuinely useful for things that have nothing to do with film:
archive.org carries public-domain books, scanned manuals, engineering documents
and software, and `inspect` reports `has-3d-models` when a torrent contains STL,
STEP, 3MF, DXF or similar — which makes it a reasonable way to check a blueprint
or model pack before pulling it.

---

## Disclaimer — read this

**This skill is not unlawful by design. It is a search-and-verify client, and
what it is pointed at determines everything.**

BitTorrent is a transfer protocol. The same three commands retrieve a Debian
image, a public-domain film, a CERN dataset, a Creative Commons album, a
manufacturer's own firmware, and things that are none of those. The tool cannot
tell the difference and does not try to.

- **No third-party indexers are bundled.** Out of the box it searches
  archive.org, which is public domain. Every other source is one _you_ add.
- **Copyright law varies enormously by country** — on downloading, on
  redistribution, and on whether those are treated differently at all. In many
  jurisdictions uploading is treated far more seriously than downloading; that
  asymmetry is a large part of why this tool never seeds.
- **The legal exposure is on what you retrieve, not on the software.** Searching
  a public index is not the same act as acquiring a specific work, and only you
  know which work you are acquiring and what your rights to it are.
- **Not seeding is not anonymity.** Any participant in a BitTorrent swarm can
  observe the IP addresses of everyone else in it, downloaders included. This
  tool prefers HTTP webseeds precisely because that route has no swarm — but
  when it must use BitTorrent, it tells you so.

**Use it for what you are entitled to use it for. That determination is yours,
in your jurisdiction, and the authors make no warranty and accept no liability
for it.** Apache-2.0: provided as-is, without warranty of any kind.
