---
schema: "kit/1.0"
slug: "refactor"
title: "Refactor — restructure without changing behaviour"
summary: "Improve structure, readability or maintainability without changing observable behaviour: understand the code and its callers, put a green baseline test net under it (fanned out one agent per module), restructure in small committed increments (multi-file work through parallel-build), then verify and finish the branch. Use for clean up this code, restructure, reorganize, extract the duplication, split this file, rename across the codebase, pay down technical debt."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "refactor",
    "clean up",
    "clean this up",
    "restructure",
    "reorganize",
    "simplify",
    "tidy up",
    "extract",
    "deduplicate",
    "remove duplication",
    "split this file",
    "rename",
    "technical debt",
    "make this more readable",
    "without changing behaviour",
  ]
antiTriggers:
  [
    "add a feature",
    "new feature",
    "implement",
    "bug",
    "broken",
    "crash",
    "fix the bug",
    "why is it failing",
    "review only",
    "plan only",
    "rewrite from scratch",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    [0] Understand — one step, but its exploration is read-only and fans out INSIDE the step: one agent per module in scope (callers, tests, docs, blame). No writes, so no leases.
    [1] Baseline tests — barrier: nothing is restructured until the safety net is green. Internally parallel, one agent per module, because baseline test files are disjoint.
    [2] Refactor — barrier on the baseline. Multi-file restructuring is parallel INSIDE the step via parallel-build/ORCA: disjoint writes run concurrently, shared files serialise.
    [3] Verify — verification barrier after every write it verifies; the whole-tree command runs once, then the branch is closed.
params:
  integration_branch:
    {
      type: "string",
      default: "develop",
      description: "Branch the finished refactor is merged into before the branch and worktree are deleted.",
    }
  baseline_agent_model:
    {
      type: "string",
      default: "sonnet",
      description: "Model for the per-module baseline-test agents in step 2. Escalate the MODEL, not the effort, when a module's baseline fails twice.",
    }
---

# Refactor — restructure without changing behaviour

> A refactor is only safe if a test can tell you the behaviour did not move.
> Write that test first, restructure in committed increments, finish the branch.

## Goal

Improve code structure, readability or maintainability without changing
observable behaviour — and leave the change proven, committed per concern, and
merged.

## When to Use

- Code is hard to understand or maintain
- Duplication needs extraction
- Module boundaries need adjustment
- Technical debt cleanup
- A rename has to reach every call site

## When NOT to use

- The change alters what the code DOES — that is a feature (`feature`) or a fix (`debug`).
- The behaviour is unknown because it is broken — diagnose with `debug` first.
- Only a review or a plan was asked for — `code-review` / `implementation-plan`.
- The code has no callers and no tests and is about to be deleted — delete it.

## Steps

### 1. Understand

out: {"type":"object","properties":{"modules":{"type":"array","items":{"type":"string"}},"callers":{"type":"array","items":{"type":"string"}},"invariants":{"type":"array","items":{"type":"string"}},"multi_file":{"type":"boolean"}}}
**Done when:** The modules in scope, their callers, and the invariants that must not move are listed, and the change is classified single-file or multi-file.

Read the code being refactored. Identify all callers and dependents, including
the ones a compiler cannot see: strings, dynamic dispatch, config, docs, tests.
Fan out one read-only agent per module — callers, existing tests, doc headers,
recent blame — and merge their findings.

Understand why the current structure exists before removing it; a shape that
looks accidental is sometimes load-bearing. Name the observable behaviour
contract in one sentence. That sentence is what step 2 tests and step 4 proves.

### 2. Baseline Tests

model: {{baseline_agent_model}}
**Done when:** Every module in scope has tests over the preserved behaviour, run green against UNMODIFIED code, with the run recorded.

Ensure tests cover the behaviour being preserved. Where they are missing, write
them first — a refactor without a safety net is a rewrite with optimism.

When several modules need baselines, fan out one agent per module; the test
files are disjoint, so they need no serialisation.

These are characterisation tests: they capture what the code OBSERVABLY does
today, warts included. A baseline asserting what the code _should_ do is a
feature request wearing a test's clothes. Run each once against the untouched
code and watch it pass — a baseline that never ran green before the edit proves
nothing afterwards.

### 3. Refactor

**Done when:** Every increment is its own commit with that module's tests green, and no commit mixes a structural change with a behaviour change.

Apply structural changes in small increments. Run the affected tests after each
one. One concern per commit; stage only that increment's files and read
`git diff --cached --stat` before committing. Update JSDoc and doc headers to
match the new structure in the same commit that moves the code.

Multi-file restructuring runs through the `parallel-build` recipe: edit-units
with disjoint `writes`, drafted in parallel, applied per-file-serialised, one
commit per unit. Single-file work stays inline with a two-line plan.

A behaviour change discovered mid-refactor is never smuggled in. Small and
obviously right → its own separate commit, labelled as a fix. Anything larger →
a bookmark in the ledger. Naming and placement choices are rulings you log
(`Ruling: <what> — <why> — <cost if wrong>`), not questions you stop for.

### 4. Verify

**Done when:** The full suite is green in output you ran yourself, the old names return no hits, and the closing line states "merged into {{integration_branch}}, branch deleted" or the exact blocker.

Run the full test suite once on the whole tree. Swallow the passing output;
surface only failures. After every rename, grep the old name across code, tests,
docs and config to catch the call sites the type checker cannot.

Exercise runtime-only paths as the user would — the served output or the real
CLI, never source inspection. Source present is not behaviour observed; if the
artifact was edited but not rebuilt, say "written, not running".

Then close the branch with the `finish-branch` recipe: integration verify → doc
currency → merge into {{integration_branch}} → prove redundancy before deleting →
delete branch and worktree → state the status line. Never ask about pushing.

## Constraints

- No behaviour changes. A bug found while refactoring becomes a separate commit or a bookmark — never folded into a structural commit.
- Keep changes reviewable: small diffs, one concern per commit, clear purpose.
- Documentation that references restructured code is updated in the SAME run, not queued.
- Stage only the increment's files. Never stage the whole tree; a dirty repository will commit work you did not write.
- Never bypass commit hooks.
- After the scope is agreed, implementation-detail choices are rulings you log, not questions. Only four things stop the run: an irreversible operation, a security-sensitive action, a side effect outside the worktree, or a scope so broken every path is a guess.
- Composition: multi-file writes → `parallel-build`; evidence for any claim → `verification-gate`; branch closure → `finish-branch`.

## Safety Notes

- Renaming functions used across files can break upstream merges — fork-renamed functions get overwritten by `--theirs` resolution.
- Track renames in `FORK_PATCHES.md` so the merge guardian can detect regressions.
- After renaming, grep for the old name to catch all call sites.
- Never destroy uncommitted work to tidy a branch. Snapshot a dirty worktree first and say where the snapshot is.
- Files a live dev server watches are assembled off-tree and landed in ONE burst, so an open page reloads once on the finished state.
- Prove a branch is redundant before deleting it: its tip is an ancestor of the integration branch, or the same patch landed under another SHA, or the integration branch deliberately superseded it.

## Failures Overcome

- **Behaviour change sneaked in:** an agent "improved" error handling during a refactor, changing behaviour. Strict separation of refactor commits from fix commits prevents this.
- **Upstream merge collision:** the fork renamed `shouldSuppressHeartbeatBroadcast()` to `shouldHideHeartbeatChatOutput()`. An upstream merge brought the old name back at 3 call sites, causing silent failures. Renames must be tracked.
- **2026-08-16 — a merge driver ate branch work with no conflict:** files under a custom merge driver silently lost the branch's changes. The only tell is a diffstat that SHRINKS, so compare diffstats across the merge and prefer `--ff-only`.
- **2026-08-31 — staging a dirty file committed 918 unrelated insertions:** staging is file-granular, so an 80-line refactor carried another session's work. Read the staged diffstat before every commit.
- **2026-08-24 — a green "committed" summary hid an unmerged branch:** committing is not done. The run ends with the merge/delete status stated explicitly or it has not ended.
- **2026-09-02 — v1.1.0:** migrated from the `recipe/1.0` schema to `kit/1.0`; the four steps and every safety note are preserved. Added the per-module baseline fan-out, the `parallel-build` route for multi-file work, the bookmark rule for behaviour changes found mid-refactor, and the `finish-branch` closure — per the architect's instruction to front-load questions, parallelise everything independent, and end merged rather than committed.
