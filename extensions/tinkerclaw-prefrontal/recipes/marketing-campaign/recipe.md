---
schema: "kit/1.0"
slug: "marketing-campaign"
title: "Run the whole marketing campaign (Along for the ride)"
summary: "The orchestrator: run the whole 'Along for the ride' campaign by composing the standalone strategy recipes — each is also runnable on its own. Authority -> reach -> engaged audience, all funneling to {{owned_site}}. Reusable for any product."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "marketing",
    "campaign",
    "run the campaign",
    "marketing campaign",
    "along for the ride",
    "do all the marketing",
    "orchestrate marketing",
    "reputation campaign",
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
---

# Run the whole marketing campaign (Along for the ride)

> The orchestrator: run the whole 'Along for the ride' campaign by composing the standalone strategy recipes — each is also runnable on its own. Authority -> reach -> engaged audience, all funneling to {{owned_site}}. Reusable for any product.

## Goal

Convert {{product}}'s verified credibility into a small, genuinely-engaged audience that funnels to {{owned_site}}. Runs each marketing strategy in turn; each sub-recipe self-gates (e.g. launches fire only when something is robust). North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- Acting on the whole campaign at once
- As the index of all marketing strategies (each step points to a standalone recipe)

## Steps

### 1. Establish the authority cornerstone

**Done when:** The anchor post is drafted on the owned site.

uses: globalcaos/marketing-anchor-post

Stand up the 'what the ecosystem says about {{product}}' authority post — the credibility cornerstone the whole funnel points back to.

### 2. Launch whatever is robust

**Done when:** Any robust feature/paper is launched everywhere (or the readiness gate cleanly stops if nothing's ready).

uses: globalcaos/marketing-coordinated-launch

Fire a synchronized multi-platform drop for any feature/paper that is robust enough. Self-gates: stops if nothing is ready (event-driven, never calendar-driven).

### 3. Make the work legible on video

**Done when:** A video for the relevant paper/feature is produced + cross-linked.

uses: globalcaos/marketing-youtube-video

Produce the explainer/demo video that boosts understanding and plants the work on video's discovery surface.

### 4. Keep the audience along for the ride

**Done when:** A genuine build-in-public update is posted + engagement happened.

uses: globalcaos/marketing-build-in-public

Keep the audience warm with honest progress between launches, and grow the owned channels.

### 5. Reveal a flagship when ready

**Done when:** A flagship is revealed if its safeguard gate passes (else cleanly deferred).

uses: globalcaos/marketing-flagship-launch

When a flagship is ready + safeguarded, run the flagship reveal. Self-gates on the safeguard checklist.

## Constraints

- North star = a small, genuinely-engaged audience, NOT vanity traffic.
- Every artifact funnels to {{owned_site}} in one consistent voice.
- Strategies are event-driven, not calendar-driven.
- Each sub-recipe is standalone-runnable; this bundle just runs them in sequence.
- Brand voice: keep your product's authentic edge, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip scanners and undercut trust; frame capability as the user's OWN. No buzzwords.

## Safety Notes

- Each sub-recipe carries its own safety gates; the flagship safeguards are mandatory and non-negotiable.
- Outward-facing actions are human-gated.
