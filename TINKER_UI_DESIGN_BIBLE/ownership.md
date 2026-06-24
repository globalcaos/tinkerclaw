---
file: ownership.md
purpose: Folder-level ownership map for the public fork — who owns what, who reviews what, where concurrent agents can safely work without colliding
audience: AI + maintainer
last_verified: 2026-05-12
last_verified_commit: HEAD
single_owner: yes — fork-side ownership lives here. Upstream's `.github/CODEOWNERS` is the source of truth for upstream-owned paths.
see_also: branch-policy.md (push authority), pii-boundary.md (which content can cross to public), topology.md (process tree this maps onto), design-principles.md (the rules these zones enforce)
verify:
  - name: ownership map covers every fork-touched top-level directory
    cmd: python3 -c 'import os; bible = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/ownership.md")).read(); required = ["src/fork/", "src/gateway/server-methods/", "extensions/tinkerclaw-", "tinker-ui/", "TINKER_UI_DESIGN_BIBLE/", "scripts/", "git-hooks/"]; missing = [r for r in required if r not in bible]; assert not missing, f"ownership map missing: {missing}"'
---

# Ownership map — public tinkerclaw fork

The public fork is touched by **three distinct agents**: Architect (Claude Code running in `~/src/jarvis-icu`), Jarvis (tinker-bridge running on the same OpenClaw gateway), and human maintainer. Plus upstream OpenClaw, which we merge from periodically. This file declares which folders each can safely change without coordinating.

The rules are advisory at first — they're enforceable later by a CODEOWNERS overlay or a pre-commit lint. The goal here is the principle: **two agents touching the same file at the same time is the primary merge-friction cause we have today; per-folder ownership is the cheapest mitigation**.

## Ownership zones

| Zone                                     | Primary owner      | Secondary editors                 | Notes                                                                                                                   |
| ---------------------------------------- | ------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/fork/`                              | Architect          | —                                 | All fork-only logic. Upstream never writes here. Safe for parallel work as long as files are distinct.                  |
| `src/fork/shared/` (when introduced)     | Architect          | —                                 | Cross-cutting fork utilities (pipeline, masking helpers, ID minting). Anything used by >1 fork module lives here.       |
| `src/gateway/server-methods/<our>.ts`    | Architect          | —                                 | Fork-added RPC handlers (debug, cron, wa, gateway probes, plugin probes). One file per concern, never combined.         |
| `src/gateway/server-methods.ts`          | Upstream           | Architect (minimal-touch only)    | The central registry. Each new fork probe adds 2 lines (import + spread). Avoid larger edits.                           |
| `src/gateway/method-scopes.ts`           | Upstream           | Architect (minimal-touch only)    | Fork probes append to the READ_SCOPE list. Single-line additions only.                                                  |
| `extensions/tinkerclaw-*/`               | Per-plugin         | —                                 | Each plugin folder is its own ownership unit. `tinkerclaw-tinker-bridge` ≠ `tinkerclaw-whatsapp` ≠ `tinkerclaw-people`. |
| `extensions/tinkerclaw-control-panel/`   | Jarvis             | —                                 | Active Phase-C MVP authored by Jarvis. Architect doesn't touch the plugin internals without coordinating.               |
| `tinker-ui/src/`                         | **Shared hotspot** | Both Architect and Jarvis         | Today's biggest collision risk (65/75 FORK anchors in `app.ts`). Both agents may edit; pull before push.                |
| `tinker-ui/src/panels/`                  | Architect          | —                                 | Per-panel files (prefrontal-tree.ts) are split-out enough to be safe.                                                   |
| `TINKER_UI_DESIGN_BIBLE/`                | Architect          | Jarvis (read-only)                | Architect maintains; Jarvis consumes. Jarvis flags staleness in today's `memory/YYYY-MM-DD.md`, never edits.            |
| `scripts/`                               | Architect          | —                                 | Fork-side scripts (test-invariants, gen-tinker-ui-registry, pii-pre-push). Architect-only.                              |
| `git-hooks/`                             | Architect          | —                                 | Pre-commit + pre-push hooks. Architect-only.                                                                            |
| `~/.openclaw/workspace/` (separate repo) | Jarvis (runtime)   | Architect (briefings + knowledge) | Jarvis's runtime mutates this continuously (memory/, BRIEFING.md, SOUL.md). Architect adds knowledge notes only.        |

## Concurrency rules

1. **Pull before push.** Every push by either agent starts with `git pull --rebase origin develop`. Today's parallel-session HUD collision (the unstaged `tinker-ui/src/app.ts` from Jarvis blocking my push for 30 minutes) would have been avoided by a pre-push pull.
2. **One-feature-per-file.** When adding a probe, a handler, or a utility, prefer a new file in the right zone over an edit to an existing file. The pre-push `bible:invariants` gate catches regressions; a new file never collides.
3. **Flag in-progress work.** If you're editing a file across multiple commits and another agent might pick it up, leave an `# WIP: <agent>` comment at the top of the file. The other agent skips until the marker clears.
4. **Architect-only paths are exclusive.** `scripts/`, `git-hooks/`, `TINKER_UI_DESIGN_BIBLE/` are Architect's. Jarvis never writes here. If Jarvis spots a problem, he writes a note in `~/.openclaw/workspace/memory/YYYY-MM-DD.md` for the next Architect session to pick up.

## When agents disagree

The bible's `single_owner: yes` claim per file is the disagreement-resolution mechanism. If two files claim authority over the same fact, one of them is wrong and must redirect to the other. The meta-verify in `test-invariants.mjs` (see `unit-tests.md`) catches this automatically.

For code, the disagreement-resolution rule is simpler: **whichever agent merged to `main` most recently wins on a conflict**, and the loser rebases. `develop` is the messy branch; collisions there are expected and resolved per the standard rebase/conflict workflow described in `branch-policy.md`.

## Upstream merge protocol

Upstream OpenClaw merges land via the daily-fork-sync cron (currently disabled — see `failures.md` M9). When re-enabled, the merge cron runs `pnpm bible:invariants` as the gate. Any failure rolls the merge back. Architect handles upstream merge conflicts manually until that gate is restored.

**Files we expect upstream to touch but that we add to:** `src/gateway/server-methods.ts`, `src/gateway/method-scopes.ts`. These are the M3 risk zone. The verify entries in `failures.md` exercise each fork-added RPC after merge.

**Files we don't expect upstream to touch:** anything under `src/fork/`, `extensions/tinkerclaw-*/`, `TINKER_UI_DESIGN_BIBLE/`, `scripts/test-invariants.mjs`, `git-hooks/pre-push`. If a merge lands changes here, audit before accepting — upstream has no reason to write fork-namespaced files.
