# Asking why: would knowing why you ask change the work?

_Second opinion: did it understand you, and does it stay on course?_ · J11 paper §6.2

Sometimes the right answer depends on what the request is for. "Make the report shorter": for your boss, or for a slide? This prompt asks Jev whether your request leaves its purpose out in a way that would change what the agent should do; the plan is that the agent then asks you one question back. It is a sketch and ships switched off, until shadow data shows it is worth the interruption.

## Examples

| Situation                                        | Jev should answer | Then                                         |
| ------------------------------------------------ | ----------------- | -------------------------------------------- |
| "Make the report shorter."                       | yes               | (when on) one question back: what is it for? |
| "Rename the variable count to total in demo.py." | no                | goes ahead                                   |

## The question Jev is asked

True if the user's request does not say what it is for, and knowing that would change what the agent should do.

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: purpose-unclear
version: 1
family: second-opinion
status: "off"
seams:
  - prompt
type: noul
fields:
  - request
cutoff:
  kind: prob
  at: 0.8
purpose: Sketch of a question that asks why; ships off until shadow data shows it is worth an interruption.
origin: design 4 (sketch)
retirement: Retire if it never separates requests the agent handled well from ones it did not.
mustCatch: []
```
