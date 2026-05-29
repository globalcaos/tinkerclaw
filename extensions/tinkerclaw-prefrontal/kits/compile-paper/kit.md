---
schema: "kit/1.0"
slug: "compile-paper"
title: "Compile Paper to PDF"
summary: "Markdown paper folder → Serra-styled PDF with figures and clickable refs"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["writing", "paper", "compile", "build", "pdf", "render", "latex", "publish"]
tools: ["read", "grep", "glob", "exec", "edit", "write"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
  notes: |
    Each step is modelled as a serial barrier. Step index:
    0=Survey, 1=Plan figures, 2=Generate missing, 3=Convert,
    4=Enrich bib, 5=Build, 6=Verify+report.
    Survey (0) and Plan figures (1) read state and must run before any
    write step. Generate missing (2) is per-figure isolated INSIDE the
    step (one failure does not abort the rest) — the caller may spawn
    sub-figures concurrently but the overall step group is serial.
    Convert (3) needs figures referenced by the .md to exist (or be
    flagged) before pandoc runs. Enrich bib (4) modifies refs.bib;
    in principle it could run alongside Convert (neither writes the
    other's output), but Build (5) needs both, so we serialise for
    simplicity. Build (5) is the canonical 3-pass pdflatex+bibtex.
    Verify (6) reads only; never aborts the build.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "compile paper | build pdf | paper to pdf | render paper | make pdf | publish paper | compile pdf | pdf from paper",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: compiling an existing markdown paper folder into a Serra-styled PDF (md → tex → pdf with figures and clickable refs).",
    },
  ]
---

## Goal

Take one paper folder under `~/Documents/AI_reports/Papers/` and produce a Serra-styled PDF — figures embedded, references clickable.

## When to Use

- One specific markdown paper (J1–J15 folder) needs a PDF.
- A previously built PDF is stale and needs a re-run after edits.
- A new paper has been added in the same `J*_topic/` layout.

Not for: bulk-building all 15 papers (separate recipe later), Group A `.latex` sources, Google-Docs sources.

## Canonical references

- Inventory + style + naming: `~/Documents/AI_reports/Papers/BLUEPRINT.md`
- Build script (unchanged): `~/Documents/AI_reports/Papers/build-paper.sh`
- Style: `~/Documents/AI_reports/Papers/serra-paper.sty`
- Converter: `~/Documents/AI_reports/Papers/md-to-tex.sh`

## Steps

### 1. Survey

**Tools:** read, glob
**Done when:** Latest dated `.md` chosen; figures + `diagram-suggestions.md` enumerated

`ls` the target folder. Pick the most recent `YYYY-MM-DD-*.md` (highest date, highest version). Enumerate figures by globbing `fig-*.{png,jpg,pdf}` at the folder root and any files in `images/` / `diagrams/`. Note whether `diagram-suggestions.md` exists.

### 2. Plan figures

**Tools:** read
**Done when:** Two lists locked: figures referenced in the `.md` and figures present on disk

Grep the chosen `.md` for `![...](path)` image references. Cross-reference against the on-disk inventory from step 1. Produce a missing-figure list (referenced but absent) and an orphan-figure list (present but not referenced — informational only, do not delete).

### 3. Generate missing figures

**Tools:** write, exec
**Done when:** Each missing figure exists in `images/` or recipe reports it as "generation-failed"

For each missing figure: open `diagram-suggestions.md`, find the suggestion matching the figure name, and generate it.

- Architecture / flow / boundary diagrams: TikZ inline in a small `.tex` file, compiled to PDF via `pdflatex`, then either embed the PDF directly or convert to PNG.
- Charts and plots: short Python (`matplotlib`) script in a temp file, run it, save the PNG into `images/`.
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

### 7. Verify + report

**Tools:** read
**Done when:** Report delivered

Report:

- Output PDF path + page count + size.
- Warnings/errors found in `<basename>.log` (grep for `! `, `Warning:`, `Undefined`).
- Missing-figure list from step 2 (and which the recipe generated vs. failed).
- Bib lookup-failed list from step 5.
- Orphan-figure list from step 2 (informational).

## Constraints

- One paper per run. Do not auto-fan-out to the rest of `Papers/` without an explicit user request — bulk orchestration is out of scope.
- Do NOT rewrite `.md` content. The recipe compiles, it does not edit.
- Do NOT touch `build-paper.sh` or `serra-paper.sty` from inside the recipe.
- Filename violations: ask the user before renaming the `.md`.

## Safety Notes

- The `refs.bib` enrichment writes to a file checked into someone's notes repo — show the diff before applying when running interactively.
- Generated diagrams may not match the paper's intent. Treat them as drafts; the user reviews them before they ship in a final paper.

## Failures Overcome

- **Silent `paper.tex`:** Previous runs (J3) produced `paper.tex` instead of the dated name. `md-to-tex.sh` now fails fast on bad filenames so this can't happen.
- **Broken refs:** Hand-entered `.bib` entries without URLs make every citation a dead link. The enrichment step is per-entry isolated so one lookup failure doesn't block the build.
- **Missing figures:** Pandoc happily emits `\includegraphics{fig-X.png}` for a path that doesn't exist; the PDF builds with `!! ERROR` markers instead. Step 2 surfaces the gap before step 6.
