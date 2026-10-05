---
name: torrent-scout
description: "Search torrent indexers for a title, then VERIFY each candidate's real file list, size and quality tags BEFORE a single content byte is transferred — so fakes, malware repackages and cinema-camcorder rips are caught up front. Ranks by picture and sound quality, never seeds, and refuses to download anything it has not inspected. Use when the user asks to find, evaluate, compare or retrieve a torrent for a film, a series, a 3D model or blueprint set, a document, or any large public file. Trigger phrases: 'find a torrent for X', 'is this torrent legit', 'what's the best quality version of X', 'check this magnet before I download it', 'dig deeper for more sources'."
license: Apache-2.0
argument-hint: "<title> | inspect <n> | fetch <n>"
allowed-tools: "Bash Read"
metadata:
  openclaw:
    requires:
      bins: [node]
---

# Torrent Scout

A torrent search engine that treats **verification as the product**. Anyone can
return 60 results; the work is proving which one is the thing you actually
wanted before you spend two hours and 40 GB finding out it was not.

Three commands, one conversation loop, and two rules that never bend.

---

## The two rules that never bend

**1. Nothing is downloaded that has not been inspected.** `fetch` exits with an
error if the candidate has no inspection record. The whole point of the skill is
that the file list is read _before_ the content is, and a flag you can override
casually is not a rule.

**2. Nothing is ever seeded.** Not throttled, not ratio-limited — off. When a
torrent advertises HTTP webseeds the download does not touch BitTorrent at all,
so there is no swarm to upload to. When it must use BitTorrent, upload is capped
at zero and the client is destroyed the instant the download completes; there is
no seeding phase in the code. Deliberate redistribution requires the infohash to
be added to `seedAllowlist` in the config by hand — a per-item decision, never a
flag.

> **Be honest with the user about what rule 2 does and does not buy.** Not
> seeding means you never redistribute a file. It does **not** make you
> invisible: any peer or monitoring host in a swarm can see the IP of everyone
> in it, downloader or not. Say this plainly when the BitTorrent route is used.
> The HTTP-webseed route has no swarm at all and is genuinely private by
> comparison — prefer it, and say when it was used.

---

## The conversation loop

This skill is used interactively. The user names a thing; you search, present,
and wait. You do not download on your own initiative — retrieval is always a
separate, explicit instruction.

```
user: "find me <title>"
  -> search.mjs "<title>" --kind movie --runtime <minutes>
  -> present the ranked candidates as a table, with their properties and flags

user: "dig deeper"            -> search.mjs "<title>" --deeper   (wider limits, filters dropped)
user: "only 4k" / "smaller"   -> re-run with --profile / re-filter the same state
user: "what's in number 3?"   -> inspect.mjs 3                   (real file list, no content bytes)
user: "get number 3"          -> fetch.mjs 3                     (never seeds)
```

Candidate numbers are stable between turns — they are persisted in
`~/.torrent-scout/last-search.json`, so "number 3" tomorrow still means the same
release. Re-running `search` replaces that state; say so if the user refers to a
number from a search you have since overwritten.

### Presenting results

**Render the table, do not describe it.** `render.mjs` emits an ```html-render
block sized for the Tinker chat:

```bash
node scripts/render.mjs [--limit 8] [--all]
```

The columns are chosen **per file type**, because the properties that separate
two films are not the ones that separate two blueprint packs. Specs live in
`lib/presenters.mjs` (machine) and `references/presenters/` (the reasoning).
`video` is fully specified; `models` and `docs` are declared and await file-list
data from `inspect`.

The design brief, in one line: **the reader is visual-first, so colour and bar
length carry the comparison and the text only confirms it.** Resolution is a
coloured chip, bitrate and swarm health are bars relative to the best row in the
same table, the recommended pick gets its own card above the table, suspect rows
stay visible but dimmed with their flags spelled out, and identical or
same-spec listings are marked so four front doors onto one file do not read as
four options. Full rules and rationale: `references/presenters/video.md`.

On channels that do NOT render HTML (WhatsApp, voice, SMS) fall back to the
plain-text list `search.mjs` already prints, where each row is marked `+` clean,
`~` minor flags, `!!` suspect.

Always state how many results were **rejected** and why in aggregate
("3 rejected — 2 camcorder, 1 dead swarm"). A silent filter is indistinguishable
from a broken search — the renderer prints this line under the table.

---

## The quality floor (movies and TV)

The user's standing instruction: **a film recorded in a cinema is never
acceptable.** Occluded frame, heads in the shot, terrible audio — not a
"low-quality option", simply not a result. `CAM`, `TS`, `TC`, `SCR`, `R5` and
`WORKPRINT` are gated out before ranking and never appear in the list.

**If the camcorder tiers are all that exists, the correct answer is "not
available yet", not "here is a bad one".** Say it in those words. The search
output detects this case and says so explicitly.

Ranking otherwise maximises **picture and sound**, in that order: resolution,
then source tier (REMUX > BluRay > WEB-DL > WEBRip > HDTV > DVDRip), then audio
tier (Atmos > TrueHD > DTS-HD > FLAC > DTS > E-AC3 > AC3 > AAC > MP3), then HDR,
bit depth and channel layout — with swarm health folded in, because a perfect
release nobody seeds is worth nothing. Size is **not** a penalty under the
default `best` profile: a 60 GB remux outranking an 8 GB encode is the intended
behaviour. Use `--profile balanced` or `compact` only when the user asks for
smaller.

### No subtitle logic, on purpose

The user reads English (native), Spanish, Catalan, French, Italian, German and
most Portuguese. Subtitle availability is therefore **not** a ranking signal and
must not be treated as one. Language tags present in a release name are parsed
and displayed so they can be _seen_, but they never move a candidate up or down.
Only filter on language if asked in that specific turn.

---

## Seeder counts are claims, not measurements

**Verify them.** Measured 2026-09-06 on one real search: a listing advertising
20 seeders had 2; another advertising 37 had 2; two advertising 15 and 1 were
completely dead. Every single candidate was inflated.

`swarm-check.mjs` does a BEP-15 **UDP scrape** against public trackers — a
connect handshake and a scrape, no announce, so you do not join the swarm and no
peer sees you. It writes `measuredSeeders` back into the search state. Where a
candidate exposes neither magnet nor working `.torrent`, it resolves the
infohash from the listing page the indexer itself linked to.

Run it before recommending anything. Swarm health is the one ranking input a
user can be actively misled about, and it decides whether the download finishes
at all — a perfect release with 2 seeders is worse than a good one with 200.

## NEVER promise a transfer to a process you cannot outlive

**Measured 2026-09-06:** an aria2 launched from a tool call with `setsid nohup`
was reaped when the turn ended, with **zero content bytes** downloaded, while
the agent reported it "running in the background". A background process started
inside an agent turn does not survive the turn. Saying otherwise is a promise
you cannot keep, and the user finds out by looking at an empty folder.

Downloads therefore go to a **systemd user service**:
`~/.config/systemd/user/torrent-scout-daemon.service` runs aria2 with JSON-RPC
on `127.0.0.1:6800`, `save-session` so queued tasks survive a restart, and
`seed-time=0 seed-ratio=0.0` so there is no seeding phase at all.

```bash
systemctl --user status  torrent-scout-daemon.service
systemctl --user restart torrent-scout-daemon.service
```

### The tray icon — status he owns, not status I report

`~/.local/share/download-tray/tray.py`, installed as
`download-tray.service` (WantedBy `graphical-session.target`), puts an indicator
in the system tray. It polls the daemon every 2s and **pulses while bytes are
actually moving** — deliberately NOT while a task is merely `active`, because a
pulse on a stalled download would claim progress that is not happening.

Expanding it lists every task with a progress bar, percentage, transferred /
total, speed, ETA, peers, and uploaded bytes, plus Open folder / Pause all /
Resume all / Restart daemon.

It fronts aria2's RPC, so it covers **any** download aria2 accepts — HTTP(S),
FTP, SFTP, magnet, `.torrent`. `daemon.mjs add <any-url>` is not torrent-specific.

Icon-design note bought by looking at the panel three times: GNOME recolours
symbolic icons and **flattens per-element opacity**, so an opacity pulse is
invisible; a 2px motion is too subtle at 22px. What reads is a **stroke-weight
throb** combined with a small descent. Verify any icon change by screenshotting
the actual panel — nothing else tells you.

`daemon.mjs board` renders live progress — percentage, bytes, speed, ETA, peers,
seeders and **bytes uploaded** (which should stay at 0). It marks a task
`stalled` when it is active but moving no bytes, and says why. **A status board
that cannot show bad news is decoration**; this one is the answer to "is it
actually downloading?", and it is allowed to say no.

## Coverage is the whole game — measured

One title, same query, same day:

| indexers | unique results |
| -------- | -------------- |
| 3        | 15             |
| 12       | 22             |
| **78**   | **190**        |

The pockets are real and they are disjoint. At 3 indexers the best option looked
like a 2-seeder 4K release; at 78, a **1080p release with 4 real seeders** appeared
at rank 26 — invisible before, and the only one that actually downloaded.

`import-bookmarks.mjs` reads Chrome/Chromium/Brave and Firefox bookmarks, keeps
torrent-looking hosts, and matches them to Jackett's catalog. `--all-public`
enables everything general-purpose. **If it parses zero bookmarks, treat that as
a broken parser, not an empty browser** — walking Chrome's `roots` object instead
of its values yields exactly zero and looks like a legitimate negative.

## The network layer — below the indexers

Indexers are one surface. Underneath sit three more, and they do not share
outages: the **tracker layer** (~500 public announce endpoints), the **site layer**
(Jackett's 554 definitions and every mirror they have ever had), and the **DHT**,
which will tell you what is being downloaded _right now_ if you ask it properly.

`net-scan.mjs` walks all of them and writes what answered to
`~/.torrent-scout/net-map.json`, so the next run starts from evidence instead of
from a list. Measured 2026-09-06 from this machine:

| surface                            | probed | answered            |
| ---------------------------------- | ------ | ------------------- |
| trackers (8 lists + newTrackon)    | 510    | **97**              |
| indexer sites + mirrors            | 485    | **250**             |
| keyless search backends            | 8      | **8**               |
| DHT nodes walked                   | —      | **2,300+**          |
| live infohashes harvested          | —      | **7,624**           |
| infohashes resolved to real titles | 90     | **30 (25–50%/run)** |

Two things make this evidence rather than a link dump. First, **liveness is
measured from here** — newTrackon's own `/api/live` scored worst of five lists
when probed from this connection, because reachability is a property of the path,
not of the tracker. Second, **a name pulled over BEP 9 is SHA-1-verified against
the infohash**, so a peer cannot lie about what it is sending.

The finding that nearly caused a bug: harvested infohashes clump hard on shared
prefixes, which looks exactly like a sybil node injecting fakes. It is not — a
DHT node stores infohashes near its own id, so BEP 51 samples are keyspace-local
by construction (`203a0…` hashes came from node `203a0574…`). The fix is to
stratify sampling across the id space, not to filter the data.

The second finding paid for the crawler. Sampling drew from `dht._rpc.nodes` —
Kademlia's routing table — which is built to retain nodes near your own id and
evict the rest, so coverage stuck at **35 of 256** keyspace buckets while the
nodes actually discovered spanned **175**. Keeping our own pool of every node
seen, same budget: **113/256 buckets and 5.3× the unique infohashes.** Ask what
a library is optimised to _forget_. Full write-up in `references/network-map.md`.

## Speeding up a thin swarm

You cannot create seeders. You can make sure you found all of them, and that is
usually the actual problem — a torrent's embedded tracker list is whatever its
creator pasted in years ago, and DHT alone finds a fraction of a small swarm.

`boost.mjs` merges a maintained public best-trackers list with **every tracker
announced by any other result for the same title** (the pockets do not share
tracker lists, which is precisely why they stay disconnected) and raises peer
limits. Measured 2026-09-06: a release sitting at 0 peers for hours reached
6–11 peers within a minute.

It improves **discovery, not bandwidth**. If a title genuinely has two seeders,
two seeders is the ceiling — which is why the honest move is often to switch to a
smaller release in a healthier pocket rather than to keep pushing the biggest one.
Seeding stays off; `boost` never touches `seed-time`/`seed-ratio`.

## Casting a wide net, and folding the pockets together

Public indexers have decayed — listings are duplicated, seeder counts inflated,
and some are bait. The same release ends up scattered across many infohashes,
each with a small pocket of seeders. So: **query many indexers, then work out
which of the results are the same file.**

Twelve indexers are configured in Jackett (from three) — widening the net took
one search from 15 unique results to 22, including foreign-dub variants worth
knowing about even when dead.

`same-file.mjs` decides identity on CONTENT, never on infohash. Piece length,
padding files, a trailing NFO and file ordering all change the hash while the
video stays byte-identical. Three escalating tests:

1. **shape** — same primary-file name-ish and **exact byte size**, from metadata
   alone, no content transferred. Different sizes ⇒ definitively different files.
2. **pieces** — where piece length and file offset align, matching piece hashes
   prove identity for free. Rare, but costs nothing to check.
3. **bytes** — fetch the first N MiB of the target file from each swarm
   independently and compare SHA-256. This is proof.

When two torrents prove identical, **their seeders are interchangeable** — the
pockets can be treated as one pool, and you can join both swarms for the same
file. When they are the same size but different bytes, you have found a bait
listing, which is exactly what a same-size collision looks like.

## Fake detection

Two stages. Name-level flags are free and immediate; file-level flags require
`inspect` and are far more reliable.

**From the name alone:** title mismatch against what was asked for, dead or thin
swarm, size implausible for the claimed resolution, a resolution claim the size
cannot support, and a resolution-independent bitrate floor that catches the very
common case of a clip, trailer or commentary track wearing a feature film's
title.

**From the real file list (`inspect`):** executables in a video torrent, decoy
files (`password.txt`, `how-to-download.url`, crack/keygen names), no video file
at all, archive payloads splitting a film into RAR parts, fragmentation, and
absurd file counts. It also reports `has-3d-models` / `has-documents`, which is
what makes the skill useful for blueprints and manuals rather than only films.

`inspect` recomputes the score against the **actual contents**, so a listing that
claimed 8 GB and delivers 400 MB is caught before anything is transferred.

Full heuristic list and the reasoning behind each threshold:
`references/fake-patterns.md`. Quality tier definitions:
`references/quality-ladder.md`.

---

## Commands

```bash
# search — fan out, rank, persist
node scripts/search.mjs "<title>" [--kind movie|tv|models|docs|any]
                                  [--profile best|balanced|compact]
                                  [--runtime <minutes>]   # size-plausibility basis
                                  [--limit <n>] [--deeper] [--only <source>] [--json]

# inspect — real file list, zero content bytes
node scripts/inspect.mjs <n|infohash|fragment> [--swarm] [--json]
#   default route is a plain HTTPS GET of the .torrent: no tracker, no DHT,
#   no peer learns you looked. --swarm is required for magnet-only results and
#   briefly announces you to that swarm — tell the user before using it.

# net-scan — walk the network below the indexers, and remember what answered
node scripts/net-scan.mjs trackers          # 8 lists + newTrackon -> resolve -> announce probe
node scripts/net-scan.mjs sites             # Jackett's definitions + every mirror, incl. redirects
node scripts/net-scan.mjs apis              # 8 keyless JSON/RSS backends, probed with a REAL query
node scripts/net-scan.mjs dht --seconds 150 # BEP 5 walk + BEP 51 keyspace-stratified sampling
node scripts/net-scan.mjs scrape [hash...]  # swarm size from every alive UDP tracker (max, not sum)
node scripts/net-scan.mjs all               # all of the above, in order
node scripts/net-scan.mjs map               # what is known, no network touched

# net-harvest — the map kept LIVE (runs as a systemd user service, not a subprocess)
node scripts/net-harvest.mjs --lanes 8 --save 60
#   systemctl --user status torrent-net-harvest.service    <- the running one
#   systemctl --user stop  torrent-net-harvest.service torrent-net-resolve.timer
#   Started, NOT enabled at boot. 'torrent-net-resolve.timer' names 40 more
#   infohashes every 15 min. Both Nice=10 / IO idle.

# net-resolve — turn harvested infohashes into names, over BEP 9
node scripts/net-resolve.mjs [--count 30] [--timeout 100] [--peers 30]
#   SHA-1-verifies every blob against its infohash; ~25-50% resolve per run,
#   which is peer availability, not a bug. Read-only: never announces.

# render — the comparison table, per-file-type columns
node scripts/render.mjs [--limit <n>] [--all]

# swarm-check — MEASURE the seeders instead of believing the listing
node scripts/swarm-check.mjs [n|all] [--json]

# daemon — the DETACHED downloader (survives the turn, the session, a reboot)
node scripts/daemon.mjs add <n|magnet|url>
node scripts/daemon.mjs status | board          # `board` = visual progress
node scripts/daemon.mjs pause|resume|remove <gid>

# import-bookmarks — turn the user's own bookmarked torrent sites into indexers
node scripts/import-bookmarks.mjs [--apply] [--all-public]

# boost — merge tracker lists into a thin swarm (discovery, not bandwidth)
node scripts/boost.mjs [gid|all]

# same-file — are two torrents carrying identical bytes?
node scripts/same-file.mjs shape                # cheap: compare primary-file sizes
node scripts/same-file.mjs bytes <a> <b> --mb 8 # proof: hash the same prefix from both

# fetch — retrieve, never seed
node scripts/fetch.mjs <n|infohash|fragment> [--dir <path>] [--video-only]
                                             [--dry-run] [--force]
```

`--runtime` matters: size plausibility is computed against it. Pass the real
runtime when known (look it up), otherwise the 105-minute default is used and
the flags are correspondingly less sharp.

## Configuration

`~/.torrent-scout/config.json`, created on first write:

```jsonc
{
  "indexers": [
    // generic Torznab. Prowlarr/Jackett both speak it.
    {
      "name": "prowlarr",
      "url": "http://localhost:9696/api/v1/indexer/1/newznab",
      "apiKey": "…",
      "categories": "2000,2040",
    },
  ],
  "useArchiveOrg": true, // public-domain source, on by default
  "downloadDir": "~/Downloads/torrent-scout",
  "profile": "best",
  "neverSeed": true,
  "seedAllowlist": [], // infohashes the user deliberately redistributes
}
```

**No third-party indexers ship with this skill.** It ships with archive.org
(public domain, legal everywhere) and a generic Torznab client. Which indexers
to point it at is the user's decision and lives entirely in their own config.
Setup guidance: `references/indexers.md`.

## Evaluation

`evals/queries.jsonl` holds graded queries with the expected outcome for each.
When you change a threshold or a weight, re-run them — a ranking change that is
not measured against the eval set is a guess, and this is the one part of the
skill that decays silently.

## This skill is the assembled whole; the parts ship separately

Decomposed 2026-09-06 so the reusable pieces are usable on their own:

| skill                      | what it is good for outside torrents                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`visual-tables`**        | any comparison table a human must read at a glance — five-tier colour vocabulary, chip/bar/number primitives, the per-domain column-spec pattern, and the render-then-LOOK discipline |
| **`media-release-parser`** | organising or deduplicating a media library, comparing two versions of a title, auditing what quality you actually have                                                               |
| **`torrent-verify`**       | "is this torrent legit?" on its own — reads a `.torrent` with no dependencies and no swarm contact                                                                                    |

Each is self-contained (it carries its own copy of the small libraries) so it
installs and runs alone. This skill keeps its own copies too; they are a few
hundred lines, and duplicating them costs far less than a shared runtime
dependency between independently installable skills.

## Scope and intent

This tool searches public indexes and retrieves files. Some of what it can find
is public domain, freely licensed, or the user's own; some of it is not, and the
legal position differs by country. **The skill enforces the technical rules it
can (verify first, never redistribute) and takes no position on what the user
chooses to retrieve.** That judgement is the user's, in their own jurisdiction.
See `README.md` for the full statement.
