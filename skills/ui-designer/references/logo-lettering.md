# Logos, wordmarks and custom lettering

**What this is for.** Designing or redesigning a mark: symbol, wordmark, or both.
**How it was made.** Condensed from the web sources at the bottom on 2026-10-01, plus what a real
redesign the same day taught.
**What changes it.** A rule that failed in a real job, or a better-sourced number.

## Parts and the responsive set

- **Symbol** (isotype): the picture. **Wordmark** (logotype): the name as drawn letters.
  **Lockup** (imagotype): both together.
- Plan the set from the start: full lockup for large sizes, wordmark alone for tight horizontal
  spaces, symbol alone for favicons and app icons (16–48 px).
- A manual that says the wordmark never appears without the symbol wins over this default.

## Building custom letters

1. Fix the skeleton first: cap height, stroke weight, the module (the repeated unit), one angle
   for every diagonal, one family of corner radii, one gap width.
2. Build letters from shared parts, like Lego: the bowl of R reused in P and B, the arm of K at
   the A's angle. A letter that needs a new part is a warning sign.
3. Sketch the whole word before polishing one letter. Letters live next to their neighbours.
4. Start with the letters the word actually uses. Check the hardest pair first (AV, LT, RA).
5. Spacing is about area, not distance. Round letters sit closer than straight ones, and two
   straight stems need the most room. Set it by eye on the whole word, at several sizes.

A wordmark that must stay in the family of an existing one: measure the existing letters and
keep those constants (cap height, stroke, angle). Change the construction rules, not the
proportions, and the family resemblance survives.

### Building letters in code

A method that works: draw each letter as a centre-line skeleton (polylines with rounded or
chamfered corners), thicken it into an outline with shapely `buffer(stroke/2, cap_style="flat",
join_style="mitre")`, union the strokes, clip to the band between cap line and baseline, and
place each letter at a measured distance from its neighbour (scaled down for round edges, up
for straight ones). Monoline is then guaranteed. Two traps, both seen on 2026-10-01:

- **Two corners on one side need room.** Each corner radius must be under half the side they
  share, or the curve starts before the last one ends and the outline folds back on itself (a
  half-height S whose corners overlap turns into an S tangled with a box).
- **Stroke ends must run well past the trim.** A flat cap is square to the stroke, so on a
  diagonal it is tilted. End every diagonal at least three strokes beyond the baseline or cap
  line, along its own direction, before clipping; otherwise the tilted cap pokes back into view
  as a small flare at the foot.
- Thin the horizontals by building the letters taller and squashing them back (y × 0.93): the
  verticals keep their width and the curves blend between the two.

## What reads as high-tech, and why

- **Superellipse curves** (the squircle): rounded rectangles instead of circles. Microgramma
  (1952) and Eurostile (1962) made it the grammar of space-age and sci-fi type. They looked like
  television screens and control panels. It is the fastest way to make a sans feel machined.
- **Wide, extended proportions:** stable and authoritative, the look of hull lettering.
- **Monoline:** one stroke weight everywhere. Reads as precise and engineered.
- **Built, not drawn:** letters made from a few repeated modules on a grid. AI and robotics brands
  favour this because the rhythm is easy to recognise.
- **Controlled cuts:** stencil breaks, a slit through a stroke, a chamfered corner. One rule,
  applied the same way everywhere. Random breaks read as damage.
- **Horizontal emphasis:** horizontal gaps, speed cuts and long bars read as motion and scan
  lines. Use one horizontal device, not three.
- **Negative space doing work:** a shared stroke between two letters, a counter that forms a
  shape. It rewards a second look.

## How "techy" goes cheap

- An unedited stock "futuristic" font. Everyone can buy it.
- Circuit traces, glows, lens flares, gradients and swooshes added as decoration.
- Several tricks at once: chamfers plus slits plus inline plus italics. Pick one idea.
- Letters that stop being letters. Three bars can read as ≡ instead of E. Ask a cold reader.
- Detail that only exists at poster size and turns to mush at 32 px.

## Optical corrections (with numbers)

- **Overshoot:** round shapes 1–3 % above and below the flat lines; pointed apexes 2–5 %.
  A circle exactly as tall as a square looks smaller.
- **Horizontal strokes** about 90–95 % of the vertical stroke, or they look heavier.
- **White on dark** looks 5–8 % fatter (irradiation). The inverse file can be 5–10 % lighter.
- **Centring a triangle** in a box: shift it 5–8 % towards the point, or use the centre of
  its inscribed circle.
- **Joins and crotches** (where a diagonal meets a stem) fill in at small sizes. Thin them, or
  cut a small notch (an ink trap).
- **Measured equal is not seen equal.** Adjust by eye, then confirm with the tests below.

## Tests before showing anything

- **Sizes:** 16 and 32 px (the symbol), about 120–160 px wide (a site header), 400 px, and large.
- **One colour:** all black on white, all white on black. It has to work by form alone.
- **Inverse:** positive and negative side by side. The negative must not look heavier.
- **Squint:** step back two or three metres, or drop to 40 % opacity. Misalignment still shows.
- **Blur:** a 3–5 px Gaussian blur. Letters that merge unevenly have uneven spacing.
- **Cold read:** what does it say? Ask someone, or a model that has not seen the brief.

`scripts/proof_sheet.py` runs the first, second and fifth tests in one PNG.

## Deliverables

- Outlined SVG with a tight viewBox and named groups (`symbol`, `wordmark`, …) so a designer
  can recolour one part in a click. No live text, no fonts.
- Every colourway the brand manual accepts, plus one colour black and white.
- Clear space and minimum size stated (many manuals: clear space = half the cap height).
- The responsive set (lockup, wordmark, symbol) when the mark will live on small screens.
- The generator script next to the files, so a later change is a parameter, not a redraw.
- A proof sheet and a short rationale: the idea, why it fits the brief, what is still open.

## Sources (read 2026-10-01)

- [Optical corrections every logo designer should know](https://logogeek.uk/logo-design/optical-corrections/)
- [The definitive guide to optical corrections](https://insightadv.it/en/blog/perche-il-tuo-logo-perfetto-sembra-storto-la-guida-definitiva-alle-correzioni-ottiche)
- [How to make a modular typeface (Glyph Drawing Club)](https://blog.glyphdrawing.club/how-to-make-a-modular-typeface-with-glyphs-for-glyph-drawing-club/)
- [Design process behind two geometric typefaces (Rich McNabb)](https://richmcnabb.com/design-process-geometric-typefaces/)
- [What makes a futuristic font work (Studio 2AM)](https://studio2am.co/blogs/news/what-makes-a-futuristic-font-work-a-practical-guide)
- [Eurostile](https://en.wikipedia.org/wiki/Eurostile) and [Microgramma](<https://en.wikipedia.org/wiki/Microgramma_(typeface)>)
- [Futuristic fonts for logos (Graphic Design Junction)](https://graphicdesignjunction.com/2026/01/best-futuristic-fonts-for-logos/)
- [Logo scalability test (Lumance)](https://lumance.ai/blog/logo-scalability-test-how-to-check-if-your-logo-works-at-any-size)
- [Logo scalability (logodesign.net)](https://www.logodesign.net/blog/logo-scalability/)
- [Wordmark logos 101 (Dribbble)](https://dribbble.com/stories/2019/10/01/wordmark-logos-101-why-and-when-to-use-them)
