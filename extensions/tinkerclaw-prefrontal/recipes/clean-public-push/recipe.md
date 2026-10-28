---
schema: "kit/1.0"
slug: "clean-public-push"
title: "Clean public push (PII-clean history, no force-push, WIP-safe)"
summary: "Publish a local branch to a PUBLIC remote with a sanitized HISTORY — not just a clean tip — via a squashed fast-forward, in a throwaway worktree so in-progress WIP is never disturbed. For repos with a PII boundary that are many commits ahead of the public remote."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "release"
tags:
  [
    "publish",
    "public push",
    "pii",
    "sanitize",
    "leak guard",
    "squash",
    "fast-forward",
    "history",
    "open source",
    "before push",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  repoRoot: "{{repoRoot}}" # absolute path to the repo
  remote: "{{remote|origin}}" # public remote name
  branch: "{{branch|develop}}" # branch to publish
  piiRe: "{{piiRe}}" # PCRE leak pattern; default = scripts/pii-pre-push.sh PII_RE
  replacements: "{{replacements}}" # ordered list of {pattern -> replacement}; e.g. first-name->role, host-path->placeholder
  verifyCmd: "{{verifyCmd|pnpm bible:invariants}}" # docs/quality gate (slow; timeout-kill is NOT a failure)
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
---

# clean-public-push

A repo that is N commits ahead of its public remote leaks PII through **history**, not just the tip: `git push` publishes every commit's blobs. Sanitizing the working tree + one commit cleans only the tip. This recipe publishes a **single squashed, sanitized commit** as a **fast-forward** (no force-push) from a **throwaway worktree** (the main tree's in-progress WIP is never touched). Drive it with the `Workflow` tool (BROCA); the sanitize transform is deterministic (a script), the careful code/test fixes + verification are where agents/judgment earn their place.

## Step 0 — backup + clean worktree + collapse

- **Claim the publish first (2026-09-29).** A publish, a history rewrite or a force-push must have exactly one owner. Before any of them, check for a sibling session working the same request (`ListAgents`, and `ps -eo args | grep "[f]ilter-repo"`), then create a claim file with `mkdir ~/.local/state/tinkerclaw/locks/publish-<repo>` (the command fails if the directory exists) and write your session name into it. If the directory already exists, stop and message its owner. Remove it when you finish. On 2026-09-29 one prompt reached two sessions; both started the same public-history rewrite, and one ran `filter-repo` inside the other's working mirror before either noticed.

- Back up WIP: `git -C {{repoRoot}} diff HEAD > $HOME/<repo>-wip-backup-<ts>.patch` (+ `git status --short`).
- `git -C {{repoRoot}} fetch {{remote}}`.
- Throwaway worktree at the tip (no WIP): `git -C {{repoRoot}} worktree add --detach /tmp/clean-pub $(git -C {{repoRoot}} rev-parse {{branch}})`; symlink `node_modules` (+ sub-package) for build/test. Link only when no step runs the package manager's install; otherwise install the worktree's own from the store (`CI=true pnpm install --frozen-lockfile`), because pnpm purges a linked `node_modules` it did not create, and that folder is the shared checkout's (master-worker-coding Step 1, 2026-10-01).
- Collapse: `git -C /tmp/clean-pub reset --soft {{remote}}/{{branch}}` → whole net diff staged on the public base; tree = clean tip content.
- **Deletion check (2026-09-29).** The public branch can hold content the source branch never had (skills published straight onto it). The collapse makes the public tree equal to the source tip, so each such path becomes a silent public DELETION. List them: `git -C /tmp/clean-pub diff --cached --diff-filter=D --name-only {{remote}}/{{branch}}`. For each one, either bring it back to the source branch first or confirm the deletion is intended. The first run of this check found 14 public skills that a publish would have deleted.

## Step 1 — identify PII files

For each staged file, `git show :<f> | grep -P "{{piiRe}}"` → the sanitize list. (PII boundary: full-name byline + public handle ALLOWED; first-name narrative, host paths, family/contact names, location, business contacts, tokens, emails MUST be scrubbed.)

- **The private list must exist before this step (2026-10-27).** `scripts/pii-pre-push.sh` only WARNS when `~/.config/tinkerclaw/pii-private.re` is missing, then checks generic tokens alone, so a host that never received the list would publish names, places and the employer without a sound. Run `test -s ~/.config/tinkerclaw/pii-private.re` first. The first publish from a newly migrated host found it missing and rebuilt it from the categories in `pii-boundary.md`. Keep `|` out of each line (the bible check splits the joined pattern on it and proves each plain piece fires) and keep `\b` away from addresses: URL-encoded (`%2F` before the digits) and regex-escaped forms slip past `\b`.
- **Scan whole lines (2026-10-27).** Until develop `8af2ecb0dc2` the hook matched `^\+[^+].*(…)`, which spends each added line's first character on `[^+]`: a token at column 0 never matched, and any gate copied from that shape inherits the hole. Run the class scan with a tool that searches the whole added line.
- **A denylist misses fixtures (2026-10-27).** Also run a roster pass: the phone book's full names, numbers and emails (`memory/people/_aliases.json`) against the added lines. It found a real contact's number, a third party's email, a street address and tailnet addresses in tests and app code that no pattern knew.

## Step 2 — sanitize (deterministic transform)

Apply `{{replacements}}` in order across the PII files (e.g. `perl -i -pe 's/<first-name>(?! <surname>)/the architect/g'`; host path → placeholder). For paths inside **code string-literals / test fixtures**, also fix the dependent expected values so tests stay valid (e.g. an encoded path constant). Prose/comments → `$HOME`/`~` is fine. Put the multi-alternation regex in a SCRIPT FILE (inline `(...|...)`/lookaheads break hook-wrappers).

## Step 3 — PII GATE (hard, blocking)

Stage the sanitized files by name, `git -C /tmp/clean-pub diff --name-only -z | xargs -0 git -C /tmp/clean-pub add --` (the session guard blocks a blanket `add -A` on files this session did not edit with its own tools, and the sanitizer is a script; 2026-10-05), then assert `git diff --cached {{remote}}/{{branch}} | grep -aP '^\+.*({{piiRe}})'` is EMPTY. Not empty → fix, repeat. Never proceed past a non-empty gate.

## Step 4 — verify + squash-commit + FF push

- Verify the sanitized tree: touched tests (single-file, not parallel), a typecheck, and `{{verifyCmd}}` (slow — a `timeout` kill is NOT a failure; confirm all _run_ checks pass).
- **Run that gate the way the pre-push hook does (2026-10-07).** `BIBLE_DIR=<publish worktree>/TINKER_UI_DESIGN_BIBLE pnpm bible:invariants`; without `BIBLE_DIR` the runner checks the shared checkout (develop plus whatever another session left uncommitted), not the cut. Then sort each failure: run it at the published base too. Red there as well = pre-existing: name it in the report and push with `BIBLE_GUARD=off`. Red only on the cut = this publish broke it: fix it on the source branch, merge, re-cut. On 2026-10-07 the first run skipped `BIBLE_DIR`, stopped on six failures, and four of them were new (a tab missing from `panels.md`, the BLIND cap, its prose, a Thalamus check that still said "ships off") while two had been red since 09-08 and 09-30. Checks named "probe is live" or "probe is wired" call this laptop's RUNNING gateway, which is the old build, not the cut: their failures say something about the live process (load, a config warning another session left), never about the code being published, and the set that fails changes from run to run. Let them through by that name, list them in the report, and gate on everything else. Pointing `OPENCLAW_GATEWAY_URL` at a closed port does not make them skip: most wrap the CLI in Python and fail instead (tried 2026-10-07). Live RPC checks with other names ("M3 fork RPC alive", "fork.skill.search is live") flake the same way when the laptop is loaded: give every failure that is not already explained two solo re-runs (the check alone, a few seconds apart) before it blocks. A flake passes; a real break stays red. On 2026-10-07 two such checks failed inside the gate and passed alone a minute later, at load average 5.
- **Run the touched tests through the repo's own runner (2026-10-05).** One `pnpm vitest run <files>` call over files from several vitest projects stops before any test with `Projects "unit" and "unit-fast" have different 'maxWorkers' but same 'sequence.groupOrder'` and reports "no tests". Use `node scripts/test-projects.mjs <root files>`, then `cd tinker-ui && npx vitest run <ui files>`; sum the "Test Files … passed" lines and compare with the number of files you passed in.
- **Build the exact commit you will push** with `scripts/deploy-worktree.sh --sha <squash> --dry-run`. On 2026-10-05 develop itself failed the plugin-sdk dts step (a type error a day old, every vitest green); fix it on the source branch first, then apply the same fix to the squash.
- **Run the fresh-clone Jev smoke on that build (2026-10-06).** Build with `--keep-worktree`, then `node scripts/smoke/fresh-clone-jev.mjs --openclaw <that worktree>/openclaw.mjs` (about 60 s, exit 0 required; it boots the built gateway under a throwaway HOME against a mock Jev and proves a keyless clone makes 0 Jev requests and 0 error lines, then arms with no restart when the key file appears). A red smoke blocks the push: the clone would ship broken or noisy without a token (bible principle 26).
- One squashed commit (message summarizes the published body of work; no AI co-author trailer or generated-by line, the commit is the architect's, 2026-09-29).
- Assert FF: `HEAD^ == {{remote}}/{{branch}}`. Re-run the PII gate on `git diff {{remote}}/{{branch}}..HEAD`.
- `git push {{remote}} HEAD:{{branch}}` (fast-forward; NO force-push). The repo's `core.hooksPath` pre-push runs as a backstop. That hook also runs `pnpm bible:invariants`, which takes more than 15 minutes: run the push as a tracked background job with a limit of an hour or more. A shorter `timeout` kills the hook and the push with it (2026-10-05: rc 124, nothing pushed).
- Clean up the worktree + temp scripts; keep the WIP backup until confirmed.
- **Before reporting "published", hold the cut against the source tip (2026-10-05).** A run takes an hour or more and the source branch keeps moving. Run `git log --oneline <cut-commit>..{{branch}}` (the commit the worktree was made from, not the squash) and say in the report what landed after the cut and is NOT published, or publish again. On 2026-10-05 the morning publish was cut at about 09:10, the Gantt tab and Jev's two windows landed during the run, the report said only "published", and the architect found Goku's page "old".

- **2026-10-06, three refused pushes in one publish.** Two were failures a `{{verifyCmd}}` run on the cut BEFORE the push would have shown: a new `scripts/**/*.test.mjs` with no `node --test` verify line in any optic, and the capability ratchet rising by exactly the new UI panel modules (set the cap to the measured result with a dated note naming them, as the cap's comment says). The third: the publish worktree was recreated without its `node_modules` link, so the hook's plugin-SDK check could not load `typescript`. Re-link on every recreate. When a gate failure also fails with `BIBLE_DIR` pointed at the published base, it is pre-existing: name it in the report and push with `BIBLE_GUARD=off`; do not fix other people's checks inside a publish.

## Step 5 — bring main up to develop (when asked)

- Fast-forward when `git merge-base --is-ancestor {{remote}}/main {{remote}}/{{branch}}`. Otherwise merge in a throwaway worktree at `{{remote}}/main`.
- **The two lines share history only up to 2026-07-17 (found 2026-10-27).** The merge then has hundreds of add/add and content conflicts, and git silently auto-merges some files into a mix of old and new text (a README went back to old counts). To make main equal develop: take develop's side for every conflict (`git checkout --theirs`), take develop's version of every auto-merged file that still differs from develop, accept develop's deletions, and delete the main-only files develop deleted on purpose (`git log --diff-filter=D develop -- <file>` names the commit). Keep only main-only files develop never had, and list them in the report.
- PII-gate the merge diff against `{{remote}}/main` AND the hook's push range, `git log -p --no-merges {{remote}}/main..<squash>`: it re-reads old public history and can trip on a line the current tree already fixed.
- Normal push, never force; commit messages are the owner's, with no AI trailer.

## Don't-regress

- **Second publish of 2026-10-27, four detours, ~25 min lost.** (1) The push script piped the hook through `tail -40`, which cut the bible failure list; naming the 9 reds meant a second 10-minute gate run. Write the push's FULL output to a file (`> push.log 2>&1`) and grep `✗` from it. (2) The MAIN worktree (Step 5) also needs `node_modules` (and `tinker-ui/node_modules`) linked, or the hook's plugin-sdk check dies with `ERR_MODULE_NOT_FOUND` and blocks as "exports out of sync". (3) Cleanup: the safety guard refuses a recursive delete, and refuses a delete or worktree removal on a `$VAR` path because it cannot see the path is under `/tmp`. Unlink the node_modules links one by one on literal `/tmp/...` paths, then `git worktree remove /tmp/...` with the path typed out. The claim dir under `~/.local/state` needs the owner's own "Delete ..." sentence: say so in the report. (4) The private sanitizer missed URL-encoded (`%2F100...`) and regex-escaped (`100\.66...`) tailnet IPs, and rewrote a test's input in one form but not its expectation in another; its IP rules now cover all three forms (2026-10-27). After sanitizing, run every test file the sanitizer touched, not just the scan.

- **Publish of 2026-10-28, three catches.** (1) Run the sanitizer over EVERY staged file, not only the files the private list flags: the sanitizer knew names the gate list did not, and two family and contact first names had reached the public tip in 8 files that no earlier cut ran through it. Once per publish, also run it over the rest of the tree as a census (16 public files changed; take only real PII, since a model vocabulary, a store-ID table and the author byline are not), and add every name the sanitizer scrubs to `pii-private.re` so the gate checks what the sanitizer cleans. (2) Look for replacement debris: grep the published diff for replacement tokens glued to other letters. On 10-27 the employer rule had rewritten the Romansh word for "close" in a vendored pdf.js locale; a case-sensitive name rule also skipped the lowercase copy in a test's expectation, so run the touched tests again after the census. (3) After any re-sanitize, `git status --short` must show no ` M` or `MM` before the squash commit: one fix sat unstaged and only the status line after the commit showed it. On the Pi, Gradle unit tests run from a copy of `apps/android` and `apps/shared` with `--no-daemon` and the aapt2 override from `apps/android/scripts/jarvis-pi-publish.sh`; Robolectric and conscrypt suites cannot load on aarch64, so name them as not run.

- **No force-push** of a shared branch — FF only. **Never `reset --hard` over live foreign WIP.**
- The local branch will diverge from the squashed remote; reconcile ONLY after the WIP is committed/cleared by its owner.
- History-clean is the point — a tip-only sanitize still leaks via `git show <old-commit>`.
- Ensure the public remote's pre-push actually invokes the PII grep (`scripts/pii-pre-push.sh`); wire it (`core.hooksPath`) if missing — manual gating is the real guard, the hook is the backstop.
- **Login shells need node (2026-10-27).** The bible runner runs each check with `bash -lc`. Where node lives only under nvm, `/etc/profile` resets PATH and every check fails with `node: command not found` (30 of 44 failures in one run). `~/.profile` must put nvm's default node on PATH; `bash -lc 'which node'` must print a path before Step 4.
- **`core.bare` must read `false` when the run ends (2026-10-05).** The main checkout was found with `core.bare = true` in `{{repoRoot}}/.git/config` at 09:43 during a publish run, and every git command there failed with "this operation must be run in a work tree" for every session sharing it. Cause, pinned the same morning: the gates the pre-push hook runs inherited `GIT_DIR` (on a push from this throwaway worktree, its gitdir, which shares the main config), and a test suite's `git init` in a temp folder re-initialised the main repository as bare. The hook drops git's environment since develop `5aa6c826c21` (`test/git-hooks-pre-push.test.ts`), but a worktree cut from an older commit still runs its own old hook. Last step of every run, before cleanup: `git -C {{repoRoot}} config core.bare false && git -C {{repoRoot}} rev-parse --is-inside-work-tree` must print `true`.
