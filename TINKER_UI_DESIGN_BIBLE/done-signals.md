---
file: done-signals.md
purpose: The cross-signal methodology for "is this turn/task done?" — the master map of every input that drives the Tinker UI thinking/activity indicator, their authority/precedence, and a fixed procedure for analysing or changing this area before bugs surface.
audience: AI (Claude, etc). Human readability is incidental.
last_verified: 2026-08-17
last_verified_commit: HEAD
single_owner: yes — the cross-signal *precedence contract* and the master doneness map live here. Per-signal facts are owned elsewhere (lifecycles.md = session/worker/recovery state machines; tool-loop.md = heartbeat/idle-watchdog/lifecycle:end emission/no-UI-watchdog; flows.md = the chat.final guarantee + F-PLAN-RESUME; subagents-and-recipes.md = plan/kit/recipe; panels.md = prefrontal render levels + the §147 helpers; failures.md = failure-mode maps). This file does NOT re-derive them — it sequences them.
see_also: lifecycles.md (L1 session, L2 tinker-bridge worker, L4 restart-recovery), tool-loop.md (heartbeat, idle watchdog, lifecycle:end emission, the deleted UI watchdog), flows.md (chat.send always ends in a final/error/aborted broadcast; F-PLAN-RESUME), panels.md (§115 prefrontal render levels, §147 single-source-of-truth helpers), subagents-and-recipes.md (plan RPCs, kits, recipes, restart-continue), failures.md (M1 idle SIGTERM, M2 stuck spinner, incomplete_turn)
verify:
  - name: chat.final/aborted is authoritative-and-immediate AND cancels the debounced lifecycle:end delete (the core precedence contract this doc owns)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert re.search(r"pendingRunDeletes\.get\([^)]*\)[\s\S]{0,240}clearTimeout[\s\S]{0,200}activeRuns\.delete", t), "the chat.final/aborted handler no longer cancels the pending lifecycle:end timer before deleting the run — the authoritative-supersedes-debounced precedence (done-signals.md) is broken; a late lifecycle:end timer can now delete a run the user already re-used, or final no longer closes the run immediately"; assert re.search(r"pendingRunDeletes\.set\(", t) and re.search(r"setTimeout\([\s\S]{0,320}activeRuns\.delete", t), "the lifecycle:end debounced (delayed) delete path is gone — lifecycle:end must remain the advisory/debounced half of the contract, NOT an immediate delete; re-read done-signals.md before changing turn-completion"'
  - name: prefrontal render precedence is plan-first then live-tree then idle (the §115 ladder this doc sequences)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/prefrontal-tree.ts")).read(); assert "Priority 2" in t and "synthetic" in t.lower(), "prefrontal-tree.ts no longer documents the explicit-plan → synthetic-2-step → idle priority ladder; done-signals.md §3 and panels.md §115 describe a precedence that the code must still implement"'
  - name: the terminal lifecycle phase:"error" event carries the SAME identity fields as phase:"end" so the Tier-3 debounced delete fires for errored runs too (FORK 2026-06-04, the error-clears-the-run precedence this doc owns)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/src/agents/embedded-agent-subscribe.handlers.lifecycle.ts")).read(); m=re.search(r"phase:\s*\"error\",\s*\n", t); assert m, "could not find the terminal phase:\"error\" emit object in handleAgentEnd"; blk=t[m.start():m.start()+600]; assert "model:" in blk and "sessionKey:" in blk, "the terminal phase:\"error\" gateway event no longer carries model+sessionKey — the Tinker UI gates its lifecycle handler on p.data?.model, so an identity-less error event is DROPPED and the errored run is NEVER scheduled for the Tier-3 debounced delete (its thinking indicator sticks + stacks). done-signals.md §2: phase:error MUST mirror phase:end identity. Re-read before touching the lifecycle terminal emit."'
  - name: R2b — exactly ONE activity clock, and it ticks under a second (FORK 2026-08-17, five reports of a blank/desynced indicator)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); m=re.search(r"const ACTIVITY_TICK_MS\s*=\s*([0-9_]+)", t); assert m, "ACTIVITY_TICK_MS is gone. done-signals.md R2b requires exactly ONE sub-second clock driving every activity surface; without it a poll-only input (sessions[].run, elapsed seconds) is never re-read and the indicator stays blank for whole turns."; ms=int(m.group(1).replace("_","")); assert ms <= 1000, "the activity clock is %dms. R2b requires under 1s (the architect, 2026-08-17: ideally 0.5s)." % ms; assert "thinkingTickInterval = setInterval" not in t and "livenessRepaintInterval = setInterval" not in t, "a SECOND activity clock is back. Two clocks means two phases: the same fact renders at different moments on different surfaces, which is the R2 corollary desync fixed on 2026-08-17."'
  - name: R2b — every governed surface repaints from the ONE trigger, and the one clock calls it (would have failed on the 2026-08-15 regression)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); m=re.search(r"function repaintActivitySurfaces\(\)[^{]*\{(.*?)\n\}", t, re.S); assert m, "repaintActivitySurfaces is gone — it is the ONE TRIGGER named in run-state.ts and done-signals.md R2b."; body=m.group(1); missing=[f for f in ("updateSessionsPanel","updateBudgetPanel","repaintThinkingIndicator") if f not in body]; assert not missing, "these surfaces left the one trigger: %s. A surface repainted on its own schedule holds a stale answer indefinitely — it is not late, nothing will correct it. That is verbatim the 2026-08-15 bug (the chat indicator was the surface left out)." % missing; c=re.search(r"function activityTick\(\)[^{]*\{(.*?)\n\}", t, re.S); assert c and "repaintActivitySurfaces" in c.group(1), "the one clock no longer calls the one trigger."'
  - name: ONE STATE SET — `pending` is per-SESSION, so a tab you are not looking at keeps its indicator (FORK 2026-08-17)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); m=re.search(r"function tabsRunningNow\(\)[\s\S]*?\n\}", t); assert m, "tabsRunningNow not found"; body=m.group(0); assert "sessionPending(" in body, "the tab glow no longer asks the per-session pending derivation. pending has gone back to being a property of the VIEWED tab, so sending a prompt and switching away blanks that tab for the whole 21-36s pre-model window — the 2026-08-17 report."; assert not re.search(r"tab\.id === activeTabId && viewedSessionPending\(\)\s*\)?\s*\{", body), "the pending glow is gated on activeTabId again — that is verbatim the 2026-08-17 regression."; v=re.search(r"function viewedSessionPending\(\)[\s\S]*?\n\}", t); assert v and "sessionPending(" in v.group(0), "viewedSessionPending no longer consults the shared per-session derivation, so the chat pill and the tab title can drift apart — the desync class this whole area keeps reproducing."'
  - name: R2a (transitive) — no PAINTING function may mutate run state, however deep in the clock's call chain (FORK 2026-08-17)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); ms=list(re.finditer(r"^(?:async )?function ([A-Za-z0-9_$]+)", t, re.M)); PAINT=re.compile(r"^(render|paint|fill|update|sync|repaint|sweep|activityTick|activityFingerprint|tabsRunningNow)"); bad=[]; [bad.append(n) for i,m in enumerate(ms) for n in [m.group(1)] if PAINT.match(n) for body in [t[m.end(): ms[i+1].start() if i+1 < len(ms) else len(t)]] for ln in body.splitlines() if not ln.strip().startswith(("//","*")) and ("activeRuns.delete" in ln or "rememberTerminated(" in ln)]; assert not bad, "these PAINTING functions mutate run state: %s. done-signals.md R2a forbids a timer that CLEARS a run, and every painter is on the 500ms clock — so a delete here IS the stale-run watchdog, just hidden one call deeper. Found 2026-08-17 in sweepDeadEegBranches, reached via activityTick -> repaintActivitySurfaces -> updateBudgetPanel -> renderEegPanel -> fillEegPaper: it deleted the run AND rememberTerminated() it, so a turn quiet for 90s (a long tool call) lost its indicator permanently. Freshness belongs at READ time (clientRunIsFresh), never as a delete." % sorted(set(bad))'
  - name: R2a — no timer may CLEAR a run (the stale-run watchdog stays deleted)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "STALE_RUN_WATCHDOG_MS" not in t, "the stale-run watchdog is back. done-signals.md R2a: the 2026-05-14 deletion is permanent — a stuck indicator is cured at the emitter, never by a UI timer that lies about doneness."; c=re.search(r"function activityTick\(\)[^{]*\{(.*?)\n\}", t, re.S); assert c, "activityTick not found"; body=c.group(1); assert "activeRuns.delete" not in body and "backgroundRuns.delete" not in body, "the activity clock now REMOVES a run. R2 turns on DIRECTION: a clock that re-reads and repaints is required; one that clears is forbidden."'
  - name: subagent chat terminals also close the run — handleSubagentChatEvent deletes from activeRuns (FORK 2026-06-22, stuck spinner after a fractal turn)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); m=re.search(r"function handleSubagentChatEvent[\s\S]*?\nfunction ", t); assert m, "handleSubagentChatEvent not found"; blk=m.group(0); assert "activeRuns.delete" in blk and "rememberTerminated" in blk, "handleSubagentChatEvent no longer closes the subagent run on its terminal chat event — a subagent (e.g. a fractal-triage lane) whose tier-3 lifecycle:end is dropped on hard teardown will stick its thinking indicator forever. done-signals.md section 2 R1: a chat terminal is tier-1 for SUBAGENT runs too, not just the main run. Re-read before changing the subagent chat handler."'
---

# Done-signals — the "is the turn/task finished?" methodology

**Read this before touching anything that decides a turn is over, clears the
thinking indicator, marks a plan/recipe step done, or resumes after a
restart.** Tinkerclaw has had repeated bugs here (stuck `sending…`,
prefrontal `idle` while chat still "thinking", per-session staleness,
leaked runs, truncated finals) because _six independent signals_ assert
"done" and they can disagree. This file is the single place that says
**which signal wins, in what order, and how to reason about a discrepancy.**
It owns the _precedence contract_; each signal's mechanics are owned by the
file named in `see_also`.

## 1. The master map (read this as text, not a picture)

```mermaid
flowchart TD
  CLI["claude-cli stream-json<br/>(persistent worker — lifecycles.md L2)"]
  R["`result` NDJSON line<br/>worker.ts:646 → resolves the turn Promise"]
  TR["tail-recover + pushTextEnd<br/>stream.ts (text_end emitted AFTER reconciliation)"]
  LC["lifecycle phase:start / phase:end / phase:error<br/>stream.ts:254 / :835 (tool-loop.md owns emission)<br/>FORK 2026-06-04: phase:error now carries model/sessionKey (§2)"]
  DLT["live chat-delta (text)<br/>app.ts delta handler — drives the streamed bubble"]
  HB["heartbeat / idle watchdog<br/>stream.ts HEARTBEAT_INTERVAL_MS (tool-loop.md)"]
  CF["chat broadcast state ∈ {final,error,aborted}<br/>server-chat.ts:emitChatFinal + chat.ts backstop (flows.md)"]
  AR["activeRuns map + phase<br/>app.ts: set@start / phase mutations / delete"]
  S147["§147 helpers: runBelongsToViewedSession /<br/>scopedActiveRuns / viewedSessionBusy (panels.md §147)"]
  IND["thinking indicator + `sending` pill<br/>(viewed-tab only)"]
  PF["prefrontal panel render ladder<br/>plan ▸ synthetic 2-step ▸ idle (panels.md §115)"]
  PLAN["plan/recipe state<br/>prefrontal.plan.* + prefrontal-plan/recipe/tree/trail events<br/>(subagents-and-recipes.md)"]
  RC["restart-continue + main-session-restart-recovery<br/>(lifecycles.md L4, subagents-and-recipes.md)"]

  CLI --> R --> TR --> LC
  R -->|"turn Promise settles"| CF
  LC -->|"WS (end AND error → 3s debounced delete)"| AR
  HB -->|resets pi idle timer; does NOT clear UI| AR
  CF -->|WS, AUTHORITATIVE| AR
  DLT -->|"delta for viewed session w/ NO activeRuns entry → SELF-HEAL: re-create run (R1)"| AR
  AR --> S147 --> IND
  AR --> PF
  PLAN -->|WS events| PF
  RC -->|on boot: re-dispatch interrupted| CF
  CF -->|cancels pending lifecycle:end timer| AR
```

**One sentence:** the claude-cli `result` line ends the _worker turn_; the
gateway converts that (plus the lifecycle stream) into exactly one
`chat` broadcast with `state ∈ {final,error,aborted}` which is the
**authoritative** "turn is done" signal; the Tinker UI's `activeRuns`
map is the **derived truth** the indicator and prefrontal panel read
through the §147 helpers; plans/recipes and restart-recovery are an
_orthogonal_ lane that says "the larger task is not done yet" even when
the turn is.

## 2. The signal catalog with authority (the part you came for)

Authority tiers — when two signals disagree, the **lower tier number wins**.

| #   | Signal                                                                                | Emitter → consumer                                                                           | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Tier                              | Owner                                                   |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| 1   | `chat` broadcast `state=final\|error\|aborted`                                        | server-chat.ts `emitChatFinal` (+ `chat.ts` backstop, FORK 2026-05-10) → app.ts chat handler | **The assistant reply is delivered; the run is over.** Immediate `activeRuns.delete`; cancels any pending lifecycle:end timer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **1 — AUTHORITATIVE**             | flows.md                                                |
| 2   | `result` NDJSON line                                                                  | claude-cli → worker.ts:646 (resolves the turn Promise)                                       | The _worker_ turn finished (exit/usage/final text). Upstream of #1; does not itself touch the UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2                                 | lifecycles.md L2                                        |
| 3   | lifecycle `phase:end` / `phase:error`                                                 | stream.ts:835 → app.ts (3s **debounced** delete)                                             | The run ended — _advisory/safety-net_. Debounced so a stray end doesn't kill a re-used run; **superseded by #1**. **FORK 2026-06-04 (G3):** the terminal `phase:error` emit now mirrors `phase:end`'s identity (`model/sessionKey/authProfileId/modelProvider/rateLimit`, `lifecycle.ts:141-145`); the UI gates its lifecycle handler on `p.data?.model`, so before this an identity-less `error` was **dropped** → the errored/failed-over run was never scheduled for deletion → its indicator stuck and stacked ("multiple at once"). Now the 3s debounced delete fires for `error` too and the run finally clears. | 3 (debounced)                     | tool-loop.md (emission) / here (cross-signal identity)  |
| 4   | lifecycle `phase:start` + phase mutations (`tool`/`responding`/`reflecting`)          | stream.ts:254 / app.ts:~1871,~1567                                                           | The run is _alive and doing X_. Sets `activeRuns`, drives the indicator label. Never asserts "done".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | — (liveness)                      | tool-loop.md                                            |
| 5   | heartbeat / idle watchdog                                                             | stream.ts `HEARTBEAT_INTERVAL_MS`; AbortSignal→SIGTERM worker.ts:724                         | Keeps pi-agent-core's idle timer from firing; on real stall, SIGTERM → worker `onExit` rejects → becomes a #1 `error`. **Never clears the UI by itself.**                                                                                                                                                                                                                                                                                                                                                                                                                                                              | — (keep-alive / failure-injector) | tool-loop.md / failures.md M1                           |
| 6   | plan / recipe state (`prefrontal.plan.*`, `prefrontal-plan/recipe/tree/trail` events) | extension → app.ts → prefrontal panel                                                        | The _task_ (multi-turn) is/ isn't done — **orthogonal** to turn doneness. A closed turn with an `in_progress` plan is "turn done, task not done".                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | — (task scope)                    | subagents-and-recipes.md                                |
| 7   | restart-continue / main-session-restart-recovery                                      | boot scan → re-dispatch a turn (#1 cycle restarts)                                           | A turn was interrupted by a gateway restart; the task is resumed. Detected via `status:"running"`→`abortedLastRun` and `in_progress` plan with unfinished steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | — (recovery)                      | lifecycles.md L4                                        |
| 8   | live chat-**delta** (text) for the viewed session                                     | stream delta → app.ts delta handler                                                          | The run is _alive RIGHT NOW_ (Jarvis is streaming). Normally `activeRuns` already has the entry (created by `phase:start`, #4). **FORK 2026-06-04 (U4 delta SELF-HEAL):** a delta whose `activeRuns` entry is **missing** is _authoritative proof of life_ → re-create a minimal entry + resume the indicator tick. This is **R1 applied to liveness** (an authoritative live signal supersedes the advisory `phase:end` that emptied `activeRuns`). It does **not** add a UI watchdog (R2 holds) — it reacts to a real inbound delta, never to a timer.                                                               | — (liveness, self-healing)        | tool-loop.md (emission) / here (cross-signal self-heal) |

| 9 | pre-model window (`preModelSince`, pre-model-window.ts) | app.ts `send()` → the tab glow + the chat pill | **The session is working but no model has been named yet.** Prompt accepted, gateway assembling the prompt; measured 21-36s (turn-latency.md). The gateway's run set correctly says "not live" for this whole span, so it is the ONE activity state no server lane can supply. Opened at send; closed by ANY of three proofs, each recorded for EVERY session above every viewed gate — a model-bearing lifecycle event, a chat delta, or a terminal chat event — and bounded by `PRE_MODEL_MAX_MS` so a dropped clear stops the glow rather than latching it. **FORK 2026-08-17:** was the boolean `sending`, a property of the VIEWED TAB, so `tabsRunningNow()` could only grant it to `activeTabId` and switching away blanked the tab you left for the whole window. Now keyed by session. | — (liveness, client-only) | here |

**The two rules that resolve every historical bug here:**

- **R1 — `chat.final/aborted` is authoritative and immediate; `lifecycle:end`
  is advisory and debounced.** The chat-final handler MUST cancel the
  pending lifecycle:end `setTimeout` and delete the run now. Trusting the
  debounced path alone is M2 ("spinner stuck on sending"); deleting on a
  bare lifecycle:end without the debounce is the "run vanished mid-reuse"
  class. (Enforced by this file's verify block #1.)
  - **R1 corollary — authoritative liveness supersedes the advisory delete
    that already happened (FORK 2026-06-04, U4).** The mirror image of R1: a
    live chat-**delta** (#8) for the viewed session that finds **no**
    `activeRuns` entry is authoritative proof the run is alive, and it
    **wins over** a `phase:end` (#3) debounce that prematurely emptied
    `activeRuns` (early/stray lifecycle:end racing a slow next delta). The
    delta handler **re-creates** the run and resumes the tick. This is a
    self-heal on a real inbound signal, **not** a watchdog — R2 still holds
    (see U4 note below).
  - **Error-clears-the-run (FORK 2026-06-04, G3):** for the debounced delete
    in R1 to ever fire on the _failure_ path, the terminal `phase:error`
    event must carry `model/sessionKey` (the UI gates its lifecycle handler
    on `p.data?.model`). It now does (`lifecycle.ts:141-145`, §2 row #3).
    Before this, errored/failed-over runs had no Tier-3 delete at all and
    their indicators stuck — a cross-signal identity gap, not a precedence
    change. (Enforced by this file's new verify block.)
  - **Subagent terminals are tier-1 too (FORK 2026-06-22, "stuck spinner
    after a fractal turn").** A `:subagent:` run of the viewed session — e.g.
    a fractal-triage lane (`agent:<id>:subagent:<uuid>`; `deliver:false`
    gates delivery, NOT visibility) — is added to `activeRuns` by its
    `phase:start` (#4) and rendered in the indicator like any other run. But
    its chat events take the `handleSubagentChatEvent` path, which `return`s
    BEFORE the tier-1 `activeRuns.delete` in the main-run chat handler. So
    until this fix a subagent's ONLY terminator was the tier-3 debounced
    `lifecycle:end` (#3) — which is dropped on hard teardown (SIGTERM /
    gateway-restart / timeout) — and with R2 (no UI watchdog) nothing
    backstopped it, so the subagent stayed pinned in `activeRuns` and the
    dots stayed lit even though the answer + fractal dock were complete. Fix:
    `handleSubagentChatEvent` now applies the SAME tier-1 authority on
    `final/aborted/end/error` (cancel the pending lifecycle:end timer →
    `activeRuns.delete` → `rememberTerminated` → recompute `sending`), so a
    subagent has the same two independent terminators (tier-1 chat + tier-3
    lifecycle) the main run has. (Enforced by this file's new verify block.)
- **R2 — a UI timer may never CLEAR a run; a UI clock that only RE-READS is
  required.** The test is **direction**, not the presence of a timer.
  - **R2a (forbidden) — no UI-side stale-run watchdog.** The 2026-05-14
    deletion is permanent (`STALE_RUN_WATCHDOG_MS` must never reappear —
    owned/enforced by tool-loop.md). Nothing on a timer may delete, expire or
    otherwise retire a run from `activeRuns`. A stuck indicator is ALWAYS
    cured by hardening `lifecycle:end`/`final` _emission_ (server side), never
    by a UI timer that lies about doneness.
  - **R2b (required) — exactly ONE repaint clock, and it is sub-second.** A
    timer that re-reads authoritative state and repaints is not merely
    tolerated, it is **mandatory**, because several of the inputs the
    indicator depends on are poll-only values that change with no event:
    `sessions[].run` (the gateway's run set) is replaced only by
    `loadSessions()`, and elapsed seconds advance on wall-clock alone. Such a
    clock **cannot lie about doneness** — it removes nothing and can only ADD
    an indicator the server itself asserts. `app.ts` `ACTIVITY_TICK_MS = 500`
    drives the single `activityTick()`, which is the only timer permitted to
    render an activity surface.

  **Why this had to be spelled out (2026-08-17).** The previous wording said
  "never on a scheduled/polled timer" as part of the U4 carve-out. Read
  literally that forbids R2b, and a future reader would have been right to
  delete the repaint clock on principle — while the actual bug, reported five
  times between 2026-07-29 and 2026-08-17, was the **absence** of that clock:
  the chat indicator had no timer at all, so a poll-only value it depended on
  was never re-read and the indicator stayed blank for entire turns. A rule
  phrased against a mechanism (timers) instead of against a failure mode
  (lying about doneness) forbids the cure along with the disease.

  **R2 corollary — ONE CLOCK, not one per surface (FORK 2026-08-17).** Two
  clocks rendering the same fact is the third way these surfaces desynchronize,
  after a second predicate (fixed by run-state.ts) and a second trigger (fixed
  by `repaintActivitySurfaces`). Until 2026-08-17 there were two — a 5s
  liveness repaint and a 1s thinking tick — so the same fact could be 5s old on
  the tab bar and 1s old in the chat. Worse, the 1s tick self-terminated on
  `activeRuns.size === 0`, which is exactly the out-of-focus case, so a
  background turn's counters never ticked at all. There is now one clock with
  two cadences split **by cost, not by subject**: every 500ms tick does the
  text-only work (elapsed counters, retry countdowns — text-only because
  replacing the indicator node restarts its CSS animation), and the expensive
  surfaces repaint on a change-fingerprint with the old 5s cadence retained as
  a forced backstop.

  **The U4 delta self-heal is legal under the same test:** it fires on an
  actual inbound delta and it _re-creates_ a run rather than _clearing_ one —
  the exact opposite of the watchdog that was deleted (which lied a run was
  _done_).

## 3. How prefrontal derives the indicator (sequence, not mechanics)

Mechanics are owned by **panels.md §115 (render ladder) + §147 (the single
source of truth + the FORK 2026-05-17 re-render-on-user-action rule)**.
This doc only fixes the _precedence among the three render levels_:

1. **Explicit plan** (`currentPlan`, `prefrontal-plan-state`, `status:in_progress`) — wins. Task-scope (#6) overrides turn-scope: show the checklist even if the current turn just ended.
2. **Implicit 2-step** (no plan, `tree.active`) — derived from the SAME `scopedActiveRuns()` set the indicator uses (#4), so prefrontal and the chat spinner can never disagree about "busy". `▶ Thinking` → `▶ Doing` on first tool/text.
3. **Idle** — no plan AND no scoped active run. The only "nothing happening" state; it says so explicitly.

Gating rule (panels.md §147 #3): the **extension tree is the GLOBAL
orchestration view** — only consult it under `budgetScope==="all"`; under
`"session"` always build from `scopedActiveRuns()`. The panel re-renders on
WS events **and** on the two user-driven changes (session switch, scope
toggle) via `updatePrefrontalTree()` / `setBudgetScope()` (panels.md §147
rule 6). "Prefrontal stale per session" / "dead toggle" = that rule
regressed.

## 4. How recipes/plans feed it (task-scope, orthogonal lane)

Owned by **subagents-and-recipes.md**. The doneness-relevant synthesis:

- A turn ending (#1) does NOT end the task if a plan is `in_progress` with
  steps not all `done`. That gap is exactly what **restart-continue**
  keys on (boot: `in_progress` + any step ≠ `done` + `agent:` sessionKey +
  30s debounce → re-dispatch a `[System] continue` turn). If you change
  step-completion semantics you change restart-continue's trigger — read
  both before editing either.
- The recipe-matcher auto-seeds a plan at turn start (`before_prompt_build`);
  without a seeded plan, restart-continue has nothing to resume for a
  normal turn. "Plan-set first for multi-step tasks" exists because of
  this coupling.
- `prefrontal-trail-event` is append-only audit, never a completion signal.
  `prefrontal-recipe-state` is mutable; recipe done ⇏ turn done.

## 5. Failure-mode quick map (symptom → which signal disagreed)

Full propagation + `diagnose_with` probes are owned by **failures.md**.
Use this as the index from _symptom_ to _the disagreeing signal_:

| Symptom                                                          | Disagreement                                                                                                                                                                       | First probe                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Spinner stuck on `sending…`, reply already shown                 | #1 never broadcast (lifecycle path dropped) — the M2 backstop didn't fire                                                                                                          | `debug.dumpUiSnapshot` + `debug.session.state` (failures.md M2)                          |
| Indicator stuck ON after a fractal turn (answer + dock complete) | a `:subagent:` run's tier-1 chat-final didn't close `activeRuns` (handleSubagentChatEvent lacked the delete); only tier-3 lifecycle:end could, and it was dropped on hard teardown | grep app.ts `handleSubagentChatEvent` for `activeRuns.delete`; §2 R1 subagent corollary  |
| Indicator clears but prefrontal still "thinking" (or vice-versa) | #4/#3 vs the §147 set diverged, or a 4th "busy" derivation was added                                                                                                               | grep app.ts for a busy computation NOT routing through a §147 helper (panels.md §147 R1) |
| "Thinking no matter which session I select"                      | prefrontal didn't re-render on session switch                                                                                                                                      | panels.md §147 rule 6 / verify #5                                                        |
| Turn never ends; SIGTERM at the idle cap                         | heartbeat #5 not resetting pi idle timer                                                                                                                                           | failures.md M1; `[idle-timeout-diag]` journal                                            |
| Reply truncated to the streamed lead-in                          | `text_end` emitted BEFORE tail-recover (#2 vs streamed scratch)                                                                                                                    | stream.ts ordering; tool-loop.md                                                         |
| 53 leaked `claude` procs / Jarvis slow                           | not a doneness bug — worker pool unbounded                                                                                                                                         | lifecycles.md L2 (bounded pool, FORK 2026-05-16)                                         |

## 6. Standard methodology — use this to find bugs before they surface

When you touch ANY code in this area, or you are asked "why is X
stuck/done?", run this fixed procedure:

1. **Name the turn.** Get its `runId` + `sessionKey`. `debug.session.state({sessionKey})` → is it in `activeRuns`? what `phase`?
2. **Walk the tiers top-down (table §2).** For "stuck": did a Tier-1 `chat final/error/aborted` broadcast happen? (`debug.dumpUiSnapshot`, journal `emitChatFinal`/backstop.) If no → the bug is upstream of the UI; do NOT add a UI timer (R2).
3. **Check the precedence contract (R1).** In app.ts: does the chat-final branch cancel `pendingRunDeletes` and delete now? Does lifecycle:end stay debounced? (verify #1 encodes this — run `pnpm bible:invariants`.)
4. **Separate turn-scope from task-scope.** Is the _turn_ done but a plan is `in_progress` (#6)? Then "still thinking" may be correct — look at the plan, not the run.
5. **Confirm the §147 single derivation.** Every "busy/active/which-runs" answer must call a §147 helper. A new inline `activeRuns` scan is the recurring bug class (panels.md §147 R1).
6. **Confirm no UI watchdog crept back (R2).** `STALE_RUN_WATCHDOG_MS` absent; no timer force-clearing `activeRuns`.
7. **Trace the diagram §1 edge that the symptom sits on**, open the _owning_ file from `see_also`, fix at the emitter, never at the symptom.
8. **Add/extend a `verify:`** in the owning file for the exact regression (patch + prevention in the same change — design-principles.md). If the regression is _cross-signal_ (a precedence/relationship bug), it belongs in THIS file's verify, not a per-signal file's.

**The invariants this methodology rests on (all machine-checked):**
`chat.final` authoritative+immediate & cancels the debounced timer (here,
verify #1) · lifecycle:end stays debounced (here, verify #1) · no UI
watchdog (tool-loop.md) · heartbeat resets the idle timer (tool-loop.md) ·
every `chat.send` ends in a final/error/aborted broadcast (flows.md) ·
exactly three §147 helpers, one derivation each (panels.md §147) ·
prefrontal re-renders on user-driven view changes (panels.md §147 r6) ·
prefrontal render ladder plan▸tree▸idle (here, verify #2 + panels.md §115).

## 7. How to evolve this doc

- A **new signal** that can assert/deny "done" → add a row to §2 with its
  tier, add the edge to the §1 diagram, name its owning file, and (if it
  introduces a new cross-signal disagreement) add a verify here.
- A **changed precedence** (e.g. making lifecycle:end authoritative) → this
  is a contract change: update R1/R2, the §2 tiers, this file's verify,
  AND audit every consumer. Do not smuggle it in as a one-line app.ts edit.
- Per-signal mechanics changes → edit the **owning** file; only update this
  doc if the _ordering between signals_ changed. Single owner per fact.
