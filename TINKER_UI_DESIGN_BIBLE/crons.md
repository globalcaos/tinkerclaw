---
file: crons.md
purpose: Cron registry — every job, schedule, purpose, status, last-run; plus the auto-merge policy
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — cron facts live here. The actual job config is in ~/.openclaw/cron/jobs.json (auto-extractable).
see_also: topology.md (where cron runs), failures.md (M9 auto-merge regressions)
verify:
  - name: daily-fork-sync cron is DISABLED (per J15 §5 — re-enable only after merge gate ships)
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/cron/jobs.json"))); job = next((j for j in cfg.get("jobs", []) if j.get("id") == "daily-fork-sync"), None); assert job is None or not job.get("enabled", False)'
  - name: morning-briefing cron has at least one receipt
    cmd: python3 -c 'import os; p = os.path.expanduser("~/.openclaw/cron/runs/morning-briefing.jsonl"); assert os.path.getsize(p) > 0'
  - name: model-rank-refresh cron is registered
    cmd: python3 -c 'import json,os; cfg = json.load(open(os.path.expanduser("~/.openclaw/cron/jobs.json"))); assert any(j.get("id") == "model-rank-refresh" for j in cfg.get("jobs", []))'
---

# Cron registry + auto-merge policy

## Job registry

Source: `~/.openclaw/cron/jobs.json`. Receipts: `~/.openclaw/cron/runs/<job>.jsonl`.

| Job id                   | Schedule    | Purpose                                                                                                                       | Status        | Notes                                                                                                  |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `morning-briefing`       | 07:00 daily | writes `memory/morning-briefings/YYYY-MM-DD.md` cumulative pass                                                               | enabled       | audit artifact; user `/new` is pass-1 (see M8 in failures.md)                                          |
| `model-rank-refresh`     | 06:30 daily | fetches Artificial Analysis leaderboard, updates `agents.defaults.models[*].rank` in openclaw.json                            | enabled       | skill: `~/.openclaw/workspace/skills/model-rank-refresh/SKILL.md`                                      |
| `people-profiles`        | every hour  | scans last hour of WhatsApp inbound, generates/updates `memory/people/<slug>/profile.md` for new aliases                      | enabled       | session: `agent:main:cron:people-profiles:profile:<slug>` per profile                                  |
| `life-butler`            | hourly      | (TBD — confirm purpose)                                                                                                       | enabled       | session: `agent:main:cron:life-butler`                                                                 |
| `cleaning-lady`          | daily       | memory consolidation pass, removes stale fragments                                                                            | enabled       |                                                                                                        |
| `fork-scanner`           | daily       | scans tinkerclaw + jarvis-workspace for new untracked memory artifacts and surveys upstream forks                             | enabled       |                                                                                                        |
| `marketplace-watcher`    | daily       | scans ClawHub / agent marketplaces for new skills relevant to the user                                                        | enabled       |                                                                                                        |
| `online-engagement`      | daily       | engagement state JSON refresh for online-presence                                                                             | enabled       |                                                                                                        |
| `security-updates-check` | daily       | OS / npm package security updates                                                                                             | enabled       |                                                                                                        |
| `self-evolution`         | daily       | self-improvement loop (Jarvis introspects on what to learn next)                                                              | enabled       |                                                                                                        |
| `spiritual-tech`         | daily       | spiritual-tech interests refresh                                                                                              | enabled       |                                                                                                        |
| `wind-down`              | nightly     | end-of-day digest + memory consolidation handoff                                                                              | enabled       |                                                                                                        |
| `engram-consolidate`     | 04:00 daily | ENGRAM sleep-consolidation: strategy-switch (U4) + skill-extraction (U6) + recipe-evolution (U1) + reconciliation (U8, gated) | **code-only** | descriptor in src, NOT in jobs.json — fired via RPC by the prompt-cron (see §engram-consolidate below) |
| `daily-fork-sync`        | daily       | **DISABLED 2026-05-09** — merges upstream + ships if pnpm build passes                                                        | **DISABLED**  | re-enable only after J15 merge gate ships                                                              |

Auto-extractable: ID, schedule, enabled. The Purpose/Notes columns are hand-written.

## Last-run probe

Today: `tail -1 ~/.openclaw/cron/runs/<job>.jsonl` returns the last receipt as JSONL.

Proposed `cron.lastRun({jobId})` RPC (see `probes.md`) would return:

```json
{
  "jobId": "morning-briefing",
  "startedAt": "2026-05-11T07:00:00+02:00",
  "endedAt": "2026-05-11T07:08:42+02:00",
  "exitCode": 0,
  "outcome": "ok",
  "outputTail": "...",
  "sessionKey": "agent:main:cron:morning-briefing"
}
```

## Cron session naming convention

Sessions spawned by a cron job follow `agent:main:cron:<jobId>` (single-shot job) or `agent:main:cron:<jobId>:<sub>:<slug>` (per-item job, e.g. people-profiles).

Cron sessions are SKIPPED by the restart-recovery main-session path (`shouldSkipMainRecovery` filters on `isCronSessionKey`). They have their own restart semantics: the cron scheduler re-fires on next schedule rather than resuming mid-turn.

## engram-consolidate — ENGRAM nightly sleep-consolidation (U1/U4/U6/U8)

```yaml
status: DEPLOYED (code descriptor + on-demand RPC); NOT in the stored jobs.json registry
last_verified: 2026-06-02
last_verified_commit: 06f8647fdc
see_also: subagents-and-recipes.md (recipe/skill stores), memory-layout.md (engram root), config-shape.md (ENGRAM_RECONCILE gate)
verify:
  - name: engram-consolidate cron descriptor source exists
    cmd: python3 -c 'import glob,os; assert glob.glob(os.path.expanduser("~/src/tinkerclaw/src/cron/jobs/engram-consolidate.ts"))'
  - name: U4 strategy-switch read RPC (what this cron produces into) is live
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.strategy.switch.list"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
```

**The 12-upgrade procedural-evolution lane runner.** Added on `develop` 06f8647fdc (Sleep Consolidation paper, Upgrades 1/4/6/8). One nightly pass over every per-session ENGRAM event store that runs `runSleepConsolidation` (`src/memory/engram/sleep-consolidation.ts`) with four evolution lanes injected. Source: `src/cron/jobs/engram-consolidate.ts` (descriptor `engramConsolidateJob`, entry `runEngramConsolidate`).

### Registration model (IMPORTANT — not a jobs.json row)

The fork has **no coded cron scheduler registry** — its crons are prompt-driven (see `self-evolution-cron.ts`). So unlike every row in the registry table above (which lives in `~/.openclaw/cron/jobs.json`), `engram-consolidate` is **NOT** registered there. The `engramConsolidateJob` descriptor is instead reachable at runtime through the gateway RPC **`fork.engram.consolidate.run`** (`src/fork/memory-rpc.ts`), which the prompt-cron / Jarvis calls on the descriptor's schedule. The descriptor carries `schedule: "0 4 * * *"` (04:00 nightly — the canonical sleep slot); that string is the _intended_ cadence the prompt-cron honors, not a value the upstream `stored-CronJob` scheduler reads. The module deliberately does NOT mutate any registry (single-owner: registry edits belong to a Wire phase that, for this fork, is the prompt-cron, not jobs.json).

This is why the registry table marks it **code-only**: the source + on-demand RPC are deployed and verified live on 06f8647fdc, but a `grep engram-consolidate ~/.openclaw/cron/jobs.json` returns nothing — that absence is expected, not a missing-registration bug.

### What it produces (per nightly pass)

The deps are built once and shared across all sessions (so a strategy/skill/recipe recurring in multiple sessions accrues a single global history):

- **U4 strategy switches** — one shared `FailureStateMap` (loaded by `loadFailureStateMap`, mutated in place by the failure-count→strategy-switch loop, persisted by `saveFailureStateMap`). Gated switch _proposals_ are appended to the daily evolution manifest. Read surface: `fork.strategy.switch.list/apply/review`.
- **U6 extracted skills** — a never-delete `SkillLibrary` (`createSkillLibrary`, same store `fork.skill.search` reads) plus a deterministic no-LLM `defaultSkillExtractor`. The strict `isSkillWorthy` gate (completed, tool-using episode with ≥1 keyDecision) means today's `detectEpisodes` (emits `keyDecisions:[]`) extracts **zero** skills — byte-identical to pre-wiring — but the lane is live. An embed fn for semantic search is resolved exactly like `fork.prefrontal.embed`; absent provider → keyword fallback.
- **U1 recipe mutations** — a `RecipeArchive` (`createRecipeArchive`) so recipe-tagged episodes accrue Laplace-smoothed fitness + gated mutation _proposals_ into the daily manifest. (`RECIPE_AUTOAPPLY_ENABLED` is already true; see config-shape.md.)
- **U8 reconciliation decisions** — **dark-launched OFF**: only constructed when `ENGRAM_RECONCILE === "true"` (default unset → today's behavior). Even when on, the default `createAlwaysAddReconciler()` ADDs every event (nothing reconciled away), backed by a persisted ledger at `<engram>/reconciliation-ledger.json`. Result counts `reconciliationDecisions.{updated,deleted}` stay 0 with the default reconciler.

**Safe-default invariant:** absence of a backend (no embed provider, `ENGRAM_RECONCILE` unset, declining extractor) leaves consolidation output exactly as it was before this wiring — every lane is opt-in / no-op-by-default.

### Outputs on disk

- **Daily evolution manifest** (gated proposals, human-in-the-loop): `<engram>/recipe-mutations/<YYYY-MM-DD>.jsonl` — JSONL with a `type` discriminator (`recipe_mutation` | `strategy_switch`); written by `evolution-manifest.ts`. This is the single audit surface (paper §7.1); proposals are NOT auto-applied.
- **Cursors persisted atomically** at run end: `<engram>/consolidation-state.json` (per-session consolidation state) and the failure-state map.
- **Skill library** + **reconciliation ledger** as above.

`<engram>` = `$OPENCLAW_HOME/.openclaw/engram` (default `~/.openclaw/engram`). The `run` is idempotent; a `baseDir` param redirects the ENGRAM root for tests. Result summary (logged): `sessions / episodes / events / switches / skills / recipeMutations / reconcile`.

## Auto-merge policy (currently DISABLED)

The `daily-fork-sync` cron implements upstream-merge automation. It is DISABLED as of 2026-05-09 because the build-only gate failed to catch behavioral regressions (today's case study, see bible §11.6c/d/e).

### What it did when enabled

1. `git fetch upstream main`
2. A synthetic-base 3-way merge with conflict auto-resolution rules:
   - **TIER1 files** — paths the fork patches directly. On conflict, prefer fork.
   - **TIER2 files** — paths the fork modifies trivially. On conflict, prefer 3-way merge.
   - **TIER3 files** — upstream-only. Always prefer upstream.

   > **Pinned synthetic ancestor (S3, 2026-06-02).** A plain `git merge upstream/main` is a worst case here: the fork and `upstream/main` are **disjoint** (`git merge-base HEAD upstream/main` is EMPTY), so every differing file becomes an add/add conflict — the conflict multiplier. The TIER2 "prefer 3-way merge" rule now resolves against the **`upstream-base`** tag (pinned at the upstream content-anchor the fork carries; S3 = `7b07a0ab8fd`) as the explicit synthetic common ancestor, via `scripts/merge-drivers/upstream-3way.sh`. After each successful sync the cron **advances** `upstream-base` to the merged upstream commit (`git tag -f upstream-base <sha>`) and records the new SHA in its receipt. Full convention: `branch-policy.md` §4.

3. Apply fork patch functions for files the fork augments (not replaces).
4. `pnpm build`.
5. If build passes → commit + push to `tinkerclaw/develop`.
6. Otherwise → emit conflict report to memory and stop.

### Why it stopped being enough

Build-passing ≠ behavior-preserving. Three classes of silent regression:

- **Type A — fork handler wiped.** Upstream rewrote `server-methods.ts`, dropped the fork's added imports. Build still passes (no compile error). The RPC just returns `unknown method` on next call. (M3)
- **Type A — patch silently inverted.** A fork patch that adds a line near an upstream-rewritten block can land in the wrong place. Build passes; behavior is wrong.
- **Type A — config schema field dropped.** Upstream's plugin manifest validation tightened; fork's older manifests crash boot. (M6)

### The path forward (J15 §5 merge gate)

After merge + build, run `pnpm test:invariants`. Each section in the bible directory with `status: DEPLOYED` carries `verify` commands. The suite runs every command and refuses the merge if any newly-failing.

The gate is not yet wired. Until it is, `daily-fork-sync` stays disabled; merges happen manually with eyes on.

## SLO observations (informal)

- Most jobs run < 60s. The exception is `people-profiles` (per-profile parallel runs, each ~10–80s, capped at maxConcurrent=6).
- `morning-briefing` runs ~5–10 minutes when preflight is healthy.
- `daily-fork-sync` (when it was enabled) typically ran 2–5 minutes for clean merges, up to 30 minutes when patches needed manual review.

## Don't regress

- Cron sessions MUST NOT trip the main-session restart-recovery path. They are filtered out by `shouldSkipMainRecovery`; the filter rules are in `src/agents/main-session-restart-recovery.ts`.
- The `daily-fork-sync` job must stay DISABLED until the J15 merge gate ships. Documented in jobs.json + bible.
- When adding a new cron, follow the session naming convention; otherwise the people-profiles 7-second storm bug recurs (memory note `cron-people storm every 7s`).

## Verify

```yaml
verify:
  - cmd: jq -r '.jobs[] | select(.id == "daily-fork-sync").enabled' ~/.openclaw/cron/jobs.json
    expect: "false"
  - cmd: jq '.jobs | length' ~/.openclaw/cron/jobs.json
    expect: "integer > 0"
```
