---
schema: "kit/1.0"
slug: "general-coding-principles"
title: "Code a feature so a reviewer can follow it: hops, commits, bench machines through git, commit diagram"
summary: "Build a product feature the way a human reviewer can check it: one branch from the base branch, checked out in the one project folder on each machine, one commit per hop with What/Why/Impact, bench machines updated only through git, every plan block mapped to its commits in a hover-to-read diagram, and every report stating where the code runs and whether the branch is on the remote. Loads the deployment's private house-rules file first when one is configured."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "feature branch",
    "commit hops",
    "one commit per hop",
    "what why impact",
    "commit diagram",
    "diagram of commits",
    "deploy to bench",
    "bench machine",
    "update the bench through git",
    "code for a reviewer",
    "reviewer cannot see the branch",
    "house coding rules",
    "house doctrine",
    "hardware feature",
    "commissioning tool",
  ]
antiTriggers: ["plan only with no commits", "review only", "what is git"]
testedHarnesses: ["Claude Code", "OpenClaw"]
authoredBy: "jarvis"
params:
  repo:
    {
      type: "string",
      default: "~/src/<project>",
      description: "The one checkout of the product repo on this machine. Every bench machine uses the same path (see bench_repo).",
    }
  remote:
    {
      type: "string",
      default: "origin",
      description: "Git remote the reviewer reads and the bench machines pull from.",
    }
  base_branch:
    {
      type: "string",
      default: "main",
      description: "Branch the feature starts from and is diffed against. Merging into it stays the owner's and the reviewer's step.",
    }
  feature:
    {
      type: "string",
      required: true,
      description: "Short feature name. The branch is feat/<feature>, switched inside {{repo}} (one folder per machine).",
    }
  reviewer:
    {
      type: "string",
      default: "the reviewer",
      description: "Who reads the commits (a role or a name). Used in reports only.",
    }
  docs_dir:
    {
      type: "string",
      default: "~/Documents/<project>",
      description: "Folder for plans, commit maps and diagrams. Never inside the agent's own state folder.",
    }
  plan_doc:
    {
      type: "string",
      default: "~/Documents/<project>/<feature>-plan.md",
      description: "The feature's work plan (blocks, hops, gates, status table).",
    }
  commit_map:
    {
      type: "string",
      default: "~/Documents/<project>/<feature>-commit-map.json",
      description: "Plan blocks to commits. Input of commit_diagram.py.",
    }
  bench_hosts:
    {
      type: "string",
      default: "",
      description: "Space-separated SSH aliases of bench machines that run the branch. Empty = no bench; skip step 4.",
    }
  bench_repo:
    {
      type: "string",
      default: "~/src/<project>",
      description: "Path of the one checkout on each bench machine.",
    }
  test_cmd:
    {
      type: "string",
      default: "python -m pytest -q",
      description: "The project's test command, run with the project's own interpreter or toolchain. Its summary line must show a count.",
    }
  test_dir:
    {
      type: "string",
      default: ".",
      description: "Folder, relative to the repo root, that test_cmd runs from.",
    }
  house_rules:
    {
      type: "string",
      default: "",
      description: "Optional path to the deployment's private house-rules file (commit rules, review habits, site specifics). Empty = this recipe's rules are the doctrine.",
    }
  tools_dir:
    {
      type: "string",
      default: "~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/general-coding-principles",
      description: "Folder holding commit_diagram.py and commit-msg-check (this recipe's folder in your TinkerClaw checkout).",
    }
  diagram_serve_dir:
    {
      type: "string",
      default: "",
      description: "Optional folder a local web UI serves (for example tinker-ui/public/diagrams/ in a TinkerClaw checkout). Empty = link the files by path.",
    }
parallelism:
  groups:
    - [0, 1]
    - [2]
    - [3]
    - [4]
    - [5, 6]
    - [7]
  notes: |
    Hops are sequential by design: each one is reviewed alone. Independent files inside ONE hop
    may be drafted in parallel (ORCA), but they land in the same commit. Deploy and diagram
    only after the commits exist.
---

# Code a feature so a reviewer can follow it

> A reviewer reads one seam at a time, on the shared remote. Work the reviewer cannot see, or a
> machine running code that matches no commit, does not count as done, however well it works.

## Goal

Leave four things true at the end of every session:

1. **Every change is a commit**, one hop each, with What/Why/Impact in the body.
2. **Every machine runs a commit**: the development folder and each bench checkout sit on a named
   SHA with a clean tree.
3. **Every plan block shows its commits**: the diagram accounts for every commit in
   `{{base_branch}}..feat/{{feature}}`, and hovering one shows its message.
4. **The report says where it is**: running on which machine at which SHA, and whether the branch
   is on `{{remote}}`. If it is not, say so plainly, with the push command.

## When to use

Any product coding that a human reviewer reads commit by commit, especially code that also runs on
bench, lab or commissioning machines: device drivers, a processing pipeline, a web UI, bench tools.
Not for a repo that already has its own merge rules (a fork that merges to `develop` under its own
recipe, for example). The hop-chopping method itself lives in recipe `git-instructions`; this recipe
is the session discipline around it.

## The non-negotiable model

- **Load the house doctrine first.** If `{{house_rules}}` is set, read it before anything else. A
  deployment keeps its private rules there: the reviewer's commit habits, site names, bench layout,
  language rules. It outranks this recipe and it outranks convenience. When it is empty, the rules
  below are the doctrine.
- **Where knowledge goes** (2026-09-25): project documentation, including how-tos a colleague posts
  in team chat, goes into the repo's own documentation folder, on its own `docs/<topic>` branch.
  Credentials go into the team's private wiki or secret store, never the repo.
- **One folder per machine** (the owner, 2026-09-28: "all the code should be inside the project
  folder"): `{{repo}}` is the only checkout, on the development machine and on every bench.
  `feat/{{feature}}` is switched inside it. Any legacy folder name is a symlink to it. No sibling
  `<project>-*` clones and no long-lived worktrees. A throwaway worktree under `/tmp` is fine if the
  same command removes it (step 3's verify loop).
- **Only this product's work goes in this repo** (the owner, twice on 2026-09-28). No other product
  (each lives in its own folder or repo) and no agent files: no AGENTS.md, CLAUDE.md, hooks or
  prompts. Loose files an earlier session left in the tree are a
  question for the owner, not "our changes": list them (what, which product) before committing any.
  Commit messages are checked by hand with `bash {{tools_dir}}/commit-msg-check <msgfile>`; no hook
  has to live in the repo.
- **A hop is one seam plus its tests.** If describing it needs "and", it is two hops. The subject
  is conventional and at most 72 characters; the body answers What, Why, Impact. Stage explicit
  paths only (`git add -- <paths>`), never `-A`: other sessions share these trees.
- **Code is changed only in the development copy and reaches a bench machine only by `git pull`**
  (the owner, 2026-09-28). Commit on the development machine, push the feature branch to
  `{{remote}}`, then `git pull --ff-only` on the bench. Never edit on the bench, never push into its
  checkout, never `scp` or `ssh cat >` files: each leaves a tree nobody can trace to what the
  development copy has.
- **A simulator is a claim about hardware.** When the bench disagrees with a green test, fix the
  simulator first (with a dated note of what the device did), then the code.
- **The feature branch goes to `{{remote}}` as part of every bench update.** That is the only way the
  bench can pull it. `{{base_branch}}`, merges and merge requests stay the owner's and
  {{reviewer}}'s step: never do those unasked. Every report states the branch's remote state.
- **A bare "commit, push" covers every branch the work produced, not only the one checked out.**
  Census first: `git -C {{repo}} fetch {{remote}} && git -C {{repo}} for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads`.
  A branch with no upstream or `[ahead N]` that this chat made is in scope. Branches whose tips are
  already inside the pushed branch are cleanup. (2026-09-25: the feature branch was already on the
  remote and on the bench; the only unpushed work was a docs branch parked that morning.)

## Steps

### 1. Load the house rules and the plan

**Done when:** you can answer the two-minute test for the next hop.

Read `{{house_rules}}` (when set) and `{{plan_doc}}`. Answer the two-minute test for the next hop:
what problem it solves, which use cases it affects, which modules it touches, how you will validate
it. If you cannot answer in two minutes, the hop is too big; split it. If the plan's status table is
older than the last commit, update it before coding.

### 2. Branch (once per feature)

```bash
git -C {{repo}} switch -c feat/{{feature}} {{base_branch}}
```

Set up the project's test environment once (a virtualenv with the device libraries, a node
toolchain) and write its path into the plan, so the next session runs `{{test_cmd}}` from `{{test_dir}}` with
the right interpreter. Build it to run in parallel from the start: one database and one mock server per
test worker, timing tests marked and run alone, fakes that do only the work a test reads, test-only settings
for costly production ones such as password hashing. Retrofitting that later cost the AcmeVision 2.0 build
a turn; the measured reasons are in `master-worker-coding` § Speed tactics.

### 3. Build hop by hop

For each hop: failing test first, then code, then the whole suite. **Read the count.** A run that
ends in `N errors` with no `passed` collected nothing. Exclude known-broken legacy test files
explicitly (`--ignore=<file>`) and check that the number of tests went up. Then commit that hop
alone.

To split work that is already mixed in one file into hops, build each intermediate version from
`HEAD` plus one hunk and stage it with `git hash-object -w` + `git update-index --cacheinfo`; the
working tree stays untouched. Verify afterwards that every commit passes on its own:

```bash
W=/tmp/verify-{{feature}}; git -C {{repo}} worktree add -q --detach $W HEAD
for c in $(git -C {{repo}} rev-list --reverse {{base_branch}}..feat/{{feature}}); do
  git -C $W checkout -q $c; (cd $W/{{test_dir}} && {{test_cmd}} | tail -1)
done; git -C {{repo}} worktree remove --force $W
```

If a bench machine lacks the test runner you use on the development machine, run the same suite
with the standard-library runner (Python: `python3 -m unittest <module names>`), under a virtual
display (`xvfb-run -a`) so no window opens on the bench screen (2026-09-25: 129 tests, OK;
2026-09-28: 316 tests, OK). Pipe it through `grep -E "^(Ran |OK|FAILED|ERROR:|FAIL:)"`: a plain
`tail` catches buffered log prints, not the summary.

On the development machine, run the tests with the project's own interpreter, never the system one:
without the project's device libraries, collection stops at a few `errors` and nothing runs. If that machine has no
Xvfb, prefix `env -u DISPLAY -u WAYLAND_DISPLAY` so GUI tests skip instead of opening windows on the
owner's screen (2026-09-28: 306 passed, 10 skipped).

A UI change is only verified by looking at it: run the window on a virtual display (Xvfb) with the
simulator and capture it, never on the owner's screen. Drive any control that only appears after an
action (open the dropdown, hover the item) before capturing.

**Web UI hops when the web app cannot run locally: run the real JavaScript with node.** The page and
its server cannot be rendered on the development machine, but their functions can be tested as
written. Pull a function out of the page's `.js` file by brace-matching, give it stub globals, and
run it with `node -e`. Load a server-side module with `require` and a fake database query helper.
Run the server's processing function on what the editor saves, and feed the result to the backend's
own parser. That proves the wiring end to end; the LOOK still waits for a human, and the report says
so.

### 4. Update each bench machine through git

**Done when:** every host in `{{bench_hosts}}` sits on the branch tip with a clean tree. Skip this
step when `{{bench_hosts}}` is empty.

**Default: the bench pulls from `{{remote}}`.** Once the branch is on the remote (the owner's call,
or an explicit go), each bench checkout tracks it and pulls with its own read-only deploy key:

```bash
for h in {{bench_hosts}}; do
  ssh "$h" 'cd {{bench_repo}} && git pull --ff-only && git log --oneline -1 && git status --short | wc -l'
done
```

A new bench machine gets its own key, never a person's key and never the owner's token. Generate it
on the bench, register it read-only on the Git host (GitLab: `POST /projects/<id>/deploy_keys` with
`can_push: false`; GitHub: a repository deploy key without write access), add an SSH alias for it in
the bench's `~/.ssh/config`, point the remote at that alias, pull. Record the key file, alias and
deploy-key id in the house-rules file, not here.

**Retired 2026-09-28: pushing straight into the bench checkout** (`…:refs/heads/incoming`, or a
scratch `verify` ref to test there first). Every bench update is a `git pull`. Test on the bench
AFTER the pull (step 3's `xvfb-run` unittest line) and fix forward with a new commit.

Stash, never discard, anything loose you find in a bench checkout. A running app keeps its old code
until it is reopened; restart it only when nobody is using it, or tell the owner to reopen it.

**When the bench checkout IS the tree a service runs from** (a process manager such as PM2 or a
systemd unit serving `{{bench_repo}}`):

- Site settings kept as local edits on top of the branch must survive every pull. Never
  `git checkout .` there.
- Before the first pull, park any colleague's old uncommitted edits as a local
  `wip/<who>-<host>-<date>` branch.
- A pull changes files on disk only. The service takes them at its restart, and that restart needs
  the site owner's OK.
- To look without sudo, use `systemctl is-active <unit>` and `ps`. Never run the process manager as
  a different user from the one that owns the service: that starts an empty daemon of its own.
- Keep the bench's layout (unit names, config files, who set it up) in the house-rules file.

**Before moving or trashing any checkout** (2026-09-28): look for processes whose working directory
is inside it, since a bench tool may show its folder only as its cwd, never in its command line:
`for d in /proc/[0-9]*; do c=$(readlink $d/cwd 2>/dev/null) && case "$c" in <folder>*) echo "${d#/proc/} $c";; esac; done`.
Anything found is the owner's to close first.

### 5. Keep the plan and the commit map current

Add each new commit to the right block in `{{commit_map}}` (a new block if the plan grew one).
Update the plan doc's status table and diagram marks in the same session.

The map is JSON:

```json
{
  "title": "Feature X: plan blocks and commits",
  "lanes": { "backend": "Backend", "ui": "UI" },
  "blocks": [
    { "id": "b1", "title": "Driver on the real pins", "lane": "backend", "commits": ["a1b2c3d4"] },
    { "id": "b2", "title": "Cancel button", "lane": "ui" }
  ],
  "edges": [["b1", "b2"]]
}
```

### 6. Draw the commit diagram

```bash
python3 {{tools_dir}}/commit_diagram.py --repo {{repo}} --remote {{remote}} \
  --range {{base_branch}}..feat/{{feature}} --map {{commit_map}} \
  --out {{docs_dir}}/{{feature}}-commits.html \
  --png {{docs_dir}}/{{feature}}-commits.png
```

Needs `mmdc` (Mermaid CLI) on PATH, and Pillow for `--png`. The script stops if any commit is
unmapped, and prints whether the branch is on the remote. `--png` also writes
`{{feature}}-commits-chat.png` at one third of the size. If `{{diagram_serve_dir}}` is set, copy the
three files there (keep it git-ignored), check that `curl` returns 200 on the served URL (in
TinkerClaw: `/tinker/diagrams/<file>`), show the **`-chat.png`** inline in the chat, and link the
full PNG and the HTML for the hover. The chat draws images at their full pixel size, so a full
3568-px PNG filled the screen (the owner, 2026-09-25: "way too big … show it at 1/3").

### 7. Write the human test plan (2026-09-25)

Automated tests prove the combinations; the human tests prove only what a machine cannot: real
wiring, real sound, real processes talking to each other, and looks. **Fewest tests, each proving a
whole chain** (one scenario that uses the latch, the alarm output and a camera beats five tests).
Never script "check each control of component X": the owner sets a component up, explores its
controls and reports what is missing. Before writing the plan, read the bench's runtime facts: which
user runs the app and each plugin, where packages, voices and passwords live, which config keys are
set. (2026-09-25: root ran the web app while the device library, the TTS voices and a device password
lived only in another user's home, and the site language was unset.) Each test says what it proves.
The plan lives in the plan document, not only in chat.

### 8. Report

Commits made (hash + subject), where each machine is (SHA, clean or not), tests with the real count,
what was only written and not run, the branch's state on `{{remote}}` with the push command when it
is not there (`git -C {{repo}} push -u {{remote}} feat/{{feature}}`), and the merge state.

## Constraints

- No documents inside the agent's own state folder (for TinkerClaw, `~/.openclaw`, which may be a
  git repo with a remote): plans, maps and diagrams live in `{{docs_dir}}`.
- Company code and diagrams never go into a public repo, including the agent's own public fork.
- Bench safety rules stay in force: outputs start OFF, an explicit unlock step gates every output
  test, and a device reboot is logged in the bench log with the reason.
- `pkill -f` over ssh matches its own shell: use the `[x]yz` bracket form or kill by PID.
- A cache that outlives the process (files on disk, a database table) stores next to each entry
  what it was made from (the inputs, the tool settings, model and format versions) and a checksum
  of the result, and reuses an entry only when both still match. Keyed by name alone, it keeps
  serving stale or half-written results after the generator changes or a crash (2026-10-05: a
  speech cache keyed by voice and text would have replayed audio made with a replaced voice model;
  the owner asked for the settings to be saved and checked).
- Times written into the plan, a status row or a bench note come from `date +%H:%M` in the same
  command that writes them, never typed. On 2026-09-25 two hand-typed times were 22 and 27 minutes
  wrong, and on 2026-09-28 another was 19 minutes wrong.

## Failures overcome

- **2026-09-24: files copied to the bench.** After the first git push in the morning, later changes
  went over as `scp` and `ssh cat >`. The bench ended on that first commit plus 8 loose files and
  missed the evening's 7 commits. Fixed 2026-09-25 by the git sync in step 4 (the loose files are in
  a stash there).
- **2026-09-24: the branch was never on the remote.** 18 commits existed only on the development
  machine; the reviewer looked the next morning and found nothing. Pushed on the owner's go; the
  bench now pulls it from the remote. The diagram prints the remote state in red whenever it is
  missing.
- **2026-09-24: a test run that ran nothing.** pytest stopped at two legacy collection errors, and
  the output "2 errors" was nearly reported as eight verified hops. Step 3 now requires the count.
- **2026-09-24: a simulator that disagreed with the module.** It changed the digital-input count the
  moment a configuration coil was written; the real I/O module fixes the count at boot. 39 green
  tests, broken on the bench.
- **2026-09-24: a device scale taken on trust.** The speech-volume fix divided by 1000, taking 1000
  as the network speaker's normal level. The vendor's audio API says 100 is normal (linear
  percent, 1000 = 10×), so speech sat 20 dB under clips at every slider position (30 dB down at the
  default). Caught 2026-09-25 by measuring on the bench and reading the vendor doc. Before mapping to
  any vendor value, quote the vendor's definition of it in the commit or code comment.
- **2026-09-24: work left uncommitted by a fallback model.** A fallback model's afternoon changes sat
  uncommitted until the evening; they were split into hops with the plumbing in step 3.
- **2026-09-25: helpers lost to capacity, not to bugs.** Two sub-agents died on the provider's usage
  limit and a third could not start (the parent session had 10/10 child slots); each left a clean
  worktree and nothing else. Check the worktree and the report file before re-spawning, and when
  helpers keep failing, do the hops yourself in order: the doctrine makes them small enough.
- **2026-09-26: fixed on the server, stale in the owner's browser (a web plugin).** The owner
  reported a squeezed review panel and a dead drag handle. A fresh headless browser measured the live
  layout as correct. The cause was the owner's cache: the panel script was loaded on demand by a URL
  with no `?ver=`, and the host served `.js` with `max-age=2592000` (30 days), so the browser kept a
  days-old panel through every deploy. When the owner sees a bug that a fresh browser does not
  reproduce, check the asset URL's version stamp and the host's `cache-control` BEFORE changing any
  layout code. Every file a script loads on demand needs its own version in the URL, and the deploy
  check has to assert it.
- **2026-09-28: a lens test that could not put the lens back.** To learn a camera vendor's zoom API,
  a camera was zoomed to 0.1 and "restored" with `zoom=0.000000`: the camera answered OK and stayed
  at 0.1, because 0 means "leave that axis". It took `0.000001` for the zoom and a second call for
  the focus to return it to its recorded values. Before moving any physical setting on a real device
  (lens, output, volume, address), read and record its values, and treat the restore as unproven
  until a read-back shows them again. A vendor "OK" confirms the request, not the position.
- **2026-09-28: a vendor procedure paraphrased out of order.** The bench tool told the installer to
  reset an I/O module with "Init, power-cycle, log in, then back to Run". The vendor's manual logs in
  as Admin only AFTER switching back to Run and powering up again, and the note never said where the
  switch is. The owner could not reset the module from it. Any vendor procedure the tool shows
  (reset, pairing, firmware) is copied in the vendor's own order, one numbered step per physical
  action, naming where each control is, with the source (manual section, FAQ number) cited in a code
  comment. A paraphrase from memory is a guess about hardware.
  Then: "I do not see any switch". The note said "top panel, next to the power plug", the vendor's
  word for the narrow face with the network sockets. Place a physical control by LOOKING at the
  vendor's drawing (render the manual page), and describe it against what the person can see: "on
  the face with the orange plug and the two network sockets, between the plug and ETH1, a tiny black
  slide switch, Init up / Run down". A vendor's panel names are not the reader's.
- **2026-09-28: an answer the user typed that nobody ever read (a web plugin).** Adding a follow-up
  box to one question exposed that three existing multiple-choice follow-ups were stored for weeks
  but never sent to either automatic grader and never shown in the admin reading view: both
  server-side evidence builders and the console's multiple-choice branch printed only the chosen
  option. Before adding or renaming any answer key, grep EVERY reader of the answer map (grading
  block, whole-test builder, server mirror, admin console, scoring view, user panel) and make each
  one show it. A field that is collected but read by nothing looks exactly like a working one.
  Same upgrade: a change to the CLOCK of a live timed test (a few minutes shorter) must carry an
  in-flight guard. New attempts get a version stamp in their saved state (for example
  `clockVersion: 2`), and any attempt already running without it keeps the old rules; otherwise the
  deploy silently takes minutes from whoever is mid-test. The plugin tree was not in git: back it up
  to a dated folder and run the test suite on an untouched copy first, so a red after the edit is
  attributable. Never probe a
  live admin door with a guessed identity: a start request with a non-reviewer email and phone
  registers a real attempt.
- **2026-09-28: green over SSH, broken from the desktop icon.** Every camera check ran over SSH or on
  Xvfb and passed; the owner, starting the bench tool from its icon, saw every camera fail. The
  bench's `ffprobe` segfaulted on exit whenever DISPLAY was set, and only the desktop session set it
  (`systemd-run --user` reproduced it, exit -11). A tool started from a desktop icon is verified in
  that environment too: run the check once through `systemd-run --user` (the session's variables) or
  with the session's DISPLAY/XAUTHORITY, not only from an SSH shell.
