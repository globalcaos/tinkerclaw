---
schema: "kit/1.0"
slug: "marketing-page-audit"
title: "Audit a marketing page (CRO + SEO + copy, fan-out)"
summary: "Audit one URL through three independent expert lenses — CRO, SEO, copywriting — using the vendored marketingskills frameworks, then merge into one prioritized report (Quick Wins / High-Impact / Test Ideas). Read-only: it recommends, it never edits the live site."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
tags:
  [
    "page audit",
    "audit this page",
    "cro",
    "conversion",
    "this page isn't converting",
    "seo audit",
    "review my landing page",
    "improve conversions",
    "website feedback",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1, 2, 3]
    - [4]
params:
  page_url: { type: "string", required: true, description: "The URL of the page to audit." }
  conversion_goal:
    {
      type: "string",
      required: false,
      description: "Primary conversion action (signup, star, install, subscribe). Inferred from product-marketing.md if omitted.",
    }
---

# Audit a marketing page (CRO + SEO + copy, fan-out)

> Three independent expert lenses on one page, merged into a single prioritized
> report. Frameworks come from the vendored marketingskills repo
> (`~/.openclaw/workspace/vendor/marketingskills`, MIT, coreyhaines31).

## Goal

Produce one actionable, prioritized improvement report for {{page_url}} —
sections: Quick Wins, High-Impact Changes, Test Ideas, Copy Alternatives —
grounded in our positioning, not generic best practice.

## When to Use

- "Audit this page", "this page isn't converting", "review my landing page"
- Before/after publishing changes to thetinkerzone.com, sprintpaper.com, or a
  ClawHub listing page

## Steps

### 1. Load context

**Done when:** Product context and the page content are both in hand.

Read `~/.openclaw/workspace/.agents/product-marketing.md` (positioning, ICP,
voice, hard rules) — ask only for what it doesn't cover, per the shared-context
contract. Fetch {{page_url}} (rendered text + meta tags). Resolve
{{conversion_goal}} from context if not given.

### 2. CRO lens

**Done when:** A findings list ordered by the CRO framework exists.

Subagent (sonnet, medium): apply `skills/cro/SKILL.md` from the vendor repo —
value-prop clarity, headline, CTA hierarchy, trust signals, objections,
friction. Output findings with severity, no prose padding.

### 3. SEO lens

**Done when:** A findings list from the seo-audit framework exists.

Subagent (sonnet, medium): apply `skills/seo-audit/SKILL.md` — titles/meta,
heading structure, internal links, schema, indexability. Skip paid-tool steps;
use what's fetchable.

### 4. Copy lens

**Done when:** Concrete rewrite suggestions for the weakest copy exist.

Subagent (sonnet, medium): apply `skills/copywriting/SKILL.md` +
`skills/copy-editing/SKILL.md` — voice match against product-marketing.md,
2–3 headline/CTA alternatives with rationale.

### 5. Merge and prioritize

**Done when:** One report exists, duplicates merged, every item tagged
Quick Win / High-Impact / Test Idea, written to
`~/.openclaw/workspace/marketing/audits/<domain>-<date>.md`.

Merge the three findings lists. Where lenses disagree, say so explicitly.
Close with the top-3 actions Oscar should approve first.

## Constraints

- Read-only toward the live site: recommend, never edit or publish.
- Every claim grounded in the fetched page or product-marketing.md — no
  fabricated metrics (hard rule).
- Respect PII boundary: report contains nothing private.

## Safety Notes

- Subagents get read/fetch tools only; no send/publish/deploy tools.

## Failures Overcome

- (none yet — v1, authored 2026-06-12 from the marketingskills integration)
