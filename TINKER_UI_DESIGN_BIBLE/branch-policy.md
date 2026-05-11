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
    cmd: bash -c 'cd ~/src/tinkerclaw && git rev-parse --verify develop >/dev/null 2>&1'
  - name: README.md is merge=ours-protected (matches the policy in §3)
    cmd: bash -c 'cd ~/src/tinkerclaw && grep -q "README.md merge=ours" .gitattributes'
  - name: pre-push hook exists (PII guard)
    cmd: test -x ~/src/tinkerclaw/git-hooks/pre-push
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
- `apply-fork-wiring.mjs` runs idempotent (re-running prints "already wired" for everything).
- A smoke probe through cc-bridge replies (e.g. SMOKE-OK).
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

**Pre-push enforcement (FORK 2026-05-11).** `git-hooks/pre-push` runs `scripts/pii-pre-push.sh` automatically. The hook scans the commit range about to be pushed for the private-token regex from `pii-boundary.md` and blocks the push if any match. Bypass with `PII_GUARD=off git push …` for genuine intentional inclusions (e.g. adding an "Oscar Serra" byline).

**README.md is `merge=ours`-protected** (`.gitattributes`, 2026-05-09). The fork's gold-pass TinkerClaw README auto-wins on every upstream conflict. Without this, the merge cron's `--theirs README.md` block silently replaced our README with upstream's OpenClaw one — happened repeatedly before the protection landed.
