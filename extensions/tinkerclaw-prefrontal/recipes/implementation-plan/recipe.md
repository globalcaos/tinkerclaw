---
schema: "kit/1.0"
slug: "implementation-plan"
title: "Write a granular implementation plan before coding"
summary: "Turn a feature request into a step-by-step implementation plan where every task is a single 2-5 minute action with exact file paths, complete code (no placeholders), and exact verification commands — TDD-ordered and saved as a living document."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "plan",
    "planning",
    "implementation plan",
    "break down",
    "task list",
    "write a plan",
    "plan before coding",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Directory where plan documents are written.",
    }
---

# Write a granular implementation plan before coding

> A plan where each task is a single executable action — exact file paths,
> complete code, exact verification commands — so any competent agent (or the
> operator) can execute it without guessing.

## Goal

Produce a step-by-step plan where each task is ONE action (2-5 minutes), with
exact file paths, complete code, and verification commands with expected
output. TDD ordering throughout: tests before implementation in every task.

## When to Use

- "Plan this feature", "break this down", "write an implementation plan"
- Before any multi-step coding task large enough that holding it in one head
  loses detail
- Before dispatching parallel subagent implementation waves — each plan task
  becomes a candidate edit-unit with its file paths already pinned

## Steps

### 1. Explore context

**Done when:** The relevant codebase area, its patterns, and its constraints
are understood — read the files the change will touch, grep for existing
conventions, and note anything that limits the design.

Read-only: read, grep, glob. No writes yet.

### 2. Define tasks

**Done when:** An ordered task list exists with dependencies explicit.

Each task = ONE action with exact file paths, complete code (no placeholders),
and exact commands with expected output. TDD ordering: the task that writes
the failing test precedes the task that makes it pass.

### 3. Write the plan document

**Done when:** The plan is saved to `{{plans_dir}}/YYYY-MM-DD-<feature>.md`.

The plan is a living document — update it as implementation teaches you
something; never let it silently drift from reality.

### 4. Review the plan

**Done when:** Each task is unambiguous, dependencies are correct, and a final
verification task exists that proves the whole feature works end to end.

## Constraints

- Each task = 2-5 minutes max — if it is bigger, split it.
- Complete code in the plan, not placeholders or "something like".
- Tests before implementation in every task.
- Plan is a living document — update as you learn.
- Skeleton rule: the plan references repository-relative paths only; no
  operator-specific names, domains, or host paths.

## Safety Notes

- Planning is read-only toward the codebase: the only write is the plan
  document itself under {{plans_dir}}. No source files are edited in this
  recipe.

## Failures Overcome

- **Vague tasks:** "Implement the feature" is not a task.
- **Missing verification:** Every code change gets verified immediately.
- v1.0: resurrected 2026-06-13 from commit a239df31a4^ (old `coding/plan.md`,
  schema recipe/1.0) as a kit/1.0 skeleton; slug renamed `plan` →
  `implementation-plan` (the old id collided with common words).
