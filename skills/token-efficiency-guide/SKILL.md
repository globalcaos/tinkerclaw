---
name: token-efficiency-guide
version: 1.2.0
description: "Reference material, not an executable tool: one document (GUIDE.md) with ten concrete steps for cutting OpenClaw token consumption on a Claude subscription — heartbeat model, session compaction, cron model and frequency, bash-ified crons, workspace file size, cache retention. Read it when asked why token usage is high or how to lower it."
---

# Token Efficiency Guide

## What this is

A single markdown document, `GUIDE.md`. There is no script, no CLI and no other
file in this directory — nothing here executes. It is written for an operator
running OpenClaw against a Claude subscription who is exhausting the weekly
limit, and it lists ten changes with the config snippets or shell commands the
operator applies by hand.

The ten steps, in the order the guide gives them:

1. Set the heartbeat model to Haiku (`agents.defaults.heartbeat.model` in `openclaw.json`).
2. Compact sessions and control context growth (`/compact`, a manual reset after big tasks).
3. Rewrite cron jobs that are pure logic as bash scripts on the system crontab.
4. Set the remaining cron jobs to Sonnet via a `model` field in the job payload.
5. Keep large command output out of the main session (sub-agents; `head`/`grep`/`wc -l`).
6. Lower cron frequency, with a small table of interval swaps.
7. Shrink the workspace files that are injected into every message, with a
   `wc -c` measuring snippet and a target of under 15 KB total.
8. Enable `cacheRetention: "long"` in the model params.
9. Coordinate time blocks when several agents share one subscription.
10. Do housekeeping in bash instead of the LLM, with one session-archiver script
    that is a dry run unless given `--apply`.

Each step carries a percentage saving and the closing table totals them to
"~80-90%". Those figures are the author's own estimates — the document shows no
measurement or methodology behind them, so treat them as ordering hints (step 1
matters more than step 9), not as numbers to quote. The guide states it is
compatible with OpenClaw 2026.2+.

## When to use / when not to

Use it when:

- The operator asks why token or subscription usage is high, or how to bring it down.
- A weekly or 5-hour limit is being hit and the causes have to be enumerated.
- Deciding which model a heartbeat or a cron job should run on.
- Auditing the size of the workspace files that ship with every message.
- A cron job is being written and the question is whether it needs an LLM at all.

Do not use it for:

- Measuring current usage. It contains no telemetry, no counters and no reporting.
  It cannot tell anyone what is being spent right now.
- Applying anything automatically. Every change in it is manual.
- Provider pricing, rate-limit APIs, or billing questions — none are covered.
- Anything outside OpenClaw's own config, sessions, crons and workspace files.

## Entry points

There is one:

```
skills/token-efficiency-guide/GUIDE.md
```

Read it. That is the whole interface. The code blocks inside it are meant to be
copied by the operator into `openclaw.json`, into `AGENTS.md`, or into
`crontab -e`; nothing in this directory does that on its own.

Two details worth knowing before quoting the file:

- Section 10 gives one complete script, a session archiver. It is the only
  maintenance script in the guide; the guide recommends no backup, upload,
  scheduled session-reset or API-key-switching job.
- The top of `GUIDE.md` is a promotional header for the wider project, not part
  of the procedure.

## Permissions & Data Flow

- **Reads:** only `GUIDE.md`, from this directory. Nothing else.
- **Writes:** nothing. This skill has no write path.
- **Network:** no calls. The only URLs are two links to the project's public
  repository in the header text, which nothing here fetches.
- **Credentials:** none touched, none required. No API key, no token, no session
  file is read.

The caution is about what the operator does _after_ reading it, since the
document hands over commands to run by hand:

- Its config snippets change model selection in `openclaw.json`, which affects
  cost and answer quality on heartbeats and cron jobs.
- Its crontab lines schedule work on the operator's machine.
- The session-archiver script in section 10 only lists session `.jsonl` files
  untouched for 7 days unless run with `--apply`; with it, it moves them to a
  `sessions-archive` directory and logs each move. It deletes nothing and never
  overwrites an archived file.

## Changelog

- 1.2.0 — Section 10 session script is now dry-run by default (`--apply` to move), never deletes, never overwrites, logs moves; removed the recommended backup/upload, nightly session-reset and API-key-switching cron jobs and the automatic nightly reset in step 2.
