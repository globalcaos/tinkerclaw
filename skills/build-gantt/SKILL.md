---
name: build-gantt
description: Draw a master-worker build as a Gantt chart in the chat. Phases in colour by kind of work (conception, spec, build, review and integration, field test, manual), one lane per parallel unit with its build and review segments at their real times, folded idle gaps, a now line, and the remaining phases as dashed estimates on their own scale. Use it in EVERY master-worker loop, before each turn is sent to the worker and at each phase review, and whenever the principal asks how a build is going ("report progress", "where are we", "show me the plan", "gantt").
---

# build-gantt

Canonical path: `~/src/tinkerclaw/skills/build-gantt/` (the workspace copy is a link to it).

A progress bar says how much. This chart says what ran beside what, how long each piece
really took, which phase we are in, and what is still ahead. The principal asked for it on
2026-10-01: "In every phase of the coding, report the progress in this chat before sending
work to your slave. The report cannot be just a progress bar, it has to have phases, in
different colors if possible, like a gantt, where one can understand the parallelism, the
complexity of tasks by their length and the different phases (from conception, spec
definition, coding, to a final fully visual manual)."

## When it runs

1. **Every send in a master-worker loop** (recipe `master-worker-coding`, Step 2): after the
   review, before `converse.mjs` sends the turn. Mark the phase being sent as `"status":
"next"` (or leave it planned), derive, render, and put the block in the turn's reply.
   In Tinker the reply must be the turn's last text block, so the chart arrives in the same
   turn as the send; say so in one line if the principal could read it as "after".
2. **Every phase review**, with the phase's real lanes filled in.
3. **On request**: "report progress", "where are we", "show the plan".

## The plan file

One JSON file per build, private, next to the charter (for example `<charter_dir>/gantt.json`).
The master owns it.

```json
{
  "title": "Product 2.0",
  "subtitle": "one line on where the times come from",
  "gap_minutes": 40,
  "future_share": 0.32,
  "phases": [
    {
      "id": "spec",
      "label": "Spec",
      "kind": "spec",
      "tasks": [
        { "label": "Questions answered", "segments": [["2026-09-30T06:15", "2026-09-30T08:33"]] }
      ]
    },
    {
      "id": "A",
      "label": "A · Foundations",
      "kind": "build",
      "workflows": ["wf_a8e2ad04-274"],
      "notes": { "A3": "one line shown in the lane's tooltip" },
      "tasks": [
        {
          "label": "Worker: pins, merges",
          "segments": [
            { "s": "2026-09-30T21:41", "e": "2026-09-30T21:50" },
            { "s": "2026-09-30T23:00", "e": "2026-09-30T23:12", "kind": "pause", "note": "reboot" }
          ]
        }
      ]
    },
    {
      "id": "C",
      "label": "C · Detection",
      "kind": "build",
      "status": "planned",
      "waits": "cameras back on the bench",
      "tasks": [
        { "label": "C1 config generator", "est_hours": 1.5 },
        { "label": "Integration", "kind": "review", "est_hours": 1, "after": "C1 config generator" }
      ]
    }
  ]
}
```

- `kind` is one of `conception`, `spec`, `build`, `review`, `field`, `manual`. The colours are
  fixed in that order and were checked with the `dataviz` validator on the dark card
  (`#241c14`): all pass, so never add a seventh colour; fold it into one of these.
- A segment is `[start, end]` or `{"s", "e", "kind", "note", "cut"}`. No `e` means running
  now. `"kind": "pause"` draws a grey hatch (a freeze, a reboot). `"cut": true` draws a red
  edge (killed before it finished).
- `workflows` lists the Claude Code Workflow ids the worker ran for that phase. `derive`
  reads their journals and each agent's own transcript and writes one lane per unit into
  `auto_tasks`: `build B3 recorder` and `review B3 recorder` become lane `B3 recorder` with
  two segments, at their real times. An agent that started, never returned a result and has
  been quiet for 10 minutes is marked cut. Lanes you write by hand stay in `tasks`.
- A planned phase (`"status": "planned"`) gets bars from `est_hours`. Its tasks run in
  parallel from the phase start unless `after` names a task in the same phase. Planned
  phases follow one another after the last real work. A phase with `"with": "<id>"` starts when that phase starts
  (run it beside it); a task with `"after_phase": "<id>"` starts when that whole phase ends. Start a
  phase as soon as its inputs exist: on 2026-10-01 this took the plan from 21 h to 15 h on the clock for
  the same 41 h of unit work. `waits` adds a ⏸ and a tooltip line.
- Times without a zone are local.
- Once a planned phase starts, drop its `status`, add its workflow ids and set `expect_until` (the worker's
  own deadline): running lanes then draw a dashed tail to it, a planned lane is dropped when a real unit
  with the same id appears (also across phases), and the phase's leftover lanes are scheduled from now.
  `not_before` holds a lane until a given time. A unit labelled `C1 build` or `build C1 …` lands in lane
  C1 either way, named after the plan's `C1 …` task.
- At every send, re-size the running phase's leftover `est_hours` from what it has cost so far. A time-left
  that stays flat while the phase runs past its plan is a finding: say so in the reply beside the chart.
  On 2026-10-01 Phase C was planned at 3.5 h, passed 10 h, and its time-left did not move in 2.5 h of work.

## Commands

```bash
G=~/src/tinkerclaw/skills/build-gantt/scripts/gantt.py
python3 $G derive <charter_dir>/gantt.json      # fill lanes from the workflow journals
python3 $G render <charter_dir>/gantt.json --png /tmp/gantt.png > /tmp/gantt.block.md
```

`render` prints a ` ```html-render ` block: paste it into the Tinker reply. It leaves out the table view to stay small (about 35 KB
for 18 lanes and 6 planned phases); `--html` writes the full page with the table. Add `--collapse-done` for the reports after the first one in a build:
finished phases fold to their summary row and running and planned phases keep every lane. Keep one `--html` and
`--png` per send in the build folder (`<charter_dir>/gantt/<nn>-<phase>.html`) so every phase's chart can
be reopened later. `--png` also
writes a screenshot (headless Chrome). **Look at the PNG before you post the block**, every
time: the layout depends on the data, and a chart nobody looked at is not done. On WhatsApp
or any channel that cannot draw HTML, send the PNG instead of the block.

## Delivery check — inspect the reply, not only the chart

Before sending, the actual reply must contain the generated `html-render` chart block, or a native markdown image at `/tinker/diagrams/<file>-chat.png` linked to the full PNG. For PNG delivery, follow `/home/user/.openclaw/workspace/memory/knowledge/tinker-inline-diagrams.md`: copy to both public and dist, check HTTP 200, and LOOK at the served image. Never substitute `[embed ref=...]`, a hosted page reference, or a status card for the inline chart. A screenshot of the standalone page proves the chart exists; it does not prove the reply includes a renderable chart. Replay this check against the final reply text; an embed-only reply fails even when its referenced file exists. After a repeated missing-chart report, do not keep repeating markdown syntax checks: emit a direct `<img>` in `html-render`, then verify that the latest Tinker snapshot's `#messages` contains that image element. HTTP 200 and matching reply syntax alone do not establish delivery.

## How to read it (say this once to a new reader)

- Bar length is working time. Idle stretches longer than `gap_minutes` are folded into a
  hatched band with the gap's length under it.
- Real work and the plan have separate scales. The plan (dashed bars, `+N h` ticks) gets at
  most `future_share` of the width, so a long estimate never squeezes the work that happened.
- Bars side by side in time are work that ran in parallel; a lane's green part is its build,
  the amber part its review.
- "Estimated left" is clock time (overlapping bars count once); the unit work summed over lanes
  is in brackets. The gap between the two is the parallelism.
- The top row is the whole programme, one block per phase. "About N % done" counts real
  working time against real plus estimated time, so it moves when the estimates move.

## Failures Overcome

- 2026-10-04 09:02, the architect: "You still failed to show me the gantt, try again." The prior markdown-image syntax check passed but did not prove delivery. A direct image in `html-render` produced an `<img src="/tinker/diagrams/sv2-gantt-31-chat.png">` inside the live snapshot's `#messages`. Repeated delivery failures now require checking that destination element, not only reply syntax.

- 2026-10-04, the architect: "You failed to show me the gantt chart." The SV2 status reply replaced the required chart block with `[embed ref="sv2-status-30" ...]`. The standalone screenshot had been inspected, but the inline-diagram procedure already forbade that delivery form. The delivery check now rejects the exact embed-only reply and requires the native chart block or served markdown image.

- 2026-10-01 22:34, AcmeVision 2.0 build: two planned lanes of a new phase, "I1 overview…" and "I2 a chapter…",
  vanished from the chart. A label's first token is read as a unit id, and Phase B already had real units I1 and
  I2, so the planned lanes counted as done. Give planned lanes of a new phase plain names, or ids no earlier phase
  used. In the same render, `after_phase` on a lane of a phase that is already running was ignored (a running
  phase schedules its leftover lanes from now): a lane that must wait for a later phase goes into that later
  phase.

- 2026-10-01, first draft: one linear scale for real work (14 h) and estimates (39 h) gave
  the plan most of the width and turned ten parallel Phase B units into slivers, the very
  parallelism the chart exists to show. Hence the two scales and `future_share`.
- 2026-10-01: date and hour labels collided on the axis, and three idle-gap labels ran into
  each other. Dates now sit on their own row, colliding tick labels are dropped, and gap
  labels are short and alternate between two rows.
