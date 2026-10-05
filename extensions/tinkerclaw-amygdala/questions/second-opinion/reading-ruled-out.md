# Ambiguity: does the record show what you did not mean?

_Second opinion: did it understand you, and does it stay on course?_ · J11 paper §6.2

The mirror of the previous prompt. After each tool result Jev is asked, for each open reading, whether the record shows that you cannot have meant it. A yes drops that reading. When one reading is left and the rest are ruled out, the agent goes ahead; when two remain that lead to different actions, it asks you to pick.

## Examples

| Situation                                                                                                                          | Jev should answer | Then                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------- |
| "The disk is full, clean up the logs", reading _delete the logging code_: the disk check shows the space is taken by old log files | yes               | that reading is dropped |
| "Send the quote to Jordi", reading _Jordi from the supplier_: the quote thread is with that Jordi                                  | no                | that reading stays      |

## The question Jev is asked

True if something in the tool record shows that the user cannot have meant this reading of the request.

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: reading-ruled-out
version: 1
family: second-opinion
status: active
seams:
  - post-tool
  - pre-tool
type: noul
fields:
  - restatement
  - toolRecord
cutoff:
  kind: prob
  at: 0.5
purpose: Drops one open reading when the record itself rules it out.
origin: design 4, paper 6.2
retirement: Retire if open readings are never dropped by this question in shadow data.
mustCatch:
  - mc-so-disk-full-rules-out
```
