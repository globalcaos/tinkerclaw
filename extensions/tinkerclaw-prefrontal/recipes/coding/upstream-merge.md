---
schema: recipe/1.0
id: upstream-merge
title: Upstream Merge
category: coding
summary: Merge upstream changes into fork — resolve conflicts, preserve wiring, verify build
triggers: [merge, upstream, sync, rebase, "pull upstream"]
effort: deep
tools: [read, grep, glob, exec, edit]
children: []
---

## Goal

Merge upstream changes into the fork while preserving all fork-specific patches, wiring, and configuration.

## When to Use

- Scheduled upstream sync (daily cron at 04:45)
- Manual merge to pick up specific upstream changes
- After upstream releases a fix we need
- Recovery from a failed automated merge

## Steps

### 1. Pre-check

**Tools:** exec, read
**Done when:** Clean working tree, fork state captured

Verify clean working tree (`git status`). Auto-commit any pending workspace changes (Gate 0). Check FORK_PATCHES.md for known renames and wiring points. Identify TIER1 files (auto-resolved with `--theirs` + re-wiring).

### 2. Merge

**Tools:** exec
**Done when:** Merge complete (with or without conflicts)

Fetch upstream. Merge with `--no-edit`. For TIER1 files, resolve with `--theirs` and mark as resolved. For other conflicts, resolve manually preserving fork changes.

### 3. Resolve Conflicts

**Tools:** read, edit, exec
**Done when:** All conflicts resolved, no conflict markers remain

For each conflict:

- Check if the file is in TIER1 (auto-resolve with `--theirs`)
- Check FORK_PATCHES.md for known fork modifications
- Preserve fork wiring (imports, call sites, config keys)
- Never use `--theirs` on non-TIER1 files without checking fork patches

### 4. Verify Wiring

**Tools:** exec, grep
**Done when:** All 20+ guardian checks pass

Run `merge-guardian.sh` which checks:

- Fork-renamed functions exist at all call sites
- `onlyBuiltDependencies` array present in package.json
- `configSchema` in all plugin manifests
- Auth profile IDs match between openclaw.json and auth-profiles.json
- External CLI sync wiring (`readClaudeCliCredentialsCached`)
- Fallback event emission sites (4 places in run.ts)
- Session reset prompt wiring
- `better-sqlite3` and `bindings` in external array of tsdown.config.ts

### 5. Build & Test

**Tools:** exec
**Done when:** Clean build, gateway starts, tests pass

Clear caches (`rm -rf dist/.cache node_modules/.cache`). Run `pnpm install`. Run `pnpm build`. Start gateway and verify it boots without crash. Run test suite.

## Constraints

- NEVER use `--theirs` on non-TIER1 files without verifying fork patches
- After merge, grep for fork-renamed functions (old names may be reintroduced)
- Verify `pnpm.onlyBuiltDependencies` -- upstream merges wipe this array
- Check ALL extension manifests for new mandatory fields
- Zod schemas for fork config keys must be manually restored

## Safety Notes

- Gate 0 auto-commits prevent data loss from dirty working tree
- Phase 6 creates jarvis-brain backup after merge (captures workspace changes)
- Failed merge can be recovered with `git merge --abort`
- Apply-fork-wiring.mjs has 12 patch functions for automated re-wiring

## Failures Overcome

- **`--theirs` wipes fork fixes:** Using `--theirs` on files with fork patches silently removes them. Same bug THREE times. FORK_PATCHES.md now required, and TIER1 list is explicit.
- **`onlyBuiltDependencies` wiped:** Upstream merge removed this array, `better-sqlite3` native addon never built, gateway crashed on WhatsApp DB access. Guardian now checks this.
- **`configSchema` missing:** Upstream made it mandatory, hippocampus extension lacked it, blocked ALL plugin loading. Guardian checks all manifests.
- **Fork-renamed function reintroduced:** `shouldSuppressHeartbeatBroadcast()` brought back by merge at 3 call sites. Undefined function caused ReferenceError, all broadcasts silently blocked, every response appeared as NO_REPLY.
- **Auth profile ID mismatch:** Upstream merge reverted profile IDs in openclaw.json. Mismatched IDs caused `profile_missing` in eligibility check, fallback silently retried same profile instead of advancing.
