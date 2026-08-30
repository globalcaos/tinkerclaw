---
schema: recipe/1.0
id: compile-paper
title: Compile Paper to PDF
category: writing
summary: Markdown paper folder → J-Series-styled PDF with figures and clickable refs
triggers: [compile paper, build pdf, paper to pdf, render paper, make pdf, publish paper]
effort: deep
tools: [read, glob, grep, exec, edit, write]
children: []
---

## Goal

Take one paper folder under `~/Documents/AI_reports/Papers/` and produce a J-Series-styled PDF — figures embedded, references clickable.

## When to Use

- One specific markdown paper (J1–J15 folder) needs a PDF.
- A previously built PDF is stale and needs a re-run after edits.
- A new paper has been added in the same `J*_topic/` layout.

Not for: bulk-building all 15 papers (use `revise-publish-batch`, which composes this recipe across a series), Group A `.latex` sources, Google-Docs sources.

## Canonical references

- Inventory + style + naming: `~/Documents/AI_reports/Papers/BLUEPRINT.md`
- Build script (unchanged): `~/Documents/AI_reports/Papers/build-paper.sh`
- Style: `~/Documents/AI_reports/Papers/jseries-paper.sty`
- Converter: `~/Documents/AI_reports/Papers/md-to-tex.sh`

## Steps

### 1. Survey

**Tools:** read, glob
**Done when:** Latest dated `.md` chosen; figures + `diagram-suggestions.md` enumerated

`ls` the target folder. Pick the **genuinely latest** version — NOT just the highest-dated filename. Most paper folders also hold an UNDATED `<topic>.md` (e.g. `curiosity-motivation.md`, `corporate-swarm.md`) that is frequently the real current version with a higher `vX.Y` in its header than any dated file. Compare version headers across the dated `YYYY-MM-DD-codename-vX.Y.md` files and the undated `<topic>.md`, then pick the highest. Ignore supporting files (`sota-expansion-*`, `*-review-*`, `*-critique*`, `*-references*`, `*-synthesis*`, `*-brief*`, `gemini-*`). Enumerate figures by globbing `fig-*.{png,jpg,pdf}` at the folder root and any files in `images/` / `diagrams/`. Note whether `diagram-suggestions.md` exists.

### 2. Plan figures

**Tools:** read
**Done when:** Two lists locked: figures referenced in the `.md` and figures present on disk

Grep the chosen `.md` for `![...](path)` image references. Cross-reference against the on-disk inventory from step 1. Produce a missing-figure list (referenced but absent) and an orphan-figure list (present but not referenced — informational only, do not delete).

### 3. Generate missing figures

**Tools:** write, exec
**Done when:** Each missing figure exists in `images/` or recipe reports it as "generation-failed"

For each missing figure: open `diagram-suggestions.md`, find the suggestion matching the figure name, and generate it.

**{{paper-figures}} owns the figure policy — follow its ROUTING RULE, do not re-decide it here.** In short:

- Architecture / flow / boundary / concept diagrams: **napkin.ai** via the `napkin-diagrams` skill, then the Nano Banana Pro cohesion pass. NOT TikZ, NOT matplotlib box-art.
- Charts and plots of real numbers: short Python (`matplotlib`) script in a temp file, house-style rcParams applied, PNG into `images/`. Never restyle these through an image model.
- TikZ/D2 only when Napkin is unavailable or the topology must be literally exact.

Per-figure isolated: one failure does not abort the run. Skip silently if the figure is already on disk.

### 4. Convert markdown to LaTeX

**Tools:** exec
**Done when:** `.tex` exists at the BLUEPRINT-mandated `YYYY-MM-DD-codename-vX.Y.tex` name

Run `~/Documents/AI_reports/Papers/md-to-tex.sh <path-to-md>`. If the helper exits non-zero with a filename-error, ask the user before renaming the `.md` (the convention is load-bearing for the PDF output name).

### 5. Enrich bibliography

**Tools:** read, edit, exec
**Done when:** Every `refs.bib` entry has a `url=` field or is listed as "lookup-failed" in the final report

Parse `refs.bib`. For each entry without `url=`:

1. If it has `doi=`, set `url=https://doi.org/<doi>`.
2. Else if it has `eprint=` or `arxivId=`, set `url=https://arxiv.org/abs/<id>`.
3. Else `curl` the arXiv API: `https://export.arxiv.org/api/query?search_query=ti:"<title>"&max_results=1`. If a single confident match, add the URL.
4. Else try the DOI resolver: `curl 'https://api.crossref.org/works?query.title=<title>&rows=1'`. Same single-confident-match rule.
5. Else leave entry untouched and list it as "lookup-failed" in the final report.

Skip entries that already have a `url=` field.

### 6. Build PDF

**Tools:** exec
**Done when:** `.pdf` exists; `build-paper.sh` exit code 0

Run `~/Documents/AI_reports/Papers/build-paper.sh <path-to-tex>`. If exit non-zero or `.pdf` missing, dump the last 50 lines of `<basename>.log` and fail the recipe.

### 7. Verify figure text size — MEASURE it, then look (hard gate)

**Tools:** exec, read
**Done when:** `fig-legibility.py` reports every figure's text-to-body ratio in `[0.7, 1.15]`, AND a full-page render of each figure has been eyed (whole page, not a crop), AND wide tables fit the margins — or the issue is fixed and the PDF rebuilt

A clean `pdflatex` log proves nothing about how the PDF _looks_. The defect that shipped twice on J10 — figure text **4× the body text**, the whole figure filling the page — is invisible to the log and was missed by eyeballing _cropped_ figure regions (a crop hides that the figure fills the page). So this step is quantitative first.

1. **Run the detector:** `python3 ~/Documents/AI_reports/Papers/fig-legibility.py <paper>.pdf "<fig1 caption substr>" "<fig2 …>" …`. It renders the body text and each figure at 150 dpi, measures the median glyph height of each, and prints `ratio = figure_glyph / body_glyph` per figure. **Target ~0.9 (figure text ≈ body, or slightly smaller). `>1.15` = TOO LARGE; `<0.7` = too small.** This is the deterministic answer to "do the figure letters exceed the body text."
2. **Fix out-of-band figures by adjusting the embed width** — NOT the D2 font. With `keepaspectratio` set (see below), on-page figure text scales linearly with the display width, so: `new_width% = current_width% × (0.9 / measured_ratio)`. Set it per figure in the markdown image attribute, e.g. `![…](images/fig-x.png){width=55%}`. Re-run the detector; converges in one step. (If the required width would be absurdly small, the figure is too wide/dense — redraw it narrower/more vertical per {{paper-figures}}.)
3. **Eyeball the WHOLE page** of each figure (`pdftoppm -r 80` of the full page, Read it) to confirm it sits as a normal inline figure — not page-filling, not stretched. A crop is not allowed here; the failure mode is scale, which only a full page reveals.
4. **Tables:** render each wide-table page; confirm no column runs under the margin and no row is clipped. If one overflows, abbreviate headers or `\resizebox` it.
5. Only after the detector passes for every figure AND the full-page look is clean do you report done.

**Report:**

- Output PDF path + page count + size.
- Warnings/errors found in `<basename>.log` (grep for `! `, `Warning:`, `Undefined`).
- **Per-figure verdict: page it landed on + "text legible: yes/no" from the actual render.**
- **Per-wide-table verdict: "fits margins: yes/no".**
- Missing-figure list from step 2 (and which the recipe generated vs. failed).
- Bib lookup-failed list from step 5.
- Orphan-figure list from step 2 (informational).

## Constraints

- One paper per run. Do not auto-fan-out to the rest of `Papers/` without an explicit user request — bulk orchestration belongs to `revise-publish-batch`.
- Do NOT rewrite `.md` content. The recipe compiles, it does not edit.
- Do NOT touch `build-paper.sh` or `jseries-paper.sty` from inside the recipe.
- Filename violations: ask the user before renaming the `.md`.

## Safety Notes

- The `refs.bib` enrichment writes to a file checked into someone's notes repo — show the diff before applying when running interactively.
- Generated diagrams may not match the paper's intent. Treat them as drafts; the user reviews them before they ship in a final paper.

## Failures Overcome

- **Silent `paper.tex`:** Previous runs (J3) produced `paper.tex` instead of the dated name. `md-to-tex.sh` now fails fast on bad filenames so this can't happen.
- **Broken refs:** Hand-entered `.bib` entries without URLs make every citation a dead link. The enrichment step is per-entry isolated so one lookup failure doesn't block the build.
- **Missing figures:** Pandoc happily emits `\includegraphics{fig-X.png}` for a path that doesn't exist; the PDF builds with `!! ERROR` markers instead. Step 2 surfaces the gap before step 6.
- **ASCII box-art diagrams (J8 pilot):** A markdown architecture diagram drawn in box-drawing glyphs (`─ │ ┌ ┐ ▼`) emits ~hundreds of undefined-Unicode errors under pdflatex. Convert it to a real TikZ figure compiled standalone to `images/<name>.pdf` and embed — don't ship the ASCII.
- **Tall figure overflows the footer (J8 pilot):** A portrait diagram triggers `Float too large for page by Npt` and the caption collides with the `J-Series — YYYY` footer. Always constrain embeds with `\includegraphics[width=\linewidth,height=0.85\textheight,keepaspectratio]{...}` so no figure exceeds the text height.
- **Unreadable figures shipped past a green log (J10):** Three figures rendered as tiny illegible strips inside the A4 PDF and were published before anyone looked at the _embedded_ result. Two compounding causes: (a) the D2 sources were wide, sprawling canvases (one was 5:1) with small relative fonts, so any fit-to-column scaling made the text microscopic; (b) the PNGs were 72 dpi, so pandoc computed a wrong intrinsic size. Fix: author figures compact/vertical with large fonts (see {{paper-figures}}) AND add `{width=92%}` to every figure ref so pandoc sizes to the column. The durable guard is Step 7 — render the actual page and READ it; verifying the standalone PNG (which looked fine at full size) is NOT the same as verifying the figure in the PDF.
- **Verifying the wrong artifact:** "I checked the figure" meant the standalone PNG, not the page. The only valid figure check renders the built PDF page at the embedded scale and reads it.
- **Figures stretched to fill the page → text 4× body (J10, the real root cause):** pandoc emits `\includegraphics[width=0.92\textwidth,height=\textheight]{...}`, and `jseries-paper.sty` did NOT set `keepaspectratio`. graphicx then treats width AND height as exact targets and STRETCHES every PNG to 0.92\textwidth × full \textheight — page-filling and vertically distorted, so the figure text rendered ~4× the body. Fix (applied): `\setkeys{Gin}{keepaspectratio}` after `\RequirePackage{graphicx}` in `jseries-paper.sty` — now width/height is a bounding box, the image fits inside preserving aspect, width binds, and on-page text scales linearly with the embed width (so Step 7's `new_width% = old% × 0.9/ratio` works). This was missed for two rounds because the figure was only ever inspected as a CROP; the full page would have shown it filling the sheet. `fig-legibility.py` now catches it numerically.
- **Wrong base version:** "Latest = highest-dated filename" picks a stale base when an undated `<topic>.md` is the real current version (J8: `curiosity-motivation.md` was v6.0 vs the dated v1.0). Step 1 now compares version headers, not filename dates.
- **Dropped code blocks (J2 full run):** `jseries-paper.sty` ships no pandoc syntax-highlighting preamble, so a paper with fenced code blocks emits `Shaded`/`Highlighting` undefined (~50 undefined control sequences) and the code silently vanishes from the PDF. Fix per-build: inject pandoc's `fancyvrb`/`framed` `Shaded`+`Highlighting` environments, the `*Tok` token macros, and `\DeclareUnicodeCharacter` for any non-ASCII glyphs (≤ ≈ × → · κ †) into the generated `.tex` preamble between `\usepackage{jseries-paper}` and `\begin{document}`. These injections are lost if `md-to-tex.sh` is re-run — the durable fix is to fold the highlighting preamble into `jseries-paper.sty` (toolchain change, needs the owner's OK).
