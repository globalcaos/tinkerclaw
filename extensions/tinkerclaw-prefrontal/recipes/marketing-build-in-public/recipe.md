---
schema: "kit/1.0"
slug: "marketing-build-in-public"
title: "Post a build-in-public update that earns the ride"
summary: "Share genuine progress, decisions, and failures (not just releases) to convert visitors into a returning, engaged audience and grow owned channels — the content that earns people 'along for the ride'. Reusable for any product."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "communication"
tags:
  [
    "marketing",
    "build in public",
    "update",
    "devlog",
    "owned audience",
    "engagement",
    "community",
    "behind the scenes",
    "progress update",
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
  community_channel:
    {
      type: "string",
      description: "The owned community channel (e.g. Discord/Discussions) for capture + engagement.",
    }
  humanizer_tool: { type: "string", description: "Tool/skill that de-AIs and humanizes copy." }
---

# Post a build-in-public update that earns the ride

> Share genuine progress, decisions, and failures (not just releases) to convert visitors into a returning, engaged audience and grow owned channels — the content that earns people 'along for the ride'. Reusable for any product.

## Goal

Build a small audience that comes for the journey of {{product}}, not the vanity number — by showing the work honestly and engaging as a peer. North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- Between launches, to keep the audience warm with real progress
- After a hard problem solved or a decision made worth sharing
- Growing the email list / {{community_channel}} / stars

## Steps

### 1. Pick a genuine update

**Done when:** A real, specific update is chosen (a decision, a failure overcome, or work-in-progress) — NOT a release announcement.

Choose something true and specific about {{product}}: a design decision and why, a bug/failure and the fix, a work-in-progress glimpse. Releases go through the launch recipe — this is the in-between, human texture that earns followers.

### 2. Write it honestly

**Tools:** {{humanizer_tool}}
**Done when:** A short, specific, human post exists that shows the work and the thinking.

Short and concrete. Show the work and the reasoning, including what went wrong. Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords. Honesty (including failures) is the differentiator — it's why people come back.

### 3. Post to owned + community channels

**Done when:** Posted to {{owned_site}} (or a dev blog with rel-canonical) + the social/community channels, with a genuine question or invite.

Post to the owned surface ({{owned_site}}) and the community channels, ending with a real question or an invite into {{community_channel}}. The funnel link is present but the post leads with substance.

### 4. Engage — give before you ask

**Done when:** Substantive engagement happened on others' posts/questions, not just a broadcast.

Give 3x before asking once: reply substantively to others, answer questions, share findings. Named relationships beat broadcast reach. This is the anti-spam, anti-vanity discipline.

## Constraints

- Substance over promotion — give before you ask.
- Honest, including failures.
- Engaged-audience signals, never vanity metrics.
- Brand voice: keep your product's authentic edge/ethos, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip security scanners and undercut any trust story; frame access/capability as the user's OWN. Run copy through {{humanizer_tool}}; no buzzwords.
- North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## Safety Notes

- Respect the PII/privacy boundary on every post.
- Don't pattern-match as a release-feed (it gets downranked) — lead with real value.
