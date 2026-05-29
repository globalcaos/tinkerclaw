---
schema: "kit/1.0"
slug: "git-worktrees"
title: "Isolated Git Worktree Workflow"
summary: "Spin up an isolated git worktree on a fresh branch, do contained work, verify, integrate, and tear down cleanly."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "operations",
    "git",
    "worktree",
    "isolation",
    "feature-branch",
    "agent-session",
    "hotfix",
    "experiment",
    "checkout",
    "cleanup",
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
    - [5]
  notes: |
    DATA-DEPENDENCY CHAIN — fully serial. The worktree must exist (0) before work can happen (1); work must be complete before committing (2); the commit must exist before verification (3); verification must pass before integration (4); integration must complete before cleanup (5). No two steps can run in parallel without violating data dependencies.
---

# Isolated Git Worktree Workflow

> Spin up an isolated git worktree on a fresh branch, do contained work, verify, integrate, and tear down cleanly.

## Goal

Perform feature or fix work in a git worktree so the current checkout and any parallel agent sessions remain unaffected, then integrate cleanly and remove the worktree.

## When to Use

- Feature work that must not disturb an in-progress branch in the main checkout
- Two or more parallel agent sessions that would otherwise collide on the same working tree
- Long-running experiments that should not block hotfix merges on the main branch
- Pre-merge verification that requires a clean HEAD without stashing current edits

## Steps

### 1. Create the worktree

**Tools:** EnterWorktree, exec
**Done when:** EnterWorktree returns success AND `git worktree list` shows the new branch checked out at the worktree path; session CWD is now inside the worktree

Preferred path: call `EnterWorktree(name: '<slug>')` — the harness creates the worktree under `.claude/worktrees/<slug>` on a fresh branch and switches the session CWD automatically. Manual fallback (when outside a Claude Code session): `git worktree add .claude/worktrees/<slug> -b <branch> [<base>]`. Do NOT use `/tmp/` — the harness roots worktrees relative to the repo, and glob/find tools won't accidentally walk a sibling path. Confirm registration with `git worktree list`.

### 2. Do the work inside the worktree

**Tools:** Read, Edit, Write, exec
**Done when:** `git status --short` (no `-C` needed — CWD is already the worktree) shows only intentional modifications; no unintended files appear

All file operations and shell commands now run inside the worktree CWD set by EnterWorktree — use bare paths, not `git -C <path>` prefixes. Build, lint, and run checks from here so artefacts stay isolated from the main checkout. Never write output files back to the main repo tree. If CWD-sensitive tools reset between calls, use the absolute worktree path (returned by `git worktree list`) as a fallback anchor.

### 3. Commit changes in the worktree

**Tools:** exec
**Done when:** `git status --short` output is empty AND `git log --oneline -3` shows the new commit SHA at HEAD

Stage and commit: `git add <explicit-files> && git commit -m '<message>'`. Never use `git add -A` or `git add .` — name files explicitly to exclude build artefacts and credentials. Empty `git status --short` output is the hard invariant; a non-empty status means work or stray files remain.

### 4. Verify — build and test from the worktree

**Tools:** exec
**Done when:** Test runner exits 0 AND the build command completes without error; both commands must have run and produced exit-zero output in this session — prose claims do not satisfy this criterion

Run the project test suite and build (`pnpm test`, `pnpm build`, or project-equivalent) with the worktree as CWD. For runtime services, restart pointing at the worktree's build output and exercise the relevant code path. Do NOT skip this step or mark it done based on 'tests should pass' reasoning — require the actual command output.

### 5. Integrate — merge or open PR from the worktree branch

**Tools:** exec
**Done when:** For a local merge: `git log --oneline -3` on the target branch shows the worktree commits. For a PR: `gh pr view` returns the PR URL and status 'Open' or 'Merged'

Option A (fast-forward merge): from the main checkout root, `git merge <branch>` — run `git log <target>..<branch> --oneline` first to confirm only intended commits are in scope. Option B (PR): `git push origin <branch>` then `gh pr create`; leave the worktree in place until the PR is closed. Resolve conflicts before merging, not after — a dirty merge that compiles is not a clean integration.

### 6. Clean up the worktree

**Tools:** ExitWorktree, exec
**Done when:** `git worktree list` no longer shows the removed path AND the directory is absent from disk

Preferred path: `ExitWorktree(action: 'remove')` — exits the session and deletes the worktree directory and branch atomically; the tool will refuse if uncommitted changes remain (set `discard_changes: true` only after confirming with the user). Manual fallback: `git worktree remove .claude/worktrees/<slug>` then `git branch -d <branch>`. Confirm with `git worktree list` — stale registrations hold git lock resources and break future worktree commands.

## Constraints

- Use absolute worktree paths (from `git worktree list`) for any tool call that resets CWD between invocations — never rely on implicit CWD being correct
- Never stage with `git add -A` or `.` — name files explicitly to exclude build artefacts and secrets
- Do not call `ExitWorktree(action: 'remove', discard_changes: true)` without explicit user confirmation — this is a silent data-loss path
- Keep the worktree path inside `.claude/worktrees/` (the harness default) to avoid recursive glob matches in the main repo tree
- Run `git worktree list` after every add/remove to confirm registration state — the CLI and filesystem can diverge if a registry file is lost

## Safety Notes

- Before merging, run `git log <target>..<branch> --oneline` to confirm only intended commits are in scope — stale merge-base divergence can silently pull in unrelated commits
- If the main checkout has an in-progress rebase or merge, `git worktree add` will refuse or leave metadata inconsistent — resolve it first
- `.git/hooks/` is SHARED across all worktrees of the same repo — a hook that writes to a hardcoded path (e.g. `dist/`) will run in both the main checkout and the worktree and may clobber the wrong tree
- Credentials and `.env` files from the main repo are NOT automatically present in the worktree — symlink or copy deliberately, and do not commit them
- If another process holds `.git/index.lock`, `git worktree add` will fail with a lock error — check for stale lock files with `ls .git/*.lock` and remove them only if no git process is running

## Failures Overcome

- **Parallel-agent working-tree collision:** Two agent sessions editing the same files simultaneously cause index lock errors and lost writes. Worktrees give each agent its own index and HEAD pointer — no lock contention, no silent clobber.
- **Stash-forget data loss:** Stashing before a branch switch and forgetting to pop leaves work stranded; stash conflicts on pop corrupt in-progress edits. Worktrees eliminate the stash/pop cycle entirely.
- **Artefact cross-contamination:** Build output from a feature branch overwriting the main checkout's `dist/` breaks the running service without any visible code change. Isolated worktree paths keep build artefacts strictly separated.
- **`git worktree add` refusal on existing branch:** If the branch name was used in a prior (stale) worktree, git refuses to check it out again. Fix: `git worktree prune` to clear stale registrations, then retry; or choose a different branch name.
- **Shared-hook side-effects:** A `post-commit` or `pre-push` hook that assumes a single working tree (e.g. triggers a gateway restart pointed at `dist/`) will fire inside the worktree too, restarting the wrong build. Audit hook scripts for hardcoded paths before running commits in a worktree.
- **Stale worktree registration after manual directory deletion:** Deleting the worktree directory without `git worktree remove` leaves a dangling registration that blocks reuse of the same name. Fix: `git worktree prune` removes registrations whose directories no longer exist.
