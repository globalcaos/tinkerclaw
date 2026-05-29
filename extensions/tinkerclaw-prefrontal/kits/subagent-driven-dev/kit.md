---
schema: "kit/1.0"
slug: "subagent-driven-dev"
title: "Subagent-Driven Development"
summary: "Dispatch plan tasks to subagents serially via stdin-file redirect, verify git truth after every exit, and compensate visibility loss with per-task chat bubbles and Prefrontal trail events."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "coding",
    "subagent",
    "dispatch",
    "execute",
    "implement",
    "tackle",
    "plan-tasks",
    "one-by-one",
    "orchestration",
    "spawn",
    "multi-step",
    "sequential",
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
    FULLY SERIAL — this recipe is a serial loop. Each step has a hard data dependency on the previous: the temp file must exist before dispatch (0→1→2), git verification requires the process to have exited (2→3), the trail event and next-task decision require the verified disk state (3→4). Independent PLAN TASKS are NOT parallelized by this recipe — they share a workdir, and a parallel dispatch would produce write collisions. The recipe serializes them deliberately. If tasks are proven to touch disjoint files and directories, a separate orchestration layer may run two loops concurrently, but that is outside this recipe's scope.
---

# Subagent-Driven Development

> Dispatch plan tasks to subagents serially via stdin-file redirect, verify git truth after every exit, and compensate visibility loss with per-task chat bubbles and Prefrontal trail events.

## Goal

Execute a multi-task implementation plan by dispatching each task to a subagent via temp-file stdin redirect, verifying git disk state after every exit, and maintaining visibility with pre-dispatch chat bubbles and Prefrontal trail events — treating git state as the authoritative record and the user's task deletion as the only valid completion signal.

## When to Use

- The plan produced by writing-plans has 2 or more tasks
- The plan has 30 or more lines
- The plan creates new files
- the user says 'execute the plan', 'dispatch subagents', 'tackle each task', or 'implement this'
- Any multi-step implementation plan where tasks can be worked serially without blocking the user's input between each step
- Default for all implementation work — never ask 'subagent vs inline'; subagent is always the answer for plans with multiple tasks

## Steps

### 1. Write task prompt to temp file

**Tools:** Write, Bash
**Done when:** `ls -la /tmp/task-<slug>.txt` shows the file exists and byte count matches the full prompt — not empty, not truncated

Write the complete task prompt to `/tmp/task-<slug>.txt`. Never pass long prompts via shell heredoc — the OS arg-length limit (~128KB on Linux but shell-dependent) silently truncates beyond practical limits. After writing, confirm the file is non-empty with `wc -c /tmp/task-<slug>.txt` before proceeding.

### 2. Emit dispatch trail event and post chat bubble

**Tools:** Bash
**Done when:** Prefrontal `--trail dispatch` event exits 0; chat bubble with task color emoji posted to the conversation

Before blocking on the subagent: run `openclaw prefrontal --trail dispatch --task <id>` and post ONE visible chat bubble using a distinct per-task color emoji (🟦🟢🟣🟠🔴🟡🟤) with a bold task label. Both actions happen BEFORE dispatch, so the user has a visible signal even if the subagent hangs indefinitely.

### 3. Dispatch subagent and wait for exit

**Tools:** Bash
**Done when:** The subagent process exits (any exit code); exit code recorded. Do not proceed until the process has exited — no fire-and-forget.

Run `node scripts/openclaw-spawn-subagent.mjs < /tmp/task-<slug>.txt`. Block until it exits. Record the exit code. A nonzero exit does NOT mean no files were written — proceed to git verification regardless of exit code or the subagent's prose output.

### 4. Verify git state — disk over prose

**Tools:** Bash
**Done when:** `git status --short` and `git log --oneline -5` output reviewed and the actual disk state (files written, commits made, collisions present) is recorded — not 'looks clean', but explicitly confirmed

Run `git status --short` and `git log --oneline -5` in the workdir. The subagent's text summary is a synopsis, not the source of truth. A task may have committed partial work, written untracked files, or exited nonzero after modifying the handler. If files were written but not committed, decide before re-dispatching — a second subagent will collide. Delete `/tmp/task-<slug>.txt` only after this step.

### 5. Emit complete trail event and advance

**Tools:** Bash
**Done when:** Prefrontal `--trail complete` event exits 0 with task id and outcome (success/partial/failed); next task prompt file written OR all tasks confirmed done via explicit checklist

Run `openclaw prefrontal --trail complete --task <id> --outcome <success|partial|failed>`. If tasks remain and they have NO data dependency on the just-completed task, prepare the next prompt file now. If they depend on this task's output, read the relevant output first, then write the prompt. Loop back to step 1. When all tasks are dispatched, do a final `git status --short` across all touched repos — empty working tree is the done invariant.

## Constraints

- Never pass long prompts via shell heredoc — always write to a temp file and redirect stdin; confirm byte count before dispatch
- Never dispatch the next task without completing the git verification step from the previous dispatch, regardless of exit code
- Never suppress the pre-dispatch chat bubble — it is the only visibility signal the user has if the subagent hangs
- Do not ask 'subagent vs inline' — subagent dispatch is the default for any plan with 2+ tasks, 30+ lines, or new file creation
- Do not mark a task resolved until the user deletes it — 'tests pass' does not mean 'works for the user in real use'
- Do not dispatch a second subagent to the same workdir without checking git state first — partial commits from the first run will collide
- pnpm build does not invoke tsdown for dist/entry.js — run node scripts/tsdown-build.mjs explicitly when gateway runtime files change

## Safety Notes

- After a nonzero subagent exit, check git before re-dispatching — the subagent may have committed partial work that a second run will collide with and silently clobber
- If two plan tasks touch overlapping files, they must be serialized even if they appear logically independent — shared workdir writes are not atomic across subagent processes
- Gateway restart does not rebuild from source — after any change to src/gateway/ or src/config/, run the build step before restarting or the new code never reaches the running binary
- Delete temp prompt files after git verification, not before — you may need to re-read the prompt to diagnose a partial failure

## Failures Overcome

- Silent partial commit on nonzero exit: on the relay-navigation-lock run, a Task 2 subagent exited 1 with empty stdout but had already written the test file and modified the handler before dying. Re-dispatching without checking git collided with a parallel agent and clobbered the partial work. Git verification after every dispatch — regardless of exit code — prevents this.
- Prose-report trust inversion: a Task 4 subagent reported BLOCKED but git log showed Tasks 2/3/4/5/6 all already committed. Trusting the text summary over disk state caused a redundant re-dispatch that re-applied already-committed work. This recipe mandates git-first truth after every exit, not prose-first.
- Arg-length truncation: shell heredoc prompts beyond practical shell limits are silently truncated before the subprocess sees them, producing a subagent that executes an incomplete task spec with no error. Writing to a temp file and redirecting stdin bypasses the limit entirely.
- Feature shipped as done while broken in real use: subagents have reported task completion ('tests pass') multiple times on features that failed under the user's actual usage patterns (amazon-shopper shipped 'done' three times while broken). The delete-as-verification protocol (the user deletes = tested and works) breaks the loop — never self-close or self-resolve a task.
- Gateway restart without rebuild: after modifying gateway source, restarting the service without rebuilding caused the team to debug against code that was never running. The modified source compiled fine but the binary was stale. The constraint 'restart does not rebuild' is now explicit in this recipe.
