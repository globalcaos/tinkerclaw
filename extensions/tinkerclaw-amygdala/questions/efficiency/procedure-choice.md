# Forgotten skills: is there a skill or recipe for this?

_Efficiency: the right procedure, the right model, no wasted loops_ · J11 paper §6.5

Reusable procedures live as short files: skills, recipes. An agent that misses the right one improvises and spends tokens rediscovering a worse version. When your request arrives, a quick search shortlists up to three candidates, and Jev picks the one the request calls for, or none. Its answer is blended with each procedure's own track record: a high score loads the procedure, a middle one suggests it, a low one says nothing.

## Examples

| Situation                                                                      | Jev should answer | Then     |
| ------------------------------------------------------------------------------ | ----------------- | -------- |
| "Run the weekly-report recipe for last week.", with weekly-report listed first | `candidate-1`     | loads it |
| "What time is it in Tokyo?", with weekly-report and backup-check listed        | `none`            | nothing  |
| "Rename the variable count to total in demo.py."                               | `none`            | nothing  |

## The question Jev is asked

Which of the listed skills or recipes does the user's request call for? Pick by what the request asks to be done, and pick none when no listed one fits.

## The answers Jev can pick

- `none`: no listed skill or recipe fits the request
- `candidate-1`: the first listed skill or recipe is what the request calls for
- `candidate-2`: the second listed skill or recipe is what the request calls for
- `candidate-3`: the third listed skill or recipe is what the request calls for

## Settings

What the code reads. `seams` says when Jev is asked, `fields` which parts of the situation it sees, `cutoff` where its answer starts to act, `mustCatch` the test cases it must get right. Rewording the question or its answers? Raise `version`, so earlier verdicts stay tied to the words they answered. Edits take effect after the next rebuild (the ↻ button).

```yaml
id: procedure-choice
version: 1
family: efficiency
status: active
seams:
  - prompt
type: choice
fields:
  - request
  - candidates
cutoff:
  kind: choice
  option: none
  at: 0.6
  negate: true
purpose:
  Chooses the procedure a request calls for; the caller lists the candidates and maps each candidate to its
  name.
origin: paper 6.4
retirement: Retire if the recipe matcher in code picks the same procedure as this question.
mustCatch:
  - mc-ef-recipe-by-name
```
