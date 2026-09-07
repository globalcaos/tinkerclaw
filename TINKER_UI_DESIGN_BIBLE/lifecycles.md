---
file: lifecycles.md
purpose: State machines for entities that have non-trivial lifecycles
audience: AI
last_verified: 2026-07-21
last_verified_commit: 06f8647fdc
single_owner: yes — state-transition facts live here, not in bible.md or flows.md
see_also: flows.md (sequence of calls), failures.md (transitions that don't fire), probes.md (`debug.session.state` proposed), config-shape.md (U7 7D/7G dead-code RPC traps), subagents-and-recipes.md (recipe selection/fitness scoring)
verify:
  - name: L1 — agent:main:main session entry exists and has a recognised status
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","debug.session.state","--params",json.dumps({"sessionKey":"agent:main:main"})],capture_output=True,text=True,timeout=25); j=json.loads(r.stdout.split("Gateway call:")[-1].split("\n",1)[1] if "Gateway call:" in r.stdout else r.stdout); status = (j.get("entry") or {}).get("status"); assert status in {"idle","running","done","failed","aborted","timeout","interrupted",None}, f"unrecognised status {status!r}"'
  - name: L4 — restart-recovery code path still emits the known log message
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/src/agents/main-session-restart-recovery.ts")).read(); assert "marked interrupted main session failed" in t and "main-session-restart-recovery" in t, "restart-recovery log emission missing or renamed — refactor without a verify update is the regression class to catch"'
  - name: L2 — tinker-bridge worker pool stays bounded (idle reap + LRU cap)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-tinker-bridge/src/worker-pool.ts")).read(); assert "idleTtlMs" in t and "maxWorkers" in t and "private sweep(" in t and "isBusy()" in t, "tinker-bridge SessionWorkerPool eviction removed — unbounded persistent-claude-proc leak regression class (people-profiles per-profile sessionKey, 53 procs/7+ days, 2026-05-16)"'
  - name: L-STRATEGY — strategy-switch state machine still carries its threshold/recency/review transitions (U4)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/strategy-switch.ts")).read(); ft=open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/failure-tracking.ts")).read(); assert "consecutiveErrors < cfg.threshold" in t and "recency guard" in t and "needsHumanReview" in t, "strategy-switch decision transitions renamed — L-STRATEGY diagram is now stale"; assert "export function recordFailure(" in ft and "export function recordSuccess(" in ft and "export function applySwitch(" in ft, "failure-tracking transition fns (recordFailure/recordSuccess/applySwitch) renamed — L-STRATEGY accumulate/reset/apply edges stale"'
  - name: L-STRATEGY — fork.strategy.switch.list RPC is live and returns ok (U4 review surface)
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","fork.strategy.switch.list"],capture_output=True,text=True); assert "\"ok\"" in r.stdout, r.stdout[-400:]'
  - name: L-RECIPE-VARIANT — recipe-evolution auto-promote gate + never-delete archive still present (U1)
    cmd: python3 -c 'import os; e=open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/recipe-evolution.ts")).read(); a=open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/recipe-archive.ts")).read(); assert "export function isAutoPromotable(" in e and "export function proposeMutations(" in e and "needsHumanReview" in e, "recipe-evolution proposed/auto-promotable transitions renamed — L-RECIPE-VARIANT stale"; assert "NEVER deletes" in a and "deprecate(recipeId" in a and "putVariant(recipeId" in a, "recipe-archive never-delete (deprecate not delete) broke — L-RECIPE-VARIANT archived-edge stale"'
  - name: L-CURIOSITY-GAP — curiosity gap lifecycle producers + RPCs still present (U2)
    cmd: python3 -c 'import os; s=open(os.path.expanduser("~/src/tinkerclaw/src/fork/curiosity-store.ts")).read(); h=open(os.path.expanduser("~/src/tinkerclaw/src/fork/attempt-hooks.ts")).read(); i=open(os.path.expanduser("~/src/tinkerclaw/src/fork/idle-goals.ts")).read(); r=open(os.path.expanduser("~/src/tinkerclaw/src/fork/curiosity-rpc.ts")).read(); assert "export function appendGap(" in s and "export function topGaps(" in s and "export function markResolved(" in s, "curiosity-store gap lifecycle fns renamed — L-CURIOSITY-GAP stale"; assert "detectUncertaintySpans" in h and "appendGap" in h, "2a hedge→gap producer unwired from onTurnComplete — L-CURIOSITY-GAP logged-edge stale"; assert "proposeIdleGoals" in i and "curiosity-goal-proposal" in i, "2d idle-goal proposer changed — L-CURIOSITY-GAP surfaced→proposed edge stale"; assert "fork.curiosity.logGap" in r and "fork.curiosity.topGaps" in r and "fork.curiosity.resolveGap" in r, "curiosity RPC names changed — L-CURIOSITY-GAP RPC labels stale"'
  - name: L-PROMPT — the queue gate keeps its run-liveness term, tolerates the shape app.ts passes, and never gates delivery
    cmd: python3 -c 'import os,re; a=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); r=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/run-state.ts")).read(); q=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/queued-sends.ts")).read(); assert "hasFreshActiveRunForSession:" in a, "the shouldQueue call site has drifted off the renamed field again — the gate silently degenerates to streamRunId||sending (2026-08-26, two days of falsely-queued prompts)"; assert len([l for l in a.splitlines() if "shouldQueue({" in l and not l.strip().startswith(("//", "*"))]) == 1, "shouldQueue is invoked from somewhere other than the one shared predicate — a second call site is a second opinion about deferral, which is the drift this entry exists to stop"; assert "Array.isArray(item) ? item[1] : item" in r, "sessionHasFreshClientRun stopped normalising per item — passing activeRuns.values() throws TypeError at the TOP of send(), blanking the composer without drawing or delivering the prompt (2026-08-26)"; assert "queue gate threw" in a, "the send-path fail-safe around the queue gate is gone — an exception there costs the user their prompt on screen"; assert "function sendWouldDefer(" in a and a.count("sendWouldDefer()") >= 2, "send() and updateBtn() no longer share ONE deferral predicate — the button can again promise a hold the send path will not perform (the subagent case)"; assert "hasFreshActiveRunForSession !== \"boolean\"" in q, "shouldQueue no longer rejects a drifted call site; a missing field would silently disable the run-liveness term again"'
  - name: L6 — restart-deferral drain partitions fresh vs stale active tasks
    cmd: python3 -c 'import os; m=open(os.path.expanduser("~/src/tinkerclaw/src/tasks/task-registry.maintenance.ts")).read(); h=open(os.path.expanduser("~/src/tinkerclaw/src/gateway/server-reload-handlers.ts")).read(); assert "export function getRestartBlockingTaskSummary(" in m and "RESTART_BLOCKING_TASK_STALE_MS" in m and "staleIgnored" in m, "getRestartBlockingTaskSummary fresh/stale partition renamed or removed — L6 diagram stale; dead workers with a live session-store entry would again defer restarts indefinitely (observed 2026-07-21)"; assert "getRestartBlockingTaskSummary" in h and "stale task run(s) ignored" in h, "server-reload-handlers no longer consumes getRestartBlockingTaskSummary — restart gate reverted to raw active counts; L6 blocking edge stale"'
---

# Lifecycles — state machines

Each diagram below is the canonical state machine for one entity. If a transition that fires in code does not appear in the diagram, the diagram is incomplete (or the transition is the bug).

---

## L1. Agent session (`agent:main:*`)

**Entity:** entry in `~/.openclaw/agents/<agentId>/sessions/sessions.json`.

```mermaid
stateDiagram-v2
  [*] --> idle: session created
  idle --> running: chat.send / agent dispatch
  running --> done: turn complete, no error
  running --> failed: surface_error (model auth, billing, fatal classification)
  running --> aborted: explicit /stop or chatAbortController.abort
  running --> timeout: run timeoutMs exceeded
  running --> interrupted: gateway boot detects status:running (markRunningMainSessionsAsInterrupted)
  interrupted --> running: recoverRestartAbortedMainSessions → resume dispatch
  interrupted --> failed: tail-check informational; still attempts resume (FORK 2026-05-10)
  done --> idle: next user message
  failed --> idle: next user message
  aborted --> idle: next user message
  timeout --> idle: next user message
```

**Invariants:**

- `running + abortedLastRun=true` at boot ALWAYS becomes `interrupted` then `running` again via recovery (FORK 2026-05-10, see bible §11.6c).
- `running` should never persist past the agent's `timeoutSeconds` without a state transition. Today this is _not_ enforced synchronously — the recovery code catches it on next boot. **Open follow-up** to mark `failed` on surface_error inside the lane, not just on next reboot.

**Probe:** `debug.session.state({sessionKey})` (proposed) — returns current status, abortedLastRun, lane state, queued replies.

---

## L2. tinker-bridge claude-cli worker

**Entity:** `ClaudeCodeWorker` instance held by `SessionWorkerPool`, one per tinker-bridge sessionKey.

```mermaid
stateDiagram-v2
  [*] --> uncreated
  uncreated --> spawning: pool.getOrCreate (no live worker)
  spawning --> streaming: first stream-json line received
  streaming --> streaming: tool_use / tool_result / text delta events
  streaming --> warm_idle: `result` line — turn RESOLVES, process STAYS ALIVE
  warm_idle --> streaming: next turn for same sessionKey (same warm process, NO respawn)
  warm_idle --> exited_signal: SIGTERM — pool sweep eviction (idle>TTL / over LRU cap) or shutdown
  streaming --> exited_signal: SIGTERM (turn AbortSignal = idle watchdog, or shutdown)
  streaming --> exited_crash: code != 0, signal=null
  exited_signal --> uncreated: pool retains sessionId for future --resume
  exited_crash --> uncreated: same
  uncreated --> spawning: next turn for same sessionKey, --resume <stored sessionId>
```

> NOTE (corrected 2026-05-16): the claude subprocess is **persistent**
> (`claude --input-format stream-json`). A completed turn does NOT exit the
> process — it stays warm for the next turn on the same sessionKey. The
> earlier diagram's `exited_ok: claude-cli exits code=0 (turn complete)`
> edge was wrong and is why the unbounded-sessionKey leak went unmodelled.

**Resume lookup priority** (worker-pool.ts, FORK 2026-05-10):

1. `getLatestResumeSessionIdByOpenclawSessionId(openclawSessionId)` — canonical, survives sessionKey hash drift
2. `getResumeSessionId(sessionKey)` — fallback for legacy entries

**Invariants:**

- The claude process is **persistent**: a completed turn keeps it warm; only SIGTERM (abort / pool eviction / shutdown) or a crash ends it.
- A worker that has SIGTERMed retains its `sessionId` in session-map.json so the NEXT turn resumes the same claude-cli conversation.
- Worker pool is gateway-wide singleton; `killAll()` runs on `exit`/`SIGTERM`/`SIGINT`.
- A turn's `signal: AbortSignal` parameter, when aborted, calls `worker.kill("SIGTERM")` — this is how the LLM idle watchdog terminates a stuck worker.
- **The pool is BOUNDED (FORK 2026-05-16, `worker-pool.ts`).** `SessionWorkerPool` sweeps on every `getOrCreate`: a non-busy worker idle past `idleTtlMs` (default 15 min) is SIGTERMed, and the pool is hard-capped at `maxWorkers` (default 32, LRU eviction of the least-recently-used non-busy worker). A worker mid-turn (`isBusy()`) and the sessionKey being requested are never evicted; evicted workers keep their `sessionId` in session-map.json so a later turn `--resume`s the same thread. Without this, a caller minting a unique sessionKey per work item (people-profiles cron — one key per profile) leaks one persistent ep_poll-blocked `claude` proc per item indefinitely (observed: 53 procs, oldest 7+ days, 2026-05-16). Enforced by the L2 `verify:` invariant above.

**Probe:** `tinker-bridge.workerInfo({sessionKey})` (proposed) — alive?, current cli sessionId, last turn duration.

---

## L3. Inbound message (any channel)

**Entity:** one message arriving from a channel adapter.

```mermaid
stateDiagram-v2
  [*] --> received
  received --> deduplicated: idempotency key + dedupe.ts
  received --> dropped_dupe: idempotency hit
  deduplicated --> matched: trigger gate (owner+prefix / noPrefixChats / surface)
  deduplicated --> dropped_no_trigger: trigger denies
  matched --> reacting: emit start reaction (WA only)
  reacting --> dispatched: dispatchInboundMessage
  dispatched --> handle_commands: handleCommands regex match (e.g. /new, /reset, /stop, /bash)
  handle_commands --> command_handled: handler returns shouldContinue=false
  handle_commands --> agent_run: handler returns shouldContinue=true OR no match
  agent_run --> replied_final: turn complete, reply delivered via deliverWebReply
  agent_run --> replied_error: surface_error envelope delivered
  agent_run --> dropped_silent: silent reply policy (silent-reply-policy.ts)
  command_handled --> [*]
  replied_final --> [*]
  replied_error --> [*]
  dropped_dupe --> [*]
  dropped_no_trigger --> [*]
  dropped_silent --> [*]
```

**Invariants:**

- For WhatsApp: every state transition is reflected in chat reactions (🤔 thinking, 🤖 active, ✅ done, ⚠️ error).
- `dropped_dupe` and `dropped_no_trigger` are the only states with NO outbound; everything else emits something the user can see.
- `handle_commands` runs BEFORE `agent_run` and can short-circuit (e.g., `/stop`, `/bash`, `/restart`).

---

## L4. Restart-recovery flow (boot)

**Entity:** the gateway boot sequence for main-session recovery.

```mermaid
stateDiagram-v2
  [*] --> boot
  boot --> mark_phase: server-startup-post-attach
  mark_phase --> recovery_phase: markRunningMainSessionsAsInterrupted
  recovery_phase --> per_session_loop: for each interrupted entry
  per_session_loop --> tail_check: resolveMainSessionResumeBlockReason
  tail_check --> push_envelope: informational only (FORK 2026-05-10)
  push_envelope --> resume_dispatch: chat.inject returned ok
  push_envelope --> resume_dispatch: chat.inject failed (best-effort)
  resume_dispatch --> mark_recovered: agent dispatch returned ok
  resume_dispatch --> mark_failed: agent dispatch threw
  mark_recovered --> per_session_loop: next entry
  mark_failed --> per_session_loop: next entry
  per_session_loop --> done: all entries processed
  done --> [*]
```

**Invariants:**

- The envelope (orange chip) ALWAYS fires before the resume dispatch, so the user sees the restart first.
- Resume is attempted regardless of tail-check result (FORK 2026-05-10).
- Only `agent:main:*` sessions are eligible. Subagent, cron, ACP sessions are skipped (`shouldSkipMainRecovery`).
- Recovery is bounded: `DEFAULT_RECOVERY_DELAY_MS=5000`, `MAX_RECOVERY_RETRIES=3`, exponential backoff.

---

## L5. chat.send run (single turn)

**Entity:** one `chat.send` RPC invocation, identified by `runId`.

```mermaid
stateDiagram-v2
  [*] --> accepted
  accepted --> dispatched: dispatchInboundMessage fire-and-forget
  dispatched --> streaming: tinker-bridge spawns / pi-agent-core streamFn
  streaming --> streaming: state="delta" broadcasts
  streaming --> finalizing_ok: lifecyclePhase=done
  streaming --> finalizing_error: lifecyclePhase=error OR surface_error
  streaming --> aborted_ext: chatAbortController.abort (user /stop, gateway shutdown)
  finalizing_ok --> broadcast_final: emitChatFinal jobState="done"
  finalizing_error --> broadcast_error: emitChatFinal jobState="error"
  aborted_ext --> broadcast_aborted: emitChatFinal jobState="error" (errorKind=aborted)
  broadcast_final --> cleanup: agentRunSeq.delete + chatAbortControllers cleanup
  broadcast_error --> cleanup
  broadcast_aborted --> cleanup
  cleanup --> [*]
  Note right of broadcast_final: BACKSTOP (FORK 2026-05-10):<br/>chat.ts .then() also fires<br/>broadcastChatFinal when<br/>agentRunStarted=true. Idempotent<br/>via agentRunSeq.delete.
```

**Invariants:**

- Every `runId` ends in a broadcast with `state ∈ {final, error, aborted}`.
- `agentRunSeq` map is the source of truth for run sequence numbers; `delete` is the cleanup signal.

**Open follow-up:** unify the lifecycle path (`server-chat.ts:emitChatFinal`) and the backstop path (`chat.ts:.then() broadcastChatFinal`) into a single emitter. Today they coexist as defense-in-depth; ultimately one should call the other.

---

## L-PROMPT — One user prompt, from keystroke to answer (client lane)

**Status:** DEPLOYED (FORK 2026-08-28). L5 above is the SERVER's view of the same turn, keyed by `runId`; this is the BROWSER's view of the same act, keyed by `_clientMsgId`. They meet at `chat.send`.

**Entity:** one user prompt in `tinker-ui`, identified by the single `clientMsgId` minted in `send()` (`tinker-ui/src/app.ts`) and reused as the outbox id, the bubble id and the gateway `idempotencyKey`.

### The distinction the whole diagram exists to make

"Queued" was one word for two orthogonal facts, and every bug in this area came out of the confusion:

|                       | question                                                                                                          | who owns the answer                                       | surface allowed to paint it                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| **DEFERRED**          | _where is the bubble stored?_ — held out of `messages[]` so the running turn's later bubbles cannot land above it | the CLIENT (`pendingQueuedSends`, gated by `shouldQueue`) | the trailing dimmed bubble, and nothing else |
| **transport backlog** | _is the server holding the text unprocessed?_                                                                     | the SERVER (`queueDepth` in diagnostics)                  | a server-sourced surface, or nothing         |

**`chat.send` is not gated by the deferral decision.** It fires on every send, deferred or not. Therefore a client-side "queued" bubble NEVER means "your words are still in your browser" — it means only "this bubble is parked below the fold". A surface that reads DEFERRED and says _queued_ to the user is asserting a transport fact it does not hold, which is why "it says queued while it is obviously the one being processed" was a truthful bug report and not a race.

`_undelivered` is the third, genuinely different fact — _nobody has this but your browser_ — and must never be styled like either of the others.

```mermaid
stateDiagram-v2
  [*] --> composed
  composed --> protected: send() writes outbox + journal BEFORE any await
  protected --> echoed: not deferred -> pushUserMsgDeduped -> messages[]
  protected --> deferred: shouldQueue() true -> pendingQueuedSends (tagged _queuedSession)

  echoed --> in_flight: chat.send fires
  deferred --> in_flight: chat.send fires ANYWAY (deferral is rendering, not transport)

  in_flight --> accepted_pending: RPC resolves - gateway holds it, no model open yet
  accepted_pending --> accepted_live: first model-bearing lifecycle phase start
  accepted_live --> answered: chat terminal for this session
  accepted_pending --> answered: terminal without a model call

  deferred --> echoed: settleQueuedSession on THIS session's turn end
  deferred --> stranded: queued > QUEUED_STRANDED_MS with no fresh run left
  in_flight --> undelivered: chat.send rejects - amber lane, retry offered
  undelivered --> in_flight: retry - same bubble id, FRESH idempotencyKey

  answered --> [*]: outbox entry retired only when proven in chat.history
  stranded --> [*]: surfaced to the user - never silently dropped

  note right of protected
    The prompt is on disk here.
    Everything after this point may
    fail without losing the text.
  end note
  note right of accepted_pending
    THE PRE-MODEL WINDOW: measured 21-36 s.
    All five activity indicators light HERE,
    not at accepted_live. See the table below.
  end note
```

**Invariants:**

- **PROTECTED precedes every yield.** The outbox write, the journal write and the one `clientMsgId` all happen before the first `await` in `send()`. Everything downstream is recoverable because of this, and it is why the 2026-08-26 crash cost seconds rather than the prompt itself.
- **ECHO IS SYNCHRONOUS AND UNCONDITIONAL.** A prompt reaches `echoed` or `deferred` on the same task that cleared the composer — never after a network round-trip. The composer's keydown handler does not `await send()`, so a throw inside `send()` blanks the box regardless: **any exception on this path costs the user their text on screen.** The deferral decision is therefore wrapped and fails safe to _not deferred_ — cosmetic misordering beats a prompt that vanishes.
- **DEFERRED never gates transport.** `chat.send` sits outside every deferral branch. Moving it inside would convert a rendering choice into a delivery choice, which is the bug class this whole entry documents.
- **One prompt, one bubble.** The outbox backstop re-injects from disk only for ids absent from BOTH `messages[]` and `pendingQueuedSends`; de-duplicating against `messages[]` alone paints a second, amber copy of every deferred prompt within 5 s.
- **Deferral is per SESSION, not per tab.** Every deferred entry carries `_queuedSession`; the render filters by it and the drain keys on the session whose turn ended, not on the tab being viewed (2026-06-08).
- **ACK IS NOT DURABILITY.** The outbox entry is retired only when `chat.history` proves the turn, never in the `chat.send` `.then()` (2026-08-24).

### The five activity indicators

The architect's rule (2026-08-28): **all five light from the moment the prompt is sent until the answer arrives** — i.e. across `accepted_pending` AND `accepted_live`, not from the first model token. They are deliberately synchronized for user simplicity, even though the models panel is strictly speaking naming a model that has not started computing yet.

| #   | surface                   | trigger membership                                                                                                                                       |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | chat thinking pill        | `repaintActivitySurfaces()`                                                                                                                              |
| 2   | tab glow                  | `repaintActivitySurfaces()`                                                                                                                              |
| 3   | sessions-panel row        | `repaintActivitySurfaces()`                                                                                                                              |
| 4   | models panel              | `repaintActivitySurfaces()`                                                                                                                              |
| 5   | recipes / prefrontal tree | **sibling call in `activityTick`, NOT in the trigger** — and the only one that never consults `resolveSessionRunState`, so it carries no freshness bound |

**The consequence the architect accepted, and the condition attached to it:** because all five light during the pre-model window, **AUTO model selection must stay fast.** The synchronization is only honest while "which model?" is a cheap decision. **If model selection becomes materially more expensive — a routing call, a scoring pass, a negotiation — the (models, recipes) pair must be dissociated from the (chat, tab, sessions) trio,** so the first three keep meaning _your turn is being worked on_ while the last two go back to meaning _this specific model is computing_. That dissociation is NOT implemented today; this note is the trigger condition for building it.

see also: done-signals.md (owns which signal wins when they disagree, and the R2a rule that a predicate clears nothing), architecture.md (the ONE PREDICATE · ONE TRIGGER · ONE CLOCK · ONE STATE SET row for UI session-activity indication), turn-latency.md (owns the measured cost of the pre-model stages), tinker-ui.md (owns the visual language of the three bubble lanes), bug-log.md (the 2026-08-26 incident this entry was written from).

---

## L6. Restart-deferral drain (task freshness gate)

**Status:** DEPLOYED (FORK 2026-07-21, `aec445bfbb` + `dbfc255cbe`). last_verified 2026-07-21.

**Entity:** one reconciled queued/running `TaskRecord`, as seen by the gateway restart/reload drain (`waitForActiveWorkBeforeChannelReload` and the restart gate in `src/gateway/server-reload-handlers.ts`).

**Code:** `getRestartBlockingTaskSummary` in `src/tasks/task-registry.maintenance.ts`; consumed by `getActiveCounts` in `src/gateway/server-reload-handlers.ts`.

```mermaid
stateDiagram-v2
  [*] --> active: reconcile pass keeps task queued/running
  active --> fresh_blocking: now - (lastEventAt ?? startedAt ?? createdAt) < RESTART_BLOCKING_TASK_STALE_MS (10 min)
  active --> stale_ignored: silent >= 10 min on the same freshness reference
  fresh_blocking --> vetoes_restart: blocking++ → getActiveCounts totalActive
  stale_ignored --> still_displayed: getInspectableTaskRegistrySummary untouched — shows as running everywhere
  vetoes_restart --> [*]: gateway restart / channel reload deferred until fresh work drains
  still_displayed --> [*]: logged as N stale task run(s) ignored — restart proceeds
```

**Invariants:**

- Freshness reference = `lastEventAt ?? startedAt ?? createdAt` — the SAME chain as `hasLostGraceExpired`, so the restart gate and lost-marking never disagree about what "silent" means. Silent ≥ 10 min (`RESTART_BLOCKING_TASK_STALE_MS`) → `staleIgnored`; otherwise → `blocking`.
- **Fresh/stale is a restart-gate VIEW, not a status transition.** A stale task still displays as running everywhere (`getInspectableTaskRegistrySummary` untouched); it only stops vetoing a gateway restart or channel reload.
- `getActiveCounts` folds ONLY `blocking` into `totalActive`; `staleIgnored` surfaces in deferral messages as `<n> stale task run(s) ignored`, so the drain's decision stays auditable in the logs.
- The same reconcile pass runs first (durable cron recovery + lost-marking still apply); the fresh/stale partition only touches tasks that SURVIVE reconciliation.
- **Why (2026-07-21):** a running task whose session-store entry still exists is never marked lost (`hasBackingSession`), so a dead worker could block restarts indefinitely — observed live: 10 zombies deferring a gateway restart 4+ hours.

see also: config-shape.md (owns config-key semantics — the 10-min threshold is the code constant `RESTART_BLOCKING_TASK_STALE_MS` today, `staleAfterMs` is an opts override, no config key yet), failures.md (deferral that never completes), flows.md (restart drain sequence).

**Probe:** none dedicated yet — `getRestartBlockingTaskSummary()` is callable in-process; the deferral log line (`<n> stale task run(s) ignored`) is the observable surface.

---

---

## L-PLAN — Plan lifecycle (plan-store managed)

**Entity:** one plan document at `~/.openclaw/workspace/state/prefrontal/plans/<sessionKey-slug>.md`.

```mermaid
stateDiagram-v2
  [*] --> in_progress: prefrontal.plan.set (status default)
  in_progress --> done: prefrontal.plan.close(status:"done")
  in_progress --> aborted: prefrontal.plan.close(status:"aborted")
  done --> [*]: archived to plans/archive/<YYYY-MM-DD>/
  aborted --> [*]: archived to plans/archive/<YYYY-MM-DD>/
```

**Invariants:**

- `prefrontal.plan.set` always creates with `status: in_progress` unless an explicit `status` is passed.
- `prefrontal.plan.close` transitions to `done` or `aborted` and moves the file to the archive directory.
- The archive path is `~/.openclaw/workspace/state/prefrontal/plans/archive/<YYYY-MM-DD>/<sessionKey-slug>.md`.
- `prefrontal.plan.get` returns `null` for plans that have been closed/archived.
- A sessionKey can have at most one active (in_progress) plan at a time — calling `plan.set` again replaces the existing plan.

**Probe:** `prefrontal.plan.get({ sessionKey })` — returns `{ plan }` with current frontmatter.

---

## L-STEP — Step lifecycle within a plan

**Entity:** one step entry within a plan document (indexed 0-based by `currentStep`).

```mermaid
stateDiagram-v2
  [*] --> pending: plan.set seeds all steps as pending
  pending --> in_progress: plan.step(stepIndex, status:"in_progress")
  in_progress --> done: plan.step(stepIndex, status:"done")
  in_progress --> error: plan.step(stepIndex, status:"error")
  error --> in_progress: plan.step(stepIndex, status:"in_progress") — retry
  done --> [*]
  error --> [*]: plan closes with aborted
```

**Invariants:**

- **At most one step may be `in_progress` at a time per plan.** Calling `plan.step` with `status: "in_progress"` for step N automatically demotes any previously `in_progress` step back to `pending`. Enforced by plan-store, not caller.
- Setting a step to `done` does not automatically advance `currentStep` — the caller must explicitly promote the next step.
- An `error` step can be retried by calling `plan.step` again with `status: "in_progress"`.
- Steps cannot be removed or reordered after the plan is created — only status mutations are allowed.

---

## L-KIT-INSTALL — Kit install lifecycle

**Entity:** one `prefrontal.kit.install` invocation.

```mermaid
stateDiagram-v2
  [*] --> fetched: GET /api/kits/<owner>/<slug>/install
  fetched --> risk_checked: inspect risk[] from API response
  risk_checked --> refused: risk Critical/High AND !allowRisky
  risk_checked --> sandbox_written: risk acceptable OR allowRisky:true
  sandbox_written --> verified: all files pass resolveSandboxPath + written to FS
  sandbox_written --> failed: any file fails sandbox check or write error
  verified --> [*]: return {ok:true, installedPath, preflightResults, nextSteps}
  refused --> [*]: return {ok:false, reason:"high risk"}
  failed --> [*]: return {ok:false, reason: sandbox/write error message}
```

**Invariants:**

- `fetched → risk_checked` is always synchronous — risk check happens before any file write.
- `sandbox_written` is atomic per-file: if any file fails, the whole install returns `{ok:false}`. Files already written in a partial install are NOT rolled back (future work: transactional write).
- Preflight execution is stubbed in the current implementation. `preflightResults` is returned verbatim from the API response; no actual script execution happens.
- The `verified` state does NOT mean the installed kit has been run or tested — only that all files were written without sandbox violations.

---

## L-STRATEGY — Strategy-switch state machine (U4)

**Status:** DEPLOYED (develop `06f8647fdc`, gateway restarted clean; `fork.strategy.switch.list` VERIFIED-LIVE → `{ok:true,decisions:[]}`). last_verified 2026-06-02.

**Entity:** one per-strategy `StrategyState` (keyed by `strategyId`) inside the durable `FailureStateMap` at `~/.openclaw/engram/failure-state.json`. A "strategy" is the named approach a cron/task currently uses (canonical: `fork-sync:always-merge`, the B010 cascade).

**Code:** transition fns in `src/memory/engram/failure-tracking.ts` (PURE: `recordFailure`/`recordSuccess`/`applySwitch`); decision logic in `src/memory/engram/strategy-switch.ts` (`decideSwitch`); atomic temp+rename persistence in `src/memory/engram/failure-tracking-store.ts` (`updateFailureStateMap` read-modify-write); review/apply RPCs in `src/gateway/server-methods/engram-strategy.ts`. Driven offline by the engram-consolidate cron. See also flows.md (the consolidate→decide→manifest sequence).

```mermaid
stateDiagram-v2
  [*] --> tracking: createInitialStrategyState (consecutiveErrors=0)
  tracking --> tracking: recordFailure → consecutiveErrors++
  tracking --> tracking: recordSuccess → consecutiveErrors=0 (reset, stamps recoveredAfter)
  tracking --> below_threshold: decideSwitch & consecutiveErrors < threshold (default 3)
  below_threshold --> tracking: more turns
  tracking --> stale_suppressed: consecutiveErrors >= threshold BUT lastFailureTime older than windowMs (default 24h)
  stale_suppressed --> tracking: recency guard suppresses; keep accumulating
  tracking --> switch_proposed: consecutiveErrors >= threshold AND within window (shouldSwitch=true)
  switch_proposed --> needs_human_review: toStrategy==null (no fallback) OR confidence < minConfidence (default 0.8)
  switch_proposed --> applyable: registered fallback AND confidence >= minConfidence
  applyable --> switched: fork.strategy.switch.apply → applySwitch (currentStrategy=to, counter reset, switchHistory += record)
  needs_human_review --> switched: human (or autonomy loop) calls fork.strategy.switch.apply with explicit toStrategy
  needs_human_review --> tracking: human declines; no switch
  switched --> tracking: post-switch failures counted via failuresSinceSwitch
  switched --> recovered: recordSuccess after switch → recoveredAfter stamped on the switch record
  recovered --> tracking: counter clean, new pattern can start
```

**Invariants:**

- `switch_proposed` requires BOTH conditions: `consecutiveErrors >= threshold` AND the most recent failure is within `windowMs` (`DEFAULT_STRATEGY_SWITCH_CONFIG`: threshold 3, windowMs 24h, minConfidence 0.8). A stale-but-numerous failure run is `stale_suppressed`, NOT a switch — the recency guard exists so an old burst doesn't trip a switch weeks later.
- `decideSwitch` is pure/read-only: `fork.strategy.switch.list` and `.review` recompute it on every call from the on-disk map; they never mutate state. Only `fork.strategy.switch.apply` writes (via `applySwitch` inside the atomic `updateFailureStateMap`).
- `needsHumanReview` is set when `toStrategy === null` (no entry in `DEFAULT_FALLBACKS`, which ships `fork-sync:always-merge → fork-sync:ask-before-merge` + `always-merge → ask-before-merge`) OR `confidence < minConfidence`. `apply` will still proceed if given an explicit `toStrategy` — the review flag is advisory, not a hard gate.
- Confidence is lowered by 0.25 when the last switch on this strategy did not recover (`recoveredAfter` undefined or > 0) — an anti-thrash penalty so the machine doesn't ping-pong between two strategies.
- `recordFailure`/`recordSuccess` are idempotent within a consolidation window via `countedEventIds` (bounded to 200), guarding against episode-split double counting.
- Every write goes through `updateFailureStateMap` (re-read fresh inside the atomic helper, temp+rename) so a concurrent writer's strategies are never clobbered (feedback_atomic_store_writes).

**Probe:** `fork.strategy.switch.review({strategyId?})` — full per-strategy `StrategyState` plus its current `decision`; the human audit surface. `fork.strategy.switch.list` returns only the `shouldSwitch===true` decisions (the open-proposal queue).

---

## L-RECIPE-VARIANT — Recipe variant evolution (U1)

**Status:** DEPLOYED (develop `06f8647fdc`). Gated by `RECIPE_AUTOAPPLY_ENABLED` (already `true`). last_verified 2026-06-02.

**Entity:** one recipe variant (`recipeId` @ a `version`) tracked by fitness in the never-delete archive at `<engram-baseDir>/recipe-archive/<recipeId-slug>/v<n>.json` (+ `index.json`). A `MutationProposal` is the transient object the evolution operator emits per consolidation.

**Code:** `src/memory/engram/recipe-fitness.ts` (Laplace-smoothed `successRate`, `loadRecipeFitness`/`makeFitnessLookup`); `src/memory/engram/recipe-evolution.ts` (`proposeMutations` + `isAutoPromotable`); `src/memory/engram/recipe-archive.ts` (`putVariant`/`deprecate`/`rank` — never deletes). PRODUCER of attribution: `recipe-runner.ts` stamps `recipe:<owner/slug>` tags via `onTag` (threaded by `prefrontal.recipe.run`); selection feeds `makeFitnessLookup` into `matchRecipesDetailed`. The actual recipe WRITE (turning an `autoPromotable` proposal into a kit-file edit) lives in the Prefrontal kit layer, OUT of scope of this operator — the Cerebellum only proposes + flags. See also subagents-and-recipes.md (selection/scoring precedence) and flows.md (consolidate→propose sequence).

```mermaid
stateDiagram-v2
  [*] --> running: recipe-runner runs a recipe (onTag stamps recipe:<owner/slug> attribution)
  running --> fitness_updated: outcome folded into recipe-fitness (Laplace-smoothed successRate)
  fitness_updated --> no_proposal: runs < minRuns (default 3) — low-n, stay quiet
  no_proposal --> running: more runs accumulate
  fitness_updated --> no_proposal: successRate >= floor (default 0.5) AND no latency regression
  fitness_updated --> proposed: successRate < floor AND runs >= minRuns (proposeMutations → add_step + tighten_criteria)
  fitness_updated --> proposed_efficiency: avgLatencyMs regressed > ratio (default 0.25) vs window mean (remove_step/reorder)
  proposed --> auto_promotable: isAutoPromotable (successRate <= floor*autoFloorRatio[0.5] AND runs >= autoMinRuns[8])
  proposed --> parked_for_review: needsHumanReview=true (under floor but not FAR under, or runs < autoMinRuns)
  proposed_efficiency --> parked_for_review: latency proposals are NEVER auto-promotable (always human-gated)
  auto_promotable --> applied_archived: Prefrontal kit layer writes new variant → putVariant(v+1); prior version stays readable
  parked_for_review --> applied_archived: human approves → new variant written + archived
  parked_for_review --> dropped: human declines (no mutation; archive unchanged)
  applied_archived --> deprecated: a superseding variant marks the prior deprecate() — body NEVER deleted (rollback path)
  applied_archived --> running: new variant enters rank() selection (epsilon-greedy, difficulty-aware)
  deprecated --> running: rollback re-promotes an archived variant (read() works on deprecated bodies)
```

**Invariants:**

- The evolution operator NEVER writes a recipe and NEVER applies a mutation — it only emits `MutationProposal`s and flags `autoPromotable`/`needsHumanReview`. The `applied_archived` edge is the Prefrontal kit layer's responsibility (cross-subsystem), not this module's.
- `autoPromotable` requires ALL THREE: HIGH-CONFIDENCE (`successRate <= successFloor * autoFloorRatio`, i.e. FAR below the floor, not merely under it), WELL-EVIDENCED (`runs >= autoMinRuns`, default 8, strictly greater than the `minRuns`=3 proposal threshold), and REVERSIBLE (always true — the never-delete archive). When `autoPromotable` is true, `needsHumanReview` drops to false.
- Only corrective (low-success-rate) proposals are ever `auto_promotable`. Efficiency/latency proposals (`remove_step`/`reorder`) are always `needsHumanReview:true` — they are not the high-confidence correctness win the autonomy gate targets.
- **Never-delete is the rollback safety net.** `deprecate()` only flips a flag; `read()` still returns a deprecated variant's body. There is NO delete path. This is what makes auto-promotion bounded/safe (self-reinforcing-error-spiral mitigation).
- `rank()` returns LIVE (non-deprecated) variants best-`successRate`-first with an epsilon-greedy explorer slot (default ε 0.1; deterministic when a seeded RNG is injected) and an optional `taskDifficulty` bias (Gödel: difficulty-aware selection).

**Probe:** none yet (proposed `fork.recipe.fitness({recipeId})` would return current fitness + archived versions + open proposals). Today inspect `recipe-archive/index.json` + the per-version sidecars directly. See probes.md.

---

## L-CURIOSITY-GAP — Curiosity gap lifecycle (U2)

**Status:** DEPLOYED (develop `06f8647fdc`). 2a hedge-detector + 2d idle-goal trigger live; RPCs present. 2c LoRA training is an EXTERNAL STUB ONLY (no GPU/Python training; out of scope — see config-shape.md dead-code registry). last_verified 2026-06-02.

**Entity:** one `Gap` record in the append-only JSONL buffer at `~/.openclaw/workspace/memory/curiosity-gaps/YYYY-MM-DD.jsonl` (auto-indexed by memorySearch). Resolution is itself an appended row, folded back by `dedupeKey` — history is never rewritten.

**Code:** `src/fork/curiosity-store.ts` (`makeGap`/`appendGap`/`readGaps`/`topGaps`/`markResolved`/`rescore`/`dedupeGaps`); RPCs in `src/fork/curiosity-rpc.ts` (`fork.curiosity.logGap`/`topGaps`/`resolveGap`). PRODUCERS: 2a hedging-detector wired in `attempt-hooks.ts` `onTurnComplete` (`detectUncertaintySpans` → `extractTopic` → `makeGap` source `lcm-entropy` → `appendGap`, fire-and-forget); 2d idle trigger in `src/fork/idle-goals.ts` (`proposeIdleGoals`, debounced per-session timer re-armed by `noteTurnActivity` in `onTurnComplete`). See also flows.md (NO-MATCH → gap → active-learning sequence).

```mermaid
stateDiagram-v2
  [*] --> logged: gap detected → makeGap + appendGap (frequency=1)
  note right of logged
    sources: lcm-entropy (2a hedge in onTurnComplete),
    no-match (2e prefrontal), retrieval-miss,
    user-correction, manual
  end note
  logged --> deduped: dedupeGaps collapses by dedupeKey — frequency summed, ts bumped to latest sighting
  deduped --> classified_drop: no-match classifyGap = recoverable | external-outage (trail event only, NOT learnable)
  classified_drop --> [*]
  deduped --> open: knowledge-gap / lcm-entropy / etc. — unresolved, in the active-learning pool
  open --> surfaced: topGaps re-scores (importance/learnability/adjacency/userRelevance/recency) + returns top-K
  surfaced --> idle_goal_proposed: proposeIdleGoals (session quiet > CURIOSITY_IDLE_MS[30m], rate-limited 1/2h) → curiosity-goal-proposal lifecycle event
  idle_goal_proposed --> open: proposal is NON-intrusive + dismissable — never a sessions.send, never triggers a turn
  surfaced --> nightly_goal: engram-consolidate / self-evolution cron picks next-goals from topGaps
  nightly_goal --> open: still open until externally resolved
  open --> resolved: markResolved → append resolution row (resolvedAt/resolvedBy/resolutionSource)
  resolved --> [*]
```

**Invariants:**

- **No self-output-as-truth (§9.3):** `source:"lcm-entropy"` gaps are _questions_, never facts; they may only ever be resolved from an EXTERNAL channel (the store records `resolutionSource`; "external only" enforcement lives in the active-learning cron body).
- `classifyGap` gates which NO-MATCH failures even become a learnable gap: `recoverable` (permission/auth — user can grant) and `external-outage` (network/timeout/5xx) emit a trail event but NO `Gap`; only `knowledge-gap` feeds the buffer (recon risk #2 — don't waste active-learning on a transient outage).
- The `idle_goal_proposed` edge is deliberately a dead-end back to `open`: a proposal is a NON-intrusive `curiosity-goal-proposal` lifecycle event (a dismissable chip), NOT a `sessions.send` — it must never trigger a Jarvis turn or interrupt the user. Rate-limited (≥2h/session) and skipped for automated/subagent/cron sessions.
- Resolution is append-only: `markResolved` writes a _resolution row_ (copy of the gap with resolution fields stamped) to today's file; `dedupeGaps` folds it onto the original by `dedupeKey`. History is never rewritten (atomic-append discipline; the daily file is `O_APPEND` single-write safe).
- JSONL append never blind-overwrites; a torn tail line degrades to "skip that line", never an exception that crashes the cron.

**Probe:** `fork.curiosity.topGaps({k})` — the current open active-learning queue (deduped, re-scored, top-K). `fork.curiosity.resolveGap({id,by,source})` transitions a gap to `resolved`. No state-snapshot probe for a single gap id yet.

---

## Validation strategy

Each state machine should be paired with a probe that returns the entity's current state. Today only L1 has a partial probe (`sessions.json` direct read); L2–L5 need probes (see `probes.md`).

When a state transition is added in code, the diagram must be updated in the same PR. The merge gate (J15 §5) eventually enforces this by failing when a code path leaves a state with no diagram arrow.
