---
schema: "kit/1.0"
slug: "visual-correspondence"
title: "Visual Correspondence — two groups, lines between the matches"
summary: "Compare two lists that should line up (org roles vs KPI owners, features vs tests, requirements vs deliverables) as a two-column diagram with a line per match, so what is missing on EITHER side is visible at a glance."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "communication"
tags:
  [
    "visual",
    "diagram",
    "correspondence",
    "mapping",
    "bipartite",
    "compare two lists",
    "gap analysis",
    "which are missing",
    "draw lines between",
    "left and right",
    "match up",
    "crosswalk",
    "traceability",
    "coverage",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
---

# Visual Correspondence — two groups, lines between the matches

> Compare two lists that should line up as a two-column diagram with a line per match, so what is missing on EITHER side is visible at a glance.

## Goal

End the turn with a diagram IN the chat where the left column is group A, the right column is group B, every correspondence is a line, and the items with no partner are flagged on both sides and listed underneath. The picture answers "what don't we have yet?" and "what is not covered?" in one look.

## When to Use

- The request names two groups and asks which match, which are missing, or to "draw lines between".
- A gap analysis: roles vs KPI owners, requirements vs tests, a spec's sections vs the implementation, a price list vs a catalogue.
- A table would need two "not found" columns and still hide the one-to-many relations.

## Steps

### 1. Extract both groups from their sources, not from memory

**Done when:** each group is a list of items with a stable id, a display name and an optional one-line sub-label, and every item cites the file or system it came from.

Read the real artifacts (the document, the deck, the registry). A group recalled from conversation drifts; the diagram is only as honest as the extraction. Include items that exist only partially in a source (e.g. a box in an org chart that has no role card) and say so in their sub-label.

### 2. Decide the links and their kind

**Done when:** every link is `full` or `partial`, and every `partial` carries a short note naming what is not covered.

A one-to-many relation is several links from one item, not a merged box. `partial` is the most informative kind: it is where a match exists on paper but a sub-area has no partner (e.g. "I+D sense KPI").

### 3. Write the spec and render with the bundled generator

**Done when:** `render.py spec.json` produced an HTML fragment.

```
python3 recipes/visual-correspondence/render.py spec.json > fragment.html
```

Spec shape is documented in the script header. The generator keeps the left order you give (put the most important or hierarchical first) and orders the right column by the barycenter of its links, which removes almost all line crossings. It emits a static SVG with no JavaScript, so it renders inside sandboxed chat iframes, e-mail and print.

### 4. Look at it before claiming it

**Done when:** a screenshot was taken and viewed, and no label overlaps a line or box.

```
google-chrome --headless=new --window-size=980,860 --screenshot=/tmp/corr.png file:///path/page.html
```

A string match in the HTML does not prove the lines land on the right boxes.

### 5. Deliver in the chat, keep the files

**Done when:** the fragment is pasted in an `html-render` block on the chat surface that renders HTML (plain lists elsewhere), and the spec JSON + standalone HTML are saved next to the source document.

Below the diagram, state in words the two unmatched lists and the partial links; those are the answer, the picture is the proof.

## Constraints

- Two groups only. Three-way comparisons become two diagrams sharing the middle column.
- Keep sub-labels to one line; badges (right side) carry a status such as "5/6" or "no data".
- Do not invent a link to make the picture look complete. An honest unmatched item is the finding.

## Failures Overcome

- **Python 3.10 f-strings reject backslashes** inside `{}` expressions (2026-09-17): build attribute fragments like `stroke-dasharray` in a variable first.
- **First instance** (2026-09-17): a company's role cards vs its monthly KPI deck. The picture showed at once that the governance roles (Administrator, CEO) carry no KPIs and that Engineering existed only as an org-chart box without a role card.
