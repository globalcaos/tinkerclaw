---
schema: recipe/1.0
id: revise-paper
title: Revise Paper
category: writing
summary: Structured improvement pass on an existing paper — audit structure, strengthen claims, tighten prose, verify accuracy
triggers: [revise, improve, polish, "round of improvements", "bounce to", review paper, paper review]
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

### 1. Full Read
**Tools:** read
**Done when:** Complete understanding of the paper's thesis, structure, and claims

Read the entire paper without editing. Note:
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

## Safety Notes
- Don't invent technical claims — only add what's verifiable
- Don't change the paper's thesis or conclusions without explicit approval
- Keep the original file intact — write to a new version

## Failures Overcome
- **Polish without substance:** Agent rephrases sentences without fixing structural issues. The structural audit step forces architectural thinking before line edits.
- **Evidence fabrication:** Agent adds impressive-sounding claims that aren't grounded. The evidence check step requires verification against actual artifacts.
- **Voice erasure:** Agent rewrites in its own style, losing the author's tone. The constraint to "improve, don't rewrite" prevents this.
