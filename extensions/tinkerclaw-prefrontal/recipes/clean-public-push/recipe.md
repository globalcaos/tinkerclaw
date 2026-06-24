---
schema: "kit/1.0"
slug: "clean-public-push"
title: "Clean public push (PII-clean history, no force-push, WIP-safe)"
summary: "Publish a local branch to a PUBLIC remote with a sanitized HISTORY — not just a clean tip — via a squashed fast-forward, in a throwaway worktree so in-progress WIP is never disturbed. For repos with a PII boundary that are many commits ahead of the public remote."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "publish",
    "public push",
    "pii",
    "sanitize",
    "leak guard",
    "squash",
    "fast-forward",
    "history",
    "open source",
    "before push",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  repoRoot: "{{repoRoot}}" # absolute path to the repo
  remote: "{{remote|origin}}" # public remote name
  branch: "{{branch|develop}}" # branch to publish
  piiRe: "{{piiRe}}" # PCRE leak pattern; default = scripts/pii-pre-push.sh PII_RE
  replacements: "{{replacements}}" # ordered list of {pattern -> replacement}; e.g. first-name->role, host-path->placeholder
  verifyCmd: "{{verifyCmd|pnpm bible:invariants}}" # docs/quality gate (slow; timeout-kill is NOT a failure)
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
---

# clean-public-push

A repo that is N commits ahead of its public remote leaks PII through **history**, not just the tip: `git push` publishes every commit's blobs. Sanitizing the working tree + one commit cleans only the tip. This recipe publishes a **single squashed, sanitized commit** as a **fast-forward** (no force-push) from a **throwaway worktree** (the main tree's in-progress WIP is never touched). Drive it with the `Workflow` tool (BROCA); the sanitize transform is deterministic (a script), the careful code/test fixes + verification are where agents/judgment earn their place.

## Step 0 — backup + clean worktree + collapse

- Back up WIP: `git -C {{repoRoot}} diff HEAD > $HOME/<repo>-wip-backup-<ts>.patch` (+ `git status --short`).
- `git -C {{repoRoot}} fetch {{remote}}`.
- Throwaway worktree at the tip (no WIP): `git -C {{repoRoot}} worktree add --detach /tmp/clean-pub $(git -C {{repoRoot}} rev-parse {{branch}})`; symlink `node_modules` (+ sub-package) for build/test.
- Collapse: `git -C /tmp/clean-pub reset --soft {{remote}}/{{branch}}` → whole net diff staged on the public base; tree = clean tip content.

## Step 1 — identify PII files

For each staged file, `git show :<f> | grep -P "{{piiRe}}"` → the sanitize list. (PII boundary: full-name byline + public handle ALLOWED; first-name narrative, host paths, family/contact names, location, business contacts, tokens, emails MUST be scrubbed.)

## Step 2 — sanitize (deterministic transform)

Apply `{{replacements}}` in order across the PII files (e.g. `perl -i -pe 's/<first-name>(?! <surname>)/the architect/g'`; host path → placeholder). For paths inside **code string-literals / test fixtures**, also fix the dependent expected values so tests stay valid (e.g. an encoded path constant). Prose/comments → `$HOME`/`~` is fine. Put the multi-alternation regex in a SCRIPT FILE (inline `(...|...)`/lookaheads break hook-wrappers).

## Step 3 — PII GATE (hard, blocking)

`git -C /tmp/clean-pub add -A` then assert `git diff --cached {{remote}}/{{branch}} | grep -aP '^\+.*({{piiRe}})'` is EMPTY. Not empty → fix, repeat. Never proceed past a non-empty gate.

## Step 4 — verify + squash-commit + FF push

- Verify the sanitized tree: touched tests (single-file, not parallel), a typecheck, and `{{verifyCmd}}` (slow — a `timeout` kill is NOT a failure; confirm all _run_ checks pass).
- One squashed commit (message summarizes the published body of work; co-author trailer).
- Assert FF: `HEAD^ == {{remote}}/{{branch}}`. Re-run the PII gate on `git diff {{remote}}/{{branch}}..HEAD`.
- `git push {{remote}} HEAD:{{branch}}` (fast-forward; NO force-push). The repo's `core.hooksPath` pre-push runs as a backstop.
- Clean up the worktree + temp scripts; keep the WIP backup until confirmed.

## Don't-regress

- **No force-push** of a shared branch — FF only. **Never `reset --hard` over live foreign WIP.**
- The local branch will diverge from the squashed remote; reconcile ONLY after the WIP is committed/cleared by its owner.
- History-clean is the point — a tip-only sanitize still leaks via `git show <old-commit>`.
- Ensure the public remote's pre-push actually invokes the PII grep (`scripts/pii-pre-push.sh`); wire it (`core.hooksPath`) if missing — manual gating is the real guard, the hook is the backstop.
