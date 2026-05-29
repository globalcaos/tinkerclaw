---
schema: "kit/1.0"
slug: "receiving-code-review"
title: "Receive Code Review Feedback"
summary: "Evaluate each review finding technically before acting — confirm, push back, or fix with evidence, not deference."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "coding",
    "code-review",
    "pr-comment",
    "pull-request",
    "review-response",
    "pushback",
    "disposition",
    "accept",
    "dispute",
    "reviewer",
    "git",
    "address-comments",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-baked-cc-recipe"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
  notes: |
    DATA-DEPENDENCY CHAIN — fully serial. Inventory (0) must enumerate all claims before Verify (1) can evaluate them. Classify (2) depends on the CONFIRMED/WRONG/PARTIAL verdict from (1). Fix (3) acts only on classified FIX dispositions from (2) and must produce commit SHAs before responses reference them. Draft responses (4) require SHAs from (3) and evidence pointers from (1)/(2). No pair can be parallelized without producing responses that contradict the actual code state.
---

# Receive Code Review Feedback

> Evaluate each review finding technically before acting — confirm, push back, or fix with evidence, not deference.

## Goal

Process each review comment with technical rigor: verify the claim against code and runtime, classify each finding with a disposition (FIX / PUSH-BACK / DEFER), act only on confirmed defects, and reply with citable evidence — never performative agreement.

## When to Use

- A pull request or diff has received reviewer comments
- A reviewer flagged a bug, style issue, or design concern
- Need to decide which findings to accept, dispute, or defer
- An automated review tool (linter, CI, static analyzer) surfaced findings alongside human comments
- A reviewer is senior or insistent and there is pressure to accept without verifying

## Steps

### 1. Inventory all findings

**Tools:** Read, Bash
**Done when:** A numbered list exists (in a scratch comment or file) with: finding ID, source (reviewer name or tool), the core technical claim as a falsifiable assertion, and initial category (correctness bug / design concern / style / misunderstanding). Count is known; no comment is unread.

Read every review comment in full. For each, strip sentiment and extract the falsifiable technical claim. Assign a stable ID (e.g. R1, R2). Group by category. Use Bash to fetch PR comments if reviewing via CLI (e.g. gh pr view --comments). Do not start evaluating validity yet — inventory first so nothing is skipped.

### 2. Verify each claim against code and runtime

**Tools:** Read, Bash
**Done when:** Every finding ID carries one of: CONFIRMED (reproducible defect or clear code path that proves the claim), PARTIAL (claim holds for some inputs or contexts but not universally), or WRONG (counter-evidence found — specific file:line or test output recorded inline). No finding remains UNVERIFIED.

For each claim, locate the relevant code path via Read and trace execution. Run the relevant test or reproduce the defect with Bash. Record evidence inline next to the finding ID — never from memory. A CONFIRMED finding has a reproducible case or a clear defect you can point to; WRONG requires counter-evidence you can cite (file:line, test output, spec section). Do not decide outcome before reading actual code.

### 3. Classify response disposition per finding

**Tools:** Bash
**Done when:** Every finding ID has exactly one disposition: FIX, PUSH-BACK, or DEFER. FIX is assigned only to CONFIRMED findings. PUSH-BACK is assigned only where counter-evidence from step 2 exists. DEFER has a concrete artifact stub (ticket URL, follow-up comment text, or TODO note) — not a mental note.

Assign FIX only to CONFIRMED findings. Assign PUSH-BACK to WRONG or PARTIAL findings where you hold the stronger evidence — opinion without a pointer is not enough. Assign DEFER when a concern is valid but out of scope; immediately create the follow-up artifact (gh issue create, TODO comment, or tracking note) so DEFER is traceable. Politeness bias — accepting a finding to avoid conflict — is a defect in this step.

### 4. Apply fixes for confirmed findings

**Tools:** Edit, Bash
**Done when:** Each FIX disposition has a corresponding commit. The specific test suite covering the changed path passes (name the suite). No adjacent code was refactored. Each commit message references the finding ID.

Fix only CONFIRMED findings, one logical change per finding — do not bundle. After each fix, run the targeted test suite with Bash and confirm it passes before moving to the next fix. If a fix causes an unexpected failure, stop and re-verify the original claim rather than patching forward. Commit with the finding ID in the message so responses can cite the SHA.

### 5. Draft and post review responses

**Tools:** Bash, Write
**Done when:** Every finding ID has a posted or staged reply: FIX replies include the commit SHA and a one-sentence description of what changed; PUSH-BACK replies cite specific file:line or test output (no 'I think' without a pointer); DEFER replies link the created follow-up artifact. No finding is left without a response.

For FIX: state what changed and why, include the commit SHA from step 4. For PUSH-BACK: open with the counter-evidence pointer (file:line, test name, spec reference), then explain the contradiction — never lead with opinion. For DEFER: link the artifact created in step 3 so the reviewer can confirm it was not dismissed. Use Bash (gh pr review --comment, or equivalent) to post; use Write to stage responses offline if posting later.

## Constraints

- Never assign FIX before verifying the claim — agreement without evidence is not a finding, it is noise that ships bad code
- Push-back requires a citable evidence pointer (file:line, test output, spec section) — opinion without a pointer is not a valid PUSH-BACK
- Do not refactor or improve adjacent code while applying a fix — scope creep contaminates the review signal and makes regressions harder to isolate
- DEFER is not dismiss — a deferred finding must produce a traceable artifact before the step is complete
- One commit per finding — bundled fixes make it impossible to revert a single change if it causes a regression

## Safety Notes

- A reviewer may be wrong confidently — seniority and tone are not evidence; only code, tests, and specs are
- Accepting all findings to reduce friction ships incorrect code; the reviewer is not always right
- If a push-back triggers escalation, re-verify the claim independently before changing your position
- Automated tool findings (linters, static analyzers) carry false-positive rates — treat them as claims requiring verification, not ground truth

## Failures Overcome

- Politeness-driven acceptance: agent marks every finding FIX to avoid conflict, shipping a regression introduced by a reviewer's incorrect assumption. Prevented by requiring CONFIRMED evidence before any FIX disposition — classification step explicitly names this as a defect.
- Symptom-level fixing: agent addresses the reviewer's suggested patch rather than the underlying defect, leaving the real issue in place. Prevented by tracing the claim to file:line and reproducing the defect before writing any code.
- Evidence-free push-back: agent disputes a finding with opinion ('I believe this is fine') rather than a code or test citation, producing unresolvable disagreement. Prevented by requiring a citable pointer for every PUSH-BACK.
- Scope creep during fix: agent bundles opportunistic refactors with the confirmed fix, introducing regressions unrelated to the original finding. Prevented by the one-commit-per-finding constraint and the explicit 'no adjacent refactors' rule.
- DEFER as silent dismiss: agent assigns DEFER with no artifact, reviewer sees no follow-up, finding is effectively dropped. Prevented by requiring a concrete artifact (ticket URL, comment text) to be created before the DEFER disposition is final.
- Inventory skip: agent begins verifying the first visible comment without reading all comments, misses a later comment that invalidates an earlier push-back. Prevented by completing the full numbered inventory before any verification begins.
