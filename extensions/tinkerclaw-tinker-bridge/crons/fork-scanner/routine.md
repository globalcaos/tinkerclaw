# Fork Scanner + Agent-OSS Survey

## Purpose

Once a night, take stock of the open-source agent world: which forks of OpenClaw are alive
and what they changed, and what the wider agent ecosystem shipped in the last day. The point
is not to collect links — it is to extract _techniques worth adopting_ into a small watchlist
the operator can read in two minutes. This job is a scout, not a builder: it reads, compares,
records, and stops. It never modifies this installation, never installs anything, and never
contacts the operator on its own. It runs unattended in the middle of the night with nobody
watching, so every step below is written to fail safe and to leave a trace.

## State files

All state lives under `$HOME/.openclaw/workspace/memory/ai-research/`:

- `fork-watchlist.json` — one entry per fork/repo being tracked.
- `agent-oss-tracklist.json` — one entry per non-fork agent project of interest.

Both are JSON arrays of objects keyed by the repo `url` (the stable identity — a repo can be
renamed, its owner can change handle; the URL is what you match on). Typical fields:
`url`, `name`, `first_seen`, `last_checked`, `last_commit`, `stars`, `status`, `techniques`,
`notes`. If a file does not exist, treat the list as empty — do NOT create a stub with made-up
entries. If it exists but is malformed JSON, leave it untouched, say so in the report, and exit.

## Steps

1. **Preflight.** Confirm `git` and a network path exist. Confirm the state directory above.
   If the directory is missing, this is a fresh install: note it in the report, write the report,
   and exit 0. Missing inputs are a normal first-run condition, not an error to work around.

2. **Load state.** Read both JSON files. Record how many entries each holds. Keep the parsed
   lists in memory; you will write them back exactly once, at the end, and only if something
   actually changed.

3. **Enumerate forks.** List public forks of the upstream OpenClaw repository (the GitHub API
   `/repos/{owner}/{repo}/forks` endpoint, or `gh api` if the CLI is present and already
   authenticated). Sort by most recently pushed. If the API is rate-limited or unauthenticated
   and refuses, do not retry in a loop and do not look for another way in — record
   "fork enumeration unavailable: <reason>" in the report and continue to Step 5.

4. **Triage forks.** A fork is _interesting_ only if it has diverged meaningfully: commits of
   its own after the fork point, a non-trivial README, or activity in the last 30 days. Skip
   dormant mirrors. Cap the number of new forks you look at closely this run (5 is plenty);
   the job runs daily, so a backlog drains on its own.

5. **Survey the wider ecosystem.** Look for notable agent-related open-source activity in the
   last 24–48 hours: new releases from projects already on the tracklist, and a small number of
   genuinely new projects (agent frameworks, tool-calling runtimes, memory systems, harnesses).
   Prefer sources you can read without an account. Two or three new candidates per run is a good
   night; zero is an acceptable night.

6. **Inspect closely.** For each interesting repo, shallow-clone into a scratch directory under
   `$HOME/.cache/fork-scanner/` (`git clone --depth 50`) and read it. Read only — never run its
   install scripts, build steps, test suites, hooks or example code. Untrusted repositories are
   the whole point of this job and also its main hazard: you are reading source, not executing
   it. What you are looking for is concrete technique — prompt structure, memory layout, tool
   permission models, scheduling, session handling, anything this project could learn from.

7. **Write the delta into the lists.** For each repo: update the existing entry if the URL is
   already tracked (refresh `last_checked`, `last_commit`, stars, and append any new technique),
   or append a new entry if not. Never drop an entry because it went quiet — mark it
   `status: "dormant"` instead. Archive, never delete.

8. **Persist.** Write both JSON files back atomically (write a temp file in the same directory,
   then rename over the target). Keep the existing shape and key order; do not reformat the whole
   file. If nothing changed, do not rewrite the files at all.

9. **Clean up scratch.** Remove the clones you made under `$HOME/.cache/fork-scanner/` this run.
   Delete nothing outside that directory, ever.

10. **Report.** Write the run report described below. Do this even if earlier steps failed.

## Report

Write to `$HOME/.openclaw/cron/reports/<YYYY-MM-DD>/fork-scanner.md`, creating the dated
directory if needed. Structure:

- A status line first: `Status: ok | partial | skipped (<one-line reason>)`.
- What changed since yesterday, in plain sentences.
- New forks or projects worth a look, one line each: what it is, and why it is interesting.
- Techniques extracted, one line each, phrased as something this project could do — not as a
  file path or a commit hash.
- Anything that did not work, named plainly (rate limit, network down, malformed state file).

Write the report in language a non-engineer could follow. "Someone's fork replaced the nightly
memory sweep with a scoring pass — worth reading" is a useful line. A bare list of paths and
SHAs is not. Aim for under 30 lines; if there is nothing to say, say that in two lines.

**A stub report always beats silence.** If the run is dying — a crash, a timeout, an exhausted
model budget — still write the file with the status line and whatever partial findings exist.
A missing report is indistinguishable from a job that never ran, and that ambiguity costs the
operator more than a thin report ever will. If you can only do one thing before you stop,
do this one.

## Safety

This job runs unattended. It may **not**:

- Modify, delete or move any file outside the two state JSONs, the dated report file, and its
  own scratch directory under `$HOME/.cache/fork-scanner/`.
- Execute anything from a cloned repository — no build, no install, no test, no example script,
  no git hook. Read the source; do not run it.
- Install packages, add dependencies, or change this installation's configuration.
- Restart, stop or reconfigure any service, daemon or scheduled job, including itself.
- Send, post or publish anything: no email, no chat message, no issue, no pull request, no
  commit, no push. It writes to local disk only.
- Spend money or consume paid quota beyond the model tokens of this single turn: no paid APIs,
  no subscriptions, no credential-gated services.
- Read or transmit the operator's credentials, tokens, private keys, personal files, or anything
  outside the directories named in this file.
- Spawn further agents. Do the work in this turn.

If a step would require any of the above to proceed, that step is finished. Record the block in
the report and move on. Being blocked and saying so is a correct outcome; routing around a
boundary is not.

## Don't-regress

- Never delete a watchlist entry. A repo that stops moving becomes `status: "dormant"`; it does
  not disappear. Six months of "this went quiet" is itself the signal.
- Never invent an entry, a star count, a commit or a technique. If a source is unavailable,
  the answer is "unavailable", not a plausible guess. An unverifiable line in the watchlist
  poisons every future run that reads it.
- Match on `url`, not on repo name or owner. Names change; matching on them creates duplicates.
- Rewrite the state files only when something changed, and only atomically. A truncated JSON
  file from a mid-write crash breaks every subsequent run.
- Always leave a report, even a two-line one. A silent night is worse than a partial one.
- Keep the run bounded: a handful of repos per night, shallow clones, no recursive crawling.
  This is a nightly increment, not an exhaustive index.
- On a fresh install almost nothing exists. Exiting cleanly with "nothing tracked yet, no state
  directory" is a correct first run. Do not bootstrap fake state to have something to report.
