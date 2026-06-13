---
schema: "kit/1.0"
slug: "brainstorm-gate"
title: "Brainstorming gate (explore, ask, propose, approve)"
summary: "Mandatory design phase before any creative or architectural work: explore the codebase, resolve ambiguities one question at a time, propose 2-3 approaches with a recommendation, and get explicit approval before a single line of implementation."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "brainstorm",
    "design",
    "before building",
    "new feature",
    "how should we",
    "how should we build this",
    "approach",
    "architecture",
    "design gate",
    "what do you think",
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
---

# Brainstorming gate (explore, ask, propose, approve)

> Explore, ask, propose, approve — a mandatory design phase that catches wrong
> directions before any code is written.

## Goal

Prevent wasted work by requiring design discussion and explicit approval from
the user before any creative or architectural work begins. The gate produces a
shared understanding of the problem, 2-3 candidate approaches with trade-offs,
and one approved direction — only then does implementation start.

## When to Use

- "How should we build this?", "what approach would you take?", "what do you
  think?" — any design-shaped question before building
- Starting a new feature, component, or architectural change
- Any creative task, however small — scale the design phase down, never skip it

## Steps

### 1. Explore

**Done when:** The relevant codebase, constraints, and prior art are understood.

Read-only reconnaissance: read the code that the work will touch, grep for
existing patterns and prior implementations, search the web for prior art if
the problem is novel. No edits in this step.

### 2. Ask

**Done when:** All ambiguities are resolved.

One question at a time, prefer multiple choice. Exhaust the conversation
context and memory before asking — a question is justified only by genuine
under-specification, never by what is already knowable.

### 3. Propose

**Done when:** 2-3 approaches with trade-offs and a clear recommendation are on
the table.

Keep each approach short enough to compare at a glance. State the
recommendation and why; do not pad with options nobody would pick.

### 4. Approve

**Done when:** The user explicitly confirms an approach.

"What do you think?" is a design gate, not a rhetorical question. Do NOT start
building while the question is open.

### 5. Transition

**Done when:** Implementation begins with the approved approach.

Hand off to the appropriate execution path — a written plan, a feature
workflow, or a three-agent-review recipe — carrying the approved design as its
input.

## Constraints

- EVERY creative task gets a design phase (scale it, don't skip it)
- Do NOT start implementation during brainstorming — steps 1-4 are read-only
- Cap at 2-3 approaches with a clear recommendation
- One question at a time in step 2; prefer multiple choice

## Safety Notes

- Steps 1-4 use read/search tools only (read, grep, glob, web search); no
  write, send, or deploy tools until the transition step.
- The approval in step 4 must come from the user, not be inferred from
  silence or assumed from context.

## Failures Overcome

- **Building the wrong thing:** Ask+propose+approve catches wrong directions before code.
- **Skipping for "simple" tasks:** Every project gets a design. Scale it, don't skip it.
- v1.0: resurrected 2026-06-13 from commit a239df31a4^ (deleted recipe/1.0
  `analysis/brainstorm-gate.md`) and converted to the skeleton+params pattern;
  no params needed for this recipe.
