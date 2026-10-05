---
name: media-release-parser
description: "Turn a scene/p2p media release name into structured quality metadata — title, year, season/episode, resolution, source tier (REMUX→CAM), video codec, audio codec and channels, HDR, bit depth, edition, language tags and release group. Use when organising or renaming a media library, deduplicating files, comparing two versions of the same title, deciding which of several files to keep, or auditing what quality you actually have. Also correctly identifies pre-retail sources (CAM/TS/TC/SCR/R5/WORKPRINT) without false-positiving on ordinary titles."
license: Apache-2.0
argument-hint: "<release name> | --file <list.txt>"
allowed-tools: "Bash Read"
metadata:
  openclaw:
    requires:
      bins: [node]
---

# Media release parser

`Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.7.1-FraMeSToR`
is a structured record wearing a filename. This turns it back into fields.

## Use

```bash
node scripts/parse.mjs "Dune.Part.Two.2024.2160p.BluRay.REMUX.TrueHD.Atmos.7.1-FraMeSToR"
node scripts/parse.mjs --file names.txt --json     # one name per line
ls *.mkv | node scripts/parse.mjs --stdin --table  # audit a library
```

```js
import { parseRelease, titleSimilarity, SOURCE_LADDER, AUDIO_LADDER } from "./lib/parse.mjs";
```

## What it returns

`title`, `year`, `season`, `episode`, `isEpisodic`, `resolution`, `source`,
`sourceRank`, `isCamcorder`, `videoCodec`, `audioCodec`, `audioRank`,
`audioChannels`, `hdr[]`, `bitDepth`, `edition`, `languages[]`, `group`,
`isProper`. Every field may be `null` — **an absent field means the NAME did not
say, never that the file lacks the feature.** Treat the two differently or you
will delete a good file for having a terse name.

## The two things it gets right that naive parsers do not

**Pre-retail sources are ranked, not just detected.** `SOURCE_LADDER` runs
`CAM < TS < TC < WORKPRINT < SCR < R5 < DVDRip < HDTV < WEBRip < WEB-DL <
BluRay < REMUX`, and `REJECT_REASON` gives each barred tier an accurate
human sentence — a workprint is an unfinished cut, not a camcorder rip, and
saying otherwise makes the tool look like it is guessing.

**Bare two-letter tags only count inside a scene-style name.** `CAM`, `TS`,
`TC`, `SCR`, `R5` are honoured only when the name is dot-separated with four or
more segments, or carries a resolution/codec/source token. Without that guard,
the 2018 film _Cam_ is classified as a camrip and a documentary about _TS_ is
thrown away. Unambiguous forms (`HDCAM`, `TELESYNC`, `DVDSCR`, `WORKPRINT`)
always count.

Group extraction handles `-GROUP`, `[GROUP]`, and `-GROUP[tracker]` — checking
the third form **first**, because otherwise `…-NTb[rartv]` returns the tracker
instead of the group.

## Comparing two names

`titleSimilarity(wanted, got)` returns 0–1 token overlap. Below ~0.5 the result
is usually a different work that merely shares a keyword — the single most common
cause of downloading the wrong film.

## Extending

Add patterns to the tables at the top of `lib/parse.mjs`; each is
`[regex, value]`, evaluated in order, most specific first. Ambiguous short tags
belong in `AMBIGUOUS_SOURCE_PATTERNS`, which is only consulted for scene-style
names.
