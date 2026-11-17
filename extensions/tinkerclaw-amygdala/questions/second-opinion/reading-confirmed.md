# Ambiguity: do two sources show what you meant?

_Second opinion: did it understand you, and does it stay on course?_ · J11 paper §6.2

Once your request is flagged as ambiguous, the agent does not guess: it lists the readings (`- reading:` lines), names the one it acts on (`- pick:`), and cites the sources that point to it (`- source: <file or message> — <what it shows>`). One source is not enough; the answer has to be redundant. Code first checks the sources: a file counts only if a call in this turn opened or searched it, a message only as a quote that is really in the conversation, two citations of the same file count once, and at least one source must be a file. Only when two sources pass is Jev asked this question. A yes settles the reading, and the held steps run.

## Examples

| Situation                                                                                                           | Jev should answer | Then                       |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------- |
| "Send the quote to Sam", pick _Sam from the supplier_: the person file and the open quote thread both name that Sam | yes               | settled, the agent goes on |
| the same pick, with two sources that only say a Sam exists                                                          | no                | still open                 |
| pick _the newer report_: the same file cited twice                                                                  | (not asked)       | code counts one source     |

## The question Jev is asked

True if the sources the agent cites in its `source:` lines, together with the conversation and the steps it ran, show that the user meant the reading named in its `pick:` line, and not the other readings it listed.

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. `says` is the line the chat shows the agent when this question acts. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: reading-confirmed
version: 2
family: second-opinion
status: active
says: "Two sources show what was meant. Go with it."
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
purpose: Settles a flagged request when two independent sources the agent cites point to the reading it picked.
origin: design 4, paper 6.2; v2 2026-11-13 (redundant sources, asked only after code checked them)
retirement: Retire if open readings are never settled by this question in shadow data.
mustCatch:
  - mc-so-quote-thread-second-sam
```
