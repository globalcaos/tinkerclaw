# Memory Consolidation (Sleep Cycle)

Once a night, while nobody is watching, this job does for the agent what sleep does for a
brain: it re-reads the raw traces of the day, keeps the few things worth keeping, files them
where they will be found again, and lets the rest fade. Concretely — read today's episodic
memory and daily log, pull out the facts that will still matter next month, route each one
into the right long-term note (knowledge / entity / project), leave a short reflection, check
that memory can still be found again, and write a run report. It is a _reading and filing_
job. It does not talk to anyone or spend anything, and the only thing it may restart is a
stopped embedding service on this machine that belongs to this user (Step 8b). On a fresh
install there is nothing to consolidate, and that is a perfectly good outcome — say so and stop.

wind-down, when it is installed, runs before this job and leaves its reflection, its theory
ledger and its note for the morning. This job reads them and does not write a second reflection.

Paths:

- `$WS` is the agent workspace: `$OPENCLAW_WORKSPACE` if that variable is set, otherwise
  `~/.openclaw/workspace`.
- `$STATE` is the state folder: `$OPENCLAW_STATE_DIR` if set, otherwise `~/.openclaw`.
- `$CRONS` is the folder of bundled routines in the repo. Your job message names this routine's
  bundled copy as `<repo>/extensions/tinkerclaw-tinker-bridge/crons/memory-consolidation/routine.md`;
  `$CRONS` is that path without `/memory-consolidation/routine.md`, and `$REPO` is the part before
  `/extensions/`. If the message does not name it, try
  `"$(dirname "$(readlink -f "$(command -v openclaw)")")"` as `$REPO`. If neither holds the
  `extensions/tinkerclaw-tinker-bridge/crons` folder, skip the steps that need its scripts and say
  so in the report.

Every path is a convention, not a guarantee: if it is absent, note it and move on.

## Steps

1. **Resolve the workspace and today's date.** Set `$WS` as above. Set `TODAY` to the local
   date as `YYYY-MM-DD`, and `YESTERDAY` to the day before. If `$WS` does not exist, skip to
   Step 9 and report "no workspace found — nothing to consolidate".

2. **Collect the day's inputs.** Read whichever of these exist; missing ones are normal:
   - `$WS/memory/episodic/$TODAY.md` (and `$YESTERDAY.md` — a night job usually runs after
     midnight, so yesterday's file is often the real subject)
   - `$WS/memory/daily/$TODAY.md` or `$WS/logs/daily/$TODAY.md` — the daily log
   - any file under `$WS/memory/inbox/` — unsorted notes dropped during the day
   - what wind-down wrote: the reflection `$WS/memory/reflections/$YESTERDAY.md` (or
     `$TODAY.md`), the theory ledger `$WS/memory/reflections/theories.md`, the note
     `$WS/memory/reflections/tomorrow.md`, and its report
     `$STATE/cron/reports/$TODAY/wind-down.md`. A theory marked `supported` with dated
     evidence is a candidate fact; one marked `new` is not a fact yet.
   - the other cron reports in `$STATE/cron/reports/$TODAY/` and `$YESTERDAY/`
     Record which inputs were found and which were absent. If none were found, still run Step 3a
     (ENGRAM keeps its own record of the chats) and Step 8b (retrieval can break on a quiet day
     too), then go to Step 9.

3. **Read the consolidation state.** If `$WS/memory/consolidation-state.json` exists, read the
   timestamp of the last successful run so you can skip material already consolidated. If it
   is missing or unreadable, treat this as a first run and process only the inputs from
   Step 2 — do not walk the entire history.

3a. **Run ENGRAM's sleep consolidation.** ENGRAM is the episodic store the Total Recall plugin
keeps (a record of each session, grouped into episodes). Its nightly pass runs inside the
gateway, which also lets it extract skills and propose strategy switches:

```bash
mkdir -p "$WS/memory/consolidation-logs"
openclaw gateway call fork.engram.consolidate.run --timeout 1800000 --params '{}' \
  > "$WS/memory/consolidation-logs/engram-$TODAY.json" 2>&1; echo EXIT=$?
```

Read the counts from that file, never by piping the run into `tail` (the counts get cut off):
`sessionsProcessed`, `episodes`, `eventsProcessed`, `skillsExtracted`,
`strategySwitchesProposed`, `recipeMutationsProposed`, and `baseDir`, the ENGRAM folder it used
(normally `~/.openclaw/engram`).

- **No `events/` folder under `baseDir`, or no `.jsonl` file in it:** ENGRAM is not in use on
  this machine. One line in the report, and go on.
- **Zero `sessionsProcessed` while `baseDir/events/` holds non-empty `.jsonl` stores:** the path is
  broken, because the call counts every non-empty store, even one with nothing new. It answers ok
  with zeros when it finds nothing, so this check is the only way to see it.
- **An `unknown method` error, or no gateway:** the in-process path is not available.

In the last two cases run the script instead:
`node "$REPO/scripts/engram-sleep.mjs" > "$WS/memory/consolidation-logs/engram-$TODAY-script.json" 2>&1; echo EXIT=$?`.
Exit 0 with `not-configured` means ENGRAM was never switched on; exit 1 means it exists but
cannot be read, and the report says why. Both paths move the same per-store cursors, so never
run both on one night unless the first one processed nothing. Report the broken path and its
cause.

4. **Extract candidate durable facts.** From the day's inputs, list the items that are still
   true and still useful a month from now: decisions and their reasons, stable preferences,
   corrections the operator made, discovered constraints, resolved unknowns, new entities and
   their relationships. There is no quota: a quiet day may keep nothing, a busy one many
   things, and the tests below decide each one.
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

7a. **Size the always-loaded files from their cost, not from a fixed number.** Run
`node "$CRONS/memory-consolidation/memory-breakeven.mjs"`. It measures the last week of chats
(context per call, cache mix, calls per session), applies the price ratios, and writes
`$WS/memory/co-access/breakeven.json`. Use it this way:

- **What stays always loaded.** A memory needed in share P of sessions belongs in a file the
  agent loads every session while it is under `max_always_loaded_tokens_by_need_share[P]` tokens
  (`null` means any size). Above that, give it its own note behind an index line.
- **What gets an index line.** A line pays for itself when its target is needed in one of
  `index_line_pays_if_target_needed_in_one_of_N_sessions` sessions. By price alone the index can
  usually hold every note.
- **The ceilings that bind first.** A harness may cut what it loads: Claude Code loads only the
  first 200 lines of `MEMORY.md` (re-check when Claude Code updates), so group several links per
  line under topic headings instead of shortening hooks. And attention: a long always-loaded file
  is followed less well line by line, which no price shows, so order an index by how much a slip
  costs (rules first) and say in the report when it grew.
- **The prices.** The script prints the models it saw most and the price file it used (the
  bundled `price-ratios.json`, or your copy at `$WS/memory/co-access/price-ratios.json`). If the
  most-used model's cache read ratio differs from the file (the bundled file lists the common
  ones), write or correct your copy and run the script again.
- **Too little data** (it exits 1 and says so, normal on a new install): change no sizes tonight,
  and say so in one line.

8. **Write the reflection.** If wind-down wrote a reflection for the day (Step 2), do not write
   a second one: append a short `## From the memory side` section to it with what only filing
   sees, such as the same bug showing up on several days, a project going quiet, or a theory
   that has gathered enough dated evidence to become a fact. Otherwise write a short reflection
   to `$WS/memory/reflections/$TODAY.md` (create the file if needed): what the day was actually
   about, what changed in the agent's understanding, what is still open, and one thing to do
   differently. Plain prose, first person, no bullet-point ceremony. This is the part a human
   might read.

8a. **Run the lesson pass.** The owner's repeated corrections are reviewed by code, not by you:
`openclaw gateway call thalamus.lessons.run --params '{"dryRun":false}'`. It answers JSON. On
`"ok": true`, keep its `report` field (Markdown that starts with `## Lessons`) word for word for the run
report. On `"error": "lessons-off"`, an `unknown method` error, or no gateway, note that one line
and go on: the lesson pass is off or Thalamus is not installed. Do not edit any file it names, do not
apply a repair it lists, and do not run it a second time. It already decided what may change on
its own. wind-down reads its diagnoses the next night and fixes what its own rules allow; the
rest waits for the owner.

8b. **Check that memory can be found again, and recover it if it cannot.** Retrieval is how
anything filed here comes back. A log line saying vector search is active is not proof; only a
probe is.

1. **Which embedding services are configured.** `openclaw config get agents.defaults.memorySearch --json`
   (the memory search provider, model and `remote.baseUrl`; with no provider set it picks one
   from the API keys it finds) and, if the Total Recall plugin is installed,
   `openclaw config get plugins.entries.tinkerclaw-total-recall.config --json`
   (`embeddingProvider`, `embeddingModel`).
2. **Probe them.** `timeout 300 openclaw memory status --deep --json` runs a live embedding ping
   through the configured provider and reports the vector store. For an Ollama endpoint, also
   `curl -s -m 10 <baseUrl, default http://127.0.0.1:11434>/api/version`, then one embedding of a
   fixed test string (`curl -s -m 60 <baseUrl>/api/embeddings -d '{"model":"<model>","prompt":"health check"}'`)
   that must return a non-empty vector. Never send memory content in a probe.
3. **Recover only what is clearly local and yours.** When a provider on this machine (a loopback
   address, or `local`) does not answer, and it runs as a service this user owns, start it once:
   a user systemd unit (`systemctl --user restart <unit>`) or a stopped Docker container this
   user runs (`docker start <name>`). Probe again, and report what you did and how to undo it.
   Never use `sudo`, never touch a system service or the gateway, never create a container,
   install a package or download a model, and never change the config. If the service or the
   model is missing, report the exact command the owner can run.
4. **Report a remote provider precisely.** For a provider reached over the network (OpenAI,
   Gemini, Voyage, Mistral, Bedrock, Copilot), do not restart or re-key anything. Report the
   provider, the model, the endpoint's host name, the error class (auth 401/403, quota 429,
   server 5xx, timeout, DNS) and, if the logs show it, when it last worked. Never print a key.
5. **Search for something written today.** Take one distinctive phrase filed in Step 5 (a note
   title works; on a quiet day, one from the newest note in `$WS/memory/`) and search for it: `timeout 120 openclaw memory search "<phrase>" --max-results 3 --json`,
   and when Total Recall is installed,
   `openclaw gateway call engram.search --params '{"query":"<phrase>","limit":3}'`. It should come
   back. If memory search misses it, `openclaw memory status --deep --index` reindexes a dirty
   store (local, and safe to repeat); search once more and report the result.
6. **One search per store per night.** A search on a large index can keep the machine busy. If
   one times out, report the index size and do not retry.

On a fresh install with no memory search configured, this step is one line in the report.

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
- Then the lesson pass's `## Lessons` section from Step 8a, exactly as it came back, or its one line
  saying why it did not run. This is the morning's single report of what slipped and why; do not
  write a second one.
- Then one line each for ENGRAM (Step 3a: which path ran and its counts, or why it did not),
  sizes (Step 7a: the hop cost and the any-size need share, or "too little data"), and
  retrieval (Step 8b: each provider's state, what you restarted and how to undo it, and whether
  today's phrase came back).
- Close with the counts: inputs read, facts kept, notes updated, notes created.

**Write a stub report even when the run is dying.** If a step fails, if the model runs out of
room, or if you must stop early, write the report first with `status: partial` or
`status: failed` and a line saying how far you got. A silent night is worse than a partial
one: an empty report directory looks identical to a cron that never fired, and that is the
failure mode that goes unnoticed for weeks.

## Safety

This job runs unattended, at night, with nobody watching. It has a deliberately small licence.

- **It may write only** inside `$WS/memory/**` and the report directory
  `~/.openclaw/cron/reports/**`. Everything else on the machine is read-only to this job. Two
  commands write in their own folders: Step 3a's ENGRAM pass under ENGRAM's folder, and Step 8a's
  lesson pass under Thalamus's data folder (with `lessons.mode: apply`, the owner's switch, off by
  default, it also adds a rule line to one always-read file). That is each command's licence, set
  by the code and the owner. It does not widen yours.
- **Act, don't defer.** Something internal that is broken, stale or unreachable, whose cause is
  not the owner, gets recovered in this run inside these rules: reindex it, re-run it, start the
  stopped local embedder. The report says what you did and how to undo it. "Needs the owner's
  approval" is not a reason to leave internal work undone.
- **Thresholds carry their reason.** Every size or count this job applies says what it is for,
  where it came from and what would change it. Sizes come from Step 7a's measurement, not from a
  remembered number.
- **Never delete, and never truncate.** No `rm`, no overwriting a note with a shorter version,
  no "cleaning up" old memories. Superseding is done by appending a dated line, not by
  removal. Archiving, when it happens at all, means moving text into an `archive/` file that
  is itself never deleted. The single exception is today's own report file, which is
  overwritten by design.
- **Do not send, publish or post anything** — no email, no chat message, no commit, no push,
  no API call to a third-party service, no webhook. Consolidation is entirely local. The one
  exception is Step 8b's health check, which sends a fixed test string through the embedding
  provider the owner already configured, the same call memory search makes every day.
- **Do not spend money, and restart only one thing.** No paid API calls beyond this turn's own
  model usage, the probes in Step 8b included; no package installs, no downloads, no config
  edits. The only restart allowed is Step 8b's: a stopped embedding service on this machine that
  this user owns. Never the gateway, never a system service, never with `sudo`.
- **What still waits for the owner**: anything another person would see, money, anything that
  cannot be undone, loosening a safety rule, and what only they can do (an API key, a password).
  Prepare everything up to that point and name it in the report.
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
- **Notes are split, never trimmed.** A note that is read only in part, and whose unread part
  is over Step 7a's carry limit, gets split by topic. Nothing is cut by deletion. With no
  measurement yet, leave sizes alone.
- **ENGRAM runs once a night** (Step 3a). Both paths move the same cursors.
- **The state file is written atomically**, so a run killed mid-write does not poison the
  next one.
- **Never widen the write scope.** If a future change wants this job to touch something
  outside `$WS/memory/**` and the report directory, that is a decision for the operator to
  make while awake, not for the night job to make on its own.
