---
schema: recipe/1.0
slug: overseer
title: Overseer
category: operations
owner: globalcaos
tools: [read]
summary: A completion-enforcing self-loop — after each Jarvis turn, a distinct Overseer persona judges whether THE TASK is fully done; if not, it nudges Jarvis to keep going, and the loop only ends when the task is genuinely complete.
triggers:
  [
    overseer,
    oversee,
    "make sure it's done",
    "see it through",
    "don't stop until",
    "complex multi-step",
    end-to-end,
    thorough,
  ]
---

# Overseer

## Goal

Drive a complex, multi-step request all the way to genuine completion instead of
stopping at "mostly done." A supervisory critic — THE OVERSEER, a persona distinct
from Jarvis — repeatedly checks Jarvis' work against the original intent and keeps
nudging until the task is truly finished, then goes silent.

## When to Use

- **A job done across distinct steps** — several sub-parts that are easy to half-finish.
- **Any task suspicious it will not complete in a single turn** — large or open-ended
  work where Jarvis is likely to stop at "mostly done" or "I'll do X next".
- Anything end-to-end where "I'll do X next" without doing it would slip through.
- When the user explicitly asks you to oversee, see it through, or not stop until done.

(The runtime engages this loop automatically on these shapes — an explicit overseer
keyword, a multi-step plan, or a request that reads as multi-step — so it covers the
cases above without the user having to ask.)

## Steps

### 1. Drive to completion

loop: until OVERSEER_DONE max 25
done-when: the Overseer judges THE TASK fully and correctly complete (it returns silence), and this step has emitted a note containing the literal token OVERSEER_DONE.
**Done when:** the Overseer judges THE TASK fully and correctly complete (it returns silence), and this step has emitted a note containing the literal token OVERSEER_DONE.

Each iteration spawns a fresh completion-assessor under the OVERSEER persona
contract — it is NOT Jarvis and never does the work itself. Give it two things:
THE TASK (the run intent — the user's original request that must be fully
satisfied) and the **FULL conversation** (pulled via `chat.history` — all there is
in the chat, so completion is judged against everything, not a recent slice). Ask
it the single question: is THE TASK fully and correctly complete (not merely
attempted, not "mostly")?

Interpret its answer with the same semantics as `parseOverseerVerdict`: an empty /
whitespace-only response, or a bare done-marker (e.g. `done`, `completed`, `✅`,
`lgtm`), means COMPLETE — silence ends the loop. Anything substantive is a
**concrete completion directive** — it enumerates every remaining gap and the
specific next actions that finish them, drawn from the full conversation, NEVER a
generic "keep going" — and means NOT done.

- When COMPLETE: emit a step note containing the literal token `OVERSEER_DONE`.
  That marker is what breaks the `until OVERSEER_DONE` loop; the run is finished.
- When INCOMPLETE: send the assessor's completion directive to Jarvis' own session
  (via `chat.send`) so Jarvis receives it as input and continues working. This
  injected prompt is the _user-side_ of the conversation — it renders as a
  right-anchored user bubble and MUST NOT carry the OVERSEER marker prefix, since
  the marker is reserved for the loop-control note above, not for what Jarvis
  reads. Let Jarvis answer, then loop back to a fresh assessment.

The `max 25` on the loop directive is only the HARD CEILING, not the operating
bound. The runner DERIVES the actual working maximum at activation time via
`deriveOverseerLoopBudget` (sized to the task), per design-principle #19: the
stated number is an upper limit the derived budget can never exceed, and a typical
run ends far sooner — the moment the Overseer falls silent. Never treat 25 as a
target; the loop should end on completion, not on exhausting iterations.

## Constraints

- The assessor is a SEPARATE persona from Jarvis — it judges and nudges, it never
  does the work.
- Be ruthless about "done": loose ends, unverified claims, skipped sub-parts, or
  "I'll do X next" without doing it all count as NOT done.
- Only the loop-control note carries `OVERSEER_DONE`; the prompt sent to Jarvis
  never carries the OVERSEER marker.
- The loop is bounded by construction (the derived budget, capped at the ceiling),
  so it can never run away.

## Failures Overcome

- **Stops at "mostly done":** without a completion gate, Jarvis declares victory
  with sub-parts unfinished. The Overseer's silence — not Jarvis' optimism — ends
  the loop.
- **Marker leaks into Jarvis' input:** prefixing the keep-going prompt with the
  done token both confuses Jarvis and can spuriously break the loop. The marker
  belongs only in the step's control note.
- **Treating the ceiling as a quota:** running to 25 iterations because the bound
  is 25. The working budget is derived and small; completion, not the cap, is the
  exit.
