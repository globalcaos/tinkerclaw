---
schema: "kit/1.0"
slug: "marketing-anchor-post"
title: "Publish an authority anchor post"
summary: "Turn verified third-party credibility into an evergreen authority cornerstone on your owned site — 'what the ecosystem says about {{product}}' — that funnels readers to subscribe + star. A reusable template; fill the variables for any product."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "writing"
tags:
  [
    "marketing",
    "authority",
    "anchor post",
    "reputation",
    "ecosystem perception",
    "what people say about us",
    "credibility",
    "social proof",
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
  product:
    { type: "string", required: true, description: "The product/project/brand being marketed." }
  owned_site:
    { type: "string", required: true, description: "The owned website that all links funnel to." }
  repo_url:
    {
      type: "string",
      required: true,
      description: "The canonical public repository or product URL.",
    }
  positioning_line:
    {
      type: "string",
      required: true,
      description: "The single canonical one-line positioning, used identically everywhere.",
    }
  receipts_source:
    {
      type: "string",
      description: "Where the verified third-party endorsements / credibility evidence are recorded.",
    }
  humanizer_tool: { type: "string", description: "Tool/skill that de-AIs and humanizes copy." }
  publish_tool:
    { type: "string", description: "Tool/skill that publishes to the owned site, draft-first." }
  community_channel:
    {
      type: "string",
      description: "The owned community channel (e.g. Discord/Discussions) for capture + engagement.",
    }
---

# Publish an authority anchor post

> Turn verified third-party credibility into an evergreen authority cornerstone on your owned site — 'what the ecosystem says about {{product}}' — that funnels readers to subscribe + star. A reusable template; fill the variables for any product.

## Goal

Lead with the credibility you already have (peer endorsements, references, proof) so it earns broad attention, then capture that attention as an owned, engaged audience. North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- Standing up a campaign's credibility cornerstone for {{product}}
- When fresh third-party endorsements/citations accumulate and the receipts should be refreshed

## Steps

### 1. Gather the receipts (sourced, never fabricated)

**Done when:** A sourced list of quotable third-party signals + working links is assembled from {{receipts_source}}.

Collect the VERIFIED external signals about {{product}}: peer endorsements, citations, independent references, third-party listings — from {{receipts_source}}. Every quote must be real and linkable. No invented praise; if it isn't sourced, it doesn't go in.

### 2. Draft the narrative arc

**Done when:** A draft post with hook -> receipts -> what-it-means -> CTA exists.

Lead with credibility, not hype. Arc: a hook (what serious people independently said about {{product}}), the receipts (quotes + links), the honest read of where you stand, and what it means for the reader. Candor about your real position is part of the credibility.

### 3. Apply the brand voice

**Tools:** {{humanizer_tool}}
**Done when:** The humanizer pass is clean and the copy is voice-compliant.

Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords. It should read like a builder showing receipts, not a marketer.

### 4. Add the funnel + capture

**Done when:** An email-capture CTA, a star/follow CTA, and {{positioning_line}} are all present.

Close with an owned-audience capture (a 'get updates' email CTA + an invite to {{community_channel}}) and a hard star-the-repo CTA to {{repo_url}}. Use {{positioning_line}} verbatim. Every outbound link is the funnel link to {{owned_site}}, UTM-tagged for attribution.

### 5. Publish to the owned site (draft-first)

**Tools:** {{publish_tool}}
**Done when:** The post is drafted/live on {{owned_site}} with rel-canonical, ready for human review.

Publish to {{owned_site}} via {{publish_tool}} (draft-only — a human reviews before live). This is the canonical home; later cross-posts point rel-canonical here. Never auto-publish.

## Constraints

- Every quote/endorsement is real and linked — never fabricate praise.
- Lead with authority, not hype.
- Funnel destination is {{owned_site}}.
- Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords.
- North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## Safety Notes

- Draft-only publish — a human reviews before live.
- Respect the project's PII/privacy boundary; no private data, host paths, or contacts.

## Failures Overcome

- Self-counted, unverified metrics read as fiction — this recipe forces every claim to be sourced + linked.
