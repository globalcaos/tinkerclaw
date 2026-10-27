---
schema: recipe/1.0
id: deep-research
title: Deep Research (Skill Acquisition)
category: analysis
summary: Research a topic online to acquire a human skill, then apply it to a concrete task
triggers: [research, "learn about", "go online and research", "study", "acquire the skill", "find books and articles", "what does the literature say"]
effort: deep
tools: [websearch, webfetch, read, write, exec]
children: []
---

## Goal
Go from "I need to understand human skill X to do task Y" to a distilled, *applied* body of knowledge: first the gist of the skill on its own terms, then a concrete mapping of that skill onto the task at hand. The output is not a literature dump — it is operational guidance the requester (or a downstream model/recipe) can act on.

## When to Use
- A task needs a *human* competence the codebase can't supply — psychology, negotiation, pedagogy, partner dynamics, emotional regulation, "how to vibrate high."
- You want grounded, sourced knowledge (books, authors, papers), not a single LLM guess.
- The end goal is *application*: the research must terminate in "here is how this changes what we build/do."

## Steps

### 1. Scope & Requirements
**Done when:** The topic, the *task it serves*, and the acceptance bar are written down.

State three things explicitly: (a) the topic/skill to acquire; (b) the concrete task it must serve (e.g. "pair Jarvis's behaviour to the operator's detected emotional state"); (c) the requirements the findings must satisfy — what would make this research *usable* vs merely interesting. Everything downstream is filtered through (b) and (c). Capture any non-negotiable framing the requester gave (including non-mainstream frames — see Constraints).

### 2. Map the Areas
**Tools:** websearch
**Done when:** The topic is decomposed into its constituent areas, each tagged with how it fits the requirements.

Survey the topic broadly. Identify the distinct *areas* it covers — the sub-disciplines, schools of thought, and practical traditions. Do NOT go deep yet. For each area, write one line on what it is and whether/how it fits the task requirements from Step 1. Drop areas that don't serve the task; flag the ones that clearly do. This is the cheap breadth pass that prevents deep-diving the wrong sub-field.

### 3. Expand & Source
**Tools:** websearch, webfetch
**Done when:** Each kept area has named, locatable sources (books, authors, articles, papers) — not vague gestures.

Expand each retained area into concrete sources. Name the seminal books and their authors, the key articles/papers, the practitioners worth reading. Prefer primary and well-cited sources; note when a source is fringe/anecdotal so the reader can weight it. Aim for the *load-bearing* sources per area, not an exhaustive bibliography. This step parallelizes cleanly — one researcher per area (ultracode fan-out) when the area count is high.

### 4. Read & Distill the Gist
**Tools:** webfetch, read, summarize
**Done when:** Each source/area has a two-part distillation: (a) the gist of the human skill, (b) its application to the task.

Read the sources (full text where fetchable; high-quality summaries/reviews otherwise — say which). For each, produce TWO summaries, in this order:
1. **The gist** — what the skill actually *is*, in the source's own terms. The core mechanism, the practitioner's mental model, the moves that matter.
2. **The application** — how that gist maps onto the task from Step 1. Be concrete: a rule, a guide, a parameter, a behaviour. If it doesn't map, say so and drop it.

### 5. Synthesize & Apply
**Done when:** A single applied artifact exists — the research has *changed something* downstream.

Collapse the per-source distillations into one coherent body. Resolve contradictions between schools (name them; don't average them away). Produce the deliverable the task actually needs — a behaviour guide, a labeling rubric, a design spec, a mapping table. End with the explicit hand-off: "given this, do X." Research that doesn't terminate in an applied artifact is incomplete.

## Constraints
- **Application is the terminus, not an appendix.** Every kept finding ends in "so we should do Z." Drop findings that don't.
- **Honor the requester's frame, including non-mainstream ones.** If the task is framed in spiritual/energetic terms ("vibrate high," synchronicity, flow-as-magic), research it faithfully on its own terms AND in its nearest empirical analog (e.g. flow states, affect/productivity, arousal regulation). Bridge the two; don't dismiss the frame and don't abandon rigor — the bridge between physics and consciousness is shared territory, not a place to flinch.
- **Weight your sources, out loud.** Distinguish peer-reviewed, practitioner-tested, and anecdotal. The reader decides; you label.
- **Breadth before depth.** Step 2 maps cheaply before Step 4 reads expensively. Never deep-dive an area before confirming it fits the task.
- **Don't guess a URL.** WebSearch to find sources, then WebFetch the hit. Never fabricate a citation, author, or title — an invented source is worse than a gap.
- **Token-aware.** A wide topic = an ultracode fan-out (one agent per area in Steps 3–4). A narrow one runs inline. Flag the cost before a large fan-out.

## Safety Notes
- Cite sources so claims are checkable; never present an unverified summary as established fact.
- Mark fringe/unreplicated claims as such, especially when they will drive a behaviour change.
- Keep private context (the operator's task, data, finances) out of any outbound search query — research the skill, not the operator.

## Failures Overcome
- **Literature dump:** Agent returns an annotated bibliography with no application. Step 5's applied-artifact requirement forces the "so we should do Z" terminus.
- **Deep-diving the wrong area:** Agent reads a whole book in an area that doesn't serve the task. Step 2's cheap breadth-map + fit-tagging prevents it.
- **Frame-flinch:** Agent dismisses a spiritual/energetic framing as unscientific and silently substitutes its own. The constraint requires researching the requester's frame faithfully AND bridging to its empirical analog — honor and rigor, not one or the other.
- **Fabricated sources:** Agent invents plausible-sounding book/author/paper names. WebSearch-then-WebFetch and the no-fabrication rule make every citation locatable.
