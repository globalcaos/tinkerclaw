---
schema: "kit/1.0"
slug: "judge-panel"
title: "Judge Panel"
summary: "Score an artifact against rubric criteria with independent judges, then aggregate"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["analysis", "judge", "rubric", "score", "evaluate quality", "grade", "panel"]
tools: ["read", "grep", "glob"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1, 2, 3]
    - [4]
  notes: |
    Define the rubric (0) first so all judges score the same axes. Three judges
    (1,2,3) score independently in parallel on the SAME artifact and rubric — no
    judge sees another's score. Aggregate (4) computes the panel verdict and
    flags any axis where judges disagree by >2 points. 0-indexed.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API"
---

### 1. Define the rubric

State the artifact under judgment and the scoring rubric: 3-5 named axes, each
scored 1-5, with a one-line definition of what a 5 vs a 1 looks like on that
axis. Done-note: the rubric as a compact list "axis: 1=… 5=…".

### 2. Judge A — correctness axis lead

Score the artifact on every rubric axis (1-5), but reason hardest about
correctness/accuracy. For each axis give the score + one-sentence justification.
Done-note: "JUDGE-A: axis1=N, axis2=N, … overall=N".

### 3. Judge B — completeness axis lead

Score the artifact on every rubric axis (1-5), reasoning hardest about coverage
and missing cases. For each axis give the score + one-sentence justification.
Done-note: "JUDGE-B: axis1=N, axis2=N, … overall=N".

### 4. Judge C — clarity/maintainability axis lead

Score the artifact on every rubric axis (1-5), reasoning hardest about clarity,
readability, and maintainability. Score + one-sentence justification per axis.
Done-note: "JUDGE-C: axis1=N, axis2=N, … overall=N".

### 5. Aggregate the panel verdict

Average each axis across the three judges. Report the panel score per axis and
overall. Flag any axis where the max-min judge spread is >2 (a contested axis
needing a human look). Done-note: "PANEL: overall=N.N; contested axes: <list or
none>".
