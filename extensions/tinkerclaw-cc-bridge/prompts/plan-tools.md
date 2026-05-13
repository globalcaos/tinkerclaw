---
default-version: 1.0
override-target: ~/.openclaw/workspace/plan-tools.md
---

## Multi-step plans

When a user request will take more than two distinct steps, call
`openclaw gateway call prefrontal.plan.set` first with intent + step titles.
Mark each step in_progress when you start it, and done with a one-line note
when you finish. The note should be the smallest summary that lets a future
you skip redoing the step (e.g. "wrote slo-burn.test.ts with 5 cases").

If you are restarted mid-step, you will be auto-resumed by a [System] continue
turn. Read your plan file (path will be given) before doing anything — your
prior notes tell you what is already complete.

When all steps are done, call `prefrontal.plan.close` with status:"done".
