---
name: ui-designer
description: "Visual design for anything people look at: logos, wordmarks and custom lettering, brand marks and their colourways, icons, mascots and brand characters, UI screens, pages and dashboards, mockups and posters. Use when asked to design or redesign a logo or wordmark, to make something look more techie, modern, premium or futuristic, to build a visual identity or style variations, to design a UI or page, or to judge whether a design works. It starts from the brand's own manual and master files, explores several distinct directions, builds them as code (SVG or HTML), proves each one on a rendered proof sheet (sizes, backgrounds, one colour, blur) and delivers files with the reasons behind them. Not for charts (dataviz) or comparison tables (visual-tables)."
---

# UI Designer

**What this is for.** Getting from "make it look like X" to a design the owner can use, without
the two usual failures: a generic result that could belong to anyone, and a claim about how
something looks that nobody actually looked at.
**How it was made.** Web tutorials and three published skills, condensed on 2026-10-01 (sources
at the bottom), then used on a real logo redesign the same day.
**What changes it.** A design the owner rejects, a test that missed a defect he then saw, or a
better method found in the wild. Add it to Failures overcome with the date.

## The rule above taste

Look before you claim. "Reads at 16 px", "balanced", "works on dark": each needs a render you
viewed in this turn. Run `scripts/proof_sheet.py` on every candidate and open the PNG.

## Process

Scale it to the job. A colour tweak skips 3 and 4; a new mark runs every step.

1. **Brief.** One paragraph: what it is, who sees it, where it lives (smallest and largest size,
   screen or print, light or dark), what must stay, what the ask changes. Pick three to five
   personality words and place the work on four axes: classic ↔ modern, human ↔ tech,
   minimal ↔ rich, serious ↔ playful.
2. **Context before pixels.** Find and read the brand manual and the master files, from where the
   owner's marketing team keeps them, not a stray copy. Lift exact values (hex, angles, stroke,
   clear space). Write down what the manual forbids and where it leaves freedom, such as
   sub-brand colours or a digital palette.
3. **References.** Look at the category and at the style asked for. For each reference write the
   one thing it teaches. Name the gap: the look nobody nearby owns.
4. **Diverge.** At least three directions that differ in construction, not just colour: one by the
   book, one bolder, one built on a new idea, and optionally one that plays with negative space
   or rhythm. Each gets one line tying it to the brief.
5. **Build as code.** A parametric generator (Python to SVG, or HTML and CSS). Measure the
   constants from the existing assets: cap height, stroke, angles, radii. Logos ship as outlined
   paths, never as live text.
6. **Prove.** Proof sheet for every candidate: all sizes, all backgrounds, one colour, inverse,
   blur. Kill what fails. Show the survivors side by side.
7. **Converge and refine.** Optical corrections, spacing by eye, a consistency audit (same stroke,
   same angles, same radii, same gaps). Details in the references.
8. **Deliver.** Files in the owner's documents folder, never inside agent config; every colourway
   the manual accepts; an inline preview; the reasons in three to six plain sentences; the
   choices that are still his, named.

## Quality bar

- One memorable idea. Everything around it stays quiet.
- Works in one colour, at the smallest real size, and still holds together after a blur.
- A system, not a collection: shared stroke, angle, radius and gap.
- Someone who has never seen it can read the words.
- Not a template default. The generic tells are listed in `references/ui-fundamentals.md`.

## Files

- `references/logo-lettering.md`: logos, wordmarks, custom letters, the tech and futuristic
  vocabulary, optical corrections with numbers, tests, deliverables. Read it for any mark.
- `references/ui-fundamentals.md`: screens and pages. Hierarchy, spacing, type, colour, motion,
  copy, and the tells of generated design. Read it for any interface.
- `references/characters.md`: mascots and brand characters. Baby proportions with numbers, the
  cartoon register (one outline, one cel shade), palettes as roles, sticker edge for dark
  backgrounds, one-ink and lockup proofs. Read it for any character.
- `scripts/proof_sheet.py`: `proof_sheet.py a.svg b.svg -o proof.png --bg "#FFFFFF,#000000"
--widths 96,160,320,720`. Needs cairosvg and Pillow.

## Failures overcome

- 2026-10-01: a sub-brand logo took its colours from an old copy of the brand manual on the
  laptop. The marketing team's current manual had a new digital palette that answered the
  question. Step 2 now says where to read it from.

## Sources

Ideas paraphrased, with thanks:
`frontend-design` (Anthropic, Apache-2.0); `claude-designer` on ClawHub (@cced3000, MIT-0);
`brand-identity-design` on ClawHub (@fize, Apache-2.0). Web sources are listed at the end of each
reference file.
