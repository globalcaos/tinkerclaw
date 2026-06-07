---
schema: "kit/1.0"
slug: "overseer"
title: "Overseer"
summary: "Supervisory critic loop — a distinct Overseer persona verifies the original task is FULLY done and nudges Jarvis forward until it is, then goes silent."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags:
  [
    "overseer",
    "oversight",
    "supervise",
    "complex",
    "multi-step",
    "verify completion",
    "ensure done",
    "make sure",
    "see it through",
    "end-to-end",
    "thorough",
    "don't stop until",
  ]
tools: ["read"]
testedHarnesses: ["OpenClaw"]
parallelism:
  groups:
    - [0]
  notes: |
    This recipe is a MODE, not a step sequence. Matching it ACTIVATES the Overseer
    supervisory loop (src/fork/overseer.ts) for the session — it does not dispatch
    subagents via the kit-runner. The single step below documents the contract.
model:
  provider: "anthropic"
  name: "claude-opus-4-8"
  hosting: "cloud API"
resolverHints:
  [
    {
      "match": "overseer | oversee | make sure it's done | see it through | don't stop until | complex multi-step",
      "load": ["kit.md"],
      "purpose": "Engage the Overseer when a task is complex enough to warrant a completion-enforcing critic loop.",
    },
  ]
---

## Goal

Guarantee a complex, multi-part request is **fully** completed — not merely attempted — by running a supervisory critic loop around Jarvis.

## How it works (a mode, not a step list)

When this recipe matches, the session activates **The Overseer** (`src/fork/overseer.ts`):

- The Overseer is a **distinct persona** from Jarvis (a terse QA/supervisor; it never does the work itself).
- After **each** Jarvis turn completes, the Overseer is consulted with the **chat window + the original task**.
- If the task is **not** fully done, the Overseer emits **one concise nudge**, which is injected into Jarvis' session as a prompt (Jarvis sees it as input) and rendered as a **right-anchored electric-blue bubble with an "Overseer" label** (the `⟦OVERSEER⟧` marker).
- Jarvis answers the nudge → the Overseer is consulted again → loop.
- When the Overseer judges the task **complete, it stays silent** — which cuts the loop.

Bounded: the number of nudges per task is a **derived working budget** (`deriveOverseerLoopBudget`, sized to the live situation — recipe reliability and whether the gap-to-done is shrinking), clamped to a structural ceiling of 25. Per design-principle #19 the ceiling is a safety limit, never the target — the loop almost always ends far sooner, the moment the Overseer goes silent. There is no frozen nudge count.

### 1. Engage the Overseer supervisory loop

done-when: the Overseer judges the original task complete (it goes silent) or the derived supervision budget is reached
As your **FIRST action**, call the `fork.overseer.activate` RPC with `{ "sessionKey": "<this session's key>", "task": "<the user's original request, verbatim>" }` to engage the supervisory loop. Then proceed to do the work normally. After each of your turns, the Overseer (a separate persona) automatically verifies completion against the original task and, if anything is unfinished, injects a nudge — which arrives as a prompt prefixed `⟦OVERSEER⟧` and renders as a right-anchored electric-blue "Overseer" bubble. Keep working until the Overseer goes silent (the loop self-terminates; it is also bounded by a derived budget clamped to a ceiling of 25, never a fixed count).
