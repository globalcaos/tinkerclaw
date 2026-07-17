---
schema: "kit/1.0"
slug: "competitor-pricing-watch"
title: "Competitor pricing watch (fetch, diff, classify, brief)"
summary: "Monitor a private list of competitor pricing pages on a cron: fetch each page (parallel, robots-respecting), extract structured pricing with LLM parsing, diff against the previous snapshot, separate noise from meaningful moves, and deliver a strategic brief. Read-only fetching; prices are quoted from the page, never fabricated."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
subdivision: "research"
tags:
  [
    "competitor pricing",
    "pricing watch",
    "did a competitor change pricing",
    "monitor pricing pages",
    "pricing changes",
    "competitive intelligence",
    "new pricing tier",
    "track competitor prices",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
    - [4]
params:
  competitors_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/marketing/competitors.json",
      description: "JSON list of competitor names + pricing-page URLs (operator-private values live here, not in the recipe).",
    }
  snapshots_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/marketing/pricing-snapshots",
      description: "Where dated snapshots are stored for diffing.",
    }
---

# Competitor pricing watch (fetch, diff, classify, brief)

> Distilled from the Journey kit
> [matt-clawd/competitive-pricing-monitor](https://journeykits.ai) (MIT).
> The kit ships a Python pipeline; this recipe keeps only the workflow — the
> agent uses its own fetch/read tools, no kit code is imported.

## Goal

Detect meaningful competitor pricing moves early. Each run: fetch every
pricing page listed in {{competitors_file}}, extract structured pricing
(tiers, prices, billing periods, feature gates), diff against the previous
snapshot in {{snapshots_dir}}, classify what changed (noise vs meaningful),
and produce a short strategic brief. Persist the new snapshots so the next
run has a baseline. Suitable as a cron job.

## When to Use

- "Did any competitor change their pricing?", "watch competitor pricing"
- A recurring (cron) competitive-intelligence sweep over known pricing pages
- Before a pricing review: "what moved in the market since last quarter?"

## Steps

### 1. Load config and baseline

**Done when:** The competitor list and each competitor's most recent snapshot
(if any) are in hand.

Read {{competitors_file}} — a JSON array of `{name, url, notes?}` entries.
The operator's real competitor names and URLs live ONLY in that file, never
in this recipe. For each entry, locate the latest dated snapshot in
`{{snapshots_dir}}/<competitor-slug>/`. A missing snapshot means first run:
establish a baseline, report no diff.

### 2. Fetch pricing pages (fan-out per competitor)

**Done when:** Rendered page content (text/markdown) exists for every
reachable competitor URL, and unreachable ones are recorded as fetch
failures — never silently skipped.

Fan out one fetch per competitor; fetches are independent and run in
parallel. Read-only GETs of publicly accessible pages only. Respect
robots.txt and rate limits; space repeated requests. Pricing pages are often
JavaScript-rendered — if a plain fetch returns an empty shell, use a
rendering fetch (e.g. the browser tool) before giving up. Never attempt to
bypass auth gates or anti-bot walls; a blocked page is reported as
"needs manual check".

### 3. Extract structured pricing (fan-out per competitor)

**Done when:** Each fetched page yields a JSON snapshot: plan/tier names,
prices (monthly + annual), billing periods, feature gates per tier, usage
limits, free-tier details, enterprise/custom indicators — plus an extraction
confidence note.

Extract from the rendered page content by reading it (LLM parsing), NOT with
CSS selectors — layout changes must not break the pipeline. Every price in
the snapshot is quoted from the page; if a value is ambiguous (calculators,
non-standard structures), record it as uncertain rather than guessing.

### 4. Diff and classify

**Done when:** For each competitor there is a change list, each change tagged
noise or meaningful, with the evidence (old value -> new value).

Compare the new extraction against the previous snapshot: price changes
(amount + percent), new or removed tiers, feature additions/removals, usage
limit changes. Classify: **meaningful** = price change, new tier, removed
tier/feature, limit change; **noise** = copy reshuffles, formatting,
extraction jitter. When unsure, mark it noise-with-a-flag rather than
alerting.

### 5. Brief, then persist

**Done when:** A strategic brief exists (what changed, significance
major/moderate/minor, implications, suggested response, extraction
confidence) and the new dated snapshots are written to
`{{snapshots_dir}}/<competitor-slug>/<date>.json` for the next run.

If nothing meaningful changed, say so in one line — don't pad. Fetch
failures and low-confidence extractions go in a "needs manual check"
section. Persist snapshots even on a no-change run.

## Constraints

- Read-only toward competitor sites: fetch and read, never interact, submit,
  or authenticate.
- No fabricated prices — every number in snapshot or brief is quoted from the
  fetched page (hard rule).
- Cron-suitable: idempotent per day, no interactive questions mid-run;
  missing {{competitors_file}} aborts with a clear message.
- Skeleton rule: real competitor names/URLs live in {{competitors_file}},
  never in this recipe.

## Safety Notes

- Only publicly accessible pricing pages; never gated or authenticated
  portals.
- Respect robots.txt and rate-limit requests; don't hammer competitor
  servers.
- Snapshots and briefs are internal competitive material — keep them under
  the operator's workspace, never share raw extractions externally.

## Failures Overcome

- JavaScript-rendered pricing pages returned empty HTML to simple fetches —
  fixed by rendering the page (headless browser) and waiting for pricing
  elements before extraction (carried from the source kit).
- CSS-selector extraction broke on every competitor redesign — fixed by
  LLM-based extraction over the rendered page content, resilient to layout
  changes (carried from the source kit).
- Anti-bot protections blocked repeated automated access — mitigated by
  modest request frequency, delays between requests, and caching successful
  extractions (carried from the source kit).
- v1.0 distilled 2026-06-13 from Journey kit
  matt-clawd/competitive-pricing-monitor.
