---
schema: "kit/1.0"
slug: "adversarial-verify"
title: "Adversarial Verify"
summary: "Prove a claim true by trying hardest to prove it false"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["analysis", "verify", "adversarial", "double-check", "are you sure", "prove it", "red team"]
tools: ["read", "grep", "glob", "bash"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1, 2]
    - [3]
  notes: |
    State the claim (0) first. Then two independent adversaries attack it in
    parallel (1 = logical/spec attack, 2 = empirical/runtime attack). Verdict (3)
    reconciles both attacks into accept/refute/uncertain. 0-indexed.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API"
---

### 1. State the claim under test

Restate the exact claim to verify, in one sentence. Pin the success criteria:
what observable evidence would make it TRUE, and what would make it FALSE. Write
a 2-line done-note: "CLAIM: <claim>. TRUE-IF: <evidence>. FALSE-IF: <evidence>."

### 2. Logical / specification attack

Assume the claim is FALSE. Find the strongest logical or spec-level
counterexample: an input, edge case, or contradiction with documented behavior
that breaks it. Cite file:line or doc references. Done-note: the single
strongest counterexample found, or "no logical counterexample found".

### 3. Empirical / runtime attack

Assume the claim is FALSE. Construct and run the cheapest experiment that would
expose it (a probe command, a focused test, a log grep). Report observed output.
Done-note: the experiment + its result, or "no runtime contradiction observed".

### 4. Verdict

Reconcile steps 2 and 3. Return exactly one verdict on the first line —
VERIFIED, REFUTED, or UNCERTAIN — then the evidence that decided it. If
UNCERTAIN, state the one experiment that would resolve it. Done-note: the verdict
line + one-sentence justification.
