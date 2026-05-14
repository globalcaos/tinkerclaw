---
schema: "kit/1.0"
slug: "debug"
title: "Debug & Fix"
summary: "Systematic debugging — reproduce, diagnose, fix, verify"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["coding", "bug", "error", "crash", "broken", "not working", "fails", "exception", "fix"]
tools: ["read", "grep", "glob", "exec", "edit"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    DATA-DEPENDENCY CHAIN — fully serial. Reproduce (0) must complete before
    Diagnose (1) can form valid hypotheses. Fix (2) needs the root cause from
    Diagnose. Verify (3) must run after the Fix. Parallelising any pair produces
    incorrect diagnoses or untested fixes. Step index: 0=Reproduce,
    1=Diagnose, 2=Fix, 3=Verify.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "bug | error | crash | broken | not working | fails | exception | fix",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: bug, error, crash, broken, not working, fails, exception, fix",
    },
  ]
---

## Goal

Systematically identify and fix a bug with minimal side effects.

## When to Use

- Error reports from users or logs
- Test failures
- Unexpected behavior
- Crash reports

## Steps

### 1. Reproduce

**Tools:** read, grep, exec
**Done when:** Can describe the exact failure with evidence

Read error logs/messages. Understand what's failing and when. Run the failing case if possible. If the bug is intermittent, identify the conditions that trigger it.

### 2. Diagnose

**Tools:** read, grep, glob
**Done when:** Root cause identified with file:line

Trace the root cause through code. Don't guess -- follow the evidence. Read the actual code path. Check git blame if the regression is recent. For UI issues, add console.log at 5 init stages, rebuild, check last visible log (don't code-read first).

### 3. Fix

**Tools:** edit, write
**Done when:** Minimal code change applied

Apply the smallest fix that addresses the root cause. Don't refactor surrounding code. Don't add "while I'm here" improvements. One concern per change.

### 4. Verify

**Tools:** exec
**Done when:** Tests pass, original error gone

Run the specific test that was failing. Run the broader test suite to check for regressions. For runtime bugs, actually trigger the original scenario.

## Constraints

- Don't fix symptoms -- find the root cause
- Don't refactor while debugging
- One fix per commit
- Clear caches before rebuilding (`rm -rf dist/.cache node_modules/.cache`)

## Safety Notes

- Check if the fix affects other callers before changing a shared function
- Don't remove error handling "because it shouldn't happen"
- For ESM/bundler issues, check if native addons need externalizing

## Failures Overcome

- **Symptom fix loop:** Agent patches the visible error but doesn't trace to root cause. Fixed by requiring the "diagnose" step to name a file:line before "fix" begins.
- **Over-engineering the fix:** Agent adds error handling, validation, and comments around a one-line bug fix. Anti-goldplating rules prevent this.
- **Wrong layer debugging:** Heartbeat contamination was patched at broadcast layer 3 times before discovering the persistence layer was the real cause. Always check if the data comes from stored history vs real-time.
- **Cache staleness:** `pnpm build` uses cache. Must clear dist/.cache and node_modules/.cache before rebuild or the "fix" doesn't take effect.
