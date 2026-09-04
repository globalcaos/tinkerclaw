---
schema: "kit/1.0"
slug: "feature"
title: "Build a feature — intent to merged, in parallel"
summary: "The full build pipeline for a new feature or capability: interview the user until a SPEC exists, turn it into an executable plan, build it in parallel waves with tests proven in isolation first, harden the tests, verify with fresh evidence, review adversarially, merge and delete the branch. Use when the user says build me, add, implement, create, I want a new feature, or ship this."
version: "2.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "add",
    "create",
    "build",
    "implement",
    "new feature",
    "make it",
    "build me",
    "i want",
    "develop",
    "ship",
  ]
antiTriggers: ["bug", "broken", "crash", "refactor", "review only", "plan only"]
testedHarnesses: ["OpenClaw", "Claude Code"]
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
    - [7]
  notes: |
    Every step is a barrier: each one consumes the artifact the previous one wrote.
    The parallelism lives INSIDE the sub-recipes — brainstorm-gate fans out read-only
    exploration, implementation-plan drafts tasks and test tiers concurrently,
    parallel-build runs ORCA waves, test-hardening fans out per module,
    verification-gate runs its independent checks concurrently and dispatches the
    second-opinion leg, code-review fans out three lenses. Do not flatten these
    groups to fake concurrency at this level.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Repository-relative directory holding the SPEC and PLAN files that the sub-recipes exchange.",
    }
  integration_branch:
    {
      type: "string",
      default: "develop",
      description: "Branch the finished work merges into; passed through to finish-branch.",
    }
---

# Build a feature — intent to merged, in parallel

> Questions all happen once, at the front. After that the pipeline decides and
> logs rulings, builds in parallel, and stops only to merge.

## Goal

Take a feature request from "I want X" to merged, without the user answering
implementation trivia along the way. Understanding is front-loaded into one
interview; everything after approval is a ruling the agent makes and writes
down. Work fans out wherever it is independent, so the wall-clock cost is the
critical path, not the sum of the tasks.

**Task sizing.** If the change fits in one sentence and one file, say so out
loud, SKIP steps 1–2, write a two-line plan inline, and run steps 3→7. Hidden
complexity upgrades the path mid-run (go back and do the interview); it never
downgrades it. Anything touching two or more files, an unfamiliar area, or an
uncertain approach runs the full pipeline.

## When to Use

- A new capability, module, extension, endpoint, or UI surface is requested.
- Existing functionality is being extended in a way that changes its contract.
- The user says "build me", "add", "implement", "create", "I want", "ship".

## When NOT to use

- Something is broken → `debug`.
- Behaviour must stay identical while the structure changes → `refactor`.
- The user asked for ONLY a plan, ONLY a review, or ONLY verification → run
  that sub-recipe standalone; each one works without this pipeline.

## Steps

### 1. Understand it perfectly

uses: brainstorm-gate
**Done when:** A SPEC file exists at `{{plans_dir}}/YYYY-MM-DD-<feature>-spec.md` and the user has said an explicit yes.

Receives: the raw request plus the repository. Returns: the SPEC path, the task
classification (spike / bounded / architectural), and a recorded approval. The
SPEC names files, interfaces, out-of-scope, verifiable done-when checks, and a
"Rulings I will make myself" list the user could veto now. Silence is not
approval. Nothing is built until this returns yes.

### 2. Turn the spec into an executable plan

uses: implementation-plan
**Done when:** A PLAN file exists at `{{plans_dir}}/YYYY-MM-DD-<feature>-plan.md` with edit-units whose `writes` sets are disjoint.

Receives: the SPEC path. Returns: the PLAN path. The plan carries a file map,
an Interfaces block (consumes/produces with exact signatures) so parallel
implementers agree without talking, tasks of 2–5 minute steps with exact verify
commands, a `complexity: simple|complicated` tag per task, edit-units tagged
`wave: isolate|integrate`, and the empty rulings ledger. No placeholders.

### 3. Build it in parallel waves

uses: parallel-build
**Done when:** Every edit-unit is committed on the feature branch and wave-1 units were green on their own tests before any wiring landed.

Receives: the PLAN path. Returns: the commit list, the units re-derived, and
anything outstanding. Complicated pieces are built and proven in ISOLATION
first — a test author and an implementer per unit, fresh context each. Wiring
runs only against committed, green units. ORCA serialises writes per file so
disjoint units run concurrently. This is where the record time comes from.

### 4. Harden the tests

uses: test-hardening
**Done when:** The behaviours the SPEC promised each have a named test, and the added tests pass in isolation and in the full suite.

Receives: the diff from step 3 plus the SPEC path. Returns: tests added, small
adjacent fixes committed separately, and bookmarks for anything larger. Fans
out one agent per touched module. Coverage is reported in behaviours, not line
percentages. Scope is the change and its direct neighbours — a widening beyond
that is a bookmark in the ledger, never a silent extra.

### 5. Prove every claim with fresh evidence

uses: verification-gate
**Done when:** Each done-when check in the SPEC has a command that was run and output that was read in this session.

Receives: the SPEC's done-when list. Returns: the evidence table. Test as the
user would: served output for wiring, a render actually looked at for
appearance with geometry as numbers, the real CLI for tools. Source is not
built is not restarted — if something is edited but not deployed, the report
says "written, not running". Successes are swallowed; only failures surface.

### 6. Adversarial review against the spec

uses: code-review
**Done when:** Findings are severity-ordered against the SPEC and PLAN, each verified against the real code, with optional ones marked optional.

Receives: the diff, the SPEC path, the PLAN path. Returns: the findings list.
Three lenses fan out in parallel — correctness plus spec compliance, security
plus data flow, tests plus maintainability — on a model family DIFFERENT from
the implementer's. Findings that do not affect correctness or a stated
requirement are marked optional so the fixer does not over-engineer.

### 7. Finish the branch

uses: finish-branch
**Done when:** The work is merged into `{{integration_branch}}` and the branch and its worktree are deleted, or the exact blocker is named.

Receives: the feature branch and `{{integration_branch}}`. Returns: the closing
status line. Integration verify runs on the branch, the owning design doc is
brought current, the merge is fast-forward where possible, and redundancy is
PROVEN before any deletion. Committing is not done; merged is done. Never ask
the user about pushing.

### 8. Report

**Done when:** The user has outcome, evidence, rulings, and what is on them — and the report contains no code.

Prose plus a status card. Outcome first, in the user's terms. Then the evidence
(commands run and what they returned), the rulings taken without asking and
what each would cost if wrong, the merge/delete status verbatim from step 7,
bookmarks left for later, and anything genuinely on the user. Two numbers
close the report, because they are what tells us whether this pipeline is
getting better: fix rounds the build needed (zero means it merged on the
first pass) and rulings taken without asking. No diffs, no snippets, no file
dumps — the code is in the commits.

## Constraints

- After step 1's approval the pipeline asks the user NOTHING except the four
  stop reasons: an irreversible or destructive operation, a security-sensitive
  action, a side effect outside the worktree (merge to a shared branch,
  publish, send), or a plan so broken every path is a guess.
- Every other ambiguity is decided and logged in the PLAN's rulings ledger as
  `Ruling: <what> — <why> — <cost if wrong>`.
- Parallelism is the default inside every sub-step. Steps 1 through 6 all fan
  out internally; steps 7 and 8 are barriers by design.
- Progress lives on disk: SPEC, PLAN, rulings ledger, one commit per edit-unit,
  a progress note at each step boundary. A resumed session reads state instead
  of re-deriving it.
- Follow existing patterns — do not invent new conventions. Every new file gets
  a header comment explaining purpose and wiring. No commented-out code, no
  leftover debug logging.
- The final report contains no code.

## Safety Notes

- Build on a feature branch or worktree, never directly on
  `{{integration_branch}}`.
- Gateway extensions: confirm the plugin manifest has every mandatory field,
  including its config schema, before wiring anything to it.
- Native addon packages must be externalised in the bundler config, and new
  dependencies with native bindings added to the package manager's
  built-dependencies allowlist.
- A step that returns without its artifact is a failure, not a pass. Do not
  advance the pipeline on a sub-recipe's confident summary alone.

## Failures Overcome

- **Pattern mismatch** (v1.0, undated): a module got built in a style unlike
  the rest of the codebase. The interview step now requires reading at least
  two similar files before any design is proposed.
- **Missing wiring** (v1.0, undated): feature code was written but never
  connected to anything that calls it. The plan must state how the feature gets
  loaded or invoked, and step 3's wave 2 exists specifically for wiring.
- **Gateway cache** (v1.0, undated): the gateway holds `index.html` in memory,
  so a UI rebuild alone changed nothing on screen. Restart after a rebuild, and
  verify on the served output rather than the source.
- **Questions at the wrong end** (2026-09-02): the architect asked for the
  understanding to happen up front and for the run to stop presenting choices
  between implementation options at the end. This version front-loads every
  question into step 1 and converts all later choices into logged rulings.
- **A summary that reads as done** (2026-09-02): the pipeline used to end at
  "verified", which a reader reasonably takes as finished while the branch sits
  open. Step 7 is now part of the pipeline and step 8 must quote its status
  line.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): the report closes with fix rounds and rulings, the two leading indicators of the pipeline itself.
