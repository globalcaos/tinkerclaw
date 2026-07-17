---
schema: "kit/1.0"
slug: "marketing-flagship-launch"
title: "Launch a high-stakes flagship reveal with safeguards"
summary: "A reusable protocol for the biggest, riskiest reveals ({{flagship_features}}) — launched only when ready, behind a safeguard gate (readiness, consent, graceful-degrade, react-don't-bait) so either outcome (adoption OR pushback) feeds you and never harms your users."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "marketing"
subdivision: "launch"
tags:
  [
    "marketing",
    "flagship",
    "launch",
    "big reveal",
    "product hunt",
    "show hn",
    "silver bullet",
    "high stakes launch",
    "controversial feature",
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
  flagship_features:
    {
      type: "string",
      secret: true,
      description: "The high-stakes flagship feature(s) to reveal, with their specific risk/consent context.",
    }
  tts_tool: { type: "string", description: "Tool/skill for video narration." }
---

# Launch a high-stakes flagship reveal with safeguards

> A reusable protocol for the biggest, riskiest reveals ({{flagship_features}}) — launched only when ready, behind a safeguard gate (readiness, consent, graceful-degrade, react-don't-bait) so either outcome (adoption OR pushback) feeds you and never harms your users.

## Goal

Land the biggest moments for {{product}} on a mature catalog, with honest risk-handling so that adoption OR a crackdown both feed you and never harm the people who trusted you. North star: a small, genuinely-ENGAGED audience that comes back — optimize for owned+engaged signals (email opens, community posts, stars, watch-time, returning readers), NOT vanity pageviews/installs.

## When to Use

- A flagship feature ({{flagship_features}}) is ready AND its safeguards are in place
- Preparing such a reveal (run the readiness gate to see what's left)

## Steps

### 1. Readiness + safeguards gate

**Done when:** The safeguard checklist for {{flagship_features}} passes; if not, STOP and finish prep first.

Confirm the flagship is ready AND safeguarded. For a visual reveal: it runs alongside (not replacing) what users have, and graceful-degrades. For a risky/forbidden-edge feature: an honest framing, a graceful-degrade fallback so a block never bricks anyone, a versioned consent gate (with a 'use a separate, non-essential account' warning where account risk exists), a hardened README, and a pre-drafted response. If the checklist isn't met, STOP — these only fire when ready.

### 2. Build the reveal asset

**Tools:** {{tts_tool}}
**Done when:** The reveal asset (demo video / honest explainer) and a mature README are ready.

Visual flagship: a demo video (use the video recipe). Risky flagship: an honest explainer that discloses the risk and recommends a separate account. The README must be bulletproof before any traffic arrives.

### 3. Coordinated drop

**Done when:** The reveal is launched across platforms (incl. Product Hunt / Show HN), leading with the payoff, funneling to {{owned_site}}.

Run the coordinated multi-platform launch (the coordinated-launch recipe), adding Product Hunt + Show HN for the flagship. Lead with the payoff. Everything funnels to {{owned_site}}.

### 4. Hold the honest line

**Done when:** Monitoring is in place, the pre-drafted response is ready, and no part of the framing courts harm to users.

Disclose the risk in full, recommend a separate non-essential account where relevant, and ship behind the consent gate. If there is pushback (a platform/vendor moving against the feature), publish the pre-drafted response (the David-vs-Goliath moment, within the long game). The hard line: REACT, never BAIT a crackdown that could harm your users' accounts. Plan for the unglamorous quiet case, which the graceful-degrade fallback mitigates.

## Constraints

- Fire ONLY when the safeguard gate passes.
- A risky feature is never default-on, always consented, always graceful-degrade.
- Never engineer for, or court, an outcome that harms your users' accounts — react, don't bait.
- Funnel to {{owned_site}}.
- Brand voice: keep your product's authentic edge, but AVOID criminal-connotation words (stolen/steal/harvest/exfiltrate) — they trip scanners and undercut trust; frame capability as the user's OWN. No buzzwords.

## Safety Notes

- Where a feature carries account-ban risk, recommend a SEPARATE non-essential account; require explicit consent; ship a graceful-degrade fallback.
- Bulletproof the README before launch — a half-empty page bounces the traffic surge.
- Outward-facing; human-gated.

## Failures Overcome

- 'Release last on a fixed slot' is a load-bearing flaw — this protocol is readiness-gated + reactive, not calendar-bound.
