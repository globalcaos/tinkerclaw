---
schema: "kit/1.0"
slug: "content-repurpose"
title: "Repurpose a post into platform-native social drafts (X thread + LinkedIn)"
summary: "Extract 8-15 standalone insights from one source post, then rewrite them platform-natively: X/Twitter threads (hook, numbered body, CTA, hard 280-char limit per tweet) and LinkedIn posts (~1300-char target, scannable line breaks, varied formats). Drafts only - a human review gate stands between output and any publishing; this recipe never auto-posts."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
tags:
  [
    "repurpose",
    "content repurposing",
    "turn this post into a thread",
    "x thread",
    "twitter thread",
    "linkedin post",
    "social media drafts",
    "cross-post this",
    "content marketing",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
params:
  source_path:
    {
      type: "string",
      required: true,
      description: "Path or URL of the source content to repurpose.",
    }
  platforms:
    { type: "string", default: "x-thread,linkedin", description: "Comma-separated target formats." }
  context_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/.agents/product-marketing.md",
      description: "Brand/voice context contract read before writing.",
    }
  output_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/marketing/repurposed",
      description: "Where drafts are written.",
    }
---

# Repurpose a post into platform-native social drafts (X thread + LinkedIn)

> Distilled from Journey kit
> [matt-clawd/content-repurposer](https://journeykits.ai) (MIT). The kit ships
> TypeScript modules; this recipe instructs the agent to perform the same
> transformations with its own tools — no kit code is imported or executed.

## Goal

Turn one long-form source post ({{source_path}}) into a suite of
ready-to-review social drafts in {{output_dir}}: extract the insights that can
stand alone, then rewrite each for the conventions of every target in
{{platforms}} — never a copy-paste of the source, always platform-native.
Output ends at drafts for human review.

## When to Use

- "Turn this post into a thread", "repurpose this for LinkedIn/X",
  "make social content from this article"
- Batch-producing social drafts from a backlog of existing posts
- Keeping one message consistent across platforms while respecting each
  platform's native format and audience norms

## Steps

### 1. Load context and source

**Done when:** Brand voice rules and the full source text are both in hand,
and {{platforms}} is resolved into a target list.

Read {{context_file}} (positioning, voice, vocabulary, emoji/hashtag
discipline, hard rules) — ask only for what it doesn't cover, per the
shared-context contract. Read or fetch {{source_path}} (markdown or rendered
text; capture title/url/author from frontmatter or H1 if present). Split
{{platforms}} on commas; only run the platform steps that are requested.

### 2. Extract standalone insights

**Done when:** 8–15 insights exist, each classified and able to stand alone
without the source.

From the source, extract 8–15 insights — each one a self-contained idea a
reader can get value from without clicking through. Classify each (statistic,
contrarian take, how-to, story, quotable line) and keep a pointer to where in
the source it came from. No invented numbers or claims: every insight must be
traceable to the source text. If structuring intermediates as JSON, strip any
markdown code fences before parsing (known failure mode).

### 3. X/Twitter threads (skip unless "x-thread" in {{platforms}})

**Done when:** 3–5 thread drafts exist, every tweet verified at or under 280
characters.

Subagent (sonnet, medium): build 3–5 threads from the insights. Conventions
(carried from the kit): each thread = one hook tweet (curiosity gap, no
numbering, no hashtags), numbered body tweets ("2/", "3/" …, one idea each),
and a closing CTA tweet (link back to the source, follow prompt, or
question). Hard limit: 280 characters per tweet INCLUDING thread numbering
and hashtags — count every tweet after drafting and rewrite or truncate any
that overflow (the kit needed a post-generation safety net; do the same by
hand). Hashtags sparing: 0–2 per thread, only in the CTA tweet. Voice per
{{context_file}}.

### 4. LinkedIn posts (skip unless "linkedin" in {{platforms}})

**Done when:** Up to 5 post drafts exist, scannable, each with hook, hashtags,
and character count near target.

Subagent (sonnet, medium): write up to 5 posts from the insights. Conventions
(carried from the kit): target ~1300 characters (hard max 3000); hook in the
first two lines (that's all that shows before "see more"); short paragraphs
separated by blank lines — never wall-of-text (known engagement killer); vary
the format across posts (narrative, listicle, contrarian, question-led); 3–5
hashtags at the end; close with an engagement-driving CTA, usually a
question. Professional storytelling tone, voice per {{context_file}}.

### 5. Human review gate — write drafts, never post

**Done when:** Every draft is on disk under {{output_dir}} and presented to
the operator for review; nothing has been published anywhere.

Write each draft to `{{output_dir}}/<source-slug>-<date>/<platform>-NN.md`
with a header noting the source ({{source_path}}), the insights used, and
per-piece character counts. Summarize the set for the operator and hand off.
HARD CONSTRAINT: this recipe NEVER posts, schedules, or queues content to any
platform — publishing is a separate, human-initiated act after review. The
LLM may overstate or misrepresent the source; the review gate exists to catch
exactly that.

## Constraints

- Drafts only: no posting, scheduling, or queueing tools may be used; the
  workflow terminates at files in {{output_dir}} (hard rule).
- Every claim in every draft traceable to the source — no fabricated
  statistics, no overstated claims.
- 280 characters per tweet is a hard limit; 3000 characters per LinkedIn post
  is a hard limit. Verify counts before accepting a draft.
- Source must be readable text/markdown (or a fetchable URL rendering to
  text); binary formats are out of scope.
- Don't repurpose confidential or PII-bearing source material.

## Safety Notes

- Subagents get read/fetch + local-draft-write tools only; no send, post, or
  publish tools.
- Human review before any publishing is the load-bearing safety property of
  this recipe — generated content can misrepresent the source or overstate
  claims, and the gate is where that's caught.

## Failures Overcome

- (kit) Tweet length overflow — hashtags + thread numbering pushed tweets past
  280 chars. Fix: explicit limit in the writing instructions AND a
  post-generation re-count that truncates/rewrites offenders.
- (kit) Dense LinkedIn wall-of-text performed poorly. Fix: explicit line-break
  instructions + varied post formats (narrative, listicle, contrarian,
  question-led).
- (kit) JSON intermediates arrived wrapped in markdown code fences, breaking
  parsing. Fix: strip fences before any JSON.parse-equivalent step.
- v1.0 distilled 2026-06-13 from Journey kit matt-clawd/content-repurposer.
