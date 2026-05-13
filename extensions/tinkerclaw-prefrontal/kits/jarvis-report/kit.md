---
schema: "kit/1.0"
slug: "jarvis-report"
title: "Jarvis Report"
summary: "Structured incident or activity report for Jarvis — copy-pasteable format"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags:
  ["communication", "report for jarvis", "structured report", "incident report", "jarvis report"]
tools: ["exec", "read", "grep", "glob"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "report for jarvis | structured report | incident report | jarvis report",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: report for jarvis, structured report, incident report, jarvis report",
    },
  ]
---

## Goal

Produce a structured, copy-pasteable report following Jarvis's standard format for incidents, changes, or activity summaries.

## When to Use

- Incident post-mortem
- Major change summary
- Activity report for review
- When the user asks for a "report"

## Steps

### 1. Gather

**Tools:** exec, read, grep, glob
**Done when:** All relevant evidence collected

Collect from all sources:

- Git log and diffs for code changes
- Gateway logs for runtime events
- Configuration file changes
- Memory files for context
- Error messages and stack traces

### 2. Analyze

**Done when:** Root cause (if incident) or rationale (if change) understood

For incidents: trace the causal chain from trigger to impact.
For changes: document what changed, why, and what it affects.
Identify all affected systems and downstream effects.

### 3. Structure

**Done when:** Report follows standard format

Format as:

```
## [Title]

### Incident / Change
[1-2 sentence summary of what happened or what changed]

### Root Cause
[What caused the issue, or what motivated the change]

### Changes Made
- [file: what changed and why]
- [file: what changed and why]

### Rationale
[Why this approach was chosen over alternatives]

### Impact
[What's affected, what users will notice]

### Suggested Actions
- [ ] [follow-up action with owner]
- [ ] [monitoring or verification step]

### Lessons Learned
[What to do differently next time]
```

### 4. Deliver

**Done when:** Report presented, ready for copy-paste

Present the complete report in a single code block or structured markdown. Ensure it's self-contained -- readable without additional context. Include file paths as absolute paths.

## Constraints

- Self-contained -- no external context needed to understand
- Use absolute file paths
- Include specific evidence (commit hashes, log lines, file:line references)
- Copy-pasteable format -- no interactive elements

## Safety Notes

- Redact credentials and tokens from evidence
- Don't include full stack traces unless relevant to root cause
- Verify facts against actual code/logs before including

## Failures Overcome

- **Vague report:** Agent writes "fixed the issue" without specifics. Structure requires evidence for each claim.
- **Missing root cause:** Agent describes symptoms but not why they happened. Analysis step requires causal chain before structuring.
- **Not copy-pasteable:** Report has relative paths or references to "the file I showed earlier." Self-contained constraint prevents this.
