# Screens, pages and interfaces

**What this is for.** Designing or judging a UI: a page, a dashboard, an app screen, a deck slide.
**How it was made.** Condensed on 2026-10-01 from the web sources at the bottom and from three
published design skills (`frontend-design`, `claude-designer`, `brand-identity-design`).
**What changes it.** A rule that failed on a real screen, or a better-sourced number.

## Plan before code

Write a small token plan and check it against the brief before building:

- **Colour:** four to six named hex values, brand palette first. Extend with `oklch()` so new
  shades stay in tune. Never invent brand colours.
- **Type:** one family with several weights, or two clearly different families. Name each role.
- **Layout:** one sentence plus an ASCII wireframe. Say how things align.
- **The one memorable thing:** where the boldness goes. Everything else stays disciplined.

If any part of the plan is what you would produce for any similar page, change it and say why.

## Hierarchy

- One focal point per screen. Scale, weight, contrast and position decide what is read first.
- Headings bold (600–800), body regular (400). Size steps that are clearly different, such as
  12 / 14 / 16 / 20 / 24 / 32.
- Structure carries meaning. Numbers like 01 / 02 / 03 only when the content really is a
  sequence.

## Spacing and layout

- A 4 or 8 px scale for every margin, padding, gap and size. Values must look different from
  each other.
- Inner space is never larger than outer space: a card's padding is at least the gap between
  the things inside it.
- Related things sit closer. Space shows what belongs together.
- Text left-aligned. Centre only to draw attention to one thing.
- Lines under about 80 characters. Line height about 1.4–1.6 for body text.
- Touch targets at least 44–48 px.

## Colour and contrast

- Text contrast at least 4.5:1 (WCAG AA), 3:1 for large text and UI parts.
- Colour is never the only signal. Add a label, an icon or a position.
- Check dark mode on purpose. Light type on dark looks heavier.

## Motion

- One orchestrated moment beats effects scattered everywhere.
- Motion that answers the user (open, expand, confirm) shows what changed. Respect reduced motion.

## Words in the interface

- Name things the way users think of them, not the way the system is built.
- Buttons say what happens ("Save changes", not "Submit"), and the action keeps its name through
  the flow.
- Errors say what went wrong and how to fix it. Empty states invite the next step.
- Sentence case, plain verbs, no filler.

## Tells of generated design

Fine when the brief asks for them, generic when they turn up on their own:

- A cream background with a serif headline and a terracotta accent.
- Near-black with one acid-green or vermilion accent.
- Everything chopped into identical rounded cards with the same soft grey shadow.
- A tracked ALL-CAPS label above every heading. Middle dots joining meta strings. Arrows on every
  link.
- Purple-to-blue gradients, glassmorphism everywhere, floating orbs and particles.
- Inter, Roboto or system-ui picked by reflex. A centred hero with a muted subtitle and two
  buttons.
- Fade-and-slide on every section. Emoji in interface copy.

## Options and review

- Show at least three options that differ in more than colour: conventional, bolder, a new idea.
- Purely visual options go side by side on one canvas with labels.
- Screenshot at mobile and desktop widths and look at both. Check keyboard focus and the console.
- Before handing over, take one thing away.

## Sources (read 2026-10-01)

- [Layout and spacing (learnvisual.design)](https://learnvisual.design/layout-spacing)
- [Spacing best practices (Cieden)](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices)
- [The 8-point grid, a practical guide (Breakdance)](https://breakdance.com/the-8-point-grid-system-a-practical-guide/)
- [Visual hierarchy in UI design (Timothy Graf)](https://timgraf.com/ui/visual-hierarchy-in-ui-design-mastering-scale-contrast-and-depth-for-2026-interfaces/)
