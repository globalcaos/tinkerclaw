---
schema: "kit/1.0"
slug: "multilingual-gap-fill"
title: "Multilingual gap fill (when the English source is silent, ask the other languages)"
summary: "Fill holes in a dataset by re-asking the SAME question of non-English editions of the reference corpus. Gap-driven, availability-pre-filtered, provenance-tagged, and merged as an explicit step. Measured 32/35 fill rate on a real run where the English sources had nothing."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
subdivision: "research"
tags:
  [
    "no English source",
    "search in other languages",
    "multilingual research",
    "non-English sources",
    "fill gaps in a dataset",
    "missing data",
    "other language wikipedia",
    "nothing on record",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
    - [5]
    - [6]
params:
  dataset: { type: "string", description: "Path to the record set being filled (JSON/JSONL/CSV)." }
  gap_field:
    {
      type: "string",
      description: "The field that is EMPTY and needs filling (e.g. medicinal_uses).",
    }
  entity_key:
    {
      type: "string",
      description: "The field that names the thing to look up — must be language-independent if possible (a Latin binomial, an ISBN, an ID), not a local common name.",
    }
  corpus:
    {
      type: "string",
      default: "wikipedia",
      description: "Reference corpus with per-language editions.",
    }
  out_file:
    {
      type: "string",
      description: "Where the research lands BEFORE it is merged. Never write findings straight into the dataset.",
    }
---

# Multilingual gap fill

> A hole in the data is often not a hole in the world. It is a hole in the
> language you asked in.

## Goal

For every record whose `{{gap_field}}` is empty, re-ask the same question of the
non-English editions of `{{corpus}}`, keep what is found **with the language and
URL attached**, and merge it back as an explicit, verified step.

## When to Use

- A dataset has gaps and the authoritative English source genuinely has nothing.
- The subject is culturally or geographically concentrated — traditional
  medicine, regional cuisine, local law, folk practice, endemic species,
  vernacular engineering. The knowledge exists; it was written in another tongue.
- Someone is about to write "no data available" into a deliverable.

**Do NOT use** to pad a dataset that English already covers. This is gap-driven
by construction; blanket re-research is expensive and produces duplicates that
disagree with the primary source.

## Steps

### 0. Read the corpus's OWN edition in the query language before going abroad

The reference database being silent (PFAF, a pharmacopoeia, a catalogue) is not the
corpus being silent. Every earlier pass on the Pàmies book used en.wikipedia only for
langlinks and a native range, then went to Hindi and Guaraní for the text — and never
read the English article's own _Uses_ section. Measured 2026-09-03: **11 of 14** plants
with "no English monograph" had a usable medicinal paragraph in English Wikipedia, in
one API call each. Label it as what it is (an encyclopaedia entry, not a monograph) and
only then rank the other languages. Two genuinely had nothing in English (Sutherlandia
— whose article is Description/Cultivation only — and the Iberian endemic _Verbascum
giganteum_); those are the real gap set.

**Also re-read your own primary source before declaring it thin.** "79 plants have shop
text but no climate block" turned out to mean: the first crawler decoded four HTML
entities and dropped the rest, and it missed every label stored as `&iacute;`. A fresh
extraction of the same cached pages recovered accents on 83 fields and the full climate
block wherever the shop had one. **Count the blank templates**: 127 of 280 product pages
publish the labels with empty values — that is a source gap, not a scrape gap, and the two
must be reported as different numbers.

### 1. Define the gap set — and ONLY the gap set

Select records where `{{gap_field}}` is empty/null. Count them and state the
number before starting. If the gap set is the whole dataset, stop: the problem is
the pipeline, not the language.

### 2. Pre-filter on availability — the cheapest step, run it first

For each gap entity, ask the corpus **how many language editions exist at all**
before fetching any of them. Entities with zero editions are unanswerable; every
request spent on them is guaranteed waste, and including them in the denominator
later will understate a strategy that actually worked.

Record the count per entity. In the reference run, 4 of 39 had zero editions.

### 3. Rank languages by EXPECTED YIELD, not by size

The intuition "try the big European languages" is wrong and measurably so. Rank by:

- **Range** — languages spoken where the subject actually occurs or is used.
- **Living tradition** — languages with an active practice around the subject.
- **Corpus depth** — editions known to carry long articles in this domain.

In the reference run Arabic (18 hits) and Russian (16) beat German (9), and
Persian (9) tied it. Spanish and Catalan led only because the source material was
Catalan. **Let the data re-rank the list after the first 20 entities** — the top
languages for one domain are not the top for another.

**Origin-first (measured 2026-08-27, 21/33 on the thin tail).** When the entity
has a native range, that range chooses the language list — Hindi/Tamil/Sanskrit
for an Indian plant, Guaraní for a Paraguayan one, Quechua/Spanish for an Andean
one. A fixed 20-language European+CJK list physically cannot answer Tulsi-class
gaps. Rank by range first, then re-rank from the first batch.

**Prove the detector on a known positive before trusting any null.** A search
tool that returns "not found" cannot distinguish _absent from the world_,
_absent from my language list_, _absent from my regex_, and _I spelled the key
wrong_. Run one known-documented entity in the origin script (e.g. _Sida
cordifolia_ / Bala in Kannada) before treating a zero as evidence. The 2026-08-27
run scored a Kannada sentence meaning "medicinal plant" as empty because the
vocabulary had no Indic script.

**Resolve the lookup key before fetching.** A misspelled binomial fails _every_
language at once and degrades to the same "nothing on record" string. Census of
281 Pàmies names found 16 invalid binomials (_Humullus_ / _Humulus_, _officinale_
/ _officinalis_, _Glyzyrrhyza_ / _Glycyrrhiza_). Correct the key, then search.

**Query the GBIF accepted name as well as the sold name.** A synonym Wikipedia
has already redirected away from looks identical to "no article". Measured
2026-08-31 against the thin tail: _Sutherlandia frutescens_ is stored as GBIF
synonym of _Lessertia frutescens_, _Plectranthus barbatus_ of _Coleus barbatus_,
_Calea zacatechich_ of _Calea ternifolia_ — and the origin sweep still queried
the shop synonym. That is a missed key, not missing knowledge.

**A correction must preserve the TAXON, not just resolve to something.** An
automated "best match by article count" will happily propose the GENUS page or a
different species, and both silently change what the record is about — worse than
the typo, because it looks fixed. Of 16 corrections verified on 2026-08-30, two
were rejected on exactly this: _Micromeria biflora_ → _Clinopodium_ (a genus) and
_Verbascum giganteum_ → _V. thapsus_ (a different, valid species; _giganteum_ is an
Iberian endemic that genuinely has no article). Accept only a repaired spelling or
an accepted synonym of the same taxon; leave the rest unresolved and say so.

Keep BOTH names: the verified binomial for lookups and for print, and the original
as `*_as_sold` for traceability. Re-keying the dataset by the corrected name breaks
every downstream reference; add a field instead.
Outcome once corrected (2026-08-30): 14 of the 16 resolved to 11–104 language
editions each and 12 of those 14 then yielded a medicinal passage, taking the
book's origin-language panels from 26 to 43.

**Correcting a key is not always a spelling fix — classify before applying.** Of
the 16, eleven were true typos, three were valid _synonyms_ of an accepted name
(safe: same organism), and one — _Verbascum giganteum_ → _V. thapsus_ — was a
DIFFERENT SPECIES. Substituting it would have attributed another plant's medicine
to an Iberian endemic. Reject silently-plausible corrections that change identity;
leave the gap honest instead.

### 4. Fetch and extract, keeping provenance attached to every fragment

For each entity × language, capture the title, URL, article size, and the
extracted passage. Never merge a bare string: a fragment without its language and
link is unciteable and will be silently dropped by a later reviewer, or worse,
printed as if it were the primary source.

Write everything to `{{out_file}}`. Do not touch `{{dataset}}` in this step.

### 5. Classify what was found — evidence is not uniform

A national pharmacopoeia monograph, a horticultural society page, and a folk
remedy paragraph are three different kinds of claim. Tag each with what it is, so
the consuming surface can render it honestly. The rendering must name the
language: _"recorded in Russian and Arabic; those articles are the source, this
work has not independently verified them."_

### 6. MERGE — as its own step, then verify from the ARTIFACT

A completed research file is not a merged one. Run the merge explicitly, then
prove it landed by checking the **artifact a human sees** — the field present on
the records AND the string present in the rendered output — never the job log.

This is the step that gets skipped. In the reference run the research file was
complete and correct for a full day while the deliverable showed none of it,
because the merge was a separate script nobody ran.

### 7. Report the yield honestly, with the impossible cases excluded

Report three numbers:

- gap set size,
- filled,
- **unanswerable** (zero editions available).

The hit rate that means anything is `filled / (gap_set − unanswerable)`. Quoting
`filled / gap_set` punishes the strategy for entities no method could have
answered. Reference run: 39 gaps, 32 filled, 4 unanswerable → **32/35 = 91%**
(82% of the raw gap set), plus 8 entities that gained a second attribute nobody
had asked for.

### 8. Rank the DISPLAY too, not just the search

Merging is not the last decision — the consuming surface usually has room for only
a few rows, and a naive append leaves the novel findings below the fold. Sort the
retained fragments so the **origin-library** languages take the visible slots and
the European mirrors fill what is left.

Measured 2026-08-30: turmeric's panel first rendered French, Portuguese, Russian and
Bengali because three European rows were already present and the cap cut the rest.
The eleven Indian findings existed in the research file and none of the four visible
rows was the reason the search was run. Re-ranked, the same panel shows Bengali,
Hindi, Kannada and Malayalam. **A finding that is merged but not visible has not
been delivered.**

Also verify the surface can physically RENDER the script before claiming the row
works — a missing font prints empty boxes, which is worse than the gap it replaced.
Look at a rasterised page; do not infer it from the text layer.

## Constraints

- Gap-driven only — never re-research a populated field.
- Availability check precedes fetching, always.
- Every retained fragment carries `{lang, url, retrieved_at}`.
- Research output and dataset stay in separate files until step 6.
- The language ranking is revisited after the first batch, not fixed up front.

## Safety Notes

- **Attribution is not optional.** Presenting a translated folk claim as
  equivalent to a regulatory monograph is the main way this recipe does harm.
  Name the language and link the article at the point of use.
- **Machine translation is a lossy witness.** Quote and attribute; do not silently
  paraphrase a claim you cannot read in the original.
- **Safety-critical domains** (dosage, toxicity, legal, medical) — a non-English
  hit fills a _presentation_ gap, never a _verification_ gap. It must not upgrade
  into an authoritative statement.
- Respect the corpus' rate limits and licence; Wikipedia text is CC BY-SA and
  requires attribution anyway, which step 4 already gives you.

## Failures Overcome

- **"No data" meant "no English data".** The original run marked dozens of
  entities as having nothing on record. 32 of them were documented — in Spanish,
  Arabic, Catalan, French and Russian. The gap was in the query language.
- **The denominator lie.** Reporting 32/39 made a 91% strategy look like 82%.
  Four entities had no language editions at all; they belong in a separate
  bucket, not in the failure count.
- **Big-language bias.** A first pass weighted toward German/French would have
  missed the Arabic and Russian records, which together carried 34 hits.
- **The merge that never ran.** Research completed, file written, nobody merged
  it; the deliverable was unchanged for a day and the job log said "done". Answer
  "did it finish?" from the artifact, never the log.
- **Common names don't cross borders.** Look up a language-independent key (Latin
  binomial, ID, ISBN). Querying a local common name in a foreign edition returns
  the wrong entity or nothing.
- **The instrument was the bottleneck.** A 20-language list with no Indian language,
  plus a detector blind in Indic script, reported Ayurvedic plants as undocumented.
  Origin-first ranking + a known-positive probe on the detector recovered 21 of 33,
  including turmeric in 11 Indian languages and Bala in 4 from zero.
- **A wrong letter closes every edition.** 16 misspelled binomials in the catalogue
  were indistinguishable from "undocumented plant". Name-resolution is a precondition,
  not a consolation prize.
- **An accepted synonym sitting unused.** GBIF had already resolved three thin
  plants to names Wikipedia actually uses (_Lessertia frutescens_, _Coleus barbatus_,
  _Calea ternifolia_). The sweep queried the shop synonym and recorded "nothing
  on record". Check `taxonomy.accepted` before concluding the world is silent.

- **Step zero skipped for three weeks.** Three sweeps went abroad for 14 plants whose
  English Wikipedia article already carried the answer for 11 of them; PFAF's silence was
  read as English's silence. Read the corpus's own edition first, then rank languages.
- **The detector's vocabulary is the domain's, not the language's.** _Sideritis syriaca_
  is documented in seven editions as a tisane ("mountain tea") and scored zero on a
  detector that only knew "medicinal". For culinary-medicinal plants add the use words
  (tea, tisane, infusión, çay, чай) or the plant reads as undocumented.
- **A scrape gap was reported as a source gap.** The shop's climate block existed on 84
  in-book pages; the old extraction had it for fewer because the label was an entity.
  Re-extract before concluding the source is thin — and separate "blank on the source"
  (127 template-only pages) from "not captured".
- **Genus-level fallback, labelled.** _Verbascum giganteum_ has no article anywhere;
  the genus article states what the genus is used for. Printing it is honest only with
  the sentence "the article is about the genus, not this species" attached — the taxon
  rule from step 3 applied to the display, not just the key.
- **When several editions give a hardiness figure, the WARMEST is the planning figure.**
  A Garraf bed is not helped by the hardiest provenance on record; keep the spread and
  cite every edition, but plan on the least hardy claim.
- **A rate-limited probe reports "one edition" for a plant with fifteen.** Two sweeps
  hitting Wikipedia concurrently drew 429s; the API helper returned `None`, the langlink
  count fell to 1 (en only) and the plant was scored as unavailable. `editions<=1` for a
  species that had 15 an hour earlier is the probe failing, not the world. Never run two
  sweeps against one corpus at once, and treat a sudden drop in availability as a fault.
- **Take the Uses section by its heading, not by paragraph scoring.** With
  `exsectionformat=wiki` the extract keeps `== Uses ==` markers; a scorer over paragraphs
  picked a fruit-flavour paragraph for _Passiflora caerulea_ and a bibliography line for
  peyote. Section-by-name first, scorer only as fallback — and when the article has no
  Uses section at all (the _Verbascum_ genus page: Description/Cultivation only), say so
  rather than promote the taxonomy intro.
