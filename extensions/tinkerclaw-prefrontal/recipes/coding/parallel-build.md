---
schema: "kit/1.0"
slug: "parallel-build"
title: "Parallel build — execute a plan in waves, one commit per unit"
summary: "Execute an implementation plan in record time: split it into edit-units with disjoint writes, prove every complicated piece in isolation with its own tests first, then wire it up — all fanned out through ORCA with one commit per unit. Use when you have a plan and want it built in parallel, built fast, or built without serial hand-edits."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "build it",
    "execute the plan",
    "implement the plan",
    "parallel build",
    "build in parallel",
    "fan out the implementation",
    "in record time",
    "as fast as possible",
    "orca",
    "edit units",
    "multi-file implementation",
    "one commit per unit",
    "isolate then integrate",
  ]
antiTriggers:
  [
    "plan only",
    "just a plan",
    "review only",
    "bug",
    "broken",
    "debug this",
    "one-line change",
    "single file edit",
    "brainstorm",
  ]
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
  notes: |
    Step 1 is a barrier: nothing may write until the units are proven disjoint and the worktree exists.
    Step 2 (wave ISOLATE) is internally parallel — ORCA runs every complicated unit's test-author and implementer concurrently.
    Step 3 (wave INTEGRATE) is a barrier against step 2: wiring reads code that wave 1 must have already committed.
    Step 4 is a single whole-tree command — one run, after all writes, never per unit.
    Step 5 fans out one fresh reviewer per unit, but only once the tree is green, so its findings are about the merged state.
    Step 6 is serial by nature: one ledger, one appender.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where the SPEC and PLAN files live; the ledger is appended to the PLAN here.",
    }
  integration_branch:
    {
      type: "string",
      default: "develop",
      description: "The shared branch the work will eventually merge into. Never built on directly.",
    }
  orca_workflow:
    {
      type: "string",
      default: "docs/superpowers/parallel-implement.workflow.js",
      description: "Repo-relative path to the ORCA parallel-implement workflow; override when the orchestrator lives elsewhere.",
    }
  max_fix_rounds:
    {
      type: "string",
      default: "3",
      description: "Fix rounds allowed against a failing integration verify before the run stops and escalates.",
    }
---

# Parallel build — execute a plan in waves, one commit per unit

> A plan becomes commits. Complicated pieces are proven alone before anything
> wires them. Independent units run at the same time; only the waves are serial.

## Goal

Turn a PLAN file into committed, tested code in the shortest wall-clock time
the dependency graph allows — without two agents fighting over one file, and
without a complicated piece being integrated before it is green on its own.

## When to Use

- A PLAN file exists (or a two-line plan for a bounded change) and the work
  touches two or more files that can be edited independently.
- The request is "build it", "build it fast", or "execute the plan".

## When NOT to use

- The change fits in one sentence and one file — just make the edit.
- No plan and no spec, and the task is architectural — run `implementation-plan`
  first; parallelism over an unclear design multiplies the wrong work.
- The failure being chased is a bug — run `debug`.

## Steps

### 1. Preflight the units

out: {"type":"object","required":["worktree","units"],"properties":{"worktree":{"type":"string"},"units":{"type":"array","items":{"type":"object","required":["id","task","writes","complexity","wave"],"properties":{"id":{"type":"string"},"task":{"type":"string"},"writes":{"type":"array","items":{"type":"string"}},"reads":{"type":"array","items":{"type":"string"}},"complexity":{"type":"string","enum":["simple","complicated"]},"wave":{"type":"string","enum":["isolate","integrate"]},"model":{"type":"string"}}}}}}
**Done when:** Every unit has a model, a wave, and a `writes` list that overlaps no other unit in the same wave; the worktree exists and is not `{{integration_branch}}`.

Read the PLAN in `{{plans_dir}}`. Lift its edit-units verbatim; if two units in
one wave write the same path, merge them or move one to a later wave — do not
hope the lease sorts it out. Snapshot any foreign work in progress before
touching the tree and say where the snapshot is. Create the worktree. Pick the
model per unit by weight: cheap for mechanical edits, strong for units tagged
`complicated`. Record the assignment; it is the first entry in the ledger.

### 2. Wave ISOLATE — prove the complicated pieces alone

**Done when:** Every `complicated` unit is committed and green on its OWN tests, with no wiring done yet.

Each complicated unit gets TWO fresh agents. The test author sees only the spec
and the interface block and writes failing unit tests. The implementer makes
them pass and never edits a test except to correct a wrong expectation, which
is logged as a ruling. The test author never sees the implementation. Dispatch
the wave through `{{orca_workflow}}`: patches drafted fully in parallel, applied
per-file-serialised, committed one unit at a time. Simple units in this wave run
as a single agent. A unit that fails twice gets a stronger MODEL, not more
thinking.

### 3. Wave INTEGRATE — wire it up

**Done when:** Callers, registration, config and the owning design doc are committed, each as its own unit commit.

Wiring runs against the committed wave-1 code, so the implementers read real
signatures rather than promised ones. Same ORCA pass: draft in parallel, apply
serialised per file, one commit per unit. Files a live dev server watches are
assembled off-tree and landed in one burst so an open page reloads once on the
finished state. A design principle or user-visible feature updates its bible
optic in this same wave — a doc left stale here is a defect, not a follow-up.

### 4. Integration verify

**Done when:** One whole-tree command — typecheck plus the full suite — exits clean, and you saw the output yourself.

Run it once, after all writes. Not per unit; per-unit checks already ran during
the waves. Swallow success output and surface only failures, so a green run
costs almost no context. A failure goes back to the unit that owns the file, as
a fix round with the verbatim error attached. Cap the rounds at
`{{max_fix_rounds}}`; then escalate the model once; then stop and report with
the evidence. Do not disable a hook or bypass a commit gate to get past a red
check — a red check that was silenced is a defect shipped.

### 5. Per-unit spec check

**Done when:** Every unit has a fresh reviewer's verdict against its plan task, and every gap is either fixed or logged as a ruling.

One reviewer per unit, fresh context, ideally a different model family from the
implementer — the suspect does not investigate itself. Tell it in as many words
not to trust the implementer's report, hand it the plan task and the unit's
diff, and ask one question: what does the task require that the diff does not
do? Gaps become fix rounds against the owning unit. Style opinions are not
gaps; do not let an un-scoped review grow the change.

### 6. Ledger and handoff

**Done when:** The PLAN in `{{plans_dir}}` carries every ruling and a progress note, and the report names each unit as committed, re-derived, or outstanding.

Append the rulings as `Ruling: <what> — <why> — <cost if wrong>` and set the
status of every task, so a resumed session reads state instead of re-deriving
it. Where a unit departed from its plan task, the plan text itself is amended
in that unit's commit, not only the ledger — the committed plan must describe
the merged code. Report the commit for each unit, which patches ORCA had to re-derive
because a shared file moved under them, and anything left outstanding with the
reason. Hand off to `finish-branch`; committed is not done, and this recipe
does not merge.

## Constraints

- ORCA is driven from the plan: `units[].writes` comes from the PLAN's edit-units, never guessed.
- One commit per unit, staging only that unit's own files. Never stage the whole tree — on a
  permanently dirty branch that commits other people's work under your message.
- Diff the staged set before every commit and read the file list, not just the summary line.
- Never bypass commit hooks or verification flags to make a commit land.
- Never build on `{{integration_branch}}`; the worktree is the unit of isolation.
- Between waves is a barrier by design. Inside a wave, everything independent runs at once.
- Prefer a mechanism to a reminder: a mistake that recurs becomes a test, a lint rule or a
  hook in this run, not a sentence in the next prompt.
- Never ask the user about pushing. Pushing is theirs, in their own time.

## Safety Notes

- Snapshot uncommitted foreign work before creating or resetting a worktree, and say where the
  snapshot lives. Never discard a dirty tree to make room.
- The four stop reasons still apply mid-wave: an irreversible operation, a security-sensitive
  action, a side effect outside the worktree, or a plan so broken every path is a guess.
  Everything else is a ruling, logged, not a question.
- Reviewers get read and test-execution access only — no commit, no deploy.
- Report what is true: "written, not running" when the code is on disk but the service has not
  been rebuilt or restarted.

## Failures Overcome

- **2026-06-05 — colliding hand-edits.** Serial edits ran into a concurrent worker touching the
  same files; work was silently overwritten. Lease-based per-file serialisation became the
  standing rule for any change spanning multiple files.
- **2026-08-16 — six reloads per unit.** Hunk-by-hunk writes into files a dev server watched
  reloaded the page on every half-applied state. Content is now assembled off-tree and landed
  in one burst.
- **2026-08-24 — green summaries hid unmerged branches.** "Committed and verified" read as
  finished; the branch sat open for days. This recipe now ends by handing to `finish-branch`
  and never claims done.
- **2026-08-31 — a whole-tree stage committed 918 unrelated insertions.** Staging is
  file-granular and the branch was dirty. Every commit now stages one unit's files and the
  staged diff is read before the commit lands.
- **v1.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): a unit that departs from its plan task amends the plan text in that unit's commit.
