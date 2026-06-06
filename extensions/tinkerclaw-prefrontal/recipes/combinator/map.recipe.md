---
schema: "kit/1.0"
slug: "map"
title: "Map"
summary: "Run a worker kit once per element of an array, collecting each returnValue in order."
tags: ["combinator", "iteration"]
parallelism:
  groups:
    - [0]
    - [1]
---

# Map

## Steps

### 1. Produce

out: {"type":"object","properties":{"items":{"type":"array"},"worker":{"type":"string"}},"required":["items","worker"]}

Produce the array `items` to iterate over and name the `worker` kitRef to run for
each element.

### 2. Map

out: {"type":"array"}
map: steps.1.out.items
uses: {{steps.1.out.worker}}

Run the worker for each element. `{{item}}` and `{{index}}` are injected into the
worker's task text. Each worker's returnValue is collected, in order, into this
step's array output.
