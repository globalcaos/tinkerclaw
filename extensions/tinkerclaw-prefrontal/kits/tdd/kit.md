---
schema: "kit/1.0"
slug: "tdd"
title: "Test-Driven Development"
summary: "RED→GREEN→REFACTOR, one behaviour per cycle: failing test pins the contract, minimum code turns it green, refactor cleans without touching the contract, commit seals the unit."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "tdd",
    "test-driven",
    "test",
    "failing test",
    "unit test",
    "red green refactor",
    "write test first",
    "pin contract",
    "regression",
    "coding",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-baked-cc-recipe"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
  notes: |
    Fully serial data-dependency chain. Step 0 (RED) must produce a runner-confirmed failing assertion before step 1 (GREEN) can begin. Step 1 must produce a fully green suite before step 2 (REFACTOR) starts — refactoring a red codebase is undefined. Step 3 (COMMIT) requires both GREEN and REFACTOR complete and the suite still green.
---

# Test-Driven Development

> RED→GREEN→REFACTOR, one behaviour per cycle: failing test pins the contract, minimum code turns it green, refactor cleans without touching the contract, commit seals the unit.

## Goal

Implement exactly one behaviour per cycle: write a failing test that would pass only when the behaviour is correct, write the minimum code to make it pass, refactor structure without touching behaviour, then commit test + implementation as one logical unit.

## When to Use

- Adding a new function, method, or module where the expected output is knowable before writing code
- Fixing a bug — the failing reproduction test must be committed before the patch lands
- Hardening a behaviour that has regressed more than once
- Pinning an API contract before refactoring its implementation
- Any case where you need a verifiable definition of done that is checked by the machine, not by eye

## Steps

### 1. Write the failing test (RED)

**Tools:** Read, Edit, Write, Bash
**Done when:** Test runner exits non-zero; the failure message cites the expected-vs-actual assertion for the behaviour under test — not a TypeError, ImportError, missing mock, or syntax error; no other test newly fails

Identify the single behaviour to pin and write the smallest test whose only path to green is the correct implementation. Run the full suite and read the failure output. A wrong-layer failure (compile error, import missing, mock not found) means the test scaffolding is broken — fix it before calling this step done. A test that passes immediately was wrong to begin with: invert the assertion to confirm it can fail, then restore it.

### 2. Write minimum code to pass (GREEN)

**Tools:** Edit, Write, Bash
**Done when:** The new test exits green; full suite exit code is zero; no test that was green before this step is now red

Write only the code that makes the specific failing test pass — no extra branches, no edge-case handling not yet covered by a test, no anticipatory abstractions. Run the full suite, not just the new test. A newly red test means the implementation has a side effect; resolve it before moving on. Temptation to also fix nearby code belongs in the refactor step, not here.

### 3. Refactor with test suite as safety net

**Tools:** Read, Edit, Bash
**Done when:** All tests that were green after step 2 are still green; no new test added; commit-ready diff contains only structural changes (rename, extract, dedup) with zero semantic delta

Improve naming, remove duplication, apply structural patterns. Run the suite after every non-trivial edit — not at the end of a batch of edits. If any test goes red during refactor, revert the last edit immediately: a red test during refactor means behaviour changed, not just structure. Do not add new logic or handle new cases in this step; open a new TDD cycle for that.

### 4. Commit the RED-GREEN-REFACTOR unit

**Tools:** Bash
**Done when:** Commit recorded; git status shows no untracked or modified files; commit message names the behaviour pinned (not the mechanics); test file and implementation file appear together in the diff

Stage test and implementation files together so the commit is self-evidently correct — a commit containing only an implementation with no test, or only a test with no implementation, is a broken unit. Commit message format: 'feat|fix|refactor: <behaviour> [not <file changed>]'. One behaviour per commit; if you ran multiple TDD cycles, make one commit per cycle, not one squash.

## Constraints

- One behaviour per TDD cycle — never write a second failing test before the first is green and committed
- No implementation code before a confirmed red test — confirmed means the runner exited non-zero with an assertion failure, not a build error
- GREEN step: minimum code only — no logic not demanded by the current failing test
- REFACTOR step: zero behaviour change — suite must stay green after every individual edit, not just at the end
- Do not skip RED confirmation — a test that passes on first run was written incorrectly
- Do not merge cycles — if a refactor reveals a new behaviour to implement, open a new cycle rather than expanding the current one

## Safety Notes

- If the failing test errors on import, compile, or missing mock rather than on an assertion, fix the test harness before proceeding — going GREEN on a broken test gives false confidence with zero contract value
- Validate that inverting the implementation actually makes the test fail: a test that passes regardless of the implementation (swallows all exceptions, asserts True, checks the wrong symbol) provides no regression guard
- Do not refactor and add logic in the same step — if you need both, finish refactor, commit, then open a new RED cycle for the new logic
- Run the FULL suite at the end of each step, not just the new test — silent regressions in unrelated tests are the most expensive failures to diagnose later

## Failures Overcome

- Implementation-first drift: agent writes the feature then retrofits tests that confirm existing behaviour rather than pin a contract. Hard gate: GREEN step cannot begin without a runner-confirmed non-zero exit on an assertion failure.
- Always-green test trap: agent writes a test that passes even when the implementation is wrong (catches all exceptions, wrong symbol, trivially true assertion). Mitigation: invert-the-assertion check at the end of step 1 before calling RED done.
- Over-broad GREEN step: agent implements full feature surface — edge cases, error paths, config options — before any test covers those paths, producing untested code mass. Minimum-code rule blocks this; untested paths belong in future RED cycles.
- Refactor-introduces-regression: agent restructures code in a batch and silently breaks a side-effecting detail. Run-after-every-edit rule (not run-at-end) catches this before the blast radius grows.
- Behaviour-bundling: agent writes two or more failing tests before going green on any of them, making the GREEN step ambiguous and the commit non-atomic. One-behaviour-per-cycle constraint prevents this.
- Test-names-mechanics not behaviour: commit message or test name describes the file changed ('update parser.ts') rather than the behaviour pinned ('parseAmount rejects non-numeric strings'), making the test useless as documentation. Commit message rule in step 4 enforces behaviour-level naming.
