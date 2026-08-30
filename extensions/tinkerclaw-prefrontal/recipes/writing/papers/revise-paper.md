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
- **cleared** — notes exist but the latest version already incorporates them →
  do not revise the manuscript. If `improvement_notes.md` still contains the
  incorporated entries, archive it and replace it with the Step-7 cleared stub
  naming the existing version; then report `skipped: already addressed`.

Run solo, this prevents wasting a deep pass on a paper with nothing pending. In the batch pipeline (`revise-publish-batch`) this gate is the fan-out filter — only `actionable` papers enter revision.

Normalizing a stale notes file for a `cleared` paper is housekeeping, not a new
paper revision. It prevents the next nonblank-file check from reopening work that
the manuscript already contains.

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
- Does the abstract work as a one-page doorway rather than a miniature paper? Target 300–450 words in 3–5 visibly separated paragraphs: the problem, what the paper does, how it was tested or reasoned about, and the outcome. Use plain vocabulary a non-specialist can follow; explain necessary technical terms in the sentence where they appear. Remove section-number tours, revision history, and long keyword inventories. Date claims that can go stale ("using information available in July 2026"). If PDF is the deliverable, render and inspect the abstract page—successful compilation does not prove readable fit.
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

### 7. Reset the improvement notes (close the staleness loop)

**Tools:** read, write, exec
**Done when:** `improvement_notes.md` carries zero un-incorporated pending entries

The staleness chain treats a non-blank `improvement_notes.md` as proof the paper is stale, so if you incorporate the notes but leave them in place, the next Step-0 triage re-classifies the paper "actionable" and revises it **forever**. Once the notes are folded into the new version, reset them in the SAME pass:

1. **Archive** the incorporated content → `improvement_notes.incorporated-<YYYY-MM-DD>.md`.
2. **Replace** `improvement_notes.md` with a header only — `Incorporated into <new-version> on <YYYY-MM-DD>. Prior notes archived in improvement_notes.incorporated-<YYYY-MM-DD>.md.` — and no pending `###` entries.
3. **Keep deferrals explicit:** anything you deliberately did NOT incorporate stays as a pending entry — clear only what actually landed.
4. **Gate on success, and it's reversible:** only reset once the revised version is confirmed good — written, and (if a PDF is part of the deliverable) built with every figure present. A failed or half-done revision KEEPS its notes so the next pass retries it. The reset is a file move + stub rewrite, never a delete.

The test: re-running Step-0 triage on the paper now classifies it **cleared**, not actionable. (Skipping this step is what makes a paper look like it needs infinite rewrites.)

> **Pipeline note:** inside the `revise-publish-jseries` workflow the _compile_ step performs this archive after a clean build (it scopes the revise agent to Steps 1–6), so don't double-archive there. This Step 7 is for standalone recipe runs that aren't followed by the compile stage.

## Constraints

- Never delete sections without replacing their content elsewhere
- Preserve the author's voice — improve, don't rewrite from scratch
- Report all changes made (summary at end)
- Version the output (v3.1, not overwrite v3.0)
- **Always reset `improvement_notes.md` after incorporating (Step 7)** — leaving incorporated notes in place makes the staleness chain demand endless re-revisions of an already-current paper
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
