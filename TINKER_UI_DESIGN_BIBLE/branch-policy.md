---
file: branch-policy.md
purpose: Public-fork branch model and merge rules — develop vs main, push authority, README protection
audience: AI + maintainer
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — branch policy lives here. Migrated from bible.md §5.78 on 2026-05-11.
see_also: pii-boundary.md (the topology check that gates every push), topology.md (where the public/private repos sit)
verify:
  - name: develop branch exists locally
    cmd: bash -c 'cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && git rev-parse --verify develop >/dev/null 2>&1'
  - name: README.md is merge=ours-protected (matches the policy in §3)
    cmd: bash -c 'cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && grep -q "README.md merge=ours" .gitattributes'
  - name: pre-push hook exists (PII guard)
    cmd: test -x ~/src/tinkerclaw/git-hooks/pre-push
  - name: synthetic 3-way merge helper exists and is executable (§4)
    cmd: test -x ~/src/tinkerclaw/scripts/merge-drivers/upstream-3way.sh
  - name: TIER1 driver post-condition (§5) — the merge-driver node:test suite passes (per-hunk restore, idempotence, exit 1 naming each lost wave hunk). No vitest project collects scripts/, so this line IS its runner (paths resolve against BIBLE_DIR's checkout, else the shared one)
    cmd: cd "${BIBLE_DIR:-$HOME/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE}/.." && node --test scripts/merge-drivers/apply-fork-wiring.test.mjs
---

# Branch Policy — public tinkerclaw fork

> Migrated 2026-05-11 from bible.md §5.78 (verbatim except for this header). Current policy is the dual-online variant in §3 below; legacy §1 / §2 are kept for archaeological context only.

## 1. Original rule (2026-04-29)

> **Superseded by §3 (2026-05-09).** The diagram below is the original 2026-04-29 local-only-`develop` flavor (push `main`, then `git reset --hard main` to refresh `develop`). Current policy: `develop` lives on `origin`, gets pushed freely, and is **never reset** after merging into `main`. Read §3 for the live workflow.

```
develop (local, may be broken at any moment)
   │
   │  when a chunk of work is fully tested:
   │  - build green
   │  - gateway boots clean
   │  - smoke test passes (`/jarvis-status` answers, model probe replies)
   │  - any new fork-wiring patches verified idempotent
   │
   ▼
main (local, snapshot of last known-good)
   │
   │  push (Jarvis owns this, never Claude Code directly)
   │
   ▼
origin/main on github
```

After each merge to main:

```bash
git checkout main
# main is now pristine
git push origin main          # Jarvis pushes — see "NEVER push" rule

git checkout develop
git reset --hard main          # develop becomes a fresh copy of main
# continue tinkering on develop
```

## 2. "Fully working" before merging develop → main

A non-negotiable checklist:

- `pnpm build` exits 0 with `NODE_OPTIONS=--max-old-space-size=8192`.
- Gateway boots cleanly (`openclaw-restart --full`, `curl /healthz` returns `{"ok":true,"status":"live"}`).
- `apply-fork-wiring.mjs` runs idempotent: a re-run leaves `git status` clean and exits 0. It is not silent — on 2026-09-25 it still printed six stale-anchor warnings and three `Patched:` lines for byte-identical rewrites — so read the exit code, not the log. Since 2026-09-25 a non-zero exit can mean a tier-1 fork hunk is gone (§5): read the hunk it names and re-site it; do not merge past it. Run it as `TINKERCLAW_DIR="$PWD" node scripts/merge-drivers/apply-fork-wiring.mjs`, or from inside the tree to patch: since 2026-10-01 (`d5e48c624ea`) it patches the git top-level it runs in, and `~/src/tinkerclaw` only outside any tree. Before that it patched the shared checkout from any worktree (twice on 2026-09-30, from the J19 build).
- A smoke probe through tinker-bridge replies (e.g. SMOKE-OK).
- For changes to plugin manifests: each plugin still appears in the gateway plugin list at boot.
- For changes to docs/scripts only: skip the build gate, but verify the doc renders or the script `node --check`s clean.

If any of these fails, fix on `develop`; do not merge.

### When the merge is messy (e.g. another big upstream catch-up)

The 23-chunk supervised merge from 2026-04-28 is the worst case. Even there, the process was: do the merge on develop, accumulate fork-wiring patches, verify each chunk builds, only THEN merge develop → main. Don't push intermediate chunks to origin/main; the only thing origin/main sees is the final caught-up state.

### What develop is allowed to be

- Half-merged upstream chunks
- Experimental plugins not yet wired up
- Disabled features (`enabled: false` in openclaw.json) being tested
- Broken builds during refactors
- Stashes that aren't ready

Anything that would embarrass us if a stranger cloned `main` and tripped on it.

### Other branches

Existing topic branches (`feat/...`, `fix/...`, `pr/...`, `wip/...`) are still fine for isolated work. They merge into `develop`, not into `main` directly. The two long-lived branches are `main` (clean) and `develop` (messy).

## 3. `develop` is the working branch, both local and pushed (2026-05-09 — current)

Both `develop` and `main` live on `origin`. We always work on `develop` and push it freely. `main` only advances when the user and the architect agree the current `develop` snapshot is stable and shippable.

**Why dual-online.** A local-only `develop` (the previous policy, also written 2026-05-09) required a recreate-after-push dance every cycle and forbade cross-machine work. A pushed `develop` is plainer: one place for in-progress work, one place for shippable, both visible. Cloners who base work on `origin/develop` are choosing the unstable side knowingly — that's their call, not ours to prevent.

**Lifecycle.**

1. Tinker on `develop`. Push freely.
2. When `develop` passes the checklist in §2 (build green, gateway boots, smoke probe replies, fork-wiring idempotent), merge `develop` → `main` locally — by **mutual agreement**, not solo.
3. Push `main` to `origin`.
4. `develop` keeps moving. No reset, no recreate.

**Push authority (2026-05-09).** The earlier "only Jarvis pushes" rule is lifted. Architect Claude Code may `git push` directly. **Topology check still mandatory** before every push: no private data into public `tinkerclaw` (see `pii-boundary.md`). The 2026-04-06 personality-NN leak is the reason that check is non-negotiable. `git push --force` / `--force-with-lease` and `--no-verify` still need explicit confirmation, especially against `main`.

**Pre-push enforcement (FORK 2026-05-11).** `git-hooks/pre-push` runs `scripts/pii-pre-push.sh` automatically. The hook scans the commit range about to be pushed for the private-token regex from `pii-boundary.md` and blocks the push if any match. Bypass with `PII_GUARD=off git push …` for genuine intentional inclusions (e.g. adding the author's full-name byline).

**README.md is `merge=ours`-protected** (`.gitattributes`, 2026-05-09). The fork's gold-pass TinkerClaw README auto-wins on every upstream conflict. Without this, the merge cron's `--theirs README.md` block silently replaced our README with upstream's OpenClaw one — happened repeatedly before the protection landed.

## 4. Pinned synthetic-ancestor 3-way merge (`upstream-base`, 2026-06-02)

**The no-merge-base conflict multiplier.** The fork's history and `upstream/main` are **disjoint** — `git merge-base HEAD upstream/main` is **EMPTY** (the fork was re-rooted; the two lineages share no real ancestor commit). Git's default merge therefore has no ancestor to diff against, so **every file that differs in any way becomes a worst-case 2-way add/add reconcile**, even when the two sides are trivially or identically different. A clean upstream catch-up explodes into hundreds of spurious conflicts. This is the single biggest cost driver of the daily fork sync.

**The fix: a pinned synthetic common ancestor.** The tag **`upstream-base`** is pinned at the upstream content-anchor the fork actually carries — established in S3 (2026-06-02) at **`7b07a0ab8fd`** (`feat(channel) add yuanbao docs entrance (#73443)`). That commit is the merge-base of the fork's last-synced upstream tag with `upstream/main`, and it is an ancestor of `upstream/main` (the validity invariant). Feeding `upstream-base` to a 3-way merge as the explicit base lets git compute `ours vs theirs vs ancestor` per file, so trivially-different and upstream-only files **auto-resolve** instead of re-conflicting. Only files BOTH sides genuinely changed relative to the pinned base will conflict — the real merge work, nothing spurious.

**Advance after every successful sync.** Once a sync lands (build green), move the tag forward to the just-merged upstream commit: `git tag -f upstream-base <merged-upstream-sha>`. The next sync's synthetic ancestor is then the content the fork now carries, keeping conflict surface minimal over time. The fork-sync cron does this automatically and records the new SHA in its receipt.

**The merge primitive: `scripts/merge-drivers/upstream-3way.sh`.** Three subcommands:

- `preview` — non-destructive; prints the would-be merged tree + conflict hunks to stdout (uses the git-2.34-portable old `git merge-tree <base> <ours> <theirs>` form). Nothing in the worktree/index changes.
- `merge` — performs the real index+worktree 3-way against the pinned base via `git merge-recursive upstream-base -- HEAD upstream/main`. Leaves conflict markers for the caller to resolve, then the caller commits. This sidesteps the "refusing to merge unrelated histories" guard because it operates on the three trees directly, not on the DAG.
- `advance <sha>` — `git tag -f upstream-base <sha>` (defaults to `upstream/main`).

**Git-version note.** `git merge-tree --merge-base` (the modern one-shot 3-way) is git >= 2.38 only; the host runs **2.34.1**, so the helper uses the portable primitives above instead. Anyone upgrading git can switch the `merge` path to `git merge-tree --merge-base upstream-base HEAD upstream/main` but the recursive primitive stays correct on all versions.

**Cross-ref.** The auto-merge policy (TIER1/2/3 conflict resolution, the build gate, why the `daily-fork-sync` cron is currently DISABLED pending the J15 merge gate) lives in `crons.md` § "Auto-merge policy". The synthetic-base 3-way is the merge _primitive_ that policy's TIER2 "prefer 3-way merge" rule now resolves against. The TIER1 driver (`scripts/merge-drivers/tier1-driver.sh`, accept-upstream-then-rewire) is orthogonal and still applies per-file via `.gitattributes merge=tier1`.

## 5. The TIER1 post-condition — a lost fork hunk fails the wiring run (2026-09-25)

**The hole.** `.gitattributes` marks a set of files `merge=tier1`. `tier1-driver.sh` resolves each
one by copying UPSTREAM over ours (`cp "$THEIRS" "$OURS"`), then runs `apply-fork-wiring.mjs` to put
the fork's lines back and trusts its exit code. Every patch in that script warns and carries on when
its anchor is missing — right for one patch, wrong for the run. Measured 2026-09-25 against
`upstream/main` `244450952c0`: `attempt.ts` now sits behind `startEmbeddedAttemptDiagnostics()`, the
`recordRunDone` call had nowhere to go, and the run exited **0** with one "Could not find anchor" line
to show for it. The `run.done` events table would have stopped filling at the next catch-up, behind a
green merge.

**The fix (`a018114b747`, `2a13682aaf3`).** `checkTier1ForkMarkers()` runs after every patch, beside the
preserve and cross-package guards, over `TIER1_REQUIRED_MARKERS`: one pattern per fork hunk that must
exist in a tier-1 file once the patches have run. A missing one sets exit code 1 and names the hunk
and the repair (`git show ORIG_HEAD:<file>`, then fix that patch's anchor so the next merge restores
it on its own). On the wired wave-0924 HEAD the script exits 0, prints
`TIER1 fork wiring markers all present (8)` and leaves `git status` clean. The list holds the
wave-0924 hunks:

| Tier-1 file                                       | Hunk(s) the post-condition requires                                                                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/embedded-agent-runner/run/attempt.ts` | the `recordRunDone` import, and its call inside `emitDiagnosticRunCompleted` — the `run.done` events row (logging.md §4.6)                                                                                                 |
| `src/gateway/server-methods/sessions.ts`          | the `evictSessionTranscript` import and the `sessions.compact` keepFraction branch that delegates to `session-eviction.ts`; the `createChatAbortOps` import and `chatAbortOps` at BOTH the reset and the delete call sites |
| `package.json`                                    | the `./plugin-sdk/fork-telemetry` export                                                                                                                                                                                   |
| `tsdown.config.ts`                                | the `infra/events/writer-worker` dist entry                                                                                                                                                                                |

**Where it fires — on the merged tree, not inside the merge (measured 2026-09-25).** The script never
sees the merge result. It reads and writes `<ROOT>/<path>`, where ROOT is `TINKERCLAW_DIR`, else
`~/src/tinkerclaw` — never git's `%A` temp file, which is where `tier1-driver.sh` put upstream's copy
and what git writes into the tree AFTER the driver returns. During the driver, the working-tree file
still holds the pre-merge (ours) side, already wired, so every patch reports "already present", the
post-condition passes, and git then lands upstream's copy with the hunk gone. Reproduced in a scratch
repository with git 2.34.1, for both `git merge` and the `git merge-recursive` primitive §4 uses: a
driver shaped like `tier1-driver.sh` (`%A` ← theirs, then check-and-patch the working-tree path) saw
the fork line present and exited 0, and the merged file was upstream's, fork line absent. Two
consequences:

- **The post-condition guards the run AFTER the merge.** Run
  `TINKERCLAW_DIR="$PWD" node scripts/merge-drivers/apply-fork-wiring.mjs` on the merged tree (bible.md
  §9): the patches then see upstream's shapes, and a hunk they cannot re-site exits 1 by name. That
  run is not optional — it is the only place the tier-1 guarantee holds.
- **ROOT is not the cwd, and the driver does not set it.** `tier1-driver.sh` `cd`s to the merging
  checkout, but a merge in any other worktree still re-wires, and checks, `~/src/tinkerclaw`. Running
  the script by hand from a worktree without `TINKERCLAW_DIR` does the same — it patches the shared
  checkout, not the worktree it was started in (observed 2026-09-25).

Closing this in code is owed: the driver has to wire the file git will keep (`%A`), or the script has
to be pointed at the merging tree. Until then, read "auto-applied" anywhere in this bible as "applied
by the post-merge run".

**The next upstream catch-up WILL trip the post-merge run**, on `attempt.ts` (no anchor left for
`recordRunDone`) and on `sessions.ts` (which `upstream/main` stopped shipping in `3350cd58b4e`, so its
markers have no file to live in) — on purpose: both need a human to re-site the hunk, and the red run
is what makes that visible.

**What it does not cover.** Only wave-0924 hunks are listed; older fork hunks in tier-1 files still
only warn when their anchor is gone — `attempt.ts`'s `onTurnComplete` hook among them. Two older
families are restored by nothing at all: every `./plugin-sdk/fork-*` export except `fork-telemetry`
(`pnpm lint:plugins:plugin-sdk-subpaths-exported` fails on any that an extension still imports), and
the two `memory/engram/fts-worker*` dist entries (a missing one fails the FTS spawn at run time, not
the build, and every search falls back to the main thread). **Rule from here: a fork edit to a
tier-1 file adds its marker to `TIER1_REQUIRED_MARKERS` beside its patch, in the same commit.**

**The tests.** `scripts/merge-drivers/apply-fork-wiring.test.mjs` — dependency-free `node:test`, after
`extensions/tinkerclaw-orca/lease-core.test.mjs` — feeds the script upstream-shaped files through
`TINKERCLAW_DIR` and asserts that each hunk comes back and that a second run is byte-identical; it adds
a tsdown fixture trimmed from `upstream/main`, a positive control (a restorable tree exits 0) and the
negative (`upstream/main`'s `attempt.ts` shape plus no `sessions.ts` exits non-zero, naming both). It
calls the script directly, so it proves the post-merge run, not the in-merge driver path above
(`design-principles.md` #24). No vitest project collects `scripts/` (`unit-tests.md`), so this optic's
`verify:` line is the suite's only automatic runner.
