---
schema: recipe/1.0
id: paper-figures
title: Paper Figures
category: writing
summary: Generate or revise a paper's figure set as D2 diagrams in the house J-series palette, render to PNG, and wire them into the markdown with captions — so every paper's figures look alike
triggers:
  [
    revise diagrams,
    create diagrams,
    paper figures,
    render figure,
    diagram-suggestions,
    "make the figures",
    synthesis diagram,
    redraw figure,
  ]
effort: medium
tools: [read, grep, glob, exec, edit, write]
children: []
---

## Goal

Produce a paper's figures as **D2** source diagrams rendered to `images/fig-*.png`, in one consistent visual language, and embed them in the markdown with proper captions. Seeded by the per-paper `diagram-suggestions.md` and the J-series color palette so figures are regenerable and uniform across papers.

## When to Use

- A paper references figures that do not exist yet, or its figures are stale after a content reframe.
- The user asks to "revise the diagrams" or "create a synthesis diagram".
- Before {{compile-paper}} when the build would otherwise emit `\includegraphics` for missing files.

Not for: one-off marketing graphics, photographic assets, or charts better served by matplotlib (use a Python step for plots; this recipe is for architecture / flow / concept diagrams).

## Canonical references

- Diagram intentions + per-figure spec: the paper folder's `diagram-suggestions.md`.
- House palette (from `{{papers_blueprint}}`): blue = storage, green = processing/coordination, orange = input, purple = output/authority, red = security/clearance. J-series print tints: umber `#5A3E28`, olive `#4A5D1A`, purple `#6B5090`, parchment `#faf7f1`.
- Renderer: `d2 --layout dagre|elk --pad 40 <src>.d2 images/<name>.png` (dagre for clean top-down tiers; elk when many cross-cutting edges).

## Steps

### 1. Inventory

**Tools:** read, glob
**Done when:** Each figure referenced by the `.md` is matched to a `diagram-suggestions.md` entry and a target `images/<name>.png`

Grep the paper for `![...](images/...)`. Read `diagram-suggestions.md`. Produce a list of figures to (a) create fresh, (b) revise (content changed), (c) leave.

### 2. Author D2 source per figure

**Tools:** write
**Done when:** A `diagrams/<name>.d2` exists for each figure, using the house palette

One `.d2` per figure under `diagrams/`. Conventions that avoid the common failures:

- **Quote any label** containing `()`, `[]`, `"`, or `:` — D2's parser breaks on unquoted special chars (`unexpected text after unquoted string`).
- `stroke-width` must be an **integer** 0–15 (not `1.5`).
- Use a `text`-shaped title node with explicit `width:` rather than a markdown `# title` block, which D2 sizes too narrow and truncates.
- Give floating annotations (`legend`, `ladder`) an explicit `width:` so they wrap instead of clipping at the canvas edge.
- Keep the figure self-sufficient but DON'T duplicate the paper's caption inside the image — the markdown supplies the caption.

### 3. Render and visually verify

**Tools:** exec, read
**Done when:** Each PNG renders exit-0 AND has been _looked at_ (Read the PNG), confirming no spaghetti, truncation, or staggered tiers

Render each. **Always open the PNG and inspect it** — a clean compile is not a clean diagram. If tiers stagger (back-edges distorting rank), switch `--layout dagre`. If the layout is a hairball, switch `--layout elk` or reduce edges. Re-render until it reads.

### 4. Wire into the markdown + mirror sources

**Tools:** edit, write, exec
**Done when:** Each figure has a `![Figure N. <caption>](images/<name>.png)` at its referenced section; PNGs + `.d2` sources live in the paper's canonical folder

Insert figure references with descriptive captions at the right sections. Copy both the rendered PNGs (`images/`) and the D2 sources (`diagrams/`) into the **canonical** paper folder so the source-of-truth markdown renders self-contained, and into the build folder so {{compile-paper}} embeds them.

## Constraints

- One consistent palette across all figures — do not invent per-figure color schemes.
- Figures are DRAFTS until the user reviews them; never publish a paper on unreviewed figures.
- Do not duplicate the in-paper caption inside the image.
- Verify visually (Read the PNG) before claiming a figure done — this is non-negotiable.

## Safety Notes

- Rendered figures may misrepresent the paper's intent; treat as drafts for review.
- A bulk rename in the paper (e.g., agent-name convention change) can leave figures stale — regenerate, don't hand-patch the PNG.

## Failures Overcome

- **Unquoted-label parse error:** D2 fails on `(`/`[`/`:` in bare labels — quote the label.
- **Fractional stroke-width:** `stroke-width: 1.5` is rejected; use integers.
- **Truncated title/legend:** markdown title blocks and unwidthed annotations clip at the canvas edge — use a `text` node with `width:`.
- **Staggered tiers:** upward/back edges distort ELK ranking; `dagre` gives clean top-down tiers for hierarchies.
- **Clean-compile ≠ clean-diagram:** a figure that compiled exit-0 can still be a hairball — the visual-verification step is mandatory.
