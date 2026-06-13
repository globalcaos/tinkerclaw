---
schema: "kit/1.0"
slug: "memory-dream"
title: "Nightly dream — distill daily logs into long-term memory"
summary: "Process unprocessed daily logs oldest-first, extract durable knowledge (decisions, corrections, contacts, project updates, preferences), consolidate into topic files with REPLACE semantics, refresh the one-line memory index, then mark and archive. Never deletes a log."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "dream",
    "distill",
    "nightly memory",
    "consolidate logs",
    "memory consolidation",
    "wind down",
    "daily logs piling up",
    "update memory index",
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
    - [5]
params:
  memory_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/memory",
      description: "Root of the agent's file-based memory tree (daily logs, knowledge/, archive/).",
    }
  index_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/MEMORY.md",
      description: "The memory index file — one-line pointers only, loaded every session.",
    }
---

# Nightly dream — distill daily logs into long-term memory

> The memory equivalent of sleeping: organize the day's experiences into
> long-term memory. Distill daily logs into topic files, update the index,
> mark and archive — never delete.

## Goal

Process recent daily logs under {{memory_dir}}, extract durable knowledge,
consolidate it into topic files, update the {{index_file}} index, and archive
processed logs.

## When to Use

- Nightly cron (automated, runs after training)
- End of a long session
- When daily logs are piling up (>5 unprocessed days)
- Wind-down routine

## Steps

### 1. Identify unprocessed logs

**Done when:** List of daily log files to process, ordered oldest-first.

Find daily logs in {{memory_dir}} that haven't been distilled. Check for a
`<!-- DISTILLED -->` marker at the top — if present, skip. Process oldest
first.

### 2. Extract durable knowledge

**Done when:** Each log's extractable items identified.

For each unprocessed log, identify:

- **Decisions**: architecture choices, preference changes, approvals
- **Corrections**: things the operator corrected or the agent got wrong
- **New contacts**: people, companies, relationships
- **Project updates**: status changes, milestones, blockers
- **Operational lessons**: patterns that should inform future behavior
- **Preferences**: how the operator wants things done

Skip: routine briefing data, transient status updates, one-off debugging
steps.

### 3. Consolidate into topic files

**Done when:** All durable items written to appropriate topic files.

Route each extracted item to the right file:

- Decisions → `{{memory_dir}}/knowledge/` relevant topic file
- Corrections → `{{memory_dir}}/knowledge/operational-lessons.md`
- Contacts → `{{memory_dir}}/contacts.md`
- Project updates → `{{memory_dir}}/projects-master.md`
- Preferences → `{{memory_dir}}/knowledge/operator-preferences.md`

If the topic file doesn't exist, create it. If the item updates an existing
entry, REPLACE the old entry (don't append a duplicate).

### 4. Update the memory index

**Done when:** {{index_file}} reflects current topic files.

Ensure every topic file in `{{memory_dir}}/knowledge/` has a one-line pointer
in {{index_file}}. Remove pointers to files that no longer exist. Keep under
200 lines.

### 5. Mark logs as distilled

**Done when:** Processed logs marked.

Prepend `<!-- DISTILLED YYYY-MM-DD -->` to each processed log. Don't delete
them — they're the source of truth if distillation went wrong.

### 6. Archive old logs

**Done when:** Logs older than 14 days moved to archive.

Move daily logs older than 14 days to `{{memory_dir}}/archive/daily/`.
They're distilled and rarely accessed.

## Constraints

- Process oldest logs first — chronological order matters for contradiction
  resolution.
- NEVER delete daily logs — mark and archive only.
- Topic files use REPLACE semantics for updates, not APPEND.
- {{index_file}} stays under 200 lines.
- If extraction is ambiguous, keep the original wording from the log.

## Safety Notes

- If a daily log mentions something the operator said to remember, it MUST be
  extracted — don't skip it.
- Contradictions between older and newer logs: newer wins (the operator's
  preferences evolve).
- Don't consolidate across unrelated topics just because they were in the
  same daily log.

## Failures Overcome

- **Lost memories**: the agent marks a log as distilled but didn't actually
  extract key items. The `<!-- DISTILLED -->` marker only goes in AFTER
  extraction is verified.
- **Topic file bloat**: the agent appends every bullet from every day. The
  REPLACE semantics keep files focused on current state, not history.
- **Over-archival**: the agent archives logs before distilling. Archive only
  runs AFTER the distilled marker is confirmed present.
- v1.0: resurrected 2026-06-13 from commit a239df31a4^ (deleted
  `operations/dream.md`), rewritten as a kit/1.0 skeleton — operator-specific
  names and hardcoded paths scrubbed into {{memory_dir}}/{{index_file}}
  params per the skeleton+variables rule.
