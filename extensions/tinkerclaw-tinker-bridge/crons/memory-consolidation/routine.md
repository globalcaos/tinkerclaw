# Memory Consolidation (Sleep Cycle)

Once a night, while nobody is watching, this job does for the agent what sleep does for a
brain: it re-reads the raw traces of the day, keeps the few things worth keeping, files them
where they will be found again, and lets the rest fade. Concretely — read today's episodic
memory and daily log, pull out the facts that will still matter next month, route each one
into the right long-term note (knowledge / entity / project), leave a short reflection, and
write a run report. It is a _reading and filing_ job. It does not talk to anyone, spend
anything, or restart anything. On a fresh install there is nothing to consolidate, and that
is a perfectly good outcome — say so and stop.

Paths below are relative to the agent workspace, which is `$OPENCLAW_WORKSPACE` if that
variable is set, otherwise `~/.openclaw/workspace`. Call that `$WS`. Every path is a
convention, not a guarantee: if it is absent, note it and move on.

## Steps

1. **Resolve the workspace and today's date.** Set `$WS` as above. Set `TODAY` to the local
   date as `YYYY-MM-DD`, and `YESTERDAY` to the day before. If `$WS` does not exist, skip to
   Step 9 and report "no workspace found — nothing to consolidate".

2. **Collect the day's inputs.** Read whichever of these exist; missing ones are normal:
   - `$WS/memory/episodic/$TODAY.md` (and `$YESTERDAY.md` — a night job usually runs after
     midnight, so yesterday's file is often the real subject)
   - `$WS/memory/daily/$TODAY.md` or `$WS/logs/daily/$TODAY.md` — the daily log
   - any file under `$WS/memory/inbox/` — unsorted notes dropped during the day
     Record which inputs were found and which were absent. If none were found, go to Step 9.

3. **Read the consolidation state.** If `$WS/memory/consolidation-state.json` exists, read the
   timestamp of the last successful run so you can skip material already consolidated. If it
   is missing or unreadable, treat this as a first run and process only the inputs from
   Step 2 — do not walk the entire history.

4. **Extract candidate durable facts.** From the day's inputs, list the items that are still
   true and still useful a month from now: decisions and their reasons, stable preferences,
   corrections the operator made, discovered constraints, resolved unknowns, new entities and
   their relationships. Aim for the handful that matter — roughly 3 to 15 on an ordinary day.
   Explicitly _drop_: transient status, one-off command output, anything already recorded in
   the repository or in git history, and anything you cannot point to a line of the day's
   inputs for. If it did not happen in the inputs, it does not get written.

5. **Route each fact to exactly one owner note.** One fact, one home:
   - a general lesson, technique or rule → `$WS/memory/knowledge/<slug>.md`
   - a person, organisation, device or account → `$WS/memory/entities/<slug>.md`
   - ongoing work with a goal and a state → `$WS/memory/projects/<slug>.md`
     Append to the existing note when one covers the topic; create a new one only when none
     does. Keep each note short and dated: one line per fact, prefixed with the date, with a
     `why` clause when the reason is the useful part. If a new fact contradicts an existing
     line, do not silently overwrite it — keep both, mark the older one superseded with today's
     date, and mention the contradiction in the report. Never delete a note.

6. **Deduplicate before writing.** Search existing notes for the fact you are about to add.
   If it is already there in substance, update the existing line (sharpen it, add the date)
   rather than appending a near-duplicate. A memory store that grows by repetition stops
   being searchable.

7. **Update the index, if there is one.** If `$WS/memory/INDEX.md` (or `MEMORY.md`) exists,
   add one short pointer line per newly created note — title, path, and a few words of hook.
   Do not move content into the index; it is a table of contents, not a store. If no index
   file exists, do not invent one.

8. **Write the reflection.** Append 5–15 lines to `$WS/memory/reflections/$TODAY.md`
   (create the file if needed): what the day was actually about, what changed in the agent's
   understanding, what is still open, and one thing to do differently. Plain prose, first
   person, no bullet-point ceremony. This is the part a human might read.

9. **Update the state file.** Write `$WS/memory/consolidation-state.json` with the run
   timestamp, the inputs processed, and the counts (facts kept, notes touched, notes
   created). Write it atomically — to a temporary file in the same directory, then rename —
   so an interrupted run cannot leave a corrupt state file.

10. **Write the run report** as described below, always, including when Step 2 found nothing.

## Report

Write to `~/.openclaw/cron/reports/<YYYY-MM-DD>/memory-consolidation.md`, creating the
directory if needed. Overwrite the file if it already exists for today.

Format — short, plain language, readable by someone who does not write code:

- **First line is a status line**: `status: ok` / `status: nothing-to-do` / `status: partial`
  / `status: failed`, followed by one sentence saying what happened.
- Then a handful of bullets: what the day was about, what was learned and filed, anything
  contradicted or superseded, anything skipped and why. Each bullet is a sentence, not a file
  path dump — mention a note by its subject ("the note on the operator's deploy preferences"),
  and add the path only when someone would need it to act.
- Close with the counts: inputs read, facts kept, notes updated, notes created.

**Write a stub report even when the run is dying.** If a step fails, if the model runs out of
room, or if you must stop early, write the report first with `status: partial` or
`status: failed` and a line saying how far you got. A silent night is worse than a partial
one: an empty report directory looks identical to a cron that never fired, and that is the
failure mode that goes unnoticed for weeks.

## Safety

This job runs unattended, at night, with nobody watching. It has a deliberately small licence.

- **It may write only** inside `$WS/memory/**` and the report directory
  `~/.openclaw/cron/reports/**`. Everything else on the machine is read-only to this job.
- **Never delete, and never truncate.** No `rm`, no overwriting a note with a shorter version,
  no "cleaning up" old memories. Superseding is done by appending a dated line, not by
  removal. Archiving, when it happens at all, means moving text into an `archive/` file that
  is itself never deleted. The single exception is today's own report file, which is
  overwritten by design.
- **Do not send, publish or post anything** — no email, no chat message, no commit, no push,
  no API call to a third-party service, no webhook. Consolidation is entirely local.
- **Do not spend money and do not restart services.** No paid API calls beyond this turn's own
  model usage, no package installs, no gateway or daemon restarts, no config edits.
- **Do not spawn other agents.** Do the work in this turn.
- **Do not invent memories.** Every line written must be traceable to something in the day's
  inputs. If you are unsure whether something happened, leave it out and say so in the report.
  A confidently wrong memory outlives the night it was written and poisons every later recall.
- **Keep secrets out of memory notes.** If an input contains a credential, token, key or
  password, do not copy it into a note — record that the credential exists and where it lives,
  nothing more.
- **When blocked, stop and report.** A missing file, an unreadable directory, a tool that is
  not installed: name it in the report and exit cleanly with a non-`ok` status. Do not work
  around it by reaching for another system or widening the search.

## Don't-regress

Things that have gone wrong before, or would obviously go wrong; keep them fixed.

- **A fresh install is a normal case, not an error.** No episodic file, no daily log, no
  memory directory: report `status: nothing-to-do` and exit 0. Do not create scaffolding, do
  not backfill history, do not fail loudly.
- **This file is the whole instruction.** Do not defer to some other document for the "real"
  routine — the previous version of this file was a four-line pointer at a file that does not
  ship, so on a cloned install the job did nothing at all. If you find yourself looking for
  the real instructions elsewhere, you are already off the rails.
- **The report always exists.** Even on the emptiest night, the dated report file is written.
- **One fact, one home.** The same fact copied into three notes drifts into three versions.
- **Notes stay short.** A note that grows past a page or so gets split by topic, never
  trimmed by deletion.
- **The state file is written atomically**, so a run killed mid-write does not poison the
  next one.
- **Never widen the write scope.** If a future change wants this job to touch something
  outside `$WS/memory/**` and the report directory, that is a decision for the operator to
  make while awake, not for the night job to make on its own.
