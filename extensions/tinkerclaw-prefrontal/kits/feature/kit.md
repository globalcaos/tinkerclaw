---
schema: "kit/1.0"
slug: "feature"
title: "Build Feature"
summary: "Explore codebase, design approach, implement with tests, verify"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["coding", "add", "create", "build", "implement", "new feature", "make it"]
tools: ["read", "grep", "glob", "exec", "edit", "write"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0, 2]
    - [1]
    - [3]
    - [4]
  notes: |
    Explore (0) and Write Tests (2) are both read-only / write-to-new-files and
    can fan: Explore reads existing patterns while tests are written against the
    expected interface. Design (1) is a barrier — it needs Explore's findings to
    produce a valid plan, and tests cannot be finalised before Design. Implement
    (3) is a single write barrier (one file list, sequential edits). Verify (4)
    runs the build + test suite as a final barrier. Step index: 0=Explore,
    1=Design, 2=Write Tests, 3=Implement, 4=Verify.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "add | create | build | implement | new feature | make it",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: add, create, build, implement, new feature, make it",
    },
  ]
---

## Goal

Build a new feature that integrates cleanly with the existing codebase, following established patterns.

## When to Use

- New capability requested
- Extending existing functionality
- Adding a new module, extension, or component

## Steps

### 1. Explore

**Tools:** read, grep, glob
**Done when:** Understand codebase structure and relevant patterns

Read existing code in the area being modified. Identify patterns (naming conventions, file structure, import style). Find similar features to use as templates. Check for existing utilities that can be reused.

### 2. Design

**Tools:** read
**Done when:** Clear plan with file list and approach

Plan the approach. Identify which files to create/modify. Define the public API or interface. Consider edge cases. For complex features, write a brief design in comments before coding.

### 3. Write Tests

**Tools:** write
**Done when:** Tests exist and fail for the expected behavior

Write failing tests first (TDD). Cover the happy path and key edge cases. Don't over-test internals -- test behavior.

### 4. Implement

**Tools:** edit, write
**Done when:** Tests pass with minimal code

Write the minimal code to pass tests. Follow existing patterns. Add JSDoc headers to new files explaining purpose and wiring. Use `FORK:` prefix for fork-specific files.

### 5. Verify

**Tools:** exec
**Done when:** All tests pass, feature works end-to-end

Run the full test suite. Check for regressions. For UI features, verify HMR picks up changes (no manual refresh needed for Tinker UI). For backend changes, rebuild with `tsdown` and restart gateway.

## Constraints

- Follow existing patterns -- don't invent new conventions
- Every new file gets a JSDoc header
- No commented-out code
- No debug console.log left behind

## Safety Notes

- For gateway extensions, check that `openclaw.plugin.json` has all mandatory fields (including `configSchema`)
- Native addon packages must be externalized in bundler config
- Add new deps to `pnpm.onlyBuiltDependencies` if they have native bindings

## Failures Overcome

- **Pattern mismatch:** Agent creates a module using a different pattern than the rest of the codebase. The explore step now requires reading at least 2 similar files before designing.
- **Missing wiring:** Feature code written but never connected to the system. Design step must include how the feature gets loaded/called.
- **Gateway cache:** Gateway caches `index.html` in memory. After Tinker UI rebuild, gateway must restart to pick up changes.
