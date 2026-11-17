---
default-version: 1.2
override-target: ~/.openclaw/workspace/plan-tools.md
---

## Multi-step plans

When a user request will take more than two distinct steps, call
`prefrontal.plan.set` first with intent + step titles.
Every plan call needs your session key, which the bridge exports as
`$TC_SESSION_KEY` (without it the call fails: "must have required property
'sessionKey'").
Send each plan call as one Bash command that tries the bridge's lean client
first. `$TC_RPC`, when the bridge exported it, sends the RPC in about a second;
`openclaw gateway call` boots the whole CLI first (about 8 s). The CLI half runs
only when `$TC_RPC` is unset or exits 3, which means nothing was sent:
`P="{\"sessionKey\":\"$TC_SESSION_KEY\",\"intent\":\"…\",\"steps\":[{\"title\":\"…\"}]}"; r=3; [ -z "$TC_RPC" ] || { node "$TC_RPC" prefrontal.plan.set "$P"; r=$?; }; if [ $r -eq 3 ]; then openclaw gateway call prefrontal.plan.set --timeout 60000 --params "$P"; else (exit $r); fi`.
Mark each step in_progress when you start it, and done with a one-line note
when you finish. The note should be the smallest summary that lets a future
you skip redoing the step (e.g. "wrote slo-burn.test.ts with 5 cases").
The step call takes `stepIndex` (0-based, not `index`):
`P="{\"sessionKey\":\"$TC_SESSION_KEY\",\"stepIndex\":0,\"status\":\"done\",\"note\":\"…\"}"; r=3; [ -z "$TC_RPC" ] || { node "$TC_RPC" prefrontal.plan.step "$P"; r=$?; }; if [ $r -eq 3 ]; then openclaw gateway call prefrontal.plan.step --timeout 60000 --params "$P"; else (exit $r); fi`.
If `$TC_RPC` exits 5, the call was sent and its answer was lost, so the gateway
may have applied it. Do not send it again blind. A second set replaces the plan
and resets every step, and a second close fails with "no plan". Read the plan
the same way with `prefrontal.plan.get` and
`P="{\"sessionKey\":\"$TC_SESSION_KEY\"}"` (a read is safe to repeat), then
send the call again only if the plan does not show it. After a close,
`"plan": null` means the close went through.
Keep `--timeout 60000` on the CLI half of every plan call: the CLI's 10 s
default times out while the gateway is busy with a fan-out, and the step is
silently not recorded. `$TC_RPC` already waits up to 60 s. At a terminal, the
CLI line alone does the same job.

If you are restarted mid-step, you will be auto-resumed by a [System] continue
turn. Read your plan file (path will be given) before doing anything — your
prior notes tell you what is already complete.

When all steps are done, call `prefrontal.plan.close` with status:"done", the same way.
