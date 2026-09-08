# Fake patterns — what the flags mean and why each threshold is where it is

Flags come in two waves. Name-level flags are free and computed at search time.
File-level flags require `inspect` and are far more trustworthy, because a name
is a claim and a file list is evidence.

## Name-level

| flag                           | test                                                      | penalty  | reasoning                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title-mismatch`               | token overlap with the requested title < 0.5              | **gate** | Indexers keyword-match loosely. Asking for _Dune Part Two_ and being handed _Dune_ (1984) is the single most common wasted download.                                                                      |
| `dead-swarm`                   | 0 seeders                                                 | **gate** | Not a quality problem — the file is unobtainable.                                                                                                                                                         |
| `thin-swarm`                   | 1–2 seeders                                               | −15      | Retrievable but likely to stall.                                                                                                                                                                          |
| `size-implausible-low`         | implied bitrate below the band for the claimed resolution | −30      | See the bands below.                                                                                                                                                                                      |
| `size-implausible-high`        | implied bitrate above the band                            | −8       | Usually a legitimate remux; mild flag only.                                                                                                                                                               |
| `resolution-claim-unsupported` | claims ≥1080p in under 500 MB                             | −40      | 1080p at 500 MB for a feature is arithmetically impossible at any usable quality. Nearly always a re-encode of a camrip or a decoy.                                                                       |
| `size-tiny`                    | under 100 MB for a feature                                | −40      | Not a film.                                                                                                                                                                                               |
| `runtime-size-mismatch`        | implied bitrate < 0.35 Mbps at any resolution             | −45      | **The most useful flag on untagged sources.** Catches clips, trailers, commentary tracks and interviews carrying the film's title — very common on archive.org, where names carry no quality tags at all. |

### Plausible bitrate bands (Mbps)

| resolution | min  | max |
| ---------- | ---- | --- |
| 4320p      | 20   | 400 |
| 2160p      | 5    | 220 |
| 1440p      | 3    | 80  |
| 1080p      | 1.2  | 70  |
| 720p       | 0.6  | 25  |
| 480p       | 0.25 | 10  |

Computed as `size × 8 ÷ (runtime × 60)`. **Accuracy depends entirely on passing
a real `--runtime`.** With the 105-minute default a three-hour film looks
suspiciously large and a 40-minute episode looks fake. Look the runtime up when
it matters.

## File-level (requires `inspect`)

| flag                 | test                                                                 | penalty       | reasoning                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `executable-payload` | any `.exe .msi .scr .bat .cmd .apk .dmg .lnk .vbs .ps1 .jar`         | **gate**      | The classic malware repackage: a tiny video plus "codec installer". There is no legitimate reason for an executable in a film torrent.      |
| `no-video-file`      | no video extension in a torrent offered as video                     | **gate**      | The advertised content is simply not present.                                                                                               |
| `decoy-files`        | `password.txt`, `how-to-download.url`, `crack`, `keygen`, `activate` | −35           | A password-protected archive means someone wants you on their website first.                                                                |
| `archive-payload`    | `.rar`, `.r00`, `.7z`, `.zip`                                        | −12           | Old scene convention, still legitimate sometimes — but it also hides what is inside from inspection, which is the whole point of this tool. |
| `fragmented`         | largest file < 60% of total, for a single work                       | −10           | A film split into sample/proof/junk, or the wrong thing entirely.                                                                           |
| `file-count-anomaly` | > 300 files for a single film or episode                             | −15           | Usually a pack mislabelled as one title.                                                                                                    |
| `has-3d-models`      | `.stl .3mf .obj .step .dxf .scad .gcode .blend .fbx`                 | informational | Not a fault — confirms a blueprint or model pack is what it claims.                                                                         |
| `has-documents`      | `.pdf .epub .djvu .cbz`                                              | informational | Same, for manuals and scans.                                                                                                                |

Flags marked **gate** remove the candidate entirely. `size-implausible-low`,
`resolution-claim-unsupported`, `size-tiny`, `runtime-size-mismatch`,
`decoy-files` and `file-count-anomaly` are **severe**: they mark the verdict
`suspect` so the row renders as `!!` even when the score survives.

## What this cannot catch

Be straight about the limits:

- **A correctly named, correctly sized file with the wrong content inside.** No
  metadata check catches a well-made fake. Only playing it does.
- **Re-encodes claiming a better source than they have.** A camrip cleaned up
  and relabelled `WEB-DL` passes every name-level test. Swarm health and release
  group reputation are the only signals, and both are weak.
- **Whether the audio is the language you want.** Language tags in release names
  are frequently absent or wrong.

The honest summary: this catches the cheap fakes, which is most of them, and it
tells you exactly what you are about to receive. It does not certify quality.
