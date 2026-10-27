---
schema: "kit/1.0"
slug: "run-the-docs"
title: "Run the docs yourself, and correct them as you go"
summary: "Follow a guide (setup, install, restore, migration, runbook, README) on a real target exactly as written, log every place it fails or says nothing the moment it happens, and correct the pages in a second lane while the run continues. A page written from records is a guess until somebody runs it. Every run adds a row to the table at the end, so what running a doc is worth gets measured instead of assumed."
version: "1.2.0"
owner: "globalcaos"
license: "MIT"
category: "writing"
subdivision: "documentation"
tags:
  [
    "documentation",
    "docs",
    "manual",
    "setup guide",
    "install guide",
    "runbook",
    "readme",
    "restore guide",
    "migration guide",
    "apply the docs",
    "follow the docs",
    "follow the guide",
    "fix the guide",
    "the guide fails",
    "on the new machine",
    "set it up from the docs",
    "test the manual",
    "test the documentation",
    "is the documentation correct",
    "update the docs with your experience",
    "try it yourself",
    "do it from scratch",
    "restore drill",
    "docs as tests",
    "dogfood the docs",
    "aplica la documentació",
    "prova el manual",
    "sigue la documentación",
  ]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis"
params:
  doc:
    {
      type: "string",
      description: "The pages to run, as paths or URLs, in the order a reader follows them.",
    }
  target:
    {
      type: "string",
      description: "The real system the run changes: a machine, a fresh clone, a VM, an account. Never one the owner has declared hands-off.",
    }
  docs_branch:
    {
      type: "string",
      default: "docs/run-<topic>",
      description: "Branch the corrections land on, checked out in its own worktree.",
    }
  doc_recipe:
    {
      type: "string",
      default: "",
      description: "The recipe that governs this doc set (build, style, merge gate), if one exists. Its rules apply to lane B.",
    }
  ledger:
    {
      type: "string",
      default: "/tmp/run-the-docs-<topic>/ledger.md",
      description: "Append-only log, one line per step run. The only thing the two lanes share.",
    }
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
    - [4]
    - [5]
---

# Run the docs yourself, and correct them as you go

**What it is for.** Docs that work for the next person who follows them cold, with nobody to ask.
**How it was derived.** Two runs on 2026-10-06 and 2026-10-07 (see Failures Overcome and the
table at the end). In both, running the guide found what reading it never had.
**What would change it.** The table at the end. If runs keep coming back clean for a kind of doc,
that kind can be spot-checked instead of run in full; if a class of error keeps appearing, the
step that should catch it gets sharper.

## Why run it yourself

The person who wrote a page fills every gap in it from memory without noticing. A page built from
records (diaries, transcripts, old commands) has the facts but not the state the reader starts
from. Running it is the only way to see the difference.

On 2026-10-07 a setup guide was written in the morning from 1,421 recorded commands, then run on a
freshly restored unit in the afternoon. Seven of its steps failed or misled the reader, and all
seven had read correctly on paper. The table at the end keeps that count for every run. Look at it
before deciding whether a doc can be trusted without running it.

## When to use

- Something is about to be set up, installed, restored or migrated, and a guide for it exists. Run
  the guide, not your memory of how it was done last time.
- A doc was written from records and has never been executed.
- After an incident, before relying on the recovery doc the next incident will depend on.
- The owner says "apply the docs", "set it up from the docs", "test the manual", or "update it
  with your experience".

Not for a target nobody may touch (a unit about to ship, production with no disposable copy). Then
the page stays marked untested, and you say so.

## Steps

### 0. Frame the run

**Done when:** the target's start state is measured and saved, the docs branch has its own
worktree, and the ledger file exists with its header.

- Write down what the doc promises at the end, as checks you can run on the target.
- Add every requirement the owner has stated for this target that the doc does not carry yet (in the
  conversation, in notes, in an earlier ask). Each one is an end-state check, and its absence from the doc is a
  `missing` line.
- Measure where the target starts, with commands, and save the output next to the ledger. Never
  assume the start the doc assumes. Worked instance: a unit restored from its sibling's disk image
  came back with the sibling's hostname, addresses and code tree, and every page assumed a clean
  flash.
- Put the docs on a branch in a worktree:
  `git worktree add -b {{docs_branch}} /tmp/<topic>-docs <base branch>`. Never switch the branch of
  a checkout someone else is using. If `{{doc_recipe}}` is set, read it now: its build, style and
  merge rules apply to lane B.
- Create `{{ledger}}`. First line: the doc, the target, and the start time from `date`.

### 1. Lane A: run the doc on the target, as written

**Done when:** every step in scope has a ledger line, and the target passes the end-state checks
from step 0.

For each step, in the order the doc gives:

1. Copy the command exactly as written and run it. Use your own version only after the literal
   one has failed, and log the failure first.
2. Check it worked with the doc's own check. If the page has none, use yours and log a `missing`
   line, because the reader needs that check too.
   A step whose result a person sees (an icon, a window, the layout of a screen) is checked with a
   screenshot of that screen, not with a file listing: a launcher that exists can still sit in the wrong corner.
3. Write the ledger line before starting the next step:
   `step | page#anchor | doc says | what happened (the command and the one output line that decides it) | class | correction`

| class       | meaning                                               | goes into the doc as                               |
| ----------- | ----------------------------------------------------- | -------------------------------------------------- |
| `ok`        | ran as written, check passed                          | remove any "untested" mark                         |
| `wrong`     | failed, or sent you somewhere wrong                   | corrected text                                     |
| `missing`   | you had to do something the doc never mentions        | a new step or check                                |
| `ambiguous` | it can be read two ways and you had to guess          | one reading, stated plainly                        |
| `drift`     | the target wasn't in the state the doc assumes        | a "before you start" note                          |
| `value`     | a value specific to this unit or site (address, name) | a row in one shared table, or the standard (below) |
| `slip`      | your own mistake at the keyboard                      | a warning at that step                             |

A slip counts. If you made it while following the page, the next reader will too.

For every `value` line, first ask whether the value should differ between units at all. Per-unit values are few: the hostname, the uplink address, a serial number. Anything every installation can share (an internal device network, ports, paths, user names) is a standard: it goes into the procedure itself, and the same value on every unit is what lets a spare unit or a disk image fit any site. When an instruction makes a standard value per-unit, say so before applying it, even when the owner gave the value.

Don't work around a failure without logging it. An unlogged workaround leaves the target right and
the doc wrong, in a place nobody will check again.

Steps that can cut your own connection (changing the address you're connected through, firewall
rules, network drivers) go through recipe `risky-remote-change`: arm a timer that undoes the
change unless you cancel it. Steps longer than about two minutes (installs, downloads, builds) run
on a supervised unit (skill `longjob`, or `systemd-run --user`), never as a background `&` from a
tool call. Switch to lane B while they run.

### 2. Lane B: correct the pages from the ledger while lane A runs

**Done when:** every ledger line that isn't `ok` has its correction in the docs worktree, and every
step this run didn't execute carries a visible "untested" mark.

- Work from the ledger, never from what you remember of the run. Pick lines up whenever lane A is
  waiting on an install, a reboot or a build.
- Alone: edit between steps. With helpers, when three or more pages need changes or the run is
  long: one subagent per page, given only that page's path, its ledger lines and the doc's style
  rules, and allowed to edit only that file. Separate files can go in parallel. A file several
  pages share (an index, the values table) gets a single owner.
- Lane B never touches the target. Only lane A appends to the ledger.
- Put each correction where it belongs: the step's own text, the shared values table, a warning at
  the step, a "before you start" note, or a check line after the step ("you should see …").
- Keep the doc's voice and layout, and match the steps around the one you change.
- A step this run didn't execute keeps its "untested" mark, or gets one. Remove the mark only from
  steps you ran.

### 3. Find every copy of each corrected value

**Done when:** every value, name or command corrected in step 2 has been searched for across the
whole doc set, and every copy says the same thing.

One wrong address on one page is a sample. `grep -rn '<old value>' <docs folder>` over every page,
including the ones this run never opened (backup, operations, troubleshooting), and fix them all
on the same branch.

### 4. Close the run

**Done when:** the docs build and pass their link check, you have looked at the changed pages
rendered, the branch is committed, and the owner has the preview link and the merge status.

- Build the docs if they have a build step, run the link and anchor check, and look at the changed
  pages rendered (screenshot or browser), not only at the source.
- Grep the diff for secrets before committing. Credentials met during the run go to their store.
  The page says where they live, never what they are.
- Commit on `{{docs_branch}}` with a message listing the corrections by class. Merge if you're
  allowed to. If the repo has a review gate, leave the branch open and say so.
- Tell the owner: the target's end state and the checks that prove it, the corrections by class,
  what is still untested, and what waits on a decision only they can make.

### 5. Measure what the run was worth

**Done when:** a new row is in the table below, with numbers counted from the run's ledger.

Count the classes in the ledger (`cut -d'|' -f5 {{ledger}} | sort | uniq -c`) and add a row.
Describe the doc and the target in general terms: no host names, people or addresses.

How to read the table: corrections divided by steps executed is the doc's error rate. While it is
high, run that doc before trusting it. After two runs in a row with no `wrong`, `missing` or
`ambiguous` line, the next run of the same doc can be a spot check of the steps that changed since.
This threshold is a starting guess; change it when the table says otherwise.

## Constraints

- Literal first. A deviation is logged before anyone works around it.
- One writer per surface: lane A owns the target, lane B owns the docs worktree, and only lane A
  appends to the ledger.
- Corrections go on a branch in a worktree, and nothing crosses a review gate without the owner.
- Unit and site values live in one table that the other pages link to. After any value changes,
  step 3 runs.
- No secrets in the doc or the ledger.

## Safety Notes

- A run changes a real system. Get the owner's go for the target, and treat "hands-off" as
  absolute until the owner lifts it.
- Before an irreversible step (flash, format, wipe, restoring over a disk), confirm the target's
  identity with a command that prints it, not from memory.
- A disk image carries its source's identity: hostname, keys, VPN profile, addresses. Two copies on
  one network clash, so a restore guide has to change the identity before the copy joins the
  network.

## Failures Overcome

- **2026-10-07, the run this recipe comes from.** A setup guide written that morning from recorded
  commands was run on a freshly restored unit. The owner, giving the go: _"As you now discover
  [the unit] and reassign the IPs and make them fixed, you will have the opportunity to test the
  manual and update it with your experience."_ Seven steps failed or misled. A plugin card's
  Start button only connects the plugin, and each script needs its own Start; pressing Start a
  second time spawned a copy that died and made the launcher show "finished" while the real one
  kept running. The old network profiles had other names, so "edit the profile" became "disable
  every other profile on that port". The hostname step missed `/etc/hosts`. A power-mode `sed`
  assumed a default the restored image didn't have. The restored code tree pulled over HTTPS
  instead of its deploy key. Re-addressing over SSH needed a revert timer. An installer started
  remotely with `&` wrote an empty file. Two of the seven were slips at the keyboard, and the page
  now warns about both.
  The corrections were made in one batch after the run, from the session's memory, with no ledger
  on disk. That worked only because the run was short. Afterwards the owner asked for this recipe:
  _"create a recipe that will allow you to understand the usefulness of trying something for
  yourself, then updating a documentation in parallel."_ So step 1 now writes the ledger per step,
  and step 2 runs alongside it instead of after.
- **2026-10-07 15:42, the owner found a gap after the second run.** _"You forgot to put the test bench icon in the middle of the desktop in Fore2."_ He had asked at 10:58 for the app "in the center of the desktop". Neither run turned that into a check: the doc only said "put the launcher on the desktop", the run checked the file was there, and nobody looked at the screen. The launcher sat in the bottom-right corner. Step 0 now adds the owner's own requirements as end-state checks, and step 1 checks anything a person sees with a screenshot.
- **2026-10-07, the second run on the same unit.** The first run had given the unit its own internal device-network address because the owner proposed one ("If Fore1 is .2, then it makes sense that Fore2 is in .3"), and the page grew a per-unit address table. The owner, an hour later: _"It actually does not make sense since we want to create a standard set-up for every installation, and you did not catch it."_ Nothing in the steps asked whether a value should be per-unit at all. Step 1 now does, for every `value` line.
- **2026-10-06, a restore drill.** Following the restore guide from scratch on a second machine
  showed that the nightly backup left 19.4 GB of the agent's state out of every backup, behind a
  coverage check that could not fail. Reading the guide had never shown it. The next day, driving
  the same restore from another machine, every new SSH session waited for a browser approval
  (Tailscale SSH in "check" mode) and a scripted SSH just hung. That went into the guide as a
  warning with its one-line fix.

## Runs

One row per run, added in step 5. Corrections = `wrong` + `missing` + `ambiguous` + `drift` +
`value` lines.

| date       | doc                                               | target                                   | steps executed | corrections | slips        | untested left                                                                                      |
| ---------- | ------------------------------------------------- | ---------------------------------------- | -------------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------- |
| 2026-10-06 | agent-host restore guide                          | a second machine, from scratch           | not counted    | 3           | not recorded | not recorded                                                                                       |
| 2026-10-07 | edge-unit setup guide (setup, operations)         | a unit restored from its sibling's image | not counted    | 5           | 2            | 2 sections waiting on the owner, touch-panel rules                                                 |
| 2026-10-07 | same guide, second run: the standard site install | the same unit                            | 9              | 5           | 1            | a reboot; a finger on the touch panel (missed: the launcher's place on screen, found by the owner) |
