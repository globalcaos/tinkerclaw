---
schema: recipe/1.0
id: dream
title: Nightly Dream — Memory Distillation
category: operations
summary: Distill daily logs into topic files and update the MEMORY.md index
triggers: [dream, distill, nightly memory, consolidate logs, wind down]
effort: standard
tools: [read, grep, glob, edit, write, memory_search]
children: [memory-review]
---

## Goal
Process recent daily logs, extract durable knowledge, consolidate into topic files, update the MEMORY.md index, and archive processed logs. This is the memory equivalent of sleeping — organizing the day's experiences into long-term memory.

## When to Use
- Nightly cron (automated, runs after training)
- End of a long session
- When daily logs are piling up (>5 unprocessed days)
- Wind-down routine

## Steps

### 1. Identify Unprocessed Logs
**Tools:** read, glob
**Done when:** List of daily log files to process

Find daily logs in `memory/` that haven't been distilled. Check for a `<!-- DISTILLED -->` marker at the top — if present, skip. Process oldest first.

### 2. Extract Durable Knowledge
**Tools:** read
**Done when:** Each log's extractable items identified

For each unprocessed log, identify:
- **Decisions**: Architecture choices, preference changes, approvals
- **Corrections**: Things the user corrected or Jarvis got wrong
- **New contacts**: People, companies, relationships
- **Project updates**: Status changes, milestones, blockers
- **Operational lessons**: Patterns that should inform future behavior
- **Preferences**: How the user wants things done

Skip: routine briefing data, transient status updates, one-off debugging steps.

### 3. Consolidate into Topic Files
**Tools:** read, edit, write
**Done when:** All durable items written to appropriate topic files

Route each extracted item to the right file:
- Decisions → `memory/knowledge/` relevant topic file
- Corrections → `memory/knowledge/operational-lessons.md`
- Contacts → `bank/contacts.md`
- Project updates → `memory/projects-master.md`
- Preferences → `memory/knowledge/oscar-preferences.md`

If the topic file doesn't exist, create it. If the item updates an existing entry, REPLACE the old entry (don't append a duplicate).

### 4. Update MEMORY.md Index
**Tools:** read, edit
**Done when:** Index reflects current topic files

Ensure every topic file in `memory/knowledge/` has a one-line pointer in MEMORY.md. Remove pointers to files that no longer exist. Keep under 200 lines.

### 5. Mark Logs as Distilled
**Tools:** edit
**Done when:** Processed logs marked

Prepend `<!-- DISTILLED YYYY-MM-DD -->` to each processed log. Don't delete them — they're the source of truth if distillation went wrong.

### 6. Archive Old Logs
**Tools:** exec
**Done when:** Logs older than 14 days moved to archive

Move daily logs older than 14 days to `memory/archive/daily/`. They're distilled and rarely accessed.

## Constraints
- Process oldest logs first — chronological order matters for contradiction resolution
- NEVER delete daily logs — mark and archive only
- Topic files use REPLACE semantics for updates, not APPEND
- MEMORY.md stays under 200 lines
- If extraction is ambiguous, keep the original wording from the log

## Safety Notes
- If a daily log mentions something the user said to remember, it MUST be extracted — don't skip it
- Contradictions between older and newer logs: newer wins (the user's preferences evolve)
- Don't consolidate across unrelated topics just because they were in the same daily log

## Failures Overcome
- **Lost memories**: Agent marks log as distilled but didn't actually extract key items. The `<!-- DISTILLED -->` marker only goes in AFTER extraction is verified.
- **Topic file bloat**: Agent appends every bullet from every day. The REPLACE semantics keep files focused on current state, not history.
- **Over-archival**: Agent archives logs before distilling. Archive only runs AFTER the distilled marker is confirmed present.
