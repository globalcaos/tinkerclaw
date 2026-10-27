---
schema: "kit/1.0"
slug: "print-diagram-fit"
title: "Fit every diagram to the printed page so its letters can be read"
summary: "For any document that is printed or read as a PDF: measure every diagram's printed label size and its share of the text width, then fix the two failures that make diagrams unreadable. A narrow diagram with small labels goes full width. A wide diagram whose labels shrink gets bigger type, a snake layout that wraps into rows, a split, or a landscape page. Ends with a measured table, not an opinion."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "writing"
subdivision: "figures"
tags:
  [
    "diagram too small",
    "diagram too wide",
    "unreadable diagram",
    "letters too small",
    "font too small",
    "full width",
    "snake layout",
    "wrap diagram",
    "print layout",
    "pdf figures",
    "d2 layout",
    "figure legibility",
    "manual diagrams",
    "book diagrams",
  ]
testedHarnesses: []
created: "2026-10-10"
---

# Fit every diagram to the printed page

**What it is for.** A diagram is read at the size it prints, not at the size it was drawn. A builder that
scales every figure to fit the column makes two kinds of unreadable figure, and both looked fine on screen.
**Derived from.** The owner's review of two 78- and 144-page technical books (2026-10-10): _"Some of them are
too small and narrow, and could use a full-width expansion so that the letters can actually be read. Other
diagrams are too wide and crammed into the horizontal space they can only be seen with very small font, not
readable. So either make the font a bit bigger or make the diagram wrap around like a snake, thus being able
to make use of all the page intelligently."_
**What would change it.** A measured run that shows a threshold below is wrong for a given paper size or
reader, or a builder that does the fitting by itself.
**Status.** First written 2026-10-10; first run recorded below (2026-10-10). Until more runs are recorded under
"Runs", treat the thresholds as a starting point.

## The numbers (A4 or Letter, read at arm's length)

- **Smallest label: 7 pt floor, 8 to 9 pt target** (7 pt is about 2.5 mm of cap-to-descender height).
  Body text is usually 10 to 11 pt; a label much smaller than the body is where readers give up.
- **Printed label size = label size in the drawing x (printed width / drawing width).** A 14 px label in a
  2400 px wide drawing printed 16 cm wide comes out at 14 x 160 / 2400 = 0.93 mm, unreadable. Compute it, do
  not eyeball it.
- **Usable aspect ratio in a portrait column: up to about 2.2 : 1 (width : height).** Wider than that, the
  scale factor needed to fit the width pushes the labels under the floor unless the drawing was made for it.
- **A narrow figure** is one that uses less than about 70 % of the text width while its labels print under
  8 pt: the builder is wasting space the reader needs.

## Steps

1. **Inventory, from the build, never from memory.** List every figure in the document: page, caption, the
   source file (D2, Mermaid, SVG, PNG), whether it is generated from code, and how the markdown sizes it
   (`width=`, a CSS class, nothing). Count them; the count goes in the report.
2. **Measure each one as printed.** For a vector PDF, read the text spans inside the figure's box with
   PyMuPDF (`page.get_text("dict")`, keep spans inside the image rectangle, take the smallest `size`); for a
   raster figure, render the page at 150 dpi (`pdftoppm -r 150`), measure the smallest label's pixel height
   and convert (px / 150 x 72 = pt). Record: printed width as a share of the text width, aspect ratio,
   smallest label in pt.
3. **Classify.** OK (labels at 7 pt or more), NARROW (under 70 % of the width and labels under 8 pt), WIDE
   (aspect over about 2.2 : 1 and labels under 7 pt), TALL (taller than the text block), DENSE (labels fine
   but too many crossings to follow: a design problem, not a print one).
4. **Fix NARROW: give it the page.** Set the figure to the full text width in the source markdown (pandoc
   `{width=100%}`, an HTML class the print CSS sizes to `width: 100%`), and stop the builder from capping it.
   If it then grows taller than the page, go to TALL.
5. **Fix WIDE, cheapest first:**
   - **Bigger type in the drawing.** Raise the label size in the source (D2: `style.font-size`, a global
     `vars`/theme override; Mermaid: `themeVariables.fontSize`) when only a few labels are small.
   - **Snake it.** A long left-to-right chain becomes rows that wrap: in D2, put the steps in a container with
     `grid-columns: 3` (or 4) so the chain folds into rows, or turn `direction: right` into `direction: down`
     and group each stage so the reading order stays obvious; draw the row-to-row link from the end of one
     row to the start of the next. In Mermaid, `flowchart TB` with subgraphs per row. A sequence diagram
     with many lifelines is split by phase instead (two diagrams, the second repeating the shared lifeline).
   - **Split** a diagram that shows two things (a pipeline and its configuration) into two figures.
   - **Landscape page** for a figure that is wide by nature (a timing diagram, a full pipeline graph) and
     must stay one piece: rotate that one page in the PDF build, keep the HTML version scrollable.
6. **Fix TALL:** split at a natural boundary, or let it take a page of its own with the caption under it.
7. **Rebuild and measure again.** Every figure must now be OK; any that is not is listed with why (a vendor
   picture you cannot redraw, say) and gets a zoomable link in the HTML edition.
8. **Look at it.** Render the changed pages at 70 dpi into one contact sheet and look at every one. A table
   of numbers that says OK over a figure nobody looked at is not done.
9. **Keep the generators honest.** When a figure is generated from code, put the size or layout rule in the
   generator, not in a hand edit of its output, so the next regeneration keeps it; extend the drift test if
   the project has one.

## Done when

The report holds one row per figure (page, source, width share, aspect, smallest label before and after,
class, fix), every row ends OK or has a reason, the changed pages were looked at, and the document was
rebuilt from its sources.

## Runs

| Date       | Document                                             | Figures           | Before: under 7 pt | After                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------- | ----------------- | ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | OrbisVision 2.0 Architecture + Use cases books (PDF) | 58 slots (52 + 6) | 41 of 45 + 6 of 6  | 18 of 52 + 2 of 6 (16 at 5.9-6.9 pt) | Two builder bugs did most of the harm: a 120 mm height cap on every figure and a non-wrapping table code span that made Chrome shrink whole pages (body 7 pt instead of 10.5). D2 at 18 px plus `direction: down`, grid-columns snakes, phase splits of sequence diagrams and named-`@page` landscape slots did the rest. Analytic label size (SVG font x printed scale) matched the PyMuPDF span size to 0.1 pt. Pages 96 to 208. |
