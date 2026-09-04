---
schema: "kit/1.0"
slug: "composed-summarize-a-document-and-cite-sources"
title: "composed: summarize a document and cite sources"
summary: "Auto-composed from 2 stdlib skill(s) for: summarize a document and cite sources"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags: ["composed", "summarize", "a", "document", "and"]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
lineage:
  composedFrom: "compose"
  sourceQuery: "summarize a document and cite sources"
  composedSkills:
    ["dep-71e968be-b506-4a4c-99a8-da15218a801b", "dep-32788471-87cb-4488-baae-2d25d416c91e"]
---

# composed: summarize a document and cite sources

> Auto-composed from 2 stdlib skill(s) for: summarize a document and cite sources

## Steps

### 1. summarize-text

invoke skill: dep-71e968be-b506-4a4c-99a8-da15218a801b

Apply skill dep-71e968be-b506-4a4c-99a8-da15218a801b to the task.

### 2. web-search-and-cite

invoke skill: dep-32788471-87cb-4488-baae-2d25d416c91e

Apply skill dep-32788471-87cb-4488-baae-2d25d416c91e to the task.
