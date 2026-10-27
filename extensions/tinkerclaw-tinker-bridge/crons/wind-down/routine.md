# Wind Down (Daily Reflection)

Once a night, after the owner's evening and before memory-consolidation, the agent looks back on
the day it just spent with its owner. What did we work on? What was the owner after, and why? How
did the day go for them? It writes that down as a short reflection, keeps a ledger of theories
worth testing, researches the few that evidence would settle, fixes what keeps going wrong, and
leaves a short note the next day starts from, with at most three questions for the owner.

Everything it writes stays in the owner's workspace. It sends nothing to anyone, publishes
nothing, and commits nothing. memory-consolidation runs after it and reads what it wrote, so this
job does not file long-term memories itself.

On a fresh install there is little to reflect on, and that is a fine outcome: write a short
reflection, say so in the report and stop.

## Paths

- `$WS` is the agent workspace: `$OPENCLAW_WORKSPACE` if that variable is set, otherwise
  `~/.openclaw/workspace`.
- `$STATE` is the state folder: `$OPENCLAW_STATE_DIR` if set, otherwise `~/.openclaw`.
- `$CRONS` is the folder of bundled routines in the repo. Your job message names this routine's
  bundled copy as `<repo>/extensions/tinkerclaw-tinker-bridge/crons/wind-down/routine.md`;
  `$CRONS` is that path without `/wind-down/routine.md`. If the message does not name it, try
  `"$(dirname "$(readlink -f "$(command -v openclaw)")")/extensions/tinkerclaw-tinker-bridge/crons"`.
  If neither exists, skip the steps that need its scripts and say so in the report.

Every path below is a convention, not a guarantee. If one is missing, note it and move on.

**The window.** Reflect on everything since the previous run started: read
`$WS/memory/reflections/.last-run` (one ISO time). If it is missing, use the last 24 hours. Name
the reflected day by the date the window started (`$DAY`).

## Step 0: Gather (read, write nothing yet)

a. **The owner's words.** `node "$CRONS/wind-down/owner-prompts.mjs" --since <window start>`
prints each prompt the owner typed in a chat, once, with its time and chat. It leaves out
prompts written by agents, jobs and the gateway. If it prints nothing while chats moved in the
window (`find "$STATE/agents" -name '*.jsonl' -newermt "<window start>"` lists files), the
probe is broken, not the day quiet: say so in the report and work from the other inputs.
b. **What got done.** The cron reports in `$STATE/cron/reports/<date>/` for each date in the
window. Notes written in the window (`find "$WS/memory" -name '*.md' -newermt "<window start>"`).
The git log of any repository the day's prompts name, and of the TinkerClaw checkout
(`git -C <repo> log --since="<window start>" --format='%h %ad %s' --date=format:%H:%M`). When a
prompt's outcome matters to a theory, read that chat's answer in its transcript.
c. **How the day went.** From the owner's words only: corrections and repeats ("still", "again",
"you didn't"), terse lines, capitals, "!!", stated feelings, warmth, jokes they made, and how
late they were still writing. Also the corrections the lesson pass recorded:
`openclaw gateway call thalamus.lessons.run --params '{}'` is a dry run (it changes nothing);
read its `corrections` count and its `report`. On `lessons-off`, `unknown method` or no
gateway, skip it with one line.
d. **What we already think.** `$WS/memory/reflections/theories.md`, the last two reflections and
their questions, `$WS/memory/reflections/tomorrow.md`, and `$WS/USER.md` or any note in
`$WS/memory/` that states the owner's goals. Did the owner answer an earlier question in the
window?

## Step 1: Reflect, and write it down first

Write `$WS/memory/reflections/$DAY.md` before anything else: a reflection that exists beats a
perfect one that a timeout killed. Plain prose, first person, 30 to 60 lines on a full day and a
few lines on a quiet one:

- **The day.** What we worked on, in the owner's terms, as a short story, not a list of commits.
- **What they were after.** The goal behind each thread. Tie it to the goals the workspace
  records, or say plainly that it fits none. Quote the owner for what they said; mark your
  readings as readings.
- **Why.** What seemed to drive them, with the evidence.
- **How it went.** The arc through the day, with times and their words. It is a reading, never a
  diagnosis. When they were frustrated, name the cause, and say so when the cause was us.
- **What surprised me, and what I got wrong.**

This file is about the owner, for the agent. Other people get only what the story needs, never
their private details.

## Step 2: Theories

Derive two to five theories. A theory is a claim that would change what we do if it were true:
about the work (why something keeps breaking, what would make a thread faster), about the owner
(what they value, what wears them out, what delights them), or about the agent (a habit that costs
the owner time or attention).

Keep them in one ledger, `$WS/memory/reflections/theories.md`. Each entry: the claim; today's
evidence (a quote, a file, a number); earlier evidence (search the ledger and the reflections
first, and update an existing theory rather than adding a twin); how to test it; what we would
change if it holds; and a status, `new`, `supported`, `weakened` or `retired`, with dated evidence
lines. Retire a theory when the evidence turns against it, and say why.

## Step 3: Research, bounded

Pick the one to three theories where outside knowledge or a measurement would settle the question,
and look: web search for papers and docs, the code, the logs, the transcripts. Write what you
found, with links, into the theory's entry.

**Search queries carry the topic, never the owner.** No names, places, quotes, numbers or details
from the chats go into a search or a URL. "Why do nightly embedding jobs stall on small machines"
is fine; anything that would identify the owner or the people around them is not.

Budget: about 30 minutes or 25 tool calls in total, then stop and write what you have. FOR: the
reflection must be on disk before memory-consolidation reads it. FROM: the bundled schedules leave
75 minutes between the two jobs, and gathering plus reflecting take about 20 to 30 of them.
CHANGE: if either schedule moves, or runs keep finishing well inside the window, widen it.

## Step 4: Fix what keeps going wrong (act, then report)

a. **Repeated corrections.** For each correction in the owner's words (Step 0a and 0c), search the
reflections, `$WS/memory/` and the lesson pass's report for the same correction on an earlier
day. Seen before means the gap is in what the agent reads, not in one turn: change the source
so it cannot recur. In the workspace that means `$WS/AGENTS.md`, a skill under `$WS/skills/`, a
routine override under `$WS/crons/<id>/routine.md`, or the note that holds the wrong fact. The
test: would this edit have prevented today's correction, not merely recorded it? Before editing
a file, copy it to `$WS/memory/archive/wind-down/$DAY/`. A correction seen for the first time
gets one dated line in `$WS/memory/reflections/lessons.md`, nothing more.
b. **Code you cannot fix from here.** Do not edit the TinkerClaw checkout: uncommitted changes in
it would block the owner's next `git pull`. Write `$WS/memory/bugs/<NNN>-<slug>.md` (next
number; symptom, how to reproduce, cause, proposed change, status), or add a dated "still
occurring" line to the existing note.
c. **Cron routines.** A job that failed, produced nothing, wasted a long run, or carried the same
skip note three nights in a row gets a rule that stops it: copy its bundled routine to
`$WS/crons/<id>/routine.md` if no override exists, and add an "if X, then Y" line there. Keep
that routine's safety section whole. Any number you write states what it is for, where it came
from, and what would change it.
d. **Skills and notes the day proved wrong.** Fix them now, in the workspace.

Never loosen a safety rule while doing this, and never widen what a job may do: that is the
owner's decision, made while awake. Tightening or sharpening a rule is fine; say so in the report.

## Step 5: Carry it forward

Overwrite `$WS/memory/reflections/tomorrow.md`, and put the same text at the end of the dated
reflection:

- **Where we are.** Three to six lines: the open threads and each one's next step.
- **Questions for the owner.** At most three, the ones whose answer would change what we do. One
  sentence each. Never a question you could answer by looking, and never a request for permission.
  FOR: the owner reads these in the morning, and more than three turns a note into homework. FROM:
  a judgment made when this routine was written, not a measurement. CHANGE: if the owner answers
  all three most mornings, allow more; if most go unanswered, ask fewer.
- **Worth a look.** Optional, one line: something they did not ask for but would want to know,
  such as a research finding.

When the owner's words answer an earlier question, act on the answer: update the theory it bears
on or the note it changes. A new goal or a re-ranking of their goals is theirs to set, so ask it as
a question instead of writing it in.

This job never messages the owner. The note and the run report wait for them.

## Step 6: Fleet health (mechanical, fast)

- `openclaw cron list --all --json`: every enabled job whose slot fell in the window has a report
  under `$STATE/cron/reports/<date>/`. For a job with no report, `openclaw cron runs --id <id>
--limit 3` says whether it ran and how it ended.
- The gateway's errors since the window start. Where the gateway runs as a systemd user unit,
  `journalctl --user-unit openclaw-gateway --since "<window start>"`; on some systems
  `journalctl --user -u …` returns nothing, and an empty result reads as "no failures" when it is
  not. Elsewhere, `openclaw logs --limit 500`. Count failed turns, rate-limit and auth errors, and
  split job sessions from chats.

Anything missing or failed: fix what you can inside this routine's rules (Step 4c covers a failing
routine), then report what is still down, with the cause in one sentence.

## Step 7: Report, then mark the run

Write the report below. Last, write the run's start time (ISO) to
`$WS/memory/reflections/.last-run`, so the next window starts where this one did.

## Report

Write to `$STATE/cron/reports/<YYYY-MM-DD>/wind-down.md`, creating the folder if needed, and
overwrite it if it exists for today.

- **First line is a status line**: `status: ok` / `status: nothing-to-do` / `status: partial` /
  `status: failed`, followed by one sentence saying what happened.
- Then short bullets: the day in one sentence, theories added or changed, research done, every fix
  from Step 4 with how to undo it (the archived copy's path), and what Step 6 found still down.
- Close with the counts: prompts read, theories new and updated, research items, questions asked,
  fixes applied, bug notes filed.

Do not copy the reflection into the report: the report says what changed, the reflection holds the
reading. **Write a stub report even when the run is dying**, with `status: partial` or
`status: failed` and how far you got. An empty report folder looks the same as a job that never
fired.

## Safety

This job runs unattended, at night, with nobody watching.

- **It may write only** inside `$WS/**` and the report folder `$STATE/cron/reports/**`. In the
  workspace, Step 4 names what it may change. Everything else on the machine is read-only to it.
- **Act, don't defer.** Something internal that is broken, stale or wrong, whose cause is not the
  owner, gets fixed in this run, inside these rules, and the report says what changed and how to
  undo it. "Needs the owner's approval" is not a reason to leave internal work undone.
- **Thresholds carry their reason.** Every number this routine or an override uses to gate an action
  says what it is for, where it came from, and what would change it. A bare number you meet is a
  guess: replace it with its reasoning, or leave it alone and say so.
- **Never delete, never truncate.** Archive instead: copy a file to
  `$WS/memory/archive/wind-down/$DAY/` before changing it. The exceptions are `tomorrow.md`,
  `.last-run` and today's report, which are overwritten by design.
- **Do not send, publish or post anything**: no message, email, commit, push, webhook or upload.
  Web research reads; it never submits a form or signs in.
- **What still waits for the owner**: anything another person would see, money, anything that
  cannot be undone, loosening a safety rule, and what only they can do (a password, a tap on their
  phone). Prepare it, and name it in the report.
- **Do not spend money and do not restart the gateway.** No paid API call beyond this turn's own
  model and tool use, and no package installs.
- **Do not spawn other agents.** Do the work in this turn.
- **Do not diagnose the owner.** Mood is a reading with evidence, never a label.
- **Do not invent.** Every claim in the reflection points to something in the inputs. A guess is
  marked as a guess.
- **Keep secrets out.** If an input holds a credential, token, key or password, never copy it:
  record that it exists and where, nothing more.
- **When blocked, stop and report.** Name the missing file, tool or permission and exit with a
  non-`ok` status. Do not reach for another system to work around it.

## Don't-regress

- **A quiet day is a short reflection, not a padded one.** Still look for the one interesting thing.
- **Zero prompts on a day with chats is a broken probe** (Step 0a), not a quiet day.
- **The reflection is written first** (Step 1), so a timeout later still leaves it on disk.
- **One theory, one entry.** Update the existing entry; a twin drifts into a second version.
- **This file is the whole instruction.** Do not go looking for the "real" routine elsewhere.
- **Do not write notes through the shell** (`cat >> file <<'EOF'`, `echo >>`). Use the file write
  and edit tools. Note prose holds backticks, `$(...)` and `$VAR`; a heredoc that lands inside a
  double-quoted argument runs that prose as commands.
- **memory-consolidation files the memories.** This job reflects and fixes; it does not route facts
  into long-term notes.
