---
schema: "kit/1.0"
slug: "code-review-5pass"
title: "5-pass code review (correctness + security + performance + readability + consistency, fan-out)"
summary: "Review a diff, file, or directory through five independent expert passes - correctness, security, performance, readability, consistency. Every finding carries file, line, severity, and a concrete fix; the run ends with a PASS/CONDITIONAL/FAIL verdict. Read-only: it reviews, it never edits the code."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
tags:
  [
    "code review",
    "review this diff",
    "review my pr",
    "pre-merge review",
    "security review",
    "5-pass review",
    "correctness",
    "code quality",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1, 2, 3, 4, 5]
    - [6]
params:
  diff_scope:
    {
      type: "string",
      default: "HEAD",
      description: "What to review: HEAD (working tree vs last commit), a commit range, or a PR ref.",
    }
---

# 5-pass code review (correctness + security + performance + readability + consistency, fan-out)

> Distilled from Journey kit [citadel/code-review-5pass](https://journeykits.ai)
> (MIT, journeykits.ai). Linters catch style; this catches what requires
> comprehension: race conditions, injection, O(n²) hot paths, stale comments.

## Goal

Produce one structured review report for {{diff_scope}}: findings grouped by
pass, sorted by severity, each pinned to file + line with the problematic code
and a specific fix ("change line 47 from X to Y because Z", never "consider
improving this"), closed by a PASS / CONDITIONAL / FAIL verdict with severity
counts.

## When to Use

- Before merging any non-trivial pull request (use a range like `main..feature`)
- Taking over code from another developer, or after a fast-moving sprint
- Before a security audit — catch the obvious issues first
- When a system misbehaves and the bug is suspected to be subtle

**Skip for:** generated files, lock files, binaries, configuration with no
logic, and code so simple the passes would come back empty.

## Steps

### 1. Resolve scope and load conventions

**Done when:** Every in-scope source file is read in full, and the project's
conventions baseline exists.

Resolve {{diff_scope}}: `HEAD` → `git diff HEAD` (staged + unstaged); a commit
range or PR ref → `git diff <range>` then read the FULL file for each changed
file (context beyond the hunks matters); a file/directory → read it (glob
recursively, skipping generated files, lock files, binaries, build artifacts,
`node_modules`). If the range references commits that don't exist, report the
git error and stop. Read everything once here — passes must not re-read.

Then load the project's config files (e.g. `tsconfig.json`, eslint/prettier
configs, `pyproject.toml`, `Cargo.toml`) and note: import style and aliases,
error-handling pattern (throw vs Result vs callbacks), naming conventions,
test patterns. This is the Pass 5 baseline — review against the project's own
standards, not generic best practice. If no convention files exist, note it;
Pass 5 then flags internal inconsistency only.

### 2. Pass 1 — Correctness

**Done when:** A findings list (file, line, severity, code, fix) exists.

Subagent (read-only) scans every in-scope file for: logic errors (inverted
conditions, wrong operators, bad boolean logic); off-by-one in loops, slices,
index/range math; null/undefined dereference without guards; missing awaits on
async results; race conditions on shared mutable state across concurrent async
ops; type coercion traps (loose equality, implicit conversions, truthiness);
resource leaks (connections, handles, listeners, subscriptions never closed);
missing cleanup in effects/lifecycle; edge cases (empty array, zero, negative,
huge input); direct mutation of supposedly immutable state.

### 3. Pass 2 — Security

**Done when:** A findings list (file, line, severity, code, fix) exists.

Subagent (read-only) scans for OWASP Top 10 and common vulnerabilities:
injection (SQL/NoSQL/command/template/LDAP — any user input reaching a query
or command unparameterized); XSS (`innerHTML`, `dangerouslySetInnerHTML`,
unescaped interpolation); broken auth (missing endpoint checks, access-control
gaps, privilege escalation, JWT validation holes); hardcoded secrets (keys,
tokens, passwords, connection strings in source); unsafe deserialization
(`eval`, `Function()`, unvalidated `JSON.parse`, `pickle.loads`, `yaml.load`
without SafeLoader); SSRF (user-controlled URLs fetched without allowlist);
path traversal (user input in file paths); insecure crypto (MD5/SHA1 for
passwords, ECB mode, hardcoded IVs, `Math.random()` for security values).

### 4. Pass 3 — Performance

**Done when:** A findings list (file, line, severity, code, fix) exists.

Subagent (read-only) scans for measurable degradation at scale — not
micro-optimizations: O(n²)-or-worse algorithms on paths that scale with data;
allocation inside hot paths (render functions, animation loops) that could be
hoisted; missing memoization of expensive derivations with unchanged inputs;
N+1 queries (DB/API calls inside loops instead of batched); whole-library
imports for one function; frontend render churn (new object/array references
forcing re-renders, inline function props in high-frequency components); sync
I/O or layout-forcing calls inside hot loops; unbounded queries or list
renders with no pagination/limits.

### 5. Pass 4 — Readability

**Done when:** A findings list (file, line, severity, code, fix) exists.

Subagent (read-only) scans for code that taxes the next reader: vague names
(`data`, `info`, `result`, `handle`, `process`); misleading names (`isValid`
returning a string, `getUser` with side effects); functions over ~50 lines
doing multiple things; cognitive complexity (3+ nesting levels, boolean
expressions that should be extracted to named variables); dead code
(unreachable branches, commented-out blocks, unused vars/imports); stale
comments describing pre-refactor behavior; magic numbers/strings without named
constants; mixed abstraction levels in one function.

### 6. Pass 5 — Consistency

**Done when:** A findings list (file, line, severity, code, fix) exists.

Subagent (read-only) scans against the Step 1 conventions baseline: import
ordering and alias usage; the project's error-handling pattern; file
organization; whether new functions match existing signature/return-type
patterns; whether new identifiers follow the naming conventions. Also flag
_internal inconsistency_ (e.g. some functions in a module throw while others
return null for errors) even when no convention file exists.

### 7. Merge, format, verdict

**Done when:** One report exists with findings grouped by pass and sorted by
severity, plus a verdict line and severity-count table.

Every finding must include: **File**, **Line** (exact number or range),
**Severity** (`CRITICAL` = bugs/vulnerabilities/data loss/crashes; `WARNING` =
problems under specific conditions, perf degradation, maintenance burden;
`INFO` = style/clarity/preventive), **Finding** (one sentence), **Code** (the
problematic lines), **Fix** (specific, not vague). For diff reviews,
distinguish findings in new/changed code from pre-existing issues surfaced by
context, and prioritize the new-code ones. Close with:

```
## Verdict: {PASS | CONDITIONAL | FAIL}
{one-line rationale}

| Severity | Count |
|---|---|
| Critical | N |
| Warning  | N |
| Info     | N |
```

## Constraints

- Read-only toward the codebase: review, never edit. The review is the
  deliverable — don't offer to fix findings unless asked.
- Don't duplicate linter/formatter output (semicolons, indentation, things
  ESLint already flags) — only semantic issues requiring comprehension.
- No false positives from skimming: verify the surrounding code for every
  finding. A "missing null check" guarded by the caller is not a finding; an
  "unused import" used in a type annotation is not a finding.
- Line numbers must be accurate — a finding on the wrong line is worse than
  none. Verify each cited line against the file.

## Safety Notes

- Subagents get read/grep/glob and read-only git only; no write/edit tools.
- CRITICAL security findings (Pass 2) are blocking for production deploys.
- When reviewing auth logic, read the entire auth flow — a bypass may live in
  an upstream guard, not the file under review.
- If hardcoded credentials surface, never include the credential value in the
  report — only the location and the finding.

## Failures Overcome

- No project conventions file found (config/lint files absent): skip
  convention-specific findings in Pass 5 but still flag internal inconsistency
  within the reviewed code.
- Review target contains binary files, images, or lock files: silently skip;
  only source files are reviewed.
- Diff range references commits that do not exist: report the git error;
  verify ref names and retry with a valid range.
- v1.0 distilled 2026-06-13 from Journey kit citadel/code-review-5pass.
