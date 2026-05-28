---
schema: "kit/1.0"
slug: "completeness-critic"
title: "Completeness Critic"
summary: "Find what's missing — requirements, edge cases, and silent gaps in a deliverable"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["analysis", "completeness", "what's missing", "gaps", "did I miss", "coverage", "critic"]
tools: ["read", "grep", "glob"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
  notes: |
    Enumerate stated requirements (0) first. Then two parallel gap hunts: 1 =
    requirement-coverage gaps (each stated requirement → is it addressed?), 2 =
    unstated/implicit gaps (edge cases, error paths, missing inverse operations).
    Prioritize (3) merges both into a ranked gap list. 0-indexed.
model:
  provider: "anthropic"
  name: "claude-sonnet-4-6"
  hosting: "cloud API"
---

### 1. Enumerate the requirements

List every explicit requirement the deliverable was supposed to satisfy (from
the spec/prompt). Number them R1..Rn. Done-note: "REQUIREMENTS: R1=…, R2=…, …".

### 2. Requirement-coverage gaps

For each R1..Rn, locate the part of the deliverable that satisfies it (file:line
or section). Mark each COVERED, PARTIAL, or MISSING. Done-note: a compact map
"R1=COVERED, R2=PARTIAL(reason), R3=MISSING".

### 3. Unstated / implicit gaps

Ignore the stated list. Hunt for gaps the spec didn't name: unhandled error
paths, missing inverse/cleanup operations, untested edge inputs (empty, max,
concurrent), absent docs. Done-note: the top implicit gaps found.

### 4. Prioritize the gap list

Merge steps 2 and 3 into a single ranked list, highest-impact first, each with a
one-line "why it matters" and the cheapest fix. Done-note: the ranked gap list
(or "no material gaps found").
