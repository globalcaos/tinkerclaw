---
name: torrent-verify
description: "Read what is actually inside a .torrent or magnet BEFORE downloading a single content byte — real file list, exact sizes, piece layout, trackers, webseeds — and flag the classic fakes: executables in a video torrent, password-protected decoys, RAR-split payloads, missing video, absurd file counts, and sizes that cannot support the claimed quality. Use when asked 'is this torrent legit', 'what's actually in this magnet', 'check this before I download it', or when auditing a .torrent file. Dependency-free for .torrent URLs and files: no swarm contact, no tracker announce, nobody learns you looked."
license: Apache-2.0
argument-hint: "<url|path|magnet> [--json]"
allowed-tools: "Bash Read"
metadata:
  openclaw:
    requires:
      bins: [node]
---

# Torrent verify

A torrent listing is a **claim**. The metadata is **evidence**. This reads the
evidence.

## Use

```bash
node scripts/verify.mjs https://example.org/file.torrent
node scripts/verify.mjs ./local.torrent --json
node scripts/verify.mjs "magnet:?xt=urn:btih:…"        # needs a client; see below
```

## Two routes, and the privacy difference matters

**A `.torrent` URL or file → plain read.** Fetched over HTTPS or read from disk
and decoded locally by the bundled bencode parser. **No tracker, no DHT, no
peer**, zero content bytes, and nobody learns you looked. Needs nothing but
`node`.

**A magnet → the file list lives with the peers.** Getting it means announcing
to that swarm, so your IP is briefly visible to everyone in it. The tool says so
and requires `--swarm` before doing it. It also needs an external client, since
the JavaScript ones are unreliable here — pass `--client aria2c` and it will
shell out to `aria2c --bt-metadata-only --bt-save-metadata`, which fetches the
`.torrent` and no content.

Prefer converting a magnet to a `.torrent` via the indexer that offered it, if
one exists. The quiet route is always better.

## What it flags

| flag                              | test                                                        | why it matters                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `executable-payload`              | `.exe .msi .scr .bat .cmd .apk .dmg .lnk .vbs .ps1 .jar`    | the classic malware repackage: a tiny video plus a "codec installer". There is no legitimate reason for an executable in a media torrent |
| `decoy-files`                     | `password.txt`, `how-to-download.url`, `crack`, `keygen`    | a password-protected archive means someone wants you on their website first                                                              |
| `no-video-file`                   | no video extension in something offered as video            | the advertised content is simply not present                                                                                             |
| `archive-payload`                 | `.rar`, `.r00`, `.7z`, `.zip`                               | sometimes legitimate, but it hides the contents from exactly this inspection                                                             |
| `fragmented`                      | largest file < 60% of total for a single work               | sample/proof/junk, or the wrong thing entirely                                                                                           |
| `file-count-anomaly`              | > 300 files for one title                                   | usually a pack mislabelled as a single item                                                                                              |
| `size-implausible`                | implied bitrate outside the band for the claimed resolution | a 500 MB "1080p" feature is arithmetically impossible                                                                                    |
| `has-3d-models` / `has-documents` | STL/STEP/3MF/DXF, PDF/EPUB/CBZ                              | informational — confirms a blueprint or book pack is what it claims                                                                      |

## What it cannot catch — say so out loud

- **A correctly named, correctly sized file with the wrong content inside.** No
  metadata check catches a well-made fake. Only playing it does.
- **A re-encode claiming a better source than it has.** A cleaned-up camrip
  relabelled `WEB-DL` passes every name-level test.
- **Whether the audio is the language you want.** Tags are frequently absent or
  wrong.

The honest summary: this catches the cheap fakes, which is most of them, and it
tells you exactly what you are about to receive. It does not certify quality.

## The bencode decoder

`lib/bencode.mjs` is ~110 lines, no dependencies, and tracks byte offsets so it
can compute the real infohash (SHA-1 over the raw `info` dict). Reusable on its
own for anything that reads torrent metadata.
