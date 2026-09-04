---
schema: "kit/1.0"
slug: "code-review"
title: "Adversarial code review against the spec"
summary: "Review a diff with fresh context against the SPEC and PLAN it was built from: three parallel lenses (correctness and spec compliance, security and data flow, tests and maintainability) on a different model family than the implementer, every finding re-verified against the real code, reported severity-ordered with concrete fixes. Use for review this, review my changes, check this PR, look at this diff, is this correct, review before merge."
version: "2.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "review"
tags:
  [
    "review",
    "code review",
    "review this",
    "review my changes",
    "check this",
    "look at this PR",
    "look at this diff",
    "review the diff",
    "review before merge",
    "is this correct",
    "did I miss anything",
    "critique this code",
    "PR review",
    "self review",
  ]
antiTriggers:
  [
    "implement",
    "build it",
    "write the code",
    "fix the bug",
    "debug",
    "plan only",
    "just merge it",
    "refactor it for me",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1, 2, 3]
    - [4]
    - [5]
  notes: |
    Group [0]: scoping is a barrier — every lens reads the same diff and artifact set, so it must be fixed first.
    Group [1,2,3]: the three lenses are read-only and disjoint in concern, so they run as three parallel subagents with fresh context.
    Group [4]: verification is a barrier — it needs all three lenses' findings before it can re-check them against the code.
    Group [5]: the report is written once, after verification has dropped the unconfirmed findings.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where SPEC and PLAN files live; the review reads them as the requirements of record when they exist.",
    }
  diff_base:
    {
      type: "string",
      default: "develop",
      description: "The ref the branch is diffed against when reviewing a branch rather than the working tree.",
    }
  reviewer_model:
    {
      type: "string",
      default: "opus",
      description: "Model for the three lens subagents. MUST be a different family than the one that wrote the code — a model does not find its own blind spots.",
    }
---

# Adversarial code review against the spec

> Three lenses, fresh context, a different model family than the author.
> Findings that survive re-verification against the real code get reported;
> the rest are dropped, not hedged.

## Goal

Find what is actually wrong with a change, measured against the requirements
it was built from — not against taste. The review reports gaps against the
SPEC and PLAN first, then correctness, then everything else, and marks
anything that does not affect correctness or a stated requirement as
optional so the fixer does not over-engineer.

## When to Use

- Reviewing a branch, PR, or staged diff before merge
- The review step of the `feature` pipeline, after the build is green
- Self-review of your own work with genuinely fresh context
- A second opinion on a change someone else already approved

## When NOT to use

- The change is not written yet — that is `brainstorm-gate` or `feature`
- Something is broken and the cause is unknown — that is `debug`
- Coverage is the question, not correctness — that is `test-hardening`
- You want the findings fixed, not listed — review first, then fix

## Steps

### 1. Scope the diff and load the requirements

out: {"type":"object","required":["files","diff_command","requirements"],"properties":{"files":{"type":"array","items":{"type":"string"}},"diff_command":{"type":"string"},"spec_path":{"type":["string","null"]},"plan_path":{"type":["string","null"]},"requirements":{"type":"array","items":{"type":"string"}}}}
**Done when:** The exact diff command, the file list, and the requirements of record are written down, and the requirements list is non-empty or explicitly marked "none on file".

Get the diff: `git diff` for unstaged, `git diff --staged` for staged,
`git diff {{diff_base}}...HEAD` for a branch. Look for a SPEC and PLAN under
`{{plans_dir}}` matching the change; when they exist they ARE the
requirements — quote the Done-when checks verbatim. When they do not,
reconstruct the requirements from the request, the issue, or the commit
messages, and say in the report that the review is against reconstructed
requirements. Note which files are generated or vendored so no lens wastes a
pass on them.

### 2. Lens A — correctness and spec compliance

thinking: high
out: {"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"object","required":["file","line","severity","claim","fix"],"properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"type":"string","enum":["blocking","major","minor","optional"]},"claim":{"type":"string"},"fix":{"type":"string"}}}}}}
**Done when:** Every Done-when check from step 1 is marked met or unmet with a file:line, and each correctness finding names a concrete failing input or state.

Fresh subagent on {{reviewer_model}}. It sees the diff, the requirements, and
read access to the repository — never the author's summary of what the change
does. Walk each requirement to the code that satisfies it; a requirement with
no code is a gap and outranks every style opinion. Then hunt correctness:
edge cases, empty and boundary inputs, error paths that swallow, off-by-one,
state that outlives its scope, async ordering. State the input that breaks it
or drop the finding.

### 3. Lens B — security and data flow

thinking: high
out: {"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"object","required":["file","line","severity","claim","fix"],"properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"type":"string","enum":["blocking","major","minor","optional"]},"claim":{"type":"string"},"fix":{"type":"string"}}}}}}
**Done when:** Every new input, credential path, and outbound call in the diff has been traced to its sink and marked safe or unsafe with a file:line.

Fresh subagent on {{reviewer_model}}. Trace data, not lines: where does each
new input enter, what validates it, where does it land. Check injection into
shells, queries, and templates; authorisation on new endpoints and commands;
secrets in source, fixtures, logs, and error text; anything newly leaving the
machine. Flag scope creep in permissions and any path where a failure is
silent. An allowlist that must recognise every future case is a finding, not
a design.

### 4. Lens C — tests and maintainability

thinking: high
out: {"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"object","required":["file","line","severity","claim","fix"],"properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"type":"string","enum":["blocking","major","minor","optional"]},"claim":{"type":"string"},"fix":{"type":"string"}}}}}}
**Done when:** Each changed behaviour is mapped to a test that would fail without the change, or listed as untested.

Fresh subagent on {{reviewer_model}}. Ask of each test: would it fail if the
behaviour regressed? Tests asserting internals, mocks asserting themselves,
and tests written against a fixture nobody checked are worth less than no
test, because they read as coverage. Then maintainability, scoped: dead code
the diff leaves behind, duplicated logic that will drift, naming that
contradicts the codebase, missing doc updates for a changed contract. Style
the codebase does not enforce is not a finding.

### 5. Verify every finding against the real code

**Done when:** Each surviving finding has been re-opened at its file:line and confirmed, and every unconfirmed finding has been deleted from the list — not softened.

The lenses produce claims. Open each one at the cited line and confirm the
code says what the finding says it says; run the command where a claim is
runnable. Re-verify with a model family different from the one that raised
the finding where the claim is expensive to act on. Line numbers must be
accurate — a finding pointing at the wrong line teaches the fixer to skim
the next one. De-duplicate overlaps between lenses, keeping the version with
the better evidence. Findings that cannot be confirmed are dropped.

### 6. Report — gaps first, severity-ordered, fixes concrete

**Done when:** The report is delivered with requirement gaps first, every item carrying file:line plus a specific fix, and every non-correctness item labelled optional.

Order: unmet requirements, then blocking correctness or security, then major,
then minor, then optional. Each item: what is wrong, where, what to change —
a fix a stranger could apply without asking a question. Label everything that
affects neither correctness nor a stated requirement as **optional** and say
plainly that optional items may be declined. Cap the optional items at five
and summarise the rest as a count — a review that lists forty nits buries the
one blocking finding. Do not report anything the repository's lint, typecheck
or CI already enforces. When a finding repeats one made on an earlier change
in the same codebase, it is no longer a review finding but a missing rule:
say so, and route it to the repo's agent instructions or owning design doc so
the second sighting is the last. Close with what was reviewed, what was
verified by running something, and what was read-only. Prose and a status
card; no rewritten files pasted in as the report body.

## Constraints

- The lenses run on a model family DIFFERENT from the one that wrote the code.
- Each lens is a separate spawn with fresh context; none sees the author's
  report of what the change does, only the diff and the requirements.
- No finding without a file:line and a concrete fix. Skimming is not review.
- Findings are dropped when unverified, never hedged into the report.
- Do not chase every finding into a redesign — un-scoped review produces
  over-engineering, which is a worse outcome than the nits it removed.
- Style is only a finding where the codebase already enforces that style.
- Review does not edit. Fixes are the next step, and someone else's call.
- Generated, vendored, and lockfile changes are scanned for surprises only.

## Safety Notes

- Scan the diff for accidentally committed secrets: env files, tokens, keys,
  connection strings, and credentials pasted into fixtures or tests.
- Check that native addon dependencies are declared in
  `pnpm.onlyBuiltDependencies` where the repository requires it.
- Check that fork-specific patches were not silently reverted by the change.
- Reviewers get read, grep, and exec-for-tests only — no commit, no deploy,
  no network writes. A review must not be able to change what it reviews.
- Never quote a secret you find into the report; name the file and line.

## Failures Overcome

- **Rubber stamp review:** the agent says "looks good" without reading the
  surrounding code. Step 1 fixes the file list and requirements before any
  lens starts, and every lens must produce a file:line or an explicit "no
  findings" — silence is not a pass.
- **Performative agreement:** the agent accepts review feedback without
  checking it is technically true. Step 5 re-opens every claim at its cited
  line; a claim that does not survive is deleted.
- **The suspect investigating itself (2026-08-29):** a post-incident review
  was run by a model that had taken part in the incident, and it found
  nothing. Vary the model family on every verification leg — a model does not
  see its own blind spots by trying harder.
- **Findings from skimming:** claims with plausible prose and wrong line
  numbers. Accurate `file:line` is now part of Done-when for every lens.
- **Un-scoped review causing over-engineering:** everything the reviewer
  noticed became work. Non-correctness items are labelled optional and may be
  declined without argument.
- v1.0 (`recipe/1.0` schema) rewritten 2026-09-02 into three parallel lenses
  after the architect asked for maximum parallelism, front-loaded questions,
  and a final report with no code in it.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): optional findings capped at five, nothing CI already enforces, and a repeated finding is routed to the repo's agent instructions as a missing rule.
