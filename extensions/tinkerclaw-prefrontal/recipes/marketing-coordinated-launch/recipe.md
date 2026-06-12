---
schema: "kit/1.0"
slug: "marketing-coordinated-launch"
title: "Coordinated multi-platform launch (event-driven)"
summary: "When a feature/release is robust enough, fire ONE synchronized drop across {{platforms}}, leading with the differentiator, all funneling to {{owned_site}}. Event-driven, never calendar-driven. Reusable for any product."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
tags:
  [
    "marketing",
    "launch",
    "release",
    "cross-post",
    "multi-platform",
    "parallel posting",
    "announce",
    "ship a feature",
    "publish",
    "coordinated launch",
    "distribution",
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
  platforms:
    {
      type: "string",
      required: true,
      description: "Comma-separated platforms to launch/cross-post on.",
    }
  publish_tool:
    { type: "string", description: "Tool/skill that publishes to the owned site, draft-first." }
  humanizer_tool: { type: "string", description: "Tool/skill that de-AIs and humanizes copy." }
---

# Coordinated multi-platform launch (event-driven)

> When a feature/release is robust enough, fire ONE synchronized drop across {{platforms}}, leading with the differentiator, all funneling to {{owned_site}}. Event-driven, never calendar-driven. Reusable for any product.

## Goal

Make every release land everywhere at once, in one voice, funneling to {{owned_site}} — but ONLY when the thing is genuinely robust. North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- A feature/release/paper for {{product}} is robust + documented and ready to announce
- NOT on a calendar — triggered by readiness, never by a schedule

## Steps

### 1. Readiness gate — ship only when robust

**Done when:** The readiness checklist passes; if not, STOP and do not launch.

Confirm the artifact is actually robust: it works, it's documented, its listing/README is mature, and (for code) it's been tested/running. If it is NOT robust, STOP — ship when ready, never to hit a date. This gate is the point: no calendar-driven launches.

### 2. Write the canonical post on the owned site

**Tools:** {{publish_tool}}
**Done when:** The core post is drafted on {{owned_site}} with the funnel + capture, leading with the differentiator.

Write the home post first — the canonical URL everything else points to — on {{owned_site}}. Lead with the differentiator/proof, show the concrete win, add the email-capture + star CTA to {{repo_url}}, and {{positioning_line}}. Draft-only.

### 3. Produce the per-platform assets in one voice

**Tools:** {{humanizer_tool}}
**Done when:** An adapted asset for each of {{platforms}} is drafted in one consistent voice with the funnel link.

Adapt the post per platform in {{platforms}} (don't copy-paste): a marketplace/listing entry, community threads, a Show-style post for link-aggregators, a social thread, a short video plan. Same voice, same canonical funnel link to {{owned_site}}, each tailored to its audience. Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords.

### 4. Sequence + publish

**Done when:** All artifacts are live (or drafted for review), with cross-posts pointing rel-canonical to the owned-site post.

Publish in order: the canonical post first, then cross-posts that reference it. Respect each community's norms (give before asking; one show-post per artifact on a mature page). Outward-facing publishing is human-gated.

### 5. Instrument + record

**Done when:** Every funnel link is UTM/source-tagged and the launch is recorded for attribution.

UTM-tag every link by source so attribution is real; record the launch + any new inbound links to your tracking store. Track engaged-audience signals, not raw pageviews.

## Constraints

- EVENT-DRIVEN: launch only when robust, never on a fixed cadence.
- One voice across all platforms; every link funnels to {{owned_site}}.
- Honest, engaged-audience metrics — not vanity counts.
- Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords.
- North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## Safety Notes

- High-stakes / account-risk reveals use marketing-flagship-launch (extra safeguards) — NOT this recipe.
- Outward-facing posts are human-gated; on communities, give before you ask.
