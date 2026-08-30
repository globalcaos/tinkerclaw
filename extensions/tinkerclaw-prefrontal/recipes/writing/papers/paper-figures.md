---
schema: recipe/1.0
id: paper-figures
title: Paper Figures
category: writing
summary: Generate or revise a paper's figure set — conceptual figures via napkin.ai, numeric charts via matplotlib — then harmonise the look through Nano Banana Pro and wire them into the markdown with captions, so every paper's figures look like one set
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
    hero image,
    figure style,
  ]
effort: medium
tools: [read, grep, glob, exec, edit, write]
children: []
---

## Goal

Produce a paper's figures at `images/fig-*.png` in ONE consistent visual language, and embed them in the markdown with proper captions. **Conceptual figures are drawn by napkin.ai; only figures that plot real numbers are drawn by code.** Seeded by the per-paper `diagram-suggestions.md` and harmonised against the J-series palette so the figure set reads as a set, not as six tools' defaults stapled together.

## When to Use

- A paper references figures that do not exist yet, or its figures are stale after a content reframe.
- The user asks to "revise the diagrams" or "create a synthesis diagram".
- A post needs a **hero/concept image** (see {{papers-staleness-audit}} — a first-page PDF screenshot is never an acceptable hero).
- Before {{compile-paper}} when the build would otherwise emit `\includegraphics` for missing files.

Not for: photographic assets or product screenshots.

## THE ROUTING RULE (the architect, 2026-08-02 — read this before drawing anything)

| Figure carries…                                                                         | Tool                                                     | Why                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| **Concepts** — architecture, flow, pipeline, cascade, hierarchy, taxonomy, hero/concept | **napkin.ai** (`napkin-diagrams` skill) — DEFAULT        | Publication-quality layout; matplotlib box-art looks homemade |
| **Real numbers** — benchmarks, time series, distributions, ablations, scaling curves    | `matplotlib` / `plotly` + the house style block (Step 4) | Napkin cannot plot data; a model would invent the values      |
| **Exact topology** Napkin refuses to honour, or Napkin unavailable                      | **D2** (fallback), TikZ only as last resort              | Deterministic edges when the picture must be literally exact  |

Matplotlib is the **exception, not the default**. If you are about to write a Python script to draw boxes and arrows, stop — that is a Napkin figure.

## Canonical references

- Diagram intentions + per-figure spec: the paper folder's `diagram-suggestions.md`.
- Napkin: `bash ~/.openclaw/jarvis-workspace/.claude/skills/napkin-diagrams/scripts/napkin-generate.sh --file <section.md> <out>.png --variations 4 --style formal-balanced`. Token in `~/.openclaw/credentials/napkin.env`. Feed it the FULL section (200+ words), never a summary. ~1 credit/word, 500/week free — budget it.
- Cohesion pass: `nano-banana-pro` (Gemini 3 Pro Image) edit mode — `uv run ~/.openclaw/jarvis-workspace/.claude/skills/nano-banana-pro/scripts/generate_image.py --prompt "<HOUSE STYLE PROMPT>" --filename <out>.png -i <in>.png --resolution 2K`. **Metered, paid tier only** — a free-tier key returns `429 limit: 0`; fire ONE call first to confirm the capability before batching N.
- **HOUSE STYLE PROMPT** (verbatim, every figure, so the whole set matches): _"Restyle this diagram in a calm academic print aesthetic: parchment `#faf7f1` background, umber `#5A3E28` primary strokes and text, olive `#4A5D1A` and muted purple `#6B5090` accents, thin even line weights, generous whitespace, one clean serif-free label font. Preserve EVERY label, box, and arrow exactly as-is — restyle only, never re-author, never add or remove elements."_
- Semantic palette (from `{{papers_blueprint}}`): blue = storage, green = processing/coordination, orange = input, purple = output/authority, red = security/clearance.
- D2 fallback renderer: `d2 --layout dagre|elk --pad 40 <src>.d2 images/<name>.png` (dagre for clean top-down tiers; elk when many cross-cutting edges).

## Steps

### 1. Inventory

**Tools:** read, glob
**Done when:** Each figure referenced by the `.md` is matched to a `diagram-suggestions.md` entry and a target `images/<name>.png`

Grep the paper for `![...](images/...)`. Read `diagram-suggestions.md`. Produce a list of figures to (a) create fresh, (b) revise (content changed), (c) leave. Tag each with its route from THE ROUTING RULE — conceptual, numeric, or exact-topology. Write the tag down; it decides the next two steps.

### 2. Generate — Napkin for concepts, code for numbers

**Tools:** exec, write
**Done when:** Every figure exists as a PNG, or is reported per-figure as `generation-failed` (one failure never aborts the run)

**Conceptual (the default path).** One Napkin call per figure, fed a **hand-authored STRUCTURED BRIEF** of 250–330 words — never a raw markdown section dump. This is the single highest-leverage detail in the recipe (learned the expensive way, 2026-08-02: raw section prose made Napkin fall back to a generic "Pros vs Cons" template, and it rendered two _different_ figures identically). The brief's shape:

- A plain title line, then the elements **explicitly enumerated and labelled** — `Risk 3, Provider employee access. Residual risk low. Mitigated by …`, `Rung 2, Contracted enterprise model. Removes … What remains … Cost paid …`.
- **No markdown syntax** — no `#` headings, no tables, no bold, no bullet characters. Plain declarative sentences.
- **Carry the caption's argument into the brief.** The figure's thesis lives in the caption, and the section prose often does not state it. If the caption says "six risks in three enforcement groups", the brief must name all six and all three.
- **Pull in what the tables hold.** Section tables usually ARE the figure's content; a text-only extract silently drops them and starves the engine.
- Working reference to copy the register from: `images/sec-trilemma.md` in any J-series paper folder.

Request `--variations 4`, then **look at all four** and pick the best. Cost is ~0.5 credit per brief word and is charged per REQUEST, not per variation — so always ask for 4; a re-run after a bad brief costs the whole request again. The figure's content must be self-contained: no sibling-paper names or codenames, no "this paper", no "Serra 202X" baked inside the image — describe adjacent mechanisms generically. Regenerate rather than reuse a PNG that happens to be on disk; stale images carry exactly the labels self-containment forbids, invisible to a text grep.

**Numeric.** Short `matplotlib`/`plotly` script in a temp file, PNG into `images/`. Apply the house style at the code level so the chart matches the Napkin set without ever going near an image model:

```python
plt.rcParams.update({
    "figure.facecolor": "#faf7f1", "axes.facecolor": "#faf7f1",
    "text.color": "#5A3E28", "axes.labelcolor": "#5A3E28",
    "xtick.color": "#5A3E28", "ytick.color": "#5A3E28",
    "axes.edgecolor": "#5A3E28", "axes.grid": True,
    "grid.color": "#5A3E28", "grid.alpha": 0.15,
    "axes.spines.top": False, "axes.spines.right": False,
})
# series colors, in order: umber, olive, purple
```

**Exact-topology / fallback.** D2 source under `diagrams/<name>.d2`. Gotchas that bite every time: quote any label containing `()`, `[]`, `"`, or `:`; `stroke-width` must be an **integer** 0–15 (not `1.5`); use a `text`-shaped title node with explicit `width:` instead of a markdown `# title` block (D2 sizes those too narrow and truncates); give floating annotations an explicit `width:` so they wrap instead of clipping.

Never duplicate the paper's caption inside the image — the markdown supplies it.

### 3. Cohesion pass — Nano Banana Pro

**Tools:** exec, read
**Done when:** Every CONCEPTUAL figure has been through one restyle call with the verbatim HOUSE STYLE PROMPT, or the pass is reported as skipped with a reason

Route each conceptual PNG through `nano-banana-pro` edit mode (`-i <in>.png`) with the HOUSE STYLE PROMPT verbatim. This is what makes six independently generated figures look like one paper's figures. Rules:

- **Smoke-test first.** One real call before batching N — the capability is billing-gated and a free-tier key fails only on the actual op (`429 limit: 0`), never on auth. Catching that wall costs one call, not N.
- **Never restyle a numeric chart through the image model.** It will silently redraw ticks, values, and axis labels — a corrupted chart that still looks plausible. Numeric figures get their cohesion from the rcParams block in Step 2, full stop.
- Compare before/after and **keep the better one**. A restyle that drops a label or re-authors an arrow is a regression: discard it and ship the Napkin original.
- Skipping the pass is acceptable (budget, credits, a one-off figure). Skipping it silently is not — say so in the report.

### 4. Visually verify

**Tools:** read
**Done when:** Every final PNG has been _looked at_, confirming no spaghetti, truncation, dropped label, or staggered tiers

Open each PNG and inspect it. A clean exit code is not a clean diagram — this applies to all three routes. Napkin: check the labels survived and the story reads. D2: if tiers stagger (back-edges distorting rank), switch `--layout dagre`; if it's a hairball, `--layout elk` or fewer edges. Re-generate until it reads.

### 5. Wire into the markdown + mirror sources

**Tools:** edit, write, exec
**Done when:** Each figure has a `![Figure N. <caption>](images/<name>.png)` at its referenced section; PNGs + `.d2` sources live in the paper's canonical folder

Insert figure references with descriptive captions at the right sections. Copy both the rendered PNGs (`images/`) and the D2 sources (`diagrams/`) into the **canonical** paper folder so the source-of-truth markdown renders self-contained, and into the build folder so {{compile-paper}} embeds them.

## Constraints

- **Conceptual figures go through napkin.ai. Matplotlib is for numbers only** — hand-drawn box-and-arrow plots are not an acceptable paper figure.
- One consistent look across all figures — the HOUSE STYLE PROMPT verbatim, no per-figure improvisation.
- The restyle pass may change **appearance only**. Any call that alters content is discarded, not patched.
- Figures are DRAFTS until the user reviews them; never publish a paper on unreviewed figures.
- Do not duplicate the in-paper caption inside the image.
- Verify visually (Read the PNG) before claiming a figure done — this is non-negotiable.

## Safety Notes

- Rendered figures may misrepresent the paper's intent; treat as drafts for review.
- Image models rewrite what they redraw. Anything load-bearing and numeric must never round-trip through one.
- Napkin and Nano Banana are both **metered** (credits / paid tier). Confirm capability with one call, then batch.
- A bulk rename in the paper (e.g., agent-name convention change) can leave figures stale — regenerate, don't hand-patch the PNG.

## Failures Overcome

- **Homemade-looking figures (2026-08-02):** matplotlib as the default figure tool produced box-art that read as a script's output, not a paper's figure. Napkin is now the default for anything conceptual; matplotlib is the numeric exception.
- **Raw section dump → generic template (2026-08-02, cost 664 credits):** feeding Napkin the paper's own prose made it emit a stock "Pros vs Cons" card — the SAME layout for two different figures, with nonsense entries ("Pros: subset exposure"). Structured briefs fixed all four on the next pass. "Feed the full section" from the skill doc is WRONG for papers; feed a brief.
- **Napkin cannot draw compound or curve-shaped figures (2026-08-02):** a two-panel figure (left: nested sets, right: the limit of the argument) lost a panel in all 4 variations; a diminishing-returns ladder came back as an ASCENDING staircase, arguing the opposite of its caption. When the caption says "the shape of the curve carries the argument", that figure is a plot — route it to matplotlib and do not bend the paper's claim to fit the prettier picture.
- **Six tools, six looks:** independently generated figures never matched. The verbatim HOUSE STYLE PROMPT restyle pass is what makes the set cohere.
- **Free-tier false confidence:** a Gemini key authenticates (HTTP 200 on `/models`) and still returns `429 limit: 0` on the real image call — tier gates only surface on the billable op. Smoke-test one call.
- **Thin Napkin prompts:** a summarised paragraph makes the layout engine invent relationships. Feed the full section.
- **Stale figure reuse:** a PNG on disk from an earlier pass routinely embeds sibling-paper names a text grep cannot see. Regenerate referenced figures; don't reuse.
- **Unquoted-label parse error (D2):** fails on `(`/`[`/`:` in bare labels — quote the label.
- **Fractional stroke-width (D2):** `stroke-width: 1.5` is rejected; use integers.
- **Truncated title/legend (D2):** markdown title blocks and unwidthed annotations clip at the canvas edge — use a `text` node with `width:`.
- **Staggered tiers (D2):** upward/back edges distort ELK ranking; `dagre` gives clean top-down tiers for hierarchies.
- **Clean-compile ≠ clean-diagram:** a figure that compiled exit-0 can still be a hairball — the visual-verification step is mandatory.
