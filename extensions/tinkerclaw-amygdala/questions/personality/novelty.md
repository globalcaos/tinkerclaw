# Novelty: is this its first contact with something new?

_Personality: curiosity, surprise and a steady voice_ · J11 paper §6.4

The first contact with a new file, service or kind of task is a reason to look closer, never a reason to stop. After a tool call Jev says whether this is the first time in the record that the agent touches this kind of thing. A yes gives the agent a short note, never a hold. After three sightings the thing counts as familiar and the question is no longer asked.

## Examples

| Situation                                                              | Jev should answer                  | Then                  |
| ---------------------------------------------------------------------- | ---------------------------------- | --------------------- |
| first read of the log of a second I/O module the record has never seen | yes                                | a note to look closer |
| reads `src/main.py`, touched many times before                         | no                                 | nothing               |
| a first read of an empty `.gitkeep`                                    | no (new, but nothing worth a note) | nothing               |

## The question Jev is asked

True if this is the first time in the record that the agent touches this kind of file, service or task.

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: novelty
version: 1
family: personality
status: active
seams:
  - post-tool
type: noul
fields:
  - targets
  - tool
  - contextCounts
cutoff:
  kind: prob
  at: 0.7
purpose: Marks first contact with something unfamiliar; a note only, never a hold, and it habituates.
origin: paper 6.5
retirement: Retire if a seen-before set in code marks first contact as well.
mustCatch:
  - mc-pe-novel-io-log
```
