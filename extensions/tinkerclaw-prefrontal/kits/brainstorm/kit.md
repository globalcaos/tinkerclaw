---
schema: "kit/1.0"
slug: "brainstorm"
title: "Brainstorm"
summary: "Structured ideation — frame the problem, diverge, converge, evaluate"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["writing", "brainstorm", "ideas", "explore options", "what if", "ideate", "possibilities"]
tools: ["read", "grep", "glob"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "brainstorm | ideas | explore options | what if | ideate | possibilities",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: brainstorm, ideas, explore options, what if, ideate, possibilities",
    },
  ]
---

## Goal

Generate and evaluate multiple approaches to a problem before committing to one.

## When to Use

- Starting a new feature with multiple possible approaches
- Stuck on a problem and need fresh angles
- Evaluating architectural decisions
- Creative problem-solving sessions

## Steps

### 1. Frame

**Done when:** Problem statement is clear and bounded

Define what we're solving and why. Identify constraints (technical, time, resources). List what success looks like. Separate must-haves from nice-to-haves.

### 2. Diverge

**Tools:** read, grep, glob
**Done when:** At least 3 distinct approaches listed

Generate options without judging them. Look at how similar problems are solved elsewhere in the codebase. Consider unconventional approaches. Each option should be genuinely different, not variations of the same idea.

### 3. Converge

**Done when:** Each option evaluated against constraints

For each approach, assess:

- Feasibility: Can we build it with current tools and knowledge?
- Effort: How long? How many files touched?
- Risk: What can go wrong? What's the blast radius?
- Maintainability: Will this survive upstream merges? Is it testable?

### 4. Evaluate

**Done when:** Recommendation made with reasoning

Pick the best approach or combine strengths from multiple options. Justify the choice against the constraints. Identify risks of the chosen approach and mitigation strategies. Document rejected alternatives and why.

## Constraints

- No implementation during brainstorming -- ideas only
- Minimum 3 options before converging
- Every rejected option needs a reason
- The chosen approach must address all must-haves

## Safety Notes

- Don't anchor on the first idea -- force yourself through diverge
- Check if someone already solved this (grep the codebase first)
- Time-box brainstorming -- analysis paralysis is real

## Failures Overcome

- **Premature commitment:** Agent jumps to implementing the first idea without considering alternatives. The diverge step forces at least 3 options.
- **Fake options:** Agent lists 3 options but they're really the same idea phrased differently. Options must be structurally different approaches.
- **Unbounded exploration:** Agent keeps generating options without converging. Time-boxing and the 4-step structure prevent this.
