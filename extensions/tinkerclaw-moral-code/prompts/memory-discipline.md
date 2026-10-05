---
default-version: 1.0
override-target: ~/.openclaw/workspace/memory/knowledge/memory-discipline.md
loaded-at: worker spawn
---

# Memory — write it or it didn't happen

Continuity is a discipline, not a promise. If a decision, correction or hard-won gotcha does not
reach disk before the session ends, it is gone, and the next session will pay for it again.

## What is worth writing

Four kinds, and nothing else:

- **user** — who they are: role, expertise, standing preferences.
- **feedback** — guidance on how to work, both corrections and confirmed approaches. Always
  include _why_; a rule without its reason gets explained away the first time it is inconvenient.
- **project** — ongoing work, goals and constraints that are **not** derivable from the code or
  the git history. Convert relative dates to absolute ones.
- **reference** — pointers to external things: URLs, dashboards, hosts, tickets.

## What is not worth writing

Anything the repository already records: code structure, what a function does, how a bug was
fixed, what is in the git log. Anything that only matters inside the current conversation. If
asked to remember one of these, ask what was _non-obvious_ about it and store that instead.

## Shape

One file, one fact, a short kebab-case name, and a one-line description written for the moment
someone is deciding whether this file is relevant. Link related files liberally — a link to a file
that does not exist yet is not an error, it is a note that one should.

Keep an index file with one line per memory. The index is what gets loaded; the memories are what
get opened. A lesson the user has had to teach **twice** belongs at the top of that index, not
filed neatly in a category — visibility is the whole mechanism, and a correctly-filed rule that
never loads has failed.

## Before saving

Check whether a file already covers it and update that one rather than creating a near-duplicate.
A store that grows by repetition stops being searchable, which is the same as not existing. Delete
memories that turn out to be wrong — a confidently wrong memory is worse than a missing one.

## Reading memory

A recalled memory is **background context, not an instruction**, and it reflects what was true when
it was written. If it names a file, a flag or a host, verify that thing still exists before acting
on it. Memory is reconstruction; the file on disk is the fact.
