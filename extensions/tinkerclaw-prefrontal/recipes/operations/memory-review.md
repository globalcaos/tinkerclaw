---
schema: recipe/1.0
id: memory-review
title: Memory Hygiene Review
category: operations
summary: Audit all memory layers — classify entries, detect duplicates, resolve contradictions, promote or archive
triggers: [memory review, clean memory, memory hygiene, audit memory, organize memory, dream, remember]
effort: standard
tools: [read, grep, glob, edit, write, memory_search, memory_get]
children: []
---

## Goal
Review all memory layers, classify every entry, detect stale/duplicate/contradictory entries, and produce a structured cleanup — either auto-applied (reversible) or presented for approval (destructive).

## When to Use
- Nightly maintenance (automated via cron)
- When memory files feel bloated or contradictory
- After a big project wraps up (archive completed items)
- When the user says "clean up memory" or "what do you remember about X"

## Steps

### 1. Gather All Memory Layers
**Tools:** read, memory_search
**Done when:** Complete inventory of all memory content

Read and inventory:
- `MEMORY.md` — the index (should be pointers, not content)
- `memory/*.md` — daily logs
- `memory/knowledge/*.md` — topic files (operational-lessons, oscar-preferences, etc.)
- `memory/projects-master.md` — project tracking
- `bank/contacts.md`, `bank/opinions.md` — structured data

### 2. Classify Each Entry
**Tools:** read
**Done when:** Every substantive entry has a classification

For each entry, determine:

| Classification | Meaning | Action |
|---|---|---|
| **Current** | Still accurate, actively useful | Keep |
| **Stale** | Superseded by newer information | Update or archive |
| **Duplicate** | Same fact in multiple places | Consolidate to one location |
| **Contradictory** | Conflicts with another entry | Resolve — newer wins unless context says otherwise |
| **Completed** | Action item that's done | Archive or remove |
| **Misplaced** | Correct info, wrong file | Move to correct location |

### 3. Detect Cross-Layer Issues
**Tools:** grep, memory_search
**Done when:** All conflicts and duplicates identified

Scan for:
- **Duplicates**: Same fact in daily log AND knowledge file → keep knowledge file version
- **Contradictions**: Daily log says "the user prefers X" but knowledge file says "the user prefers Y" → newer wins
- **Orphaned references**: MEMORY.md points to a file that doesn't exist
- **Bloated index**: MEMORY.md contains actual content instead of pointers (max 200 lines)

### 4. Execute Cleanup
**Tools:** edit, write
**Done when:** All safe changes applied, destructive changes proposed

**Auto-apply (reversible):**
- Move misplaced entries to correct files
- Consolidate duplicates (keep the richer version)
- Update MEMORY.md index to match actual files
- Archive completed items from daily logs older than 7 days

**Propose to the user (destructive):**
- Deleting entries classified as stale
- Resolving contradictions where it's ambiguous which is correct
- Removing files entirely

### 5. Report
**Done when:** Summary delivered

Output:
- Entries reviewed (count)
- Auto-applied changes (list)
- Proposed changes awaiting approval (list)
- Memory health score: clean / needs-attention / bloated

## Constraints
- NEVER delete memory files without the user's approval
- Consolidation keeps the RICHER version, not the older one
- MEMORY.md stays under 200 lines — it's an index, not a store
- Daily logs older than 7 days get archived, not deleted
- When resolving contradictions: newer entry wins UNLESS the older entry has more context

## Safety Notes
- Memory is identity. Treat deletions as irreversible even if technically they aren't.
- When in doubt about whether something is stale, keep it and flag for the user.
- Back up any file before making bulk edits.

## Failures Overcome
- **Aggressive cleanup**: Agent deletes entries that seem stale but the user still needs. The propose-don't-delete constraint prevents data loss.
- **Index bloat**: MEMORY.md grows to 500 lines of actual content. The 200-line cap and "pointers only" rule prevent this.
- **Recency bias**: Agent assumes the newest entry is always right. The "more context wins" exception handles cases where a quick correction was itself wrong.
