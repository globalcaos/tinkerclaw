---
file: crons.md
purpose: Cron registry — every job, schedule, purpose, status, last-run; plus the auto-merge policy
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — cron facts live here. The actual job config is in ~/.openclaw/cron/jobs.json (auto-extractable).
see_also: topology.md (where cron runs), failures.md (M9 auto-merge regressions)
---

# Cron registry + auto-merge policy

## Job registry

Source: `~/.openclaw/cron/jobs.json`. Receipts: `~/.openclaw/cron/runs/<job>.jsonl`.

| Job id                   | Schedule    | Purpose                                                                                                  | Status       | Notes                                                                 |
| ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `morning-briefing`       | 07:00 daily | writes `memory/morning-briefings/YYYY-MM-DD.md` cumulative pass                                          | enabled      | audit artifact; user `/new` is pass-1 (see M8 in failures.md)         |
| `model-rank-refresh`     | 06:30 daily | fetches Artificial Analysis leaderboard, updates `agents.defaults.models[*].rank` in openclaw.json       | enabled      | skill: `~/.openclaw/workspace/skills/model-rank-refresh/SKILL.md`     |
| `people-profiles`        | every hour  | scans last hour of WhatsApp inbound, generates/updates `memory/people/<slug>/profile.md` for new aliases | enabled      | session: `agent:main:cron:people-profiles:profile:<slug>` per profile |
| `life-butler`            | hourly      | (TBD — confirm purpose)                                                                                  | enabled      | session: `agent:main:cron:life-butler`                                |
| `cleaning-lady`          | daily       | memory consolidation pass, removes stale fragments                                                       | enabled      |                                                                       |
| `fork-scanner`           | daily       | scans tinkerclaw + jarvis-workspace for new untracked memory artifacts and surveys upstream forks        | enabled      |                                                                       |
| `marketplace-watcher`    | daily       | scans ClawHub / agent marketplaces for new skills relevant to the user                                   | enabled      |                                                                       |
| `online-engagement`      | daily       | engagement state JSON refresh for online-presence                                                        | enabled      |                                                                       |
| `security-updates-check` | daily       | OS / npm package security updates                                                                        | enabled      |                                                                       |
| `self-evolution`         | daily       | self-improvement loop (Jarvis introspects on what to learn next)                                         | enabled      |                                                                       |
| `spiritual-tech`         | daily       | spiritual-tech interests refresh                                                                         | enabled      |                                                                       |
| `wind-down`              | nightly     | end-of-day digest + memory consolidation handoff                                                         | enabled      |                                                                       |
| `daily-fork-sync`        | daily       | **DISABLED 2026-05-09** — merges upstream + ships if pnpm build passes                                   | **DISABLED** | re-enable only after J15 merge gate ships                             |

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

## Auto-merge policy (currently DISABLED)

The `daily-fork-sync` cron implements upstream-merge automation. It is DISABLED as of 2026-05-09 because the build-only gate failed to catch behavioral regressions (today's case study, see bible §11.6c/d/e).

### What it did when enabled

1. `git fetch upstream main`
2. `git merge upstream/main` with conflict auto-resolution rules:
   - **TIER1 files** — paths the fork patches directly. On conflict, prefer fork.
   - **TIER2 files** — paths the fork modifies trivially. On conflict, prefer 3-way merge.
   - **TIER3 files** — upstream-only. Always prefer upstream.
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
