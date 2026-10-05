---
schema: "kit/1.0"
slug: "big-software-design-by-phases"
title: "Big software design by phases — from a prompt, a paper or a short interview to a buildable plan"
summary: "Design a large piece of software in passes the principal reviews one at a time: intake from a prompt, a paper, a document or a short interview (questions until there is enough to go on); pass 1, the architecture choices; pass 2, a visual UI page where every mock-up has its own feedback box; feedback rounds; then the build and, when something live is replaced, a shadow run and a staged cutover. Use for 'plan how to code X', 'design X', 'first pass / second pass', 'show me the UI ideas', 'replace the current implementation'."
version: "2.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "design"
tags:
  [
    "design by phases",
    "big software design",
    "first pass",
    "second pass",
    "implementation plan",
    "plan how to code",
    "ui design",
    "design page",
    "mock-ups with feedback",
    "replace the implementation",
    "from a paper to code",
    "digital amygdala",
  ]
antiTriggers: ["one-line fix", "typo", "bug", "revise the paper"]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
  notes: |
    Passes are barriers: each waits for the principal's review of the one before. Inside a pass,
    independent reads (inventory, source sections, existing UI) and the build's disjoint units fan out.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Repository folder for the plan document.",
    }
  design_dir:
    {
      type: "string",
      description: "Private folder for the design page and its saved feedback (never a public repo).",
    }
  design_port:
    {
      type: "number",
      default: 18797,
      description: "Loopback port for the design page; pick a free one per project.",
    }
---

# Big software design by phases

> One pass, one artifact, one review. The principal steers between passes, so a wrong turn costs a pass, not
> the build.

## Goal

Turn an idea into software the principal recognises as theirs. Each pass adds one layer (choices, then
appearance, then detail), each is short enough to be read, and each ends with the principal's feedback before
the next begins.

## When to Use

- A system too big for one plan: a new subsystem, a rewrite, an implementation of a paper or a spec.
- The principal wants to see and steer the design, not only receive code.
- Something live is being replaced and the change must not open a gap.

## When NOT to use

- A change that fits in one sentence and one file: `coding/feature` with its task-sizing shortcut.
- Revising a paper: `writing/papers/adversarial-review-loop`.

## Steps

### 0. Intake: know enough to plan

**Tools:** read, exec
**Done when:** the source is read (prompt, paper, document or dialog), the existing implementation is inventoried
and measured live, and every blocking question has an answer or a stated default.

The source can be anything. A paper or document is read by section, and the plan will point to those sections.
A bare prompt usually needs a **short dialog**: ask, in one batch, only the questions whose answers change the
plan (what it is for, who uses it, what exists and what it replaces, hard constraints, what "done" looks like).
Offer a default for each, stop when each has an answer or an accepted default, and never run more than two
rounds.

When replacing something, measure what runs today, not what the code implies: whether it is enabled, whether it
enforces, what it logs. The most important fact for the plan is often there.

### 1. Pass 1: architecture choices

**Tools:** read, write
**Done when:** one short document in `plans_dir` holds the shape, a choices table (choice | why | instead of),
the module map, the build order, the cutover, the lines not to cross, and the open items split into "the
principal decides" and "unverified". The principal has read it.

Explain choices; do not restate the source. Point to its sections instead. No test plan and no fine detail in
this pass.

### 2. Pass 2: the UI, as a page the principal can react to

**Tools:** write, exec, read
**Done when:** a page in `design_dir` shows one mock-up per user-visible outcome, each with a verdict (keep,
change, drop) and a feedback box; it is served, driven by a scripted browser and looked at; the principal has
the clickable URL and path; the plan document has a short UI-choices section.

- **One mock per outcome the user will actually see**, in every state that matters: default, expanded, after
  the action, and when something is broken. Make controls live where the behaviour is the point (a rewind that
  refills the box, an expander, a self-test button).
- **Quiet by default.** A panel nobody opens is worse than none: lead with one line that is always true, and put
  the rest behind expanders with one-line summaries.
- **Show names, not internals.** No literal prompts or questions in the UI or the plan, only what they are about.
- **Use the product's own palette**, read from its stylesheet, so the mock looks like the real thing.
- **Feedback reaches the server without a button hunt.** Every change in a feedback box saves itself to
  `/save` about a second after the last keystroke (debounced), with "saved HH:MM" shown beside the box, and the
  page ends with a large **Submit feedback** button after the last block. A save button in a fixed bar is not
  enough on its own: the principal filled a whole page and could not find it (2026-10-02).
- **Serve it with `server.py` from this kit**, copied into `design_dir` and run as a persistent user service on
  a free loopback port. It saves each round with a timestamp plus `latest.json`, restores the last save on open,
  and has a load button. A transient process dies with the next power-off.
- **Test saves against a scratch server** (`--port <other> --out $(mktemp -d)`), never the principal's folder.
  Click hidden radios through their labels; select repeated blocks with `.nth()`, not `nth-of-type`.
- **Look at the screenshots** before handing over, and put the URL and the path on their own lines.

### 3. Feedback rounds

**Tools:** read, write, exec
**Done when:** every block in the latest save is resolved (keep frozen; change revised in the page and the plan;
drop removed with its reason) and the principal has either nothing left to change or says go.

Read `feedback/latest.json`. Revise, re-serve, and say which blocks changed. Old saves stay on disk as the
record of the principal's decisions.

### 4. Further passes, only if needed

**Tools:** read, write
**Done when:** each extra layer (data model, interfaces, migration, rollout) exists as one short section or one
page, and has been reviewed like the passes before it.

### 5. Build

**Tools:** exec, edit, write
**Done when:** the build order of pass 1 is done in parallel waves, merged into the integration branch, and a
replaced system has gone through a shadow run and a cutover staged for the next start.

uses: parallel-build

**When the principal will not be in the loop**, run the build with recipe `master-worker-coding` (the loop's
mechanics, review checklist and failures live there). In short: a master–worker loop between two chained
Tinker tabs (the smarter model reviews, the other builds). Write a **charter** the worker re-reads every turn:
sources, worktree and branch, the principal's decisions, the defaults taken in their absence (the live system
does not change), one phase per worker turn with a deliverable and a done-when, the rules, a status file per
phase, and the master's review checklist. Give the worker its own worktree with its own installed dependencies (master-worker-coding Step 1: never a linked `node_modules` when a step runs `pnpm install`). Arm
`wake-on-finish.mjs` (a long `--timeout`, build phases outlast review rounds) before every send, send with
`converse.mjs --no-wait`, and end the master's turn (`writing/papers/adversarial-review-loop` Step 3 has the
commands). **The status file, not the wake, marks the end of a phase:** a worker that launches a background
workflow ends its turn early, the one-shot watcher fires, and the workflow's completion starts a turn nobody
watches (J11, 2026-09-29: wake at 18:08, real end at 19:12, noticed at 19:25). The worker writes the status file
only at the true end; a wake without one means re-arm, send nothing, end the turn. **Exception, a gateway restart:** it gives
the worker a fresh session that has never read the charter, so it can finish a phase and skip the status file.
If the wake comes after a restart, the tree is clean, the phase's commits are there and the worker says it is done,
verify it yourself, accept it, and have the status file written first thing next turn. Every restart-recovery
message to a worker should name the charter path (J11, 2026-09-29 22:08, Phase F). Worked instance: J11 amygdala build, charter in
`~/Documents/AI_reports/Papers/J11_learned_intuition/build/charter.md`, 2026-09-29.

**Review checks when something live is replaced** (all three were missed by the worker in the J11 build and
caught at the master's review, 2026-09-29):

- The shadow run must see the **real traffic path**. If the new component only hooks in when it enforces, shadow
  sees nothing; run old and new side by side on the same path, the new one adding no latency.
- "Protection never lapses" must be **code**, not convention: the new floor switches itself on whenever the old
  one is not enforcing.
- **"Applied" must be proven by behaviour, not by a stored flag.** Any state that says a change took effect
  (a learned threshold, a config value, a toggle) needs a test that the behaviour actually changes, end to end. In
  the J11 build a learned danger cut-off was stored and reported "applied" while the table never read it (caught
  by the worker reading its own code, 2026-09-29).
- **Check the shared checkout before the merge phase, not at it.** `git merge` refuses while anything is
  staged there, and refuses to touch a file another session left dirty. If either holds, the merge is the
  principal's call: name the files and their owners, never stash or commit someone else's work (J11, 2026-09-29:
  build green, merge blocked by four sessions' uncommitted work).
- Code merged into the integration branch is **live at the next build**, before anyone enables it: every touched
  shared path (bridge arguments, UI) needs a test that it behaves exactly as before while the feature is off.

**Build the test environment for speed in the first wave.** The charter takes `master-worker-coding`'s Speed
tactics, and the first wave builds suites that run parallel from day one, timing tests that run alone, cheap
fakes and test-only settings for costly production ones. The AcmeVision 2.0 build ran 20 hours on
single-process suites before a turn went to retrofitting them (2026-10-01).

When something live is replaced, its protection never lapses: the old system keeps working until the new one is
staged to take over, and the removal of the old one is its own commit.

uses: finish-branch

### 6. Report

**Tools:** none
**Done when:** the principal knows what exists, what is running (source, built and restarted are three different
states), the merge and branch state, and what is still open.

## Constraints

- One pass, one artifact, one review. Never start a pass before the previous one was read.
- Summarise; point to the source instead of restating it. "Too much rigour is rigour mortis" (principal,
  2026-09-29).
- Every mock-up carries a feedback box; mock data is labelled as mock data.
- The design folder is private; the server binds loopback only.
- Links the principal should open go on their own line, as a URL and as a path.

## Safety Notes

- Config changes to a live platform are staged for the next start, never toggled from a chat.
- Enforcement flips, data leaving the machine, and deletions of the old system are the principal's decisions.

## Failures Overcome

- **Born project-specific (2026-09-29):** pass 1 was written as `digital-amygdala-build`; at the second pass the
  principal asked for a name "useable by other things" that can start from a prompt, a paper or a dialog. The
  amygdala is now the worked instance below.
- **The verbose panel nobody reads:** the amygdala v3.1 panel listed every tool call. Pass 2 leads with one line
  and counts the rest.
- **A link present but not found:** a path in the middle of a paragraph went unseen. URLs and paths get their own
  line.
- **A scratch cleanup blocked by the safety floor:** `rm -rf /tmp/…` of a test folder was held by the live guard.
  Use a fresh `mktemp -d` folder per test run instead of deleting one.
- **A design server that died with a power-off** (decision page, 2026-09-25): run it as a persistent user
  service.
- **Answers typed, never sent** (Thalamus full deploy, 2026-10-02): "I have filled up the questionnaire but cannot
  find a submit button." The answers lived only in the browser's draft and were recovered from Chrome's local
  storage. Pages now save each change to the server and end with a Submit button (Step 2).

## Worked instance

J11 digital amygdala, 2026-09-29. Pass 1: `docs/plans/2026-09-29-digital-amygdala-implementation-plan.md`. Pass 2:
a ten-block design page (refusal rewind, hold and proof cards, the second-opinion ask, sent-back chip, notes,
approval card, the panel closed, open and broken, the composer dot) served at `http://127.0.0.1:18797/`.
