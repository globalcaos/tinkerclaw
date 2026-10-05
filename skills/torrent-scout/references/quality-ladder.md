# Quality ladder — what the tiers mean and why they rank where they do

## Source tiers, worst to best

| tier        | what it physically is                                                                                                              | verdict   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `CAM`       | a camcorder pointed at a cinema screen. Heads in frame, keystoned image, room audio.                                               | **gated** |
| `TS`        | telesync — same camera, audio taken from a jack or an assistive-listening feed. Sound is better; the picture is still a camcorder. | **gated** |
| `TC`        | telecine — captured off a film print with a scanner. Better than a camera, still pre-retail and usually badly graded.              | **gated** |
| `WORKPRINT` | an unfinished cut. Missing VFX, temp music, timecode burn-in, sometimes scenes that were cut.                                      | **gated** |
| `SCR`       | screener — a review copy, watermarked, often with anti-piracy overlays mid-scene.                                                  | **gated** |
| `R5`        | a fast retail rip from a specific region, historically poor transfers.                                                             | **gated** |
| `DVDRip`    | from retail DVD. 576p at best.                                                                                                     | 3 pts     |
| `HDTV`      | broadcast capture. Station bugs, cut for time, ad breaks.                                                                          | 8 pts     |
| `WEBRip`    | screen-scraped from a streaming service. Re-encoded, so a generation of loss.                                                      | 18 pts    |
| `WEB-DL`    | pulled from the streaming service's own file. No re-encode. Usually the best realistic option for a recent title.                  | 32 pts    |
| `BluRay`    | encoded from the disc. Compressed, but from the best available master.                                                             | 40 pts    |
| `REMUX`     | the disc's streams copied bit-for-bit into a container. Zero quality loss. Enormous.                                               | 45 pts    |

The six gated tiers are not "low quality options" — they are excluded before
ranking and never shown. If a title exists only in those tiers, the honest
answer is that it is **not available yet**.

## Audio tiers, worst to best

`MP3` (1) · `AAC` (5) · `AC3`/Dolby Digital (9) · `E-AC3`/DD+ (12) · `DTS` (16) ·
`FLAC` (20) · `DTS-HD MA` (25) · `TrueHD` (27) · `Atmos` (30)

The break that matters is **lossy vs lossless**: everything up to and including
DTS is lossy; FLAC, DTS-HD MA and TrueHD are not. Atmos is an object-based layer
carried on top of TrueHD or E-AC3 — it ranks highest because a release tagged
Atmos is nearly always sourced from the disc.

## Resolution

`480p` (5) · `720p` (25) · `1080p` (60) · `1440p` (72) · `2160p` (100) · `4320p` (115)

Under the default `best` profile resolution carries full weight and size carries
no penalty at all. A 60 GB remux outranking an 8 GB encode is intended. Use
`--profile balanced` (size penalty above 20 GB) or `compact` (above 6 GB) when
the user asks for something smaller.

## Extras

`DolbyVision` +12 · `HDR10+` +9 · `HDR10` +7 · `HLG` +4 · 10-bit +4 ·
7.1 +6 / 5.1 +4 · `PROPER`/`REPACK` +3 · a named edition +2 ·
AV1/HEVC +3–4, H.264 +2, **XviD −12** (a 20-year-old codec on a modern release
is a red flag about the whole encode).

## Swarm health

`min(30, 12 · log10(1 + seeders))` — 10 seeders ≈ 12 pts, 100 ≈ 24, 1000 ≈ 30
(capped). Deliberately logarithmic: the difference between 5 and 50 seeders
matters enormously, between 500 and 5000 barely at all. Zero seeders is a hard
rejection, not a penalty — the file cannot be retrieved.

Sources with HTTP webseeds (archive.org) get a flat 25: availability is
guaranteed by a web server, so swarm size is irrelevant.
