---
schema: "kit/1.0"
slug: "implementation-plan"
title: "Turn a spec into a plan a stranger could execute in parallel"
summary: "Write an implementation plan from a spec: a file map, an interfaces block, tasks of 2-5 minutes with complete code and exact verify commands, grouped into edit-units with disjoint writes so the build runs concurrently. Use for 'write a plan', 'break this down', 'plan this feature', 'just a plan, no code yet'."
version: "2.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "planning"
tags:
  [
    "plan",
    "planning",
    "implementation plan",
    "write a plan",
    "plan this feature",
    "break this down",
    "break it into tasks",
    "task list",
    "plan before coding",
    "plan only",
    "just a plan",
    "how would you build this",
    "spec to plan",
  ]
antiTriggers:
  [
    "bug",
    "broken",
    "crash",
    "just fix it",
    "review only",
    "we already have a plan",
    "one-line change",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
    - [5]
  notes: |
    Step 1 is a barrier: exploration fans out INSIDE it, but nothing can be planned until the spec and the touched files are known.
    Step 2 is a barrier: the file map and interfaces fix the names every later section depends on.
    Steps 3 and 4 fan out together: tasks and test tiers are drafted by separate agents against the same fixed interfaces, and neither writes the other's section.
    Step 5 is a barrier: self-review must see the merged draft, not half of it.
    Step 6 is the single write of the plan file.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Directory holding spec and plan documents; the only place this recipe writes.",
    }
  spec_path:
    {
      type: "string",
      default: "",
      description: "Path to an existing SPEC file. Empty means locate one under plans_dir, or derive a minimal spec when the task is bounded.",
    }
---

# Turn a spec into a plan a stranger could execute in parallel

> Every task names its files, its complete code and its verify command; every
> unit names its writes. A stranger could run it, and several could run it at
> once.

## Goal

Produce a PLAN file from a SPEC: file map, interfaces, tasks of 2-5 minutes
with complete code and exact verification commands, test tiers per unit, and
edit-units with disjoint `writes` so the build fans out. Complicated pieces
are ordered to be proven in isolation before anything wires them.

## When to Use

- "Write a plan", "break this down", "plan this feature before we code"
- A change spanning multiple files, or unfamiliar code, or an uncertain approach
- Before a parallel build wave — each edit-unit is what the executor consumes
- Standalone: the user wants only a plan and no implementation

## When NOT to use

- The diff fits in one sentence and one file — write it, then verify
- A defect with unknown cause — find the root cause first
- The requirements are still open — run the intent interview first; this
  recipe plans a decided thing, it does not decide it

## Steps

### 1. Load the spec and fan out exploration

model: sonnet
thinking: medium
out: {"type":"object","required":["spec_path","task_class","files"],"properties":{"spec_path":{"type":"string"},"task_class":{"type":"string","enum":["spike","bounded","architectural"]},"files":{"type":"array","items":{"type":"string"}},"conventions":{"type":"array","items":{"type":"string"}},"risks":{"type":"array","items":{"type":"string"}}}}
**Done when:** A spec is in hand with its path recorded, and every file the
change will touch has been read, with conventions, constraints and risks
written down.

Use `{{spec_path}}` when given; otherwise look under `{{plans_dir}}` for
`YYYY-MM-DD-<feature>-spec.md`. No spec and the task is bounded: derive a
minimal one (Goal, Constraints, Done-when, Out of scope) from the request and
say in the plan header that it was derived. No spec and the task is
architectural: stop and run the intent interview — do not invent scope.
Exploration fans out read-only, one agent per area: the files to change,
sibling implementations of the same pattern, the test conventions, the owning
design doc, recent commits touching those paths. No writes in this step.

### 2. File map and interfaces

**Done when:** Every file to create or modify is listed with one
responsibility each, and an Interfaces block gives exact signatures for
everything that crosses a task boundary.

The Interfaces block is what lets implementers work without talking to each
other: for each boundary, what it consumes and produces, with exact names,
types and error shapes. Anything two tasks share — a type, a constant, a
fixture path, a config key — is defined here and owned by exactly one file;
the other tasks import it. A name invented later by two agents in parallel is
two names.

### 3. Define tasks and edit-units

model: opus
thinking: high
**Done when:** Every task carries its files, steps of 2-5 minutes, complete
code, an exact verify command with expected output, a complexity tag and an
edit-unit id whose `writes` are disjoint from its wave siblings.

TDD order inside every task: the failing test comes before the code that
passes it. No placeholders — "TBD", "add error handling", "similar to task 3"
are defects, not shorthand. Tag `complexity: complicated` when the task has
non-trivial logic, state, concurrency, parsing or maths; those take
`wave: isolate` and are proven on their own tests before anything depends on
them. The rest take `wave: integrate`. Group tasks into edit-units
`{ id, task, writes, reads, complexity, wave }` with disjoint `writes`; two
tasks writing one file are one unit, not two.

### 4. Test tiers per unit

model: sonnet
thinking: medium
**Done when:** Each unit names its unit tests, its seam integration test and
the single end-to-end check, each with the exact command to run it.

Unit tests assert behaviour — public contract, edge cases, error paths — not
internals. The integration test covers the seam the unit exposes to its
callers. The end-to-end check is exercised as the user would: the served
output for wiring, a render someone looked at with geometry reported as
numbers for UI, the real command line for tools. Presence in source is not
appearance on screen. Write the expected output next to each command, so
"passed" is a comparison and not an impression.

### 5. Self-review the draft

thinking: high
**Done when:** Four scans pass and each is recorded as a line in the plan:
spec coverage, placeholder scan, name and type consistency, isolation
ordering — and the three interrogation questions have written answers.

Interrogate the plan the way an engineer interrogates it in plan mode before
accepting: What could break? Which step is the most risky? What other options
were there, and why not? The answers become the plan's **Risks** section (one
line per risk, with the task that carries it) and its **Proof** section (the
exact tests and observations that will show the feature works). A plan
without a Risks section has not been interrogated.

Spec coverage: every Done-when in the spec maps to at least one task's verify
command. Placeholder scan: search the draft for TBD, "etc.", "and so on",
"handle errors", "similar to". Consistency: names, types and signatures agree
between tasks and the Interfaces block. Isolation ordering: every complicated
unit's own tests appear in the isolate wave before any integrate task reads
it. Defects are fixed here, in the draft — never carried forward as a note
for the executor to discover.

### 6. Write the plan file and hand off

**Done when:** `{{plans_dir}}/YYYY-MM-DD-<feature>-plan.md` exists containing
header, file map, interfaces, tasks, test tiers, Risks, Proof, an empty rulings
ledger and a per-task status table, and the hand-off names the plan path.

The plan is the audit trail for the review that follows. When implementation
departs from it, the plan is updated in the SAME commit as the departure, so
the merged diff and the committed plan never disagree; a departure that is
only in the ledger is half-recorded.

The header carries goal, architecture, spec path and global constraints.
Status starts `pending` for every task. Hand the plan path to the build
recipe; a standalone run stops here and presents the plan instead. State
explicitly that from this point implementation-detail choices are rulings the
executor makes and appends to the ledger as
`Ruling: <what> — <why> — <cost if wrong>`, not questions for the user.

## Constraints

- One task = one action of 2-5 minutes. Bigger means split it.
- Complete code in the plan. No placeholders, no "something like this".
- Tests before implementation, in every task.
- Edit-units in the same wave have disjoint `writes`; shared files merge into
  one unit.
- The plan is a living document — execution updates status and the ledger;
  it never silently drifts from what was built.
- Repository-relative paths only; no operator names, domains or host paths.
- After the plan is handed off, only four things stop a run to ask a human: an
  irreversible or destructive operation, a security-sensitive action, a side
  effect outside the worktree, or a plan so broken that every path is a guess.

## Safety Notes

- This recipe is read-only toward the codebase. The only write is the plan
  document under `{{plans_dir}}`. No source file is edited here.
- No spec and an architectural task means the requirements are not settled:
  run the intent interview rather than planning a guess.
- Claims about subsystems nobody read in step 1 are assumptions — mark them as
  such in the plan so the executor verifies rather than inherits them.

## Failures Overcome

- **Vague tasks:** "Implement the feature" is not a task. A task names its
  files, its code and its verify command.
- **Missing verification:** every code change carries its verify command and
  expected output in the plan, not in the executor's memory.
- **2026-06-13, v1.0:** resurrected from the old `coding/plan.md`
  (schema `recipe/1.0` to `kit/1.0`); slug renamed `plan` to
  `implementation-plan` because the old id collided with common words.
- **2026-09-02, v2.0:** the architect asked for questions front-loaded into
  the intent phase and none at the end, and for the build to run in parallel.
  A serial task list cannot deliver that: the plan now fixes interfaces before
  tasks, groups tasks into edit-units with disjoint `writes`, and orders every
  complicated piece to be proven on its own tests before a wiring task depends
  on it.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): Risks and Proof sections, the three plan-mode interrogation questions, and the rule that a departure amends the plan in the same commit.
