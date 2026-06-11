---
schema: recipe/1.0
id: audit-paper-posts
title: Audit Paper ↔ Post Staleness
category: writing
summary: Detect NEW papers without a post and STALE posts (paper revised past the version the post serves) for the thetinkerzone.com Building Jarvis series — read-only audit that routes each finding to its follow-up recipe
triggers:
  [
    check for new papers,
    detect staleness,
    stale posts,
    new papers,
    audit posts,
    which papers need publishing,
    are our posts up to date,
    paper post audit,
  ]
effort: light
tools: [read, glob, exec]
children: [publish-paper-summary, revise-publish-batch, compile-paper]
---

## Goal

Answer two questions in one read-only pass, then route each finding to the recipe that fixes it:

1. **New papers** — which `~/Documents/AI_reports/Papers/J*/` folders have no post on thetinkerzone.com yet?
2. **Stale posts** — which live posts serve a PDF whose version is now behind the paper's latest revision?

This is the **discovery gate** that sits in front of `publish-paper-summary` (publish the new ones) and `revise-publish-batch` / `compile-paper` (rebuild + refresh the stale ones). It writes nothing and publishes nothing — it produces a work-list.

## When to Use

- "Check for new papers locally and detect staleness in our posts."
- Periodically (after a revision sprint, or on a cadence) to catch posts that drifted behind their source paper.
- Before a publish push, to know exactly which folders are new-and-ready vs new-but-seed.

Not for: actually publishing or refreshing — those are the child recipes. This only tells you what needs them.

## Execution model

The audit is deterministic, not a fan-out — one script does it:

```
python3 ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/writing/audit-paper-posts.py
```

It scans every `J*` folder for its highest-versioned paper `.md`, queries the live `Building Jarvis` category (id 29) for each post's served PDF + version, matches paper↔post, and prints four buckets: **current / stale / new / orphan**, with the follow-up action per bucket.

## Steps

### 1. Run the audit (read-only)

**Tools:** exec
**Done when:** the four buckets are printed and shown to the user

Run the script. It reads `WP_APP_PASSWORD` from `skills/wordpress-ultimate/.env`. No writes. Surface the buckets verbatim — the user decides what to act on.

### 2. Route the findings

**Tools:** read
**Done when:** each actionable item is mapped to its child recipe (or held)

- **STALE** → if the latest version has no built PDF, recompile first (`compile-paper`, or `revise-publish-batch` if notes are pending); re-SFTP the new PDF (REST PDF upload is WAF-blocked — see `reference_tinkerzone_wp_publishing`); then refresh the existing post's body + featured image in place (do NOT create a duplicate post).
- **NEW + ready (PDF built)** → `publish-paper-summary.workflow.js` with `args.folders = [...]` (creates DRAFTS for review — never auto-publish).
- **NEW + seed (no PDF)** → hold. A `sketch-v0.1` is not publishable; report it, don't act.
- **ORPHAN** (post with no paper folder) → investigate manually; usually a renamed folder or a non-paper post mis-filed in the category.

### 3. Pause for go

**Tools:** read
**Done when:** the user has chosen what to publish/refresh

Publishing and post-refresh touch the live public site — get explicit go (Rule 3, reversibility) before running any child recipe. The audit itself needs no permission; the actions it routes to do.

## Constraints

- Read-only: this recipe never writes a paper, builds a PDF, or touches a post. It only reports.
- Match key is the paper's **version-stem topic** with a substring fallback and a small alias map (`cortex`→`identity-persistence`); a new codename↔title rename needs one `ALIASES` entry in the script.
- "Latest version" = highest `vX.Y[.Z]` header among the folder's real paper `.md` files (skips `improvement_notes`, `*-review*`, `*-critique*`, `sota-expansion*`, `diagram-suggestions`), not the newest filename date.
- Never auto-publish or auto-refresh — Step 3 gate is mandatory.

## Safety Notes

- The WP query needs the app password; the script reads it from the gitignored `.env`, never echoes it.
- A `draft` post counts as "has a post" — staleness applies to drafts too, so a stale draft is flagged before it ever goes live.

## Failures Overcome

- **New papers fell through the cracks:** the publish fan-out only covered the folders it was handed; J16/J17/J18 existed on disk with no post and nothing surfaced them. This audit makes "folder with no post" a first-class, automatic finding.
- **Silent post drift:** a paper revised after its post was built (J11 amygdala v2.8→v3.0) leaves the public post serving an outdated PDF with no signal. Version-diffing the served PDF against the folder's latest catches it.
- **Codename ≠ published title:** paper files use codenames (`cortex`, `myelin`) while posts use reader-facing titles (`identity-persistence`, `myelin-budget-prompting`). Naïve filename matching would mis-flag every renamed paper as both "new" and "orphan"; substring matching + a tiny alias map fixes it.
- **Date ≠ version:** an undated `<topic>.md` can outrank a newer-dated file; the audit compares version headers, not mtimes (same trap `revise-paper` Step 1 calls out).
