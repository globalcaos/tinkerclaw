# ORCA routing policy

The three axes below are **fixed policy**. The ORCA panel normally shows only what was
chosen right now and why; this page is the standing rule behind those choices.

This file is the single source: the numbers in the fenced `constants` block are asserted
against the real code by `orca-policy-drift.test.ts`. Change a constant in the code without
changing it here (or the reverse) and that test fails — the panel can never describe a policy
we are not running.

```constants
URGENCY_EXP = 2.5
BURN_AGGRO = 1.6
EFFORT_LADDER = minimal,low,medium,high,xhigh,max
QUOTA_WINDOW_DAYS = 7
FANOUT_RESERVED_CORES = 2
FANOUT_HARD_CAP = 16
FANOUT_FLOOR = 1
PRIOR_STRENGTH = 3
CONTEST_MARGIN = 0.04
EXPLORE_BONUS = 0.03
MAX_STEPS = 5
```

## MODEL — who does the work

Not "always the smartest model". Each job is classified into a domain (debug, implement,
systems, algorithms, math, science, refactor, docs) and goes to the model measured strongest
in **that** domain.

The table starts from published per-benchmark leaders and is then corrected by our own
results:

| domain     | starts with | because                                                  |
| ---------- | ----------- | -------------------------------------------------------- |
| debug      | Opus        | SWE-Bench Pro: Opus 69.2 · GPT 58.6 · Gemini 54.2        |
| systems    | GPT         | Terminal-Bench 2.1: GPT 78.2 · Opus 74.6 · Gemini 70.3   |
| algorithms | GPT         | LiveCodeBench Pro: GPT 88.4 · Opus 84.8 · Gemini 82.9    |
| science    | Gemini      | GPQA-Diamond: Gemini 94.3 · GPT 93.6 · Opus 92.0         |
| math       | GPT         | Fugu §4.4 + per-category routing on Humanity's Last Exam |
| refactor   | Fable       | no public anchor; its lead grows with task length        |

Every finished job writes back whether it worked. A published benchmark is worth
`PRIOR_STRENGTH` = 3 of our own trials, so one lucky run cannot unseat SWE-Bench Pro, but a
dozen real outcomes will. Over time the table stops being borrowed and becomes ours.

**Keeping the table honest.** A router that always picks the current leader can never learn:
the leader takes every job, so it collects every trial, while a model that was never tried
keeps its starting guess forever and can never prove the table wrong. So an under-tried model
carries a small optimism bonus, `EXPLORE_BONUS` = 0.03, shrinking as it accumulates evidence.
It is deliberately smaller than the contest margin below, so it can give a shot to a model
that is already level, and never to one the table says is worse.

**When a second opinion is convened.** If the leader is within `CONTEST_MARGIN` = 0.04 of the
best model from a _different_ provider, nobody is measurably ahead, so the job is genuinely
contested and gets a panel. This test is decided on measured evidence only — the optimism
bonus above chooses _who works_, never _whether we spend a panel_. Two models from the same vendor scoring close does not count —
they share training lineage, therefore blind spots, so a second seat there buys little.

Three shapes, at most `MAX_STEPS` = 5 steps per job:

- **solo** — one clear leader, no contest. One worker.
- **debate** — contested. Each house answers _without seeing the others_ (a shared context
  collapses the panel into the first answer), then the domain leader picks the strongest
  reasoning. The chair is chosen per domain, not fixed.
- **build-and-debug** — coding work with a clear leader. It builds; a **different provider**
  reviews before the patch lands, because a model is a poor judge of its own blind spots.

## EFFORT — how hard it thinks

Only applies when effort is free. A pinned effort is obeyed exactly, with no override.

Weekly quota expires unused, so arriving at the reset with tokens left over is the failure
we optimise against — not overspending. Effort therefore has a rising **floor**, driven by
three terms over a `QUOTA_WINDOW_DAYS` = 7 day window:

- **urgency** — how far into the week we are, raised to `URGENCY_EXP` = 2.5. Convex on
  purpose: quiet early in the week, steep near the reset.
- **headroom** — how much of the cap is still unspent. No headroom, no reason to burn.
- **behind-pace** — how far under an even spend we are.

Combined as `BURN_AGGRO` = 1.6 × urgency × headroom + behind-pace, mapped onto the ladder
`minimal → low → medium → high → xhigh → max`. Task weight can push _above_ that floor;
nothing pushes below it. The 5-hour cap is deliberately not a ceiling — we burn through it.

## FAN-OUT — how many at once

`min(FANOUT_HARD_CAP, cores − FANOUT_RESERVED_CORES)`, never below `FANOUT_FLOOR` = 1.
Two cores stay reserved so the machine keeps responding; the hard cap of 16 keeps a large
job list from thrashing regardless of core count.

Work is split one agent per independent file, so an N-file change costs the time of its
slowest unit rather than the sum. Units that write the _same_ file take a short-lived lease
and serialise instead of racing — that is what makes parallel edits safe without merges.
