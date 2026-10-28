---
schema: recipe/1.0
id: status-board-hover
title: Status board with hover summaries in the Tinker chat
category: communication
summary: Show many items with several measures each (papers, projects, services, candidates) as one graphic table in the chat, grouped and colour-coded by subject, with KPI tiles, bars, stacked bars, status pills and a summary that opens when the mouse is over a name. Generated from a JSON spec and checked in the chat's own iframe wrapper before it is sent.
triggers:
  [
    status board,
    html table with mouseover,
    pretty table,
    graphic table,
    table with hover,
    description on mouseover,
    colour coded by subject,
    dashboard in chat,
  ]
effort: standard
tools: [exec, read]
---

## Goal

One table the owner reads at a glance: each row an item, each column a measure drawn as a bar, a stacked bar or a coloured pill, rows grouped under coloured subject headings, the key numbers as tiles on top, and a short description that appears on mouseover instead of a column of prose.

## When to Use

- A request for a table that is visual rather than prose, with descriptions on mouseover and rows colour-coded by subject.
- A status report over 8 or more items with 4 or more measures each.

Not for a short side-by-side of a few options: the `visual-tables` skill draws those inline. Not for WhatsApp, SMS or voice: the `html-render` fence only renders in the Tinker chat.

## Steps

### 1. Measure first, draw second

**Done when:** every number in the board comes from a command or a file read this turn, and each column states where its numbers came from.

A pretty board of guessed numbers is worse than a plain one. Gather the data, then write one line per column saying what it measures.

### 2. Write the spec

**Done when:** a JSON file holds `kpis`, `columns`, `groups` (name, colour, rows) and `legend`, in the shape of `example.json` in this folder.

Column types: `bar` (`value`, optional `extra` drawn hatched, e.g. "beta"), `stack` (`parts` as `[count, tone]`, tones `good` / `warn` / `bad` / `neutral` or a hex colour) and `pill` (`text`, `tone`). Each row has `id`, `name`, `sub` (a second name, e.g. a code name), `note` (a version) and `tip`: the mouseover text, two sentences at most.

### 3. Generate

**Done when:** `board.py spec.json > board.html` has run without error.

The output ends with a `<script>`. Keep it. See Failures Overcome.

### 4. Check it the way the chat draws it

**Done when:** `check.sh board.html <outdir>` prints OK and you have LOOKED at `full.png` and `hover.png`.

The check wraps the board in the same base styles the chat iframe adds (`htmlRenderFrame` in `tinker-ui/src/app.ts`), renders it at chat width, and forces one tooltip open. Fix what looks wrong and run it again. A board you have not looked at is not finished.

### 5. Send

**Done when:** the reply holds the board inside one ` ```html-render ` fence, plus a line saying where the numbers came from.

The file runs to tens of KB; paste it whole. Say it was checked in a simulated frame, not on the owner's screen.

## Constraints

- The fence must contain a `<script>`. Without one, the chat sanitises the block with DOMPurify and draws it inline, which drops the leading `<style>`: no classes, no hover, a plain table (`app.ts` `md()`, `/<script[\s>]/` test). Since develop `5f0eb22645e` (2026-10-12) a block with its own `<style>` also goes to the frame, but that ships only with the next Tinker rebuild and never reaches older installs: keep the script.
- The chat iframe forces `table-layout:fixed` and breaks words anywhere; `board.py` overrides both. Keep the override if you change the CSS.
- Tooltips on the bottom 40% of rows open upwards, so the frame (height-clamped 40–2000 px) does not cut them.
- Light text on the dark tooltip: a subject colour as the tooltip title is unreadable on brown.

## Safety Notes

Read only. It writes local files under the outdir you give it and sends nothing.

## Failures Overcome

- **2026-10-10, J-series status table, three tries.** Try 1 was loose cards, never rendered: "looks like crap". Try 2 was a real table, checked in a plain browser and sent with no `<script>`, so the chat stripped its `<style>`: "still not html-pretty with mouseover". Try 3 added the script and was checked inside the iframe wrapper: "better, save it as a recipe". The lessons: render before sending, and render the way the chat does, not the way a browser does.
- **The 09-19 memory note already named this trap**, and it bit again on 10-10: a text rule did not bind, so the routing moved into code (`5f0eb22645e`), and this recipe's generator writes the script itself.
- **Forced-hover check opened nothing.** `tr.row:nth-of-type(2)` counts the group header rows too. `check.sh` now marks the first tooltip directly.
