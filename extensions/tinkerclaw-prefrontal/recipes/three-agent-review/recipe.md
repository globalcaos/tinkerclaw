---
schema: "kit/1.0"
slug: "three-agent-review"
title: "Three-agent code review (implement, spec-verify, quality-review)"
summary: "Implement a task with high first-time quality using three sequential subagents: an implementer, a spec-compliance reviewer told explicitly NOT to trust the implementer's report, and a quality reviewer dispatched only after spec passes. The orchestrator runs final verification itself."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "code review",
    "three-agent",
    "review pipeline",
    "implement and review",
    "full review",
    "spec compliance",
    "quality review",
    "verification",
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
params:
  implementer_model:
    { type: "string", default: "sonnet", description: "Model for the implementer subagent." }
  spec_reviewer_model:
    { type: "string", default: "haiku", description: "Model for the spec-compliance reviewer." }
  quality_reviewer_model:
    {
      type: "string",
      default: "opus",
      description: "Model for the quality reviewer — ideally a different model family than the implementer to avoid correlated blind spots.",
    }
---

# Three-agent code review (implement, spec-verify, quality-review)

> Build → spec-verify → quality-review pipeline using three sequential
> subagents. The pipeline's soul: the spec reviewer is explicitly instructed
> to DISTRUST the implementer's report and verify against the actual code.

## Goal

Implement a task with high first-time quality using three sequential
subagents: implementer, spec reviewer, quality reviewer. The orchestrator
never takes any subagent's word for it — final verification is run by hand.

## When to Use

- Multi-file implementation tasks
- Features where correctness matters more than speed
- Work that will be submitted as a PR

## Steps

### 1. Prepare task brief

**Done when:** A complete task description exists with context, file paths,
and explicit acceptance criteria.

Read the relevant code first. The brief must be self-contained — the
implementer subagent sees nothing but what you hand it.

### 2. Dispatch implementer

**Done when:** The subagent returns with an implementation report.

Subagent ({{implementer_model}}): must implement, write tests, run tests,
self-review, and commit. Its report is treated as a CLAIM, not a fact.

### 3. Dispatch spec reviewer

**Done when:** Spec compliance is confirmed, or a concrete issues list exists.

Subagent ({{spec_reviewer_model}}). Critical instruction, verbatim:
"DO NOT trust the implementer's report." It must read the actual code and
compare it to the requirements line by line. If issues are found, send them
back to the implementer and repeat from step 2.

### 4. Dispatch quality reviewer

**Done when:** Code quality is approved.

Subagent ({{quality_reviewer_model}}) — ideally a different model family than
the implementer to avoid correlated blind spots. Only dispatches AFTER spec
compliance passes. Checks patterns, tests, dead code, over-engineering.

### 5. Final verification

**Done when:** The full test suite passes with evidence you saw yourself.

Run verification yourself, in your own session. Don't trust any subagent's
claim — not the implementer's, not the reviewers'.

## Constraints

- Sequential dispatch — never parallel; each stage gates the next.
- Each subagent is a separate spawn with its own clean context.
- The spec reviewer MUST be told not to trust the implementer.
- Quality review only runs after spec compliance passes.
- If the implementer needs 3+ rounds, stop and reconsider the task scope
  instead of dispatching a fourth round.

## Safety Notes

- Reviewers get read/grep/exec-for-tests only; no commit or deploy tools.
- The orchestrator owns the final verdict; subagent reports are advisory.

## Failures Overcome

- **Trusting reports:** Implementer says "all tests pass" but had failures.
  Spec reviewer catches by running independently.
- **Rubber-stamping:** Explicit "DO NOT trust" instruction prevents reviewer
  passivity.
- v1.0 resurrected 2026-06-13 from commit a239df31a4^ (old `recipe/1.0`
  schema → `kit/1.0` skeleton; hardcoded "gpt" quality reviewer genericized
  to {{quality_reviewer_model}}).
