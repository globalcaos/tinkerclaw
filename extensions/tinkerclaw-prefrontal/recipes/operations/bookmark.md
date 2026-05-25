---
schema: recipe/1.0
id: bookmark
title: Bookmark & Switch (rabbit-hole handler)
category: operations
summary: When mid-task you discover you need a new capability, decide which task to defer (and how to preserve context) so neither is lost.
triggers:
  [
    rabbit hole,
    while we're at it,
    we should also build,
    bookmark this,
    save for later,
    defer this,
    switch to,
    opportunistic feature,
  ]
effort: light
tools: [read, edit, exec, openclaw-control-panel]
children: []
---

## Goal

Handle the "two-tasks-collided" moment: you started task X (a fix, a deliverable), and partway through you realised you actually need a new capability Y that needs its own brainstorm → spec → plan → build cycle. Pick which one to ship now and which to bookmark, then preserve the bookmarked task with enough context that a future agent (or future-you) can resume it cold.

## When to Use

- You're executing a plan and find that one of the steps requires building a new tool/feature/recipe not in the plan.
- A user request reveals an underlying gap that itself merits a separate ticket.
- Mid-debug you realise the bug is one symptom of a broader missing capability.
- Any "...but to do this properly we'd need to first build X" moment.

## Steps

### 1. Detect

**Tools:** read
**Done when:** You've named both tasks explicitly — "task X" (the one in flight) and "task Y" (the new realisation).

State both tasks in chat. Write them as one-line headings: _"In flight: X — adding navigation guard. Discovered: Y — need recipe for handling mid-task rabbit holes."_ If you can't name them clearly, you don't understand the situation yet — stop and read more code.

### 2. Decide

**Tools:** read
**Done when:** You've picked which one to bookmark and stated the reason.

Apply this rule:

- **Hard deadline today on task X?** → bookmark **Y** (the rabbit hole). Ship X with whatever existing tools allow — the ugly version is fine. The deadline wins.
- **No deadline pressure?** → bookmark **X** (the original). Go down the rabbit hole and build Y properly. Then return to X and use Y to complete it cleanly.

The trade-off is real and worth naming explicitly:

| Path                        | Wins                                            | Costs                                                                                                                                                 |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookmark Y (tight deadline) | X ships fast today                              | When Y comes back off the stack later, you'll have less context and harder testing — Y was discovered AS A REAL NEED via X, and that connection fades |
| Bookmark X (deep dive)      | Y lands cleanly and is immediately tested via X | X is delayed by hours-to-days                                                                                                                         |

Do not pretend the choice is free. State the trade-off in chat as part of the decision.

### 3. Bookmark

**Tools:** openclaw-control-panel
**Done when:** A Control Panel task exists in the `jarvis-bookmarks` axis with the full context block (see template below).

Create the bookmark via:

```bash
openclaw gateway call control-panel.tasks.create --params '{
  "priority_axis": "jarvis-bookmarks",
  "text": "<one-line summary>",
  "status": "open",
  "context_md": "<the template below, filled in>"
}'
```

If `jarvis-bookmarks` does not exist as an axis yet, use `meta` and tag the title with `[BOOKMARK]` as a fallback — flag this to the user as a one-line note ("Tagged in meta because jarvis-bookmarks axis isn't registered yet").

**Context template (fill every field — partial bookmarks are useless):**

```markdown
## Origin

- **Triggered by:** <the task that was in flight when we discovered this>
- **Date:** <YYYY-MM-DD>
- **Path chosen:** bookmark-Y (deep-dive deferred) OR bookmark-X (tight-deadline deferred)

## What was happening

<2-4 sentences describing where you were in the original task when you realised you needed this capability. Specifically: what symptom or limitation surfaced the need.>

## What this capability needs to do

<3-5 bullet points of acceptance criteria — what "done" looks like. Be concrete: file paths, function names, behavioural assertions.>

## State of work so far

- **Git refs:** <commits already landed, branches in play, any WIP>
- **Files touched:** <paths>
- **Specs / plans:** <links to any spec/plan docs already drafted>
- **Open questions:** <unresolved decisions that future-resume must make>

## Specific resumption point

<One sentence: where exactly to pick this up. e.g. "Start by reading the prefrontal recipe catalog format, then write recipes/operations/bookmark.md.">

## Trade-off being incurred

<Restate the deadline/depth choice from step 2 and why it was right at the moment of bookmarking.>
```

### 4. Tackle the chosen path

**Tools:** whatever the path needs
**Done when:** The non-bookmarked task ships (committed, tested, verified).

Execute as a normal task — follow the appropriate recipe (debug, feature, etc.) for whichever one you kept in flight. The bookmark stays static during this work; you can update it if state drifts significantly, but don't churn it.

### 5. Resume the bookmark (eventually)

**Tools:** read, openclaw-control-panel
**Done when:** The bookmarked task is being executed AS IF you wrote the context yesterday, even if it was weeks ago.

When the bookmarked task is picked up:

1. Read its `context_md` in full — no skimming.
2. Verify the "Git refs" still exist (commits may have been rebased; specs may have moved).
3. Note the time gap and any state drift in a quick chat update.
4. Update the bookmark status (`in_progress`) before starting.
5. Execute via the appropriate recipe.
6. Mark `resolved` when done.

## Constraints

- One active in-flight task at a time. Don't bookmark _both_ and then forget — that just loses context twice.
- The bookmark MUST include "Specific resumption point". Without that field, the bookmark is a TODO label, not a resumption aid.
- Don't bookmark in chat memory alone. The Control Panel task is the durable artifact; chat is ephemeral.
- The trade-off must be stated explicitly when the bookmark is created. "We're choosing this because <X>" is not optional.

## Safety Notes

- If a deadline is invoked to push the "bookmark Y" path, **name the deadline source**. "the user said urgent" or "PR review window closes at 5pm". A vague "deadline pressure" without a real source is usually a sign of premature optimisation toward shipping.
- The faster-now path leaves technical debt. The bookmark IS the debt receipt — make sure it's specific enough that paying it back is possible.
- If after writing the bookmark you can't articulate the resumption point in one sentence, you don't yet understand what you're deferring. Either think harder or pick the deep-dive path.

## Failures Overcome

- **Lost rabbit-hole task:** Without a recipe for this pattern, the second task either gets attempted ad-hoc (interleaved messily into the first) or quietly dropped. The deep-dive path with a written bookmark is the cleanest recovery.
- **Tight-deadline panic with no rabbit-hole record:** Shipping X under deadline pressure used to leave Y as a vague chat note — by next session, the connection between Y's need and X's failure mode was gone. The bookmark template's "What was happening" field preserves that.
- **Wrong path chosen:** Picking "deep dive" with a real deadline blocks delivery; picking "tight deadline" without one accumulates debt. The explicit deadline-source check at step 2 forces the right framing.

## Related

- `feature` (for the deep-dive path once Y is brainstormed-spec'd-planned)
- `debug` (for the tight-deadline-on-X path when X is itself a bug fix)
- `[[feedback_subagent_driven_default]]` — if Y is non-trivial, dispatch its plan to subagents per the standard rule.
