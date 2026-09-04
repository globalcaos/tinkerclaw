---
schema: "kit/1.0"
slug: "test-hardening"
title: "Test hardening — behaviour coverage for a change and its neighbours"
summary: "Fan out one agent per touched module to audit behaviour coverage, write the missing unit tests so the new code stays stable against future additions, and land small obviously-right adjacent fixes as separate commits. Use for add unit tests, improve test coverage, harden this code, make sure this does not regress, cover the edge cases."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "add tests",
    "add unit tests",
    "write tests",
    "test coverage",
    "missing tests",
    "regression tests",
    "harden",
    "test hardening",
    "cover the edge cases",
    "make it stable",
    "does this have tests",
    "flaky test",
  ]
antiTriggers:
  [
    "why is this test failing",
    "fix the build",
    "run the tests",
    "delete the tests",
    "plan only",
    "review only",
    "rewrite the test framework",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
  notes: |
    [0] Scope is a barrier: every later step reads the file list it produces.
    [1] Fans out one read-only auditor per touched module — no writes, so width is free.
    [2] Fans out one test author per module; test files are disjoint, so they run concurrently.
    [3] Adjacent fixes touch source files — routed through ORCA so same-file writes serialise.
    [4] Flake and speed gate is a whole-suite barrier: it must see every test at once.
    [5] Report reads the results of everything above.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where the PLAN file and its rulings/bookmarks ledger live.",
    }
  test_command:
    {
      type: "string",
      default: "pnpm test",
      description: "The repository's full-suite command, used for the baseline and the gate.",
    }
  auditor_model:
    {
      type: "string",
      default: "sonnet",
      description: "Model for the per-module audit and test-authoring agents; cheap and wide beats one deep pass.",
    }
  max_adjacent_fix_lines:
    {
      type: "string",
      default: "20",
      description: "Line budget above which an adjacent improvement becomes a bookmark instead of a commit.",
    }
---

# Test hardening — behaviour coverage for a change and its neighbours

> Enough tests that the next change cannot silently break this one — bounded to
> the diff and one hop out, written as a fan-out, never as a rewrite.

## Goal

Give the change a test suite that holds under future additions: the public
contract, the edge cases, the error paths, and the exact bug class if this
followed a debug run. Improve adjacent code that is obviously wrong, in
separate commits, without turning coverage work into a refactor.

## When to Use

- After `parallel-build` or `debug`, before `verification-gate`.
- Standalone: "add tests for this", "does this have coverage", "harden this".
- When a module keeps breaking on unrelated changes.

## When NOT to use

- A test is failing and you need the cause — that is `debug`.
- The task is restructuring code — that is `refactor` (it calls this after).
- Chasing a line-coverage percentage. Behaviours are the unit here, not lines.

## Steps

### 1. Scope

**Done when:** A written list exists of the touched files plus their direct callers and callees, with everything else named as out of scope, and a baseline runtime for `{{test_command}}`.

Derive the touched files from the diff against the integration branch, or from
the plan's edit-units when a PLAN exists in `{{plans_dir}}`. For each, list the
direct callers and callees — one hop, no further. Nothing else enters scope; a
second hop is how a coverage pass becomes a two-day audit. Record the current
test count and suite runtime so step 5 can detect a speed regression. If this
run follows a debug, record the bug class in one line: the test that guards it
is mandatory, not optional.

### 2. Audit behaviour coverage per module

model: {{auditor_model}}
out: {"type":"object","properties":{"module":{"type":"string"},"contract":{"type":"array","items":{"type":"string"}},"covered":{"type":"array","items":{"type":"string"}},"missing":{"type":"array","items":{"type":"string"}},"adjacent":{"type":"array","items":{"type":"string"}}},"required":["module","contract","missing"]}
**Done when:** Every module in scope has an audit note listing its public contract, the behaviours already covered, the missing ones, and any adjacent fragility — with no test written yet.

One agent per module, read-only, in parallel. Each reads the module and its
existing tests and answers four questions: what does this promise callers, what
is already proven, what is unproven, what nearby code is wrong or fragile.
Missing behaviours are stated as sentences — "returns the cached value when the
fetch times out" — not as function names. Tests that assert internals are
reported as coverage debt, not as coverage. Auditors write nothing but their
note.

### 3. Write the missing tests

model: {{auditor_model}}
**Done when:** Each new test has been observed failing for the right reason and then passing, and every in-scope module is green on its own tests.

One test author per module; test files are disjoint, so this fans out. Test
behaviour through the public surface — real code over mocks, mocking only
process boundaries (network, clock, slow filesystem). One behaviour per test,
named for the behaviour. Where the test guards new behaviour, watch it fail
first and READ the failure message: a test that fails for the wrong reason
proves nothing. For UI, assert measured geometry as numbers rather than
appearance. Fixtures must match reality — a test green against a wrong fixture
is worse than no test.

### 4. Adjacent fixes

**Done when:** Every landed fix is its own commit labelled as adjacent, and every improvement larger than the budget is a bookmark line in the ledger.

An adjacent improvement lands now only if it is obviously right, under
{{max_adjacent_fix_lines}} lines, and changes no interface: fix it, commit it
alone with a `fix(adjacent):` subject, staging only that fix's own files, never
a whole-tree stage. Anything bigger — a rename, a new abstraction, a redesign —
becomes `Bookmark: <what> — <why it matters> — <where>` appended to the ledger
in `{{plans_dir}}`. Silent scope widening is the failure mode this step exists
to prevent. Three similar lines beat a premature abstraction.

### 5. Flake and speed gate

**Done when:** Each new test passes when run alone, `{{test_command}}` passes twice consecutively, and the runtime delta against the step-1 baseline is stated.

Run each new test in isolation, then the whole suite twice. Order dependence,
shared fixtures, real clocks and live network are the usual causes of a test
that passes only in one position. A flaky test is fixed, or quarantined with a
written reason plus a bookmark — never left to pass on a re-run, and never
deleted to reach green. Swallow success output; surface only failures. If the
suite got materially slower, name the tests responsible and either justify or
trim them.

### 6. Report

**Done when:** A prose report exists naming behaviours covered before and after, the tests added, the fixes committed, and the bookmarks left — containing no code.

Coverage is reported in behaviours, not line percentages: what was unproven at
the start of this run and is proven now. List the fix commits by subject, the
bookmarks by their ledger line, and any quarantined test with its reason. State
plainly what remains unproven and why it was left — an honest gap the reader
can act on beats a number that hides it.

## Constraints

- Scope is the diff plus one hop. A second hop needs a new run with new scope.
- Test behaviour through the public contract; asserting internals is debt.
- Never weaken an assertion to reach green — a wrong expectation is corrected
  and logged as `Ruling: <what> — <why> — <cost if wrong>`.
- No new test framework, runner, or dependency introduced by this recipe.
- Fixes and tests never share a commit; fixes are staged file-by-file.
- Never bypass commit hooks; never stage the whole tree.
- Implementation-style choices (naming, fixture shape, mock boundary) are
  rulings the executor makes and logs, never questions to the user.

## Safety Notes

- Auditors get read and grep only; test authors may write test files.
- Quarantine requires a written reason and a bookmark. Deleting a failing test
  to reach green is a data-loss event, not a fix.
- Regenerate snapshots or fixtures only after checking the new output against
  reality; a regenerated fixture blesses whatever the code currently does.
- Never put production data, credentials, or real user records in a fixture.
- Adjacent fixes stay inside the worktree; merging is `finish-branch`'s job.

## Failures Overcome

- **Green against a wrong fixture (2026-08-30):** a screenshot script set its
  own CSS override, so the test photographed a surface the user never sees and
  passed while the bug shipped. Verify the surface, not the thing you added.
- **Eyeballed layout (2026-09-02):** appearance claims made from looking at a
  render instead of measuring. UI assertions carry numbers — geometry from the
  DOM — because a human reads visually and a model does not.
- **Coverage pass becomes a refactor (anti-gold-plating rules, encoded
  2026-09-02):** unbounded "while I'm here" improvements outgrew the change
  they were meant to protect. Hence the one-hop scope, the line budget, and the
  bookmark ledger.
- **Tests written for internals:** they pass, then break on every legitimate
  refactor, and the suite gets deleted rather than fixed. Behaviour only.
- **Flake tolerated (standing rule, encoded 2026-09-02):** "it passes on
  re-run" trains everyone to ignore red. Fix or quarantine, with a reason.
- **The architect's instruction (2026-09-02):** sufficient unit tests so new
  code stays stable against future additions, with fixes added as improvable
  code is found — bounded so the fixes never become the project.
