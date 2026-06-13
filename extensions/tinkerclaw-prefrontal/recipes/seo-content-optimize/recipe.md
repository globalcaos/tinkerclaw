---
schema: "kit/1.0"
slug: "seo-content-optimize"
title: "Optimize content for SEO (audit → rewrite → schema, voice-guarded)"
summary: "Audit an existing piece of content for SEO gaps (keyword coverage, heading structure, meta tags, internal links, readability), rewrite it for higher rankings without drifting from the brand voice, generate validated JSON-LD schema markup, and close with a before/after report. All output is a draft — it never publishes."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
tags:
  [
    "seo",
    "optimize this post",
    "seo rewrite",
    "content optimization",
    "rank higher",
    "improve rankings",
    "schema markup",
    "meta description",
    "ai citation",
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
params:
  content_path:
    { type: "string", required: true, description: "Path or URL of the content to optimize." }
  target_keywords:
    {
      type: "string",
      required: false,
      description: "Comma-separated target keywords; inferred from the content if omitted.",
    }
  context_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/.agents/product-marketing.md",
      description: "Voice/positioning contract — rewrites must not drift from it.",
    }
  frameworks_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/vendor/marketingskills/skills",
      description: "Optional vendored marketing frameworks directory.",
    }
---

# Optimize content for SEO (audit → rewrite → schema, voice-guarded)

> Distilled from Journey kit
> [matt-clawd/seo-content-optimizer](https://journeykits.ai) (MIT). The kit
> ships a TypeScript pipeline; this recipe distills the WORKFLOW only — no
> code imported.

## Goal

Take one existing article, blog post, or landing page at {{content_path}} and
produce: (1) an SEO gap audit, (2) a rewritten draft optimized for rankings
that stays true to the voice in {{context_file}}, (3) validated JSON-LD
structured data, and (4) a before/after report. Optimization prioritizes
information gain — unique insights competitors lack — over keyword density,
which is also what AI citation systems (Perplexity, AI Overviews) reward.

## When to Use

- "Optimize this post for SEO", "why doesn't this page rank", "seo rewrite"
- Existing content underperforms in search despite targeting the right topic
- You want schema markup / rich-snippet readiness for a published page

## Steps

### 1. Load context

**Done when:** The content, the voice contract, and the keyword targets are
all in hand.

Read {{context_file}} (positioning, ICP, voice, hard rules) first. Fetch or
read {{content_path}} and parse to clean text (Markdown/HTML/plain). Resolve
keywords: use {{target_keywords}} if given, otherwise infer 3–5 primary
keywords from the content's topic and intent — more dilutes focus.

### 2. SEO gap audit

**Done when:** A findings list with severity per gap exists.

Audit the content against: keyword coverage (title, headings, body, meta
description, URL slug), heading hierarchy (H1–H4) and scannability, meta
title/description quality, internal-link opportunities, readability
(target ~grade 8 unless the audience is technical; flag long-sentence
clusters), information gain (unique data/angles vs. what generic coverage of
the topic offers), and AI-citation readiness (clear entity definitions,
extractable facts). Routing note: the agent SHOULD also read the vendored
frameworks at `{{frameworks_dir}}/seo-audit/SKILL.md` and
`{{frameworks_dir}}/copy-editing/SKILL.md` when present — this recipe
orchestrates, the frameworks inform the checklists.

### 3. Rewrite without voice drift

**Done when:** A full optimized draft exists that a reader of {{context_file}}
would recognize as on-brand.

Rewrite title + meta description for click-through, restructure headings for
keyword coverage, add information-gain sections (real insights only — never
fabricate data, statistics, or quotes), improve readability toward the target
grade, add an FAQ section where natural, and state key claims as extractable,
citable facts. Brand-voice guard: before finalizing, diff the draft's tone,
phrasing, and person against {{context_file}} and revert any drifted passage.

### 4. Generate schema markup

**Done when:** JSON-LD that parses and matches schema.org vocabulary exists.

Generate Article schema (author, datePublished, description), FAQ schema from
the FAQ section, and HowTo schema only if the content is genuinely procedural.
Validate the JSON-LD (it must parse, and types/properties must exist in
schema.org vocabulary) before including it — invalid markup causes Search
Console errors; misrepresenting page content with FAQ/HowTo schema violates
search-engine guidelines.

### 5. Before/after report

**Done when:** One report exists with the draft, the schema block, and a
before/after comparison: keyword coverage, heading structure, readability
score, information-gain additions, and suggested internal links. Close with
the top-3 changes the operator should approve first.

## Constraints

- Edits are DRAFTS; never publish, deploy, or edit the live page directly —
  the operator reviews and ships.
- No fabricated data, statistics, or expert quotes; information gain comes
  from real insights only.
- Schema markup must accurately represent the page content.
- Optimization is guidance, not a ranking guarantee; content under ~500 words
  rarely benefits.

## Safety Notes

- Read/fetch tools only toward the live site; no send/publish/deploy tools.
- Review the rewritten draft for factual accuracy — rewrites can introduce
  subtle errors.

## Failures Overcome

- Keyword-dense rewrites ranked initially but dropped within weeks. Fixed by
  prioritizing information gain — unique insights and data that competitors
  do not cover.
- Generated JSON-LD schema was invalid and caused Search Console errors.
  Fixed with a validation step against schema.org vocabulary.
- Optimized content did not match brand voice. Fixed with a calibration step
  using on-brand content as style references (here: {{context_file}}).
- v1.0 distilled 2026-06-13 from Journey kit matt-clawd/seo-content-optimizer.
