---
schema: "kit/1.0"
slug: "write-plan"
title: "Write Plan"
summary: "Create an implementation plan — scope, research, structure, draft, review"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["writing", "plan", "roadmap", "design doc", "RFC", "proposal", "implementation plan"]
tools: ["read", "grep", "glob", "write"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
  notes: |
    Scope (0) defines boundaries — must complete before any research begins.
    Research (1) is read-only and can fan per affected area internally (e.g.
    one scout per integration point), but is modelled as one step group.
    Structure (2) synthesises the research into a dependency-mapped task
    breakdown — serial barrier. Draft (3) writes the plan document — single
    write step. Review (4) validates completeness and feasibility — serial read.
    Step index: 0=Scope, 1=Research, 2=Structure, 3=Draft, 4=Review.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "plan | roadmap | design doc | RFC | proposal | implementation plan",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: plan, roadmap, design doc, RFC, proposal, implementation plan",
    },
  ]
---

## Goal

Produce a clear, actionable implementation plan that can be executed by agents or humans.

## When to Use

- Before starting a multi-step implementation
- Design documents or RFCs
- Project roadmaps
- Migration plans

## Steps

### 1. Scope

**Done when:** Clear boundaries, success criteria, and non-goals defined

Define what's in scope and explicitly what's NOT. Set measurable success criteria. Identify dependencies and prerequisites. Estimate overall effort level.

### 2. Research

**Tools:** read, grep, glob
**Done when:** Current state understood, patterns identified

Read the existing code that will be affected. Identify integration points. Check for prior art or related plans. Note risks and unknowns discovered during research.

### 3. Structure

**Done when:** Task breakdown with dependencies mapped

Break work into numbered tasks. Each task should be independently completable and verifiable. Map dependencies between tasks. Identify which tasks can be parallelized. Assign effort estimates.

### 4. Draft

**Tools:** write
**Done when:** Complete plan document written

Write the plan following the superpowers spec+plan format:

- Summary (1-3 sentences)
- Context and motivation
- Task list with descriptions, files affected, verification steps
- Risk register
- Rollback strategy

### 5. Review

**Tools:** read
**Done when:** Plan reviewed for completeness and feasibility

Verify every task has clear success criteria. Check that dependencies are correctly mapped. Ensure rollback is possible at each stage. Validate that the plan addresses all requirements from the scope.

## Constraints

- Every task must be independently verifiable
- Dependencies must be explicit
- Plans should be executable by someone unfamiliar with the codebase
- Include rollback strategy for each major step

## Safety Notes

- Don't plan changes to files you haven't read
- Verify assumptions about APIs and interfaces against actual code
- Include "what could go wrong" for each task

## Failures Overcome

- **Vague tasks:** Agent writes tasks like "implement the feature" without specifics. Each task must name files, functions, and verification commands.
- **Missing dependencies:** Tasks ordered wrong because dependencies weren't mapped. The structure step requires explicit dependency declaration.
- **No rollback:** Plan assumes everything works. Every plan needs a rollback strategy at the plan level and ideally per-task.
