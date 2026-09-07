---
schema: recipe/1.0
id: jseries-paper-conventions
title: J-Series Paper Conventions (location · improvement-notes · versioning)
category: writing
subdivision: papers
summary: The three load-bearing conventions for editing any J-series paper — where papers live, how improvement_notes.md works (a work QUEUE, reset to empty when done), and how to version (continue the paper's OWN number, never invent one).
triggers:
  [
    j-series paper,
    jseries convention,
    improvement notes,
    improvement_notes,
    paper version,
    version the paper,
    "what version",
    bump the paper,
    edit a paper,
    "which paper folder",
  ]
effort: shallow
tools: [read, grep, glob, exec, edit, write]
children: []
---

## Goal

Before touching ANY J-series paper, load the three conventions that are easy to get wrong and expensive
when you do. This is the reference card `write-paper` and `revise-paper` assume you already followed.

## When to Use

- Any time you are about to create, revise, version, or "improve" a J-series paper.
- Whenever you touch an `improvement_notes.md`.
- Read this FIRST; then run `revise-paper` for a full revision pass.

## The three conventions

### 1. Location — where papers live

- Every J-series paper lives in its own folder: **`~/Documents/AI_reports/Papers/J<N>_<slug>/` (moved out of the repo 2026-09-07; NOT in the pushable tree)**
  (e.g. HIVEMIND = J10 = `docs/papers/corporate-swarm/`; the dir name is a topic slug, NOT the codename).
- The **canonical current manuscript** is usually the **undated `<slug>.md`** — not the highest-dated
  filename. Confirm by comparing version headers/footers across candidates; ignore supporting files
  (`*-review*`, `*-critique*`, `*-references*`, `sota-*`).
- The J-number (J1…J11…) and each paper's status live in the **J-series registry**
  (`~/src/jarvis-icu/docs/notes/*jseries*registry*.md`) — check it when unsure which paper is which.

### 2. `improvement_notes.md` — a WORK QUEUE, not a changelog

**It is a to-do list of improvements TO MAKE, then emptied — never a log of what you did.**

- **To queue work:** add `### <improvement>` entries describing changes the paper still NEEDS.
- **Do the work:** incorporate those entries into the manuscript itself (self-contained prose — the
  paper never references its own version history; versioning lives only in the header/footer).
- **Reset to empty:** once incorporated AND the new version is confirmed good, replace the file with a
  **header-only cleared stub** — `Incorporated into <version> on <YYYY-MM-DD> — no pending entries.` —
  with **zero pending `###` entries**. Archive the incorporated text to
  `improvement_notes.incorporated-<YYYY-MM-DD>.md` if it was substantial. It is a file move + stub
  rewrite, never a delete.
- **Deferrals stay:** anything you deliberately did NOT do remains a pending `###` entry.
- **Why:** the staleness chain reads a non-blank `improvement_notes.md` as "this paper is stale." Leaving
  incorporated notes in place makes it demand endless re-revisions; writing a changelog INTO it (the 2026-09-06
  mistake) both mis-uses the queue and never clears, so the paper looks permanently stale.

### 3. Versioning — continue the paper's OWN number

- **Read the number off the artifact, never invent it.** The current version is in the paper's **footer**
  (`_J-series paper J-N | Version X.Y | DATE_`) or the registry. Bump from THAT: `+0.1` for a revision,
  `+1.0` for a major reframe. **Never invent a number and never regress one** (the 2026-09-06 mistake:
  a paper already at 2.2 was mislabelled "2.0").
- **Follow the paper's own file convention — check the folder first:**
  - **In-place** (e.g. J10/`corporate-swarm.md`): edit the one manuscript, bump the footer line, let git
    commits carry history. No separate `-vN` file.
  - **Separate versioned file** (e.g. `learned-intuition-v4.0.md`): copy to `<slug>-v<next>.md`, put the
    version in a `**Version N.N**` header, leave the baseline intact.
    A `ls` of the folder tells you which pattern this paper uses. Do not impose one on a paper that uses the other.
- Commit message names the version and J-number (e.g. `paper(J10): v2.3 — …`) so history stays legible.

## Steps

### 0. Load conventions

**Tools:** read, glob, exec
**Done when:** you know the paper's folder, its current version (from footer/registry), and its file convention (in-place vs `-vN`).

- `ls ~/src/tinkerclaw/docs/papers/<slug>/` and read the footer of the canonical manuscript.

### 1. Queue → incorporate → reset

**Tools:** read, edit, write
**Done when:** improvements are in the manuscript, version bumped, `improvement_notes.md` reset to the cleared stub.

- Follow convention 2 and 3 above. For a full structural revision pass, hand off to `revise-paper`.

## Constraints

- Never edit a paper without first reading its current version number off the footer/registry.
- Never leave incorporated notes in `improvement_notes.md`; never turn it into a changelog.
- Never invent or regress a version number; never impose a file convention the paper doesn't use.

## Failures Overcome

- **Changelog-in-the-queue (2026-09-06):** wrote "what I did to the paper" into `improvement_notes.md` and left it. It is a queue to empty, not a log to fill.
- **Invented/regressed version (2026-09-06):** stamped "v2.0" on a paper already at 2.2, and split off a wrongly-named `-v2.0.md`. Read the footer; continue the number; use the paper's own file convention.
- **Wrong "latest" file:** revised a dated sibling instead of the undated canonical `<slug>.md` that carried a higher version. Compare headers before choosing.
