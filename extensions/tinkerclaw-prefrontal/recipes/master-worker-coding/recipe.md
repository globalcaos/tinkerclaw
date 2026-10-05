---
schema: "kit/1.0"
slug: "master-worker-coding"
title: "Master–worker coding — a long build run by two chained tabs, one building, one reviewing"
summary: "Run a coding task that takes hours as a loop between two chained Tinker tabs: a worker model builds one phase per turn in its own worktree, and a stronger master model checks each phase against a charter, re-runs the tests itself, writes the next turn and ends its own turn, woken by the worker's finish. Works with the principal away."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "orchestration"
tags:
  [
    "master worker",
    "master-slave",
    "master slave loop",
    "co-coding",
    "long coding task",
    "unattended build",
    "build while I'm away",
    "loop with the worker",
    "worker tab",
    "slave tab",
    "phase by phase build",
  ]
antiTriggers: ["review the paper", "one-line fix", "typo", "single file", "quick question"]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
    - [5]
    - [6]
  notes: |
    One master review per wake, one send per turn. A turn fans out every unit whose inputs are merged,
    from as many phases as that covers (Step 2); the master's checks are independent reads and run
    together, and its full re-run overlaps the next send (Step 3).
params:
  charter_dir:
    {
      type: "string",
      description: "Private folder for the charter, turn files and status files (never the public repo).",
    }
  worktree:
    {
      type: "string",
      description: "The worker's own git worktree on a feature branch, with its own installed dependencies.",
    }
  wake_timeout:
    {
      type: "number",
      default: 14400,
      description: "Seconds the watcher waits for one worker turn.",
    }
---

# Master–worker coding

> The worker builds, the master checks. The master never trusts a report it has not re-run, and it never
> waits idle: after the send it works the pipeline in parallel, ends its turn when that work is done, and the
> worker's finish wakes it.

## Goal

Finish a long coding task (hours, many files, several phases) with review quality that does not depend on the
principal watching. The worker model does the volume; the master model (the stronger one) holds the plan,
catches what a builder misses at the edges of the live system, and keeps the record honest.

## When to Use

- A build with a plan already made (for example the output of `big-software-design-by-phases`), split into
  phases that each end in something testable.
- The principal will be away or only glancing in, and wants the work to keep moving safely.
- A cheaper or faster model can build, and a stronger one should review.

## When NOT to use

- A task that fits in one turn, or a single file: do it directly.
- Reviewing a paper: use `writing/papers/adversarial-review-loop`, the same loop shaped for referees.
- No plan yet: design first (`big-software-design-by-phases`), then build with this.

## Steps

### 0. Pair the tabs and write the charter

**Done when:** `loop-partner.mjs` returns `role: master` for this tab, and a charter exists in `charter_dir`.

The principal chains the two tabs in the Tinker UI (right-click a tab, **Set conversation slave**). Resolve the
worker's session key with `loop-partner.mjs` (see `adversarial-review-loop` Step 0); never guess from titles.

The charter is the worker's memory. It re-reads it every turn, and it is the only thing that survives a gateway
restart. It holds: the sources (plan, design, paper); the worktree and branch; the principal's decisions (apply,
do not re-ask); the **defaults taken while the principal is away** (the live system does not change, new code ships
switched off); a phases table (phase, deliverable, done-when; the last phase is the merge: in the principal's own repo a merge into its integration branch is pre-authorized, but into a product
branch someone else ships from it is the principal's go only, never the master's, and the charter says which);
the rules below; the **Speed tactics** below, copied in as rules; the reporting contract; and the master's
checklist for every wake.

The reporting contract separates two kinds of open question. **Decisions for the principal** are only the
ones he keeps: product, customer, money, safety, people. **Technical choices** go to the master, each with the
worker's recommendation, and the master decides them in the charter. A worker left alone escalates every
fork in the road to the principal, and a master that forwards them spends his attention on calls he delegated.

### 1. Give the worker its own worktree

**Done when:** `worktree` exists on a feature branch from the integration branch, its own dependencies installed,
tree clean.

Install the worktree's dependencies from the package store (`CI=true pnpm install --frozen-lockfile`, `uv sync`):
it takes seconds. Symlink a `node_modules` into a worktree only when nothing in the run calls the package
manager's install (a `make test` with a `deps` prerequisite does). pnpm treats a linked `node_modules` it did
not create as a folder to purge, and the folder it purges is the shared checkout's. The same holds for the
master's own re-run worktree.

Never let the worker build in the shared checkout. Other sessions keep work in progress there, and builds there
break them.

### 2. Send a phase, then end the turn

**Done when:** the Gantt is drawn and looked at, the watcher is armed, the turn file is sent, the worker is
running exactly one process, the Gantt block is in the reply, and the master either works the parallel track
below or has ended its turn.

Write the turn file in `charter_dir/turns/<nn>-<phase>.md`: corrections from the last review first, then the
phase.

**Start every worker turn in a fresh session.** Before arming, reset the worker session
(`openclaw gateway call sessions.reset --params '{"key":"<worker key>","reason":"reset"}'`; the old transcript stays
on disk). **Check its answer before arming:** it must carry a new `sessionId`. A session the gateway still counts
as active (a turn that just ended, or an idle worker process you have just stopped) is refused after 15 s with
`UNAVAILABLE … still active; try again in a moment`. Wait a few seconds and retry; never send on a refused reset,
because the turn then lands in the old session with all its context (2026-10-01 23:52: the master stopped the idle
worker, reset at once, filtered the answer for a `sessionId`, saw nothing, and sent anyway). A resumed session drags
the whole build into every model call: on the AcmeVision 2.0 build each call
carried about 565k tokens resumed and 216k fresh. So the turn file opens with what to read, in order (charter,
the last status or progress file, the last pins and turn file), and never says "as before" without naming the
file. Past 8 MB the bridge would not resume the transcript anyway.

**Send every unit whose inputs exist, not only the next phase's.** Phases are a reading aid, not a queue: a
unit of a later phase that needs only what is already merged goes into this turn's fan-out, beside the
current phase. Leave for later only what spans units not yet built (a full translation pass, a test of every
screen). A track that waits on the principal (a spec that needs his answers) goes to him as early as
possible, because his time is the slowest resource in the build. A phase that cannot start yet is listed, not
used as a reason to stop: send the next unit whose inputs already exist, even when it only prepares a later
phase (a measurement, scaffolding, a watcher for the machine that is off). The loop ends only when the
principal says stop. (2026-10-03 19:07, his words: "Why did you stop? The whole goal of a long-running task is
to not stop for anything." The 15:48 review had ended the loop because Desk1 was off and his calls were open.)

CPU is the ceiling, not agents: agent units
mostly wait on the model, so fan them out freely. Tests get a **core budget**, not a suite count: the charter
names the most test processes allowed at once (pytest workers, Playwright workers, browsers; 12 of 16 cores on
the AcmeVision laptop), and every suite runs parallel inside itself. "Two suites at once" let two
single-process suites use 1.4 of 16 cores while the worker waited. Timing tests (a latency bound, a real-time
rate) carry a marker and run alone after the parallel pass. If the project's suites cannot run parallel yet
(one shared database, one mock server), making them parallel is the first track of the next turn.

**Before the send, draw the Gantt** (skill `build-gantt`, `~/src/tinkerclaw/skills/build-gantt/SKILL.md`).
In `charter_dir/gantt.json`, add the workflow ids the worker ran since the last send to their phase, mark
the phase you are about to send `"status": "next"`, and keep the estimates of the phases after it current.
Then `python3 ~/src/tinkerclaw/skills/build-gantt/scripts/gantt.py derive charter_dir/gantt.json` and
`… render charter_dir/gantt.json --png /tmp/<build>-gantt.png > /tmp/<build>-gantt.block.md`. Look at the
PNG. The block goes into this turn's reply to the principal, every phase, never a bare progress bar. In
Tinker the reply is the turn's last text block, so it lands in the same turn as the send. A plan without
a `gantt.json` gets one now: conception and spec from the build's own dated files, past phases from their
workflow ids, the rest as estimates sized on the phases already measured.

Then:

```bash
S=~/.openclaw/workspace/skills/conversation-loop/scripts
[ "$TC_SESSION_KEY" = "<master key>" ] || { echo "not the master tab: never arm from the worker"; exit 1; }
READY=/tmp/<build>-wake.ready                  # one file per build
systemctl --user is-active <build>-wake && { echo "watcher already running"; exit 1; }
rm -f "$READY"
systemd-run --user --unit=<build>-wake --collect node $S/wake-on-finish.mjs --watch "$WORKER" \
  --wake "$TC_SESSION_KEY" --ready-file "$READY" --timeout {{wake_timeout}}
for i in $(seq 1 240); do [ -s "$READY" ] && break; sleep 0.25; done
[ -s "$READY" ] || { echo "watcher not armed"; exit 1; }   # never send unarmed
node $S/converse.mjs --session "$WORKER" --say-file <turn-file> --no-wait --json > <turn-file>.sent.json
```

Then count the worker's processes for 30 s: `claude` processes whose `/proc/<pid>/environ` holds
`TC_SESSION_KEY=<worker key>`. Do not match `--resume <session-id>` in the command line: file-transport workers
start without it and that count reads 0 while the worker runs. More than one working process is a twin: stop and
investigate before anything else. **After a gateway restart the count can read 2 with no twin:** the new gateway
adopts a mid-turn worker, lets it finish, then spawns a fresh worker for the next prompt and leaves the adopted one
idle (2026-09-30, J19). Check `readlink /proc/<pid>/fd/0`: a FIFO under a worker dir whose gateway pid is dead
cannot be fed, so it is a leak, not a twin. Step 3.3's test (one prompt copy, one reply chain) decides. **A real
twin** (two live processes, two prompt copies): stop the unit whose `$XDG_RUNTIME_DIR/tinkerclaw-workers/<unit>/meta.json`
reads `turn: null`, because the gateway no longer tracks it and its turn end wakes nobody. Then check every worktree
and branch it made, and tell the survivor by SendMessage (its `cc-socks/<pid>.sock`) that it owns the turn, so it does
not stand down for a dead twin's leftovers. **Count once before the send too:** the principal may have typed in
the worker's tab between turns, and that turn's process stays alive after it ends. A process that is already
there before the send, whose `meta.json` reads `turn: null`, whose gateway pid is gone and whose last output
line is a `result`, is a finished leftover, not part of this send: read what it did (it may have committed
somewhere), then stop its unit so the count after the send reads clean. Then end the turn with one line to the
principal.
Never wait in the turn, never `--wait`, never spawn a subagent or a side CLI instead.

**A recovery send owes a fresh watcher (2026-10-04).** Before resuming a worker after a provider failure, restart or manual handoff, inspect the watcher itself. A watcher that already emitted `slave failed` has finished; it does not watch a later successful continuation. Re-arm and confirm the ready file before EVERY recovery send, including a continuation sent manually from the worker tab. At the next master status request, compare the latest worker completion with the latest charter review and next-turn sent artifact. If a completion is unreviewed and the worker is idle, review it and dispatch the next eligible unit now; do not report a long-running build as active merely because its last unit passed. Evidence: turn 29 completed at 00:40 after the watcher had reported failure; at 08:20 no turn 30 existed and the loop had been idle overnight.

**Then work in parallel, never sleep (principal, 2026-10-02).** A worker turn takes hours. After the send the
master uses them on what makes the next turns faster or safer: test machines and runners, test speed, the next
phase's inputs, the review checklist, platform defects in their own tab. Three limits: never touch the worker's
branch, worktrees, lock or turn files (prepare changes elsewhere and hand them over in the next turn file); never
take the CPU, memory or test stacks the worker's charter budget counts on (use other machines, or tell the worker
in the next turn file what moved); never poll the worker (the watcher wakes the master). Log what the parallel
track did in the review log, and end the turn when it is done.

### 3. Review at every wake

**Done when:** every claim in the status file is re-checked by the master, the review is logged in the charter, and
the next turn is sent (Step 2) or the loop is stopped.

0. **The status file marks the end of a phase, not the wake.** No status file means the worker's turn ended
   mid-phase (a background job finishes later): re-arm, send nothing, end the turn. **But a notification to an idle
   worker can be lost** (bug-log `monitor-notify-idle-session-lost`): when the worker's last message says it is
   waiting for a background job (a Workflow, a Monitor) to wake it, nothing may ever wake it, or you. Send a short
   continuation instead: wait inside this turn on the report files, then carry on. Each wait call is the full
   590 s, because every call re-reads the whole context (167 loops of about 500k tokens on 2026-10-01), and the
   loop also ends when the job's holder process is gone (`kill -0 <pid>`): report files alone never say the job
   died (a dead holder went unnoticed for 43 min). That send resumes the session
   in a NEW process beside the one holding the job, so two processes are expected: the holder (`turn: null`, its
   job still streaming) and the new tracked one. Stop only an untracked newcomer (a gateway retry), never the
   holder, or the job dies with it; tell both by SendMessage which one merges. Prevent it in the charter: a worker
   never ends its turn while something it started still runs. **Exception, a gateway restart:**
   it gives the worker a fresh session that never read the charter. If the tree is clean, the phase's commits are
   there and the worker says it is done, verify it yourself, accept it, and ask for the status file first thing
   next turn. **Exception, a killed turn:** if the worker's last message is an "interrupted" error (SIGTERM, the
   gateway's run limit) and no process of the worker is left, nothing will finish later, and a silent re-arm
   stalls the loop until the watcher times out. Read where it stopped (its worktrees, the workflow journals) and
   send a continuation turn. **Exception, a provider quota:** if the worker's last message is a weekly or rate
   limit (Claude: "You've hit your weekly limit"), stop every extra worker on that session (the gateway retries
   the same exhausted provider), keep any uncommitted worktree, write the pause into the charter and tell the
   principal. Do not move the worker or the master to another provider family: the loop pauses until its own
   provider answers again, unless the principal names a substitute himself. Paid extra usage on the same provider
   is not a limit: keep going. On resume, the first turn re-checks, with that provider, whatever another model
   built in between (2026-10-05). Tell the worker the run limit in the charter, plan turns to end well inside it, and
   give it a progress file to write when it has to stop mid-phase at a clean point. That stop includes its own
   Workflow: stop it by id (TaskStop) and check its processes are gone before writing the file. A Workflow lives as
   long as the worker process, not the turn. If one is still running at the wake anyway, the send's unit stop ends
   it: check its pids are gone right after the send, and trash the temp folders it left. The same holds for a
   Workflow the MASTER runs (a paper, a review): a gateway restart carries busy chats over but replaces an idle one,
   and an idle master tab with a Workflow in the background counts as idle, so the Workflow dies (2026-10-03 07:25,
   the paper's assembly step). Wait for it inside the turn, in 560 s calls, and at any wake where it shows as
   stopped, relaunch it with `resumeFromRunId`: finished agents come back from the cache.
1. Read the status file. **Do not re-run the suites the worker already ran on the same tip.** The worker's
   final-run logs are saved outside `/tmp` and start with the SHA they ran on: check that SHA is the tip you
   accept, compare the counts with the status file, and re-run alone (as a longjob) only what was red,
   timing-flaky, or changed after the worker's run. A full re-run of five suites on an unchanged tip costs
   20 to 40 min and, run beside the next worker turn, produces load failures instead of evidence (2026-10-01:
   two timing tests the worker had passed failed at load 42). Do the cheap checks (status file, git, AI lines,
   nothing running, prompt copies, screenshots), then send the next turn. A red targeted re-run becomes the
   first unit of that turn, by SendMessage to the worker's socket, never as a second chat prompt. `git log` and the diff stat
   since the last phase, with THREE dots (`git diff --stat <integration>...HEAD`, from the merge base): two dots
   also list every commit the integration branch gained since the cut, reversed, as if the worker had made them. Spot-read new code against the charter's lines not to cross. `stat` every claimed artifact.
   Open the screenshots behind every UI claim and check each shows the loaded screen: a spinner, "Loading…",
   "Connecting…" or an empty frame means the test took its picture too early, and a manual built from it
   shows nothing. The fix is a capture helper that waits for the screen's own content and fails on a spinner.
   Then run the EXISTING suites of every live file the phase changed, not only the worker's new tests: the worker names
   what it wrote. A red there is compared against the integration branch's tip in a scratch worktree before it is
   blamed on the branch; if the tip is red too, fix it on the integration branch, and the worker merges it in.
2. Check the live side is untouched (config and cron files' mtimes, no data folder created, nothing enabled), and
   that nothing the worker started is still running (units, mock servers, background shells).
3. Count prompt copies in the worker's transcript by `type == "user"` lines only. A plain `grep -c` also hits the
   queue and last-prompt bookkeeping lines. One copy and one reply chain means no twin, whatever the process count. Pick the
   worker's transcript by time and session, never by grepping the turn file's first line: the master's own
   transcript holds that line too once the master has read the file, because a tool result is a `type == "user"`
   line (2026-10-01 21:06: the master's 5.6 MB transcript showed "2 copies"; the worker's fresh one held 1).
4. Log one line in the charter's review log (date from `date`, never typed), then write the next turn. The time in
   a log line or a block header is generated by the command that writes it (`$(date +%H:%M)`, `datetime.now()`);
   a literal in that command is a typed time, even when `date` ran a minute before (2026-10-03 01:12: a block and
   a log line stamped "01:20", eight minutes ahead, the third such slip). A rule
   decided in the charter at this review that would serve any build (a speed tactic, a review check, a safety
   line) goes into this recipe in the same review, with the number that justified it: the charter dies with the
   build, the recipe runs the next one.

**Scope that arrives while the worker is mid-phase** (the principal adds to the spec): never send it into the busy
worker, because a second prompt on a running session is how twins start. Change the charter (sources, a dated
decision, the phase rows the new scope lands in), write `turns/pending-<nn>.md` for the next turn to open with, and
make sure the charter's wake checklist tells whichever master session reviews next to prepend it.

### 4. Final testing on what the merge will produce

**Done when:** the integration branch is merged into the feature branch, the suites pass on that tree, and
`scripts/deploy-worktree.sh --sha <tip> --dry-run` exits 0.

Merge the integration branch in first, so the last phase tests what the merge will produce. Pass `--sha`,
because without it the dry-run builds the integration branch, not yours. Host long jobs on a `systemd-run` unit
with `PATH` passed through, and wait in the foreground with bounded waits (≤ 590 s per call, repeated). Any live
external call (a paid judge, an API) runs on synthetic cases only, with a spend cap written in the turn file.
Misses that need a wording or threshold change go to the principal as decisions; code defects get fixed.

**Plan the fix turn from the start.** The charter's phases table carries a fix phase after final testing (H2 / G2):
both builds run with this recipe needed one, because live calls find what mocks cannot (J11 2026-09-29: replay
without its command, raw scores against whole-number cut-offs; J19 2026-10-01: fractional scores, reads that threw on
missing fields, true/false answers with no confidence). Budget the live run for two passes, before and after.

**Start the feature switched ON from the built `dist` once, before calling it done.** A feature that ships off
is inert by design, so every gate (tests, the dry-run, the inert comparison) passes with it never loaded. Build
with `--keep-worktree`, then load it enabled from that `dist`: missing data folders, hook scripts or assets only
show there.

### 5. Merge and clean up

**Only on the principal's go when the target is a product branch another person ships from** (Step 0). Planning the
merge is not deciding it: the charter's phases table names who gives the go.

**Done when:** the branch is merged into the integration branch, its content is proven there, and the branch,
worktree and backup refs are gone.

Check the shared checkout **before** promising the merge: `git diff --cached --name-only` must be empty, because
`git merge` refuses while anything is staged, and no file the branch changes may be dirty with someone else's
work. A file staged with its working copy equal to `HEAD` is a phantom left by the pre-commit formatter after a
pathspec commit: `git restore --staged -- <path>` clears it losslessly (prove `git diff HEAD -- <path>` is empty
first). Real foreign work is the principal's to commit or drop. Never stash it, and never commit it as your own.
Strip any AI co-author trailer from the branch before merging: back up the tip in a ref, filter only
`<integration>..<branch>`, and prove the tree is identical, with the same count, authors and dates.

### 6. Report

**Done when:** the principal has one message with the phases done, what was re-checked, the defaults taken while
he was away, the decisions that are his (one line each, pointing at the status file that holds them), and the
merge and delete status stated plainly.

## Speed tactics

Measured on the AcmeVision 2.0 build (2026-10-01, the principal's review of its first 20 hours): building units
took 51 %, end-of-turn integration and test runs 27 %, incidents 11 %, setup and review 11 %. The model was not
the bottleneck; serial and repeated testing, waiting at full context and late integration were. Every charter
takes these tactics at Step 0, and the first phase builds the test environment to fit them: that build ran
20 hours on single-process suites before a turn went to retrofitting them.

**The test environment, built this way in the first phase:**

- Every suite runs parallel from day one. Unit tests under xdist. Integration tests with one database per
  worker (a Redis index, a MariaDB schema, an SQLite file) and the few tests that share one external service in
  a `serial` group. Browser mock tests with several Playwright workers, one mock server per worker on a free
  port. A suite that cannot run parallel is a defect of the test environment and is fixed first. Measured on
  AcmeVision 2.0 after its speed phase: integration 28 min down to 7 min 48 s, browser mock 11.5 min down to 4.
- Timing tests (a latency bound, a real-time rate) carry a marker and run alone after the parallel pass. They
  are never loosened to pass under load; every flaky failure on 2026-10-01 was one of them, at load 13 to 42.
- Fakes do only the work a test reads: a fake camera draws a flat image wherever no test reads pixels (measured
  0.67 core per camera down to 0.33, with a cheaper filter graph for its counter strip and overlay).
- Costly production settings get test settings: password hashing at the cheapest parameters in tests (measured
  146 ms down to 0.04 ms a hash), and one test that checks the production parameters.
- Tests own everything their result depends on, so it is the same on any machine: a disk share of their own,
  sized under the free space of every test machine (never "the machine's free space minus a budget", which other
  writers move); ports picked free; the fonts the UI draws shipped with the UI, because a font the machine happens
  to have makes pictures, capture checks and label placement machine-dependent. A test that passes on one machine
  and fails on another has found a hidden dependency and is a red like any other. Moving AcmeVision 2.0's suites
  to a second machine found five (an absolute-path filter, the real disk in a retention test, a missing make
  prerequisite, a recorder floor read off the machine's disk, the fonts) and one product fault: labels placed as
  if every glyph were 0.6 em wide.
- Re-run state survives a new worktree: the pytest cache dir outside it (for `--lf`), Playwright
  `--last-failed`.
- Final-run logs are saved outside `/tmp` and outside every folder a tool empties, each starting with the SHA it
  ran on, so the master can accept from them.

**The turn** (details in Steps 2 and 3 and the Constraints): integrate after every merge and turn a red into a
fix unit in the same turn; a core budget, not a suite count; re-run only what failed; accept from the logs on
the tip SHA; one lock and one fresh session per worker turn; platform fixes in their own tab. Reviewers reuse
the builder's evidence (the unit's own test output on its SHA) instead of rebuilding an old copy with its own
services. The worker's fan-out should run where the pool's idle sweep and the run limit cannot kill it (its own
systemd unit, as `longjob` does), and the worker should end its turn and be woken. Until the platform does that
(bug-log `monitor-notify-idle-session-lost`), Step 3.0's 590 s wait with a holder-alive check is the fallback;
retire it when the fix is live.

- **Suite order.** The fast suites together (unit, lint, UI unit), then the stack suites together (integration,
  browser mock), then the real-stack browser suite alone, with nothing heavy beside it. Under time pressure a unit
  moves to the next turn; the order never changes. On AcmeVision turn 10 the real suite failed 6 of 47 beside
  the integration suite at load 26 and passed alone.
- **A merge that changes a shared component** (a date input, a capture helper, a fixture) runs the whole browser
  mock suite, not only the specs that look near. It takes 4 min; on turn 10 the nearby check passed and the full
  run found 8 reds.
- **A red seen twice becomes a unit.** One flaky failure is re-run alone. The same test red twice in one run, or
  in two turns running, gets its unit: a `timing` marker if it asserts a rate or a latency, otherwise a fix.
- **The model per unit, by weight.** The strongest model for a trace across the system or a unit that already
  failed once; a cheaper one for scoped units (AcmeVision turn 16: Opus for the real-suite trace, Sonnet for test
  fixes and pictures).
- **Small items ride along.** Low-priority fixes go into the next turn that exists anyway, never a turn of their
  own.
- **Say what comes first.** The turn file names what moves to the next turn if time runs short, so a clean stop
  at the 2 h 30 min point keeps the work that matters.

**Spread the suites over every machine at hand.** One laptop running every suite is the bottleneck the
2026-10-01 numbers show. A runner image with the laptop's toolchain, a bare mirror on each test machine and one
container and worktree slot per suite run turns any Docker host into extra cores: AcmeVision 2.0 does this with
`sv2-build/remote/sv2-remote` (2026-10-02). Runs use the host network and every stack picks free ports, so two
runs coexist (a container's own network broke the mDNS tests). Push only to the test machine's own mirror, never
to the shared remote, and make the push succeed when the ref already holds the commit (two runs of one commit
raced on it and one died). Keep a log per run that starts with the SHA, so the master accepts from it as from the
laptop's. Then:

- **A machine list, fastest first**, each with its cap (runs at once, CPUs, memory), and an `auto` target that
  takes the first free slot and waits when all are busy. The units' own runs and the integration runs after each
  merge go there, so the units stop competing for the laptop's CPU.
- **The final runs start all at once** (`sv2-remote fan`): every suite on its machine, one table at the end, the
  exit status the worst run's, while the laptop keeps only what still needs it. The unit suite also runs on the
  architecture that ships (an ARM box, capped so it keeps its own work).
- **A machine that ships to a customer, or runs production, is never a test machine** (2026-10-02: the ARM box was the
  controller due at a customer site in a week). Its runner footprint goes before it ships.
- **Respect each machine's owner:** nice, a CPU and memory cap, never log out a desktop session, and the owner's
  hours written in the charter (Desk1: three runs and no GPU before 14:00 on a working day, five runs and the GPU
  after).
- Measured 2026-10-02: the unit suite 10 min on the loaded laptop, 1 min 19 s on Desk1 with 16 workers; the
  browser mock suite 7.1 min against 1.9 min; six suites on three machines in 10.3 min of wall time, the ARM unit
  suite the long pole.

**Planning and measuring:**

- A phase's estimate includes its test time and a budget for one red result, not only the units' build time.
  Phase C was planned at 3.5 h of units and passed 10 h, most of it integration and re-runs.
- At every wake, split the time since the last send into building, testing, incidents and review (the Gantt
  lanes and the review log give it). When testing and incidents together pass building, fix the pipeline
  before the next phase.
- A time-left estimate that does not move while the phase runs past its plan is a finding: re-size it from what
  the phase has cost so far and say so (Phase C's stayed flat through 2.5 h of work).

## Constraints

- Every clock time the master writes (a review-log line, a §4b block header, a turn file's heading) comes from
  `date` inside the same command that writes it, never typed. Typed times drift ahead of the real clock, and once a
  sent turn file names a block by its time, that time cannot be corrected without breaking the worker's lookup.
- One send per worker turn; a turn may carry units of several phases. The worker never starts work the turn did
  not send.
- The worker commits per unit by pathspec, never `git add -A`, with no AI signature of any kind.
- Before a worker turn ends, every background shell, loop, unit or server it started is stopped. A leftover loop
  made the bridge start twin workers on one session.
- A phase is accepted on evidence tied to the tip SHA the master accepts: the worker's saved run logs on that
  SHA, read by the master, plus the master's own targeted re-runs of what was red. Never on the report's prose.
- **Integrate after every merge, not at the end of the turn.** When a unit merges into the integration branch,
  its integration and real-stack tests and the cross-unit ones run at once, and a red becomes a fix unit in the
  same turn. Leaving them to the end made every red result cost a whole extra turn of 2.5 to 3 h.
- **Re-run only what failed** (`pytest --lf` with a cache dir that survives the worktree, Playwright
  `--last-failed`). A whole suite run again after one flaky failure costs 6 to 19 min, several times a turn.
- **One run per turn.** The worker takes a lock file per turn (`turns/<nn>.lock`, its PID) before launching a
  Workflow; a second process that finds a live lock stands down. A duplicated resume must not start a second
  fan-out.
- **Platform fixes go to their own tab.** A defect in TinkerClaw found during the build is fixed in a separate
  platform tab, never in the master or worker tab, and goes live only between worker turns.
- Evidence the master must look at (screenshots, reports, logs, the manual's pictures) lives outside every folder a
  tool empties on its own: Playwright's `outputDir` at each run, `/tmp` at a reboot. Name the folder in the charter.
- A status or health line reports the running component, and a failed start must say so. Before
  shipping, test the down path: start with a required file missing and check the status says it is not
  running (2026-09-30: the amygdala read "Shadow: watching" for 13 minutes while its runtime was dead).
- "Applied" is proven by behaviour, not by a stored flag: a learned value, a config switch or a toggle needs a
  test that the behaviour changes, end to end.
- Code merged into the integration branch must be inert while its feature is off: prove it with a comparison
  against the integration branch in that state.

## Safety Notes

- The live system does not change during the loop: no gateway restart, no config edit, no plugin enabled, no
  build in the shared checkout, nothing on the production UI port.
- Mocks for every write-capable interface the UI calls. A test UI never talks to the live gateway.
- Secrets are loaded into one process's environment and never printed, logged, committed or written. Scan the
  branch (`git log -p <integration>..HEAD`) and the status files for them before the merge. `git log --all -p`
  over a large repo takes minutes, so limit the range.
- No `rm -rf` (use `trash` or `mktemp -d` scratch). No `pkill -f` or `pgrep -f`: they match your own shell.
  `trash` frees nothing on the same disk: on a nearly full machine a turn reuses one output folder and overwrites
  it, instead of trashing one per run (AcmeVision 2026-10-03: about 590 MB a run went to the Trash and pushed the
  laptop under the real stack's free-space floor).

## Failures Overcome

- **2026-10-03 21:02, AcmeVision 2.0.** Turn 29's worker died mid-unit with Claude's weekly limit ("You've hit your
  weekly limit · resets Oct 8, 6pm"). The gateway then started four more Claude workers on the same session, all
  hitting the same wall. A provider quota is a killed turn, not a reason to wait until the reset date. Step 3 now:
  stop the twins, pin the worker session to another family (`sessions.patch` `{key, model}`), keep any uncommitted
  worktree, and send a continuation that forbids a Workflow of the exhausted provider. The 19:07 "do not stop"
  rule covers quota the same way it covers a dark machine. **Superseded 2026-10-05, next entry.**

- **2026-10-05, AcmeVision 2.0, the principal: "Stop the process for now, until we have claude tokens ready, I
  don't trust the other models as much."** The 21:02 rule moved the worker to GPT-5.6-Sol while a Grok master
  reviewed it, and four turns (29b to 32) of research were built and accepted outside Claude, though at 21:20 he had
  said the build was running on extra usage. A quota now pauses the loop; switching family needs his say-so; the
  first turn after the pause has the build's own provider re-check the other models' work (turn 34, unit RC1).

- **2026-10-03 19:07, AcmeVision 2.0, the principal: "Why did you stop? The whole goal of a long-running task is
  to not stop for anything."** Turn 26 had finished and Desk1 was off the network, so the 15:48 review followed the
  old line ("when every phase left waits on the principal, send no turn and end"), stopped the worker and told him
  the build was paused. He had asked for a loop that keeps working. Step 2 now sends the next unit whose inputs
  exist anyway, and a phase that cannot start is listed, not used as a reason to stop. The loop ends only when he
  says stop. A provider limit is not: it pauses the loop (2026-10-05 entry).

- 2026-09-29, wake at 18:08, real end at 19:12: the worker launched a background workflow and its turn ended
  early, so the watcher fired on a half-done phase. The status-file rule in Step 3.0 exists because of it.
- 2026-09-29 20:19: one send produced three worker processes on one session, two of them writing, because a
  33-minute background poll left the worker looking busy. Hence the stop-everything rule and the process count.
- 2026-09-29 21:58: a gateway restart replaced the worker's session. It finished the phase but, never having read
  the charter, skipped the status file. Hence the restart exception.
- 2026-10-01 02:39: a 10-unit phase hit the gateway's 3-hour run limit (`configuredRunTimeoutMs`) one integration
  branch short of done. The worker and every workflow agent in it were killed: no status file, nothing running.
  "Send nothing" would have left the loop waiting 8 h for a turn that could never end. Hence the killed-turn
  exception and the progress file.
- 2026-10-01 02:44: the continuation send produced a twin. The resumed CLI returned an empty result in 220 ms, the
  gateway retried the prompt on a fresh bridge session, and the first CLI kept working (bug-log, same date). The
  30 s count caught it. The survivor found the stopped twin's two empty worktrees and was about to stand down for
  them. Hence the real-twin steps in Step 2.
- 2026-10-01 07:52, the principal: "In every phase of the coding, report the progress in this chat before
  sending work to your slave. The report cannot be just a progress bar, it has to have phases, in different
  colors if possible, like a gantt, where one can understand the parallelism, the complexity of tasks by their
  length and the different phases." Until then the master reported in prose plus a longjob bar, and the
  parallelism of ten units lived only in the workflow journals. Hence the Gantt before every send and skill
  `build-gantt`.
- 2026-10-01 08:09: the count after the Phase C send read 2. The extra process was the principal's own
  "keep going" in the worker tab at 07:38: finished at 08:07 (a fix merged into another repo's develop), its
  gateway gone after a 07:58 restart, still alive. One prompt copy proved no twin. Hence the count before the
  send and the finished-leftover case in Step 2.
- 2026-10-01 08:18, the principal: "Are you sure you are doing things in parallel as much as possible?" Inside a
  phase, yes: ten units started together. But phases ran one after another although D's screens needed only
  Phase B, the master's 25-minute re-run ran its five suites one by one, unit tests used one core, and the
  worker sat idle for 38 minutes while the master reviewed. Widening turn 05 to 14 units (C, D's screens, the
  manual generator, parallel tests) took the plan from 21 h to 15 h on the clock for the same work. Hence
  "send every unit whose inputs exist", the side-by-side re-run and the overlap with the next send.
- 2026-09-29: the charter told the worker to add an AI co-author trailer. 46 of 50 commits carried it and were
  rewritten before the merge. The charter's commit rule now forbids any signature.
- 2026-09-29, final testing: the new extension was missing from the lockfile, so a frozen-lockfile deploy would
  have failed. The deploy dry-run with `--sha` caught it before the merge.
- 2026-09-29: the dry-run unit exited 3 because `systemd-run` had no `pnpm` on its `PATH`.
- 2026-09-29: two UI tests failed with `DOMParser is not defined` under the package's own runner and passed
  under the repo runner (`node scripts/run-vitest.mjs`). Check the runner before blaming the change.
- 2026-09-29 22:52: the build was green, but the merge was blocked by two stale staged files (formatter phantoms)
  and by four sessions' uncommitted work in the shared checkout. Hence Step 5's check, done before the merge
  phase, not at it.

- 2026-09-30 06:30: the amygdala went live in shadow mode and failed to start (`ENOENT … questions`). The
  build copied only a plugin's `skills` folder, so its questions, cases and hooks never reached `dist`, while
  its status line still said "Shadow: watching". Every gate had passed with the plugin off. Fixed with a
  manifest `runtimeAssets` list the build copies; Step 4 now starts the feature ON from `dist`.
- 2026-09-30 06:58, J19 Thalamus build: the Step 2 twin check matched `--resume <session-id>` and counted 0 for
  30 s while the Sonnet worker was running. File-transport workers (live since that morning) start with no
  `--resume`. Step 2 now counts by `TC_SESSION_KEY` in the process environment.
- 2026-09-30 18:59, same build: after a thaw the worker resumed as a fresh session, followed the charter's master
  block and armed a watcher on its own key (it would have woken itself). It stopped it within seconds. The
  Step 2 block now refuses to run unless `$TC_SESSION_KEY` is the master's.
- 2026-10-01 02:27, J19 build: final testing's live Jev run found three read defects and a short-list floor the design
  never asked for. As in J11 (G2), a fix phase was added by hand; Step 4 now plans it from the start.
- 2026-09-30 07:44, same build, review of Phase B: `git diff --stat develop..HEAD` showed 32 files and a UI chart the
  worker never touched; the branch really held 16 new files. Develop had moved. Step 3 now says three dots.
- 2026-09-30 15:45, same build, review of D1: the worker's 587 tests were green, but the runner's own `attempt*` suites,
  which the worker had not named, had 8 red. The same 8 failed on develop's tip: a mock missing an export since
  2026-07-28, two months unnoticed. Fixed on develop (`67d8e6ddc55`). Step 3 now runs the touched files' own suites.
- 2026-09-30 07:26, same build: the principal asked for paper v4.1 (Jev ranks the enhancements) while the worker was
  mid-Phase B. Nothing said how new scope reaches a busy worker; the pending-turn rule in Step 3 is how it went.

- 2026-09-30 07:16, J19 Thalamus build: the twin check counted 2 worker processes after the Phase B send. One was
  the Phase A worker, adopted by the gateway that restarted at 07:06 and left idle with its stdin in the dead
  gateway's worker dir; the other was the fresh worker. One prompt copy, no forked chain: no twin. Step 2 now says
  how to tell them apart.

- 2026-09-30 23:31, AcmeVision 2.0 build, Phase A: the worker's status file listed five "decisions that are
  the architect's" (recorder capture time, Docker for tests, session length, a column name, migrations in the binary).
  All five were technical; the architect had said of the sync problem "I leave it to you to solve however you see fit".
  The master decided them in the charter. Step 0 now splits the reporting contract into principal decisions
  and technical choices for the master.

- 2026-10-01 11:05, AcmeVision 2.0 build, review of turn 05: the mock run's `admin-logic.png` and
  `admin-floor.png` showed "Loading…" and "Connecting…", an empty frame, while every spec around them was
  green. Phase H builds the user manual from these captures. Step 3 now checks screenshots for the loaded state.

- 2026-10-01 13:55, AcmeVision 2.0 build, review of turn 06: the 27 screen pictures were gone. The capture
  helper wrote them inside Playwright's `outputDir`, which the next run emptied, so the master could look at none.
  The second loss of this kind in one day: at 06:35 a reboot wiped `/tmp` and the reports with it. Hence the
  constraint on where evidence lives. The same review found the worker's transcript at 8.7 MB, past the resume
  limit; turn 07 was written for a fresh session and started in a new transcript. Hence the size check in Step 2.

- 2026-10-01 13:59, AcmeVision 2.0 build, turn 07: the worker, a fresh session, launched six units as a
  background Workflow and ended its turn to wait for a Monitor. Step 3.0 said re-arm and send nothing, but
  Monitor events to an idle worker are lost here, so the loop would have stalled until the watcher's 4 h timeout.
  The master sent a "wait in the turn" continuation. The resume printed an early empty result, the gateway retried
  on a second process, and three processes shared one session: the holder of the Workflow, the tracked worker and
  an untracked twin. The twin was stopped before it changed anything (bug-log `event-ordering+cleanup-race`, fixed
  the same day in worker.ts). Hence the exception in Step 3.0 and the charter rule.

- 2026-10-01 18:54, AcmeVision 2.0 build, master re-run of Phases C and D in its own worktree: the worktree's
  `ui/node_modules` was a symlink to the worker's checkout, and the Makefile's `ui-deps` ran `pnpm install`. pnpm
  tried to remove that modules folder and stopped only because the job had no TTY
  (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`); with `CI=true` it would not have asked. Nothing was lost; the
  worktree now installs its own from the store in 1 s. Hence Step 1's install rule.

- 2026-10-01 19:50, AcmeVision 2.0 build, the principal's review of the first 20 hours: "In my estimate the same
  build could finish in roughly half the wall-clock time, using far fewer tokens and much less CPU. The model
  isn't the bottleneck." Building units took 51 %, end-of-turn integration and final runs 27 % (each red result
  cost a whole extra turn), incidents 11 %, setup and review 11 %; Phase C was planned at 3.5 h and passed 10 h.
  Only `make test` ran parallel; the charter allowed "two heavy suites", which used 1.4 of 16 cores; the master
  re-ran all five suites at every acceptance on the tip the worker had just run; the worker spent 768 min in 167
  sleep-and-check loops at full context; every turn resumed the same session (565k tokens a call). Hence the
  fresh session and core budget in Step 2, the wait rule in Step 3.0, evidence reuse in Step 3.1, and the
  integrate-after-merge, re-run-only-failures, lock-per-turn and platform-tab constraints.

- **2026-10-02, AcmeVision 2.0: the master slept while the worker worked.** After each send the master ended
  its turn and stayed idle for two to three hours, while the laptop ran every suite alone and three other
  machines sat unused. The principal: "while you are waiting for a response from your slave, you can engineer
  optimizations, shuffle workloads and stuff, so instead of sending him the instructions and going to sleep,
  you can work in parallel, knowing that your slave will take a few hours to respond." Step 2 now gives the
  master a parallel track with three limits, and Speed tactics adds remote runners.

- **2026-10-02, AcmeVision 2.0: five typed clock times in one day, all ahead of the clock.** Block headers and
  review lines read 09:55, 11:45, 12:15, 12:40 and 12:45 when the shell said 09:51, 11:40, 12:12, 12:34 and 12:35.
  Three of them had already been sent to the worker as block names, so they had to stay wrong. A memory rule
  ("a time comes from date, never typed", 2026-09-28) existed and did not bind. Now a Constraint: the time comes
  from `date` inside the writing command.

- **2026-10-02 14:54, AcmeVision 2.0, the principal: "Make sure all our speed optimizations are in the
  recipe."** The build's speed rules had gone into its charter (§4b) turn by turn, and only some reached this
  recipe. Checking the charter against it found ten missing: the suite order, the full mock run after a
  shared-component merge, a red seen twice becoming a unit, the model per unit, small items riding along, what
  comes first when a turn runs short, tests that own their disk, ports and fonts, the machine list with `auto`,
  the all-at-once final runs, and the owner's hours. One line was stale: runner containers had moved to the host
  network. Speed tactics now holds all of them, with measured numbers in place of the targets. A speed rule
  decided in a charter goes into this recipe in the same review.

- **2026-10-02 22:26, AcmeVision 2.0, the principal: "I see you are planning to merge the present branch into main,
  don't. I would rather wait for what Alex pushes next week, and would like to have a stable shinobi to install in
  CustomerCo Flex on Friday 9th, something we can trust."** The charter, copied from Step 0, ended in "merge into
  `vms-main` after the master's go", and planned the field test on Fore2, the controller due at the customer that
  Friday, which also served as the ARM test runner. The product's maintainer had not trusted the rewrite yet, and he is
  the one who ships it. Step 0 and Step 5 now make the merge into someone else's product branch the principal's go,
  and Speed tactics keeps shipping machines out of the runner pool.

- **2026-10-02 22:43, AcmeVision 2.0 turn 19.** The worker stopped at its 2 h 30 min point, wrote a progress file,
  removed PF1's worktree and wrote that PF1's fix stage was "left to die with the turn". It did not die: at the
  wake it was still running a real walkthrough suite on the laptop (an e2e stack, two fake cameras, Chrome) from the
  removed `/tmp/sv2-pf1`, which would have collided with the next turn's real suite. Step 3 now has the worker stop
  its Workflow before the progress file, and the master check the pids after the send.

## Worked instance

The J11 digital amygdala, 2026-09-29: eight phases (design, foundations, seams, families, learning, UI, final
testing, fixes) between a Sonnet worker and an Opus master in one evening. Reviews caught a shadow mode that
would have seen no traffic, a learned cut-off stored as "applied" that changed nothing, a replay built without
its commands, and a score compared raw against whole-number cut-offs. The worker found the lockfile gap.
