---
schema: recipe/1.0
id: verify
title: Verification Gate
category: coding
summary: Evidence-based verification before claiming completion
triggers: [verify, done, complete, finished, ready to merge, ship]
effort: quick
tools: [exec, read]
children: []
---

## Goal
Prove work is complete with fresh evidence. No claims without running the command and reading the output.

## Steps

### 1. Identify
**Tools:** read
**Done when:** Know which commands prove each claim

### 2. Run
**Tools:** exec
**Done when:** All verification commands executed fresh

### 3. Read
**Tools:** read
**Done when:** Full output reviewed, exit codes checked

### 4. Claim
**Done when:** Claim stated WITH evidence, or actual status reported honestly

## Verification Table

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| Tests pass | Test output: 0 failures | Previous run, "should pass" |
| Build succeeds | Build: exit 0 | Linter passing |
| Bug fixed | Reproduce: gone | "Code looks correct" |
| Agent completed | Read actual changes | Agent's report |

## Red Flags — STOP
- Using "should", "probably", "seems to"
- Expressing satisfaction BEFORE verification
- Trusting a sub-agent's report without independent check

## Constraints
- NEVER claim without fresh evidence from THIS session
- One verification round minimum — even for "obvious" changes
