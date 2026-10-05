# Cleaning Lady — Workspace Hygiene

## Purpose

Once a night, walk the agent workspace and keep it liveable: move genuinely stale session
files out of the way into a dated archive, measure the logs and caches that are quietly
eating the disk, and flag links that point nowhere and files nothing references any more.
This job **archives, it never deletes**, and it changes as little as possible — its real
output is a short report the operator can read over coffee. It runs unattended, at night,
with nobody watching, so every step is written to fail safe: when something is missing or
ambiguous, say so in the report and move on rather than guessing.

## Steps

Perform these in order. If a step's inputs do not exist, record one line about it in the
report and continue — a fresh install where almost nothing exists yet is a **normal**
outcome, not an error.

1. **Set up.** Compute today's date as `YYYY-MM-DD` in the job's timezone. Create
   `~/.openclaw/cron/reports/<YYYY-MM-DD>/` if needed and immediately write a stub
   `cleaning-lady.md` there with a `Status: started` line. You overwrite it at the end;
   it is the guarantee that a crashed run still leaves a trace.

2. **Locate the roots.** The areas this job cares about, if they exist:
   `~/.openclaw/workspace/`, `~/.openclaw/sessions/`, `~/.openclaw/logs/`,
   `~/.openclaw/cron/reports/`, `~/.cache/` entries owned by this tool, and any `tmp/` or
   `scratch/` directory inside the workspace. Test each for existence. Record which roots
   are absent; do not create them.

3. **Find stale sessions.** In the sessions root, list items whose modification time is
   older than **30 days**. Judge staleness only by modification time — never by name,
   contents, or what "looks old". Skip anything touched in the last 30 days, anything held
   open by a running process (if you can tell), and any path containing `active`,
   `current`, or `pinned`.

4. **Archive them.** `mv` each stale item to
   `~/.openclaw/archive/cleaning-lady/<YYYY-MM-DD>/`, preserving its path relative to the
   sessions root so it can be put back by hand. Create that directory as needed. Move at
   most **200 items or 2 GB** per run; on hitting either cap, stop moving and report how
   many were left for tomorrow. Never delete, rewrite, or compress in place. If a move
   fails (permissions, busy file), leave the file alone and note it.

5. **Measure logs and caches.** Report — **do not touch** — any single log file over
   **50 MB**, any log directory over **500 MB**, and any cache directory over **1 GB**.
   Give sizes in human units and say how old the newest entry is, so the operator can tell
   live from abandoned. What to do about them is the operator's call, not this job's.

6. **Flag broken links.** Inside the workspace, find symlinks whose target does not
   resolve, then check relative local-path links in the workspace's own markdown files and
   flag those with nothing at the other end. Cap at the first **50** findings and say how
   many more there were. Fix nothing — a broken link is often a file that moved on purpose.

7. **Flag orphans.** Report files in `tmp/` or `scratch/` areas older than **14 days**, and
   archive directories from previous runs of this job older than **90 days**. Reported
   only. The operator decides whether they are garbage or someone's work in progress.

8. **Write the report.** Replace the step-1 stub with the final report described below,
   then confirm the file exists and is non-empty.

9. **Finish.** Exit cleanly with a short summary. If nothing needed archiving and nothing
   crossed a threshold, that is a good night: say so in one line.

## Report

Write to `~/.openclaw/cron/reports/<YYYY-MM-DD>/cleaning-lady.md`.

If the run is dying, blocked, or only partly finished, it **must still leave a stub report
with a status line** naming what it did and where it stopped. A silent night is worse than
a partial one: the operator reads a missing report as "the job is broken", while
`Status: partial — archived 4 sessions, then could not read the logs directory` is
immediately useful.

Keep it human-readable. Each bullet is a short plain-language line a non-engineer could
follow — "moved 12 chat sessions older than a month into today's archive folder", not a
dump of file paths. Give a path only where the operator needs one to act. Never put
credentials, tokens, or file contents into the report.

Shape:

```
# Cleaning Lady — <YYYY-MM-DD>

Status: ok | partial | nothing-to-do | blocked
Ran for: <duration>

## What I did
- ...

## Worth a look
- ...

## Skipped
- ...
```

`What I did` covers archiving. `Worth a look` covers oversized logs and caches, broken
links, and orphans. `Skipped` covers absent roots, files that could not be moved, and caps
that were hit. Aim for under 30 bullets; if a category is huge, give the count and the
worst five.

## Safety

This job runs unattended with nobody watching. It may **not**:

- **Delete anything.** No `rm`, no truncation, no emptying of caches or logs. Archiving is
  a move; if a move would overwrite something at the destination, skip it and report.
- **Modify file contents.** Steps 5–7 are strictly read-only. The only writes in the whole
  job are the archive moves in step 4 and the report itself.
- **Touch anything outside `$HOME`** — and inside `$HOME`, only the step-2 roots plus the
  archive and report directories. No system paths, no other users, no mounted volumes.
- **Send, publish, or post anything.** No email, chat message, upload, or third-party API
  call. The report on disk is the entire delivery mechanism.
- **Spend money.** No paid API calls, no spawning other agents, no scheduling follow-ups.
- **Restart, stop, or reconfigure services** — not the gateway, not a daemon, not cron
  itself. Something that looks broken is a line in the report, not an action.
- **Touch git.** No commit, push, branch, stash, or checkout.
- **Read credentials.** Skip anything that looks like a secret (`.env`, `*.key`, `*.pem`,
  `credentials*`, token or auth stores): count and size them, never open, archive, or name
  them in full.
- **Invent work.** If the workspace is clean, the right output is a two-line report saying
  so. Padding a quiet night with speculative findings trains the operator to stop reading.

When a step is genuinely blocked, stop that step, record what blocked it, and continue with
the rest. Do not improvise a workaround or widen scope to "fix" what you find.

## Don't-regress

- **This file is self-contained.** It must never be reduced to a pointer at another
  document or a path that exists on only one machine. Instructions change here.
- **It stays generic.** No personal names, real host paths, company or place names, private
  URLs, or credentials. Paths use `~` or `$HOME`; the human is "the operator".
- **Archive, never delete** — including under any future "just clear the obvious junk"
  temptation. A wrong archive costs one move back; a wrong delete is permanent.
- **Always leave a report**, including on failure and on the first run of an empty machine.
  Status line first.
- **A missing input is a normal case.** Never error out, never create the missing thing,
  never fabricate findings to make the report look substantial.
- **Thresholds stay conservative** (30-day stale, 50 MB / 500 MB / 1 GB size flags, 14- and
  90-day orphan ages, 200-item / 2 GB move cap). Lowering them turns a quiet janitor into a
  nightly file-shuffling machine the operator has to audit.
