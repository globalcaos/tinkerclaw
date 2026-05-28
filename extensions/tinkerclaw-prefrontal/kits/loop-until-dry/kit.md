---
schema: "kit/1.0"
slug: "loop-until-dry"
title: "Loop Until Dry (bounded re-sweep)"
summary: "Repeat a fix-and-find sweep a bounded number of times until a pass finds nothing"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["operations", "sweep", "until clean", "keep going", "exhaust", "drain", "iterate"]
tools: ["read", "grep", "glob", "bash"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    NOT A TRUE LOOP. kit-runner.ts executes dispatchGroups with a single for-loop
    and cannot while-loop or re-dispatch a group on a runtime predicate. This kit
    is a FIXED 3-sweep re-pass (plus a baseline). Each sweep is a full
    find-and-fix pass; a later sweep is a deliberate no-op when the prior sweep
    reported "dry". Steps run sequentially (one group each) so each sweep sees the
    prior sweep's effects. To actually loop unboundedly, the parent agent must
    re-invoke this kit — that is the only loop mechanism available.
model:
  provider: "anthropic"
  name: "claude-sonnet-4-6"
  hosting: "cloud API"
---

### 1. Baseline — define "dry"

State the target condition that means DRY (e.g. "grep finds zero matches",
"all tests pass", "no TODO markers remain"). Run the baseline check and record
the starting count. Done-note: "DRY-WHEN: <condition>. BASELINE: <count>".

### 2. Sweep 1 — find and fix

Run the dry-check. For every remaining item, apply the fix. Re-run the check.
Done-note: "SWEEP-1: fixed N, remaining M. STATUS: DRY|WET".

### 3. Sweep 2 — find and fix (no-op if Sweep 1 was DRY)

If the prior done-note said DRY, do nothing and report "skipped (already dry)".
Otherwise repeat the find-and-fix. Done-note: "SWEEP-2: fixed N, remaining M.
STATUS: DRY|WET" or "skipped (already dry)".

### 4. Sweep 3 — final pass + honest residual report

If prior was DRY, report "skipped (already dry)". Otherwise do a final
find-and-fix. Then ALWAYS report the residual: if items remain after 3 sweeps,
state the count and that the bound was hit (re-invoke the kit to continue).
Done-note: "FINAL: remaining M. <DRY | BOUND-HIT: re-invoke to continue>".
