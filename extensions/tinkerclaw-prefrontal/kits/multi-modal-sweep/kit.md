---
schema: "kit/1.0"
slug: "multi-modal-sweep"
title: "Multi-Modal Sweep"
summary: "Inspect a problem through multiple independent lenses in parallel, then converge"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["analysis", "sweep", "lenses", "perspectives", "look at it from", "angles", "triangulate"]
tools: ["read", "grep", "glob", "bash"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1, 2, 3, 4]
    - [5]
  notes: |
    Frame the subject (0) first. Then four independent lenses sweep in parallel:
    1 = code/static lens, 2 = runtime/behavioral lens, 3 = data/state lens, 4 =
    docs/intent lens. Converge (5) triangulates findings and surfaces the lenses
    that AGREE (high confidence) vs CONFLICT (needs resolution). 0-indexed. This
    is a single fan-out of four lenses, not a loop.
model:
  provider: "anthropic"
  name: "claude-sonnet-4-6"
  hosting: "cloud API"
---

### 1. Frame the subject

State the subject under inspection and the question each lens must answer about
it. Done-note: "SUBJECT: <x>. QUESTION: <q>".

### 2. Code / static lens

Inspect only the source: structure, call sites, types, invariants. Cite
file:line. Done-note: the 1-3 key static findings.

### 3. Runtime / behavioral lens

Inspect only observed behavior: run a probe/test/log grep and report what
actually happens. Done-note: the 1-3 key behavioral findings + the command run.

### 4. Data / state lens

Inspect only persisted state and data shapes: config files, stores, schemas,
on-disk artifacts. Done-note: the 1-3 key state findings + paths.

### 5. Docs / intent lens

Inspect only documentation and stated intent: bible optics, READMEs, comments,
commit messages. Done-note: the 1-3 key intent findings + references.

### 6. Converge

Triangulate the four lenses. List findings the lenses AGREE on (high confidence)
and any CONFLICTS between lenses (needing resolution). End with the single most
load-bearing conclusion. Done-note: agreements, conflicts, and the conclusion.
