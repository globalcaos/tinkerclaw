---
schema: "kit/1.0"
slug: "dispatch-parallel"
title: "Dispatch Parallel Agents"
summary: "Fan out 2+ independent tasks concurrently; barrier on shared-state boundaries; serialize writes to shared files."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "parallel",
    "concurrent",
    "fan-out",
    "dispatch",
    "subagent",
    "multi-task",
    "independent",
    "at the same time",
    "simultaneously",
    "split the work",
    "operations",
    "speed",
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
    The recipe steps themselves are fully serial — each step is a prerequisite for the next. The parallelism this recipe MANAGES lives inside step 2: the user's tasks are fanned out concurrently within that single step. Steps 0 (partition) and 2 (barrier) are the guards that make that internal fan-out safe.
---

# Dispatch Parallel Agents

> Fan out 2+ independent tasks concurrently; barrier on shared-state boundaries; serialize writes to shared files.

## Goal

Execute independent tasks concurrently to minimize wall-clock time while preventing write collisions and data-race failures.

## When to Use

- 2 or more tasks have no shared output files or shared state
- Tasks operate on distinct modules, files, or external services
- A downstream stage needs all prior results before it can start and you want to minimize the wait
- You have already confirmed write-scope ownership — do NOT use this recipe as the tool that discovers ownership

## Steps

### 1. Partition tasks by write-scope and dependency

**Tools:** Read, Bash
**Done when:** Every task has an explicit, non-overlapping list of files/modules it writes; any task that reads the output of another task is in a later serial slot; the partition is written down (even as inline comments) before any dispatch begins

List all tasks and the exact paths each one writes. Two tasks that write the same path must share a serial slot — they cannot be parallel. Draw the dependency edges: if task B reads task A's output, B is downstream and must wait. A read-only task never blocks a peer but still belongs in a defined slot. Abort and redesign if write scopes overlap.

### 2. Dispatch independent groups concurrently

**Tools:** Bash, Task
**Done when:** All tasks in the current parallel group have been dispatched in a single message turn (or via a single background-job batch); each dispatch includes only that task's own context slice; a record of which task maps to which job exists before waiting begins

Dispatch every task in the parallel group simultaneously — not sequentially. Pass each subagent only the context it needs; no shared mutable objects, no shared temp paths. If using background Bash jobs, capture handles in an array before the first wait call. If using Task tool, issue all Task calls in one message turn. Never fire-and-forget a batch without first recording what was fired.

### 3. Barrier: verify disk state before continuing

**Tools:** Bash, Read
**Done when:** Every dispatched task has a confirmed on-disk artefact (output file present, or git log shows the expected commit); git status --short is inspected in every touched repo; no task is silently missing

Wait for all in-flight tasks then check disk state — not just text reports. A subagent that exits with empty stdout may have already written files; a subagent that reports success may have committed nothing. Run git status and git log --oneline -3 in each touched repo. If any expected artefact is absent or any repo is dirty in an unexpected way, treat it as a blocking failure before proceeding.

### 4. Serialize writes to shared files

**Tools:** Edit, Write, Bash
**Done when:** Each shared file has been updated exactly once in a single serial pass; no two patches applied simultaneously; JSON stores written via atomic temp-file-rename (not direct writeFileSync)

Apply all post-parallel changes to shared files in a single serial pass — never merge two subagent patches to the same file at the same time. For JSON stores, use an atomic read-modify-write with temp-file-rename, never a direct overwrite of a possibly-stale snapshot. If a shared file was written by a subagent directly, read it fresh before applying any further patch.

### 5. Verify end state and close orphans

**Tools:** Bash, Read
**Done when:** git status --short is empty in every touched repo (no untracked files, no unstaged changes); every expected output artefact is present and non-empty; any WIP files are explicitly flagged to the user, not silently left

Run git status --short in every repo touched by any task. Confirm each task's output artefact exists, is non-empty, and is coherent with its spec. Untracked files you did not author must be flagged with path, mtime, and a one-line guess at origin — do not sweep silently and do not ignore. A clean tree is the invariant before claiming done.

## Constraints

- Never dispatch two tasks that write the same file in the same parallel group — this must be verified in step 0 before any dispatch, not discovered after a collision
- Record all dispatched jobs/tasks before waiting — fire-and-forget without a collection plan makes the barrier step impossible
- Treat a missing expected artefact or an unexpected dirty file as a blocking failure at the barrier step; do not proceed assuming partial success
- Pass each subagent only its own context slice — no shared mutable state, no shared temp files across agents
- A subagent's text report is a SUMMARY, not ground truth — disk state (git status, file presence) is the authoritative source

## Safety Notes

- A subagent that exits non-zero with empty stdout may have already written or committed files — always run git status after any dispatch regardless of reported exit status
- Do not apply two subagent patches to the same JSON store simultaneously; use atomic temp-file-rename (read-modify-write inside a mutator) to avoid silent clobbers from stale snapshots
- Never claim a parallel run succeeded until the barrier step has confirmed disk state — a text report of success from a subagent is not sufficient evidence

## Failures Overcome

- Write collision: two agents patch the same file simultaneously and produce a corrupted or partially-applied result. Prevented by the partition step enforcing single-owner write scopes before any dispatch begins.
- Silent partial completion: one subagent exits non-zero but the orchestrator proceeds assuming all succeeded, leaving the system half-applied. Prevented by the barrier step requiring confirmed on-disk artefacts (not just text reports) from every task before continuing.
- Fire-and-forget without collection: tasks are dispatched but no record of which jobs were launched is kept, making it impossible to wait for all of them. Prevented by the rule that dispatch records must exist before the first wait call.
- Over-parallelising a dependency chain: an agent fans out reproduce, diagnose, and fix believing they are independent, but fix reads diagnose's output. Partition step forces drawing dependency edges first, exposing the serial chain before dispatch.
- Stale-snapshot clobber: a subagent reads a JSON store, holds the snapshot in memory, does work, then writes it back — overwriting changes another subagent committed in the meantime. Prevented by requiring atomic read-modify-write via temp-file-rename for all shared JSON stores.
- Orphan artefacts: a subagent writes files then exits without committing; a later session finds an inconsistent working tree. Prevented by the verify step requiring git status --short to be clean across all touched repos before claiming done.
