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

Before touching ANY J-series paper, load the five conventions that are easy to get wrong and expensive
when you do. This is the reference card `write-paper` and `revise-paper` assume you already followed.

## When to Use

- Any time you are about to create, revise, version, or "improve" a J-series paper.
- Whenever you touch an `improvement_notes.md`.
- Read this FIRST; then run `adversarial-review-loop` (the default paper-improvement procedure) for a full revision pass.

## The five conventions

### 1. Location — where papers live

- Every J-series paper lives in its own folder: **`~/Documents/AI_reports/Papers/J<N>_<slug>/` (moved out of the repo 2026-09-07; NOT in the pushable tree)**
  (e.g. HIVEMIND = J10 = `docs/papers/corporate-swarm/`; the dir name is a topic slug, NOT the codename).
- **A secret paper never goes in `Papers/`.** The publish and staleness workflows (`revise-publish-jseries`,
  `papers-staleness-audit`, `audit-paper-posts`) scan that folder, so a paper filed there can be revised and summarised
  for the public site. Company research the principal keeps secret lives in that product's own private repo
  (AcmeVision: GitLab acmevision-vms, `documentation/vms/research/<slug>/`; principal 2026-10-03: "the paper should
  live in the AcmeVision gitlab"). A staging folder under `~/Documents/ACME/` is fine while drafting, never the home.
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
- **Not every edit is a version.** A small change the principal asks for between rounds (a cut, a sentence,
  a wording) goes into the current version in place: add it to that version's build step so a rebuild keeps
  it, recompile the same files, no bump and no new file. Bump for a revision round or a change of substance
  (principal, 2026-09-29, on a two-sentence abstract cut: "No need to create a new version for that change").
- **Follow the paper's own file convention — check the folder first:**
  - **In-place** (e.g. J10/`corporate-swarm.md`): edit the one manuscript, bump the footer line, let git
    commits carry history. No separate `-vN` file.
  - **Separate versioned file** (e.g. `learned-intuition-v4.0.md`): copy to `<slug>-v<next>.md`, put the
    version in a `**Version N.N**` header, leave the baseline intact.
    A `ls` of the folder tells you which pattern this paper uses. Do not impose one on a paper that uses the other.
- Commit message names the version and J-number (e.g. `paper(J10): v2.3 — …`) so history stays legible.

### 4. Illustrative examples — carry the point, not a grievance

An example in an abstract or an opening scene is doing one job: making an abstract mechanism concrete
fast. It is not evidence, so it is cheap to swap and expensive to get wrong — a reader who stops on the
example has stopped reading the paper.

- **Do not name a live geopolitical flashpoint** to illustrate a censorship or topic-policy mechanism. The
  flashpoint only adds people who may take offence, including vendors we depend on.
- **Prefer a real, well-known, cited case over a vague description.** A generic "pointed question about a
  government's record" was safe but forgettable, and the principal replaced it within the hour (v3.7 → v3.8) with
  the Hugging Face break-in of July 2026, where hosted models refused the forensics and an open-weight model did
  it. A public incident everyone remembers makes the point, cuts across vendors instead of accusing one, and can
  be cited. Cite the PRIMARY source and state only what it says: the disclosure does not name the refusing
  models, so the paper does not either, even though the press does. Before using a case the principal recalls,
  check it: he remembered this one as "to prevent the hack"; the record says forensics after the break-in.
- **Do not use Catalan (or Spanish) as the stand-in "other language."** Too close to home for the
  principal — it reads as being about him. Pick a language that is plainly an example: Swahili, Finnish,
  Tagalog. A distant language is also funnier, which helps.
- **A swapped example can change what is TRUE.** Catalan → Swahili turned "a good writer in that language
  and no great depth, so a cheaper model does the job" into a false claim: for a low-resource language the
  deciding axis is coverage, not depth. Re-read the sentences around any example you swap and fix the ones
  that only held for the old one.
- **Measured results are not examples.** A finding that says "three tasks on Chinese politics" is data;
  softening it falsifies the record. Change illustrations freely, flag findings to the principal instead.

### 5. A J-series paper is the design for the next coding iteration

**The principal, 2026-09-30 06:22, rewriting J19 into v4.0:** "I don't care what we do today, nobody cares. The
J-series papers are the design principles for the next coding iteration." So a J-series paper describes the best
version of the system we could build, and it is written to be built from.

- **No status report.** No "what runs today" table, no counts from our own logs, no "not yet wired", no names of
  the current code's files or flags. What the harness does now belongs in the code, the design bible and the
  plans, not in the paper.
- **Design, derived.** Each mechanism states what it does, why, and when it pays. Where a number decides a design
  choice, derive it (the J19 cache break-even $N^*$ is the model) from published facts, and say which ones.
- **Proof is the tests.** Where there is no result yet, name the test that would decide it (the story rule's
  "proof where possible"). One plain sentence says the paper is a design; that is the only status it carries.
- **Buildable.** A coder should be able to start from it: the components, the loop (pseudocode is fine; prompts
  are not, see adversarial-review-loop § No literal prompts), and what the design needs from the harness.

## Steps

### 0. Load conventions

**Tools:** read, glob, exec
**Done when:** you know the paper's folder, its current version (from footer/registry), and its file convention (in-place vs `-vN`).

- `ls ~/src/tinkerclaw/docs/papers/<slug>/` and read the footer of the canonical manuscript.
- **One number, one folder.** Run `ls -d ~/Documents/AI_reports/Papers/J<N>_*`. More than one folder for the
  number (J19 had `J19_maestro/` and `J19_orchestration/` until the principal merged both into `J19_maestro/` on
  2026-09-30) means two manuscripts may claim the paper: read both
  headers and the registry row, and if the one you were asked about is not the registry's canonical one, the
  choice is a DIRECTION decision for the principal, not a file you pick.

### 1. Queue → incorporate → reset

**Tools:** read, edit, write
**Done when:** improvements are in the manuscript, version bumped, `improvement_notes.md` reset to the cleared stub.

- Follow convention 2 and 3 above. For a full structural revision pass, hand off to `adversarial-review-loop` (the default; `revise-paper` only inside a batch or when no Astra tab is chained).

## Constraints

- Never edit a paper without first reading its current version number off the footer/registry.
- Never leave incorporated notes in `improvement_notes.md`; never turn it into a changelog.
- Never invent or regress a version number; never impose a file convention the paper doesn't use.

## Failures Overcome

- **Changelog-in-the-queue (2026-09-06):** wrote "what I did to the paper" into `improvement_notes.md` and left it. It is a queue to empty, not a log to fill.
- **Invented/regressed version (2026-09-06):** stamped "v2.0" on a paper already at 2.2, and split off a wrongly-named `-v2.0.md`. Read the footer; continue the number; use the paper's own file convention.
- **Wrong "latest" file:** revised a dated sibling instead of the undated canonical `<slug>.md` that carried a higher version. Compare headers before choosing.

- **Flashpoint and home language as examples (J19 v3.7, 2026-09-30):** the abstract illustrated topic policy
  with Tiananmen Square and the four-request scene used a letter in Catalan. The principal asked for both to
  go — the first could offend people we would rather not offend, the second hits too close to home. Swapping
  the language also broke the sentence that justified a cheaper model. The vague replacement then lasted one
  version: he asked for a known, real case instead (v3.8). See convention 4.
- **Status report instead of a design (J19 v3.x, rewritten as v4.0 on 2026-09-30):** twelve pages about what the
  current router logged, what was wired and what was not. The principal: "nobody cares" what runs today; the
  paper is the design the next iteration is built from. See convention 5.
- **Two folders, one number (J19, found 2026-09-29):** the Thalamus supply-axis revision (2026-09-03) went into
  `J19_maestro/`, a folder whose notes said SUPERSEDED, while the registry's J19 was `J19_orchestration/`. Nothing in
  this recipe looked above the folder, so the split surfaced only in a series-wide snapshot 26 days later. Step 0
  now lists every folder that carries the number. **Second cost (2026-09-30):** the review loop then built v3.0–v3.5
  in `J19_orchestration/`, the registry's folder; the principal opened `J19_maestro/`, saw v0.2 as the latest, and
  merged both into `J19_maestro/` ("here is where all the J19 files should go"). The registry is not the
  principal's folder: when two folders carry the number, ask him which one is home before the first write.
