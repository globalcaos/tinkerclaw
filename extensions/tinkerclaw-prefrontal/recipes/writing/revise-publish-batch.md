---
schema: recipe/1.0
id: revise-publish-batch
title: Revise & Publish Paper Batch
category: writing
summary: Orchestrate revise-paper → compile-paper across a whole paper series — triage by improvement notes, fan out via ultracode, supervise to completion with the Overseer
triggers:
  [
    revise all papers,
    rewrite the papers,
    all J-series,
    paper batch,
    revise and publish,
    bulk paper revision,
    all the papers,
  ]
effort: deep
tools: [read, glob, grep, exec, edit, write]
children: [revise-paper, compile-paper]
---

## Goal

Take a whole series of markdown papers (e.g. `J1–J15` under `~/Documents/AI_reports/Papers/`), revise the ones with **actionable** improvement notes, and produce a Serra-styled PDF (figures + clickable refs) for each — end to end, supervised, without dropping any paper.

This recipe is the **orchestrator** the single-paper recipes deliberately punt to. `revise-paper` and `compile-paper` are the unit steps; this composes them across N papers and enforces completion.

## When to Use

- "Rewrite all the J-series papers that have improvement notes, then build PDFs."
- Any time the same revise→compile pipeline must run over a directory of papers.
- A post-review sweep where several papers each got reviewer notes.

Not for: a single paper (use `revise-paper` then `compile-paper` directly). Group A `.latex` / Group C Google-Docs sources are out of scope — markdown (Group B) only.

## Execution model

Recipes are playbooks; the executable layer is **ultracode** (the `Workflow` tool). The canonical script lives at `recipes/writing/revise-publish-jseries.workflow.js` and is invoked with `args`:

- `{ mode: "triage" }` — read-only. Classify every paper; return the actionable work-list. Run this FIRST, show the user, get a go.
- `{ mode: "full", folders: [...] }` — for each actionable paper, `pipeline(revise → compile)` with **no barrier** (paper A compiles while paper B is still revising). Returns per-paper `{ newMdPath, pdfPath, pages, warnings }`.

## Steps

### 0. Engage the Overseer

**Tools:** read
**Done when:** `fork.overseer.activate` called with the verbatim original task

Two supervision modes — pick by how the work runs:

- **Interactive / multi-turn drive** (you revise papers across several of your own turns): call `fork.overseer.activate` with `{ sessionKey, task: "<user's original request, verbatim>" }` FIRST. The Overseer (`src/fork/overseer.ts`) checks after each turn whether **every** actionable paper was revised AND compiled, and nudges (right-anchored electric-blue `⟦OVERSEER⟧` bubble, bounded by a derived budget — not a fixed count) until done.
- **Single background ultracode run** (one `Workflow` call fans out all papers): the workflow returns a per-paper result array — that IS the completion signal. Do NOT rely on the Overseer here (it watches _your_ turns, and would fire prematurely while the run is still in flight). Instead, when the run returns, run a **completeness check**: diff the returned results against the requested folder list, and re-launch `mode:full` for any paper that is missing or has `ok:false`. The pilot proved this self-report is reliable; the diff is the guarantee.

Skip both for a `triage`-only run — there is nothing to enforce yet.

### 1. Triage (read-only fan-out)

**Tools:** read, glob
**Done when:** Each paper classified `actionable` / `seed-only` / `cleared`; work-list reported

Invoke the workflow with `{ mode: "triage" }`. One agent per paper folder reads `improvement_notes.md` + the latest dated `YYYY-MM-DD-*.md` and applies the Step-0 gate from `revise-paper`. Surface the list: how many actionable, which are skipped and why. **Pause for user go before the write phase** — the next phase rewrites real papers and burns real tokens.

### 2. Revise (per actionable paper)

**Tools:** read, edit, write
**Done when:** Each actionable paper has a NEW versioned `.md` incorporating its notes

Pipeline stage 1 = `revise-paper` Steps 1–6 per paper. Bump the version (never overwrite). Each paper folder is independent → no write conflicts, no worktree needed.

### 3. Compile (per revised paper)

**Tools:** exec, write
**Done when:** Each revised `.md` has a Serra PDF; failures reported, not fatal

Pipeline stage 2 = `compile-paper` Steps 1–7 per paper: generate missing figures (TikZ/matplotlib from `diagram-suggestions.md`, or the `d2-diagrams`/`napkin-diagrams` skills), `md-to-tex.sh`, enrich `refs.bib`, `build-paper.sh`. A compile failure drops that paper to a reported error — it does not abort the batch.

### 4. Aggregate + report

**Tools:** read
**Done when:** One table: paper → revised? → PDF path → pages → warnings → skipped-reason

Collect every pipeline result. Report per paper. The Overseer reads this to judge completion; if any actionable paper lacks a PDF, it nudges and the loop continues.

## Constraints

- Triage runs before any write, always. Never start the `full` phase without showing the work-list first.
- Version outputs (`-vX.Y+1`), never overwrite an existing paper version.
- Pipeline, not barrier: do not block all compiles on all revisions finishing. Slowest single paper sets wall-clock, not slowest-stage × N.
- One paper failing (revise or compile) must not abort the others — isolate to a reported null.
- Do NOT touch `build-paper.sh` or `serra-paper.sty`.

## Safety Notes

- This phase rewrites the user's research papers and regenerates PDFs. Both are reversible (new version files; PDFs rebuild), but the token cost of N × deep-revise + compile is large — get explicit go after triage (Rule 9: resource awareness).
- Generated diagrams are drafts; the user reviews before they ship in a final paper.
- The recipe `.md` is live-selectable only after a gateway restart (recipes load on startup). Driving via the `Workflow` tool directly needs no restart — the script is the executable, the recipe is the playbook.

## Failures Overcome

- **Bulk was nobody's job:** `revise-paper` and `compile-paper` both explicitly punt fan-out to "a separate recipe later." This is that recipe — the orchestration spine they assume exists.
- **Rewriting cleared papers:** Without a triage gate, a batch run wastes a deep pass on papers whose notes are seed-only (J15) or already addressed (J13). Step 1 filters them out before the expensive phase.
- **Silent paper drop:** A subagent that dies mid-batch can leave a paper un-built with no error surfaced. The Overseer (Step 0) re-checks completion against the original task and nudges until every actionable paper has a PDF — the supervision the user explicitly asked for.
- **Stage barrier waste:** A naive `revise-all-then-compile-all` blocks fast papers behind the slowest reviser. The `pipeline()` model lets each paper flow revise→compile independently.
