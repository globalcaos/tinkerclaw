---
schema: "kit/1.0"
slug: "compose"
title: "Compose"
summary: "Thread a value through a pipeline of sub-kits — each step's typed returnValue feeds the next (no compose-specific runtime)."
tags: ["combinator", "control-flow"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
---

# Compose

## Steps

### 1. Plan

out: {"type":"object","properties":{"kit1":{"type":"string"},"kit2":{"type":"string"},"seed":{}},"required":["kit1","kit2"]}

Name the two kits to compose (`kit1` then `kit2`) and an optional `seed` input.

### 2. First

out: {"type":"object"}
in: [{"name":"seed","from":"steps.1.out.seed"}]
uses: {{steps.1.out.kit1}}

Run the first kit on the seed. Its typed returnValue becomes this step's output,
available to the next step via steps.2.out.

### 3. Second

out: {"type":"object"}
in: [{"name":"prev","from":"steps.2.out"}]
uses: {{steps.1.out.kit2}}

Run the second kit on the first kit's returnValue. Its returnValue is the
pipeline's final output.
