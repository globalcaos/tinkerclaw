# Presenting VIDEO results

The reader is visual-first: they decide with colour, position and bar length,
then read text to confirm. A table that must be _read_ has already failed.

## The decision the table has to serve

For a film or episode, in this order:

1. **Can I actually get it?** A perfect release with 2 seeders is worse than a
   good one with 200. Health gates everything else.
2. **How will it look?** Resolution first, then source tier, then bitrate.
3. **How will it sound?** Codec and channel layout — lossless vs lossy is the
   break that matters.
4. **What does it cost me?** Size and download time.

Columns exist in that order, left to right. Anything that does not answer one of
those four questions is a footnote.

## Columns

| column      | why it earns its place                                                            | visual encoding                                                                                            |
| ----------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **#**       | stable reference for "get number 3" across turns                                  | plain, tabular numerals                                                                                    |
| **Quality** | resolution is the single strongest signal                                         | **coloured chip** — amber 2160p+, blue 1080p, green 720p, grey below; source tier in small text under it   |
| **Picture** | plain-language source meaning, for readers who do not parse scene tags            | text: _untouched disc / from disc / from stream / re-encoded stream / broadcast_, plus HDR or Dolby Vision |
| **Sound**   | codec + channels, with lossless called out                                        | text, `· lossless` suffix                                                                                  |
| **Bitrate** | the honest quality tell — two 1080p files at 2 GB and 12 GB are not the same film | **bar**, length relative to the best row, plus the number                                                  |
| **Size**    | download cost and disk                                                            | right-aligned, tabular                                                                                     |
| **Swarm**   | how reliably it will finish                                                       | **bar + number**, coloured green ≥50 / blue ≥10 / yellow ≥3 / orange ≥1 / red 0                            |
| **Release** | group reputation and which indexer found it                                       | group in amber, indexer in grey, flags in red when suspect                                                 |

### Deliberately omitted

- **Language tags.** the operator reads English, Spanish, Catalan, French, Italian,
  German and most Portuguese. Subtitle availability is not a quality signal for
  him and must never move a ranking. Tags are parsed and available, just not
  shown unless he asks in that turn.
- **Publish date.** Age is not quality, and a fresh upload of a bad encode reads
  as "new" to the eye. Excluded on purpose.
- **Score.** The ordering already expresses it. Printing the number invites
  arguing with the arithmetic instead of looking at the evidence.

## Visual rules

- **Colour carries one meaning across every file type**: amber = best available,
  blue = good, green = adequate, grey = weak, red = suspect. Learn it once on a
  video table and a 3D-model table reads for free.
- **Bar length is always relative to the best row in the same table**, never to
  an absolute scale. The question is "compared to my other options", not
  "compared to all torrents".
- **The best pick gets its own card above the table**, restated in prose. A
  reader who stops after two seconds should still leave with the right answer.
- **Suspect rows stay visible but dimmed**, with a red left edge and their flags
  spelled out. Hiding them looks like a shorter list; showing them dimmed
  teaches the reader what a fake looks like.
- **Rejected candidates are never rows.** They get one summary line under the
  table with counts and reasons — a camcorder rip is not a low-quality option,
  it is not an option.
- **Zebra striping, generous row padding, tabular numerals.** Numbers that do
  not line up cannot be compared at a glance.

## Adding a new file type

1. Add an entry to `PRESENTERS` in `lib/presenters.mjs` — label, subtitle,
   columns, and an `omit` list stating what you are dropping _and why_.
2. Add a spec note beside this one in `references/presenters/`.
3. Reuse the shared vocabulary (`PALETTE`, `healthTier`, `bar`, `chip`). A new
   colour language per file type destroys the transfer that makes the tables
   fast to read.
4. Answer the same four questions in the type's own terms. For 3D models that
   is: can I get it → what format is inside (STL prints, STEP/F3D edits) → how
   many parts → how big. Resolution and audio are meaningless there and are
   omitted rather than left blank.

`models` and `docs` specs already exist in `lib/presenters.mjs` and follow this
shape; they need their file-list data from `inspect` before they can be rendered.
