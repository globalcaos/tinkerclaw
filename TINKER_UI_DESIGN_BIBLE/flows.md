---
file: flows.md
purpose: Sequence diagrams (Mermaid) for the top pipelines an AI must understand before editing
audience: AI
last_verified: 2026-06-01
last_verified_commit: 18e618d241
single_owner: yes — sequence-of-calls facts live here, not in bible.md
see_also: lifecycles.md (state transitions per entity), failures.md (failure-mode propagation), topology.md (which components exist)
verify:
  - name: F1 — chat.send returns a runId synchronously (the dispatch path is alive)
    cmd: python3 -c 'import subprocess,json,time; r=subprocess.run(["openclaw","gateway","call","chat.send","--params",json.dumps({"sessionKey":"agent:main:main","message":"FLOWS-F1-VERIFY","deliver":False,"dispatchAgent":False,"idempotencyKey":f"flows-f1-{int(time.time()*1000)}"})],capture_output=True,text=True,timeout=25); assert "runId" in r.stdout, r.stdout[-500:]'
  - name: F5 — briefing.resolve returns content (the /new path's resolver is alive)
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","briefing.resolve"],capture_output=True,text=True,timeout=25); j = json.loads(r.stdout.split("Gateway call:")[-1].split("\n",1)[1] if "Gateway call:" in r.stdout else r.stdout); assert j.get("content") or j.get("path"), r.stdout[-500:]'
  - name: F-PLAN-RESUME — plan RPCs round-trip without firing a turn
    cmd: python3 -c 'import subprocess,json,time; sk=f"test:plan:{int(time.time()*1000)}"; subprocess.run(["openclaw","gateway","call","prefrontal.plan.set","--params",json.dumps({"sessionKey":sk,"intent":"verify","runId":"v1","steps":[{"title":"a"},{"title":"b"}]})],check=True,timeout=15); r=subprocess.run(["openclaw","gateway","call","prefrontal.plan.get","--params",json.dumps({"sessionKey":sk})],capture_output=True,text=True,timeout=15); assert "verify" in r.stdout, r.stdout[-500:]; subprocess.run(["openclaw","gateway","call","prefrontal.plan.close","--params",json.dumps({"sessionKey":sk,"status":"aborted"})],check=True,timeout=15)'
  - name: F-KIT-INSTALL — kit RPCs alive (search responds)
    cmd: python3 -c 'import subprocess,json; r=subprocess.run(["openclaw","gateway","call","prefrontal.kit.search","--params",json.dumps({"query":"feature"})],capture_output=True,text=True,timeout=20); assert "results" in r.stdout, r.stdout[-500:]'
  - name: F-RECIPE-STATE — runKit wires the onRecipeState producer (the dull-panel fix)
    cmd: python3 -c 'import os; src=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kit-rpcs.ts")).read(); assert "onRecipeState:" in src and "fork.prefrontal.setRecipe" in src, "recipe-state producer wiring missing"'
---

# Flows — top pipelines

Each diagram below is the canonical sequence-of-calls for one pipeline. If the diagram disagrees with the code at HEAD, the diagram is stale and must be re-verified.

---

## F1. Tinker UI inbound: `chat.send` → cc-bridge → reply

**Trigger:** user types a message in Tinker UI webchat.
**Entry:** `src/gateway/server-methods/chat.ts:chatHandlers["chat.send"]`
**Exit:** TUI receives `chat` broadcast with `state="final"` or `state="error"`.

```mermaid
sequenceDiagram
  participant TUI as Tinker UI (app.ts)
  participant GW as Gateway (chat.ts)
  participant AR as auto-reply (dispatchInboundMessage)
  participant DSP as ReplyDispatcher
  participant CC as cc-bridge (worker)
  participant CLI as claude-cli (subprocess)
  participant SCH as server-chat.ts (lifecycle)

  TUI->>GW: chat.send {sessionKey, message, idempotencyKey}
  GW-->>TUI: {runId, status:"started"}
  GW->>AR: dispatchInboundMessage(ctx, cfg, dispatcher, replyOptions)
  Note over GW,AR: chat.ts:2324 — fire-and-forget (.then/.catch)
  AR->>DSP: createReplyDispatcher({deliver: collect to deliveredReplies[]})
  AR->>CC: pool.getOrCreate({sessionKey, openclawSessionId, ...})
  CC->>CLI: spawn claude --resume <sessionId>
  CLI-->>CC: stream-json events (tool_use, tool_result, text deltas)
  CC-->>SCH: emit lifecycle events
  SCH->>TUI: broadcast("chat", {state:"delta", ...})
  Note over CLI,CC: tool calls execute INSIDE claude-cli<br/>see tool-loop.md
  CLI-->>CC: result (final text)
  CC-->>SCH: lifecyclePhase = "done" (or "error" on surface_error)
  SCH->>TUI: broadcast("chat", {state:"final", message})
  alt lifecycle event dropped (FORK 2026-05-10 fix)
    AR-->>GW: .then() — agentRunStarted=true
    GW->>TUI: broadcastChatFinal (BACKSTOP)
  end
```

**Invariants:**

- Every `chat.send` run terminates with at least one `chat` broadcast where `state ∈ {final, error, aborted}`. Enforced by `server-chat.ts:emitChatFinal` (lifecycle path) + `chat.ts:2515` (backstop, FORK 2026-05-10, see bible §11.6e).
- `runId` returned by `chat.send` is the same `runId` carried in every subsequent `chat` broadcast for that run.
- `dispatchAgent:false` short-circuits after the synchronous ack — caller still receives `{runId, status:"started"}`, but no transcript write, no `dispatchInboundMessage`, no `chat` broadcasts. F1's invariant probe uses this so the bible merge gate does not surface "FLOWS-F1-VERIFY" + an agent reply in the user's Tinker UI session. `deliver` only governs OUTBOUND channel routing (WA etc.); the in-app `broadcast("chat", …)` fan-out is keyed by sessionKey and ignores `deliver`. Added `chat.ts:2068` (FORK 2026-05-12).

**Last verified:** 2026-05-12 — F1 runs with `dispatchAgent:false` (zero broadcasts, zero claude-cli spawns).

---

## F2. WhatsApp inbound DM → reply

**Trigger:** the owner sends a WhatsApp message that matches the trigger contract (owner+prefix or noPrefixChats).
**Entry:** `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/...` (wm adapter)
**Exit:** WhatsApp outbound delivered via `deliverWebReply` (misleading name, see topology.md).

```mermaid
sequenceDiagram
  participant WA as WhatsApp (whatsmeow)
  participant ADP as wm-adapter
  participant MON as auto-reply/monitor (LID rescue)
  participant TRG as trigger-gate
  participant AR as auto-reply pipeline
  participant CC as cc-bridge
  participant DDM as DELIVERY-DICHOTOMY
  participant OUT as WA outbound (deliverWebReply)

  WA->>ADP: message:incoming
  ADP->>MON: normalized inbound
  MON->>MON: LID rescue (self.lid===remoteJid OR noPrefixChats∩allowFrom)
  MON->>TRG: from, body, isOwner
  alt trigger matches
    TRG->>AR: dispatch
    AR->>CC: turn
    CC-->>AR: result_text
    AR->>DDM: sendFinalPayload
    DDM->>OUT: deliverWebReply (chunked text + reactions)
    OUT->>WA: send
  else trigger denies
    TRG-->>MON: drop
  end
```

**Invariants:**

- LID rescue gates: `self.lid===remoteJid` OR (`remoteJid ∈ noPrefixChats ∧ allowFrom`). Anything looser triggers the 2026-05-04 sister-DM bug. See bible §13 + memory `Sister-DM trigger bug`.
- For `fromMe=true` self-DM: trigger fires only with explicit owner+prefix.
- Heartbeat reactions alternate 🤔/🤖 ~1/sec while processing; cleared with empty reaction on completion.

**Open follow-up:** populate `self.lid` from whatsmeow auth state (memory note 2026-05-04).

---

## F3. Surface-error → envelope → broadcast

**Trigger:** LLM/provider failure that the agent runner classifies as `surface_error` (timeout, overload, auth, etc.).
**Entry:** `src/agents/pi-embedded-runner/run/assistant-failover.ts`
**Exit:** Channel-appropriate error envelope delivered.

```mermaid
sequenceDiagram
  participant ATT as attempt.ts
  participant FAIL as assistant-failover.ts
  participant ENV as fork/error-envelope.ts
  participant DSP as ReplyDispatcher
  participant RTR as routeReplyToOriginating
  participant DDM as DELIVERY-DICHOTOMY (sendFinalPayload)
  participant OUT as channel-specific delivery
  participant TUI as Tinker UI (webchat)

  ATT->>FAIL: stream error / idle timeout / SIGTERM
  FAIL->>ENV: classify(error) → category
  ENV-->>FAIL: {kind, fatal, category, icon, headline, explanation}
  FAIL->>DSP: sendFinalReply(payload with __ERR_ENV__:JSON)
  DSP->>DDM: deliver callback
  DDM->>RTR: routeReplyToOriginating(payload)
  alt route exists (WA, telegram, etc.)
    RTR->>OUT: deliverWebReply (chunked)
    DDM-->>DSP: queuedFinal=true, routedFinalCount=1
  else webchat (no originating route)
    RTR-->>DDM: null
    DDM->>DSP: dispatcher.sendFinalReply (queues)
    DDM-->>DSP: queuedFinal=true, routedFinalCount=0
    Note over DDM,TUI: lifecycle event from server-chat.ts<br/>SHOULD broadcast state="final"
    DDM-->>TUI: (if isControlUiVisible) broadcast state="final"
    Note over DDM,TUI: BACKSTOP (FORK 2026-05-10):<br/>chat.ts .then() also broadcasts
  end
```

**Invariants:**

- `routedFinalCount=0` for webchat is normal (it's a count of _originating-channel_ routes; webchat uses the dispatcher path).
- The 2026-05-10 backstop in `chat.ts` `.then()` guarantees `broadcastChatFinal` fires even if the lifecycle path drops.

**Bug history:** see failures.md (regression C — chat.send broadcast hole).

---

## F4. Gateway restart → recovery → orange chip → resume

**Trigger:** gateway process exits (SIGUSR1 graceful, SIGTERM, or crash) and boots back up.
**Entry:** `src/gateway/server-startup-post-attach.ts` → `src/agents/main-session-restart-recovery.ts`
**Exit:** TUI sees orange `__ERR_ENV__` chip; agent run resumes on the existing session (cc-bridge resumes claude-cli via session-map openclawSessionId fallback).

```mermaid
sequenceDiagram
  participant BOOT as gateway boot
  participant MRK as markRunningMainSessionsAsInterrupted
  participant REC as recoverRestartAbortedMainSessions
  participant TC as resolveMainSessionResumeBlockReason (informational)
  participant ENV as pushRestartWarningEnvelope
  participant CINJ as chat.inject
  participant AGT as agent dispatch ([System] continue)
  participant CC as cc-bridge worker-pool
  participant CLI as claude-cli (--resume)

  BOOT->>MRK: mark every status:running as interrupted (regardless of stale locks)
  BOOT->>REC: for each interrupted session
  REC->>TC: tail-check (informational only since 2026-05-10)
  REC->>ENV: pushRestartWarningEnvelope({sessionKey})
  ENV->>CINJ: chat.inject(__ERR_ENV__:{cat:busy, fatal:false, icon:🔄, headline:"Gateway restarted at HH:MM — picking up where I stopped"})
  CINJ-->>TUI: state="final" with envelope payload
  REC->>AGT: agent dispatch [System] continue from existing transcript
  AGT->>CC: turn
  CC->>CC: deriveSessionKey (may produce new cc-sp-<hex> due to systemPrompt drift)
  CC->>CC: getLatestResumeSessionIdByOpenclawSessionId(oc) — finds prior cli
  CC->>CLI: spawn --resume <cli sessionId>
  CLI-->>CC: resumed with full prior context
  CC-->>TUI: assistant message (continuation)
```

**Invariants:**

- Every status:`running` session at boot is marked interrupted, regardless of lock state.
- Tail-check is informational; resume is always attempted (FORK 2026-05-10).
- cc-bridge worker-pool prefers `getLatestResumeSessionIdByOpenclawSessionId` over hash-derived sessionKey (FORK 2026-05-10 fix for sessionKey hash drift after [System] continue).
- The envelope chip fires BEFORE the agent dispatch so the user sees the restart first, the resume second.
- **Client-side hold (FORK 2026-05-11):** before the WS closes, the gateway broadcasts `shutdown { restartExpectedMs }`. `tinker-ui/src/app.ts` marks every entry in `activeRuns` with `state: "restarting"`; the `ws addEventListener("close")` handler then preserves `activeRuns` instead of clearing them, and `renderThinkingIndicator()` paints a `RESTARTING` badge alongside the live dots. The resumed agent run's natural lifecycle `start` event replaces the entry on the new gateway, removing the badge. Safety-net: `scheduleUnconfirmedPrune` keeps restarting runs for 30 s (vs 5 s for normal unconfirmed runs) before evicting them — so even if the resume dispatch is delayed, the indicator clears cleanly rather than persisting forever.

**Last verified:** 2026-05-10 commit 78594ebd1a via marker-quote-back test (`MARKER-FIBONACCI-1-1-2-3-5-8-PROOF-FINAL`); client-side hold added 2026-05-11 commit `950b1a83c6`.

---

## F5. `/new` → briefing injection → agent

**Trigger:** user types `/new` in Tinker UI.
**Entry:** `tinker-ui/src/app.ts:buildInjectedPrompt`
**Exit:** Jarvis executes the morning-briefing pipeline.

```mermaid
sequenceDiagram
  participant USR as user
  participant TUI as Tinker UI (buildInjectedPrompt)
  participant RPC as briefing.resolve RPC
  participant FS as workspace BRIEFING.md
  participant SEND as chat.send
  participant AGT as agent
  participant CMD as handleCommands (auto-reply)

  USR->>TUI: types "/new"
  TUI->>RPC: briefing.resolve()
  RPC->>FS: read ~/.openclaw/workspace/BRIEFING.md
  alt success
    FS-->>RPC: full content
    RPC-->>TUI: {path, content}
  else fallback
    RPC-->>TUI: bundled briefing-default.md
  end
  TUI->>TUI: buildBriefingPrompt(path, content) — imperative "Execute NOW" wording + collapsed <details> + .fs-link
  TUI->>SEND: chat.send {message: full_briefing_inject}
  SEND->>AGT: dispatch
  AGT->>CMD: handleCommands
  CMD->>CMD: regex match ^/(new|reset)(\s|$) → resetRequested=true
  CMD->>AGT: emitResetCommandHooks → before_reset hook chain
  AGT-->>USR: briefing execution
```

**Invariants:**

- Wording must include the imperative sentinel `"Execute the morning briefing NOW"` (regex-match-detected by `reconstructInjectionFields`).
- The path link in the user bubble uses `<code class="fs-link" data-path="...">` (reuses `config.openExternalFile` RPC).
- Falls back gracefully: RPC error → soft suffix; bundled missing → soft suffix.

**See also:** bible §11.6b for the imperative-wording rationale (model was acknowledging instead of executing).

---

## F6. cc-bridge tool call (claude-cli internal)

This flow is short by design and has its own document. See `tool-loop.md`.

**One-liner:** tool_use blocks are visible in the UI (via cc-bridge stream events) but NOT placed in `assistant.message.content`, to prevent pi-agent-core's agent-loop from re-executing them via the OpenClaw exec tool. FORK 2026-04-22.

---

## F7. chat.inject → transcript → webchat broadcast

**Trigger:** any code calls `chat.inject` (today: restart-recovery envelope, plugin error envelopes).
**Entry:** `src/gateway/server-methods/chat.ts:chatHandlers["chat.inject"]`
**Exit:** TUI subscription receives the injected message.

```mermaid
sequenceDiagram
  participant CALLER as caller (e.g. recovery)
  participant INJ as chat.inject handler
  participant STR as session store
  participant FS as session jsonl
  participant BCT as broadcast("chat",...)
  participant TUI as Tinker UI

  CALLER->>INJ: {sessionKey, message, label?}
  INJ->>STR: loadSessionEntry(sessionKey)
  INJ->>FS: appendAssistantTranscriptMessage
  INJ->>BCT: state="final" with the injected payload
  BCT->>TUI: live update
  INJ-->>CALLER: {ok:true, messageId}
```

**Invariants:**

- The injected message is persisted to the session transcript BEFORE the broadcast, so a refresh shows it consistently.
- Used today for: the restart-warning orange chip (F4), error envelopes from non-agent paths.

---

---

## F-PLAN-RESUME. Gateway restart → plan-aware [System] continue

**Trigger:** gateway process boots up (SIGUSR1 graceful, SIGTERM, or crash); there is at least one active plan in `state/prefrontal/plans/*.md`.
**Entry:** `extensions/tinkerclaw-prefrontal/src/index.ts:register()` → `runRestartContinue` (30s debounce after boot)
**Exit:** Jarvis receives a plan-aware `[System] continue` dispatch and picks up execution from the correct step; TUI shows a grey `__SYS_PLAN_RESUME__` chip.

```mermaid
sequenceDiagram
  participant BOOT as gateway boot
  participant PFR as prefrontal register()
  participant PS as PlanStore
  participant FS as plans/*.md
  participant SEND as chat.send (loopback)
  participant CINJ as chat.inject
  participant CC as cc-bridge worker-pool
  participant CLI as claude-cli (--resume)
  participant TUI as Tinker UI

  BOOT->>PFR: register() hook fires
  Note over PFR: setTimeout 3s (let gateway stabilise)
  PFR->>PS: runRestartContinue()
  PS->>FS: glob state/prefrontal/plans/*.md
  loop for each in_progress plan
    PS->>PS: read frontmatter (sessionKey, currentStep, intent, kitRef?)
    PS->>CINJ: chat.inject {sessionKey, message:"__SYS_PLAN_RESUME__:Resuming step N: <title>"}
    CINJ-->>TUI: state="final" — grey chip renders
    PS->>SEND: chat.send {sessionKey, deliver:false, dispatchAgent:true, idempotencyKey, message:"[System] Gateway restarted at HH:MM. You were working on plan: <intent>. Current step N: <title>. Continue from where you left off."}
    SEND->>CC: turn for sessionKey
    CC->>CC: getLatestResumeSessionIdByOpenclawSessionId (FORK 2026-05-10)
    CC->>CLI: spawn --resume <cli sessionId>
    CLI-->>CC: resumed with full prior context
    CC-->>TUI: assistant message (continuation)
  end
  Note over PS: debounce 30s same sessionKey — no double dispatch on multiple restarts
  Note over PS: skip plans with status:done or status:aborted
```

**Invariants:**

- Debounce window: 30s per sessionKey. If the gateway bounces twice in <30s only one dispatch fires.
- Plans with `status: done` or `status: aborted` are skipped.
- The `__SYS_PLAN_RESUME__` sentinel is injected via `chat.inject` BEFORE `chat.send` so the chip appears before the agent resumes.
- The dispatch uses `deliver: false, dispatchAgent: true` — INTERNAL_MESSAGE_CHANNEL routes to the agent, the webchat subscription sees only the chip (no duplicate user bubble). See flows.md F1 invariants.
- The `systemKind: "plan-resume"` annotation is carried in the loopback call metadata for diagnostic filtering.
- cc-bridge resume uses `getLatestResumeSessionIdByOpenclawSessionId` (FORK 2026-05-10) so sessionKey hash drift after the `[System] continue` message is tolerated.

**See also:** lifecycles.md L-PLAN, L-STEP; tinker-ui.md §**SYS_PLAN_RESUME** chip family.

---

## F-KIT-INSTALL. Journey kit install (sandboxed)

**Trigger:** caller invokes `prefrontal.kit.install { kitRef }`.
**Entry:** `extensions/tinkerclaw-prefrontal/src/kit-rpcs.ts:handleKitInstall`
**Exit:** files written to `~/.openclaw/workspace/kits/<owner>/<slug>/`; caller receives `{ ok, installedPath, preflightResults, nextSteps }`.

```mermaid
sequenceDiagram
  participant CALLER as caller (Jarvis / TUI)
  participant KR as kit-rpcs.ts
  participant JK as journeykits.ai API
  participant KS as KitStore (sandbox)
  participant FS as ~/.openclaw/workspace/kits/

  CALLER->>KR: prefrontal.kit.install {kitRef, allowRisky?}
  KR->>JK: GET /api/kits/<owner>/<slug>/install?target=openclaw&ref=latest
  JK-->>KR: {files[], preflightChecks[], risk[], nextSteps[]}
  KR->>KR: inspect risk[] — Critical or High Risk?
  alt risk Critical/High AND !allowRisky
    KR-->>CALLER: {ok:false, reason:"Kit flagged as high risk. Pass allowRisky:true to override."}
  else risk acceptable OR allowRisky:true
    loop for each file in files[]
      KR->>KS: resolveSandboxPath(file.path, installTarget)
      alt path is absolute OR contains ".."
        KS-->>KR: throw SandboxViolationError
        KR-->>CALLER: {ok:false, reason:"Sandbox path violation"}
      else path is safe
        KS->>FS: write file contents
      end
    end
    KR->>KR: stubbed preflightChecks (real exec sandbox: future work)
    KR-->>CALLER: {ok:true, installedPath, preflightResults, nextSteps}
  end
```

**Invariants:**

- Every file path in the install payload passes through `resolveSandboxPath` — no bypass, no trusted-path exceptions.
- Risk-gating is active: kits with `risk` containing `"Critical"` or `"High Risk"` require explicit `allowRisky: true`.
- Preflight execution is **stubbed** — `preflightChecks` are returned as-is from the API response. Real execution in a sandbox is future work.
- The install target is `~/.openclaw/workspace/kits/<owner>/<slug>/`. Source-tree kits (bundled at `extensions/tinkerclaw-prefrontal/kits/`) are never overwritten by install — they are separate.
- `nextSteps` is passed through verbatim from the Journey API response for the caller to display.

**See also:** lifecycles.md L-KIT-INSTALL; subagents-and-kits.md §Kits.

---

## F-RECIPE-STATE. Recipe run → live recipe-state → RECIPES panel header

**Trigger:** caller invokes `prefrontal.recipe.run { kitRef, sessionKey, intent }` (the RECIPES-panel-backed kit execution path).
**Entry:** `extensions/tinkerclaw-prefrontal/kit-rpcs.ts:"prefrontal.recipe.run"` → `kit-runner.ts:runKit`
**Exit:** Tinker UI RECIPES panel paints the rich recipe header (recipeId + step M/N + parallelism cap + in-flight labels) from live data instead of the synthetic fallback plan.

**PRIOR GAP (fixed 18e618d241, FORK 2026-05-31):** the panel was dull because `runKit` NEVER emitted recipe-state — the rich header (`renderRecipeHeader`, panels.md) had no data source, so the panel always fell back to the synthetic 2-step "Thinking → Acting" plan. The fix wires the **producer** half: `runKit` now calls `onRecipeState` at kit start, on each parallel-group transition, and on completion.

```mermaid
sequenceDiagram
  participant CALLER as caller (Jarvis / TUI)
  participant KR as kit-rpcs.ts (prefrontal.recipe.run)
  participant RUN as runKit (kit-runner.ts)
  participant SR as fork.prefrontal.setRecipe (prefrontal-state-rpc.ts)
  participant EV as emitAgentEvent (lifecycle)
  participant TUI as Tinker UI (app.ts)
  participant PNL as RECIPES panel (prefrontal-tree.ts)

  CALLER->>KR: prefrontal.recipe.run {kitRef, sessionKey, intent}
  KR->>RUN: runKit({..., onRecipeState})
  Note over KR,RUN: onRecipeState wired to fork.prefrontal.setRecipe<br/>via loopback callGateway — fire-and-forget,<br/>wrapped so observability never throws into the run
  RUN->>KR: onRecipeState({recipeId, step, totalSteps, stepName, parallelismCap, inFlightLabels})
  Note over RUN: emit at kit start, each parallel-group<br/>transition, and on completion
  KR->>SR: callGateway fork.prefrontal.setRecipe {…RecipeStateUpdate}
  SR->>EV: emitAgentEvent(stream=lifecycle, phase="prefrontal-recipe-state")
  EV->>TUI: ws {stream:"lifecycle", data:{phase:"prefrontal-recipe-state", …}}
  TUI->>TUI: app.ts:2864 handler stores currentRecipe
  TUI->>PNL: renderPrefrontalPanel(currentRecipe)
  PNL->>PNL: renderRecipeHeader(recipe) — recipeId + step M/N + parallelism
```

**Invariants:**

- The recipe-state emit is **best-effort, fire-and-forget**: `kit-rpcs.ts` wraps the `callGateway` in `.catch(() => {})` and `runKit` wraps every `onRecipeState` call so observability NEVER throws into the execution loop. A dead/closed UI must not stall a run.
- `onRecipeState` is the PRODUCER seam (the half that was missing). The `RecipeStateUpdate` payload mirrors the `fork.prefrontal.setRecipe` param shape so `kit-rpcs.ts` forwards it verbatim; progress fields are optional (the start emit may omit step detail).
- The lifecycle phase token is `prefrontal-recipe-state` (single owner of the emit: `src/fork/prefrontal-state-rpc.ts`; the UI gate keys on `p.data.phase === "prefrontal-recipe-state"`).
- The header data is **last-write-wins** in the UI: `currentRecipe` holds only the latest event, not a history.

**See also:** subagents-and-kits.md §Kits (the parallel-group/runKit execution mechanism that GENERATES the transitions); panels.md (`renderRecipeHeader` render + RECIPES-panel fallback semantics); lifecycles.md L-STEP (per-step status barrier).

---

## Auto-validation

Each diagram should be paired with an `[idle-timeout-diag]`-style probe that emits one log line per traversal. Today only F1 has this (the `idle-timeout-diag` line). Probes for F2–F7 are listed as proposed in `probes.md`.

## Update cadence

Refactor-driven. A flow diagram changes only when the call graph between named components changes. If you touch any of the file paths cited above, re-validate the diagram and bump `last_verified_commit`.
