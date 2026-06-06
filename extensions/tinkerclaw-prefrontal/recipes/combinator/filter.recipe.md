---
schema: "kit/1.0"
slug: "filter"
title: "Filter"
summary: "Keep the elements of an array that pass a keep: predicate (or a predicate-kit's truthy returnValue)."
tags: ["combinator", "iteration"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Filter

## Steps

### 1. Produce

out: {"type":"object","properties":{"items":{"type":"array"},"worker":{"type":"string"}},"required":["items","worker"]}

Produce the array `items` to filter and name a predicate `worker` kitRef whose
truthy returnValue keeps an element.

### 2. Filter

out: {"type":"array"}
filter: steps.1.out.items
uses: {{steps.1.out.worker}}

Run the predicate worker for each element (with `{{item}}`/`{{index}}` injected).
Keep, in order, the elements whose worker returnValue is truthy.
