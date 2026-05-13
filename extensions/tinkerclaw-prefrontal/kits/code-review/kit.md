---
schema: "kit/1.0"
slug: "code-review"
title: "Code Review"
summary: "Review changes for correctness, security, and quality"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["coding", "review", "check this", "look at this PR", "code review", "PR"]
tools: ["read", "grep", "glob", "exec"]
testedHarnesses: ["OpenClaw", "Claude Code"]
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "review | check this | look at this PR | code review | PR",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: review, check this, look at this PR, code review, PR",
    },
  ]
---

## Goal

Review code changes for correctness, security issues, and quality, providing actionable feedback.

## When to Use

- Pull request review
- Pre-commit review of staged changes
- Reviewing someone else's work before merge
- Self-review before pushing

## Steps

### 1. Read Changes

**Tools:** read, exec
**Done when:** All changes read and understood

Read the full diff. Use `git diff` for unstaged, `git diff --staged` for staged, or `git diff base...HEAD` for branch changes. Understand what changed and why.

### 2. Understand Context

**Tools:** read, grep
**Done when:** Surrounding code and impact understood

Read the files around the changed lines. Check callers of modified functions. Understand the feature or bug being addressed. Check if tests cover the changes.

### 3. Assess

**Done when:** Issues identified and categorized

Check for:

- **Correctness:** Does it do what it claims? Edge cases handled?
- **Security:** New inputs validated? Secrets exposed? Auth checked?
- **Style:** Follows codebase conventions? JSDoc headers present?
- **Performance:** N+1 queries? Unbounded loops? Memory leaks?
- **Maintainability:** Clear naming? No magic numbers? No dead code?

### 4. Report

**Done when:** Review delivered with actionable items

Present findings organized by severity. Distinguish blocking issues from suggestions. Be specific -- reference file:line. Suggest fixes, don't just point out problems.

## Constraints

- Don't nitpick style if the codebase doesn't have a consistent style
- Focus on correctness and security first, style second
- Be constructive -- suggest alternatives, don't just reject

## Safety Notes

- Check for accidentally committed secrets (.env, credentials, tokens)
- Verify native addon deps are in `pnpm.onlyBuiltDependencies`
- Check that fork-specific patches aren't removed

## Failures Overcome

- **Rubber stamp review:** Agent says "looks good" without reading context. The context step requires reading at least the surrounding function for each change.
- **Performative agreement:** Agent agrees with feedback without verifying it's technically correct. Must verify claims against actual code before accepting review feedback.
