---
schema: recipe/1.0
id: reconcile-paper-chain
title: Reconcile Paper Chain
category: writing
summary: Before building or publishing a paper, diff every link in its chain — canonical md ↔ build md ↔ published PDF ↔ landing page ↔ blog post — and refuse to proceed on an unresolved divergence
triggers:
  [
    reconcile paper,
    paper chain,
    before publish,
    stale fork,
    which version is canonical,
    "is this the latest",
    divergence check,
    pre-publish gate,
  ]
effort: medium
tools: [read, grep, glob, exec]
children: []
---

## Goal

Guarantee that the version you are about to build/publish is the _intended_ one, by checking that all representations of a paper agree before any irreversible step. Prevent the failure where edits are made to a stale fork and a build silently regresses the published artifact.

## When to Use

- **Before** {{compile-paper}} or {{publish-paper}} on any paper that has more than one on-disk representation.
- When unsure which file is canonical, or after long gaps between edits.
- Any time a paper exists in BOTH the source repo (`tinkerclaw/docs/papers/<slug>/`) AND a separate build folder (`~/Documents/AI_reports/Papers/J*/`).

Not for: a brand-new paper with a single source file and no prior publish.

## The chain

```
notes/improvement_notes  →  CANONICAL md (tinkerclaw/docs/papers/<slug>/)
   →  BUILD md (AI_reports/Papers/J*/<dated>.md)  →  PDF (dated)
   →  published PDF (sprintpaper protected/papers/J<n>.pdf)
   →  landing page (sprintpaper web/.../index.html + papers.json)
   →  blog post (thetinkerzone)
```

Each arrow is a place the two ends can silently disagree.

## Steps

### 1. Locate every representation

**Tools:** glob, grep
**Done when:** Every on-disk md, the latest dated build md, the published PDF, and the landing/blog references are listed with sizes + mtimes

### 2. Diff canonical vs build lineage (the load-bearing check)

**Tools:** exec, read
**Done when:** Section-header diff between the canonical md and the latest dated build md is clean, OR every difference is explained

Compare _section structure_, not just byte size: `diff <(grep -E '^#{1,3} ' A.md) <(grep -E '^#{1,3} ' B.md)`. A canonical file that LACKS sections present in the build lineage is a **stale fork** — the build lineage advanced and was never synced back. STOP and surface it; do not let a build proceed on the lacking side. The fix is a cherry-pick/merge decision the user must make (which side is base, what to carry forward), not an automatic overwrite.

### 3. Confirm the published artifact's provenance

**Tools:** exec
**Done when:** The live PDF is matched (by size/hash) to a known build version, so "what is currently published" is established before changing it

`ls -la` the published PDF and compare to the dated build PDFs. Knowing the live version is what makes "am I about to regress it?" answerable.

### 4. Check the surface metadata agrees

**Tools:** grep
**Done when:** Title/version/hook in `papers.json`, the landing `index.html`, and the blog post all match the version you intend to publish

### 5. Verdict

**Tools:** (none)
**Done when:** Either "chain consistent → proceed" or "divergence at <link> → resolve before build/publish"

Emit an explicit verdict. On divergence, name the link and the decision required. Never silently proceed.

## Constraints

- This recipe READS and DIFFS; it does not edit or merge. Reconciliation (cherry-pick/merge) is a user-gated decision.
- Treat the published PDF as ground truth for "what is live" — never assume the newest local file is published.
- A divergence is a hard stop for any irreversible downstream step.

## Safety Notes

- Publishing a regressed paper to a public site is hard to fully reverse (caches, downloaded PDFs). This gate exists precisely to prevent that.

## Failures Overcome

- **Stale-fork regression (2026-06-18, J10):** three editing rounds landed on a `tinkerclaw` copy that was a v1.1 fork; the build lineage had advanced to v1.8 with a whole Related-Work section, evals, and retrieval the fork lacked. Building the fork would have stripped them from the live paper. A section-header diff (Step 2) catches this in one command. Pairs with {{papers-staleness-audit}} (which covers improvement-notes staleness; this covers cross-representation divergence).
