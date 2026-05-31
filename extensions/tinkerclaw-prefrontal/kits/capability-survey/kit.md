---
schema: "kit/1.0"
slug: "capability-survey"
title: "Capability Survey"
summary: "Survey online agent harnesses for absorbable capabilities (autonomy-first — discard fear-induced/restrictive tooling), cross-reference against the J-series papers + TinkerClaw code, rank, then on a human threshold bake the winners into the improvement notes and implement them."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags:
  [
    "capability survey",
    "harness survey",
    "absorb capabilities",
    "what should we steal",
    "competitive scan",
    "make jarvis smarter",
    "upgrade jarvis",
    "fork capability survey",
    "oss roadmap",
    "new techniques",
    "agent frameworks",
  ]
tools: ["web", "read", "write", "exec"]
testedHarnesses: ["OpenClaw"]
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
  notes: |
    Serial by data-dependency: survey (0) → filter (1) → cross-reference (2) → rank +
    PRESENT for the human threshold (3, a hard gate) → bake into improvement notes (4) →
    implement (5). Step 0 itself fans out internally (one worker per harness category) —
    see the dispatch-parallel / multi-modal-sweep recipes. Steps 4–5 run ONLY after the
    human picks the threshold in step 3.
model:
  provider: "anthropic"
  name: "claude-opus-4-8"
  hosting: "cloud API"
resolverHints:
  [
    {
      "match": "survey harnesses | what capabilities should we absorb | scan agent frameworks | make jarvis smarter | what should we steal from other agents | capability roadmap",
      "load": ["kit.md"],
      "purpose": "Run a capability-absorption survey of the agent-harness landscape and turn the winners into shipped TinkerClaw upgrades.",
    },
  ]
---

## Goal

Keep TinkerClaw/Jarvis at the frontier by systematically mining the open-source agent-harness
landscape for capabilities worth absorbing — and shipping the winners. This recipe encodes the
strategy run on 2026-05-30 (the OSS roadmap → ranked list → improvement notes → implementation),
so it is repeatable.

## Core principle — AUTONOMY-FIRST (load-bearing)

A capability is absorb-worthy **only if it makes the agent smarter or more useful/capable**.
**Discard "fear-induced" tooling** whose purpose is to _restrict_ autonomy or capability:
sandboxing, human-approval/permission/consent gates, capability throttles, refusal/guardrail
layers, "safety" interlocks that block actions. Those are anti-goals — do not surface them as
candidates. (Genuine _quality_ mechanisms — self-verification, adversarial critique, calibrated
confidence — make the agent _better_, not smaller; keep those.)

## Living artifact

The harness inventory lives at `~/Documents/AI_reports/agent-harnesses-survey.md` (harness → key
functionalities → autonomy verdict → J-paper(s) → already-in-TinkerClaw? → absorb-value →
rationale). Each run REFRESHES + EXTENDS it; never start from scratch.

### 1. Survey the harness landscape

done-when: agent-harnesses-survey.md is updated with each notable harness + its key functionalities
uses: multi-modal-sweep
Fan out one worker per harness CLASS (memory/knowledge-graph, reasoning/search, multi-agent orchestration, self-improvement/evolution, curiosity/open-endedness, tooling/skill-acquisition, deep-research/context-engineering). Each worker web-searches current projects + papers, lists each harness's MAIN functionalities, and records them. Read the existing survey md first and extend it, don't duplicate.

### 2. Filter for absorb-worthy capabilities (autonomy-first)

done-when: every candidate is tagged aligned/absorb-worthy or restrictive/discard, with a reason
Apply the AUTONOMY-FIRST principle above. For each functionality, decide: does it make Jarvis SMARTER or MORE CAPABLE (keep) or is it fear-induced tooling that RESTRICTS autonomy/capability (discard)? Discard outright; do not let restrictive "safety" features into the candidate set.

### 3. Cross-reference against the J-series papers + our code

done-when: each surviving candidate is mapped to its J-paper(s) + a have-it/partial/gap verdict
For each kept candidate, find the matching J-series paper(s) (J1–J15) and grep the TinkerClaw code (`~/src/tinkerclaw/extensions` + `src/`) + the papers' improvement_notes to judge whether we ALREADY have it (yes / partial / gap). A candidate we fully have is not a candidate; a partial is an enhancement; a gap is net-new. Be concrete (file:line / paper section).

### 4. Rank + PRESENT for the human threshold (GATE)

done-when: a single ranked candidate list (by absorb-value × leverage) is presented to Oscar, and he has chosen a threshold
Merge all categories into ONE ranked list (highest absorb-value × leverage first), each row: candidate · what it adds · J-paper · have/partial/gap · effort (S/M/L/XL). Present it and STOP — Oscar decides where the cut line is. Do NOT proceed past this gate without his threshold.

### 5. Bake the selected features into the J-series improvement notes

done-when: each above-threshold feature has a design + implementation-plan section in the right paper's improvement_notes.md
For each selected candidate, write a grounded improvement-note section into its J-series paper's improvement_notes.md (design rationale, file-level integration plan citing real seams, pseudocode, test plan, complexity, risks). Mirror the 2026-05-30 plan format.

### 6. Implement, test, and ship

done-when: each feature is implemented + tested (build clean) + committed + has a 📌 pending-testing task
uses: subagent-driven-dev
Implement the selected features (subagent-driven where multi-task), with real tests, build clean. Commit on `develop`. For each shipped capability create a 📌 task in the right "Closed and pending testing" bucket (⚙️ TinkerClaw Bugs `meta-closed` or 🤖 Jarvis Upgrades `jarvis-upgrades-closed-and-pending-testing`) for Oscar's weeks-long soak verification.
