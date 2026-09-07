---
schema: "kit/1.0"
slug: "product-comparison-chart"
title: "Product Comparison Chart — rank by the comparable unit, show the picture"
summary: "Compare candidate products from any vendor in one chart: every row carries a photo that clicks to full size, a link, the absolute price, the normalized per-unit price it is ranked by, the characteristic being optimised, and verified availability. Sticker price never decides; the comparable unit does."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
subdivision: "decision support"
tags:
  [
    "compare products",
    "product comparison",
    "which one should i buy",
    "best value",
    "price per kg",
    "price per unit",
    "cheapest",
    "best deal",
    "shopping",
    "amazon",
    "comparison table",
    "comparison chart",
    "find me the best",
    "value for money",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
---

# Product Comparison Chart — rank by the comparable unit, show the picture

> Vendor-agnostic. This recipe owns the SHAPE of a comparison answer. It does not own how to
> fetch any particular site — that belongs to the source's own skill, which this recipe calls.

## Goal

End the turn with one chart the requester can act on at a glance: candidates sorted by a
normalized per-unit price, each row carrying a clickable photo, a working link, the absolute
price, the per-unit price, the characteristic being optimised, and confirmed availability —
followed by one named recommendation and its runners-up.

## When to Use

- The request compares purchasable options: "which should I buy", "best value", "cheapest",
  "find me a good X", or any follow-up narrowing an earlier product answer.
- The candidates differ on a dimension that makes sticker price misleading — pack size,
  concentration, capacity, active fraction.
- Any vendor. Amazon is the common case, not the requirement.

## Composition

This recipe is a middle layer and is meant to be called with others in the same turn.

- **Upstream (data in):** the source's own skill supplies rows — `amazon-shopper` for
  amazon.es, `obramat` for Obramat, `pamies-vitae` for Pàmies, a plain web fetch otherwise.
  Vendor DOM selectors, session handling, rate limits and stock markers live THERE, never here.
  The seam is the row contract in Step 3: any source that can fill those fields can drive this.
- **Downstream (pixels out):** image sourcing and click-through obey `visual-answer`'s rules —
  verify before use, link to full size in a new tab, never a scripted lightbox.
- **Inward (missing numbers):** when the per-unit metric of Step 1 divides by a fraction the
  vendor does not publish — protein %, concentration, usable capacity — call
  `spec-resolution-ladder` for the rows where that figure could change the ranking. It returns
  each value with a base unit, a source and a date, or an honest unresolved.
- **Sideways:** when the cheapest access path to a source appears blocked, run
  `source-access-ladder` before telling the requester you are stuck.

## Steps

### 1. Fix the comparable unit before gathering anything

**Done when:** One per-unit metric is written down, with its formula.

Decide what makes these products commensurable and state the formula: euros per kg, per litre,
per GB, per wash, per kg of the ACTIVE fraction. This choice is the whole recipe — everything
downstream is bookkeeping. Where products differ in purity, protein percentage, concentration or
usable capacity, the honest metric divides by that fraction, because sticker price and even
price-per-kg rank such a field wrong: a 90%-pure product at a higher price per kilo is frequently
cheaper per kilo of the thing actually being bought. Ask at most one or two load-bearing questions
if the axis is genuinely ambiguous; do not interrogate the requester about preferences that cannot
change the ranking.

### 2. Sweep several phrasings, not one keyword

**Tools:** the source's own skill
**Done when:** Candidates are gathered from multiple query phrasings and deduplicated by identity.

One phrasing under-samples the catalogue badly — synonyms, the local-language name, the brand's
own product-line name and the size written both ways each surface different items. Sweep them and
dedupe on the vendor's stable id. Delegate the actual fetching to the source's skill; if you find
yourself writing selectors here, you are editing the wrong file.

### 3. Fill EVERY row completely — the winner is not special

**Done when:** No cell in the table is silently blank, and every product named in prose has a link.

Each row carries: a **link** to the product page; a **photo** with a full-size target; the
**absolute price**; the **per-unit price** from Step 1; the **characteristic** being optimised;
and **availability**. Runners-up need this most — they are the rows the requester goes on to
compare. Naming a product without a link hands back the search work that was delegated in the
first place; a spec table without a cost column cannot answer a value question at all. Where a
figure is genuinely unavailable, print the gap and say so per row rather than dropping the column.

### 4. Gate on availability BEFORE ranking

**Tools:** the source's own skill
**Done when:** Every unbuyable candidate is dropped or struck through, and none can win.

An unavailable product cannot be the recommendation however well it scores, and discovering this
after acting on the answer is worse than a weaker pick. Two traps, both observed. **A price on the
page does not mean it is buyable** — dead listings routinely still render a price sourced from
third-party or used offers, so confirm against the vendor's actual availability marker and the
presence of a real buy control. And **a live page that returns a correct title proves only that
the listing exists**; house brands are the highest-risk rows here, because they win on price and
are the most often discontinued with the page left standing.

### 5. Rank by the comparable unit, and separate measured from claimed

**Done when:** Rows are sorted by the Step 1 metric and every figure is attributed.

Sort by the per-unit metric, never by sticker price. Mark which numbers were measured from a
primary source and which are a manufacturer's marketing claim — "low sugar", "zero added", "up to
18 g" are claims, and a table that renders them in the same weight as a verified nutrition panel
launders advertising into data. Treat any per-unit value roughly ten times better than its peers
as a parse bug until proven otherwise: it is usually an accessory that merely _supports_ the spec,
a per-serving figure read as per-100, or a unit price captured as a total.

### 6. Render the chart, then recommend one

**Done when:** One script-free html-render block exists, sorted, with clickable photos, followed by a named pick.

Emit a single html-render block: photo column first, thumbnail wrapped in a link to the full-size
image opening in a new tab, rows in metric order, the winning row visually distinguished, dead
candidates struck through and dimmed rather than deleted — the requester learns as much from what
was rejected. Keep the block script-free so it renders inline and does not flicker on streaming
deltas. Then, in prose, name ONE recommendation and quantify it against the requester's current
option or stated constraint, add the one or two honest runners-up with the trade-off each carries,
and state anything the chart could not verify.

## Constraints

- Every option gets a link, a photo, a price, a per-unit price and an availability verdict. Every option, not the winner.
- Sort by the comparable unit. Sticker price is a column, never the ranking.
- An unavailable product is never the recommendation.
- A price is necessary but not sufficient evidence of availability.
- Distinguish measured figures from manufacturer claims, visibly.
- A per-unit outlier is a parse bug until proven otherwise.
- Photos link to full size in a new tab; no scripted lightbox — a height-clamped chat frame crops the very view it promises.
- Keep vendor mechanics OUT of this recipe. Selectors, sessions and rate limits belong to the source's skill.
- Keep case facts out. Specific products, prices and brands belong in the answer, not in the recipe.

## Safety Notes

- Quote prices from the page with the date and time observed; a price is a perishable fact and a stale one is a real cost to the requester.
- Never fabricate a figure to complete a column. An empty cell marked unknown is honest; an invented one is not.
- Read-only. This recipe compares and recommends; it never adds to a cart, checks out, or spends.

## Failures Overcome

- A recommendation was made on a house-brand listing that fetched cleanly and returned a correct title. It was unavailable, and the requester discovered that himself. Availability moved from a footnote to a gate that runs before ranking.
- The same answer named five runner-up products with no links and no cost column at all, so the pick could not be bought and the alternatives could not be judged. Hence: every row, every field.
- Scoping price extraction to the vendor's price block returned the per-kg figure as if it were the total — a wrong number that looked entirely plausible, off by the pack size. Cross-check that total divided by size matches the stated unit price.
- A generic out-of-stock string matched inline scripting on every page and marked eleven live candidates dead in one sweep. A probe returning the same verdict for every input is broken; scan the result column before trusting it.
- An adapter that merely _supported_ 256 GB scored best on euros per GB and topped a storage board. The outlier was the tell.
