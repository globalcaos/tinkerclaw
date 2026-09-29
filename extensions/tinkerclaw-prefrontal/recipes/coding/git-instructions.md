---
schema: "kit/1.0"
slug: "git-instructions"
title: "Git instructions — hop along a traced path, one reviewable commit at a time"
summary: "House git for any product repo a colleague reviews: decide branch vs fork, trace the feature from originating surface to user-visible end, chop into hops a human can pull and test alone, commit each hop with its tests and a what/why/impact message. Use before planning or committing, when house git applies, when a commit would need the word and, or when starting a hardware/life that must stay independent of the old line."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "build"
tags:
  [
    "git",
    "git instructions",
    "commit",
    "how to commit",
    "commit message",
    "one commit",
    "logical change",
    "hop",
    "trace the path",
    "branch vs fork",
    "house doctrine",
    "house rules",
    "reviewed repo",
    "what to develop first",
    "how to test",
    "policyText",
  ]
antiTriggers: ["plan only with no commits", "review only", "what is git", "how does git work"]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
  notes: |
    Every step is a barrier. The hop list is the artifact later recipes consume.
    Nothing fans out until the path is named; chopping a path you have not traced
    is guessing.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Where the hop list is written when this recipe runs as a planner step.",
    }
  integration_branch:
    {
      type: "string",
      default: "develop",
      description: "The live line a short-lived branch will merge into. Unused when the ruling is fork.",
    }
---

# Git instructions — hop along a traced path

> Trace the feature from the surface that originates it to the surface a human
> sees. Each hop is one layer crossing, with its own tests, that a colleague
> can pull, run, and sign off without holding the rest of the stack in their
> head. That is the grain of a commit.

Doctrine with provenance: the deployment's private house-rules file, if one is configured
(it came from a reviewing colleague, three mails 2026-09-10; the architect's corrections the same afternoon:
branch vs **fork**, not project; hops are generic along a traced path).

## Goal

Before any code is written — and again before any commit lands — produce a hop
list a stranger could execute, and a compact ORCA `policyText` that stops a
worker gluing two hops back together.

## When to Use

- Any coding turn on a reviewed product repo, including a one-file change
  that still crosses a seam.
- `implementation-plan` when it defines tasks; `parallel-build` when it
  preflights units; `debug` / `refactor` when they commit.
- The user says git instructions, how should we commit, house git, branch or
  fork, chop this, one commit per change.

## When NOT to use

- Docs-only or config-typo commits that do not change behaviour.
- Upstream-merge / fork-patch restoration — those have their own recipes.
- Explaining Git as a tool.

## Steps

### 1. Two-minute test, then branch vs fork

out: {"type":"object","required":["problem","use_cases","modules","validation","lineage"],"properties":{"problem":{"type":"string"},"use_cases":{"type":"array","items":{"type":"string"}},"modules":{"type":"array","items":{"type":"string"}},"validation":{"type":"string"},"lineage":{"type":"string","enum":["short-lived-branch","fork"]}}}
**Done when:** The four questions have written answers, and the lineage is a
ruling (`short-lived-branch` or `fork`) with the cost if wrong.

Answer, in writing, in under two minutes:

1. What problem does this solve?
2. Which use cases does it affect?
3. Which modules does it touch?
4. How will I validate it?

If you cannot, the change is too big — split the problem, not the files.

Then pick the lineage. Git branches are for work that **will merge** onto
`{{integration_branch}}`. When two lives must stay independent (new hardware,
rewritten comms / data model / deploy / drivers) **and** the old line may
still progress: **fork**. A fork keeps the merge-base, so `git diff old..fork`
and cherry-picks stay cheap — that is the point of not starting a disconnected
copy. A forever-branch on the same repo is the failure the reviewer named (mixed
history, nobody knows the live version, pipelines grow exceptions). A
disconnected new project is the failure the architect named (you redo work the old
line already paid for).

Ruling: `Ruling: lineage=<short-lived-branch|fork> — <why> — <cost if wrong>`.

### 2. Trace the path

**Done when:** A single ordered list names every seam from the originating
surface to the user-visible end, each seam with the module that owns it.

Name the path. Hardware I/O is one instance (pins → driver → logic manager →
JS/UI). The rule is generic: wherever a behaviour can be followed from the
place it originates to the place a human observes it, that chain **is** the
path. Examples of the same shape: sensor → protocol → model → API → UI;
file on disk → parser → store → renderer; CLI flag → config → runtime → log.

Write the path as `A → B → C → …`. If you cannot draw it, you do not yet know
what to develop. Stop and read the code until you can.

### 3. Chop into hops a human can review

**Done when:** Each hop is one seam crossing, names its tests, does not need
the word "and"/"i"/"y" to describe, and is independently pullable.

A hop is one layer crossing plus the tests that prove **that crossing**. The
reason to chop is not agent convenience — agents can hold the whole path.
Humans review one seam at a time. The reviewer (or anyone) must be able to check out
that commit, run that hop's tests, and say yes or no without the rest of the
feature existing yet. That is the double- and triple-check.

How to know a hop is still too fat: if describing it needs **"and"** (Catalan
**"i"**, Spanish **"y"**), it is two hops.

Worked grain (the reviewer): create API X → consume API X → validate API X → UI
cancel button. Worked path (the reviewer, I/O): (1) prove the driver on the real
pins, test-main allowed but not shipped; (2) encapsulate for the product,
logic-manager test, drop the test-main; (3) wire JS/UI without regressing
the current board.

Constraints on a hop:

- **Tests travel with it**, documented if not obvious. If this hop can affect
  another feature, widen the tests _in this hop_, not later.
- **Clean-machine deployable.** After the hop, a blank machine can run the
  project. A WIP pile with a message on it is not a hop.
- **Additive at the seam.** A later hop must not rewrite the hop below it.
  Wiring new pins must not affect the pins already working. The previous hop's
  contract is now a public surface.
- Parallelism is allowed _inside_ a hop (disjoint files, ORCA leases). It is
  forbidden _across_ hops that sit on the same path — B reads A's committed
  contract.

Emit `{ id, seam, task, writes, tests, verify, wave }` per hop. `wave` is
the hop's index along the path; ORCA may parallelise units that share a wave
and have disjoint `writes`.

### 4. Commit hygiene and message

**Done when:** The staged set matches one hop, the message answers what / why
/ impact, and the secrets scan is clean.

Before `git commit`, read `git diff --cached --stat` and the file list:

- Do I want to ship all of this?
- Are all staged files this hop?
- Temporary files? Passwords? IPs, tokens, certificates?

Unstage, split, or delete. Never `--no-verify`, `--amend` of published
history, `git add -A`, or `--force`.

Subject: `type(scope): <imperative>` ≤72 chars. Body, three answers:

1. **What** it does (one hop, no "and").
2. **Why** (the problem, not the diff).
3. **Impact** (what else now behaves differently, what is still safe).

If the message and the staged diff disagree, the message is the bug — fix one
of them before committing.

### 5. Hand the hop list and the ORCA backstop

**Done when:** The hop list is on disk under `{{plans_dir}}` (or returned to
the caller), and the compact `policyText` below is what every ORCA call on
this work will pass.

`implementation-plan` consumes the hop list as its edit-units.
`parallel-build` refuses any unit that is not a hop, and passes `policyText`
into ORCA (advisory, ≤4000 chars, cannot widen `writes`). ORCA remains the
executor: it does not decide hops. Do not split ORCA into more recipes — a
mixed-concern unit named "add the I/O module" would still become one polite
commit; the hop list is what prevents that unit from existing.

Compact `policyText` (keep verbatim unless this recipe changes):

```
GIT INSTRUCTIONS (house git). Subordinate to the unit task and writes allowlist.

LINEAGE. Short-lived branch if this will merge. Fork if two lives stay independent AND the old line may still progress (keep merge-base, diff, cherry-pick). Never a forever-branch. Never a disconnected copy that forces redoing the old line's work.

HOPS. One unit = one hop along the traced path (one seam crossing). If the task needs "and"/"i"/"y", refuse and ask the caller to split. Do not bundle create+consume, driver+UI, or feature+cleanup. Later hops are additive: do not rewrite the hop below.

TESTS. Every commit ships its tests, documented if not obvious. If this change can affect another feature, add those cases in THIS commit. After this commit a clean machine can run the project. A colleague must be able to pull THIS commit and sign off this seam without the rest of the feature.

MESSAGE. Subject type(scope): imperative ≤72. Body: WHAT, WHY, IMPACT. If message and staged diff disagree, fix one before committing.

HYGIENE. Stage only this unit's files. No temps, passwords, IPs, tokens, certs. No --no-verify / --amend / -A.
```

## Constraints

- This recipe decides lineage, path, hops, messages, and test width. It does
  not write product code.
- ORCA is not extended and not split. The hop list is the planner's job;
  `policyText` is the worker backstop.
- Do not apply the fork ruling blindly to TinkerClaw (that repo already merges
  to `develop`). Do apply hops, messages, and hygiene everywhere a colleague
  reviews the history.
- Prefer a hook later (reject "and"/"y" subjects, secrets scan) in the
  _product_ repo. That is CI, not this recipe.

## Safety Notes

- Forking a product repo is a lineage decision with a long tail. Record the
  ruling and the cost if wrong; do not fork because a branch felt messy.
- Never put secrets, host IPs, tokens or certificates in a commit or a
  message. That check is in step 4 and is not optional.
- Do not `--no-verify` to land a hop that is not clean-machine deployable.

## Failures Overcome

- **2026-09-10 — mixed-concern commits into a reviewed product repo.** The reviewer's three mails
  (branch-vs-project, git practices, I/O example). Commits bundled a whole
  path; a human could not review a seam. Hops exist so they can.
- **2026-09-10 — "project" would have thrown ancestry away.** The architect: the old
  line may still progress; a fork keeps `diff` and cherry-pick so the same
  work is not done twice. Lineage is branch vs fork, not branch vs project.
- **2026-09-10 — I/O order was read as the rule.** It is an instance. The
  rule is: trace any path, chop every seam, test every hop so a human can
  double- and triple-check.
