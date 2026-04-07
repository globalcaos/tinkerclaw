---
schema: recipe/1.0
id: plan
title: Implementation Plan
category: coding
summary: Granular, executable implementation plan before writing code
triggers: [plan, planning, break down, task list, implementation plan]
effort: standard
tools: [read, grep, glob, write]
children: []
---

## Goal
Step-by-step plan where each task is a single action (2-5 min), with exact file paths, complete code, and verification commands.

## Steps

### 1. Explore Context
**Tools:** read, grep, glob
**Done when:** Understand codebase area, patterns, constraints

### 2. Define Tasks
**Tools:** write
**Done when:** Ordered list with dependencies explicit
Each task = ONE action with exact file paths, complete code, exact commands with expected output. TDD ordering.

### 3. Write Plan Document
**Tools:** write
**Done when:** Plan saved to `docs/plans/YYYY-MM-DD-<feature>.md`

### 4. Review Plan
**Tools:** read
**Done when:** Each task unambiguous, dependencies correct, final verification task exists

## Constraints
- Each task = 2-5 minutes max
- Complete code, not placeholders
- Tests before implementation in every task
- Plan is a living document — update as you learn

## Failures Overcome
- **Vague tasks:** "Implement the feature" is not a task.
- **Missing verification:** Every code change gets verified immediately.
