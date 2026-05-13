---
schema: "kit/1.0"
slug: "write-paper"
title: "Write Paper"
summary: "Structured paper or article writing — outline, research, draft, review, polish"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["writing", "paper", "article", "write-up", "document", "spec", "publication"]
tools: ["read", "grep", "glob", "exec", "edit", "write"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "paper | article | write-up | document | spec | publication",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: paper, article, write-up, document, spec, publication",
    },
  ]
---

## Goal

Produce a well-structured, evidence-based document that communicates complex ideas clearly.

## When to Use

- Technical papers or articles
- Design specifications
- Architecture documents
- Research write-ups
- Blog posts or documentation

## Steps

### 1. Outline

**Tools:** write
**Done when:** Section structure with bullet points for each section

Define the thesis or central argument. Break into sections with clear purpose for each. Identify what evidence or examples each section needs. Set the target audience and tone.

### 2. Research

**Tools:** read, grep, glob
**Done when:** Evidence gathered for each section's claims

Gather supporting material. Read relevant code, docs, or prior work. Collect specific examples, data points, and references. Note gaps in knowledge that need filling.

### 3. Draft

**Tools:** write, edit
**Done when:** Complete first draft with all sections filled

Write each section following the outline. Don't self-edit during drafting -- get ideas down first. Use concrete examples over abstract descriptions. Include diagrams or tables where they clarify.

### 4. Review

**Tools:** read
**Done when:** Issues identified, revision plan clear

Read the draft critically. Check:

- Does each section serve the central argument?
- Are claims supported by evidence?
- Is the flow logical? Can a reader follow without backtracking?
- Are there redundancies or gaps?
- Is the tone consistent with the audience?

### 5. Polish

**Tools:** edit
**Done when:** Final version ready for delivery

Address review findings. Tighten prose -- remove filler words, shorten sentences. Ensure consistent terminology. Add cross-references between related sections. Final proofread.

## Constraints

- Outline before drafting -- don't start writing without structure
- Evidence before claims -- every assertion needs support
- One idea per paragraph
- No jargon without explanation (unless audience is known-expert)

## Safety Notes

- Don't include proprietary information without clearance
- Verify technical claims against actual code/docs
- Attribution for referenced work

## Failures Overcome

- **Stream of consciousness draft:** Agent writes without structure, producing a wall of text. The outline step prevents this by requiring section structure first.
- **Unsupported claims:** Agent makes technical assertions without checking code. The research step requires gathering evidence before drafting.
- **Infinite polish loop:** Agent keeps "improving" the same paragraph. Polish step is bounded -- address review findings, then stop.
