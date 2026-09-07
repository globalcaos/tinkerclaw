---
schema: "kit/1.0"
slug: "finish-branch"
title: "Finish a branch — verify, merge, delete, say so"
summary: "The definition of done for a feature branch: one whole-tree verification on the branch tip, design docs made current, merge into the integration branch, PROVE the branch is redundant before deleting it and its worktree, and close with an explicit merge/delete status line. Use when work is committed and someone asks to merge it, finish it, wrap it up, clean up the branch, or whether it is done."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "ship"
tags:
  [
    "finish the branch",
    "merge",
    "merge into develop",
    "wrap it up",
    "is this done",
    "definition of done",
    "delete the branch",
    "clean up worktree",
    "integrate",
    "ship it",
    "close out",
  ]
antiTriggers:
  [
    "plan only",
    "review only",
    "keep the branch",
    "do not merge",
    "open a pull request",
    "work in progress",
    "just commit",
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
    [0] barrier: nothing merges until the whole-tree check is green on the branch tip.
    [1] barrier: docs currency is judged against the same diff that is about to merge.
    [2] barrier: the merge is the one irreversible step; it runs alone and is compared before/after.
    [3] barrier: deletion proof must read the post-merge integration branch, so it cannot precede it.
    [4] barrier: destructive; runs only on a recorded proof from the previous step.
    [5] barrier: the status line reports what actually happened in the five steps above.
params:
  integration_branch:
    {
      type: "string",
      default: "develop",
      description: "The branch this work merges into. The ONLY merge target this recipe is authorized to write.",
    }
  verify_command:
    {
      type: "string",
      default: "",
      description: "The one whole-tree verification command. Leave empty to derive it from the repo (package manifest scripts, CI config, Makefile).",
    }
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where a plan file and its rulings ledger live, when one exists; the closing status line is appended there.",
    }
---

# Finish a branch — verify, merge, delete, say so

> Committing is not the end. Work is done when it is merged, the branch is
> gone, and the closing line says so in words nobody has to interpret.

## Goal

Turn "the code is committed" into "the work is done": one whole-tree
verification on the branch, docs current with the change, a merge into
{{integration_branch}}, deletion of the branch and its worktree only after
redundancy is PROVEN, and a closing status line stating the outcome.

## When to Use

- Implementation is complete and committed on a feature branch.
- A build, refactor, or debug run reached its last step.
- Someone asks "is this done?", "merge it", or "clean up the branches".

## When NOT to use

- Work is unfinished or the suite is red — finish the work first.
- Nothing is committed yet — commit per unit first, then come back.
- The target is a third-party remote expecting a pull request — open the PR
  instead; do not merge locally.
- The merge target is a shared branch the user has not named as
  {{integration_branch}} — ask, then run.

## Steps

### 1. Integration verify on the branch

**Done when:** {{verify_command}} exited 0 on the branch tip, and its exit code plus a one-line summary are recorded.

Run it ONCE, on the branch tip, whole tree — not per file. Derive the command
from the repo when the param is empty (typecheck + full suite). Confirm the
worktree is clean first; declare any dirt rather than hiding it. Swallow
success output, surface only failures — a green run needs one line, not a
scrollback. Never bypass hooks. A red result is a stop: name the failing test
and do not merge. If the change requires a build or restart to take effect,
say "written, not running" rather than implying it is live.

### 2. Documentation currency

uses: bible-currency-gate
**Done when:** every design fact the diff changed is reflected in its owning doc, and where the repo has a docs-invariants gate, that gate exits green.

The sub-recipe receives the branch diff, the repo's design-docs root, and one
instruction for repos without one: update the README and the docs this diff
made stale instead. It must return the list of documents touched — empty is a
valid answer with a stated reason — and the gate's result. Judgment edit, never
an auto-dump of the diff into prose. Stale design docs are a merge blocker, not
a follow-up.

### 3. Merge into {{integration_branch}}

**Done when:** the branch's work is present in {{integration_branch}} AND the post-merge diffstat is not smaller than the pre-merge branch diffstat.

Record the branch diffstat against {{integration_branch}} BEFORE merging.
Bring {{integration_branch}} up to date, then prefer a fast-forward merge. If
fast-forward is impossible, rebase the branch and retry; a true merge commit is
a Ruling — log what and why. After merging, recompute the diffstat and COMPARE:
a diffstat that SHRANK means a merge driver resolved without conflict and
silently dropped branch work — stop there, delete nothing. Conflicts are
resolved and logged as Rulings unless the resolution would be a guess.

### 4. Prove redundancy before deleting

**Done when:** one of the three proofs below is recorded verbatim, or the branch is kept with the reason stated.

Exactly three proofs count. One: `git merge-base --is-ancestor <branch>
{{integration_branch}}` exits 0. Two: `git cherry {{integration_branch}}
<branch>` prints no `+` lines — the same patch landed under another SHA, the
normal outcome of per-unit commits. Three: SUPERSEDED — the integration branch
shipped a different deliberate implementation, proven by READING its code, never
inferred from a branch name. Before any of this, check the branch's worktree for
uncommitted work; snapshot it and state the snapshot location. Never destroy
uncommitted work to satisfy a cleanup.

### 5. Delete the branch and its worktree

**Done when:** neither the worktree nor the branch is listed any more, and no snapshot was lost.

Remove the worktree first, then delete the branch with the safe flag — its
refusal is a safety net, not an obstacle. The force flag is allowed only when
proof two or three was recorded in step 4, and the report must say which.
Prune stale worktree entries afterwards. If deletion is refused and step 4
produced no proof, KEEP the branch and say so: a spare branch costs nothing,
lost work costs a day.

### 6. Closing status line

**Done when:** the reply's last line is one of the two forms below, and the same line is appended to the plan's ledger when a plan file exists under {{plans_dir}}.

Exactly one of: `merged into {{integration_branch}}, branch <name> deleted
(worktree removed)` — or — `NOT merged — <the exact blocker> — unblock: <the
one action that clears it>`. Never phrase a summary so "done" can be inferred
while a branch is still open. Never ask about pushing, never offer it, never
list it as a next step: pushing is the user's own step in their own context.
The report is prose plus this line — no code.

## Constraints

- The closing status line is mandatory on every run, including failed ones.
- Fast-forward first; a merge commit is a logged Ruling, not a default.
- Stage only what a step here changed; never stage the whole tree, never bypass
  hooks, never force-push, never delete an unproven branch.
- No new implementation work happens here. A needed fix goes back to the build
  recipe as its own commit, and this recipe restarts at step 1.
- Only four things stop the run: an irreversible or destructive operation beyond
  the authorized merge, a security-sensitive action, an effect outside the
  worktree that was not named, or a state where every path is a guess.
  Everything else is decided and logged as a Ruling.

## Safety Notes

- Merging into {{integration_branch}} is this recipe's one authorized side
  effect outside the worktree. Any other target must be named by the user.
- No remote writes at all: no push, no pull request, no tag publication.
- Uncommitted work is snapshotted before any destructive step and its location
  is stated in the report.
- Deletion is gated on proof, never on a branch name, a commit message, or a
  subagent's claim that the work landed.

## Failures Overcome

- **2026-08-24 — a green "committed + verified" summary hid an unmerged
  branch.** The reader reasonably concluded the task was over; the branch sat
  open indefinitely. Encoded as: done means merged, and the merge/delete status
  is stated explicitly in the closing message every time.
- **2026-08-16 — a custom merge driver silently dropped branch work.** The
  files resolved with no conflict and the branch's edits vanished; the only tell
  was a diffstat that SHRANK. Encoded as: record the diffstat before the merge,
  compare it after, prefer fast-forward.
- **Deleting on a hunch.** A branch that looks merged is not evidence that it
  is. Encoded as the three-proof rule in step 4.
- **Cleanup that destroyed work.** A dirty worktree removed for tidiness took
  uncommitted edits with it. Encoded as: snapshot first, report where.
- **Asking about pushing.** Surfaced repeatedly as an "open question" the user
  had already answered. Encoded as: never ask, merge locally and stop.
