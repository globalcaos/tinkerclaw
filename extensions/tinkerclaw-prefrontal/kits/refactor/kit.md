---
schema: "kit/1.0"
slug: "refactor"
title: "Refactor"
summary: "Improve code structure without changing behavior"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["coding", "refactor", "clean up", "restructure", "reorganize", "simplify"]
tools: ["read", "grep", "exec", "edit"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "refactor | clean up | restructure | reorganize | simplify",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: refactor, clean up, restructure, reorganize, simplify",
    },
  ]
---

## Goal

Improve code structure, readability, or maintainability without changing observable behavior.

## When to Use

- Code is hard to understand or maintain
- Duplication needs extraction
- Module boundaries need adjustment
- Technical debt cleanup

## Steps

### 1. Understand

**Tools:** read, grep
**Done when:** Current structure understood, change plan clear

Read the code being refactored. Identify all callers and dependents. Understand why the current structure exists -- it may have reasons that aren't obvious.

### 2. Baseline Tests

**Tools:** exec
**Done when:** Tests exist and pass before any changes

Ensure tests cover the behavior being preserved. If tests don't exist, write them first. The refactor is only safe if you can verify behavior didn't change.

### 3. Refactor

**Tools:** edit
**Done when:** Code restructured, all tests still pass

Apply structural changes in small increments. Run tests after each change. Keep commits granular -- one concern per commit. Update JSDoc headers to reflect new structure.

### 4. Verify

**Tools:** exec
**Done when:** All tests pass, no regressions

Run the full test suite. Check that no callers broke. For runtime-only verification, exercise the affected code paths.

## Constraints

- No behavior changes -- if you find a bug during refactoring, fix it in a separate commit
- Keep changes reviewable -- small diffs, clear purpose
- Update documentation that references restructured code

## Safety Notes

- Renaming functions used across files can break upstream merges (fork-renamed functions get overwritten by `--theirs` resolution)
- Track renames in FORK_PATCHES.md so the merge guardian can detect regressions
- After renaming, grep for the old name to catch all call sites

## Failures Overcome

- **Behavior change sneaked in:** Agent "improved" error handling during a refactor, changing behavior. Strict separation of refactor vs fix commits prevents this.
- **Upstream merge collision:** Fork renamed `shouldSuppressHeartbeatBroadcast()` to `shouldHideHeartbeatChatOutput()`. Upstream merge brought back old name at 3 call sites, causing silent failures. Renames must be tracked.
