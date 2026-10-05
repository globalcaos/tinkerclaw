# Futility: are the last steps getting anywhere?

_Efficiency: the right procedure, the right model, no wasted loops_ · J11 paper §6.5

Some waste looks like work: the same error three times, the same file read again, many steps since the last new fact. Code counts the repeats; Jev judges whether the last steps produced anything new. "Nothing new" together with three or more repeats gives the agent a note: say what you learned and change approach, or stop and report what blocks you. If the loop goes on, the next note tells it to stop, and its further steps are held.

## Examples

| Situation                                        | Jev should answer | Then                                   |
| ------------------------------------------------ | ----------------- | -------------------------------------- |
| the same error three times in a row, nothing new | 0 · nothing new   | a note to change approach              |
| the same error twice                             | 0 · nothing new   | nothing yet (fewer than three repeats) |
| one error, fixed by the next step                | 2 · some          | nothing                                |
| each step turned up a new fact                   | 3 · clear         | nothing                                |

## The question Jev is asked

Did the last few steps produce anything new? Compare the results in the tool record; the counts of repeated errors and steps since the last new fact are given.

## The answers Jev can pick

0. nothing new: the last steps repeat an error or a result already seen
1. a little: one new fact, but the goal is no closer
2. some: new facts that narrow the problem
3. clear: the last steps produced a result that moves the task forward

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: progress-made
version: 1
family: efficiency
status: active
seams:
  - post-tool
type: score
fields:
  - repeatedErrors
  - stepsSinceNewFact
  - toolRecord
cutoff:
  kind: level
  atOrBelow: 0
purpose: Tells a stuck loop from steady work; acts only together with three or more repeats, which code counts.
origin: paper 6.4
retirement: Retire if repeat counts from code catch every stuck loop alone.
mustCatch:
  - mc-ef-same-error-3x
```
