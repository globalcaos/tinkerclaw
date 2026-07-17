---
schema: "kit/1.0"
slug: "simplify-parallel-review"
title: "Simplify — parallel code review (reuse + quality + efficiency, fan-out)"
summary: "Review all changed code through three parallel review lenses — code reuse, code quality, efficiency — each given the same full diff, then aggregate and FIX every confirmed finding directly. Not a report generator: findings get fixed, not listed."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "review"
tags:
  ["simplify", "review code", "clean up", "code review parallel", "review changes", "polish code"]
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
  review_model:
    {
      type: "string",
      default: "haiku",
      description: "Model tier for the three review subagents — cheap pattern-matching work, not creative reasoning.",
    }
---

# Simplify — parallel code review (reuse + quality + efficiency, fan-out)

> Three independent review lenses on the same diff, launched simultaneously,
> then one aggregation pass that fixes everything found.

## Goal

Review all changed code for reuse opportunities, quality issues, and
efficiency problems using three parallel review agents, then fix everything
found.

## When to Use

- Before committing a batch of changes
- After implementing a feature, before PR
- When the user says "clean this up" or "review the changes"
- Post-implementation quality pass

## Steps

### 1. Identify changes

**Done when:** Full diff captured.

Run `git diff` (or `git diff HEAD` for staged changes). If no git changes,
review the most recently modified files.

### 2. Launch three review agents in parallel

**Done when:** All three agents return findings.

Dispatch all three subagents simultaneously — in the SAME message, never
sequentially. Each runs on {{review_model}} and receives the FULL diff so it
has complete context.

#### Agent 1: Code Reuse Review

For each change:

- Search for existing utilities and helpers that could replace newly written code
- Flag any new function that duplicates existing functionality — suggest the existing one
- Flag inline logic that could use an existing utility (hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards)

#### Agent 2: Code Quality Review

Flag these patterns:

- **Redundant state**: duplicates existing state, cached values that could be derived
- **Parameter sprawl**: adding params instead of restructuring
- **Copy-paste with variation**: near-duplicate code that should be unified
- **Leaky abstractions**: exposing internals, breaking abstraction boundaries
- **Stringly-typed code**: raw strings where constants/enums already exist
- **Unnecessary comments**: comments explaining WHAT (code already says that) — keep only non-obvious WHY

#### Agent 3: Efficiency Review

Flag these patterns:

- **Unnecessary work**: redundant computations, repeated file reads, N+1 patterns
- **Missed concurrency**: independent operations run sequentially
- **Hot-path bloat**: blocking work on startup or per-request paths
- **Recurring no-op updates**: state updates that fire unconditionally without change detection
- **TOCTOU**: pre-checking existence before operating (operate directly, handle the error)
- **Memory**: unbounded data structures, missing cleanup, event listener leaks
- **Overly broad operations**: reading entire files when only a portion is needed

### 3. Aggregate and fix

**Done when:** All issues fixed or explicitly skipped with reason.

Wait for all three agents. Aggregate findings. Fix each issue directly. If a
finding is a false positive, note it and move on — don't argue, just skip.

### 4. Verify

**Done when:** Tests pass, build succeeds.

Run tests and build. Confirm nothing broke during cleanup.

### 5. Summary

**Done when:** Brief report of what was fixed.

List what was fixed, what was skipped (with reason), and confirm the code is
clean.

## Constraints

- All three agents launch in the SAME message (parallel, not sequential)
- Each agent gets the FULL diff — don't split the work by file
- Use {{review_model}} for all three agents — this is focused comparison work, not creative reasoning
- Fix issues directly — don't just report them
- Skip false positives without debating them

## Safety Notes

- Don't refactor working code that isn't in the diff
- Don't introduce new patterns — match existing codebase conventions
- Run tests after every batch of fixes

## Failures Overcome

- **Sequential review**: Running agents one after another wastes time. Parallel launch is the point — independent analyses don't need to wait.
- **Report without fix**: Agent lists 12 issues but doesn't fix any. Step 3 requires fixing, not reporting.
- **Over-qualified reviewers**: Using opus/sonnet for pattern-matching comparison work. A cheap tier (default haiku) is sufficient and 10× cheaper.
- v1.0 resurrected 2026-06-13 from commit a239df31a4^ (deleted schema recipe/1.0 `coding/simplify.md`), modernized to kit/1.0 with {{review_model}} param per the skeleton+variables rule.
