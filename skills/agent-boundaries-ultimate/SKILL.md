---
name: agent-boundaries-ultimate
description: "Reference material only, not a runnable skill: a contributor guide explaining how to submit a real-world AI agent boundary, privacy or safety lesson to this repository, with a fill-in template, quality bar and review process. Read it when writing up such a lesson; it contains no boundary rules to follow at runtime."
---

# agent-boundaries-ultimate

## What this is

This directory holds one file, `CONTRIBUTE.md`. It is a contributor guide: it
explains how someone can submit a lesson learned about AI agent boundaries,
privacy or safety, and it gives the markdown template that submission should
use, the categories to tag it with (privacy/OPSEC, authorization, inter-agent
communication, resource consumption, publishing, other), what counts as a good
or bad submission, and how submissions are reviewed.

There is no SKILL body, no script, no data file and no executable entry point
here. `CONTRIBUTE.md` refers to a `COMMUNITY-LESSONS.md` in this same directory
as the place contributions get added, but that file is not present in the
repository and never has been. So the guide describes a collection process whose
collection is not in this directory.

This SKILL.md exists so the file is loadable and honestly labelled. It does not
add behaviour.

## When to use

- You are writing up an incident or near-miss about agent boundaries and want
  the expected format, categories and quality bar before opening an issue or PR.
- You are reviewing such a submission and want the stated acceptance criteria.

## When not to use

- You want rules an agent should follow about privacy, authorization, resource
  use or publishing. This directory does not contain any. The guide is about
  contributing lessons, not about applying them.
- You want the collected lessons. `COMMUNITY-LESSONS.md` is referenced but
  absent, so there is nothing here to read.
- You want something to execute. There is no command to run.

## Entry points

| File            | What it is                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CONTRIBUTE.md` | The contributor guide: submission routes, lesson template, quality criteria, review process, two worked examples. |

Read it directly:

```
cat skills/agent-boundaries-ultimate/CONTRIBUTE.md
```

The guide names two submission routes: open an issue labelled
`community-lesson` on this repository's GitHub issue tracker, or fork the
repository and add the lesson to `skills/agent-boundaries-ultimate/COMMUNITY-LESSONS.md`
in a pull request. Both routes are actions the operator takes on GitHub; nothing
in this directory performs them.

## Permissions & Data Flow

- **Reads:** one local markdown file, `CONTRIBUTE.md`, in this directory.
- **Writes:** nothing. No file in this directory writes anywhere.
- **Network:** none. The guide contains a link to a GitHub issue tracker, but
  no code here fetches it; following the link is a manual step by the operator.
- **Credentials:** none read, stored or required.
- **Note on data the operator supplies:** submitting a lesson by either route
  publishes its text publicly on GitHub. The guide itself asks contributors to
  scrub names, companies and identifiers before submitting. That scrubbing is
  manual and unenforced — nothing here checks it.
