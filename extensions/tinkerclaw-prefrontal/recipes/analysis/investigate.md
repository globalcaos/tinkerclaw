---
schema: recipe/1.0
id: investigate
title: Investigate
category: analysis
summary: Gather information, analyze, report findings
triggers: [investigate, analyze, check, "look into", "find out", "what is", "why does", "how does"]
effort: standard
tools: [read, grep, glob, exec]
children: []
---

## Goal
Answer a question or understand a system by systematically gathering and analyzing evidence.

## When to Use
- Understanding how a system works
- Answering "why does X happen?"
- Researching before making changes
- Debugging without a clear bug

## Steps

### 1. Scope
**Done when:** Clear question defined with boundaries

Define exactly what we're trying to learn. Identify what we already know. Set boundaries -- what's in scope and what's not. Determine what "answered" looks like.

### 2. Gather
**Tools:** read, grep, glob, exec
**Done when:** Evidence collected from multiple sources

Search broadly first, then narrow down. Use multiple strategies:
- Grep for keywords, function names, error messages
- Glob for file patterns
- Read specific files for context
- Check git log for recent changes
- Run commands to observe runtime behavior

### 3. Analyze
**Done when:** Evidence synthesized into an answer

Connect the dots. Build a mental model of how the system works. Identify cause-and-effect relationships. Note any contradictions or gaps in understanding. Distinguish facts from hypotheses.

### 4. Report
**Done when:** Concise report delivered with evidence

**Before presenting: resolve any uncertainty that could invalidate the conclusion.** If an assumption is load-bearing — i.e. if it were wrong the answer would flip — close it FIRST (search the web, run the calc, fetch the source), then report. A caveat that "could render the analysis wrong" is a prerequisite, not a footnote. Never bury it at the end; if it cannot be resolved, it leads the report, not trails it.

Present findings clearly:
- The load-bearing assumption, stated and resolved up front (or flagged as unresolved if it genuinely can't be closed)
- Direct answer to the question
- Supporting evidence (file paths, code snippets, log entries)
- Confidence level (certain, likely, uncertain)
- Follow-up questions or areas of remaining uncertainty

## Constraints
- Don't guess -- follow evidence
- Report confidence levels honestly
- **Resolve material assumptions before concluding.** If a few tokens of web search, a calc, or a fetch can close a gap that affects the answer, do it — reporting ignorance you could have closed is a failure, not honesty.
- **Lead with the analysis-invalidating uncertainty, never trail it.** The thing that could flip the conclusion goes first.
- If the answer requires reading 20+ files, narrow the scope first
- Stop when the question is answered, don't keep exploring

## Safety Notes
- Don't run destructive commands during investigation
- Don't modify files while investigating
- Note if investigation reveals security concerns

## Failures Overcome
- **Rabbit hole exploration:** Agent keeps reading files without converging on an answer. Scoping and bounded gather steps prevent this.
- **Premature conclusion:** Agent reads one file and reports a conclusion. Must check multiple sources before synthesizing.
- **Correlation as causation:** Agent sees two things happening together and assumes one causes the other. Analysis step requires explicit cause-and-effect reasoning.
- **Buried invalidating caveat:** Agent presents a confident conclusion, then trails a caveat that — if true — would flip it ("assuming the concentration is ~100%..."). The caveat should have led the report AND been resolved (a quick search confirmed pool granulate is 90-99% bisulfate). Resolve-then-lead, never conclude-then-hedge. (ph-minus value analysis, 2026-05-29)
