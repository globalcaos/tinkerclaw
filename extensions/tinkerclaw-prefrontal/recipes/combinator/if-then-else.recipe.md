---
schema: "kit/1.0"
slug: "if-then-else"
title: "If-Then-Else"
summary: "Run one of two sub-kits depending on a boolean condition (no combinator-specific runtime — pure when: + dynamic uses:)."
tags: ["combinator", "control-flow"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
---

# If-Then-Else

## Steps

### 1. Decide

out: {"type":"object","properties":{"cond":{"type":"boolean"},"thenKit":{"type":"string"},"elseKit":{"type":"string"}},"required":["cond","thenKit","elseKit"]}

Evaluate the branch condition and name the kit to run for each branch. Emit `cond`
(the boolean), `thenKit` (the kitRef to run when true), and `elseKit` (the kitRef to
run when false).

### 2. Then

when: steps.1.out.cond == true
uses: {{steps.1.out.thenKit}}

Run the then-branch kit. Its returnValue becomes this step's output.

### 3. Else

when: steps.1.out.cond == false
uses: {{steps.1.out.elseKit}}

Run the else-branch kit. Its returnValue becomes this step's output.
