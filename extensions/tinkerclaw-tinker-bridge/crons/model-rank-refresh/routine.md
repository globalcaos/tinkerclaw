# Routine — Model Rank Refresh

## Purpose

Keep the model rankings that drive the model picker and the router honest. Vendors ship new
models and retire old ones constantly, so a ranking frozen at install time quietly degrades:
the router keeps preferring a model that is no longer the best value, and the picker keeps
offering names that no longer exist. This job reads a public benchmark index, compares it to
the model entries already present in the local config, and writes back updated scores and
rank order. It runs unattended at night. It touches exactly one config file, it archives
before it writes, and it never restarts anything. Everything the job needs is in this file.

## Steps

1. **Establish the working paths.** Config file: `~/.openclaw/openclaw.json`. Report
   directory: `~/.openclaw/cron/reports/<YYYY-MM-DD>/` (create it if missing). Archive
   directory: `~/.openclaw/cron/archive/model-rank-refresh/` (create it if missing). Use
   `$HOME`; never hard-code an absolute user directory.

2. **Preflight, and be willing to stop here.** If the config file does not exist, or does not
   parse as JSON, or contains no model entries at all, this is a _fresh install_, not an
   error. Write the report saying exactly that in one plain sentence, and exit 0. Do not
   create a config, do not seed a model list, do not "helpfully" invent defaults.

3. **Read the current model list.** Parse the config read-only and build an inventory of the
   models it already knows about: identifier, provider, current score, current rank. Keep a
   verbatim copy of the pre-change values in memory — the report compares against them and
   you cannot re-read them after writing.

4. **Fetch the public benchmark index.** Use whatever HTTP/fetch capability is available. One
   attempt, then one retry after a short pause. If both fail — offline machine, DNS down,
   index moved, rate limit — that is a normal outcome: write the report saying the index was
   unreachable and which error came back, leave the config untouched, and exit 0. A stale
   ranking is strictly better than a ranking built from a failed download.

5. **Normalise the fetched data.** Extract, per model: canonical name, provider, and the
   index's score. Discard rows you cannot confidently attribute to a provider the config
   actually uses. If the fetched payload parses but yields fewer usable rows than the config
   already has models, treat it as a bad payload: report it, change nothing, exit 0.

6. **Rank ordinally, never by a fixed cut.** Sort by score and assign rank positions. Any
   selection threshold must be expressed as a position ("top N", "above the median") and
   never as a hard-coded score literal — benchmark publishers rebase their scales without
   warning, and a fixed numeric cut silently empties the picker the night they do.

7. **Match fetched models to config entries.** Match on the canonical model identifier;
   fall back to a provider+name match. Record three buckets: _updated_ (matched, score
   changed), _unchanged_ (matched, score identical), _unmatched_ (in config, absent from the
   index). Never delete or disable an unmatched entry — the index may simply not cover it.
   Leave it exactly as it is and list it in the report.

8. **Decide on additions conservatively.** A model present in the index but absent from the
   config may be added only if its provider is already configured and usable on this machine.
   Never add a model from a provider with no credentials configured — it would appear in the
   picker and fail on first use. If in doubt, do not add; list it under "worth knowing".

9. **Archive before writing.** Copy the current config to
   `~/.openclaw/cron/archive/model-rank-refresh/openclaw-<YYYY-MM-DD-HHMM>.json`. Never
   delete a previous archive, and never overwrite one. If the copy fails, stop: report the
   failure and exit without writing.

10. **Write the config back minimally.** Change only the score and rank fields of model
    entries, plus any newly added entries from step 8. Preserve everything else byte-for-byte
    where possible: key order, unrelated sections, formatting, comments-as-fields, and any
    routing or fallback configuration. This job is not a config formatter.

11. **Validate what you wrote.** Re-parse the written file as JSON. Confirm the model list is
    non-empty and no shorter than before. If validation fails, restore the archive copy from
    step 9 immediately, report the restore, and exit non-zero.

12. **Write the run report** (next section) before finishing, in all cases.

## Report

Write to `~/.openclaw/cron/reports/<YYYY-MM-DD>/model-rank-refresh.md`.

Write the report even when the run does nothing, and especially when the run is dying. If you
are running out of time, hitting an unrecoverable error, or being cut off mid-way, the first
thing you do is drop a stub report with a status line — `STATUS: partial — fetched the index,
did not write config` is a good night. A silent night is worse than a partial one, because
the operator cannot tell a job that found nothing from a job that never ran.

Keep it human-readable. Each bullet is one short plain-language line that someone
non-technical could follow. No file-path dumps, no raw JSON, no stack traces in the body —
if an error matters, say what broke in a sentence and put the raw text at the very bottom
under a single "Details" heading.

Structure:

- **Status** — one line: `ok`, `no changes`, `skipped (reason)`, `partial (reason)`, or
  `failed (reason)`.
- **What changed** — one line per model whose ranking moved, in the form
  "ModelName moved up 3 places" or "ModelName's score went from X to Y". Cap at ten lines;
  if more moved, list the biggest ten and add "and N others".
- **What stayed the same** — a single count, not a list.
- **Not in the index** — models the config keeps that the benchmark did not cover, by name.
- **Worth knowing** — new models seen but not added, and why; anything the operator may want
  to decide on.
- **Details** — optional, last: raw error text or index URL if a human will need it.

## Safety

This job runs unattended with nobody watching. It may NOT:

- Write to any file other than the config at `~/.openclaw/openclaw.json`, its own archive
  copies, and its own report. Every other file and directory is read-only to this job.
- Delete anything. Ever. Archives accumulate; that is intended. Pruning them is a separate
  decision the operator makes.
- Remove, disable, or downgrade a model entry the operator configured, even if the benchmark
  index has never heard of it.
- Restart, reload, or signal any service, daemon, or gateway. If a restart is needed for the
  new ranking to take effect, say so in the report and let the operator do it.
- Send, publish, post, commit, push, or message anything anywhere. The report file is the
  only output channel.
- Spend money: no paid API calls, no model invocations for "evaluation", no purchases. It
  reads one public index and edits one local file.
- Install, update, or remove software or dependencies.
- Escalate privileges or touch anything outside `$HOME`.

If any step needs something on this list, the correct action is to stop, write the report
explaining what it wanted to do and why, and exit cleanly. Blocked is a valid outcome;
improvising around a boundary is not.

## Don't-regress

Behaviours that have broken this job before, or would break it obviously — do not reintroduce:

- **No fixed score thresholds.** Selection is ordinal. A hard-coded numeric cut breaks the
  night the benchmark rebases its scale, and every check still reports green.
- **Never write an empty or shorter model list.** A failed fetch that parses as an empty
  result must not be mistaken for "no models are good any more".
- **Never leave the run silent.** No report file means the operator learns nothing happened
  only when something downstream breaks, days later.
- **A missing input is a normal first run.** Fresh installs have almost nothing on disk. Exit
  0 with an explanatory report; do not error out, and do not manufacture work to look busy.
- **Do not reformat the config.** A diff that touches a thousand unrelated lines is
  unreviewable and hides the three lines that actually changed.
- **Do not depend on any file outside this bundle.** This routine is self-contained by
  design; the version it replaced was a shim pointing at a file that does not ship, and it
  failed on every machine but one.
