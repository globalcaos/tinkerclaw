---
schema: recipe/1.0
id: brainstorm-gate
title: Brainstorming Gate
category: analysis
summary: Explore, ask, propose, approve — mandatory design phase before building
triggers: [brainstorm, design, before building, new feature, how should we, approach, architecture]
effort: standard
tools: [read, grep, glob, web_search]
children: []
---

## Goal
Prevent wasted work by requiring design discussion and approval before any creative or architectural work.

## Steps

### 1. Explore
**Tools:** read, grep, glob
**Done when:** Understand relevant codebase, constraints, prior art

### 2. Ask
**Done when:** All ambiguities resolved
One question at a time, prefer multiple choice.

### 3. Propose
**Done when:** 2-3 approaches with trade-offs and a recommendation

### 4. Approve
**Done when:** the user confirms an approach
"What do you think?" is a design gate, not a rhetorical question. Do NOT start building.

### 5. Transition
**Done when:** Implementation begins with approved approach
Move to plan, feature, or three-agent-review recipe.

## Constraints
- EVERY creative task gets a design (scale it, don't skip it)
- Do NOT start implementation during brainstorming
- Cap at 2-3 approaches with clear recommendation

## Failures Overcome
- **Building the wrong thing:** Ask+propose+approve catches wrong directions before code.
- **Skipping for "simple" tasks:** Every project gets a design. Scale it, don't skip it.
