---
schema: "kit/1.0"
slug: "requesting-code-review"
title: "Request Code Review"
summary: "Structured code review before merge — diff correctness, simplification, risk areas, and sign-off"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "coding",
    "review",
    "code review",
    "merge",
    "pull request",
    "before I merge",
    "check my code",
    "ready to ship",
    "lgtm",
    "sign off",
    "is this ready",
    "pr",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-baked-cc-recipe"
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
    - [4]
  notes: |
    Step 0 (diff capture + verification enumeration) is a single combined step because both reads happen in one shell pass with no dependencies between them — collapsing them removes a false serial chain. Steps 1 and 2 (correctness review and simplification review) are genuinely independent passes over the same diff and can run in parallel. Step 3 (synthesis + review artifact) depends on both review passes completing. Step 4 (fix blockers + re-verify) depends on the findings list from step 3.
---

# Request Code Review

> Structured code review before merge — diff correctness, simplification, risk areas, and sign-off

## Goal

Produce a structured, evidence-backed review request that catches correctness bugs and simplification opportunities before merge, and gives the reviewer enough context to approve or reject with confidence.

## When to Use

- Before merging a feature branch or submitting a PR
- After completing a major implementation task
- When asked to 'review my changes', 'check my code before I ship', or 'is this ready to merge'
- Any time the change touches shared utilities, auth, persistence, or concurrency
- When a peer agent or CI gate requires a structured review artifact before approving the branch
- Before requesting human sign-off, to pre-filter blockers so the human reviewer focuses on judgment calls rather than obvious bugs

## Steps

### 1. Capture the diff and enumerate verification already done

**Tools:** exec, read
**Done when:** Full diff is in hand (non-empty output confirmed); change narrative written (what changed, why, blast radius); list of completed checks produced with explicit names and pass/fail — skipped checks named as gaps

Run `git diff <base>...HEAD` to get the complete patch. Simultaneously run `git log <base>..HEAD --oneline` and check test/lint/type-check output for evidence of passing CI. Write a concise change narrative: what the code now does differently, the motivation, and scope. List each check (tests, lint, type-check, build, manual probe) with its result — no hedging. If a check was skipped, name it explicitly as a gap. These are independent reads and can be done in one pass.

### 2. Review diff for correctness bugs

**Tools:** read, grep, glob
**Done when:** Every changed hunk audited; findings list produced with file:line and severity (BLOCKER or WARN) for each issue found; explicitly states 'no findings' if clean — not left blank

Read every changed hunk for logic errors: off-by-one, missing null/error guards, wrong branch conditions, state mutation ordering, incorrect caller assumptions. For every changed function signature or exported symbol, use grep/glob to find all call sites and verify they are consistent with the new contract. Flag each finding as BLOCKER (would cause incorrect behavior) or WARN (risk or debt, but not a correctness fault).

### 3. Review diff for reuse, simplification, and efficiency

**Tools:** read, grep, glob
**Done when:** Simplification/reuse findings listed separately from correctness findings; explicitly states 'no findings' if clean — not left blank; no new functionality introduced during this pass

Independent of the correctness pass: look for duplicated logic that could reuse an existing helper, unnecessary allocations or re-computations in hot paths, and dead code introduced by the change. Keep this list strictly separate from bug findings — mixing severity levels causes reviewers to deprioritise blockers.

### 4. Synthesise findings into a structured review artifact

**Tools:** read
**Done when:** Single review artifact produced containing: change narrative, verification evidence with named gaps, correctness findings (BLOCKER/WARN), simplification findings, risk areas with file:line callouts, and an explicit binary sign-off question — all six sections present even if empty

Combine all prior findings into one review artifact. Risk areas are sections of the diff deserving extra reviewer attention (shared utilities, concurrency, persistence, auth, public API surface). Correctness and simplification findings must remain as separate labelled sections. End with an explicit binary question: 'Approve to merge as-is?' or 'Approve after resolving [list]?' — not an open-ended 'LGTM?'.

### 5. Fix all BLOCKER findings, re-verify, and update the artifact

**Tools:** edit, read, grep, exec
**Done when:** Every BLOCKER finding has a commit or inline resolution; test suite re-run and green (output shown, not inferred); review artifact updated to record which findings were resolved and how; WARN findings listed as accepted trade-offs with rationale or escalated to BLOCKER if re-examination warrants

Fix every BLOCKER before requesting sign-off — do not ship known correctness bugs for the reviewer to find. Use read/grep to re-verify call sites after edits. Re-run the full test suite and paste the result. Update the review artifact: move resolved BLOCKERs to a 'resolved' section with a one-line description of the fix. Do not introduce new logic while fixing — fix only, no scope creep.

## Constraints

- Never self-approve — the review artifact must go to a human or peer agent, not loop back to the authoring agent
- Correctness review and simplification review are separate passes — mixing them causes both to be shallow
- Do not introduce new logic while fixing BLOCKER findings — fix only, no scope creep
- The sign-off ask must be explicit and binary (approve/request-changes), not an open-ended question
- Always verify the diff is against the correct base branch before reviewing — reviewing against a stale or wrong base produces a meaningless audit

## Safety Notes

- Check all call sites of any changed shared function before declaring it correct — a function that looks right in isolation may break callers with different assumptions
- Do not treat passing tests as a correctness certificate — tests only cover what was written; explicitly audit the untested paths in the diff
- Confirm the base branch is current (fetch + compare) before diffing — a stale base hides conflicts that will surface at merge time

## Failures Overcome

- **Silent known-bug ship:** Agent marks work complete without auditing the diff, leaving a correctness bug for production. Mandatory hunk-by-hunk correctness pass (step 2) before the sign-off request prevents this.
- **Mixed-concern review chaos:** Correctness bugs and style/simplification suggestions land in the same list, causing reviewers to deprioritise blockers. Steps 2 and 3 are explicitly separate passes with separate output lists.
- **Vague sign-off request:** Agent asks 'LGTM?' with no context, reviewer approves on trust. Step 4 requires six named sections including verification evidence and risk areas — the reviewer has enough signal to actually decide.
- **Call-site blind spot:** A changed function signature is reviewed in isolation and looks correct, but breaks callers with different assumptions. Step 2 mandates grep/glob across all call sites for every changed exported symbol.
- **Stale-base review:** Agent runs `git diff HEAD` instead of `git diff <base>...HEAD`, reviewing only the last commit rather than the full branch delta, missing earlier regressions introduced in the branch.
- **Fix introduces new scope:** While resolving a BLOCKER, agent refactors adjacent code, widening the diff and introducing new review surface. Step 5 explicitly prohibits new logic during fix passes.
