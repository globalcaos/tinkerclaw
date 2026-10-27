## Chapter: friction — errors, retries, stalls, unattended failures

_Why this chapter came with your prompt: the gate saw tool errors or repeated tool calls in the
trail, or a nudge on work that should have been running. v4 chapters 3 (friction, 2026-10-08) and
12 (unattended jobs and self-heal)._

### Every retry is a cost the next run pays again

- [ ] Read the trail digest (tool calls by name, error counts, duration, tokens), then the trail
      itself: every tool call and result of the main turn is in your context.
- [ ] List every error, retry, probe loop, timeout, workaround and fallback. Each one is a cost
      the NEXT run of the same task pays again unless something changes on disk.
- [ ] For each, fix the governing skill or recipe so the next run takes the shortest path: the
      working route first, the exact query or command that worked, a ready script. State the
      saving as "next time: N calls → 1".
- [ ] A tool that failed with no detail ("tool execution failed", nothing else) is a defect to
      diagnose (log it, reproduce it), not a footnote.
- [ ] A friction you saw and only described is the failure this chapter exists for. "Open" with no
      edit to the skill is a miss.

Worked instance. The owner, 2026-10-08 06:36: "Veig que has tingut dificultats transitòries per
accedir al Factorial, però ho has arreglat. Fractal hauria d'haber detectat aquest moviment i
hauria d'haber arreglat el skill de Factorial per tal que la propera vegada això no passi i es
gastin menys tokens accedint-hi." (Fractal should have fixed the Factorial skill so that next time
fewer tokens are spent getting there.) Asked to check his leave, the turn needed ~20 tool calls.
The jarvis MCP `browser act evaluate` failed twice with a bare "tool execution failed" (even on
`document.title`); the CLI `openclaw browser evaluate --target-id … --fn …` worked. GraphQL
introspection is disabled, so finding `allowanceBalancesConnection` took five probe rounds of ~8 s,
one of which outran the 120 s tool timeout. The reflection listed the MCP failure as "open"; the
skill got notes, not a one-command path.

### Interruptions: the owner had to restart work that stopped on its own

_Added 2026-10-09._ One turn's trail cannot show this: the stall happens between turns, while the
chat is idle. It shows up as the next prompt.

- [ ] **Trigger.** His prompt only asks to resume or report ("keep going", "continue", "progress?",
      "any news?", "segueix") and the turn before it ended with work running in the background (a
      long job, a fan-out, a waiter, a slave tab, a spawned agent). That prompt is a defect report:
      the work stopped and nothing told him.
- [ ] **Measure the dead time.** When did the work's progress last move (its job log, its
      `state.json`, the files it writes), and when did he nudge? Count the nudges this task has
      needed in this chat; the second one is a recurrence: fix what produces it, not the instance.
- [ ] **List every waiter the earlier turn left and what each one watches.** A waiter that watches
      only success (a file appearing, an "ok" status, a counter reaching its total) cannot see a
      dead producer. A multi-hour timeout is dead time, not a safety net. A progress card that says
      "running" while its number has not moved is wrong.
- [ ] **Find what stopped the work before theorising:** gateway boots in the window (`gw.boot` in
      `~/.openclaw/logs/events.sqlite`, the gateway journal), usage limits (synthetic "limit"
      replies, `scripts/claude-usage.py`), children that ended without their artifact, waits that
      never resolve.
- [ ] **Fix the waiting, not the instance:** the waiter also watches liveness and failure, and
      wakes the chat when progress stalls, when a child ends without its artifact, or when the
      machinery under it restarts. Then resume the work itself. A reflection that only notes the
      stall is the miss.

Worked instance. The owner, 2026-10-09 18:32: "This process is not going as smooth as possible.
This has been interrupted too many times. Fractal should have picked up on it and should have
investigated the cause and fixed it." A 20-paper fan-out ran 08:43–18:00; he typed "keep going"
three times, after 210, 116 and 150 minutes of silence. Causes: a Claude weekly limit that killed
11 analysts which still read as finished, and three gateway restarts (11:07, 14:32, 15:14). Every
waiter watched for a success file or an "ok", the card said "running" throughout, and one
reflection called a three-hour timeout a safety net. That day, one of six nudges on stalled work
was followed by a reflection that looked for the cause.

### Unattended: did anything scheduled fail while nobody watched?

_Added 2026-09-05._ A failing cron is the highest-value thing to reflect on and the least likely
to get a reflection: a run that dies mid-way produces no turn end to reflect from. An interactive
turn inherits the duty.

- [ ] Whenever the turn touched automation, config, models or a published surface, and always when
      the owner reports something broken he did not break, run:

```
python3 -c "import json;s=json.load(open('$HOME/.openclaw/cron/jobs-state.json'));d=s.get('jobs',s);
print([(k,v['state'].get('lastRunStatus'),v['state'].get('lastErrorReason'),(v['state'].get('lastError') or '')[:70]) for k,v in d.items() if v.get('state',{}).get('lastRunStatus')=='error'])"
ls -t ~/.openclaw/cron/reports/$(date +%F)/ 2>/dev/null
```

- [ ] A job whose last run errored, or whose report for today is simply MISSING, failed silently,
      and its partial work usually sits uncommitted in a working tree. Read `lastErrorReason`
      before theorising.
- [ ] `timeout` means the run was cut. `FallbackSummaryError: All models failed (1)` means a
      ONE-ENTRY chain: a single-supply outage killed it, and the ladder is the fix, not the model.
- [ ] `auth` is the one that will fool you. **Before declaring a credential dead, find its WRITER
      and read the file the writer actually targets.** A stale artifact beside a live one is the
      most convincing wrong answer there is.
- [ ] Fixing a job's inputs, ladders and refresh timing is reversible and belongs here. Asking the
      owner to re-authenticate is a claim on HIS time, so it must survive the writer check first.

### Self-heal: is the machinery itself intact?

- [ ] Only when the turn touched it or symptoms suggest breakage; probing everything every turn is
      its own failure mode.
- [ ] Four layers: is this reflection lane firing (once, not twice, not never); did an external
      sense fail (auth expiry, dead relay, stale token); are memories readable; is the environment
      consistent (config says one thing and the runtime does another, source edited but the built
      artifact stale).
- [ ] On damage: diagnose by reading, not guessing → classify reversible or not → repair with tool
      calls → verify by re-running the probe → immunize by encoding it.
- [ ] **The bar: the owner should never have to tell you something is broken that you could have
      detected yourself.**

Worked instance, 2026-09-05: an xAI JWT twelve days expired in
`~/.openclaw/agents/main/auth-profiles.json`, and the owner was told to re-authenticate. Wrong: the
live profile is `agents/main/agent/auth-profiles.json`, one path segment away, refreshed
automatically; `grok-oauth.mjs` names it in its own header, and one `grep -rl` for the filename
would have found it. The real cause was duller: a ~30-minute turn started with 16 minutes of token
left, and the refresher only fires under a 20-minute margin, never mid-turn.
