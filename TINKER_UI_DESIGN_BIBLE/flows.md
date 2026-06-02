---
file: flows.md
purpose: Sequence diagrams (Mermaid) for the top pipelines an AI must understand before editing
audience: AI
last_verified: 2026-06-02
last_verified_commit: 06f8647fdc
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
  - name: F-RECIPE-STATE — runRecipe wires the onRecipeState producer (the dull-panel fix)
    cmd: python3 -c 'import os; src=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipe-rpcs.ts")).read(); assert "onRecipeState:" in src and "fork.prefrontal.setRecipe" in src, "recipe-state producer wiring missing"'
  - name: F-RECIPE-EVOLVE — consolidation self-apply loop wired to the prefrontal apply RPC (U1)
    cmd: python3 -c 'import os; con=open(os.path.expanduser("~/src/tinkerclaw/src/memory/engram/sleep-consolidation.ts")).read(); assert "proposeMutations" in con and "prefrontal.recipe.applyProposal" in con and "RECIPE_AUTOAPPLY_ENABLED" in con, "consolidation evolution loop wiring missing"; app=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipe-apply.ts")).read(); assert "invalidateRecipeIndexCache()" in app and "isJarvisAuthored" in app, "recipe-apply rails/cache-invalidate missing"'
  - name: F-TOT-DELIBERATE — pre-prompt ToT deliberation is turn-local + trace persists (U10)
    cmd: python3 -c 'import os; att=open(os.path.expanduser("~/src/tinkerclaw/src/agents/pi-embedded-runner/run/attempt.ts")).read(); assert "maybeRunThoughtSearch" in att and "preDeliberationSystemPromptText" in att, "attempt.ts deliberation wiring missing"; rr=open(os.path.expanduser("~/src/tinkerclaw/src/fork/reasoning-runtime.ts")).read(); assert "## Deliberation" in rr and "stashReasoningTrace" in rr, "reasoning-runtime producer missing"; hk=open(os.path.expanduser("~/src/tinkerclaw/src/fork/attempt-hooks.ts")).read(); assert "reasoning_tree_state" in hk and "consumeReasoningTrace" in hk, "trace persist-on-turn-complete missing"'
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
**Entry:** `extensions/tinkerclaw-prefrontal/src/recipe-rpcs.ts:handleKitInstall`
**Exit:** files written to `~/.openclaw/workspace/kits/<owner>/<slug>/`; caller receives `{ ok, installedPath, preflightResults, nextSteps }`.

```mermaid
sequenceDiagram
  participant CALLER as caller (Jarvis / TUI)
  participant KR as recipe-rpcs.ts
  participant JK as journeykits.ai API
  participant KS as RecipeStore (sandbox)
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

**See also:** lifecycles.md L-KIT-INSTALL; subagents-and-recipes.md §Kits.

---

## F-RECIPE-STATE. Recipe run → live recipe-state → RECIPES panel header

**Trigger:** caller invokes `prefrontal.recipe.run { kitRef, sessionKey, intent }` (the RECIPES-panel-backed kit execution path).
**Entry:** `extensions/tinkerclaw-prefrontal/recipe-rpcs.ts:"prefrontal.recipe.run"` → `recipe-runner.ts:runRecipe`
**Exit:** Tinker UI RECIPES panel paints the rich recipe header (recipeId + step M/N + parallelism cap + in-flight labels) from live data instead of the synthetic fallback plan.

**PRIOR GAP (fixed 18e618d241, FORK 2026-05-31):** the panel was dull because `runRecipe` NEVER emitted recipe-state — the rich header (`renderRecipeHeader`, panels.md) had no data source, so the panel always fell back to the synthetic 2-step "Thinking → Acting" plan. The fix wires the **producer** half: `runRecipe` now calls `onRecipeState` at kit start, on each parallel-group transition, and on completion.

```mermaid
sequenceDiagram
  participant CALLER as caller (Jarvis / TUI)
  participant KR as recipe-rpcs.ts (prefrontal.recipe.run)
  participant RUN as runRecipe (recipe-runner.ts)
  participant SR as fork.prefrontal.setRecipe (prefrontal-state-rpc.ts)
  participant EV as emitAgentEvent (lifecycle)
  participant TUI as Tinker UI (app.ts)
  participant PNL as RECIPES panel (prefrontal-tree.ts)

  CALLER->>KR: prefrontal.recipe.run {kitRef, sessionKey, intent}
  KR->>RUN: runRecipe({..., onRecipeState})
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

- The recipe-state emit is **best-effort, fire-and-forget**: `recipe-rpcs.ts` wraps the `callGateway` in `.catch(() => {})` and `runRecipe` wraps every `onRecipeState` call so observability NEVER throws into the execution loop. A dead/closed UI must not stall a run.
- `onRecipeState` is the PRODUCER seam (the half that was missing). The `RecipeStateUpdate` payload mirrors the `fork.prefrontal.setRecipe` param shape so `recipe-rpcs.ts` forwards it verbatim; progress fields are optional (the start emit may omit step detail).
- The lifecycle phase token is `prefrontal-recipe-state` (single owner of the emit: `src/fork/prefrontal-state-rpc.ts`; the UI gate keys on `p.data.phase === "prefrontal-recipe-state"`).
- The header data is **last-write-wins** in the UI: `currentRecipe` holds only the latest event, not a history.

**See also:** subagents-and-recipes.md §Kits (the parallel-group/runRecipe execution mechanism that GENERATES the transitions); panels.md (`renderRecipeHeader` render + RECIPES-panel fallback semantics); lifecycles.md L-STEP (per-step status barrier).

---

## F-RECIPE-EVOLVE. Episode complete → consolidation fitness → mutation self-apply → matcher re-reads (U1, J5+J13)

**Trigger:** the `engram-consolidate` cron fires `consolidate()` over the day's closed episodes; at least one episode carries a `recipe:<owner/slug>` attribution tag.
**Entry (producer of tags):** `extensions/tinkerclaw-prefrontal/recipe-runner.ts:runRecipe` stamps `recipe:<owner/slug>` via the `onTag` sink (wired by `prefrontal.recipe.run`) at run start + each task dispatch.
**Entry (loop):** `src/memory/engram/sleep-consolidation.ts:consolidate()` §3b (opt-in, only when `config.recipeEvolution` is injected).
**Exit:** for each `autoPromotable` proposal the on-disk recipe file is rewritten, the matcher's in-memory kit index is dropped, and the next turn's matcher re-scans the catalog with the new body + updated fitness boost.

```mermaid
sequenceDiagram
  participant RUN as runRecipe (recipe-runner.ts)
  participant ING as ingestion (recipe:<owner/slug> events)
  participant CRON as engram-consolidate cron
  participant CON as consolidate() §3b (sleep-consolidation.ts)
  participant FIT as recipe-fitness.ts (updateRecipeFitness)
  participant ARC as recipe-archive.ts (putVariant — never delete)
  participant EVO as recipe-evolution.ts (proposeMutations)
  participant GW as callGateway (loopback)
  participant APP as prefrontal.recipe.applyProposal (recipe-rpcs.ts)
  participant RA as applyMutationProposal (recipe-apply.ts)
  participant KS as RecipeStore (recipe .md on disk)
  participant CACHE as recipe-matcher.ts (invalidateRecipeIndexCache)
  participant MAT as matcher next turn (matchRecipesDetailed)

  RUN->>ING: onTag → recipe:<owner/slug> stamped on episode events
  Note over ING: attribution survives in the event log<br/>(recipe-fitness.attributeRecipe matches this exact tag)
  CRON->>CON: consolidate({recipeEvolution})
  loop for each attributed episode
    CON->>FIT: updateRecipeFitness(prior, episode, events) — Laplace-smoothed successRate
    CON->>ARC: putVariant(rid, version, body, fitness)
    CON->>EVO: proposeMutations(fitness, archive.history(rid), cfg)
    EVO-->>CON: MutationProposal[] (autoPromotable flag = isAutoPromotable)
  end
  Note over CON: every proposal → manifest entry (audit trail)<br/>regardless of the gate below
  alt RECIPE_AUTOAPPLY_ENABLED === "true" (live)
    loop for each autoPromotable proposal
      CON->>GW: callGateway prefrontal.recipe.applyProposal {recipeId, op, intent, rationale}
      Note over CON,GW: fire-and-forget + try/caught —<br/>consolidation never blocks/fails on apply
      GW->>APP: prefrontal.recipe.applyProposal
      APP->>RA: applyMutationProposal(input, deps)
      RA->>RA: Rail 2 isJarvisAuthored? (curated → skip)
      RA->>KS: Rail 3 snapshot(recipeId) → .recipe-archive/ (rollback net)
      RA->>RA: LLM rewrite → extractKitSpec → Rail 4 validateRecipeSpec
      RA->>KS: authorKit(spec) (authorship-guarded write, slug preserved)
      RA->>CACHE: invalidateRecipeIndexCache() — ONLY on successful apply
    end
  else gate off (tests/clones)
    Note over CON: proposals stay in the manifest for human review — no write
  end
  MAT->>KS: next turn re-scans catalog (index was dropped)
  MAT->>FIT: makeFitnessLookup(baseDir) → successRate boost folded into score
```

**Invariants:**

- **Attribution is explicit, never inferred.** `recipe-fitness.attributeRecipe` matches ONLY the literal `recipe:<owner/slug>` tag stamped by `recipe-runner.ts` `onTag`. No tag → no fitness update → no false attribution (`sleep-consolidation.ts:322` `continue`).
- **The archive never deletes.** `recipe-archive.putVariant` appends a versioned variant per consolidation pass; rollback is always possible. The apply path additionally snapshots the live body into `.recipe-archive/` (Rail 3) before any rewrite.
- **`autoPromotable` is the only auto-apply gate inside the loop**, AND the whole self-apply block is gated by `RECIPE_AUTOAPPLY_ENABLED === "true"` (strict equality — OFF in tests/clones; live in prod, see memory `Jarvis full-autonomy flags`). Every proposal lands in the manifest regardless, so the audit trail exists even when the apply is gated off.
- **`invalidateRecipeIndexCache()` fires only on a successful `authorKit`** (`recipe-apply.ts:208`) — a no-op/skip/reject never triggers a spurious catalog re-scan. Without this, an autonomous rewrite would only take effect after a process restart (or an unrelated dir-mtime bump).
- **Selection feedback closes the loop:** the matcher reads `makeFitnessLookup(engramBaseDir)` as the `feedback` arg into `matchRecipesDetailed` (`recipe-rpcs.ts:420`), so the just-updated `successRate` boosts the recipe's score on the next match. Precedence: base score → U1 fitness feedback → U12 rating tie-break (see config-shape.md scoreRecipe composition).
- **The rewrite is authorship-guarded** (Rail 2): `applyMutationProposal` refuses any recipe that is not `isJarvisAuthored` — hand-curated kits are never auto-mutated.

**State machines:** see lifecycles.md L-RECIPE / L-RECIPE-VARIANT (fitness/version transitions, archive lifecycle) — those are the single owner of the per-recipe state facts; this diagram owns only the call sequence.

**See also:** config-shape.md (`RECIPE_AUTOAPPLY_ENABLED` flag + scoreRecipe precedence + the 5 apply rails); subagents-and-recipes.md §Kits (`runRecipe`/`onTag` producer mechanics); failures.md (apply-failure → keep-original fallbacks).

---

## F-TOT-DELIBERATE. Pre-prompt Tree-of-Thoughts deliberation → turn-local prompt → trace persist (U10, J3↔J13)

**Trigger:** an interactive turn is about to call `activeSession.prompt(...)` AND `fork.cognitive.reasoning` config is `"tree"` or `"lats"` (default `"none"` → pure pass-through).
**Entry:** `src/agents/pi-embedded-runner/run/attempt.ts:~2783` (the pre-prompt deliberation block) → `src/fork/reasoning-runtime.ts:maybeRunThoughtSearch`.
**Exit:** the model runs THIS turn with a `## Deliberation` block folded into the system prompt; the search tree is persisted as a `reasoning_tree_state` MemoryEvent on turn complete; the base prompt is restored so nothing leaks into the next turn.

```mermaid
sequenceDiagram
  participant ATT as attempt.ts (turn body)
  participant RET as retrieval/reinject augmentation
  participant RR as maybeRunThoughtSearch (reasoning-runtime.ts)
  participant CFG as getReasoningMode (fork.cognitive.reasoning)
  participant GATE as shouldRunThoughtSearch
  participant RT as ReasoningRuntime.run (per-session registry)
  participant STASH as stashReasoningTrace (attempt-hooks.ts, by runId)
  participant SESS as activeSession (applySystemPromptOverride)
  participant MODEL as model (session.prompt)
  participant HOOK as onTurnComplete (attempt-hooks.ts)
  participant ES as eventStore.append

  Note over ATT,RET: retrieval-pack + reinject augment systemPromptText FIRST
  ATT->>ATT: preDeliberationSystemPromptText = systemPromptText (snapshot BEFORE deliberation)
  ATT->>RR: maybeRunThoughtSearch({sessionManager, systemPromptText, query, isAutomatedSession, runId})
  RR->>CFG: getReasoningMode() → none | tree | lats
  RR->>GATE: shouldRunThoughtSearch(query, mode, isAutomatedSession)
  alt mode==="none" OR automated session OR trivial query OR no runtime
    RR-->>ATT: returns systemPromptText UNCHANGED (pure pass-through)
  else mode is tree/lats and search-worthy
    RR->>RT: runtime.run(query, systemPromptText)
    RT-->>RR: {answer, trace}
    RR->>STASH: stashReasoningTrace(runId, trace) — best-effort, never breaks the turn
    RR-->>ATT: systemPromptText + "\n\n## Deliberation\n<answer>"
    ATT->>SESS: applySystemPromptOverrideToSession(turn-local augmented prompt)
    Note over ATT,SESS: TURN-LOCAL only. If a runtimeContext override is in play,<br/>re-derive runtimeSystemPrompt from the AUGMENTED base<br/>(bugfix — else this turn runs WITHOUT the deliberation).<br/>appliedTurnLocalOverride = true
  end
  ATT->>MODEL: activeSession.prompt(prompt[, images])
  MODEL-->>ATT: assistant turn
  ATT->>SESS: finally: if appliedTurnLocalOverride → restore preDeliberationSystemPromptText
  Note over ATT,SESS: restores the SNAPSHOT, not the mutated systemPromptText<br/>→ deliberation cannot leak into the next turn's base
  HOOK->>HOOK: onTurnComplete: consumeReasoningTrace(runId)
  alt trace was stashed this turn
    HOOK->>ES: eventStore.append({kind:"reasoning_tree_state", content:JSON(trace), importance:4})
  else no trace (default — ToT off)
    Note over HOOK: inert — no event written
  end
```

**Invariants:**

- **Default-off.** `getReasoningMode` returns `"none"` unless `fork.cognitive.reasoning ∈ {tree, lats}`; `maybeRunThoughtSearch` is then a pure identity on the system prompt. ToT is opt-in/expensive.
- **Deliberation runs AFTER retrieval/reinject augmentation** so the search sees the fully assembled context, then folds `## Deliberation` onto that augmented base.
- **Skips automated sessions.** `isAutomatedReasoningSession` is true for subagent/ACP/probe/`cron:`/`heartbeat`/`isolated:` keys and missing keys — a search before every cron tick is wasteful and risks recursive triggering.
- **TURN-LOCAL, leak-proof (BUGFIX, FORK U10).** `preDeliberationSystemPromptText` snapshots the TRUE base BEFORE the deliberation augments it; the `finally` restores that snapshot (gated on `appliedTurnLocalOverride`), NOT the mutated `systemPromptText`. The prior bug: when a `runtimeContext` override was present the session held `runtimeSystemPrompt` built from the pre-deliberation base, so either the deliberation never reached the model OR it leaked into the next turn — fixed by re-deriving `runtimeSystemPrompt` from the augmented base for the turn and restoring the captured pre-deliberation base in `finally`.
- **Trace persistence is producer→consumer by `runId`.** `maybeRunThoughtSearch` is the producer (`stashReasoningTrace(runId, trace)`); `onTurnComplete` is the consumer (`consumeReasoningTrace(runId)` → `reasoning_tree_state` MemoryEvent, `importance:4`). Both legs are best-effort try/caught — a stash/persist failure never breaks the turn. No trace stashed (the default) → consume path is inert, no event written.
- **NOT a fractal trigger.** The fractal/round-table escalation fires separately post-turn; the ToT deliberation is strictly pre-prompt and single-session.

**State machines:** see lifecycles.md L-REASONING (none→tree→lats tri-state + the per-turn apply/restore states) — the single owner of the reasoning-mode state facts; this diagram owns only the call sequence.

**See also:** config-shape.md (`fork.cognitive.reasoning` key + the `fork.reasoning.search` RPC that runs a model — do NOT add it to a verify block); memory-layout.md (`reasoning_tree_state` EventKind + importance ranking); failures.md (deliberation failure → pass-through).

---

## Auto-validation

Each diagram should be paired with an `[idle-timeout-diag]`-style probe that emits one log line per traversal. Today only F1 has this (the `idle-timeout-diag` line). Probes for F2–F7 are listed as proposed in `probes.md`.

## Update cadence

Refactor-driven. A flow diagram changes only when the call graph between named components changes. If you touch any of the file paths cited above, re-validate the diagram and bump `last_verified_commit`.
