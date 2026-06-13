---
schema: "kit/1.0"
slug: "verification-gate"
title: "Verification gate (evidence before claiming done)"
summary: "Evidence-based verification before claiming completion. Identify which commands prove each claim, run them fresh, read the full output, and only then claim — with the evidence attached. No 'should pass', no stale runs, no trusting a subagent's own report."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags: ["verify", "done", "complete", "finished", "ready to merge", "ship", "are you sure it works"]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
---

# Verification gate (evidence before claiming done)

> Prove work is complete with fresh evidence. No claims without running the
> command and reading the output in THIS session.

## Goal

Prove work is complete with fresh evidence. No claims without running the
command and reading the output.

## When to Use

- About to say "done", "complete", "finished", "ready to merge", or "ship"
- Asked "are you sure it works?"
- A subagent reports success and you are about to relay it

## Steps

### 1. Identify

**Done when:** Know which commands prove each claim.

For every claim you are about to make, name the exact command whose output
would prove it (see the Verification Table below).

### 2. Run

**Done when:** All verification commands executed fresh.

Run each command now, in this session. A run from before the latest change
does not count.

### 3. Read

**Done when:** Full output reviewed, exit codes checked.

Read the whole output, not just the tail. Check exit codes explicitly.

### 4. Claim

**Done when:** Claim stated WITH evidence, or actual status reported honestly.

State the claim together with the evidence that backs it. If the evidence is
missing or contradicts the claim, report the actual status instead.

## Verification Table

| Claim           | Requires                | NOT Sufficient              |
| --------------- | ----------------------- | --------------------------- |
| Tests pass      | Test output: 0 failures | Previous run, "should pass" |
| Build succeeds  | Build: exit 0           | Linter passing              |
| Bug fixed       | Reproduce: gone         | "Code looks correct"        |
| Agent completed | Read actual changes     | Agent's report              |

## Red Flags — STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction BEFORE verification
- Trusting a sub-agent's report without independent check

## Constraints

- NEVER claim without fresh evidence from THIS session
- One verification round minimum — even for "obvious" changes

## Failures Overcome

- Claiming from stale evidence: a test run that predates the latest change was
  cited as proof; the gate now requires every verification command to be re-run
  fresh in the current session before any claim.
- Trusting subagent reports: a subagent's "completed" summary was relayed
  without independently reading the actual changes; the gate now requires
  reading the real diff/output, never the agent's own report.
- v1.0 resurrected 2026-06-13 from commit a239df31a4^.
