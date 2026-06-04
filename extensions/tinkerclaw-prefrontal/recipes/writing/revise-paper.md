---
schema: recipe/1.0
id: revise-paper
title: Revise Paper
category: writing
summary: Structured improvement pass on an existing paper — audit structure, strengthen claims, tighten prose, verify accuracy
triggers:
  [revise, improve, polish, "round of improvements", "bounce to", review paper, paper review]
effort: deep
tools: [read, grep, glob, exec, edit, write]
children: []
---

## Goal

Take an existing paper and produce a measurably better version — clearer structure, stronger evidence, tighter prose, fewer unsupported claims.

## When to Use

- Paper exists but needs improvement
- Bouncing a draft to a different model for fresh perspective
- Post-sprint polish before publication
- Incorporating reviewer feedback

## Steps

### 0. Improvement-notes triage (gate)

**Tools:** read, glob
**Done when:** Paper classified `actionable` / `seed-only` / `cleared`; non-actionable papers exit here

Before reading the whole paper, decide whether it even needs revising. Locate the improvement notes (`improvement_notes.md` in the folder, an `J-0XX-improvement-notes.md` sibling, or the `J-series-status` table's "Improvements Pending?" column). Classify:

- **actionable** — concrete pending items NOT yet reflected in the latest version → proceed to Step 1.
- **seed-only** — placeholder text, e.g. "none logged from a formal review pass yet" → STOP, report `skipped: no actionable notes`.
- **cleared** — notes exist but the latest version already incorporates them → STOP, report `skipped: already addressed`.

Run solo, this prevents wasting a deep pass on a paper with nothing pending. In the batch pipeline (`revise-publish-batch`) this gate is the fan-out filter — only `actionable` papers enter revision.

### 1. Full Read

**Tools:** read
**Done when:** Complete understanding of the paper's thesis, structure, and claims

First pick the **genuinely latest** version to revise: it is NOT always the highest-dated filename. Many folders hold an undated `<topic>.md` (e.g. `corporate-swarm.md`) that is the real current version with a higher `vX.Y` header than any dated file. Compare version headers across dated and undated candidates; ignore supporting files (`sota-expansion-*`, `*-review-*`, `*-critique*`, `*-references*`). Then read the entire paper without editing. Note:

- Central thesis and whether it's stated clearly
- Section flow — does each section earn its place?
- Claims made without evidence
- Redundancies or circular arguments
- Missing context a reader would need
- Tone inconsistencies

### 2. Structural Audit

**Tools:** read, write
**Done when:** List of structural issues with proposed fixes

Evaluate the architecture:

- Does the abstract accurately reflect the content?
- Is the introduction hook strong enough?
- Do sections follow a logical progression?
- Are there sections that should be merged, split, or reordered?
- Is the conclusion doing real work (synthesis, not summary)?
- Are figures/tables/diagrams earning their space?

Write a revision plan before touching the paper.

### 3. Evidence Check

**Tools:** read, grep, glob, exec
**Done when:** Every technical claim verified or flagged

For each technical claim:

- Check against actual code, configs, or test output
- Verify version numbers, file paths, function names
- Confirm benchmarks or metrics are current
- Flag any claim that can't be verified — either find evidence or soften the language

### 4. Prose Tightening

**Tools:** edit
**Done when:** Paper is shorter and clearer without losing content

Apply the cuts:

- Remove hedge words ("somewhat", "arguably", "it could be said")
- Kill filler sentences that restate what was just said
- Replace passive voice with active where it improves clarity
- Shorten sentences over 30 words
- Ensure consistent terminology (don't alternate between synonyms)
- Fix any AI-isms ("delve", "landscape", "robust", "leveraging")

### 5. Fresh Additions

**Tools:** edit, write
**Done when:** New content integrated where gaps were identified

Add what's missing:

- Concrete examples where abstract claims stood alone
- Comparisons or contrasts that strengthen the argument
- Implementation details that were hand-waved
- Failure modes or limitations section if absent
- Future work that's honest, not aspirational padding

### 6. Final Pass

**Tools:** read, edit
**Done when:** Paper reads clean from top to bottom

One final read-through for:

- Consistent formatting (headers, code blocks, references)
- No orphaned references or broken cross-links
- Abstract and conclusion still match after edits
- Word count delta (report: before → after)

## Constraints

- Never delete sections without replacing their content elsewhere
- Preserve the author's voice — improve, don't rewrite from scratch
- Report all changes made (summary at end)
- Version the output (v3.1, not overwrite v3.0)
- **Self-contained, version-independent:** the paper reads as a standalone first edition. No changelog, no "improvements in this version", no reference to prior versions. Versioning lives only in the filename/header, never in the prose.
- **Independent of sibling papers:** never label work a "J-series" or cite siblings by J-number/codename. When borrowing an idea from another paper, inline a 1–2 sentence summary of it (as for any external citation) — never assume the reader has read it. Fold any series-only "companion papers" framing into self-contained prose.

## Safety Notes

- Don't invent technical claims — only add what's verifiable
- Don't change the paper's thesis or conclusions without explicit approval
- Keep the original file intact — write to a new version

## Failures Overcome

- **Polish without substance:** Agent rephrases sentences without fixing structural issues. The structural audit step forces architectural thinking before line edits.
- **Evidence fabrication:** Agent adds impressive-sounding claims that aren't grounded. The evidence check step requires verification against actual artifacts.
- **Voice erasure:** Agent rewrites in its own style, losing the author's tone. The constraint to "improve, don't rewrite" prevents this.
