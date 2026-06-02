---
file: done-signals.md
purpose: The cross-signal methodology for "is this turn/task done?" — the master map of every input that drives the Tinker UI thinking/activity indicator, their authority/precedence, and a fixed procedure for analysing or changing this area before bugs surface.
audience: AI (Claude, etc). Human readability is incidental.
last_verified: 2026-05-17
last_verified_commit: HEAD
single_owner: yes — the cross-signal *precedence contract* and the master doneness map live here. Per-signal facts are owned elsewhere (lifecycles.md = session/worker/recovery state machines; tool-loop.md = heartbeat/idle-watchdog/lifecycle:end emission/no-UI-watchdog; flows.md = the chat.final guarantee + F-PLAN-RESUME; subagents-and-recipes.md = plan/kit/recipe; panels.md = prefrontal render levels + the §147 helpers; failures.md = failure-mode maps). This file does NOT re-derive them — it sequences them.
see_also: lifecycles.md (L1 session, L2 cc-bridge worker, L4 restart-recovery), tool-loop.md (heartbeat, idle watchdog, lifecycle:end emission, the deleted UI watchdog), flows.md (chat.send always ends in a final/error/aborted broadcast; F-PLAN-RESUME), panels.md (§115 prefrontal render levels, §147 single-source-of-truth helpers), subagents-and-recipes.md (plan RPCs, kits, recipes, restart-continue), failures.md (M1 idle SIGTERM, M2 stuck spinner, incomplete_turn)
verify:
  - name: chat.final/aborted is authoritative-and-immediate AND cancels the debounced lifecycle:end delete (the core precedence contract this doc owns)
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert re.search(r"pendingRunDeletes\.get\([^)]*\)[\s\S]{0,240}clearTimeout[\s\S]{0,200}activeRuns\.delete", t), "the chat.final/aborted handler no longer cancels the pending lifecycle:end timer before deleting the run — the authoritative-supersedes-debounced precedence (done-signals.md) is broken; a late lifecycle:end timer can now delete a run the user already re-used, or final no longer closes the run immediately"; assert re.search(r"pendingRunDeletes\.set\(", t) and re.search(r"setTimeout\([\s\S]{0,320}activeRuns\.delete", t), "the lifecycle:end debounced (delayed) delete path is gone — lifecycle:end must remain the advisory/debounced half of the contract, NOT an immediate delete; re-read done-signals.md before changing turn-completion"'
  - name: prefrontal render precedence is plan-first then live-tree then idle (the §115 ladder this doc sequences)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/prefrontal-tree.ts")).read(); assert "Priority 2" in t and "synthetic" in t.lower(), "prefrontal-tree.ts no longer documents the explicit-plan → synthetic-2-step → idle priority ladder; done-signals.md §3 and panels.md §115 describe a precedence that the code must still implement"'
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
  LC["lifecycle phase:start / phase:end<br/>stream.ts:254 / :835 (tool-loop.md owns emission)"]
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
  LC -->|WS| AR
  HB -->|resets pi idle timer; does NOT clear UI| AR
  CF -->|WS, AUTHORITATIVE| AR
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

| #   | Signal                                                                                | Emitter → consumer                                                                           | Asserts                                                                                                                                                          | Tier                              | Owner                         |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------- |
| 1   | `chat` broadcast `state=final\|error\|aborted`                                        | server-chat.ts `emitChatFinal` (+ `chat.ts` backstop, FORK 2026-05-10) → app.ts chat handler | **The assistant reply is delivered; the run is over.** Immediate `activeRuns.delete`; cancels any pending lifecycle:end timer.                                   | **1 — AUTHORITATIVE**             | flows.md                      |
| 2   | `result` NDJSON line                                                                  | claude-cli → worker.ts:646 (resolves the turn Promise)                                       | The _worker_ turn finished (exit/usage/final text). Upstream of #1; does not itself touch the UI.                                                                | 2                                 | lifecycles.md L2              |
| 3   | lifecycle `phase:end` / `phase:error`                                                 | stream.ts:835 → app.ts (3s **debounced** delete)                                             | The run ended — _advisory/safety-net_. Debounced so a stray end doesn't kill a re-used run; **superseded by #1**.                                                | 3 (debounced)                     | tool-loop.md                  |
| 4   | lifecycle `phase:start` + phase mutations (`tool`/`responding`/`reflecting`)          | stream.ts:254 / app.ts:~1871,~1567                                                           | The run is _alive and doing X_. Sets `activeRuns`, drives the indicator label. Never asserts "done".                                                             | — (liveness)                      | tool-loop.md                  |
| 5   | heartbeat / idle watchdog                                                             | stream.ts `HEARTBEAT_INTERVAL_MS`; AbortSignal→SIGTERM worker.ts:724                         | Keeps pi-agent-core's idle timer from firing; on real stall, SIGTERM → worker `onExit` rejects → becomes a #1 `error`. **Never clears the UI by itself.**        | — (keep-alive / failure-injector) | tool-loop.md / failures.md M1 |
| 6   | plan / recipe state (`prefrontal.plan.*`, `prefrontal-plan/recipe/tree/trail` events) | extension → app.ts → prefrontal panel                                                        | The _task_ (multi-turn) is/ isn't done — **orthogonal** to turn doneness. A closed turn with an `in_progress` plan is "turn done, task not done".                | — (task scope)                    | subagents-and-recipes.md      |
| 7   | restart-continue / main-session-restart-recovery                                      | boot scan → re-dispatch a turn (#1 cycle restarts)                                           | A turn was interrupted by a gateway restart; the task is resumed. Detected via `status:"running"`→`abortedLastRun` and `in_progress` plan with unfinished steps. | — (recovery)                      | lifecycles.md L4              |

**The two rules that resolve every historical bug here:**

- **R1 — `chat.final/aborted` is authoritative and immediate; `lifecycle:end`
  is advisory and debounced.** The chat-final handler MUST cancel the
  pending lifecycle:end `setTimeout` and delete the run now. Trusting the
  debounced path alone is M2 ("spinner stuck on sending"); deleting on a
  bare lifecycle:end without the debounce is the "run vanished mid-reuse"
  class. (Enforced by this file's verify block #1.)
- **R2 — there is no UI-side stale-run watchdog.** The 2026-05-14 deletion
  is permanent (`STALE_RUN_WATCHDOG_MS` must never reappear — owned/enforced
  by tool-loop.md). A stuck indicator is ALWAYS cured by hardening
  `lifecycle:end`/`final` _emission_ (server side), never by a UI timer
  that lies about doneness.

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

| Symptom                                                          | Disagreement                                                              | First probe                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Spinner stuck on `sending…`, reply already shown                 | #1 never broadcast (lifecycle path dropped) — the M2 backstop didn't fire | `debug.dumpUiSnapshot` + `debug.session.state` (failures.md M2)                          |
| Indicator clears but prefrontal still "thinking" (or vice-versa) | #4/#3 vs the §147 set diverged, or a 4th "busy" derivation was added      | grep app.ts for a busy computation NOT routing through a §147 helper (panels.md §147 R1) |
| "Thinking no matter which session I select"                      | prefrontal didn't re-render on session switch                             | panels.md §147 rule 6 / verify #5                                                        |
| Turn never ends; SIGTERM at the idle cap                         | heartbeat #5 not resetting pi idle timer                                  | failures.md M1; `[idle-timeout-diag]` journal                                            |
| Reply truncated to the streamed lead-in                          | `text_end` emitted BEFORE tail-recover (#2 vs streamed scratch)           | stream.ts ordering; tool-loop.md                                                         |
| 53 leaked `claude` procs / Jarvis slow                           | not a doneness bug — worker pool unbounded                                | lifecycles.md L2 (bounded pool, FORK 2026-05-16)                                         |

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
