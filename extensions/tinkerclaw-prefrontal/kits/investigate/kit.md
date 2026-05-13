---
schema: "kit/1.0"
slug: "investigate"
title: "Investigate"
summary: "Gather information, analyze, report findings"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags:
  [
    "analysis",
    "investigate",
    "analyze",
    "check",
    "look into",
    "find out",
    "what is",
    "why does",
    "how does",
  ]
tools: ["read", "grep", "glob", "exec"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "investigate | analyze | check | look into | find out | what is | why does | how does",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: investigate, analyze, check, look into, find out, what is, why does, how does",
    },
  ]
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

Present findings clearly:

- Direct answer to the question
- Supporting evidence (file paths, code snippets, log entries)
- Confidence level (certain, likely, uncertain)
- Follow-up questions or areas of remaining uncertainty

## Constraints

- Don't guess -- follow evidence
- Report confidence levels honestly
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
