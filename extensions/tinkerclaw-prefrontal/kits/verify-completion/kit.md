---
schema: "kit/1.0"
slug: "verify-completion"
title: "Verification Before Completion"
summary: "Never claim done/fixed/passing without running the verification command and confirming output — evidence before assertions."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "verify",
    "verify-completion",
    "before-claiming-done",
    "evidence-required",
    "verification-gate",
    "fixed",
    "tests-pass",
    "regression",
    "shipping",
    "resolved",
    "quality",
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
    Fully serial data-dependency chain. Step 0 (confirm fix) must be observed first — without it, suite results in step 1 are unanchored. Step 2 (runtime path) requires the build to be current and the suite to be clean, so it follows step 1. Step 3 (orphan check) is the final gate and closes after all artifacts from prior steps exist on disk. No two steps can run in parallel without producing misleading signals.
---

# Verification Before Completion

> Never claim done/fixed/passing without running the verification command and confirming output — evidence before assertions.

## Goal

Enforce evidence-before-assertions discipline: an agent must run and observe every verification command and capture actual output before making any completion claim.

## When to Use

- About to write 'done', 'fixed', 'resolved', or 'passing' in any reply
- Before committing a fix and marking a Control Panel task resolved
- Before creating a PR or pushing to a shared branch
- After any subagent or parallel agent dispatch — verify git state and runtime behavior before trusting the subagent's prose report
- When the user asks 'is it fixed?', 'does it work?', or 'is it ready?'
- When a CI run passes remotely but local behavior has not been confirmed

## Steps

### 1. Confirm the exact failure case is now resolved

**Tools:** Bash
**Done when:** The single narrowest command that reproduces the original failure now exits 0 (or returns the expected output) — actual terminal output pasted, not assumed.

Identify the precise command: the failing test ID, the curl that returned the wrong status, the script invocation that panicked. Run it against the actual changed code. If the output is not what the fix promised, stop — the fix is not done. Paste verbatim output before moving on.

### 2. Run the full merge-gate suite for regressions

**Tools:** Bash
**Done when:** Project-level test suite / lint / type-check exits 0 with zero new failures versus the pre-fix baseline — exit code and any new failure names recorded.

Run whatever the project treats as its merge gate (e.g. `pnpm test`, `pytest`, `go test ./...`, `tsc --noEmit`). A green targeted case that breaks a neighbor is not done. Record exit code and diff of failures vs baseline. If no suite exists, document that explicitly.

### 3. Exercise the real runtime or user-facing path

**Tools:** Bash, WebFetch
**Done when:** The observable user-facing outcome (HTTP status, UI state, log line, WA message, cron output) matches the requirement — screenshot or log excerpt captured as evidence.

'Tests pass' is not 'works for the user'. Start the server/gateway (verify the running binary reflects the current build — check dist/ mtime vs last build), then trigger the actual path: API call, browser action, WA message, cron fire. For HTTP endpoints use WebFetch. If the path cannot be triggered programmatically, state what proxy was used and why it is sufficient.

### 4. Assert no orphan or unstaged artifacts

**Tools:** Bash
**Done when:** `git status --short` is empty (or every changed file is intentionally staged/committed) in every repo touched during the fix.

Run `git status --short` in every repo touched. Untracked or unstaged files are orphans — commit, stash, or flag them with path + mtime + origin before claiming done. A clean working tree is a hard exit condition. Multiple parallel agent sessions may have written files to the same worktree; do not assume the tree is clean because you did not write to it.

## Constraints

- Never write 'done', 'fixed', 'passing', or 'resolved' before all four steps complete with evidence in hand
- 'Tests pass' is not 'works for the user' — both are required
- For gateway/runtime changes: confirm dist/ mtime is newer than the last source edit before running step 2; a stale binary silently invalidates all runtime evidence
- If a verification command is unavailable, say so explicitly with the reason — do not silently substitute a plausible-sounding proxy
- Subagent prose reports are summaries, not evidence — run step 0 locally even if the subagent claims success

## Safety Notes

- Do not restart the gateway as the verification step — restart reloads dist/, which is stale if build was skipped; build first, then restart, then verify
- A passing CI badge on a remote branch is not local verification — run against the actual working-tree change
- If the runtime path cannot be triggered automatically, mark it 'manual-verify-needed' and surface it to the user; do not silently omit the step

## Failures Overcome

- **Premature 'done' claim (amazon-shopper pattern):** Fix ships, targeted test passes, agent marks resolved — real user path never triggered. Marked done 3 times while broken in real use. Step 2 (runtime scenario) is the explicit antidote; it is not optional even when tests are green.
- **Stale binary illusion:** Fix applied to source, suite run against a cached dist/ predating the change, everything 'passes'. Caught by checking dist/ mtime vs last source edit before step 2 executes — not by git status alone.
- **Adjacent regression blindness:** Targeted fix silences the reported failure but breaks a neighboring test. Step 1 (full suite) is mandatory precisely to catch this; running only the failing test ID is insufficient.
- **Subagent false-done report:** Subagent exits 1 with empty stdout but had already written files and modified handlers before dying; parent agent trusts the prose report and re-dispatches, colliding with prior work. Step 3 (git status in every touched repo) catches this before any completion claim.
