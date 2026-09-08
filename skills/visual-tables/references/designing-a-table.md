# Designing a table someone can read at a glance

## Start from the decision, not the data

The wrong question is _"what fields do I have?"_. The right one is _"what is the
reader about to decide, and what would change their mind?"_ Columns exist in the
order those factors matter, left to right.

Worked example — torrent search results for a film. The decision is _which one
do I download tonight_, and the factors, in the order a viewer actually weighs
them, are: **can I get it** (swarm health) → **how will it look** (resolution,
source, bitrate) → **how will it sound** (codec, channels) → **what does it cost
me** (size). Eight columns, each answering one of those four questions.

Dropped from that table, on purpose:

- **language tags** — the reader speaks seven languages, so they never move his
  ranking. Parsed and available; simply not shown.
- **publish date** — age is not quality, and a recent upload of a bad encode
  reads as "new" to the eye.
- **the numeric score** — the row order already expresses it. Printing it invites
  arguing with the arithmetic instead of looking at the evidence.

## Encodings, and when each earns its place

| encoding                            | use for                                       | why                                                                                  |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| **coloured chip**                   | the one attribute that most determines rank   | the eye finds colour before it finds text; more than one per row destroys the anchor |
| **bar**                             | any magnitude the reader compares across rows | length is pre-attentive; a number is not                                             |
| **tabular numerals, right-aligned** | sizes, prices, counts                         | digits that do not line up cannot be compared at a glance                            |
| **dimmed italic**                   | missing data                                  | distinguishes "we do not know" from "it has none"                                    |
| **left edge colour**                | row status — recommended, suspect             | marks a row without adding a column                                                  |
| **plain text**                      | everything else                               | most fields are confirmation, not comparison                                         |

## Collapse false choices

The commonest defect in a results table is **rows that are not actually
different options**. Four listings of one file behind four front doors read as
four choices and waste the reader's attention.

Detect and mark them — but **claim only what you can prove**. Matching content
hashes is _identical_; matching size and format within a tolerance is _same
spec_. Saying "same file" about two different byte counts is a lie the reader
will act on. Say the strongest true thing, not the strongest convenient thing.

## Excluded rows get one line, not rows

Anything filtered out before ranking belongs in a footnote with **counts and
reasons**, never as a dimmed row. A silent filter is indistinguishable from a
broken search, and a reader who cannot see "7 excluded, 2 for X" will assume the
tool missed them.

## Verify by looking

Render to PNG and open it. This is not optional polish; it is the only check
that catches the class of defect that matters:

- a column of `—` that reads as "no audio" when it means "the name did not say"
- a parser silently returning nothing, so every row says `no group`
- a colour that is correct in the DOM and invisible against its background
- a legend that wraps onto two lines and separates a swatch from its label

Every one of those passed syntax checks, unit tests and a string match first.
None survived thirty seconds of looking at the picture.
