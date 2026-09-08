---
name: orca
description: "ORCA (ORChestrator for parallel multi-Agent coding) — lease-based parallel multi-file coding. Use BY DEFAULT, without being asked, whenever a coding task touches 2+ files that can be edited independently: it drafts patches in parallel then applies them per-file-serialized so disjoint files run concurrently and shared files never collide. Especially for multi-file work in ~/src/tinkerclaw."
trigger: /orca
---

# ORCA — parallel multi-agent coding orchestrator

**Use this by default for ANY multi-file coding task that decomposes into independent edit-units.** Do not hand-edit several files one at a time when ORCA can parallelize them. This is a SHIPPED, live-verified tool — not a proposal.

## Why

The only contention point in parallel editing is a _shared file_. ORCA serializes those via short-lived per-file leases while everything else runs concurrently, so "clean merge" is a non-event. Two-phase workers:

- **Phase A (no lease, fully parallel):** each edit-unit reads + diagnoses + drafts its EXACT patch. ~95% of wall-clock.
- **Phase B (brief per-file lease, fast handoff):** acquire the file leases → apply the prepared patch → verify that file → release. Disjoint-file units run concurrently; shared-file units serialize; a staleness guard makes a Phase-B agent AUTO-RE-DERIVE a patch that no longer applies.

## How to run

ORCA is a Workflow. Invoke it through the **Workflow tool** using `scriptPath` (named-workflow invocation is NOT auto-discovered):

```
Workflow({
  scriptPath: "<path-to-parallel-implement.workflow.js>",
  args: {
    repoRoot: "<absolute-repo-path>",
    units: [
      { id: "u1", task: "<what to change>", writes: ["path/a.ts"], reads: ["path/x.ts"] },
      { id: "u2", task: "<what to change>", writes: ["path/b.ts"] }
    ],
    wrapPath: "<optional-bash-wrapper>",
    verifyHint: "typecheck only the file(s) you changed if a fast per-file check exists"
  }
})
```

- `units[].writes` = the files that unit edits (the lease keys). Keep units' `writes` disjoint when possible for max parallelism; overlapping `writes` are safe (they serialize).
- For `~/src/tinkerclaw` specifically, ORCA is the right tool because parallel sessions contend on shared files like `tinker-ui/src/app.ts` — the per-file lease prevents clobbering another session's WIP.
- **When the change is a new design principle, feature, or requirement** — include a bible unit in `units` up front (the owning `TINKER_UI_DESIGN_BIBLE/*.md` optic + its `verify:`). Phase A will also demand it; discovering the gap after draft is the 2026-08-28 failure. Update any optic the change makes stale in the same run. The architect does not have to ask (design-principles #21, ORCA `DOC_REQUIREMENT`).
- **Code vs prompt, evaluated per unit.** Code buys consistency; prompt buys plasticity. Code does not beat prompt all the time. Prefer code whenever it is possible; keep prompt when plasticity is the point (tone, judgment, retuning) or there is no structural producer. Name the reason. Silence has not evaluated — prefer code in that case (design-principles #22, ORCA `MECHANISM_REQUIREMENT`).

## Fast committing (Phase C — on by default)

After apply+verify, ORCA **commits each applied unit as its own commit** so nothing is left as an orphan pile. Commits are **serialized** (git's index/HEAD is one shared resource — concurrent commits would race) and each stages **ONLY that unit's files** (never `git add -A`), so a parallel session's unrelated WIP is never swept in. Pass `commit:false` to leave changes uncommitted; `commitScope` to set the conventional-commit scope; `coAuthor` to override the trailer.

**Commit-message rules ORCA enforces per unit:**

1. Subject `<type>(<scope>): <imperative summary>` ≤72 chars (type = feat|fix|docs|refactor|perf|test|chore).
2. Body: WHAT changed + WHY (the why comes from the unit's task); note if the patch was re-derived.
3. Quote any task IDs / issue refs / spec paths from the unit task verbatim.
4. Stage ONLY this unit's files (`git add -- <files>`), never `-A`/`.`.
5. End with the co-author trailer.
6. No `--no-verify` / `--force` / `--amend`; let pre-commit hooks run.
7. No secrets/credentials/absolute host paths in the message.

## Phase D — THE DEFINITION OF DONE (2026-08-24, the architect)

**A branch that is not merged into `develop` is unfinished work, not finished work.** Committing is
Phase C; it is NOT the end. The task is done when:

1. every unit is committed, AND
2. the working branch is **merged into `develop`**, AND
3. every branch that no longer holds anything `develop` lacks is **deleted** (with its worktree), AND
4. `git branch` shows no leftovers you created.

**Say this out loud in the final message, every time.** The reported failure mode is precise: the
architect reads a green "committed + verified" summary, concludes the task is over, and the branch
sits forever. So the closing message must state the merge/delete status explicitly — either
"merged into develop, branch deleted" or the exact reason it could not be, with the unblock. Never
let a summary end in a way that lets "done" be inferred while a branch is still pending.

**Never ask whether to push.** Pushing is the architect's own step, taken in a separate context
whenever he chooses. Do not ask, do not offer, do not treat an unpushed branch as an open question —
it is not one. Merge to `develop` locally and stop there. (This is the standing rule; the old
"ask before pushing" habit is retired.)

**Before deleting, prove redundancy** — do not infer it from the branch name or from "it looks
merged":

- `git merge-base --is-ancestor <branch> develop` → tip already in develop; or
- `git cherry develop <branch>` → no `+` lines (same patch landed under a different SHA, which is
  the normal ORCA outcome since Phase C commits units straight onto the integration branch); or
- the branch is **superseded** — develop shipped a different, deliberate implementation of the same
  goal. Verify by reading develop's code, not by assuming. Merging a superseded branch resurrects
  rejected work.
  Anything else still holds work: merge it.

**Never destroy uncommitted work to delete a branch.** If a worktree is dirty, snapshot it first
(`git diff HEAD > …patch` plus a copy of the untracked files) and say where the snapshot is.

## UI quiescence — don't reload the architect's page 40 times (2026-08-16, ON by default)

The Tinker UI is served by a vite dev server that WATCHES its source: every write to a watched file
rebuilds and RELOADS whatever page is open. ORCA applies patches hunk by hunk, so a 6-hunk unit used
to be six reloads — five of them rendering a UI built from a half-applied file.

**The rule: never edit a watched file in place.** Assemble the finished content where the watcher
cannot see it, verify it there, and land every file of the unit in ONE burst — one transition, old
coherent state → new coherent state.

- **Worktree mode (the default)** already gives this: the worktree is off the watched path, so
  Phase B is invisible to vite and the **Phase-C merge-back is the single write**. ORCA now says so
  explicitly and defends it — the apply agent must never reach back into the live tree for a watched
  file, and the merge-back must not interleave builds between landing the commit and finishing.
- **In-place mode (`worktreePerAgent:false`)** gets the staging protocol: `cp --parents` the current
  files out to `/tmp/orca-ui-stage-<unitId>`, apply every hunk there, verify there, then a single
  `cp … && cp …` back. Content copy, **never `mv`/rename/symlink** — an inode swap can make the
  watcher drop the file and stop reloading at all.
- **Phase A is in scope too:** since the burst lands all hunks together, a watched unit's patch must
  be coherent once its hunks are applied _together_ — don't split one file's change across two units.

`hmrPaths` — the repo-relative prefixes a dev server watches. Default
`['tinker-ui/src/', 'tinker-ui/index.html', 'tinker-ui/public/', 'ui/src/']`; pass your own array
for another project, or `hmrPaths:false` to switch it off. Detection is per-unit on `writes`, and
the run logs which units triggered it. Test: `node --test docs/superpowers/parallel-implement.hmr-quiescence.test.mjs`.

## FUGU routing — Phase R / Phase L (2026-07-25, ON by default)

ORCA no longer runs every unit on the same model. A **Conductor** phase routes each unit to
the supplier measured best at its _domain_, following Sakana AI's Fugu (arXiv 2606.21228),
whose whole result is that per-domain routing beats every individual model in the pool.

- **Phase R (Route)** classifies each unit (`debug · implement · systems · algorithms · math ·
science · refactor · docs`) and picks a mode:
  - **solo** — one worker leads clearly.
  - **build-debug** — builder + a critic **on a different provider** + a revise step.
  - **debate** — contested domain: 2–3 houses answer in isolation, then the domain leader
    synthesises. The aggregator changes per domain (science→Gemini, systems→GPT, debug→Opus).
- **Phase L (Ledger)** appends each unit's real outcome to `~/.openclaw/orca-expertise.jsonl`.
  Routing starts from published benchmark leaders and is progressively overruled by OUR
  measurements — that write-back is what makes the table ours rather than a hardcoded opinion.

Args: `quality` — `'ultra'` (**default**, compose for the best answer), `'fugu'` (one worker
per unit, cheap), `'off'` (pre-routing behaviour). `crossProvider:false` restricts to Anthropic.

Fail-open by construction: if routing is unavailable every unit runs exactly as before.

Inspect routing without running anything if you have the conductor script on this machine.
If you do not, skip this step — ORCA still works as a Workflow with `scriptPath` above.

## When NOT to use

- A single-file change → just edit it.
- Truly sequential edits where unit B must read unit A's committed result → split into separate ORCA runs.

Keep the workflow script _with the repo you are editing_, not on a private helper machine.
