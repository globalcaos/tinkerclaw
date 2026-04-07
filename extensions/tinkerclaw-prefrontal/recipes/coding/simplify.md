---
schema: recipe/1.0
id: simplify
title: Simplify — Parallel Code Review
category: coding
summary: Three parallel review agents (reuse, quality, efficiency) on the same diff, then fix all issues
triggers: [simplify, review code, clean up, code review parallel, review changes, polish code]
effort: deep
tools: [exec, read, sessions_spawn, edit]
children: []
---

## Goal
Review all changed code for reuse opportunities, quality issues, and efficiency problems using three parallel agents, then fix everything found.

## When to Use
- Before committing a batch of changes
- After implementing a feature, before PR
- When the user says "clean this up" or "review the changes"
- Post-implementation quality pass

## Steps

### 1. Identify Changes
**Tools:** exec
**Done when:** Full diff captured

Run `git diff` (or `git diff HEAD` for staged changes). If no git changes, review the most recently modified files.

### 2. Launch Three Review Agents in Parallel
**Tools:** sessions_spawn (×3, all at once)
**Done when:** All three agents return findings

Spawn all three simultaneously. Pass each the FULL diff so they have complete context.

#### Agent 1: Code Reuse Review (model: haiku)
For each change:
- Search for existing utilities and helpers that could replace newly written code
- Flag any new function that duplicates existing functionality — suggest the existing one
- Flag inline logic that could use an existing utility (hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards)

#### Agent 2: Code Quality Review (model: haiku)
Flag these patterns:
- **Redundant state**: duplicates existing state, cached values that could be derived
- **Parameter sprawl**: adding params instead of restructuring
- **Copy-paste with variation**: near-duplicate code that should be unified
- **Leaky abstractions**: exposing internals, breaking abstraction boundaries
- **Stringly-typed code**: raw strings where constants/enums already exist
- **Unnecessary comments**: comments explaining WHAT (code already says that) — keep only non-obvious WHY

#### Agent 3: Efficiency Review (model: haiku)
Flag these patterns:
- **Unnecessary work**: redundant computations, repeated file reads, N+1 patterns
- **Missed concurrency**: independent operations run sequentially
- **Hot-path bloat**: blocking work on startup or per-request paths
- **Recurring no-op updates**: state updates that fire unconditionally without change detection
- **TOCTOU**: pre-checking existence before operating (operate directly, handle the error)
- **Memory**: unbounded data structures, missing cleanup, event listener leaks
- **Overly broad operations**: reading entire files when only a portion is needed

### 3. Aggregate and Fix
**Tools:** read, edit
**Done when:** All issues fixed or explicitly skipped with reason

Wait for all three agents. Aggregate findings. Fix each issue directly. If a finding is a false positive, note it and move on — don't argue, just skip.

### 4. Verify
**Tools:** exec
**Done when:** Tests pass, build succeeds

Run tests and build. Confirm nothing broke during cleanup.

### 5. Summary
**Done when:** Brief report of what was fixed

List what was fixed, what was skipped (with reason), and confirm the code is clean.

## Constraints
- All three agents launch in the SAME message (parallel, not sequential)
- Each agent gets the FULL diff — don't split the work by file
- Use haiku for all three agents — this is focused comparison work, not creative reasoning
- Fix issues directly — don't just report them
- Skip false positives without debating them

## Safety Notes
- Don't refactor working code that isn't in the diff
- Don't introduce new patterns — match existing codebase conventions
- Run tests after every batch of fixes

## Failures Overcome
- **Sequential review**: Running agents one after another wastes time. Parallel launch is the point — independent analyses don't need to wait.
- **Report without fix**: Agent lists 12 issues but doesn't fix any. Step 3 requires fixing, not reporting.
- **Over-qualified reviewers**: Using opus/sonnet for pattern-matching comparison work. Haiku is sufficient and 10× cheaper.
