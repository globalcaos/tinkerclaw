# Curiosity: did it read something you'd want to know now?

_Personality: curiosity, surprise and a steady voice_ · J11 paper §6.4

Language models don't wonder: every token serves the task in front of them. This is the curiosity check. After the agent reads something, Jev scores how much it matters to your goals and the standing facts about you, from "not relevant" to "you would want to hear about it now". Only the top level gives a short "worth knowing" note, at most one per stretch of work. It is opt-in and ships switched off.

## Examples

| Situation                                                                                  | Jev should answer     | Then                |
| ------------------------------------------------------------------------------------------ | --------------------- | ------------------- |
| fixing a failing export test, it reads `assets/logo-notes.txt`                             | 0 · not relevant      | nothing             |
| checking a supplier's quote, it reads that the supplier closes its only factory next month | 3 · you'd want it now | a short note to you |

## The question Jev is asked

How much does what the agent just read matter to the user's goals? Compare it with the request and the standing facts.

## The answers Jev can pick

0. not relevant to what the user is working on
1. slightly relevant
2. relevant to one of the user's goals
3. the user would want to hear about it now

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: worth-knowing
version: 1
family: personality
status: "off"
seams:
  - post-tool
type: score
fields:
  - request
  - standingFacts
  - toolRecord
cutoff:
  kind: level
  atOrAbove: 3
purpose: Opt-in interruption for something the user would want to know; at most one per stretch of work.
origin: paper 6.5
retirement: Retire if it interrupts and the user marks most interruptions as not useful.
mustCatch: []
```
