# Structural crons — the habits that ship with the repo

An agent runtime is an engine. What makes this fork feel _alive_ is not the engine, it is
the handful of jobs that run every night while nobody is watching: it consolidates what it
learned that day, tidies its own workspace, checks itself for security updates, refreshes
which models are worth using, and reads up on what the rest of the field shipped.

For a long time none of that travelled with a `git clone`. The engine did; the habits lived
in one machine's private cron store, pointing at routine files under a personal workspace
that ship nowhere. A cloner got a car with no driver, and no way to know a driver existed.
These files are the fix.

## What is here

One directory per job:

| file              | what it is                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `<id>/routine.md` | The full brief the agent executes. Self-contained, plain language, meant to be read before you switch the job on. |
| `<id>/job.json`   | The schedule and payload skeleton the seeder installs.                                                            |

| job                      | when (UTC) | what it does                                                                                                           |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `memory-consolidation`   | 04:15      | Reads the day's notes and log, files what is worth keeping into long-term notes, writes a reflection.                  |
| `self-evolution`         | 04:30      | Scans vendor blogs, model releases and agent techniques; updates a running picture of the field.                       |
| `security-updates-check` | 05:00      | Read-only sweep: pending OS updates, dependency advisories, open ports, plaintext credentials. Reports; never patches. |
| `fork-scanner`           | 05:15      | Surveys OpenClaw forks and open-source agent projects; extracts techniques worth adopting.                             |
| `cleaning-lady`          | 05:30      | Workspace hygiene. Archives stale material. Never deletes.                                                             |
| `model-rank-refresh`     | 05:45      | Refreshes model scores and rank order so the model picker and router stay current.                                     |

## Installing them

```bash
pnpm tinker:crons -- --list       # what ships, and what you already have
pnpm tinker:crons                 # install the missing ones, switched ON
pnpm tinker:crons -- --disabled   # install them, switched off
```

`scripts/setup.sh` asks once during a fresh install and defaults to **on**, so a fresh clone
behaves like a mature one instead of like an empty shell.

The seeder is idempotent: it matches on job id and name, never edits a job it did not create,
and is safe to re-run after every `git pull` — that is how you pick up jobs added upstream
later. It talks to the cron CLI, which needs a running gateway; if the gateway is down it
tells you and exits without changing anything.

## What they cost, and how to stop them

They arrive **on**, because a self-maintaining fork whose self-maintenance ships switched off is
one whose best feature nobody ever meets — you would have to already know the jobs existed to go
looking for them.

The cost is real and worth stating plainly rather than hiding behind a safe default: each job
wakes an agent on a schedule and spends model tokens on **your** account. The whole nightly cycle
runs to roughly one euro a night on a typical setup. Every routine is written to be read, and
switching any of them off is one command:

```bash
openclaw cron list --all          # find the id (--all, or disabled jobs are hidden)
openclaw cron disable <id>
```

Install them idle instead with `pnpm tinker:crons -- --disabled`.

## Making one your own

Routines resolve in this order, so your edits survive `git pull`:

1. `~/.openclaw/workspace/crons/<id>/routine.md` — your version
2. `~/.openclaw/workspace/scripts/cron-<id>-prompt.txt` — legacy override location
3. `extensions/tinkerclaw-tinker-bridge/crons/<id>/routine.md` — the bundled default

Copy the bundled routine to path 1 and edit it there. Never edit it in the repo; the same
git-pull contract applies here as to `SOUL.md` and `BRIEFING.md` (see `FORK_SETUP.md`).

## Safety rules every bundled routine follows

- **Read-only means read-only.** The security sweep reports; it does not apply updates.
- **Archive, never delete.** Hygiene moves things aside; nothing is destroyed.
- **No outbound.** These jobs do not send, publish, or message anyone.
- **Degrade quietly.** A fresh install has almost nothing to work on. Missing inputs are a
  normal first-run outcome: the job says so in its report and exits cleanly.
- **Never a silent night.** A dying or partial run still leaves a stub report with a status
  line, because a partial report beats no report.

Reports land in `~/.openclaw/cron/reports/<YYYY-MM-DD>/<id>.md`.
