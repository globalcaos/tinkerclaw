---
name: tinker-orca
version: 1.3.1
description: "Stop editing files one at a time. ORCA drafts every change in parallel, then applies them per-file-serialized so disjoint files fly and shared files never collide. It SPAWNS SUBAGENTS on your own provider (one per unit, which costs money) and writes ONLY the repo-relative files you list. Patches that name any other file are rejected in code. Because a symlinked path component can carry a write outside the repository, a separate checker agent resolves every path before any writer is spawned and again after apply, and lists the change set git can see; code refuses or fails the units it flags. The writers and checkers are ordinary subagents running as your user: the checkers are told not to write and their output is self-reported, and git cannot see writes outside the repository — this is detection, not a sandbox. Committing rewrites git history and needs commit AND confirmedCommit; it is OFF by default and never inferred. In its default mode it creates a git worktree and branch per unit-group and removes them afterwards. It runs an external program ONLY when you pass its absolute path IN THE CALL — no environment variable can name one. See Permissions, Data Flow and Consent."
metadata:
  openclaw:
    emoji: "🐋"
    os: ["linux", "darwin"]
    requires:
      capabilities: ["shell", "file_write", "file_delete", "subagents"]
    permissions:
      shell: "Runs git inside the repoRoot you name: status, log, rev-parse, add, commit, worktree add/remove/prune, merge --ff-only, cherry-pick, checkout of named paths, and `git stash create`. Also mktemp/cp for off-tree staging, and a fixed POSIX script (generated in code) that resolves write targets with `cd -P`/`pwd -P` and lists changes with `git diff --name-only` / `git ls-files --others`, run by separate checker agents before and after apply (instructed not to write; same tools as any subagent). It runs an external program ONLY when you pass its absolute path as an ARGUMENT (spawnCliPath, conductorPath, ownershipScript); with none passed, no other command is executed. Since 1.2.1 the environment cannot supply one — ORCA_CONDUCTOR / ORCA_SPAWN_CLI / ORCA_OWNERSHIP_SCRIPT are no longer read, because a variable set by a shell profile, a CI job or a parent process is not a consent surface. Never push, force-push, amend, or --no-verify."
      file_write: "Only the repo-relative paths listed in each unit's `writes`, applied by subagents running as your user. Checks: (1) every drafted hunk is matched against that allowlist in code before it is applied; (2) before any writer is spawned, a checker agent resolves every declared path and code refuses a unit whose path is a symlink, has a dangling symlink component, or resolves outside the repository; (3) after apply, a checker agent resolves the paths again and lists the change set against the HEAD recorded before any writer ran (plus untracked files, with content hashes so already-dirty files still count) — a refused path fails the unit; an undeclared change fails the group in worktree mode and disables committing in place, where it cannot be attributed to one unit; a missing result disables committing. Limits: the checkers are subagents told not to write, not tool-restricted, and report their own stdout; the audit cannot see writes to absolute paths outside the repository, a symlink created and removed again, or gitignored files. Detection plus refusal, not an OS sandbox. Plus one temporary directory created with `mktemp -d` at mode 0700."
      file_delete: "Three delete paths, all scoped: (1) the temporary staging directory this run created with mktemp; (2) `git worktree remove` on worktrees this run created, whose paths carry this run's unique id — never --force, never a worktree it did not create; (3) with allowForeignWip only, `git checkout -- <named files>` discards another session's uncommitted changes in specific files after snapshotting them to a dangling commit, then restores them. It deletes no branches."
      subagents: "Spawns one or more workers per edit-unit through YOUR configured provider, at your cost. Model choice is yours. Cross-provider critics and panels are off unless you supply spawnCliPath."
      network: "None of its own. Your spawned agents use whatever provider you already configured."
      credentials: "None. Reads no tokens, keys or auth files."
repository: https://github.com/globalcaos/tinkerclaw
homepage: https://github.com/globalcaos/tinkerclaw
---

# ORCA — parallel multi-agent coding

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Your agent edits twelve files. One. At. A. Time.

You watch it read, think, patch, verify — then start again on the next file as if the other eleven didn't exist. The work is embarrassingly parallel and it is running in single file.

The reason nobody parallelises it is the fear of two workers touching the same file. ORCA removes the fear instead of working around it: the only contended thing in a repo is a **shared file**, so it puts a short-lived lease on files and on nothing else. Disjoint files run at full concurrency. Shared files queue for a moment. A patch that goes stale while waiting is re-derived rather than clobbering someone.

"Did it merge cleanly?" stops being a question you ask.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

## How it works — three phases

**Phase A — no lease, fully parallel.** Every unit reads, diagnoses and drafts its exact patch simultaneously. That is ~95% of the wall-clock, and none of it contends. Nothing is written in this phase.

**Phase B — brief per-file lease.** Acquire the lease, apply the prepared patch, verify that file, release. Disjoint units run concurrently; units sharing a file serialise; a staleness guard makes a worker re-derive a patch that no longer applies.

**Phase C — one commit per unit.** OFF by default; needs `commit` **and** `confirmedCommit`. Each unit stages only its own files — never a blanket stage — so a parallel session's unrelated work is never swept in.

By default each unit-group applies inside its **own git worktree** off clean HEAD (branch `orca/<group>-<runId>`), and Phase C merges those branches back. Pass `worktreePerAgent: false` to apply directly in your working tree instead.

## Requirements

- OpenClaw with a configured model provider.
- A git repository. ORCA works on the repo you name and nowhere else.
- Optional: a subagent-spawn CLI (`spawnCliPath`) if you want cross-provider critics or panels. There is no default path — without it, those features stay off.

## Usage

```js
Workflow({
  scriptPath: "<this skill>/scripts/parallel-implement.workflow.js",
  args: {
    repoRoot: "/absolute/path/to/your/repo",
    units: [
      { id: "u1", task: "what to change", writes: ["src/a.ts"], reads: ["src/x.ts"] },
      { id: "u2", task: "what to change", writes: ["src/b.ts"] }
    ],
    verifyPreset: "npm-test",   // named check, run after each unit applies
    commit: true,               // opt in...
    confirmedCommit: true       // ...and confirm. Both required, or nothing is committed.
  }
})
```

`units[].writes` are the lease keys **and** the enforced write allowlist. Keep them disjoint for maximum parallelism; overlapping writes are safe — they simply serialise.

### Arguments worth knowing

| arg | default | what it does |
| --- | --- | --- |
| `repoRoot` | — | **Required.** Absolute, canonical path. Rejected if relative, containing `..`, or carrying shell metacharacters. |
| `units[].id` | — | **Required.** Must match `^[A-Za-z0-9_-]{1,64}$` — it appears in branch names and commands. |
| `units[].writes` | — | **Required.** Repo-relative paths only. Absolute paths, `..`, globs, and option-looking names are rejected. |
| `commit` + `confirmedCommit` | both `false` | Both must be `true` before anything is committed. |
| `coAuthor` | none | No attribution trailer is added unless you supply one. |
| `verifyPreset` | none | A named check: `npm-test`, `pnpm-typecheck`, `cargo-check`, `go-test`, `pytest`, … |
| `verifyHint` / `integrationVerify` | none | Raw command strings. **Refused unless `allowRawCommands: true`**, and echoed to the log before any agent runs them. |
| `policyText` | none | Extra house policy for draft agents. Printed in full before it is used, and ranked below the task, the allowlist and the repo boundary. |
| `worktreePerAgent` | `true` | Apply in an isolated worktree per group; `false` applies in your working tree. |
| `allowForeignWip` | `false` | Required before ORCA will touch another session's uncommitted changes. |
| `hmrPaths` | `[]` (off) | Repo-relative prefixes a live dev server watches; those files are staged off-tree and landed in one burst. |
| `spawnCliPath` / `conductorPath` / `ownershipScript` | none | Absolute paths to programs you want ORCA to run. **Arguments only** — no environment variable is consulted, and unset means the dependent feature is off. There is no fallback path of any kind. |

## Permissions, Data Flow & Consent

**What it does.** Runs git inside the `repoRoot` you pass, applies patches to the files you listed, and spawns one or more subagents per unit through your own provider.

**Everything it can touch, named.** git worktree and branch creation and removal (paths and branches carrying this run's unique id); `git stash create` snapshots; commits, fast-forward merges and cherry-picks when you have opted in; one `mktemp -d` directory at mode 0700 for off-tree staging and inter-agent hand-off; and an external program only when you give its absolute path. If you configure a `conductorPath`, ORCA also writes routing outcomes — domain, model, pass/fail — to that script's ledger. No code, prompts or file contents are written there.

**What it does not do.** It makes no network calls of its own, reads no credentials, and never pushes, force-pushes, amends, or passes `--no-verify` — your hooks run.

**Where the write boundary is enforced, exactly.** The Workflow runtime this script runs in has no
filesystem or process API — it composes prompts and reads back structured results — so every write
and every disk check happens in a subagent's shell. What ORCA controls is which agent does what, and
what code accepts:

1. **Patch text, in code.** Every drafted hunk is re-checked against the unit's `writes` before it is
   applied; a unit whose patch names another file is blocked whole.
2. **Disk, before any writer exists.** A separate checker agent runs a fixed script (generated in
   code from validated values) that resolves the realpath of each declared path with `cd -P`/`pwd -P`.
   Code parses its output and refuses any unit whose path is a symlink, has a dangling symlink
   component, or resolves outside the repository. Missing or truncated output refuses every unit.
3. **Disk and git, after apply.** Another checker agent, which never saw a patch, a task or file
   content, resolves the paths again in every root that was written and lists the change set with
   `git diff --name-only <HEAD recorded before any writer ran>` plus untracked files, each with a
   content hash so an edit to a file that was already dirty still counts. A refused path fails the
   unit. A changed file no unit declared fails its group in worktree mode (no merge-back); in place,
   where one shared tree cannot say which unit made it, it fails no unit and turns committing off for
   the run. A missing audit also turns committing off. The writer's own `filesChanged` report is
   checked too, but it is not the only evidence.

The writing agent is also given the same containment function and told to refuse. In place, a file a
parallel session changes during the run is undeclared too, so committing turns off — apply-only is
the safe outcome.

What this does **not** give you: the checkers are ordinary subagents with the same tools as the
writers, told not to write, and their stdout is self-reported — a checker that itself misbehaves
could report a pass. The audit sees only what git sees inside the repository or worktree, so a write
to an absolute path elsewhere (for example a dotfile in your home directory), a symlink created,
written through and removed again, or a write into a gitignored path is not detected, and anything
it does detect has already happened. It is detection and refusal around agents that run as your
user, not a sandbox. Use worktree mode (the default) to keep writes off your main tree.

**No program can be named by the environment.** ORCA runs an external program only when you pass its
absolute path as an argument. Until 1.2.1 an unset argument fell back to `ORCA_CONDUCTOR`,
`ORCA_SPAWN_CLI` or `ORCA_OWNERSHIP_SCRIPT` in the environment — which is the same problem one level
down: you read your own invocation, see no external program, and a variable set by a shell profile, a
CI job, a parent process or an earlier agent supplies one anyway, and it is executed. Those variables
are no longer read. What runs is visible in the call that asked for it.

**Committing is OFF unless you ask twice.** Phase C writes git history, so it needs BOTH `commit: true` and `confirmedCommit: true`. With anything less, ORCA applies and verifies the patches and leaves them for you to inspect. There is no flag, env var or heuristic that makes committing the default, and the confirmation is yours to give — an orchestrating agent should not supply it on your behalf.

**Another session's work is not ours to move.** If the pre-flight finds uncommitted changes belonging to someone else in files this run writes, ORCA refuses to commit and says which files caused it. Snapshotting and restoring that work across a merge happens only with `allowForeignWip: true`.

**Verify commands are named, not free text.** A verify string is handed to an agent with "run this" attached, so the default is a fixed table of presets. Raw command strings still work, but only behind `allowRawCommands: true`, and the exact text is printed before any agent sees it.

**It ships no policy of its own.** Draft agents receive the unit task, the allowlist, and generic verification discipline. Anything else is yours to pass via `policyText`, which is displayed in full before use and cannot widen the write allowlist or move the repository boundary.

**Temporary files are unpredictable by construction.** The staging directory is created with `mktemp -d` at mode 0700. No path is derived from a unit id, so concurrent runs cannot collide and nothing can pre-create a file a worker is about to trust.

**It costs money.** One or more subagents per unit, on your provider, at your rates. A 12-unit run is at least 12 agents. Start with two.

## When NOT to use it

- A single-file change — just edit it.
- Edits where unit B must read unit A's committed result — split into separate runs.

## Verifying this yourself

```bash
node scripts/selftest.mjs
```

Runs the real workflow against stubbed agents and asserts the properties above: hostile paths, unit
ids and command strings are refused before any agent starts; the double opt-in actually gates
committing; a patch or a report that leaves the allowlist blocks the unit and stops the commit; and,
in a throwaway git repository with REAL symlinks, that a symlinked directory, a dangling link or a
symlinked target is refused before any writer is spawned, and that a writer stub which ignores every
instruction — writing an undeclared file, or creating a symlink mid-run and writing through it, in
place or in a worktree — is caught by the post-apply audit and gets no commit. It also checks that an
environment full of `ORCA_*` executable paths supplies nothing and no prompt carries policy you did
not supply. Needs `git` and `sh`.

## Included Files

| File | Purpose |
| --- | --- |
| `scripts/parallel-implement.workflow.js` | The orchestrator. |
| `scripts/selftest.mjs` | Executable checks for the safety properties documented above. |

## Changelog

- **1.3.1** — In-place audit now diffs against the HEAD recorded before any writer ran (a commit made during apply no longer hides an undeclared file); already-dirty files are compared by content hash; docs state that checkers are instructed-not-to-write subagents with self-reported output, that in-place undeclared changes disable commit without failing a unit, and that writes outside the repo, removed symlinks and gitignored paths are not detected.
- **1.3.0** — Disk boundary no longer depends on the writing agent: a separate checker agent resolves every declared path before any writer is spawned (refused in code) and re-audits after apply using git's real change set; dangling symlink components are now refused; docs state plainly that checks run in agent shells, not a sandbox; selftest adds real-symlink integration tests and drops its split-string payload.
