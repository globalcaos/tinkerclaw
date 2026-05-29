---
schema: "kit/1.0"
slug: "execute-plan"
title: "Execute an Implementation Plan"
summary: "Execute a written multi-step plan one step at a time: mark in-progress, do exactly that step, verify with evidence, commit, then advance or stop on blocker."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "coding",
    "execute-plan",
    "implement",
    "step-by-step",
    "multi-step",
    "plan-execution",
    "subagent",
    "tasks",
    "writing-plans-output",
    "ship",
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
    Fully serial by data dependency. Step 0 (Load) must complete before step 1 (Execute) knows which step to run. Step 1 must produce output before step 2 (Verify) has anything to test. Step 2 must produce verification evidence before step 3 (Checkpoint) can record it. Step 3 must produce a clean git state before step 4 (Advance) can safely mark the next step in_progress. No pair can be parallelized without producing unverified steps, orphan files, or skipped checkpoints.
---

# Execute an Implementation Plan

> Execute a written multi-step plan one step at a time: mark in-progress, do exactly that step, verify with evidence, commit, then advance or stop on blocker.

## Goal

Execute a written multi-step plan with per-step in-progress marking, scope-locked execution, evidence-backed verification, and clean-checkpoint commits — one step at a time, fully auditable and resumable after a restart.

## When to Use

- A plan file with 2+ numbered steps exists and needs execution
- User says 'execute the plan', 'implement step by step', 'work through the tasks', or 'resume the plan'
- A writing-plans or spec session has produced a plan file and now needs an execution agent
- Resuming a partially-executed plan after a session restart — completed steps have commit SHAs in the plan file, incomplete ones do not
- A subagent-driven-development workflow needs a single-thread fallback for plans with tight sequential dependencies

## Steps

### 1. Load Plan and Mark Step In-Progress

**Tools:** read, glob, prefrontal.plan.step
**Done when:** Plan file confirmed to exist with a current mtime (not stale vs repo HEAD), first incomplete step number and title are known, prefrontal.plan.step status set to in_progress returns without error — before any file is touched.

Glob or read the plan file from the path given; if not given, search for a \*-plan.md or PLAN.md in the repo root and docs/plans/. Verify its mtime is newer than or equal to the most recent commit it references — a plan written against old code causes drift. Identify the first step whose status is not done/skipped. Call prefrontal.plan.step (or equivalent tracker) to mark it in_progress. This mark is the social contract; it MUST precede any code or file change.

### 2. Execute Exactly That Step

**Tools:** read, glob, bash, edit, write
**Done when:** git diff --stat shows only files named or implied by this step's description; no other files modified; deliverable artifact or code change exists on disk.

Do exactly what this step says — no more. Do not fix adjacent issues, refactor bystander code, or absorb the next step. If the step description is ambiguous, apply the narrowest reasonable interpretation and record the interpretation chosen (one sentence appended to the plan step) before executing. Scope is enforced by checking git diff --stat at the end of this step: any file outside the step's stated scope is a red flag, not a bonus.

### 3. Verify Step Completion

**Tools:** bash, read
**Done when:** Verification command exits 0 and its pass line (or artifact path + size) is recorded verbatim in the plan step note; git status shows no untracked files.

Run the step's own verify command if the plan specifies one. If absent, run the most targeted test suite or lint covering the changed files — name the proxy explicitly so the user can audit the coverage decision. Record the exact command run and its stdout pass line (not a hash, not a summary) as a note on the step. Then run git status: any untracked file not committed by this step is an orphan — either commit it or explicitly flag it as WIP before proceeding.

### 4. Checkpoint — Commit and Update Plan

**Tools:** bash, edit
**Done when:** git log --oneline -1 shows a new commit whose message cites the plan step number; plan file step row updated with done status and commit SHA; git status is clean.

Stage only the files this step touched (named paths, not git add -A). Commit with a message of the form 'plan step N: <step title> (<plan-slug>)'. Then edit the plan file to mark this step done and append the commit SHA inline. A clean git status is the hard exit criterion — no committed step leaves orphan files or unstaged hunks.

### 5. Advance or Surface Blocker

**Tools:** read, write, prefrontal.plan.step
**Done when:** Either: next step is marked in_progress and execution loops to step 2 — OR — blocker note written to plan file with blocked step number, missing dependency, and decision needed; user notified with those three fields.

If remaining steps exist and no blocker was hit, mark the next step in_progress and return to step 2 immediately. If execution hit a blocker (missing dependency, ambiguous external API, failing service, spec contradiction), STOP: write a one-paragraph blocker note to the plan file naming (1) the blocked step number, (2) the exact missing thing, (3) the decision or input needed from the user. Never improvise scope to route around a blocker — surface it and halt.

## Constraints

- One step in_progress at a time — never mark two steps in_progress simultaneously
- Scope is exactly the current step — no absorbing adjacent steps even if they look trivial
- git add by named path only — never git add -A or git add . which risks committing unrelated files or secrets
- Do not push to remote without explicit user instruction
- Blockers stop execution immediately — no scope improvisation to route around them
- git status must be clean (zero untracked, zero unstaged) before every checkpoint commit
- Never self-resolve the plan as complete — user deletion of the final step or explicit sign-off is the verified-done signal

## Safety Notes

- Verify the plan file mtime is current before starting — executing a plan written against old code causes silent drift between spec and reality
- If a step's verify command is absent from the plan, name the proxy test used so the user can audit what coverage was assumed
- If the plan file references external services (APIs, DBs, CI), confirm they are reachable before marking a step in_progress — a mid-step connectivity failure leaves partial changes in an unverified state
- Never auto-publish, auto-push, or auto-deploy as a side effect of a plan step unless the step description explicitly says to do so

## Failures Overcome

- Scope creep mid-step: agent fixes an adjacent issue 'while in the file', muddies the commit, breaks the audit trail. Prevented by the exact-step-only rule in Execute and the git diff --stat scope check before moving to Verify.
- Silent blocker bypass: agent cannot satisfy a dependency so silently substitutes a simpler implementation and continues. Prevented by the hard-stop rule in Advance — blockers are named with step number + missing thing + decision needed, never routed around.
- Orphan files at session end: agent produces output but skips the commit step. Prevented by requiring a clean git status as the hard exit criterion of every Checkpoint — untracked files are caught here, not later.
- Lost checkpoint context across restarts: agent re-executes already-done steps because the plan file has no record. Prevented by appending the commit SHA to the plan step at every Checkpoint, making completed steps unambiguously detectable on resume.
- Stale plan execution: agent runs a plan written against an older codebase version, producing changes that conflict with work done since. Prevented by the mtime-vs-HEAD check in Load before any execution begins.
- Ambiguity-driven wrong scope: step description is underspecified, agent picks the widest interpretation and touches more files than intended. Prevented by the narrowest-interpretation rule in Execute plus recording the interpretation chosen before acting, so the user can correct it before the next step.
- Unverifiable done-when: agent marks a step done based on 'it looks right' without running any check. Prevented by requiring the exact verification command and its stdout pass line to be recorded in the plan step note — no evidence, no done.
