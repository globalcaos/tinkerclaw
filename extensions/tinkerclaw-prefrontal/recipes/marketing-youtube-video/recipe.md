---
schema: "kit/1.0"
slug: "marketing-youtube-video"
title: "Make a video for a product paper or feature"
summary: "Produce a clear, watchable video that explains one paper/feature, makes the work legible (especially anything visual), and funnels viewers to {{owned_site}} — planting {{product}} on video's discovery surface. Reusable template."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
tags:
  [
    "marketing",
    "youtube",
    "video",
    "demo",
    "explainer",
    "paper video",
    "feature video",
    "tutorial",
    "make a video",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
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
  tts_tool: { type: "string", description: "Tool/skill for video narration." }
---

# Make a video for a product paper or feature

> Produce a clear, watchable video that explains one paper/feature, makes the work legible (especially anything visual), and funnels viewers to {{owned_site}} — planting {{product}} on video's discovery surface. Reusable template.

## Goal

Teach what one paper/feature of {{product}} does so well that understanding drives adoption — and plant it on video's discovery surface. North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- A paper or feature is ready to be explained on video
- Backfilling existing papers/features with videos
- As the video asset inside a coordinated launch

## Steps

### 1. Pick the angle + write the script

**Done when:** A tight script (hook -> demo -> takeaway -> CTA) exists.

One paper/feature per video. Script: a hook (the problem), a live demo (show, don't tell), the takeaway (why it matters), and a CTA to {{owned_site}} + {{repo_url}}. Teach first — understanding is the goal, adoption the side effect.

### 2. Capture the demo

**Done when:** Demo footage/screen-capture of the feature in action is captured and sanitized.

Screen-record the feature — especially anything visual, which is the payoff. Sanitize: no private data, host paths, contacts, tokens, or PII on screen.

### 3. Narrate, edit, package

**Tools:** {{tts_tool}}
**Done when:** The video is assembled with title, thumbnail, chaptered description carrying the funnel link, and a pinned comment.

Add narration ({{tts_tool}} keeps it on-brand), edit to a tight runtime, and package: a searchable title, a clear thumbnail, a description with chapters + the UTM-tagged funnel link to {{owned_site}}, and a pinned comment with {{repo_url}}.

### 4. Publish + cross-link

**Done when:** The video is live and linked from the owned-site post, the listing, and the launch.

Upload, then cross-link from the canonical {{owned_site}} post, the listing, and any coordinated launch. The video and the post reinforce each other.

## Constraints

- Lead with understanding (teach, don't sell).
- Funnel to {{owned_site}}.
- Brand voice: keep your product's authentic edge, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip scanners and undercut trust; frame capability as the user's OWN. No buzzwords.
- Sanitize all on-screen content — no PII, paths, tokens, or private data.

## Safety Notes

- Scrub demos for private data / host paths / credentials before publishing.
- Outward-facing publish is human-gated.
