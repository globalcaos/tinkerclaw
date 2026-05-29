---
schema: "kit/1.0"
slug: "ultracode-orchestration"
title: "Ultracode Orchestration"
summary: "Scale effort to the ask: solo inline for trivial, parallel subagents for independent work, full understand→design→implement→verify workflow for high-stakes or cross-cutting tasks."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "operations",
    "orchestration",
    "subagents",
    "parallel",
    "adversarial",
    "judge-panel",
    "loop-until-dry",
    "completeness",
    "multi-step",
    "workflow",
    "quality-gates",
    "dispatch",
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
    Fully serial by data dependency. Step 0 (tier decision) gates all others: subsequent steps differ based on tier. Step 1 (design) must be complete and locked before step 2 (implement) begins — FULL-WORKFLOW only. Step 2 output is required input for step 3 (adversarial verify). Step 4 (completeness critic) requires all prior steps to have produced their artifacts. Internal parallelism within step 2 (parallel subagent dispatches) is implementation detail, not step-level concurrency — dispatches are serial-with-verification: dispatch → verify git state → next dispatch.
---

# Ultracode Orchestration

> Scale effort to the ask: solo inline for trivial, parallel subagents for independent work, full understand→design→implement→verify workflow for high-stakes or cross-cutting tasks.

## Goal

Execute hard or comprehensive tasks at the correct effort tier: read the ask, commit to a tier, compose applicable quality patterns (adversarial verify, judge-panel, loop-until-dry, completeness critic), and ship correct output. Correctness over cost; token generosity over truncation.

## When to Use

- 2+ subtasks exist with provably non-overlapping write targets (PARALLEL tier)
- The task is cross-cutting, high-stakes, or requires a design before touching code (FULL-WORKFLOW tier)
- A finding or solution needs an independent skeptic pass before being reported (adversarial verify)
- Multiple candidate solutions exist and a winner must be chosen on scored criteria (judge-panel)
- Discovery work has unknown size — the scan must run until a full pass finds zero new items (loop-until-dry)
- A completeness gate is needed before claiming done — enumerate requirements and confirm each

## Steps

### 1. Calibrate scale tier

**Tools:** Read, Bash, Grep
**Done when:** A tier label (SOLO / PARALLEL / FULL-WORKFLOW) and a one-sentence rationale appear as the first output line; no implementation has started yet

Read the full ask plus any referenced files before deciding. SOLO: single file, one concern, no design needed. PARALLEL: 2+ subtasks with provably non-overlapping write targets. FULL-WORKFLOW: cross-cutting, high-stakes, or requires a design doc before any code. If you cannot assign a tier without reading more context, read it now — a wrong tier chosen late is an invisible failure mode. Write the tier decision visibly before any other action.

### 2. Understand and design (FULL-WORKFLOW tier only; skip for SOLO and PARALLEL)

**Tools:** Read, Bash, Grep, Write
**Done when:** A written design doc or numbered step list exists on disk or inline; every load-bearing unknown is resolved by evidence (search / calc / fetch result cited), not assumption; no ambiguity remains that would flip the implementation direction

Read every relevant file, log, and spec before writing a line of implementation. Identify load-bearing unknowns — if wrong, the answer flips — and resolve them NOW via search, calculation, or fetch. A trailing caveat after shipping findings is a protocol violation. Write the design as a concrete artifact (file or inline numbered list). Lock the design before step 3 begins; no mid-implementation redesigns.

### 3. Implement

**Tools:** Edit, Write, Bash
**Done when:** SOLO: change complete and git status clean. PARALLEL: all subagent dispatches finished; for each dispatch, git status + git log --oneline -5 confirm the expected disk state before the next dispatch is sent. FULL-WORKFLOW: every design step addressed; git status clean; no opportunistic refactors added

SOLO: implement inline in one pass. PARALLEL: dispatch each independent subtask via the subagent harness; pass long prompts via stdin file redirect, not shell heredoc; after every dispatch (success, fail, or silent exit) run git status + git log — the subagent's text report is a summary, not proof of disk state. FULL-WORKFLOW: implement design steps in order, one concern per change. In all tiers: if you discover mid-implementation that the tier was wrong (e.g., SOLO ballooned to multi-file), surface it explicitly and re-calibrate before continuing.

### 4. Adversarial verify

**Tools:** Read, Bash, Grep, Write
**Done when:** An independent skeptic pass has challenged every major claim, finding, or solution — not a re-read of the same reasoning path. Each challenge is resolved (confirmed, corrected, or flagged as known limitation). For judge-panel: scores written for each candidate on correctness, side-effects, reversibility; winner identified. For loop-until-dry: scan ran until a complete pass found zero new items (not after a fixed iteration count)

Re-approach the work as a skeptic who did not produce it. Challenge assumptions, check edge cases, probe boundary conditions. This must be a genuinely independent reasoning path — running the same mental model again is not adversarial. If multiple candidate solutions exist, score each on a judge panel (correctness, minimal side-effects, reversibility) and select the winner with written justification. For discovery tasks with unknown size (missing links, untested paths, coverage gaps), loop the scan until a full pass finds nothing new — termination is evidence-driven, not count-driven. Write the adversarial findings as a brief artifact before proceeding.

### 5. Completeness critic and close

**Tools:** Read, Bash
**Done when:** Every requirement from step 1 is listed and confirmed addressed or explicitly marked as intentional omission with reason; git status is clean (no orphan files); result reported as WHAT WE HAVE + TRADE-OFFS, two sections, nothing omitted to save tokens

Before claiming done: enumerate every requirement gathered in step 1, confirm each is addressed by a specific artifact or action, name any intentional omissions with a one-line rationale. Run git status — no orphan untracked files. If any requirement is unaddressed and not intentionally omitted, go back. Report result in two sections: WHAT WE HAVE (facts, artifact locations) and TRADE-OFFS (explicit omissions, known limitations). Be generous with tokens here; a truncated final check is a false close.

## Constraints

- SOLO tier: do NOT spawn subagents or write design docs — overhead must match the ask; if scope expands mid-pass, surface the tier change explicitly
- PARALLEL tier: subagents must have provably non-overlapping write targets declared before dispatch; verify git status + git log after every dispatch before sending the next
- FULL-WORKFLOW tier: design doc must exist on disk before any implementation begins; no opportunistic refactors during implementation
- Loop-until-dry terminates only when a full scan pass returns zero new items — never after a fixed iteration count
- Adversarial verify must use a genuinely independent reasoning path, not a re-read of the same derivation
- Be generous with tokens — truncating to save cost is the primary failure mode; correctness wins over brevity
- Resolve all load-bearing unknowns in step 1 or 2; trailing them as caveats after shipping findings is a protocol violation
- Long subagent prompts must be passed via stdin file redirect, not shell heredoc, to avoid shell quoting failures

## Safety Notes

- A subagent exit code is not proof of side effects — always verify git status + git log after every dispatch before proceeding
- A load-bearing unknown (if wrong, the answer flips) is a prerequisite that must be resolved before concluding, not a trailing caveat
- Adversarial verify must be a genuinely independent pass — running the same reasoning path again does not qualify
- Claiming SOLO tier when the task is actually PARALLEL or FULL-WORKFLOW scale is silent under-coverage; surface tier changes explicitly if discovered mid-implementation

## Failures Overcome

- Effort mismatch: agent applies full workflow to a trivial one-liner (waste) or does a solo pass on a cross-cutting multi-file change (missed coverage). Fixed by the explicit written tier decision in step 0 with rationale before any action.
- False close: agent claims done without a completeness critic, leaving unaddressed requirements or orphan files. Fixed by step 4 enumerating every requirement from step 1 and confirming each has a specific artifact.
- Speculative fix loop: agent ships a fix built on an unverified assumption, iterates 3-4 times on the wrong layer. Fixed by resolving load-bearing unknowns in step 1/2 and the adversarial verify pass in step 3.
- Subagent collision: two parallel dispatches write to the same file; second silently overwrites first. Fixed by requiring non-overlapping write targets declared before dispatch and mandatory git verification after each dispatch.
- Silent subagent success with no disk writes: subagent exits 0 with a success report but produced no file changes. Fixed by the post-dispatch git status + git log check — disk state, not text report, is the truth.
- Fake adversarial pass: agent re-reads its own work on the same reasoning path and finds nothing wrong. Fixed by requiring a genuinely independent skeptic approach that challenges assumptions rather than confirming them.
- Mid-task tier discovery: SOLO task expands to multi-file scope mid-implementation with no upgrade path. Fixed by the explicit constraint to surface tier changes and re-calibrate before continuing rather than silently overrunning.
- Loop-until-dry premature exit: discovery scan stopped after a fixed number of iterations while new items remained. Fixed by requiring the termination condition to be evidence-based — a complete pass with zero new findings.
