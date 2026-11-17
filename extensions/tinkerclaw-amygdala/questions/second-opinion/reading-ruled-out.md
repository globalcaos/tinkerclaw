# Ambiguity: does the record rule out the reading picked?

_Second opinion: did it understand you, and does it stay on course?_ · J11 paper §6.2

The mirror of the previous question. While a flagged request is open, Jev is asked whether what the agent found, or the conversation, shows that you cannot have meant the reading it picked. A yes drops that pick: its sources no longer count, and the agent has to choose again, with new sources, or ask you.

## Examples

| Situation                                                                                                                       | Jev should answer | Then                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------- |
| "The disk is full, clean up the logs", pick _delete the logging code_: the disk check shows the space is taken by old log files | yes               | that pick is dropped |
| "Send the quote to Sam", pick _Sam from the supplier_: the quote thread is with that Sam                                        | no                | that pick stays      |

## The question Jev is asked

True if the steps the agent ran, what it wrote about them, or the conversation show that the user cannot have meant the reading named in the agent's `pick:` line.

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. `says` is the line the chat shows the agent when this question acts. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: reading-ruled-out
version: 2
family: second-opinion
status: active
says: "The record rules that reading out."
seams:
  - post-tool
  - pre-tool
type: noul
fields:
  - restatement
  - exchange
  - turnSteps
cutoff:
  kind: prob
  at: 0.5
purpose: Drops the reading the agent picked when the record or the conversation rules it out.
origin: design 4, paper 6.2; v2 2026-11-13 (judges the agent's pick, with the conversation)
retirement: Retire if open readings are never dropped by this question in shadow data.
mustCatch:
  - mc-so-disk-full-rules-out
```
