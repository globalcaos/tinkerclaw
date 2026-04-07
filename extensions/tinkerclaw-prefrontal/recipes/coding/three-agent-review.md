---
schema: recipe/1.0
id: three-agent-review
title: Three-Agent Code Review
category: coding
summary: Build → spec-verify → quality-review pipeline using three sequential sub-agents
triggers: [review pipeline, three-agent, implement and review, full review]
effort: deep
tools: [read, grep, glob, exec, sessions_spawn]
children: []
---

## Goal
Implement a task with high first-time quality using three sequential sub-agents: implementer, spec reviewer, quality reviewer.

## When to Use
- Multi-file implementation tasks
- Features where correctness matters more than speed
- Work that will be submitted as a PR

## Steps

### 1. Prepare Task Brief
**Tools:** read, grep
**Done when:** Complete task description with context, file paths, and acceptance criteria

### 2. Dispatch Implementer
**Tools:** sessions_spawn
**Done when:** Sub-agent returns with implementation report
Model: sonnet. Must implement, write tests, run tests, self-review, commit.

### 3. Dispatch Spec Reviewer
**Tools:** sessions_spawn
**Done when:** Spec compliance confirmed or issues listed
Model: haiku. Critical instruction: "DO NOT trust the implementer's report." Must read actual code and compare to requirements line by line.

### 4. Dispatch Quality Reviewer
**Tools:** sessions_spawn
**Done when:** Code quality approved
Model: gpt. Only dispatches after spec compliance passes. Checks patterns, tests, dead code, over-engineering.

### 5. Final Verification
**Tools:** exec
**Done when:** Full test suite passes with evidence
Run verification yourself. Don't trust any sub-agent's claim.

## Constraints
- Sequential dispatch — not parallel
- Each sub-agent is a separate sessions_spawn call
- Spec reviewer MUST be told not to trust implementer
- If implementer needs 3+ rounds, reconsider task scope

## Failures Overcome
- **Trusting reports:** Implementer says "all tests pass" but had failures. Spec reviewer catches by running independently.
- **Rubber-stamping:** Explicit "DO NOT trust" instruction prevents reviewer passivity.
