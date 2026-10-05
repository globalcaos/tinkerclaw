---
name: fork-scanner
description: "Ranks a GitHub repository's forks to surface changes worth reviewing: pages the fork list via the GitHub API, scores commit messages by keyword, then shallow-clones the top candidates and diffs them against upstream, writing Markdown/CSV/JSON reports and a SQLite watchlist. Use when asked which forks of a repo are worth a look."
---

# fork-scanner

## What this is

A Python CLI that surveys every fork of one GitHub repository and ranks them, so
a maintainer can find the handful carrying changes worth reading. It works in
three tiers, each narrowing the set:

- **Tier 1 — metadata.** Pages `/repos/{repo}/forks`, then calls the compare API
  per fork to get commits ahead/behind. Keeps forks with stars, commits ahead, or
  a push in the last 180 days.
- **Tier 2 — commit messages.** Fetches up to 100 commits per surviving fork and
  scores the _message text_ against a keyword table (`security`/`CVE`/`injection`
  score 10, features 5, optimisations 4, fixes 3), then multiplies by stars,
  recency and commits-ahead.
- **Tier 3 — diff.** Shallow-clones the top 200 by score, adds the upstream
  remote, diffs fork HEAD against upstream, and records a "gem" per category it
  can match in the diff text. The clone is deleted after each fork.

Results land in SQLite (`forks`, `commits`, `gems`, `watchlist`, `run_history`)
and are rendered as reports. A watchlist auto-collects forks above a score or gem
threshold, and can also be edited by hand.

Scoring is keyword matching on text, not semantic analysis — it ranks candidates
for a human to read, and a fork with terse commit messages will score low
regardless of what it actually changed.

## When to use / when not to

Use it when the operator asks which forks of a repo are worth reviewing, wants a
periodic report on fork activity, or wants to track specific forks over time.

Do not use it to sync or merge anything: it has no write path to GitHub and does
not open PRs, push, or modify the local repository. Do not use it for a one-off
look at a single known fork — a `git fetch` and `git diff` is cheaper than a full
tier run. It targets exactly one upstream repo per run, set by `UPSTREAM_REPO`.

The sibling `skills/fork-and-skill-scanner-ultimate/` is documentation only; this
directory holds the working code.

## Setup

```bash
pip3 install -r requirements.txt          # requests; markdown + weasyprint only for PDF
export UPSTREAM_REPO="owner/repo"         # defaults to openclaw/openclaw
export GITHUB_TOKEN="..."                 # optional; without it the API allows 60 req/hour
```

**Known defect — the database schema does not load as shipped.**
`scripts/database.py` looks for `schema.sql` next to itself, but the file sits at
the directory root. The lookup fails silently, so the first insert dies with
`no such table: forks`. Verified by running it. Copy the file before the first
run:

```bash
cp schema.sql scripts/schema.sql
```

## Commands

All commands run from `scripts/`. Entry point is `fork_scanner.py`.

```bash
python3 fork_scanner.py                       # all three tiers, then reports
python3 fork_scanner.py --tier1-only          # metadata pass only
python3 fork_scanner.py --tier2-only          # commit scoring only
python3 fork_scanner.py --tier3-only          # clone + diff the current top 200
python3 fork_scanner.py --update-watchlist    # refresh watchlist after the run
python3 fork_scanner.py --no-report           # skip report generation

python3 fork_scanner.py --show-watchlist
python3 fork_scanner.py --add-to-watchlist owner/repo \
    --watchlist-reason "why" --watchlist-priority 9
python3 fork_scanner.py --remove-from-watchlist owner/repo

python3 test_system.py                        # component check, makes no API calls
```

Tiers are incremental: a fork checked within the last 24 hours is skipped, so
reruns are cheap. Tuning (keywords, thresholds, tier sizes, rate-limit floor)
lives in `scripts/config.py`.

`../setup_cron.sh [daily|weekly|custom]` installs crontab entries — read the
warning under Permissions before running it. `../example_usage.sh` only prints
example commands; it executes nothing.

## What is in this directory besides the scanner

`ARCHITECTURE.md`, `QUICKSTART.md` and `DELIVERY_SUMMARY.md` document the system
above. The remaining files are not read by any script:

- `fork-report-spec.md` — a design for a newspaper-style briefing format. It is
  **not implemented**; `reporter.py` emits a plain table-based Markdown report.
- `2026-02-08_001_fork-sync-comprehensive.md`, `2026-02-08_fork-report-data.md` —
  two dated example briefings in that unimplemented format.
- `skill-downloads-sample.json` — self-declared sample download counts for
  ClawHub skills, unrelated to fork scanning.

## Permissions & Data Flow

**Network.** Required. It calls `api.github.com` (fork list, repo metadata,
compare, commits, rate limit) and, in Tier 3, `git clone` / `git fetch` over
HTTPS from `github.com`. Nothing else is contacted.

**Credentials.** `GITHUB_TOKEN` is read from the environment and sent as an
`Authorization` header to `api.github.com` only. It is optional and the scanner
never writes it to disk. **`setup_cron.sh` does:** it interpolates the token
literally into the crontab line, leaving it in plaintext in the operator's
crontab, and it uses `sudo` to create and chown `/var/log/fork_scanner`.

**Reads.** The GitHub API responses above, its own SQLite database, and
`schema.sql`. It does not read the surrounding repository or any local files
outside its own directory.

**Writes.** All under `scripts/`, created on import of `config.py`:

- `data/forks.db` — fork metadata, commit messages, gems, watchlist, run history
- `data/clones/<repo>` — shallow clones during Tier 3, deleted after each fork
- `reports/report_*.md`, `forks_*.csv`, `data_*.json`, and `report_*.pdf` when
  weasyprint is installed
- `fork_scanner.log`

**Writes to GitHub.** None. There is no code path that pushes, opens a pull
request, comments, or changes any setting.

**Worth knowing.** Tier 3 clones arbitrary third-party repositories onto the
machine. Their contents are diffed as text and deleted afterwards, never
executed or built — but untrusted code does touch the disk while it runs.
