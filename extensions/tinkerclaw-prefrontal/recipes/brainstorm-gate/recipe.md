---
schema: "kit/1.0"
slug: "brainstorm-gate"
title: "Brainstorming gate — interview to an approved spec"
summary: "The intent interview that runs before anything is built: classify the task, fan out read-only exploration, interview the user hard-parts-first, propose 2-3 approaches with a recommendation, write a SPEC file, and hold a hard approval gate. Use it when the user says how should we build this, what do you think, interview me, help me clarify the requirements, or asks for a spec before building."
version: "2.2.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
subdivision: "planning"
tags:
  [
    "brainstorm",
    "design",
    "before building",
    "how should we",
    "how should we build this",
    "what do you think",
    "spec",
    "write a spec",
    "interview me",
    "understand the requirements",
    "clarify",
    "approach",
    "architecture",
    "design gate",
    "scope this",
  ]
antiTriggers:
  [
    "fix the bug",
    "broken",
    "crash",
    "typo",
    "one-liner",
    "just do it",
    "already decided",
    "spec is approved",
    "review this code",
    "debug this",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
  notes: |
    [0] classify + explore: the read-only lanes fan out INSIDE this step, one explorer per lane; the interview cannot start until their findings land.
    [1] interview: a conversation with the user — not parallelisable, and the one step that spends their attention.
    [2] propose: needs every interview answer, so it is a barrier behind step 2.
    [3] spec write + self-review: one author, one file, no fan-out.
    [4] approval: a human barrier by definition.
    [5] transition: only meaningful after the yes.
params:
  plans_dir:
    {
      type: "string",
      default: "docs/plans",
      description: "Repository-relative directory where the SPEC file is written, so downstream recipes find it at a predictable path.",
    }
  explorer_model:
    {
      type: "string",
      default: "haiku",
      description: "Model for the step-1 read-only exploration lanes — breadth work, so a cheap model fanned out wide beats one strong agent reading serially.",
    }
---

# Brainstorming gate — interview to an approved spec

> Ask everything now, so nothing has to be asked later. Ends in a SPEC file
> and an explicit yes; after that, choices are rulings, not questions.

## Goal

Front-load every question that needs a human, and close with an artifact a
stranger could build from. The gate produces three things: a stated task class,
2-3 candidate approaches with one recommendation, and a SPEC file the user has
explicitly approved. Its second job is subtraction — the "Rulings I will make
myself" list moves implementation-detail decisions out of the user's inbox and
into the agent's, so the end of the job is a result rather than a quiz.

## When to Use

- "How should we build this?", "what approach would you take?", "what do you
  think?" — any design-shaped question before building
- Starting a new feature, component, or architectural change
- The user asks to be interviewed, or asks for a spec before implementation
- Any creative task, however small — scale the design phase down, never skip it

## When NOT to use

- The change fits in one sentence and one file — say so and go build it
- A bug with a known reproduction (use `debug`)
- An approved spec or plan already exists (go to `implementation-plan`)
- Reviewing code that is already written (use `code-review`)

## Steps

### 1. Classify and explore

out: { "type": "object", "required": ["classification", "findings"], "properties": { "classification": { "type": "string", "enum": ["spike", "bounded", "architectural"] }, "findings": { "type": "string" } } }
**Done when:** the classification is stated in chat and a findings summary names the files, conventions and prior art the work will touch.

Name the class out loud before anything else. Spike: answer a question, code is throwaway. Bounded: changes an existing flow, short design in chat. Architectural: new subsystem, written spec and sectioned design. Hidden complexity upgrades the class mid-task, never downgrades it.

Then fan out read-only explorers ({{explorer_model}}), one per lane: similar features already shipped, repo conventions and architecture rules, the tests around the area, the docs the change would make stale, recent commits touching those files. No edits in this step. Fold the lanes into one summary — every fact in it is a question you will not spend on the user.

### 2. Interview — hard parts first

**Done when:** technical approach, UX, edge cases, failure modes and out-of-scope are all answered, and the "Rulings I will make myself" list has been shown to the user.

Hard parts first: technical approach, the shape of the interaction, edge cases, failure modes, trade-offs, and what is explicitly out of scope. Batch questions by theme instead of dripping them one at a time, and prefer multiple choice with a recommended default so answering costs a word.

Never ask what memory, the repo, the conversation or step 1 already answered — an avoidable question spends the scarcest resource in the room.

Close the interview with "Rulings I will make myself": the implementation-detail decisions you intend to take alone once building starts. The user vetoes any of them NOW; that is the whole point. Stop when the spec would be self-contained, not when curiosity runs out.

### 3. Propose approaches

**Done when:** 2-3 approaches, each with its trade-off named, and one explicit recommendation are on the table.

Two or three approaches, each short enough to compare at a glance, each with its real trade-off stated: cost, blast radius, reversibility, and what it forecloses later. Then recommend one, and say why.

Do not pad the list with options nobody would pick — a fake option is a gibberish question wearing a suit. Bounded work gets a short design in chat. Architectural work gets a sectioned design: data flow, interfaces, failure handling, migration path. A spike skips this step; say that it is being skipped rather than skipping it silently.

### 4. Write the SPEC and self-review it

**Done when:** `{{plans_dir}}/YYYY-MM-DD-<feature>-spec.md` exists with all seven sections and the placeholder scan comes back clean.

Write the shared artifact in two blocks. First the INTENT block, in the plain-language shape the AI-native SDLC playbook gives an originator who is not an engineer: Problem (the situation and its pain) · Proposed outcome (the future state, not the solution) · Affected users and systems · Constraints · Open questions — with an author line and a status line (`draft` until step 5 says `approved`). Then the SPEC block: Goal · Context · Done-when · Out of scope · Rulings I will make myself. Each Done-when line is a check someone else could run — a command, a served output, an observation — not an adjective. The intent block is what a product owner approves; the spec block is what the plan is built from.

Name the file with a TYPE PREFIX — `feature-`, `bug-`, `chore-`, `research-` — because intents accumulate and an ordered folder of them IS the backlog. Keep the section list and the prefix set STABLE: the value of a standard artifact is that the team, the agents and every downstream recipe read the same shape, and that value is destroyed by improving the format every other week. Change it deliberately, rarely, and everywhere at once.

Then self-review the file before showing it: scan for placeholders ("TBD", "add error handling", "similar to the other one"), contradictions between sections, and scope that grew past what was agreed. Present the spec as prose in chat as well as writing the file; the user should be able to approve it without opening anything.

### 5. Approval gate

**Done when:** the user has said yes in words, and those words are quoted in the transition note.

Hard gate. Nothing is built until an explicit yes. Silence is not approval. Enthusiasm about the problem is not approval of the approach. A "sounds good" aimed at a different question is not approval of this one.

If the answer is conditional ("yes, but change X"), fold X into the spec, restate the delta in one line, and ask again. If the user is unavailable, stop and say the spec is waiting — a plausible guess about what they would have said is exactly the failure this gate exists to prevent.

"Not now" is not a discard. Set the status line to `backlog`, leave the file where it is, and say it is filed — the interview's cost is already paid, and the next time the idea surfaces it starts from a written intent instead of a blank page. Only an explicit "no, never" sets `rejected`, and even then the file stays.

### 6. Transition — questions stop here

**Done when:** the SPEC path has been handed to the caller or the next recipe, and the switch to rulings mode is stated in chat.

Hand the SPEC path onward. Architectural work, and bounded work touching several files, goes to `implementation-plan`. Bounded single-flow work can go straight to `parallel-build` with a two-line plan. Do not invoke either from inside this recipe — return the path so the caller (usually the `feature` pipeline) chains them; start the next recipe yourself only when running standalone.

From here, implementation choices are RULINGS, not questions: decide, log `Ruling: <what> — <why> — <cost if wrong>` in the plan's ledger, keep moving. Only four things stop the run: an irreversible or destructive operation, a security-sensitive action, a side effect outside the worktree, or a spec so broken that every path is a guess.

## Constraints

- Every creative task gets a design phase — scale it to the class, never skip it.
- Steps 1-3 are read-only; step 4's only write is the SPEC file. No implementation before the yes in step 5.
- Cap the proposal at 2-3 approaches with one recommendation. A fourth option is padding.
- Questions are front-loaded into step 2 and batched by theme. After approval they become rulings.
- Never ask what memory, the repo, or the conversation already answers.
- The SPEC is self-contained: someone with the repo and the file could build it without asking anything.
- This recipe never chains `implementation-plan` or `parallel-build` itself — the caller does, so the pipeline cannot run a phase twice.

## Safety Notes

- Steps 1-3 use read and search tools only (read, grep, glob, web search). No write, send, or deploy tool runs before approval.
- Step-1 explorers are spawned read-only. A fan-out agent holding write tools can start building the thing that has not been approved yet.
- The approval in step 5 comes from the user in words — never inferred from silence, a reaction, or the absence of an objection.
- The SPEC file is written inside `{{plans_dir}}` in the current repo or worktree. Nothing in this recipe writes outside it, merges, publishes, or sends.
- Exploration reads code; it does not exfiltrate it. Web searches carry the problem shape, never repository contents.

## Failures Overcome

- **Building the wrong thing:** the ask-propose-approve sequence catches a wrong direction while it still costs a paragraph instead of a branch.
- **Skipping the gate for "simple" tasks:** every project gets a design phase; the artifact scales with the class, the approval gate does not.
- **Gibberish options at the end (2026-09-02):** the architect asked for fewer end-of-job questions about how to choose between indistinguishable options. Fix: questions move to step 2, batched by theme with recommended defaults; the "Rulings I will make myself" list offers the veto up front; after approval the agent decides and logs instead of asking.
- **Questions the answer was already sitting in:** step 1's exploration fan-out runs BEFORE the interview so the repo answers what it can, and the interview only spends the user's attention on what the repo cannot.
- v1.0 was resurrected 2026-06-13 from a deleted `recipe/1.0` `analysis/brainstorm-gate.md` and converted to the skeleton pattern.
- v2.0.0 (2026-09-02) adds the classification, the parallel exploration lanes, the SPEC artifact, the rulings list, and the transition contract; the old one-question-at-a-time rule became batch-by-theme with recommended defaults.
- **v2.1.0 (2026-09-03):** folded in the AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook — the source the "INTENT.md" video walks through): the intent block (Problem · Proposed outcome · Affected users and systems · Constraints · Open questions, author + status) now heads the SPEC file.
- **v2.2.0 (2026-09-04):** from the video walkthrough of the playbook — intents are type-prefixed (`feature-`/`bug-`/`chore-`/`research-`) because an ordered folder of them IS the backlog; the artifact format is deliberately STABLE (its worth comes from every agent and recipe reading one shape); and a "not now" is filed as `backlog`, never discarded, so the interview is paid for once.
