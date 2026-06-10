---
file: orca-leases.md
purpose: ORCA's cross-session file-lease registry — how concurrent agents serialize edits per-file (no branches, no merges), the atomicity guarantee, and the Edit/Write hook contract
audience: AI
last_verified: 2026-06-10
last_verified_commit: HEAD
single_owner: yes — cross-session file-leasing facts (lease-core primitives, the orca.lease.* RPC surface, the PreToolUse/Stop hook, atomicity + staleness model) live here
see_also: subagents-and-recipes.md (ORCA workflow / parallel-implement; in-run union-find leasing is a DIFFERENT, in-memory thing), topology.md (tinkerclaw-orca plugin), ownership.md (who may edit which file), branch-policy.md (one branch, no merges)
verify:
  - name: lease-core primitives + CLI + concurrency tests pass (the mutual-exclusion guarantee)
    cmd: bash -lc 'cd ~/src/tinkerclaw && node --test extensions/tinkerclaw-orca/lease-core.test.mjs'
  - name: the Edit/Write lease hook passes its end-to-end behavioural tests
    cmd: bash -lc 'cd ~/src/tinkerclaw && bash extensions/tinkerclaw-orca/enforce-file-lease.test.sh'
  - name: lease writes are ATOMIC (linkSync claim + renameSync replace) — a plain writeFileSync would torn-read and let a live lease be stolen
    cmd: python3 -c 'import os; s=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-orca/lease-core.mjs")).read(); assert "fs.linkSync" in s and "fs.renameSync" in s and "withLeaseLock" in s, "lease-core lost its atomic-write primitives or the per-lease steal lock — the double-grant / torn-read defenses regressed"'
  - name: the hook ships in the TRACKED extension dir (not gitignored .claude/) so it is public + co-located with lease-core
    cmd: bash -lc 'test -x ~/src/tinkerclaw/extensions/tinkerclaw-orca/enforce-file-lease.sh && ! git -C ~/src/tinkerclaw check-ignore -q extensions/tinkerclaw-orca/enforce-file-lease.sh'
  - name: the hook releases on Stop but NOT on SubagentStop (subagents may share the parent session_id → would free the parent's live leases)
    cmd: python3 -c 'import os; s=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-orca/enforce-file-lease.sh")).read(); assert "= \"Stop\" ]" in s and "SubagentStop\" ]" not in s, "the hook regressed to releasing on SubagentStop — that frees the parent session\x27s live leases mid-flight"'
---

# ORCA cross-session file leases

## The problem this solves

Multiple agents share **one working tree**: several Claude Code sessions, Jarvis,
an ORCA run. Without coordination they overwrite each other's edits and each
other's context files (this bible's own `latest-context.md` was clobbered exactly
this way on 2026-06-10). ORCA's lease registry serializes edits **per file** so
disjoint files proceed in parallel and a contended file is held by one agent at a
time — **on one branch, no branches, no merges.**

> Not to be confused with the ORCA _workflow_'s in-run leasing (`subagents-and-recipes.md`):
> that is an in-memory union-find partition WITHIN a single run. THIS is the
> cross-PROCESS, cross-session dynamic lock backed by on-disk files.

## Model

- **A lease = one JSON file** per `(repo-root, repo-relative path)` under
  `~/.openclaw/run/orca-leases/<repo-slug>/<path-slug>.lease`. Keyed by repo-root
  **plus** repo-relative path — basename alone collides.
- **Claim** = `fs.linkSync(tmp, file)` — the record is fully written to a temp
  file then linked into place in ONE atomic step that also fails `EEXIST` if the
  slot is taken. That is the sole grant point: atomic content **and** O_EXCL-style
  mutual exclusion. **Replace** (refresh / steal) = `fs.renameSync` — atomic, so a
  reader sees the complete old or complete new file, never a torn write.
- **Staleness**: a held lease is reclaimable when `now > acquiredAt + ttlMs`, OR
  (opt-in, real positive pid only) when its holder process is dead on this host.
- **pid 0 = TTL-governed.** The hook/CLI records pid 0 because the owner is a
  _session_ that outlives the ephemeral `node lease-core.mjs` process — there is
  no live pid to probe. Pid-liveness reclaim is reserved for a long-lived
  in-process holder that anchors the lease to its own pid (`--pid N`).
- **Stealing is serialized** by a short per-lease `O_EXCL` `.lock` (stale-reclaimed
  after 5 s), so two acquirers cannot both steal one stale lease (no double-grant).

## Surfaces (one source of truth: `lease-core.mjs`)

- **Library**: `acquire / release / releaseAllByOwner / status / list / gc / gcAll / renew`.
- **CLI** (`node lease-core.mjs <cmd> …`): exit `0`=allowed/ok, `3`=DENIED,
  `1`=usage/infra error. Output is always JSON on stdout.
- **Plugin RPCs** (`index.ts`): `orca.lease.acquire/release/status/list` + a
  `gcAll()` janitor (only under `registrationMode === "full"`). For Jarvis / the
  ORCA workflow.
- **Hook** (`enforce-file-lease.sh`): PreToolUse `Edit|Write|MultiEdit` claims;
  `Stop` releases all; modes `off|warn|enforce` (default `warn`); **fail-open** on
  any error. See `extensions/tinkerclaw-orca/README.md` for activation.

## Don't-regress

- **Never** make lease writes non-atomic again (plain `fs.writeFileSync` →
  torn reads → `readLease()` null → `isStale(null)` true → a LIVE lease stolen
  with no TTL expiry). Claims use `linkSync`, replaces use `renameSync`.
- **Never** release leases on `SubagentStop` — only `Stop`.
- The hook must stay **fail-open**: leasing makes editing safer, never impossible.
- The hook lives in the **tracked** extension dir, not gitignored `.claude/`.
