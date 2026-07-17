---
schema: "kit/1.0"
slug: "memory-hygiene-review"
title: "Memory hygiene review (classify, dedupe, resolve, archive)"
summary: "Audit every layer of the agent's file-based memory — classify each entry (current/stale/duplicate/contradictory/completed/misplaced), detect cross-layer conflicts, auto-apply reversible fixes, and propose destructive ones for approval. Memory is identity: nothing is deleted without the operator's sign-off."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
subdivision: "memory"
tags:
  [
    "memory review",
    "clean memory",
    "memory hygiene",
    "audit memory",
    "organize memory",
    "dream",
    "remember",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
params:
  memory_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/memory",
      description: "Root of the agent's file-based memory tree.",
    }
  index_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/MEMORY.md",
      description: "The memory index — pointers only, max ~200 lines.",
    }
---

# Memory hygiene review (classify, dedupe, resolve, archive)

> Review all memory layers, classify every entry, detect stale/duplicate/
> contradictory entries, and produce a structured cleanup — reversible changes
> auto-applied, destructive changes presented for the operator's approval.

## Goal

Review all memory layers under {{memory_dir}} plus the index {{index_file}},
classify every entry, detect stale/duplicate/contradictory entries, and
produce a structured cleanup — either auto-applied (reversible) or presented
for approval (destructive).

## When to Use

- Nightly maintenance (automated via cron)
- When memory files feel bloated or contradictory
- After a big project wraps up (archive completed items)
- When the operator says "clean up memory" or "what do you remember about X"

## Steps

### 1. Gather All Memory Layers

**Done when:** Complete inventory of all memory content.

Read and inventory:

- {{index_file}} — the index (should be pointers, not content)
- `{{memory_dir}}/*.md` — daily logs
- `{{memory_dir}}/knowledge/*.md` — topic files (operational-lessons,
  operator-preferences, etc.)
- `{{memory_dir}}/projects-master.md` — project tracking (if present)
- Any structured data files under the memory tree (contact lists, opinion
  registers, watchlists, …)

### 2. Classify Each Entry

**Done when:** Every substantive entry has a classification.

For each entry, determine:

| Classification    | Meaning                         | Action                                             |
| ----------------- | ------------------------------- | -------------------------------------------------- |
| **Current**       | Still accurate, actively useful | Keep                                               |
| **Stale**         | Superseded by newer information | Update or archive                                  |
| **Duplicate**     | Same fact in multiple places    | Consolidate to one location                        |
| **Contradictory** | Conflicts with another entry    | Resolve — newer wins unless context says otherwise |
| **Completed**     | Action item that's done         | Archive or remove                                  |
| **Misplaced**     | Correct info, wrong file        | Move to correct location                           |

### 3. Detect Cross-Layer Issues

**Done when:** All conflicts and duplicates identified.

Scan for:

- **Duplicates**: Same fact in daily log AND knowledge file → keep the
  knowledge file version
- **Contradictions**: Daily log says "the operator prefers X" but a knowledge
  file says "the operator prefers Y" → newer wins
- **Orphaned references**: {{index_file}} points to a file that doesn't exist
- **Bloated index**: {{index_file}} contains actual content instead of
  pointers (max 200 lines)

### 4. Execute Cleanup

**Done when:** All safe changes applied, destructive changes proposed.

**Auto-apply (reversible):**

- Move misplaced entries to correct files
- Consolidate duplicates (keep the richer version)
- Update the {{index_file}} index to match actual files
- Archive completed items from daily logs older than 7 days

**Propose to the operator (destructive):**

- Deleting entries classified as stale
- Resolving contradictions where it's ambiguous which is correct
- Removing files entirely

### 5. Report

**Done when:** Summary delivered.

Output:

- Entries reviewed (count)
- Auto-applied changes (list)
- Proposed changes awaiting approval (list)
- Memory health score: clean / needs-attention / bloated

## Constraints

- NEVER delete memory files without the operator's approval
- Consolidation keeps the RICHER version, not the older one
- {{index_file}} stays under 200 lines — it's an index, not a store
- Daily logs older than 7 days get archived, not deleted
- When resolving contradictions: newer entry wins UNLESS the older entry has
  more context

## Safety Notes

- Memory is identity. Treat deletions as irreversible even if technically
  they aren't.
- When in doubt about whether something is stale, keep it and flag for the
  operator.
- Back up any file before making bulk edits.

## Failures Overcome

- **Aggressive cleanup**: Agent deletes entries that seem stale but the
  operator still needs. The propose-don't-delete constraint prevents data
  loss.
- **Index bloat**: The index grows to 500 lines of actual content. The
  200-line cap and "pointers only" rule prevent this.
- **Recency bias**: Agent assumes the newest entry is always right. The
  "more context wins" exception handles cases where a quick correction was
  itself wrong.
- v1.0: resurrected 2026-06-13 from commit a239df31a4^ as a generic kit/1.0
  skeleton — host-specific paths moved into the memory_dir / index_file
  params, structured data files genericized per the skeleton+variables rule
  (subagents-and-recipes.md "Authoring recipes").
