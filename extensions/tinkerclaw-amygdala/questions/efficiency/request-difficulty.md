# Right model: how hard does your request look?

_Efficiency: the right procedure, the right model, no wasted loops_ · J11 paper §6.5

This one never acts. It gives the model router (Thalamus) a signal: how much work your request looks like, from trivial to very hard, so it can pick a model and how long that model thinks. It has no cut-off, so it can never produce a note or a hold, and it ships switched off.

## Examples

| Situation                                                | Jev should answer | Then                   |
| -------------------------------------------------------- | ----------------- | ---------------------- |
| "What does the merge function return?"                   | 0 · trivial       | a signal to the router |
| "Rename the variable count to total in demo.py."         | 1 · easy          | a signal to the router |
| "Find out why the export fails on some days and fix it." | 2 · hard          | a signal to the router |
| "Plan the backups for the whole office."                 | 3 · very hard     | a signal to the router |

## The question Jev is asked

How much work does the user's request look like?

## The answers Jev can pick

0. trivial: one step, the answer is known
1. easy: a few steps with clear order
2. hard: many steps or several things that can go wrong
3. very hard: open-ended, or needs facts the agent does not have

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: request-difficulty
version: 1
family: efficiency
status: "off"
seams:
  - prompt
type: score
fields:
  - request
cutoff:
  kind: none
purpose: A signal for the model router only, never a response; the cut-off is above the top level so it never acts.
origin: design 4
retirement: Retire if the router picks models well without it.
mustCatch: []
```
