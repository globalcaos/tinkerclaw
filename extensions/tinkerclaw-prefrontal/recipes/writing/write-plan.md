---
schema: recipe/1.0
id: write-plan
title: Write Plan
category: writing
summary: Create an implementation plan — scope, research, structure, draft, review
triggers: [plan, roadmap, "design doc", RFC, proposal, "implementation plan"]
effort: standard
tools: [read, grep, glob, write]
children: []
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
