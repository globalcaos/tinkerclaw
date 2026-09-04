---
schema: "kit/1.0"
slug: "debug"
title: "Debug — reproduce, prove the root cause, fix once"
summary: "Systematic debugging for a bug, error, crash, test failure or regression: reproduce it as a failing test, gather evidence from disk, served output and the rendered surface, fan out one agent per live hypothesis, name the root cause as file:line, then fix minimally with the prevention in the same act. Includes an emergency stop after two failed fixes so the run escalates instead of guessing again."
version: "2.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "debug"
tags:
  [
    "bug",
    "debug",
    "error",
    "crash",
    "broken",
    "not working",
    "fails",
    "exception",
    "fix",
    "regression",
    "test failure",
    "stack trace",
    "flaky",
    "it worked before",
    "why is this happening",
    "root cause",
    "still broken",
  ]
antiTriggers:
  ["new feature", "add a feature", "build me", "refactor", "plan only", "review only", "rename"]
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
    - [6]
  notes: |
    Step 1 (reproduce) is a barrier — everything downstream is guessing until the failure is captured.
    Step 2 (evidence) is one sweep by the orchestrator; its findings scope the hypotheses.
    Step 3 (hypotheses) FANS OUT — one cheap subagent per live hypothesis, each proving or disproving it with a command; the step ends when their verdicts return.
    Step 4 (root cause) is a barrier: a single named mechanism, or back to step 3.
    Step 5 (fix + prevention) writes code — serial, one concern.
    Step 6 (verify) is a barrier after the write it verifies.
    Step 7 (emergency stop) is conditional: it runs only when step 5 has failed twice.
params:
  hypothesis_model:
    {
      type: "string",
      default: "haiku",
      description: "Model for each hypothesis leg in step 3 — these are cheap prove/disprove errands, so fan out wide rather than deep.",
    }
  escalation_model:
    {
      type: "string",
      default: "opus",
      description: "Model the emergency stop escalates to before any further edit. Escalate MODEL before effort; re-running the same model into the same dead end is not an attempt.",
    }
  max_fix_attempts:
    {
      type: "string",
      default: "2",
      description: "Failed fixes allowed before step 7 fires. Two wrong fixes means the diagnosis is wrong, not the patch.",
    }
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where the debug note is written so a resumed session reads state instead of re-deriving it.",
    }
---

# Debug — reproduce, prove the root cause, fix once

> No code change without a confirmed root cause. Two failed fixes is a stop,
> not a third attempt.

## Goal

Find why something is actually broken, fix it once, and leave behind a guard
that catches the same bug class next time.

## When to Use

- An error, crash, exception or stack trace
- A failing or flaky test
- A regression: it worked before and does not now
- Behaviour that contradicts what the code appears to say

## When NOT to use

- The change is a new capability, not a defect — use `feature`.
- The code works and you want it cleaner — use `refactor`.
- You already know the one-line cause and the fix is a typo — just fix it,
  then add the guard.

## Steps

### 1. Reproduce

**Done when:** A command or test fails on demand, and fails for the reason the report describes.

Capture the failure as a FAILING TEST wherever possible — the test is both the
reproduction and the regression guard, and it is the check the run is scored
against. Where a test cannot reach it (a live surface, a startup path, an
intermittent race), write the exact command sequence that triggers it and the
observed output. Name the conditions: inputs, environment, timing, who or what
was concurrent. If it will not reproduce, that is the finding — say so and go
to step 2 to learn why, rather than fixing a bug you cannot see fail.

Confirm the test fails for the EXPECTED reason (read the failure message, not
just the red), then COMMIT the failing test on its own before any fix is
written. That commit is the proof the bug existed and the guard that it stays
gone; a fix and its test in one commit can be tuned to each other.

### 2. Gather evidence

**Done when:** Evidence exists for each layer the bug could live in, quoted, not paraphrased.

Walk the ladder and stop guessing at the first contradiction: what is on
DISK (the source), what is in the BUILT artifact, what is SERVED, what is
RENDERED. Grep the built artifact for a symbol the fix introduced AND a
control symbol that must already be there — a hit on neither means you are
reading the wrong file. Read the logs; check blame for a recent regression;
establish whether the data came from stored history or a live source. Separate
**know** (a log line, a command's output) from **assume** (the code looks like
it does X). Assumptions are hypotheses, and belong in step 3.

### 3. Hypotheses

out: {"type":"object","required":["hypothesis","verdict","command","evidence"],"properties":{"hypothesis":{"type":"string"},"verdict":{"type":"string","enum":["proved","disproved","inconclusive"]},"command":{"type":"string"},"evidence":{"type":"string"}}}
**Done when:** Every live hypothesis carries a verdict backed by a command someone else could re-run.

With two or more live hypotheses, fan out — one subagent per hypothesis on
{{hypothesis_model}}, each given the reproduction, the evidence from step 2,
and one job: prove or disprove its own hypothesis with a command, not with
reasoning about the code. Legs run concurrently and do not talk to each other.
Cover distinct layers rather than variations of one idea: code/logic, config
and environment, build cache and stale artifacts, test-harness validity,
upstream contract or data shape. Inconclusive is an honest verdict; a leg that
returns prose instead of a command result has not answered.

### 4. Name the root cause

**Done when:** The cause is stated as `file:line` plus the mechanism that produces the observed symptom.

One sentence, in the form: at `path:line`, X happens, which causes Y, which
is why the user sees Z. If the mechanism cannot be traced end to end from the
cause to the symptom, the cause is not confirmed — return to step 3 with the
gap as the new hypothesis. A layer named without a line is a guess wearing a
lab coat. Where the evidence genuinely cannot close the gap, the correct
output is instrumentation: add the logging that will name the caller next
time, ship that, and say plainly that the patch waits for the next
reproduction.

### 5. Fix, with the prevention in the same act

**Done when:** The smallest change addressing the named cause is applied, together with the check that catches its recurrence.

One concern. No refactoring of the surrounding code, no "while I am here"
improvements, no defensive scaffolding around a one-line bug. Then install
the prevention: the failing test from step 1 becomes the regression guard, or
a lint rule, a structural test, or a runtime assertion with remediation text.
A recurring mistake becomes a mechanism, not a reminder. State explicitly
whether the change is a GUARD (suppresses the symptom) or a CURE (removes the
cause) — both are legitimate, but shipping one while claiming the other is
how the same bug returns a month later.

The fix commit must not touch a test file. If the test fails, fix the code,
not the test; a wrong expectation is corrected in its own commit with a
logged ruling, never inside the fix. Read the staged diff before committing
and reject the commit if a test path is in it.

### 6. Verify as the user would

**Done when:** The step-1 failure passes, the original scenario is re-run end to end, and the suite is green — all seen, not assumed.

Run the failing test: it passes. Re-run the original reproduction on the real
surface — the CLI for a tool, the served page for a web change, the actual
trigger for a runtime bug. Measure rather than eyeball: geometry as numbers,
output diffed against the expectation. Then the full suite, once. Source is
not built is not restarted: if the fix is written but the process still runs
the old artifact, say "written, not running". Swallow success output and
surface only failures. When the fix sits on a branch, finish it with
`finish-branch`; when the bug class deserves broader coverage, hand the
touched modules to `test-hardening`.

### 7. Emergency stop

**Done when:** Either the adversarial pass names a cause the earlier fixes missed, or the run stops and reports with consolidated evidence.

Fires when {{max_fix_attempts}} fixes have failed, or the same symptom returns
after a "fix". Do not attempt a third patch on the same theory. First escalate
to {{escalation_model}} with the verbatim failure output. If that also stalls,
fan out an adversarial root-cause pass — one agent per suspect layer
(code/logic · config, environment, build cache · test-harness validity ·
upstream contract) — each handed every fix already tried and why it failed.
The synthesis must explain the earlier failures BEFORE proposing any edit.
Write the note to `{{plans_dir}}`: symptom, fixes tried, verdicts, what is
still unknown. This pass counts as one attempt; it does not repeat.

## Constraints

- No code change without a confirmed root cause named as `file:line`.
- Fix the cause, not the symptom; do not refactor while debugging.
- One fix per commit; stage only that fix's files.
- Clear caches before rebuilding (`rm -rf dist/.cache node_modules/.cache`) —
  otherwise the "fix" is never in the artifact you test.
- A hypothesis leg reports a command and its output, never an opinion.
- Report evidence honestly: a partial run is never presented as a complete one.

## Safety Notes

- Check every caller before changing a shared function — a leaf with more than
  one caller has more than one chain to guard.
- Do not remove error handling "because it should not happen"; the branch you
  delete is the one that fires in production.
- For ESM or bundler failures, check whether native addons need externalizing
  before theorising about the code.
- Reproduce against a copy when the trigger is destructive; never debug by
  running an irreversible operation on live data.

## Failures Overcome

- **Symptom fix loop:** the visible error is patched without tracing to the
  cause. Fixed by requiring step 4 to name a `file:line` before step 5 begins.
- **Over-engineering the fix:** error handling, validation and comments get
  added around a one-line bug. The anti-goldplating constraint prevents this.
- **Wrong layer debugging:** a contamination bug was patched at the broadcast
  layer three times before the persistence layer turned out to be the cause.
  Always establish whether data comes from stored history or a live source.
- **Cache staleness:** the build uses a cache, so `dist/.cache` and
  `node_modules/.cache` must be cleared or the fix never reaches the artifact
  under test.
- **A green deploy is not a shipped fix (2026-08-29):** a patch landed in one
  copy of a handler while the running extension shipped its own; the build
  stamp matched and the symbol was absent from the whole bundle. Grep the
  artifact for a NEW symbol plus a CONTROL symbol, and locate the live file
  from a log marker rather than from its name.
- **Theorising before the ladder (2026-08-26):** three commands — what is on
  disk, what is served, what is rendered — settle in seconds what code-reading
  argues about for an hour. Run them first; the first contradiction is the bug.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): the failing test is committed on its own before the fix, and the fix commit may not touch a test file.
