---
schema: recipe/1.0
id: daily-report
title: Daily Report
category: communication
summary: Gather status, summarize, format, deliver — concise daily status update
triggers: [daily, status, standup, "what happened", "daily report", "status update"]
effort: light
tools: [exec, read, grep]
children: []
---

## Goal

Produce a concise, informative daily status report covering what happened, what's in progress, and what's next.

## When to Use

- Morning standup preparation
- End-of-day summary
- Status check after being away
- Handoff between work sessions

## Steps

### 1. Gather

**Tools:** exec, read, grep
**Done when:** Activity data collected from all sources

Collect data from:

- `git log --since="24 hours ago" --oneline` for recent commits
- Open issues or tasks in progress
- Gateway logs for incidents or errors
- Any pending merge or deploy activities
- Memory files for session context

### 2. Summarize

**Done when:** Key points extracted, noise filtered

Identify:

- What was completed (commits, fixes, features)
- What's in progress (active branches, pending PRs)
- What's blocked (waiting on upstream, dependencies, decisions)
- Any incidents or notable events

### 3. Format

**Done when:** Structured report ready

Format as:

```
## Status - [date]

### Completed
- [item with brief context]

### In Progress
- [item with current state]

### Blocked / Needs Attention
- [item with what's needed]

### Next Steps
- [prioritized list]
```

### 4. Deliver

**Done when:** Report shared in requested format

Present the report directly. Keep it scannable -- bullet points, not paragraphs. Lead with the most important items. If nothing notable happened, say so briefly.

## Constraints

- Keep it concise -- under 20 bullet points total
- Focus on what's meaningful, not exhaustive
- Include blockers prominently -- they need attention
- No filler -- "quiet day" is a valid report

## Safety Notes

- Don't include credentials or secrets in status reports
- Redact specific error messages that might contain sensitive data

## Failures Overcome

- **Exhaustive log dump:** Agent lists every commit message without context. Summary step requires extracting meaning, not listing activity.
- **Missing blockers:** Agent reports completions but omits what's stuck. Explicit "blocked" section prevents this.
