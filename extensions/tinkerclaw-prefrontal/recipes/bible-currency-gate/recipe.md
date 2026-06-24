---
schema: "kit/1.0"
slug: "bible-currency-gate"
title: "Bible-currency gate (design docs stay current after a code change)"
summary: "After a task that changed the codebase's design/structure/behavior, keep the project's design docs current BEFORE claiming done. Route each changed fact to its single owner, run the docs-invariants gate, and only then claim. Judgment-edit — never auto-dump."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "bible",
    "design docs",
    "update docs",
    "as-built",
    "keep docs current",
    "after change",
    "currency",
    "done",
    "single owner",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
---

# Bible-currency gate (design docs stay current after a code change)

> A task that changed how the system works leaves the design docs stale unless you update them in the SAME task. Run this gate before claiming done.

## Goal

Keep the project's design docs (`{{design_docs_dir}}`) current with what the task just changed, then prove it with the invariants gate — before claiming done.

## When to Use

- The last step of ANY BROCA task (you ran/composed/authored a recipe) that CHANGED `{{repo_root}}` code, structure, config, or runtime behavior.
- NOT for read-only / research / marketing recipe runs that changed no code — there the gate is a no-op (Step 2 passes).
- Run ONCE, by the task-owning (orchestrator) agent — not by every leaf subagent.

## Steps

### 1. Detect the change-set

**Done when:** you know exactly what this task changed under `{{repo_root}}`.

`git -C {{repo_root}} diff --stat` over `src/`, `extensions/`, `tinker-ui/`, and config — plus your own commits this task. List the design/structure/behavior facts that changed.

### 2. No-change shortcut

**Done when:** if the task changed no `{{repo_root}}` code/structure/behavior, record "no bible-relevant change" and PASS the gate.

### 3. Route each fact to its single owner

**Done when:** every changed fact is reflected in the ONE bible file that owns it.

- A bug fix → append a tagged entry to `bug-log.md` (root-cause line required).
- A structural/behavioral fact → update the OWNING optic per `INDEX.md` (single-owner-per-fact) AND add/adjust an executable `verify:` block so the new behavior is gated.
- A decision / intent / don't-regress → a `bible.md` §sub-letter next to what it supersedes.
- Judgment-edit only: write the correct fact in the correct place. NEVER auto-dump a changelog into the bible.

### 4. Run the invariants gate

**Done when:** `{{invariants_cmd}}` is green (pre-existing/environmental failures — e.g. the daily-cron model-rank check — are called out, not silently absorbed).

Run `{{invariants_cmd}}` from `{{repo_root}}`. Fix any verify block your change broke.

### 5. Claim

**Done when:** "done" is stated WITH the bible updated + invariants evidence — or the actual gap is reported honestly.

## Constraints

- JUDGMENT-EDIT, never an auto-writer — the bible is single-owner curated + gated.
- Single-owner-per-fact: a fact lives in exactly one optic (`INDEX.md` decides which).
- Orchestrator-level, once per task — leaf subagents (billing-stripped, partial context) do NOT run this.
- The gate is a NO-OP when the task changed no code — never invent a bible edit.

## Failures Overcome

- 2026-06-19: a chat-rendering fix changed the §5.8 grouping behavior, but the owning optic (`tinker-ui.md`) still described the old position-only collapse — drift caught only on review. This gate makes the bible update a REQUIRED completion step of any code-changing BROCA task.
