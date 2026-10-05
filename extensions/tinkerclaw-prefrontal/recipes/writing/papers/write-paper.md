---
schema: recipe/1.0
id: write-paper
title: Write Paper
category: writing
summary: Structured paper or article writing — outline, research, draft, review, polish
triggers: [paper, article, "write-up", document, spec, publication]
effort: deep
tools: [read, grep, glob, exec, edit, write]
children: []
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

Shape the outline as a story before anything else: vision, claim, explanation, proof where possible, with an
abstract that opens on the vision (`adversarial-review-loop` § What a paper is).
Write the contributions list first (each refutable, each tied to the section that will prove it), then
an outline of one sentence per planned paragraph (Peyton Jones; Mensh & Kording, rule 9).

**Tools:** write
**Done when:** Section structure with bullet points for each section

Define the thesis or central argument. Break into sections with clear purpose for each. Identify what evidence or examples each section needs. Set the target audience and tone.

### 2. Research

**Tools:** read, grep, glob
**Done when:** Evidence gathered for each section's claims

Gather supporting material. Read relevant code, docs, or prior work. Collect specific examples, data points, and references. Note gaps in knowledge that need filling.

### 3. Draft

**Tools:** write, edit
**Done when:** Complete first draft with all sections filled, and every section whose argument is a flow, an architecture, a cycle, a taxonomy or a progression carries a figure reference (`![caption](images/fig-<name>.png)`) drawn by {{paper-figures}}

Write each section following the outline. Don't self-edit during drafting -- get ideas down first. Use concrete examples over abstract descriptions. Include diagrams or tables where they clarify.

Figures belong to the draft, not to the build. While drafting, list the sections that need one, write each Napkin brief to `images/briefs/<name>.md`, and run {{paper-figures}} (concepts through Napkin, numbers through matplotlib) before calling the draft done. {{compile-paper}} draws only the figures the draft already references, so a draft with no references ships with none.

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
- **A 34,000-word paper shipped with one figure (2026-10-03).** The AcmeVision temporal-network paper was drafted, reviewed and compiled with a single D2 drawing: no step asked for figures, and compile-paper found nothing missing because the draft referenced nothing. the architect: "Great work on the paper, but you forgot to inject in it napkin diagrams as our recipe calls for." Step 3 now plans the figures and runs paper-figures.
- **Infinite polish loop:** Agent keeps "improving" the same paragraph. Polish step is bounded -- address review findings, then stop.
