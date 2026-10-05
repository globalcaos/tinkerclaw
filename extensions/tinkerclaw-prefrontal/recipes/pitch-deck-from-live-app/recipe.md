---
schema: "kit/1.0"
slug: "pitch-deck-from-live-app"
title: "Pitch deck built from a working app's real screens"
summary: "Present something the owner built (to a colleague, a client, a buyer) as a 16:9 HTML deck + PDF, using fresh screenshots of the real app driven with fictional data, every number checked against code or DB."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "writing"
subdivision: "presentations"
tags: ["presentation", "pitch", "slides", "deck", "demo", "screenshots"]
triggers:
  [
    "create a presentation",
    "make a presentation",
    "pitch deck",
    "slides to show",
    "so I can pitch it",
    "present it to",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis"
params:
  decks_root:
    {
      type: "string",
      default: "~/Documents/decks",
      description: "Parent folder for deck folders. Each deck gets its own `<decks_root>/<YYYY-MM-DD> <title>/` holding scripts, screenshots, index.html and the PDF. Must be outside any git repo that has a remote.",
    }
  chrome_bin:
    {
      type: "string",
      default: "google-chrome",
      description: "Chrome or Chromium binary used by Playwright for the screenshots and by the headless PDF export.",
    }
  playwright_from:
    {
      type: "string",
      default: ".",
      description: "Directory whose node_modules resolves `playwright-core` (the app's own repo, or any checkout that already has it). Avoids a fresh install per deck. If none has it, run `npm i playwright-core` once in the deck folder and point this there.",
    }
  prose_check:
    {
      type: "string",
      default: "",
      description: "Optional command that reads slide text on stdin and flags stiff or machine-sounding prose (for example a prose linter such as Vale, or your own style checker). Empty = re-read the text yourself.",
    }
---

# Pitch deck built from a working app's real screens

**What it is for.** The owner shows something they built to someone outside the project (a
colleague in another department, a client, a buyer) and needs a deck that shows it truthfully.
**Update it** when a deck built this way gets a correction from the owner or the audience.

## Worked example used below

A small web app for a neighbourhood tool-lending library: members browse a catalogue, book a
tool for a date range, get an automatic overdue reminder (written by a model call), and the
coordinator prints a monthly usage report. The owner wants to pitch it to the board of another
library. The steps reference this example in brackets; swap in your own app.

## Steps

1. **Read the project memory first** (the agent's notes on the project, its README and design
   docs), then the code. The memory tells you what exists; the code tells you what is true today
   (counts, timings, flags). Every number on a slide must come from a command you ran this turn:
   section counts, item counts, scoring points, real usage.
   [Tools in the catalogue: a `SELECT count(*)` on the dev DB. Loans last month: the real log,
   counted, not remembered.]
2. **Screens come from a local harness seeded with FICTIONAL people** (`@example.invalid`), never
   from the live site and never with a real person's data. The audience is external: a real
   customer's, user's or colleague's name on a slide is a privacy leak. Scan the finished folder
   for real names before handing it over. [Seed ten invented members and forty invented loans.]
3. **Real output, fictional input.** If the app has a stub (grader, model call, mailer) that
   prints `STUB`, feed the fictional data through the REAL pipeline so the screenshot shows
   genuine output. A stub on a pitch slide is a fake. [Run the reminder writer against the real
   model for one invented overdue loan; do not screenshot the dev-mode `STUB reminder text`.]
4. **Drive the app with Playwright** (`playwright-core` resolved from `{{playwright_from}}`,
   browser `{{chrome_bin}}`), `deviceScaleFactor: 2`. Put scripts and outputs in the deck
   folder under `{{decks_root}}`, never `/tmp`.
5. **Look at every screenshot** (contact sheet for the batch, full size for the key ones) before
   it goes on a slide. Crop with PIL to slide-ready JPEGs.
6. **Deck = one self-contained `index.html`** (1600×900 slides scaled to the window, arrow keys,
   `N` speaker notes, `F` fullscreen, no CDN so it works offline) + a PDF export
   (`{{chrome_bin}} --headless=new --no-pdf-header-footer --print-to-pdf`). Speaker notes carry
   the talk; slides stay light.
7. **Render every slide to PNG and check** overflow + image load programmatically, then look at
   the contact sheet. If `{{prose_check}}` is set, pipe the extracted slide text into it; never
   leave its stdin on the terminal (feed a pipe, or `< /dev/null` if it takes a file argument), or
   it waits for input and hangs the run.
8. **Honest slides:** a "what it would take / open questions" slide and a "your turn" slide with
   the questions the owner wants answered. Say what is not calibrated, not deployed, or not legal
   yet. [Not yet tested with more than one library; reminders only in one language.]
9. **Chat hand-off:** clickable backtick paths to the deck and PDF, plus anything the demo must
   NOT show live (bugs found while shooting).
10. **Claims about time or money saved** (2026-09-26): every "before → after" number is either an
    industry benchmark named on the slide (source + year, fetched this turn) or an assumption printed
    on the slide itself (volumes, minutes per unit). Keep the model conservative (below the benchmark)
    and invite the audience to correct it. Mark each feature's status honestly: working / done by hand
    with AI / next. [“40 loans a month × 6 min of paperwork each, our estimate: correct us.”]
11. **Demo a generator on invented data when the harness data is gone:** write an invented record in
    the REAL data format (a small `make_demo.py` that emits the same JSON shape the real builder
    reads, emails `@example.invalid`) and run the real builder on it. The layout is real output; only
    the input is invented, and the caption says so. [Invented loans in the real `loans.json` shape →
    the real monthly-report builder → the report page on the slide.]

## Constraints

- No deck inside the agent's state directory or any repo that pushes to a remote. Decks go under
  `{{decks_root}}/<YYYY-MM-DD> <title>/`.
- Deck language = the language the owner asks in, unless they name the audience's language.
- Legal/compliance claims come from a dated, verified note, and the slide says "as of <date>".

## Failures overcome

- **2026-09-26 — `style="flex:0"` on a `.row` collapsed it to zero height** (flex-basis 0), so the next
  block painted ON TOP of the cards. The overflow check only measures the slide's bottom edge and
  passed. Use `flex:none` for fixed-height rows, and LOOK at the contact sheet: overlap is invisible
  to the check.
- **2026-09-26 — the same invented person had different numbers on adjacent slides** (a dashboard
  card and a printout showed two different averages for them, and a mock email's headline figure did
  not match the average of its own cells). When a mock shows an aggregate, compute it from the
  mock's own cells in code and reuse the person's numbers everywhere they appear.
- **2026-09-26 — the prose checker flagged UI glyphs (✓ ✗ ~) inside a mock screen as emoji.**
  Expected; judge the prose, not the illustration.

- **2026-09-25 — `new URL(..., import.meta.url).pathname` keeps `%20` for spaces**, so Playwright
  silently created a sibling folder literally named `…%20Demo%20deck/`. Use `fileURLToPath()`.
- **2026-09-25 — the shooting run found a live bug**: a computed score was 0 for every real record
  (the scoring check functions were dropped when the config went through JSON). Shooting the full
  feature path is also the best end-to-end test the app gets; report such findings, do not demo the
  broken screen.
- **2026-09-25 — `pkill -f "<pattern>"` killed its own shell** because the pattern was in the
  command line. Match the exact argv with `ps -eo pid,args | awk …` instead.
- **2026-09-25 — first-draft slide claims overshot the evidence** (a claim of real-world use that
  had not happened yet, and "the data stays on our server" while one step sent it to a third-party
  model API). Re-read each claim against the source before rendering.
