---
schema: recipe/1.0
id: visual-feedback-loop
title: Visual Feedback Loop
category: operations
summary: Render any HTML/SVG/UI to a PNG you can actually SEE, then iterate visual edits against the real render instead of guessing
triggers:
  [
    visual,
    "looks off",
    "doesn't look right",
    screenshot,
    render,
    "see it",
    svg,
    overlay,
    position,
    "conform",
    "areas",
    marker,
    layout,
    "not quite",
    iterate visually,
  ]
effort: standard
tools: [exec, read, edit]
script: ~/.openclaw/jarvis-workspace/scripts/visual-feedback.mjs
---

## Goal

Close the loop on visual work. Never ship a visual edit you have not SEEN
rendered. Replace "I think the HTML contains X" (a simulation) with "here is
the actual rendered pixels" (ground truth), and iterate against that.

## When to Use

- Positioning/sizing overlays, SVG regions, markers, hotspots on an image
- "It looks off / not quite / completely off" feedback on any rendered artifact
- Any change to a chart, diagram, card, or page where the SHAPE is the point
- Before declaring any visual task done — the render IS the verification

## Core Insight

The failure this prevents: editing an artifact, then previewing a _separate
reconstruction_ of what you believe you wrote. If the reconstruction and the
file drift, you tune the wrong thing for rounds. The fix: screenshot the REAL
file (image + SVG + CSS + JS), through a real browser engine.

## The Tool

`scripts/visual-feedback.mjs` — headless-Chrome screenshot wrapper.

```
node ~/.openclaw/jarvis-workspace/scripts/visual-feedback.mjs --html <file> [opts]
```

Key options:

- `--out <png>` output path (default `/tmp/vf-<name>.png`)
- `--width N --height N` viewport (set `--width 1696` to match an SVG viewBox so
  render px ≈ artifact coords → you can crop by the same numbers you edit)
- `--hide "<sel,sel>"` chrome away surrounding UI (header/panels/footer)
- `--tight` zero `.wrap/.container` padding for edge-to-edge
- `--show-regions` force ALL SVG region shapes visible at once (debug overlay) —
  the single most useful mode for checking shape conformance
- `--hot "<id>"` simulate hover: adds `.hot.locked` to `[data-j=id]` + `.dim` to
  `.fig` so you see the real hover/highlight state and its label
- `--crop "WxH+X+Y"` post-crop via ImageMagick
- `--grid N` overlay a labeled coordinate grid in ARTIFACT coords (offset-aware
  when combined with `--crop`) — render + crop + measure in ONE command

Then **Read the PNG** — that is the feedback. Iterate.

> Improvement note (v1.1, added after first use): `--grid` was folded into the
> tool because step 2 originally needed a separate ImageMagick pass each
> iteration. Render-and-measure is now a single invocation.

## Steps

### 1. Render the real artifact

**Tools:** exec, read
**Done when:** you have a PNG of the ACTUAL file open in front of you
Run the tool on the real HTML (not a copy you reconstruct). Read the PNG.

### 2. Measure against ground truth

**Tools:** exec
**Done when:** you can name each offset in real coordinates
Render at `--width <viewBox-width>` so render px ≈ artifact coords, then add
`--crop <area> --grid 50` in the SAME call to crop and lay a labeled grid over
the area under scrutiny. Now "the area is too high" becomes "move J8 from y298
to y270".

### 2b. Ground against an EXTERNAL reference (when correctness is domain-specific)

**Tools:** websearch, webfetch, exec, read
**Done when:** you have a labeled reference image beside your render
Your eye + the drawing is not enough when the RIGHT answer is a fact you can't
infer (anatomy, geography, a real product layout, a brand's true colors). Don't
place from memory — fetch the truth:

1. WebSearch a LABELED reference (e.g. Wikimedia Commons), WebFetch the file
   page to get the direct `upload.wikimedia.org` URL, `curl` it to `/tmp`.
2. `montage <reference> <your-render> -tile 2x1` into one side-by-side image and
   Read it. Align on a shared landmark (here: thalamus + corpus callosum), then
   map each element by ANALOGY to the labeled reference — not by guess.
3. Re-place, re-render, re-montage until the arrangement matches the reference.
   This is what turns "looks plausible" into "is correct".

### 3. Edit, re-render, compare

**Tools:** edit, exec, read
**Done when:** the render matches intent — not your memory of the edit
Make the smallest change, re-run the tool, Read the new PNG. Repeat. Use
`--show-regions` to see every shape, `--hot <id>` to verify hover + label.

### 4. Verify the state the user sees

**Tools:** exec, read
**Done when:** both rest and interactive states are confirmed
Static overlay ≠ what the user experiences. Render the rest state at real
opacity AND at least one `--hot` state before claiming done.

## Constraints

- Write the temp render-HTML in the SAME directory as the source so relative
  asset paths (images, fonts) resolve.
- Match `--force-device-scale-factor=1` and a fixed `--width` so coordinates are
  stable across iterations.
- The render is the verification artifact (Iron Law: evidence before "done").

## Failures Overcome

- **Simulation drift** — previewing a hand-rebuilt overlay instead of the file;
  fixed by screenshotting the real artifact.
- **Coordinate guessing** — eyeballing positions from a wide view; fixed by
  rendering at viewBox scale + gridded crops.
- **Rest-only checks** — shipping without seeing the hover/active state; fixed by
  `--hot` state simulation.
- **Plausible-but-wrong placement** — positioning domain elements (anatomy,
  geography, real layouts) from memory; fixed by fetching a LABELED reference
  and mapping side-by-side (Step 2b). "Looks right" ≠ "is right".

## Improvement log

- v1.1 — folded `--grid` into the tool (render+crop+measure in one call).
- v1.2 — added Step 2b: ground placement against an external labeled reference
  (web-fetched), side-by-side, when correctness is a domain fact not inferable
  from the artifact alone. Added after brain-region overlays kept being
  "plausible but anatomically off" until compared to a real limbic diagram.
