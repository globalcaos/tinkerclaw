---
schema: "kit/1.0"
slug: "spec-resolution-ladder"
title: "Spec Resolution Ladder — find the number a comparison actually turns on"
summary: "Resolve a missing characteristic (protein %, concentration, capacity, sustained write, active fraction) for products being compared: climb from the label to independent databases to the manufacturer, fan out one subagent per brand only when it can change the ranking, and stamp every value with its provenance and base unit."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
subdivision: "decision support"
tags:
  [
    "concentration",
    "protein percentage",
    "active ingredient",
    "nutrition per 100g",
    "spec",
    "specification",
    "datasheet",
    "how much of it is actually",
    "purity",
    "missing spec",
    "unknown concentration",
    "resolve spec",
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
---

# Spec Resolution Ladder — find the number a comparison actually turns on

> Sub-procedure of `product-comparison-chart`. That recipe needs a per-unit metric; this one
> supplies the denominator when the vendor will not.

## Goal

Every candidate that can plausibly win carries the characteristic its ranking depends on, as a
number with a stated base unit, a named source and a date — or is honestly marked unresolved and
excluded from the ranking rather than silently defaulted.

## When to Use

- The comparable unit divides by a fraction — euros per kg of ACTIVE ingredient, per gram of
  protein, per usable GB — and that fraction is missing for one or more rows.
- A listing offers a marketing phrase where a number is needed: "low sugar", "zero added",
  "high protein", "up to 18 g per serving".
- Two contenders are close enough that the missing figure could flip them.

## Steps

### 1. Decide whether the number can change the answer

**Done when:** Each unresolved row is marked either RANKING-CRITICAL or ignorable, with a reason.

Resolution is the expensive part of a comparison, so spend it only where it pays. A candidate
already beaten on every axis by a wide margin does not need its figure refined — the winner does
not change whether it is 92% or 100%. Resolve when a contender sits within roughly fifteen percent
of the leader, when the row rests on an assumed default rather than an observation, or when the
requester's question IS the characteristic. Everything else can stay honestly blank.

### 2. Climb the ladder, cheapest rung first

**Tools:** exec, webfetch, websearch
**Done when:** Each critical value is resolved, or every rung has been tried for it.

Take the rungs in this order and stop at the first that yields a real number. **The label itself**
— many titles state the spec outright, and a stated percentage or grade beats any inference.
**The vendor's structured fields** — spec tables and bullets, though be aware that rich product
content is frequently images, so a page can be visually full of nutrition and textually empty.
**A local brand table** of previously confirmed values, which is why Step 5 exists. **Independent
structured databases keyed by an identifier** — barcode, EAN, part number, model — which are
usually the highest-yield rung and the most overlooked: they carry transcribed label panels while
the vendor page carries marketing. **The manufacturer's own site or datasheet**, accurate but
often bot-walled. Only then, **one subagent per distinct brand in parallel**, because brands are
independent and a web-capable agent beats a brittle in-process scrape.

### 3. Never bank a marketing claim as a measurement

**Done when:** Every stored value is either a number from a label/datasheet or explicitly tagged as a claim.

"Low sugar", "reduced", "zero added" and "up to N per serving" are positioning, not data, and a
table that renders them beside a transcribed panel launders advertising into evidence. Two
specific traps. **"Up to N per serving" is unusable until the serving is known** — derive it from
pack size divided by the stated servings count, then convert. And a **claim about ADDED sugar says
nothing about total sugar**, which for dairy-derived products is mostly what is there. When a
value stays a claim, keep it in the table but visually distinct, and never let it decide the pick.

### 4. Normalise the base before comparing anything

**Done when:** Every value in the column shares one base unit, verified by an arithmetic cross-check.

This is where comparisons silently invert. Per-serving and per-100 differ by roughly the scoop
size — a factor of three is enough to reorder a whole board — and mixing them produces a table
that looks consistent and ranks wrong. Convert everything to one base, then cross-check by an
independent route: total divided by pack size should reproduce the stated unit price; servings
times serving size should reproduce the pack weight. A figure that fails its cross-check is a
parse error, not a surprising product.

### 5. Record what was confirmed, with source and date

**Tools:** write
**Done when:** Each resolved value is persisted with its URL and date, and durable ones are cached.

A resolved spec is expensive and perfectly reusable, so write it where the next run will look —
the brand table the ladder reads at rung three. Stamp each value with the source and the date it
was read, because formulations get reformulated and a confidently stored number with no date is
the same trap as an undated negative finding. Where sources conflict, prefer the one closest to
the physical label, say which you took, and note the disagreement rather than averaging them.

## Constraints

- Resolve only what can change the ranking; a fan-out that refines an uncontested number is waste.
- One subagent per distinct brand, in parallel, and only after the cheaper rungs failed.
- A marketing phrase is never stored as a number.
- Every value carries a base unit, a source and a date.
- Never average conflicting sources — choose, and say why.
- Independent identifier-keyed databases usually beat the vendor page; try them before the manufacturer's site.
- An unresolved spec means the row is excluded from the ranking and shown as unknown — never quietly filled with a default.

## Safety Notes

- Specs affecting health, dosage or safety are quoted from the label, never inferred from a similar product in the same range.
- Read-only research. Do not create accounts or accept terms to reach a datasheet.

## Failures Overcome

- Eleven vendor product pages were scraped for a nutrition figure and yielded nothing, because the panels existed only inside image-based rich content. One identifier lookup against an independent food database returned exact transcribed panels immediately. The cheapest-looking rung was the vendor; the highest-yield rung was the database nobody tried first.
- "Up to 18 g of protein per serving" was nearly banked as a protein percentage. Derived properly — pack weight divided by the stated servings count — the serving was about 30 g, making the product roughly 59% protein, far from the 73% of its siblings and enough to change which was better value per gram of protein.
- A per-serving sugar figure and a per-100 g figure sat in the same column in the same answer. Both were correct; the comparison was not.
- A per-form default was used for a missing concentration and presented with the same confidence as measured values, so an assumption ranked as evidence.
