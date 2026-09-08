# Cron Report Contract (day-0)

Copied into `~/.openclaw/workspace/CRON-REPORT-CONTRACT.md` on first setup if missing.
Every bundled structural cron already requires a report. This is that report.

## The one rule

Report **only what changed**, what broke, and what needs a decision. Never explain
the system. Never restate the task. A quiet night is a one-line headline and zero bullets.

## Layer 1 — the file

```
~/.openclaw/cron/reports/<YYYY-MM-DD>/<job-id>.md
```

Date = local date the run **started**. Create the directory if needed. Overwrite
your own file on a re-run (last run of the day wins).

```markdown
---
job: <id>
ran: <ISO timestamp>
status: ok | partial | failed | nothing-to-do
headline: <one line, the single most important thing>
---

- FOUND: …
- WATCH: …
- ACT: …
- BROKE: …
```

A stub with `status: partial` beats a silent night. If you can only do one thing
before dying, write the stub.

## Hard limits

- No outbound (no send, no publish, no message).
- No delete. Archive if the job's own routine allows it.
- No credentials, tokens, or file dumps in the report.
- A missing input on a fresh install is a normal first run, not an error.
