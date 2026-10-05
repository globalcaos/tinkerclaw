# Self-Evolution Scanner — routine

## Purpose

Once a day, unattended, build an honest picture of what changed in the AI field in the last
24 hours and fold it into two long-lived files the agent keeps about its own capabilities: a
machine-readable model-intelligence state file, and a dated, append-only self-evolution index.
The point is not to collect headlines — it is so that when the operator later asks "what should
I be running for this?", the answer reflects the models, agent techniques and tooling that exist
today rather than the ones that existed when the agent was installed. This routine is a
research-and-write job: it reads the web, writes two files under the agent's own workspace, and
leaves a run report. It changes nothing else on the machine.

## Steps

1. **Set the run date.** Compute `TODAY` as the local date in `YYYY-MM-DD` form. Use it for the
   report directory and for the index entry heading. Do not backdate or reuse yesterday's date.

2. **Locate the state files.** The two artifacts this job maintains are:
   - `~/.openclaw/workspace/memory/self-evolution/model-intelligence-state.json` — current picture
     of available models, their rough tier, cost posture, and what each is good for.
   - `~/.openclaw/workspace/memory/self-evolution/index.md` — append-only log, newest entry last,
     one dated section per run.
     If the directory or either file is missing, that is the **normal first-run case on a fresh
     install**. Create the directory and treat the missing file as an empty starting point: an empty
     JSON object `{}` for the state, and a file with a single title heading for the index. Note in the
     report that this was a cold start. Never abort because a file was absent.

3. **Read the current state before changing anything.** Load the state JSON and skim the last two
   or three entries of the index. This is what makes the run a _delta_ instead of a fresh dump: you
   are looking for what is new relative to what is already recorded. If the JSON is unparseable,
   do not overwrite it — leave it untouched, say so in the report, and continue in read-only mode
   for the rest of the run.

4. **Scan for changes, breadth first.** Using whatever web search and page-fetch tools this agent
   actually has, cover these areas, in this priority order:
   1. New or updated frontier model releases from the major AI vendors — name, date, claimed
      capability, price if published, availability.
   2. Vendor engineering and research blogs: agent frameworks, tool-use protocols, context and
      memory techniques, evaluation results.
   3. Agent technique write-ups from credible independent sources — orchestration patterns,
      retrieval, long-horizon reliability, cost control.
   4. Deprecations and retirements. A model going away matters as much as a model arriving.
      Prefer primary sources (a vendor's own announcement) over aggregators. Cap the scan: roughly
      10–20 fetches, or ~15 minutes of work, whichever comes first. Breadth beats depth here; a
      shallow-but-current picture is the deliverable.

5. **Filter to what is actually new.** Discard anything already present in the state file or in a
   recent index entry. Discard speculation, rumours, and undated posts. Keep an item only if you can
   name the source and, ideally, its publication date. If nothing new turned up, that is a valid and
   common outcome — record "no material change" rather than padding the entry.

6. **Update the model-intelligence state file.** Apply only the deltas found in step 5: add new
   models, correct stale facts, mark retired models as retired rather than deleting their entries.
   Write the file atomically — write to a temporary file in the same directory, then move it into
   place — so an interrupted run cannot leave a half-written JSON. Validate that the result parses
   as JSON _before_ the move. If validation fails, keep the old file and report the failure.

7. **Append one dated entry to the index.** Newest entry at the end of the file, headed with
   `TODAY`. Keep it to roughly 5–15 lines: what changed, why it might matter to how this agent
   works, and the source links. Append only — never rewrite, reorder, or prune earlier entries.
   If the file has grown unwieldy, say so in the report and let the operator decide; do not
   compact it on your own initiative.

8. **Write the run report.** See the Report section below. Do this last, but do it always.

## Report

Write to `~/.openclaw/cron/reports/<YYYY-MM-DD>/self-evolution.md`, creating the directories if
they do not exist.

The report is for a human skimming it over coffee, not for a machine. Each bullet is one short
plain-language line: what happened and whether it matters. Do not dump file paths, raw JSON, or
tool traces into it. Structure:

- A `Status:` line as the very first line — one of `ok`, `partial`, or `failed`.
- What was scanned, in a sentence.
- What changed, as a few bullets, in plain language ("a new mid-tier model from one vendor, cheaper
  than the one currently preferred for bulk work"). Zero bullets is a fine answer; write "nothing
  material changed today" and stop.
- Anything that could not be done, and why — a missing file, an unreachable source, a tool the
  agent does not have.
- Anything the operator may want to act on. Nothing is a valid answer here too.

**A stub report is mandatory.** If the run is failing, running out of time, or degrading, write the
report anyway with `Status: partial` or `Status: failed` and one honest line about how far it got.
A silent night is worse than a partial one: the operator cannot tell a job that found nothing from
a job that never ran. If you can only do one thing before dying, do this.

## Safety

This job runs unattended, at night, with nobody watching. It operates under a deliberately narrow
licence.

- **Read-only outside its two state files and its report.** The only writes permitted are: the
  model-intelligence state file, the self-evolution index, and the run report. Nothing else on the
  filesystem is touched — not configuration, not credentials, not other memory files, not code.
- **Archive, never delete.** Retired models are marked retired, not removed. Index entries are
  appended, never rewritten or pruned. If something looks like it should be deleted, say so in the
  report and leave it in place.
- **No sending, no publishing.** No email, no chat message, no post, no commit, no push, no
  pull request, no upload. The report file is the entire output surface.
- **No spending, no installing, no restarting.** Do not sign up for anything, buy anything, call a
  paid API beyond the agent's normal inference, install packages, or restart, stop or reconfigure any
  service. If a scan would require one of those, skip it and note it in the report.
- **No self-modification.** This job reports on capabilities; it does not change the agent's own
  configuration, prompts, model selection, skills or scheduled jobs on the basis of what it read.
  Recommending a change in the report is the correct move; making it is not.
- **Web reads only, and politely.** Fetch public pages. Do not attempt authentication, do not work
  around a paywall or a robots restriction, and do not hammer a host with rapid repeat requests.
- **Blocked means stop and say so.** If the work cannot be done as written — no network, no search
  tool, a corrupt state file — write the report saying exactly what blocked it and exit cleanly.
  Do not improvise an alternative route, and never invent findings to fill the entry.

## Don't-regress

Properties that have to survive future edits to this file:

- **Self-contained.** This file is the complete instruction set. It must never be reduced to a
  pointer at another document — the version it replaced was a four-line shim referencing a file
  that does not ship, which meant the job silently did nothing on every install but one.
- **Generic.** No personal names, no real host paths, no company names, no private URLs, no
  credentials. The human is "the operator". Paths use `~` or `$HOME`.
- **A missing input is not an error.** A fresh install has almost nothing. Missing directories,
  missing state files and missing tools all produce a clean exit with an explanatory report, never
  a crash and never fabricated work.
- **The report always gets written**, including on partial and failed runs.
- **Append-only stays append-only**, and the state file is only ever replaced atomically after its
  JSON has been validated.
- **The output stays a delta.** If a future edit makes this job re-summarise the whole field every
  night, it has regressed into a headline generator and the index becomes unreadable.
