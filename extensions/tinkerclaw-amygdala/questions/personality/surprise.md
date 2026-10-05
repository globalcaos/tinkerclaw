# Surprise: did the result contradict what it expected?

_Personality: curiosity, surprise and a steady voice_ · J11 paper §6.4

Before each tool call the agent writes a sentence about what it is about to do; that sentence is its expectation. When the result says otherwise, it is easy to skate past it. After the call Jev compares the two: no surprise, partly, or the opposite. Only "the opposite" gives the agent a note, naming both before its next step: "you expected the tests to pass; they failed". "Partly" is common (an agent's sentence states an intent more often than a prediction) and stays quiet (raised from "partly" on 2026-10-03, after the first live hour gave six notes in a row in one chat).

## Examples

| Situation                                                              | Jev should answer | Then                |
| ---------------------------------------------------------------------- | ----------------- | ------------------- |
| expected the test suite to pass; it failed                             | 2 · opposite      | a note to the agent |
| expected the search to return 3 files; it found none                   | 2 · opposite      | a note to the agent |
| expected the tests to pass; they passed                                | 0 · no surprise   | nothing             |
| expected a listing with the export folder; got it, plus one extra line | 0 · no surprise   | nothing             |
| said it would read the config to find the port; the port was not there | 1 · partly        | nothing             |

## The question Jev is asked

Compare the last tool result with what the agent said it expected. How far apart are they?

## The answers Jev can pick

0. no surprise: the result matches what the agent said it expected
1. partly: some of the result differs from what the agent said it expected
2. opposite: the result is the reverse of what the agent said it expected

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: surprise
version: 1
family: personality
status: active
seams:
  - post-tool
type: score
fields:
  - expectation
  - toolRecord
cutoff:
  kind: level
  atOrAbove: 2
purpose: Marks a result that contradicts the stated expectation, so a note can make the agent look again.
origin: paper 6.5
retirement: Retire if expectations are compared by code with the same catches.
mustCatch:
  - mc-pe-expected-pass-got-fail
  - mc-pe-expected-3-got-0
```
