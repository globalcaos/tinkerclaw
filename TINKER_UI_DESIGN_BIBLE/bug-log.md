---
file: bug-log.md
purpose: Historical bug-fix log — root causes, fixes, lessons. Reads like a forensic timeline.
audience: AI
last_verified: 2026-06-01
last_verified_commit: 18e618d241
single_owner: yes — past-bug forensics live here. Migrated from bible.md §7 on 2026-05-11.
see_also: failures.md (current failure-mode map by category — what to look for going forward), flows.md (pipelines whose disruption produced many of these bugs)
note: this is the original prose from bible.md §7, relocated verbatim. New bug fixes are appended here, not added to bible.md.
verify:
  - name: bug-log.md grows monotonically (or stays equal) — never shrinks unexpectedly
    cmd: python3 -c 'import os; n = sum(1 for _ in open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md"))); assert n >= 280, f"bug-log.md only {n} lines, did someone delete entries?"'
  - name: every FIXED entry has a root-cause line
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); fixes = re.findall(r"^### (?:FIXED(?:\s*\[[^\]]*\])?|~~FIXED): ", t, re.M); rcs = re.findall(r"^- \*\*Root cause", t, re.M); assert len(rcs) >= len(fixes) - 5, f"{len(fixes)} FIXED entries but only {len(rcs)} root-cause lines"'
  - name: failure-class taxonomy header is present
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); assert "## Failure-class taxonomy" in t, "taxonomy header missing"'
  - name: most FIXED entries are tagged with at least one failure class
    cmd: python3 -c 'import os,re; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md")).read(); total = len(re.findall(r"^### FIXED", t, re.M)); tagged = len(re.findall(r"^### FIXED \[[^\]]+\]:", t, re.M)); assert tagged >= total - 2, f"only {tagged}/{total} entries tagged — obsolete ones may be excluded but new entries should always be tagged"'
---

# Bug Fix Log

## 7. Bug Fix Log

## Failure-class taxonomy (added 2026-05-11)

Every entry below now carries one or more `[tag+tag]` chips after `FIXED`.
Tags let an AI scan for recurring patterns ("how many `auth-token` bugs
have we seen?") without re-reading each prose entry. When adding a new
fix, pick from this list — extend it only if no tag fits.

| Tag                   | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `auth-token`          | OAuth tokens — refresh, content-type, scope-downgrade, refresh-failed             |
| `auth-scope`          | Scope/permission gate dropped legitimate clients                                  |
| `billable-noop`       | A paid LLM turn fired that nobody consumes (skip-gate failed / was dead code)     |
| `bridge-leak`         | Cross-channel state bleed (real or suspected)                                     |
| `bundler-trap`        | tsdown/onlyBuiltDependencies/\_\_filename/native-deps wiped or misconfigured      |
| `cache-staleness`     | TTL not invalidated after dependent change                                        |
| `cleanup-race`        | Drain deadlock, orphan processes, stuck resurrection across restarts              |
| `config-dead-code`    | Config key looked live but didn't actually apply                                  |
| `crash-on-startup`    | Bad SDK call / missing artifact prevented plugin or gateway boot                  |
| `detection-pattern`   | Substring/regex/startsWith assumption broke under prefix change                   |
| `display-misclassify` | UI rendered system as user, error as raw object, etc.                             |
| `event-ordering`      | text_end before tail-recover, lifecycle dropped, race on stream state             |
| `lid-routing`         | WhatsApp LID rescue / sister-DM trigger class                                     |
| `merge-wipe`          | Upstream merge dropped fork code/config/scope (often combined with another)       |
| `outbound-drop`       | Outbound message lost / queued without delivery                                   |
| `plugin-load`         | Plugin failed to register — manifest missing field, wrong SDK call, name mismatch |
| `timeout-tuning`      | Idle watchdog / request timeout fired prematurely or wrongly                      |
| `ui-state-clear`      | File-watcher / event handler cleared UI state too aggressively                    |
| `workspace-shadow`    | workspace/ override of bundled/ with stale content                                |

**Recurring patterns visible from the chips:**

- `merge-wipe` shows up across `auth-scope`, `bundler-trap`, and standalone — the highest-leverage discipline gap.
- `ui-state-clear` repeats 7 times — clearing state on file-watch events without preserving error chips is a known anti-pattern.
- `event-ordering` repeats 7 times — async race conditions around stream lifecycle / button-state / session-resume.
- `auth-token` repeats 5 times — OAuth machinery is the largest single class of fragility.

### FIXED [billable-noop+config-dead-code]: G1 Hourly interval heartbeat fired a BILLABLE Opus turn every tick (2026-06-04)

- **Symptom:** The hourly interval heartbeat fired a full, billable Opus turn on every tick (`target:"none"` — nobody consumes the output). A self-poll meant to be a cheap no-op was costing one Opus turn per hour, silently, forever.
- **Root cause:** TWO independent skip-gates both failed open, so nothing stopped the LLM call. (a) `isHeartbeatContentEffectivelyEmpty` was defeated by `HEARTBEAT.md`'s trailing `## Related` link-footer — the boilerplate link block counted as "content", so the empty-content gate concluded there WAS something to say and let the turn run. (b) The task-due gate that should short-circuit a plain `reason:"interval"` poll when no task is actually due was dead code — it never returned the skip path, so an interval poll with nothing due still produced a prompt and ran the model.
- **Fix (commit `cd324209`):** (a) `stripTrailingRelatedFooter` + `isLinkOnlyBoilerplateLine` added in `src/auto-reply/heartbeat.ts` so a HEARTBEAT.md that is only a `## Related` link footer is correctly classified as effectively empty. (b) Re-implemented the task-due gate in `src/infra/heartbeat-runner.ts` `resolveHeartbeatRunPrompt`: a plain `reason:"interval"` poll with no due task now returns `prompt:null` → `{status:"skipped",reason:"no-tasks-due"}`, so NO LLM call is made. 53/53 tests pass.
- **Files:** `src/auto-reply/heartbeat.ts` (`stripTrailingRelatedFooter`, `isLinkOnlyBoilerplateLine`), `src/infra/heartbeat-runner.ts` (`resolveHeartbeatRunPrompt` task-due gate).
- **Rule:** any zero-consumer scheduled trigger (`target:"none"`) MUST resolve its skip decision and return `prompt:null` BEFORE the model is invoked — never let it fall through to a turn. Two skip-gates protecting the same hot path is fine, but each must fail CLOSED (skip), not open (run). Boilerplate link footers are not content. See `crons.md` for the heartbeat schedule and `failures.md` for the skip-gate map.

### FIXED [config-dead-code]: G2 Forensic store stayed empty — captureForensicDump reachable only via a dead export (2026-06-04)

- **Symptom:** The forensic map / `forensic.getLive*` RPCs returned `NO_DATA` even on active turns — the forensic store was always empty. (The separate anatomy treemap worked, which masked the gap: people assumed forensic data flowed because the anatomy view rendered.)
- **Root cause:** `captureForensicDump` (the function that snapshots the exact post-deliberation system-prompt bytes into the forensic store) was reachable ONLY through `emitPrePromptAnatomy()`, a DEAD export that nothing in the live turn path ever invoked. So the producer never fired → the store never filled → every `forensic.getLive*` read returned `NO_DATA`. The anatomy treemap renders because it is wired separately in `onTurnComplete`; only the forensic-dump producer was orphaned. A classic looked-live / never-invoked producer trap (sibling of the 2026-06-01 RECIPES-panel `setRecipe` bug).
- **Fix (commit `1f174c74`):** new `captureForensicDumpHook` in `src/fork/attempt-hooks.ts`, called from `src/agents/embedded-agent-runner/run/attempt.ts` immediately before `activeSession.prompt()` with the EXACT post-deliberation system-prompt bytes (request side); `finalizeForensicRun` wired into `onTurnComplete` for the response side. (RC2 — `forensic.summarize` rerouted to Anthropic Haiku — was already shipped separately.)
- **Files:** `src/fork/attempt-hooks.ts` (`captureForensicDumpHook`), `src/agents/embedded-agent-runner/run/attempt.ts` (call site before `prompt()`), `onTurnComplete` (`finalizeForensicRun`).
- **Rule:** if a store is empty in production, trace the PRODUCER to a real call site on the hot path — don't trust a sibling view (anatomy treemap) rendering as proof the data flows. An export invoked only by another dead export is dead. See `probes.md` for the forensic inspection RPCs and the META scaffold-but-unwired entry above.

### FIXED [event-ordering+display-misclassify]: G3 Lifecycle phase:"error" shipped without model/sessionKey identity → Tinker UI dropped it, indicator stuck (2026-06-04)

- **Symptom:** Errored / failed-over runs left the chat "thinking" indicator stuck and stacking ("multiple at once") — the run was never scheduled for deletion, so its spinner never cleared.
- **Root cause:** the terminal `phase:"error"` gateway lifecycle event shipped WITHOUT the identity fields (`model`/`sessionKey`/etc.) that `phase:"end"` carries. The Tinker UI gates its entire lifecycle handler on `p.data?.model` being present, so the identity-less error events were DROPPED on the floor → the existing 3s-debounced delete (which already handles both `end` and `error`) never received an error event for the run → the activeRuns entry persisted → the indicator stuck and, across successive failures, stacked.
- **Fix (commit `8e440e41`):** mirror the `phase:"end"` identity fields (`authProfileId`/`model`/`modelProvider`/`sessionKey`/`rateLimit`) onto the `phase:"error"` emit in `src/agents/embedded-agent-subscribe.handlers.lifecycle.ts`. With identity present, the UI handler no longer drops the event and the existing `app.ts` debounced delete clears the run. 52/52 tests pass. (This is the EMITTER half; the consumer-side self-heal is U4 below.)
- **Files:** `src/agents/embedded-agent-subscribe.handlers.lifecycle.ts` (`phase:"error"` emit).
- **Rule:** every TERMINAL lifecycle phase (`end` AND `error`) must carry the same identity payload — a consumer that gates on `model` will silently drop any terminal event missing it. Symmetry between `end` and `error` emits is the invariant. See `lifecycles.md` for the run lifecycle and `flows.md` for the lifecycle→UI event path.

### FIXED [ui-state-clear+event-ordering]: U1 MODELS glow / prefrontal froze after a session-view change — each switch site hand-rolled a drifting subset of indicator updates (2026-06-04)

- **Symptom:** Two related glitches on changing the viewed session: (a) under "session" budget scope the MODELS panel kept glowing (indicating activity) after a tab switch even though the newly-viewed session was idle; (b) the prefrontal tree froze showing "thinking" until a scope toggle forced a re-render.
- **Root cause:** every viewed-session-change site hand-rolled its OWN subset of the per-session indicator refreshes, and the subsets had drifted apart. `switchToTab` forgot `updateBudgetPanel()` (→ MODELS glow stale under "session" scope); `attachSessionToTab` forgot BOTH `updateBudgetPanel()` and `updatePrefrontalTree()` (→ prefrontal frozen on the old session's "thinking" state). No single source of truth for "what to refresh when the viewed session changes" meant new indicators were wired into some sites and not others.
- **Fix (tinker-ui/src/app.ts, HMR-live, committed develop `0bdb090c437`):** a single `refreshViewedSessionIndicators()` that calls the full set (`updateChat` + `updateBtn` + `updateSessionsPanel` + `updateBudgetPanel` + `updatePrefrontalTree`), invoked from BOTH `switchToTab` and `attachSessionToTab`. One function = no drift between switch sites.
- **Files:** `tinker-ui/src/app.ts` (`refreshViewedSessionIndicators`, `switchToTab`, `attachSessionToTab`). Task `task-mpkwez3k`.
- **Rule:** all per-viewed-session indicators must refresh through ONE function called at EVERY view-change site — never hand-roll a per-site subset, or the subsets drift and indicators freeze on stale sessions. See `tinker-ui.md` for the indicator inventory.

### FIXED [display-misclassify]: U2 Completed 3-section reply rendered as a plain thinking bubble with raw markers — splitter gated by POSITION not STRUCTURE (2026-06-04)

- **Symptom:** A completed bubble carrying the 3-section answer / amygdala / fractal structure, when it landed in a non-final message slot, rendered as a plain "thinking" bubble with the raw section markers showing instead of the formatted three-part layout.
- **Root cause:** `splitSectionedReply` was gated behind `!isThinking` — a POSITION-based test (is this the final slot?). A structurally-complete sectioned reply that happened NOT to be in the final slot was treated as still-thinking, so the splitter never ran and the raw markers leaked into the rendered bubble. Appearance was being decided by message position rather than message content.
- **Fix (tinker-ui/src/app.ts, HMR-live, committed develop `0bdb090c437`):** run the splitter UNCONDITIONALLY at both `renderMsg` detection sites — STRUCTURE decides appearance, not position. The split is content-local, so it cannot reintroduce the old "blinking" class (which was position-coupled).
- **Files:** `tinker-ui/src/app.ts` (both `renderMsg` section-detection sites). Task `task-mpwf4x8s`.
- **Rule:** how a bubble renders must be a pure function of its CONTENT (does it carry the section structure?), never of its position in `messages[]`. Position-gated rendering misclassifies any structurally-complete payload that isn't in the slot you assumed. See `tinker-ui.md` for the sectioned-reply layout.

### FIXED [ui-state-clear]: U3 Background tabs were born empty — only the active tab's transcript hydrated on connect (2026-06-04)

- **Symptom:** Restored attached tabs showed empty until you clicked into them — a background tab had no messages until `switchToTab` lazily fetched its transcript, so context "loaded only on switching".
- **Root cause:** tabs are born empty (`freshTabState` → `messages:[]`) and only the ACTIVE tab's transcript was fetched on connect. A background (restored, attached) tab only hydrated lazily via `switchToTab`→`loadChat`, so until you switched to it its `TabState` held no history.
- **Fix (tinker-ui/src/app.ts, HMR-live, committed develop `0bdb090c437`):** new `hydrateTab()` proactively fetches each restored attached tab's `chat.history` into its OWN `TabState` on connect, batched via `Promise.allSettled` so one slow/failed tab doesn't block the others.
- **Files:** `tinker-ui/src/app.ts` (`hydrateTab`, connect path). Task `task-mppceqsu`.
- **Rule:** restored multi-tab state must hydrate EVERY attached tab's transcript on connect, not just the active one — lazy per-switch hydration leaves background tabs blank and loses cross-tab context. Batch with `allSettled` so a single failure is isolated. See `tinker-ui.md` for tab/session attachment.

### FIXED [event-ordering+ui-state-clear]: U4 Chat thinking indicator vanished mid-stream — activeRuns entry created only by lifecycle:start, never re-created by a live delta (2026-06-04)

- **Symptom:** The chat thinking indicator disappeared while Jarvis was still streaming — the spinner vanished even though deltas were still arriving for the viewed session.
- **Root cause:** the `activeRuns` entry is created ONLY by lifecycle `phase:start`; the live chat-delta handler READ that entry but never re-created a missing one. If `activeRuns` was emptied while the model was still streaming — a premature/early `lifecycle:end`, or the 3s debounce racing a slow next delta — the indicator had no entry to render and silently vanished. (Pairs with G3: G3 fixed the EMITTER dropping terminal events; U4 hardens the CONSUMER against an entry going missing mid-stream.)
- **Fix (tinker-ui/src/app.ts, HMR-live, committed develop `0bdb090c437`):** delta SELF-HEAL — a delta for the viewed session with NO `activeRuns` entry is authoritative proof of life, so the handler re-creates a minimal entry and resumes the tick. (Per `done-signals.md` R1, an authoritative live signal supersedes an advisory one; there is no UI stale-run watchdog, so `done-signals.md` R2 still holds — nothing else will spuriously revive a genuinely-finished run.)
- **Files:** `tinker-ui/src/app.ts` (chat-delta handler self-heal). Task `task-mpr2cego`.
- **Rule:** a live data delta is authoritative proof the run is alive and must be able to RE-CREATE the indicator state, not merely read it — never let an advisory lifecycle event (or a debounce race) leave the consumer with no entry to render while data still flows. See `done-signals.md` R1/R2 for the authoritative-vs-advisory rule.

### FIXED [event-ordering+display-misclassify]: U5 Queued prompt bubble rendered in the MIDDLE of the still-streaming answer (2026-06-04)

- **Symptom:** A prompt queued mid-turn rendered its user bubble in the middle of the last answer — the queued bubble appeared above the streaming turn's later continuation/tool bubbles. A hard refresh fixed it (the server returns correct chronological order).
- **Root cause:** the queued prompt's user bubble was pushed to the END of `messages[]`, but the still-streaming turn ALSO pushes its own continuation/tool bubbles to the end as they arrive → those landed AFTER the queued bubble, so the queued prompt appeared mid-answer. Note on server behavior: cc-bridge `worker.ts` genuinely QUEUES a mid-turn send (`turnQueue` → `drainQueue` = a separate NEXT turn) — it does NOT steer or blend into the running turn — so the queued bubble truly belongs AFTER the current turn finishes, not interleaved into it.
- **Fix (tinker-ui/src/app.ts, HMR-live, committed develop `0bdb090c437`):** a `pendingQueuedSends` buffer holds the queued bubble OUT of `messages[]` and renders it as a TRAILING bubble; on turn-final it is flushed into `messages[]` in correct chronological order (after the completed turn's bubbles). True mid-turn steer/blend is deferred — it depends on claude-cli headless input injection.
- **Files:** `tinker-ui/src/app.ts` (`pendingQueuedSends` buffer, trailing-bubble render, turn-final flush). Task `task-mpwfiot2`.
- **Rule:** a mid-turn-queued user prompt must be held OUT of the shared `messages[]` array (rendered as a trailing bubble) until the running turn finalizes — appending it eagerly races the streaming turn's own end-pushed bubbles and misorders the transcript. See `tool-loop.md` for the cc-bridge `turnQueue`/`drainQueue` next-turn semantics.

### FIXED [event-ordering+config-dead-code]: U10 ToT deliberation never applied for the current turn AND leaked into the next — runtimeContext-override path (2026-06-02)

- **Symptom:** With the U10 Tree-of-Thoughts reasoning lane enabled (`fork.cognitive.reasoning` mode `tree`/`lats`), a turn that ALSO carried a `runtimeContext` override behaved two ways wrong at once: (a) the freshly-computed `## Deliberation` block never reached the model for the turn that triggered the search, and (b) once the search HAD augmented the prompt, the augmentation leaked into every subsequent turn's base system prompt. Hard to see in tests because the unit suite exercised `maybeRunThoughtSearch` in isolation, not the runtimeContext-override branch in `attempt.ts`.
- **Root cause:** in `attempt.ts` the prompt path is: build `runtimeSystemPrompt` from the base, install it on the session, THEN call `maybeRunThoughtSearch` which returns a deliberation-augmented `turnSystemPromptText`. Two distinct defects in the original wiring: (1) **never applied this turn** — when a runtimeContext override was present the session was holding `runtimeSystemPrompt`, which had been composed from the PRE-deliberation base; the augmented `turnSystemPromptText` was computed but nothing re-installed it onto the session, so the model ran the turn WITHOUT the `## Deliberation` block (the whole point of the search). (2) **leaked into the next turn** — the augmentation was written back onto the outer `systemPromptText`, and the `finally` restore (which re-applies whatever `systemPromptText` currently holds) therefore restored the AUGMENTED prompt as the base, so the one-shot deliberation became sticky and contaminated later turns. The two failures are the same off-by-one ownership mistake: turn-local state was being threaded through the variable that owns cross-turn base state.
- **Fix (commit `06f8647fdc`):** make the deliberation strictly turn-local. (a) Snapshot the true base into `preDeliberationSystemPromptText` BEFORE the search augments anything — re-snapshotted once AFTER the mid-context persona reinject hook (whose mutation is _meant_ to persist), so the snapshot tracks persona-reinject but excludes deliberation. (b) Keep the search result in a local `turnSystemPromptText` and DO NOT reassign the outer `systemPromptText`. (c) When a runtimeContext override is in play, re-derive the runtime prompt from the AUGMENTED base (`composeSystemPromptWithHookContext({baseSystemPrompt: turnSystemPromptText, …})`) and `applySystemPromptOverrideToSession` it, so the turn actually carries the deliberation; otherwise apply `turnSystemPromptText` directly. (d) Set `appliedTurnLocalOverride` and, in `finally`, restore `preDeliberationSystemPromptText` (the TRUE base) rather than the mutated `systemPromptText`.
- **File:** `src/agents/embedded-agent-runner/run/attempt.ts` (prompt-submission branch ~L2742-2862: `preDeliberationSystemPromptText` snapshot + `turnSystemPromptText` local + turn-local re-apply + `finally` restore).
- **Rule:** a per-turn system-prompt augmentation (deliberation, retrieval pack, one-shot context) must live in a turn-scoped local and be re-installed onto the session for that turn; the `finally` restore must target a snapshot of the TRUE cross-turn base captured BEFORE the augmentation, never the working variable the augmentation mutated. Threading turn-local content through the cross-turn base variable fails BOTH directions at once — drops it this turn (if a later compose re-derives from the stale base) and leaks it next turn (via the restore). See `lifecycles.md` for the deliberation turn lifecycle and `config-shape.md#fork.cognitive.reasoning`.

### META [config-dead-code]: scaffold-but-unwired PRODUCER trap — 6 of 12 OSS-harness upgrades were inert with green unit tests (2026-06-02)

- **Symptom:** The first implementation pass of the 12 OSS-harness upgrades (U1–U12, roadmap `docs/notes/2026-05-30-papers-coverage-and-oss-roadmap.md` Part 3 in jarvis-icu) merged with every unit test green, yet six upgrades did NOTHING at runtime: U1 recipe-evolution (fitness never fed back into selection), U6/U4 skill-library + strategy-switch (never invoked by the consolidation cron), U9 A-MEM links (never extracted/indexed), U10 reasoning trace (never stashed), U12 marketplace rating (never composed into scoring). Consumers were fully wired and tested; the things that were supposed to FEED them were left as "handoff notes" to wire later.
- **Root cause:** the pass wired every CONSUMER (the function that reads the signal) but left the PRODUCER injections as TODO-shaped prose instead of real call-site wiring: `onTag` recipe-attribution into `runRecipe`, `setLinkBuilderRuntime` at the session-setup site, `stashReasoningTrace` in `onTurnComplete`, the engram-consolidate cron's skill/strategy dependency injections, and the `makeFitnessLookup`/`makeRatingLookup` feedback threaded into `matchRecipesDetailed`/`scoreRecipe`. A unit test mocks the producer's output and asserts the consumer behaves — so the consumer suite stays green whether or not the producer ever fires in production. The dead code looked live (the config keys existed, the RPCs returned `ok:true` against empty stores) which masked it further — a `config-dead-code` instance at integration scale.
- **Fix (commit `06f8647fdc`, on `70ad58e45d`):** wire each producer at a REAL call site and verify it fires there, not just that the consumer is reachable. Confirmed live producers: `recipe-runner.ts` stamps `recipe:<owner/slug>` via `onTag` (threaded from `prefrontal.recipe.run`); `setLinkBuilderRuntime` registered beside `setIngestionRuntime` at `src/agents/embedded-agent-runner/extensions.ts:179` with `extractAndIndex` fire-and-forget in `onTurnComplete`; `stashReasoningTrace` + `reasoning_tree_state` persisted in `onTurnComplete`; skill-library + strategy-switch injected into the engram-consolidate cron; `makeFitnessLookup`/`makeRatingLookup` composed into kit selection (precedence base → feedback → rating). Caught by adversarial review of the integration, NOT by the unit suite. Three upgrades remain honestly-inert-by-design and are registered as dead-code traps in `config-shape.md`: U2 2c LoRA (external stub), U8 Mem0 reconciliation (dark-launched behind `ENGRAM_RECONCILE`, default OFF), and U7 7D/7G (degrade to no-op until gateway RPCs `agent.getBillingState` + `plugins.getOrchestrator` exist).
- **Lesson:** a green unit test proves the consumer handles a signal; it says NOTHING about whether the producer emits that signal in production. For any producer→consumer wiring, the verification is "trace the producer to a real call site on the hot path and confirm it fires" — exactly the discipline that caught the 2026-06-01 RECIPES-panel bug (consumer render path looked live, producer `setRecipe` was never called) and the 2026-05-30 W3 subagent-color bug (renderer wired, `_subagentId` producer never set + the `:subagent:` event guard dropped the deltas). Three of a kind now: never trust "data already flows, just surface it"; verify the emit. See `design-principles.md` (split-of-concerns / producer-consumer invariant) and the two sibling entries below.

### FIXED [event-ordering+config-dead-code]: RECIPES panel showed only Thinking→Acting — recipe-runner never emitted recipe-state (2026-06-01)

- **Symptom:** The RECIPES panel was dull — it only ever rendered the synthetic 2-step "Thinking → Acting" plan, never the rich recipe header (named recipe, groups, composition). A prior handoff had assumed the data already flowed and "just needs surfacing" in the UI.
- **Root cause:** the rich recipe header (`renderRecipeHeader`) reads `currentRecipe`, which is populated only by `prefrontal-recipe-state` lifecycle events. Those events are emitted only when something calls `fork.prefrontal.setRecipe`. The recipe-runner (`runRecipe` in `extensions/tinkerclaw-prefrontal/recipe-runner.ts`) NEVER called it → `currentRecipe` stayed empty → `renderRecipeHeader` had no data source → the panel fell back to the synthetic 2-step plan. The handoff's premise ("data already flows, just surface it") was FALSE for the header — verifying the PRODUCER side caught it. Classic event-ordering (a lifecycle event the consumer depends on was never emitted) compounded with config-dead-code (the rich-header render path looked live but had no upstream data source).
- **Fix (commit `18e618d241`):** wired an `onRecipeState` sink into `runRecipe` that emits at recipe start / each group / composition → `setRecipe`, so `prefrontal-recipe-state` now actually fires. Added a decision-trail provenance chip + structured trail payload, recipe-apply/reject events, and a per-subagent task entry.
- **Secondary (semantic lane was DOUBLY inert):** recipe semantic matching never ran because three independent breakages stacked: (1) `/v1/embeddings` returned 404 (the route was gated off), (2) the `mxbai-embed-large` model was never pulled, and (3) the ollama models dir lived on an NTFS drive the `ollama` service user couldn't write to. Fix: an internal `fork.prefrontal.embed` RPC (bypasses the gated HTTP route) + the ollama models-dir made group-writable via fstab `gid=998`.
- **Files:** `extensions/tinkerclaw-prefrontal/recipe-runner.ts` (`runRecipe` `onRecipeState` sink).
- **Lesson:** verify the PRODUCER actually emits before trusting a "data is hidden, just surface it" premise. A consumer-side render path that looks live is worthless if nothing upstream ever feeds it. See `subagents-and-recipes.md` for the recipe/kit RPC contract.

### FIXED [config-dead-code+ui-state-clear]: Today card DnD trigger on invisible grip — clicks silently ate as drag-no-ops (2026-05-23)

- **Symptom:** Drag-and-drop in the Today card surface didn't work reliably — and after the pointer-event rewrite went in, ordinary clicks on a task row (to expand the drawer) sometimes did nothing. The user's mental model was "I'm trying to grab the task; nothing happens."
- **Root cause #1 (visible grip vs invisible hit-target):** the pre-rewrite implementation showed a `⋮⋮` grip on each task row but only that 6px-wide column was draggable; users dragging anywhere else on the row got nothing because pointerdown didn't even register as a drag intent.
- **Root cause #2 (click vs drag conflict after rewrite):** once we widened the pointerdown surface to the whole `.exec-task-head`, every click on the row was being interpreted as the start of a drag. With no threshold to distinguish movement from a tap, pointerup never reached the click handler that toggles the drawer — the DnD takeover silently stole every click.
- **Fix (commits `7b91d26a6a`, `c0ebbf6b8b`, `ce1da137bf`):** (a) replaced the visible `⋮⋮` grip with `cursor: grab` on the whole row and widened the pointerdown trigger to `.exec-task-head` / `.exec-group-header` / `.exec-subgroup-header`, excluding interactive children (buttons, chips, `<input>`, `<textarea>`); (b) introduced `DRAG_START_THRESHOLD_PX = 4` — pointermove crossing the threshold commits to a drag, pointerup before the threshold fires the click handler manually (toggling expand/collapse).
- **Files:** `tinker-ui/src/app.ts` (pointer-event DnD handlers).
- **Don't regress:** if you ever change the trigger surface, keep the interactive-children exclusion (buttons/chips/inputs) AND keep the threshold. Without both, clicks die silently. See `tinker-ui.md` §5.68.

### FIXED [config-dead-code]: priority_rank INTEGER collisions via midpoint arithmetic (2026-05-23)

- **Symptom:** User: "I am not able to move tasks properly within the same group. They seem to not want to get in the order I want." Dragging a task within the same axis worked sometimes and produced arbitrary order other times.
- **Root cause:** `task.priority_rank` is `INTEGER`. The Today-card DnD commit used midpoint arithmetic `(prevRank + nextRank) / 2` to compute the dropped task's new rank. Midpoint of two ints often produces a float that truncates back to an existing rank when stored, so over a few reorders adjacent tasks share the same integer rank and SQLite's sort becomes undefined. Live data confirmed the diagnosis before this fix: `ventures` had 21 tasks at `rank=30` and 17 at `rank=40`; `house-upgrades` had 5 at `rank=0`.
- **Fix (commit `76df31f68d`):** on every drop, instead of one `tasks.update` with a midpoint rank, the client walks the destination axis container in DOM order (treating the drop indicator as the dragged task's new position, skipping the source row), produces an `orderedIds[]` list, and fires parallel `tasks.update` RPCs renumbering every task in the axis with `rank = (index + 1) * 100`. ~50 tasks complete in well under a second. Spacing 100 is the visible-order spacing, not a collision-window — since we renumber on every drop, no collision can accumulate.
- **A one-shot offline `/tmp/renumber-ranks.py`** cleaned the 60 currently-open tasks across 7 axes to spacing-of-100 BEFORE the on-drop renumber commit landed; the commit prevents future collisions.
- **Files:** `tinker-ui/src/app.ts` (DnD commit path).
- **Don't regress:** never reintroduce midpoint arithmetic on INTEGER ranks. If you need single-RPC ordering, change the column type to REAL. See `failures.md` M11.

### FIXED [display-misclassify]: Sessions list rendering "Tinker UI" as every session's label (2026-05-23)

- **Symptom:** The right-panel sessions list showed "Tinker UI" as the label of every chat-originated session — multiple stale rows, plus a phantom row sitting above the actual main session after `/clear` rotated it to a `tinker:<ts>` key.
- **Root cause:** the Tinker UI WS-client connects with `client.displayName = "Tinker UI"` (`tinker-ui/src/app.ts:1211`) for pairing + security audit. That string was inheriting into every chat-originated session's `origin.label`, and the displayName resolver in `src/gateway/session-utils.ts` was falling through to it (`entry.displayName ?? buildGroupDisplayName ?? entry.label ?? originLabel`). Result: every session created after the Tinker UI started identifying itself as "Tinker UI" carried that string as its server-resolved displayName.
- **Fix (commits `cd0ad59239`, `c438842cef`, `54268a94d4`):** two-part, paired. (a) Server-side `GENERIC_WS_CLIENT_LABELS = {"Tinker UI", "webchat-ui", "openclaw-cli"}` set filters both `entry.displayName` and `originLabel` before they participate in the resolver chain; meaningful origin labels (`"jarvis-inject"`, group titles via `buildGroupDisplayName`) pass through unchanged. (b) Client-side `renderSessionRow` mirrors the same set as a defensive backstop and resolves in order: `tab.title` (with prefix-tolerant `sessionKeyMatches`) → server `s.label` (generic-filtered) → server `s.displayName` (generic-filtered) → key-derived `shortLabel`.
- **Verified:** 6 sessions that previously resolved to `displayName="Tinker UI"` now resolve to `displayName=""`; new sessions inherit the fix automatically.
- **Files:** `src/gateway/session-utils.ts`, `tinker-ui/src/app.ts`.
- **Don't regress:** keep the server-side and client-side `GENERIC_WS_CLIENT_LABELS` sets in lockstep. Adding a new WS-client identifier to one side without the other reintroduces the leak. See `tinker-ui.md` §5.69.

### FIXED [crash-on-startup+plugin-load]: Schema-migration ordering — CREATE INDEX before ALTER TABLE (2026-05-22)

- **Symptom:** After the v3.5 task_axis hierarchy migration landed, every `control-panel.*` RPC returned `unknown method`. The plugin appeared to vanish from the running gateway with no obvious user-visible error.
- **Root cause:** `schema.{sql,ts}` ran `CREATE INDEX IF NOT EXISTS task_axis_parent ON task_axis(parent_id)` via `db.exec(CONTROL_PANEL_SCHEMA_SQL)` at boot, BEFORE the `addAxisParentIdColumn` migration added the `parent_id` column. On any existing v3.3 DB (where `task_axis` lacked `parent_id`), the CREATE INDEX threw `SqliteError: no such column: parent_id` and crashed plugin registration. The loader silently re-registered several times after the initial failure, but those re-registrations landed AFTER the HTTP server started listening, so the RPC routing table never picked them up.
- **Fix (commit `e60c1f45c9`):** drop the offending `CREATE INDEX` from `schema.{sql,ts}` entirely; document why in a comment block. The index is created inside `addAxisParentIdColumn` (idempotent with `IF NOT EXISTS`) AFTER the column ALTER. Fresh DBs get the column from `CREATE TABLE` → migration ALTER is no-op → CREATE INDEX runs. Existing DBs: `CREATE TABLE IF NOT EXISTS` no-op → ALTER adds column → CREATE INDEX builds on the now-present column.
- **Prevention:** new regression test in `db.test.ts` ("getDb() boot path on a pre-v3.5 DB") seeds a tmpdir with v3.3-shaped task_axis (no `parent_id`), then calls `getDb()` which runs schema.exec + migrations in real boot order. Two tests: must not throw + `parent_id` added + rows preserved; must end with `task_axis_parent` index present. 4 PASS in 380ms.
- **Files:** `extensions/tinkerclaw-control-panel/src/store/{schema.sql,schema.ts,db.ts,db.test.ts}`.
- **Rule:** indexes that depend on newly-added columns ALWAYS live in the migration that adds the column, never in `schema.{sql,ts}`. Schema files describe final state; migrations describe transitions. Mixing them produces an unrecoverable boot crash on any pre-migration DB. See `failures.md` M12.

### FIXED [plugin-load+merge-wipe]: Plugin-SDK export drift — new subpath ships without manifest entry (2026-05-21)

- **Symptom:** Gateway crashed with `EPIPE` at 15:39, systemd restarted it, and the now-cold module cache hit a missing `dist/plugin-sdk/provider-config-overlay.js`. cc-bridge plugin failed to load → Tinker UI and WhatsApp DM both went silent simultaneously because no LLM worker route was registered. Orphaned worker PID 19196 survived (bounded by the 0e475ba6 worker-pool-leak fix) but unreachable.
- **Root cause:** `src/plugin-sdk/provider-config-overlay.ts` had existed since `566bf478a6` (2026-05-10) and `extensions/tinkerclaw-cc-bridge/index.ts` imported it via `openclaw/plugin-sdk/provider-config-overlay`, but the entry was missing from BOTH `scripts/lib/plugin-sdk-entrypoints.json` (the tsdown subpath manifest) AND the `./plugin-sdk/provider-config-overlay` entry in `package.json#exports`. tsdown therefore never built the dist artifact. Production `NODE_ENV=production` (systemd) prefers `dist/` over source via `root-alias.cjs`, so the resolver fell through to a synthesised `.../root-alias.cjs/provider-config-overlay` path that does not exist, and Node threw `ERR_MODULE_NOT_FOUND` on every plugin reload.
- **Fix (commit `e065bc94f5`):** add `provider-config-overlay` to `scripts/lib/plugin-sdk-entrypoints.json` and regenerate `package.json#exports` via `pnpm plugin-sdk:sync-exports`. Verified after rebuild + restart: `chat.send` runId returned `result_text=ALIVE` in 3.4s; `openclaw plugins list` shows `@globalcaos/cc-bridge` as `status=enabled`.
- **Prevention (commit `0b5c17f614`):** pre-push **Gate 4** (FORK 2026-05-21) installs `pnpm lint:plugins:plugin-sdk-subpaths-exported` (src→manifest drift) + `pnpm plugin-sdk:check-exports` (manifest→`package.json#exports` drift). Both checks were available as `pnpm` scripts before, but no pre-push hook was installed at all (`.git/hooks/` was empty), so they were never enforced on push. Bypass for intentional WIP: `SDK_EXPORTS_GUARD=off git push`.
- **Files:** `package.json` (exports), `scripts/lib/plugin-sdk-entrypoints.json`, `git-hooks/pre-push` (Gate 4).
- **Rule:** never add a new `src/plugin-sdk/*.ts` file without also adding its entry to the manifest AND regenerating `package.json#exports` in the same commit. Gate 4 will block the push otherwise. See `failures.md` M13.

### FIXED [merge-wipe+type-gap]: Full build red — CompactionEntry.tokensAfter not in upstream type (2026-05-16)

- **Symptom:** `pnpm build` (and the pre-push hook chain) failed at `build:plugin-sdk:dts` with `src/gateway/session-utils.fs.ts(152): error TS2339: Property 'tokensAfter' does not exist on type 'CompactionEntry<unknown>'`. The gateway runtime was unaffected, so it went unnoticed until the full build was exercised.
- **Root cause:** Commit `962b1622fd` (2026-04-29, compaction-visibility / Bible §5.80) made compaction a visible event — `session-utils.fs.ts` reads `entry.summary` / `entry.tokensBefore` / `entry.tokensAfter` off the JSONL `type:"compaction"` entry to render the UI banner's "before → after tok" diff. The fork's compaction writer (`src/agents/embedded-agent-runner/compaction-hooks.ts:274`) genuinely persists `tokensAfter`, but upstream `@mariozechner/pi-coding-agent`'s `CompactionEntry<T>` (`core/session-manager.d.ts:36`) only declares `summary` + `tokensBefore` — not `tokensAfter`. esbuild/tsdown skips typecheck (runtime fine); only the strict `tsgo` dts build caught the gap. Only `tokensAfter` errored because `summary`/`tokensBefore` ARE in the upstream type.
- **Fix:** Declaration-merge `interface CompactionEntry<T = unknown> { tokensAfter?: number }` into `src/types/pi-coding-agent.d.ts` — the fork's existing augmentation home for that module (same pattern as the `Skill.source` augmentation already there; the dts tsconfig includes `src/types/**/*.d.ts`). Optional because pre-962b1622fd JSONL entries lack the field and the read site already guards with `typeof === "number" && Number.isFinite(...)`.
- **Files:** `src/types/pi-coding-agent.d.ts`
- **Prevention:** the compiler + the `build:plugin-sdk:dts` step in the pre-push gate IS the regression guard — a redundant grep-verify would be gold-plating. If the augmentation is ever removed the same TS2339 returns and blocks the build/push.
- **Rule:** After an upstream merge, fork code that reads fork-written-but-upstream-unmodeled fields off shared types belongs in `src/types/*.d.ts` declaration merges, not silent `as` casts. Runtime-green ≠ build-green: esbuild doesn't typecheck; always exercise the full `pnpm build` (or trust the pre-push dts step) before calling a type-touching change done.

### FIXED [cache-staleness]: Usage Bars Showing Stale Data from Disabled OAuth Endpoint (2026-04-03)

- **Symptom:** Anthropic 5h/7d usage bars showed stale or zeroed data regardless of actual usage. The bars hadn't updated since January 2026.
- **Root cause:** The `api.anthropic.com/api/oauth/usage` endpoint was disabled by Anthropic in January 2026. The budget-panel extension was silently failing to fetch usage data — returning null, which rendered as disconnected bars. No alternative data source existed.
- **Fix:** Rate limit headers (`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`) piggybacked on every API call via custom fetch wrapper in `anthropic-vertex-stream.ts`. Bars now update live on every LLM response with no additional API calls. See §5.53.
- **Files:** `anthropic-vertex-stream.ts`, `ratelimit-store.ts`, `attempt-hooks.ts`, `app.ts`

### FIXED [auth-scope+merge-wipe]: Tinker UI Missing Operator Scopes After Upstream Merge (2026-04-03)

- **Symptom:** Usage graphs not loading, session list empty, chat send failing, provider health unavailable — all silently after the 2026-03-30 upstream merge.
- **Root cause:** Upstream's stricter scope gate in `isOperatorUiClient()` didn't include `webchat-ui` (Tinker's client identity). WS connections downgraded to unprivileged scope.
- **Fix:** Added `webchat-ui` to `isOperatorUiClient()`. See §5.54.
- **Files:** `src/gateway/server-ws.ts`, `merge-guardian.sh`

### FIXED [display-misclassify+detection-pattern]: Fractal Prompts Appearing as User Messages in Chat (2026-04-03)

- **Symptom:** FRACTAL REFLECTION system prompts appeared as blue user chat bubbles in Tinker UI, making it look like the user had sent a multi-paragraph system message.
- **Root cause:** `startsWith("# FRACTAL REFLECTION")` detection failed when the WhatsApp gateway-connected system event was prepended to the same message string. The reflection header was no longer the first character.
- **Fix:** Changed to `includes("# FRACTAL REFLECTION")`. See §5.55.
- **Files:** `app.ts`, `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts`

### FIXED [crash-on-startup]: Gateway Crash Loop — Missing dist/index.js (2026-03-26)

- **Symptom:** Gateway systemd service in crash loop (85+ restarts, ~5s interval). Jarvis fully offline — no WhatsApp, no webchat, no LLM sessions. Tinker UI disconnected.
- **Root cause:** `dist/index.js` (gateway entry point) was missing — the entire `dist/` directory was empty. Node threw `MODULE_NOT_FOUND` on every startup attempt. Likely caused by an interrupted build or merge that cleared `dist/` without completing the write.
- **Fix:** Cleared stale caches (`dist/.cache`, `node_modules/.cache`) and rebuilt with `pnpm build`. Restarted gateway with `openclaw-restart` (SIGUSR1, 1s recovery).
- **Rule:** After any build failure or upstream merge, verify `dist/index.js` exists before restarting. Consider adding a pre-start guard to the systemd unit and a `dist/index.js` check to `merge-guardian.sh`.

### FIXED [workspace-shadow+plugin-load]: WhatsApp Plugin Runtime Unavailable — Two Layered Failures (2026-03-21)

- **Symptom:** Every message in Tinker UI returns `WhatsApp plugin runtime is unavailable`. Two distinct errors surfaced sequentially.
- **Root cause 1 — stale workspace shadow:** `~/.openclaw/workspace/extensions/whatsapp/` was a 15-day-old copy (from 2026-03-06 workspace sync) that overrode the freshly-merged bundled version. It lacked `light-runtime-api.ts` and `runtime-api.ts` introduced by upstream commit `30a94dfd3`. Workspace extensions (rank 1) override bundled (rank 3) by design.
- **Root cause 2 — boundary discovery gap:** After removing the workspace copy, the runtime boundary's independent `loadPluginManifestRegistry()` call (no `workspaceDir`, different cache key than startup) only found 46/85 plugins. WhatsApp is an optional bundled cluster excluded from tsdown build — no `dist/extensions/whatsapp/` entry exists. The boundary's discovery silently dropped it.
- **Fix 1:** Removed stale `~/.openclaw/workspace/extensions/whatsapp/`.
- **Fix 2:** Added `OPENCLAW_BUNDLED_PLUGINS_DIR=~/src/tinkerclaw/extensions` to `~/.config/systemd/user/openclaw-gateway.service`. This upstream-supported env var bypasses auto-detection and ensures the boundary discovers all source extensions including optional clusters.

### FIXED [ui-state-clear]: Auth Error Badge Not Seeded for Dead OAuth Tokens (2026-03-21)

- **Symptom:** When an OAuth profile (cli-sv, cli-gm) had a dead/expired token, the models panel showed disconnected dashed bars but no clickable error badge. Users couldn't trigger re-auth because there was nothing to click.
- **Root cause:** `loadBudget()` only seeded error badges from `config.models` `disabledReason` (billing/cooldown). Dead tokens returned null from the usage API, but null was treated as "disconnected" (dashed bars) without also setting a `providerErrors` entry.
- **Fix:** `loadBudget()` now seeds a clickable `AUTH ERROR` badge in `providerErrors` for any OAuth profile (`cli-*`) where the budget API returns null usage data. The badge gets the `auth-clickable` class, enabling the reload/re-auth popover.
- **File:** `tinker-ui/src/app.ts` (`loadBudget`)

### FIXED [auth-token]: OAuth Re-Auth Token Exchange Wrong Content-Type (2026-03-21)

- **Symptom:** In-UI re-authentication flow completed (popup captured code) but token exchange returned an error from Anthropic's token endpoint.
- **Root cause:** `exchangeCodeForTokens()` in `extensions/auth-reload/reauth.ts` sent `Content-Type: application/json` with a JSON body, but Anthropic's `/v1/oauth/token` endpoint requires `application/x-www-form-urlencoded`. Also missing `state` parameter in the exchange request.
- **Fix:** Changed Content-Type to `application/x-www-form-urlencoded` with `URLSearchParams` body encoding. Added `state` parameter. Improved code parsing to accept three formats: `code#state` (auto-capture redirect fragment), bare authorization code, or full callback URL with `?code=` query param.
- **File:** `extensions/auth-reload/reauth.ts` (`exchangeCodeForTokens`)

### FIXED [display-misclassify]: Auth Flow Errors Showing [object Object] (2026-03-21)

- **Symptom:** When auth reload, re-auth start, or token exchange failed, the toast notification showed `[object Object]` instead of a human-readable error message.
- **Root cause:** Catch blocks in all three auth flow handlers string-coerced the raw gateway error object (which is `{ error: "message" }`) instead of extracting the message field.
- **Fix:** All auth flow catch blocks now extract `err.message || err.error` before displaying in toast.
- **File:** `tinker-ui/src/app.ts` (3 catch blocks: `auth.reload`, `auth.reauth.start`, `auth.reauth.exchange`)

### FIXED [crash-on-startup+plugin-load]: Budget Panel Extension Crash on Startup (2026-03-21)

- **Symptom:** Budget panel extension failed to register ANY gateway methods (`budget.usage`, `budget.status`, `config.models`), causing all model panel data to be unavailable.
- **Root cause:** `extensions/budget-panel/index.ts` called `registerPluginHttpRoute()` which doesn't exist in the plugin SDK. The crash on this call prevented all subsequent `registerMethod()` calls from executing.
- **Fix:** Changed to `api.registerHttpRoute()` (the correct plugin SDK method, same as used in the tinker extension).
- **File:** `extensions/budget-panel/index.ts`

### FIXED [ui-state-clear]: Billing Error Badges Cleared by File Watcher (2026-03-21)

- **Symptom:** When a model hit a billing cap, the error badge appeared briefly then disappeared. Re-sending a message hit the same billing cap again.
- **Root cause:** The `auth.profiles.updated` handler (triggered by file watcher on credential changes) unconditionally cleared all `providerErrors` entries before refreshing the budget panel. A billing cap error would trigger a credential file write (cooldown update), which triggered the file watcher, which cleared the billing error badge.
- **Fix:** The handler now preserves `billing` and `auth_permanent` errors in `providerErrors` during the clearing phase. Only transient errors (rate limits, overloaded, auth) are cleared on profile updates.
- **File:** `tinker-ui/src/app.ts` (`auth.profiles.updated` handler)

### FIXED [cache-staleness]: Stale Usage Cache After Re-Auth (2026-03-21)

- **Symptom:** After successfully re-authenticating via the in-UI OAuth flow, the models panel still showed dashed bars (disconnected) for up to 30 minutes.
- **Root cause:** The budget panel cached null usage results with 2min TTL and real data with 30min TTL. After re-auth, the `auth.profiles.updated` handler called `loadBudget()` which hit the backend cache — still serving the pre-re-auth null data until the 30min TTL expired.
- **Fix:** `loadBudget()` now accepts `{ forceRefresh: true }` which passes `forceRefresh` to the `budget.usage` RPC call. The backend `usageCache` is busted when this flag is set, forcing a fresh fetch with the new token. The `auth.profiles.updated` handler always passes this flag.
- **Files:** `tinker-ui/src/app.ts` (`loadBudget`), `extensions/budget-panel/index.ts` (`budget.usage` handler)
- **Scope:** 46 of 49 workspace extensions were stale duplicates of bundled extensions — all potential shadow failures. Only 3 are genuinely workspace-specific (`google-gemini-cli-auth`, `minimax-portal-auth`, `test-utils`).
- **Files:** systemd service file, `~/.openclaw/workspace/extensions/whatsapp/` (deleted)
- **Full report:** `memory/knowledge/whatsapp-light-runtime-api-incident-2026-03-21.md`

### FIXED [auth-token]: Cloudflare Blocks OAuth Refresh — Root Cause of Sleep Recovery Failure (2026-03-18)

- **Root cause:** pi-ai's `refreshAnthropicToken()` calls `fetch()` without a `User-Agent` header. Cloudflare blocks these with error 1010. Token refresh silently fails → access token stays expired → all Anthropic requests fail → falls to qwen3.
- **Why Claude Code works:** Claude Code's SDK includes proper headers. Same OAuth tokens, same API, different HTTP client behavior.
- **Fix:** `refreshAnthropicOAuthToken()` in `credential-file.ts` sends `User-Agent: openclaw-gateway/1.0`. Used by both `oauth.ts` and `proactive-refresh.ts` for Anthropic refreshes. pi-ai's function kept for other providers.
- **Files:** `credential-file.ts`, `oauth.ts`, `proactive-refresh.ts`
- **Note:** `proactive-refresh.ts` removed 2026-04-06 (upstream native `claude-cli` auth). User-Agent fix in `credential-file.ts` and `oauth.ts` remains relevant.

### FIXED [timeout-tuning]: Overloaded (529) Retry Storm (2026-03-18)

- **Root cause:** On 529, gateway retried 4+ times per profile with backoff, then rotated to next profile, retried again. 3+ minutes wasted hammering an overloaded API — made the overload worse.
- **Fix:** On `reason === "overloaded"`, skip `advanceAuthProfile()` entirely. Throw `FailoverError` immediately so model fallback picks qwen3 in seconds. 529 = provider is stressed, not per-key issue.
- **Files:** `run.ts` (prompt path + assistant path)

### FIXED [event-ordering]: Partial Streamed Text Wiped on Error (2026-03-18)

- **Root cause:** `messages.filter(!_temporary)` cleared all streaming messages on error. Partial Opus response (thinking + text) disappeared.
- **Fix:** Convert temporary messages with content to permanent `_partial` messages before filtering.
- **Files:** `app.ts`

### FIXED [event-ordering]: Session Resume Silent Failure (2026-03-18)

- **Root cause:** `requestHeartbeatNow({ reason: "session-resume" })` routed through 5 heartbeat gates that silently blocked it — "session-resume" was classified as "other" by the reason classifier, causing HEARTBEAT.md content check, quiet hours, disabled heartbeat, and wrong-prompt failures
- **Fix:** Replaced heartbeat-based resume with direct `agentCommand()` call (same pattern as `boot.ts`). Added "session-resume" → "wake" in `heartbeat-reason.ts` as defense in depth. Added guardian check.
- **Files:** `server-startup.ts` (main), `heartbeat-reason.ts` (defense), `merge-guardian.sh` (guard)

### FIXED [ui-state-clear]: Send Button Never Enabled (2026-03-03)

- **Root cause:** `updateBtn()` never called after `connected = true`
- **Fix:** Added `updateBtn()` calls after gateway handshake and in `ws.onclose`
- **Verification:** Enter key always worked (bypassed button state)

### FIXED [plugin-load]: Plugin API Wrong Method (2026-03-04)

- **Root cause:** Used `api.registerHttpHandler()` which doesn't exist in the plugin SDK
- **Fix:** Rewrote to `api.registerHttpRoute({ path: "/tinker", auth: "gateway", match: "prefix", handler })`

### FIXED [bundler-trap]: \_\_filename ESM Crash (2026-03-03)

- **Root cause:** `tsdown` bundled `bindings` inline into ESM where `__filename` is undefined
- **Symptom:** Gateway crashed every ~8 min when WhatsApp history DB accessed
- **Fix:** `external: ["better-sqlite3", "bindings"]` in ALL 8 `tsdown.config.ts` entries
- **Rule:** After every build: `grep -r '__filename' dist/ --include='*.js' | grep -v node_modules` should return nothing

### FIXED [crash-on-startup]: Missing Import Broke Model Glow (2026-03-03)

- **Root cause:** `getSessionResetPrompt` used but never imported in `get-reply-run.ts`
- **Symptom:** ReferenceError killed reply handler → no lifecycle events → no model glow
- **Fix:** Added import, added to wiring script + guardian checks

### FIXED [ui-state-clear]: Error Badges Bleeding Across Models (2026-03-05)

- **Root cause:** `fallback-error` handler stored errors keyed by bare provider name (e.g., `"anthropic"`). Rendering fell back to `providerErrors.get(provider)`, so ALL models from that provider showed the same error badge (opus, sonnet, haiku × 3 keys = 6 rows all showing "billing cap").
- **Fix:** 4 changes in `app.ts`:
  1. `fallback-error` handler: key by `failedProfileId || failedModel || failedProvider` (not bare provider)
  2. Rendering: fall back to `providerErrors.get(modelId)` instead of `providerErrors.get(provider)`
  3. Start-phase clearing: also delete model-keyed entries
  4. Health poll + retryProvider: also clear `provider/*` pattern entries
- **Rule:** `providerErrors` keys must never be bare provider names — always use profileId, modelId, or at minimum `provider/model`

### FIXED [event-ordering]: Fallback Errors Never Emitted to UI (2026-03-05)

- **Root cause:** `agent-runner-execution.ts` and `followup-runner.ts` had no `onError` callback → `fallback-error` lifecycle events never reached Tinker UI. Also `run.ts` only had 4 of 6 `fallback-profile-error` emission paths wired.
- **Fix:** Added `onError` callbacks in both runners emitting `fallback-error`. Extended `run.ts` to emit on all 6 failure paths with provider/model fields. Added `onError` in `model-fallback.ts` for provider-level cooldown skips.
- **Commit:** `29ff272d4`

### FIXED [bundler-trap+merge-wipe]: onlyBuiltDependencies Wiped by Merge (2026-03-05)

- **Root cause:** Upstream merge wiped `pnpm.onlyBuiltDependencies` → `better-sqlite3` native addon never built → crash on WhatsApp DB access
- **Fix:** Restored `better-sqlite3`, `@discordjs/opus`, `opusscript` to `onlyBuiltDependencies`
- **Commit:** `033526256`

### FIXED [plugin-load]: configSchema Mandatory (2026-03-05)

- **Root cause:** Upstream made `configSchema` mandatory in plugin manifests
- **Fix:** Added field to `openclaw.plugin.json`
- **Commit:** `033526256`

### FIXED [event-ordering]: Stop Button Not Working During Streaming (2026-03-06)

- **Root cause:** Two issues: (1) Click listener attached directly to `.thinking-run` elements inside `updateChat()` — during streaming, `innerHTML` replacement between mousedown and mouseup detached the element before the click event fired. (2) `abort()` didn't clear `activeRuns`, so even successful aborts showed no visual feedback until server events arrived.
- **Fix:** (1) Moved click handler to delegated listener on `#messages` container, registered once in `init()` — survives innerHTML wipes. (2) Added `activeRuns.clear()` in `abort()` for immediate UI response.
- **Rule:** Never attach per-element click listeners on DOM that gets replaced by innerHTML during streaming. Use event delegation.

### FIXED [bridge-leak]: WhatsApp Lifecycle Events Contaminating Main Session (2026-03-03)

- **Root cause:** `enqueueSystemEvent()` for WA connect/disconnect/relink routed to main because `resolveAgentRoute()` with no `peer` → `peerId=""` → all `dmScope` branches fall through to `buildAgentMainSessionKey()` → `agent:main:main`
- **Fix:** Removed 4 `enqueueSystemEvent` calls in `src/web/auto-reply/monitor.ts` (journal still logs these)
- **Rule:** `enqueueSystemEvent` without a peer WILL go to main session. Don't use for channel lifecycle.
- **Commit:** `1ba87b077`

### FIXED [ui-state-clear]: Usage Bar Fills Invisible (2026-03-07)

- **Root cause:** `.usage-bar` and `.usage-bar-fill` were `<span>` elements (inline by default). CSS `height` and `width` percentages are ignored on inline elements — bars rendered as 3px background tracks but fills had 0 effective width.
- **Fix:** Added `display:block` to both `.usage-bar` and `.usage-bar-fill` in `base.css`
- **Rule:** When using `<span>` for visual elements with dimensional properties, always set `display:block` or `display:inline-block`

### FIXED [auth-token]: Budget Panel Token Rotation Breaking Agent Auth (2026-03-09)

- **Root cause:** On usage API 429, budget-panel called `forceRefreshToken()` which rotated the OAuth token via Anthropic strict rotation — immediately invalidating the agent runner's in-memory token. Both cli-sv AND cli-gm got 401 errors simultaneously.
- **Fix:** On 429, return cached data instead of refreshing tokens. `usageCache[label]` updated with current timestamp to prevent re-fetching during the rate limit window.
- **Rule:** Budget panel must NEVER call `forceRefreshToken()` — it's a read-only consumer of OAuth tokens, not a token lifecycle participant.
- **Commit:** `f7e552f44`

### FIXED [ui-state-clear]: Error Clearing Too Aggressive (2026-03-09)

- **Root cause:** Lifecycle `start` handler cleared ALL `providerErrors` entries matching the starting model's provider. When cli-gm succeeded after cli-sv hit rate limit, cli-sv's error badge was wiped.
- **Fix:** Only clear the specific `authProfileId` from the start event + the `startModel` key. Other profiles' errors persist until they individually succeed or health poll clears them.
- **Commit:** `9d1162aa8`

### FIXED [event-ordering]: Session Resume Not Working After Gateway Restart (2026-03-08)

- **Root cause:** Two bugs: (1) `clearSessionResume` in `get-reply.ts` fired _before_ `runPreparedReply`, so the resume file was deleted before the crash-prone LLM streaming phase. (2) `enqueueSystemEvent` in `server-startup.ts` is passive — it only prepends text to the next LLM call's context but never triggers one, so the resumed prompt sat idle until the user manually sent a new message.
- **Fix:** (1) Moved `clearSessionResume` to after `runPreparedReply` completes. (2) Added `requestHeartbeatNow({ reason: "session-resume", sessionKey })` to actively trigger an LLM run on the interrupted session (same pattern as `/hooks/wake` with `mode=now`).
- **Files:** `src/auto-reply/reply/get-reply.ts`, `src/gateway/server-startup.ts`
- **Commit:** `11c7dfa5e`
- **Rule:** Resume files must persist through the entire LLM streaming phase. Passive system events need `requestHeartbeatNow` to trigger active processing.

### FIXED [plugin-load]: Hippocampus Plugin Not Found Warning (2026-03-10)

- **Root cause:** Hippocampus was configured as enabled in `openclaw.json` (`plugins.entries.hippocampus`) but had no extension directory with `openclaw.plugin.json`. The config validator scans `extensions/` for manifests to build `knownIds` — missing manifest = "plugin not found" warning on every gateway start.
- **Fix:** Created `extensions/hippocampus/` with manifest + no-op `index.ts` stub. The actual hippocampus code (importance scoring, dedup, episodic buffer) lives in `src/memory/engram/` and is wired at build time — the extension exists solely for plugin discovery.
- **Commit:** `92580a562`
- **Rule:** Any fork-only subsystem referenced in `openclaw.json` plugin entries must have a corresponding `extensions/<id>/openclaw.plugin.json` manifest, even if the code is wired elsewhere.

### FIXED [cleanup-race]: Gateway Draining Deadlock — Orphan Processes (2026-03-11)

- **Root cause:** `KillMode=process` in `openclaw-gateway.service` meant systemd only killed the main gateway PID on restart. Child processes (agent runs, channel workers, cron tasks) survived as orphans in the cgroup, accumulating across restarts (200 tasks, 10.8GB memory). When Jarvis used the gateway restart tool mid-task, the drain couldn't complete because orphaned tasks held the "draining" state — all new LLM requests rejected with "Gateway is draining for restart; new tasks are not accepted".
- **Fix:** Changed `KillMode=control-group` in `~/.config/systemd/user/openclaw-gateway.service` + `systemctl --user daemon-reload`. Now systemd kills the entire cgroup on restart — no orphans survive.
- **Rule:** After `openclaw gateway install --force`, verify `KillMode=control-group` is preserved (upstream default is `process`). If draining errors recur, check `systemctl --user status openclaw-gateway` for orphan child processes with old PIDs.
- **Symptom path:** UI shows "sending" → no response → all 4 fallback models fail with same drain error → `Agent failed before reply: Gateway is draining for restart`

### FIXED [cleanup-race]: Stuck Cron Session Resurrecting Across Restarts (2026-03-11)

- **Root cause:** Cron task `fdc72836` got stuck during the drain deadlock above. The gateway persists incomplete cron runs as `.jsonl` files in `~/.openclaw/cron/runs/`. On every boot, the gateway restores them from disk and re-runs them — immediately re-entering the stuck state. Cleaning `overseer-state.json` alone was insufficient; the cron run file kept resurrecting the session.
- **Fix:** Deleted `~/.openclaw/cron/runs/fdc72836-*.jsonl` + purged 15 accumulated cron entries from `overseer-state.json`.
- **Rule:** If a cron task is stuck and survives gateway restarts, check `~/.openclaw/cron/runs/` for its `.jsonl` file. Delete it to break the resurrection loop. Also: Jarvis should never use the gateway restart tool while his own tasks are active — the SIGUSR1 drain will deadlock if the draining task is the one being drained.

### FIXED [bridge-leak]: Heartbeat Contaminating Webchat (2026-02-21, config)

- **Root cause:** Heartbeat ran in main session, its prompt+response persisted to transcript, webchat loaded from history
- **Fix:** Config-only: `heartbeat.session: "heartbeat"`, `heartbeat.target: "none"`
- **Lesson:** When suppression patches don't work, check the PERSISTENCE layer

### FIXED [event-ordering]: Mute Button Not Toggling (2026-03-19)

- **Root cause:** All dev-mode API calls (`jarvis-mute`, `context-anatomy`) hardcoded `http://localhost:18789` as base URL, bypassing Vite proxy. Cross-origin POST with `Content-Type: application/json` triggered CORS preflight (OPTIONS) which gateway auth middleware rejected with 401. `.catch(() => {})` silently swallowed all errors — button appeared functional but never toggled.
- **Fix:** Changed all API base URLs to `""` (routes through Vite proxy at `/tinker/api` which injects `Authorization: Bearer` header). Removed `Content-Type: application/json` from mute POST. Added `/tinker/api` proxy route to `vite.config.ts`. Added defensive OPTIONS handler to mute endpoint.
- **Lesson:** Never bypass Vite proxy for gateway API calls in dev mode — the proxy handles auth injection. Silent `.catch(() => {})` hides real failures; at minimum log the error during development.

### FIXED [event-ordering]: Context-Anatomy 400 "Absolute path required" (2026-03-19)

- **Root cause:** Gateway loaded the tinker extension 3 times (source repo + workspace + gateway reload). Source version had a broad `pathname.startsWith("/tinker/api/")` catch-all for the file-read API that matched ALL `/tinker/api/` routes — including context-anatomy and mute — returning 400 before specialized handlers ran.
- **Fix:** Synced source extension from workspace version (mute → context-anatomy → file-read API ordering). Replaced `~/.openclaw/workspace/extensions/tinker/` with a symlink to `~/src/tinkerclaw/extensions/tinker/` to prevent future desync.
- **Lesson:** The gateway loads extensions from both source and workspace dirs. Keep them in sync via symlink. Specific routes must come before catch-all routes.

### FIXED [ui-state-clear]: "Overloaded" Label Persisting Indefinitely (2026-03-19)

- **Root cause:** Three clearing mechanisms all broken: (1) health poll called `provider.health` which doesn't exist on gateway; (2) `loadBudget` clearing skipped profiles with null usage data (cli-gm always null due to 403 scope error); (3) 2h TTL never expired because each new error re-set the timestamp.
- **Fix:** Clear provider errors for `authProfileId` and `provider/model` on successful run completion (`phase=end`). `loadBudget` clearing no longer requires usage data — clears transient errors for any profile in the response (preserves `billing`/`auth_permanent`).
- **Files:** `app.ts` (onEvent `phase=end` handler + `loadBudget` clearing)

### ~~FIXED: Proactive Refresh Failing Silently (2026-03-19)~~ [OBSOLETE — extension removed 2026-04-06]

- **Root cause:** When credential file had expired tokens and the refresh API returned null (stale refresh token), no log was emitted — just "token expired" then silence. Made it impossible to diagnose dead OAuth profiles from logs.
- **Fix:** Added 3 log lines in `proactive-refresh.ts`: credential file expired (with minutes ago), credential file unreadable, refresh returned null (with actionable `anthropic-oauth-login.mjs` command).
- **Note:** This fix is now obsolete — the `tinkerclaw-proactive-auth` extension was removed on 2026-04-06. Upstream handles auth natively.

### FIXED [cache-staleness]: Usage Cache 30min Lockout After Boot (2026-03-19)

- **Root cause:** Budget-panel cached failed usage fetches (`null`) with same 30min TTL as successful ones. On boot, if token wasn't ready yet (proactive refresh still running), null was cached for 30 minutes → dashed lines even after token refreshed seconds later.
- **Fix:** `CACHE_TTL_FAILED_MS = 2min` for null results, `CACHE_TTL_MS = 30min` for real data. Boot-time token races self-heal in 2 minutes.
- **File:** `extensions/budget-panel/index.ts`

### FIXED [auth-token]: OAuth Refresh Downscoping All Tokens (2026-03-20)

- **Root cause:** `refreshAnthropicOAuthToken()` in `credential-file.ts` passed `scope: "user:inference"` in the refresh request body. OAuth 2.0 `scope` in a refresh request is a **downscope** — it restricts the new token to only the listed scopes. Every refreshed token lost `user:profile`, `user:file_upload`, `user:mcp_servers`, etc. The `/api/oauth/usage` endpoint requires `user:profile` → 403 on all budget-panel usage fetches → dashed lines on all opus model rows.
- **Cascade:** Downscoped tokens were written back to BOTH `auth-profiles.json` AND credential files (`.credentials-sv.json`, `.credentials-gm.json`), corrupting the credential files that were supposed to be source of truth. cli-sv's refresh token was also invalidated by Anthropic strict rotation after 2 days, making it unrecoverable without re-login.
- **Fix:** Removed `scope: "user:inference"` from `refreshAnthropicOAuthToken()`. Omitting `scope` preserves the original grant's full scope set per OAuth 2.0 spec. Manually re-synced tokens from Claude Code's `.credentials.json` (full scopes) and re-logged cli-sv via `anthropic-oauth-login.mjs --profile sv`.
- **File:** `src/agents/auth-profiles/credential-file.ts`
- **Commit:** `b11812feb`
- **Rule:** Never pass `scope` in OAuth refresh requests unless intentionally downscoping. The refresh grant inherits all scopes from the original authorization.

### FIXED [restart-recovery]: Architect re-prompt required after gateway restart (2026-05-13)

- **Symptom:** After `openclaw-restart --full`, Jarvis's session resumed via the openclaw-sessionId fallback (FORK 2026-05-10) but he did not autonomously continue mid-task; the user had to type "keep going".
- **Root cause:** cc-bridge resume only re-attaches the claude-cli session; no `[System] continue` is injected. The 2026-04-20 generic continue had been bypassed by the 2026-05-10 fallback. No persisted plan meant the agent had nothing concrete to resume from.
- **Fix:** new `prefrontal.plan.*` RPCs + boot-time `runRestartContinue` that dispatches a plan-aware `[System] continue` via `chat.send {deliver:false, dispatchAgent:true}`. The grey `__SYS_PLAN_RESUME__` chip surfaces the action in TUI.
- **Spec:** `docs/superpowers/specs/2026-05-12-prefrontal-plan-board-design.md` (commit `131f26d`).
- **Plan:** `docs/superpowers/plans/2026-05-13-prefrontal-plan-board-implementation.md` (commit `f991621`).
- **Commits:** Phase 1 `25552c1b40`, Phase 2 `9e444add28`, Phase 3 `9a36d25c59`+`a092050166`, Phase 4 `1b806a92af`, Phase 5 `340fd1ae23`, Phase 6 `8e665c925f`+`7febf58974`, Phase 7 `02f92f7f18`.

### FIXED [config-dead-code]: WhatsApp QR Pairing 515 Restart Dead Code (2026-03-20)

- **Root cause:** Fork inlined `getStatusCode()` from upstream's `session-errors.ts` but missed the `err.error?.output?.statusCode` fallback added in upstream PR #27910. Baileys wraps errors as `{ error: { output: { statusCode: 515 } } }` — without the fallback, `login.errorStatus` was always `undefined` and the entire 515 restart path in `waitForWebLogin` was dead code. QR scan succeeded but the phone showed "cannot log in" because the restart socket was never created.
- **Cascade:** Two additional issues compounded: (1) single global creds save queue instead of per-authDir queues meant creds weren't reliably flushed before restart, (2) even with proper detection, the restart socket connected too fast (368ms) — WhatsApp servers need ~3s to finalize device registration after `pair-device-sign`.
- **Fix:** Added `err.error?.output?.statusCode` to `getStatusCode()`, ported per-authDir `credsSaveQueues` Map + `waitForCredsSaveQueueWithTimeout()`, added 3s delay before restart socket creation.
- **Files:** `extensions/whatsapp/src/session.ts`, `extensions/whatsapp/src/login-qr.ts`, `extensions/whatsapp/src/login.ts`
- **Commit:** `cd30d97cb`
- **Rule:** After upstream merges, verify fork's inlined `getStatusCode` matches upstream's `session-errors.ts`. The error unwrapping depth is critical for Baileys disconnect handling.

### FIXED [event-ordering]: Today-card DnD always landed at end of axis (2026-05-23)

- **Symptom:** "The drag and drop for tasks within groups and among groups always puts things at the end of the list regardless of where I drop them." Recurrent — survived two prior fix commits (`76df31f68d` rank-renumber, `912922950a` head-rect + source-row guard) because the silent fallback masked the real failure mode.
- **Root cause:** the pointerup commit handler tore down the DOM state the renumber walk depended on, BEFORE the walk ran. Two stripped pieces, both fatal: (1) `drag.source.classList.remove("exec-task-source")` ran unconditionally at the top of `onPointerUp` — the walk used this class to skip the source row at its OLD position, so without it the source got pushed into `orderedIds` at its original index AS IF it were a regular peer. (2) `drag.indicator.remove()` ran at the top of the drag branch — the walk used the indicator's DOM position to know where to insert `drag.id`, so without it `querySelectorAll('.exec-drop-indicator')` returned zero hits, `insertedSource` stayed false, and the trailing `if (!insertedSource) orderedIds.push(drag.id)` fallback pushed `drag.id` at the END. Net: `drag.id` appeared TWICE in `orderedIds`; the higher-index RPC won the rank race on the server → source always landed at end. Same pattern hit the group DnD commit path (`8699` + `8712`).
- **Fix:** restructure both pointerup handlers to walk FIRST, strip visuals SECOND. Concrete ordering: `drag.ghost.remove()` → click-branch (if !passedThreshold; removes source-class + indicator inline since no walk runs) → drag-branch: stamp `execLastDragEndAt`, validate `indParent`, walk while indicator + source-class are STILL in DOM, bail if indicator is outside the destination subtree (now a hard `console.warn` + abort, NOT the silent "push at end" fallback), THEN strip visuals, THEN run the parallel RPC batch. The silent "push at end" fallback is GONE — its existence was what hid the bug across two prior fix commits.
- **File:** `tinker-ui/src/app.ts` (`attachExecPointerDragHandlers.onPointerUp` + `attachExecGroupPointerDragHandlers.onPointerUp`)
- **Commit:** `ffbc4cb5cc`
- **Rule:** when a commit handler walks DOM state set by earlier event handlers, order strictly — validate → walk → strip → commit. Visual teardown is the LAST step, not the first. Treat marker-not-found as a hard error (warn + bail), never a fallback that pushes the dragged element to a default slot. See `[[feedback_walk_before_teardown]]` in jarvis-icu memory.

### FIXED [event-ordering]: cc-bridge dual-path stream duplication after --include-partial-messages (2026-05-24)

- **Symptom:** "I still do not see answer-amygdala-fractal rendered correctly. On top of that, we are hitting the 'truncated' issue again. Messages should never truncate." User saw every block of streamed text appear twice in the rendered bubble — `"Good catches…Good catches…## 💬 ANSWER…"` — with later sections appearing to truncate.
- **Root cause:** the prior commit `3e343cb5ee` added `--include-partial-messages` to the cc-bridge spawn args so claude-cli would emit fine-grained `stream_event.content_block_delta.text_delta` lines token-by-token. claude-cli STILL emits its cumulative `assistant` block-complete frames in parallel. cc-bridge's `stream.ts` handled both paths but the fine-grained handler did NOT update `blockTextSeen[ev.index]`. When the cumulative `assistant` frame arrived, the block-handler saw `prev = blockTextSeen[bi] = ""` → its slice condition `cumulative.length > prev.length` fired → it pushed the entire cumulative text as a "new delta" ON TOP OF what the fine-grained deltas had already pushed. With gap-split bubbles in the mix, `_segmentStart` cursors went past `finalText.length` during the tail-recover at finalization, which the user perceived as truncation.
- **Fix:** in the `stream_event` handler at `extensions/tinkerclaw-cc-bridge/src/stream.ts:516`, mirror every fine-grained text_delta into `blockTextSeen[ev.index] += delta` (and the equivalent for thinking). The `index` field on `content_block_delta` is documented by the Anthropic API but typed only as `unknown` on `CcStreamStdoutStreamEvent`, so read via a narrow cast. The cumulative handler's slice condition then no longer fires for blocks the fine-grained path already covered.
- **File:** `extensions/tinkerclaw-cc-bridge/src/stream.ts`
- **Commit:** `d32e44cc24`
- **Rule:** when two paths can both deliver the same logical content (token-deltas + cumulative re-emit), the secondary tracker MUST be updated by BOTH paths or the consuming path will double-emit. Diagnostic recipe: count occurrences of identical text blocks in the rendered UI snapshot at `~/.openclaw/data/tinker-ui-snapshot.html` vs the source JSONL at `~/.claude/projects/<cwd>/<sessionId>.jsonl` — if JSONL has it once but UI has it twice → dual-path push regression. See `[[project_cc_bridge_streaming_partial_messages]]` in jarvis-icu memory.

### FIXED [config-dead-code]: Gateway-side code change didn't take effect after `openclaw gateway restart` (no rebuild step) (2026-05-24)

- **Symptom:** Shipped commit `cb0a6b4e1e` (fortune-cookie session names + soft-delete) + `openclaw gateway restart`. The user reported "secondary sessions are still named weird" — `sessions.list` was returning zero `cookiePhrase` fields despite the new code being committed + pushed.
- **Root cause:** `openclaw gateway restart` runs `systemctl --user restart openclaw-gateway.service` which re-execs the SAME bundled binary at `~/src/tinkerclaw/dist/index.js`. The dist was built on May 23 (BEFORE the commit). The restart never picked up the new source. Gateway version `openclaw --version` reported the new commit hash (because the CLI is loaded from source via tsx), but the GATEWAY PROCESS was running the stale bundle.
- **Fix:** `pnpm build` (runs `node scripts/build-all.mjs` → tsdown + postbuild + plugin-sdk checks) THEN `openclaw gateway restart`. Verified post-fix: `sessions.list` returns 49/50 entries with `cookiePhrase` populated, sample phrases `slate stream`, `indigo willow`, `silver hearth`, `ancient foxglove`, etc.
- **Rule:** for any change touching `src/gateway/`, `src/config/`, `src/agents/`, `src/auto-reply/`, etc. (anything bundled into `dist/index.js`) — build BEFORE restart. The mtime check `ls -la dist/index.js` against your commit time is the canary. Plugins under `extensions/*/src/` are exempt — they're TS-loaded at runtime via `definePluginEntry` and need ONLY a restart (no build). Tinker UI has its own vite HMR loop and needs neither.
- **Rule (jarvis-icu memory):** [[feedback_gateway_restart_does_not_rebuild]] carries the build-step responsibility table.

### FIXED [ui-state-clear]: Prefrontal "claude still running" with frozen clock after graceful restart (2026-05-24)

- **Symptom:** "Prefrontal says claude is still running, with frozen clock, but I don't see thinking activity anywhere else. Should it not go back to idle?" Server-side `prefrontal.tree` RPC returned `{active:false, root:null}` while the Tinker UI's prefrontal panel still showed an active claude run with a frozen elapsed timer.
- **Root cause:** the in-tab graceful-restart path skipped enrolling runs in `unconfirmedRuns`. When the gateway sends a `shutdown` frame with `restartExpectedMs`, `app.ts` line 1281-1292 marks every `activeRuns` entry with `state="restarting"` (to hold the indicator across the restart) but does NOT add the runIds to `unconfirmedRuns`. The reconnect-hello handler at line ~1269 then calls `scheduleUnconfirmedPrune()` unconditionally, but that function early-returns at `unconfirmedRuns.size === 0`. So the 30s prune timer is never scheduled, the gateway process that owned those runs is dead (no lifecycle:end will ever come), and the entries stay in `activeRuns` forever. Page-reload was the only path that cleared them because `restoreActiveRuns()` re-runs and repopulates `unconfirmedRuns` from sessionStorage.
- **Fix:** in the shutdown-frame handler, `unconfirmedRuns.add(runId)` for each active run alongside the `state="restarting"` mark. After the next reconnect, `scheduleUnconfirmedPrune()` schedules the 30s timer for these runs and they're cleaned up automatically. If lifecycle:start for the same runId arrives after reconnect (cc-bridge resume preserves runId), the existing `unconfirmedRuns.delete(p.runId)` at line 2338 confirms it — no spurious prune.
- **File:** `tinker-ui/src/app.ts` (in-tab shutdown handler at the WS-frame dispatch)
- **Commit:** see HEAD of this commit batch (paired with the bible verify added in `tool-loop.md`)
- **Rule:** any state-clear pathway that depends on `unconfirmedRuns` being populated MUST be paired with an enrollment site at the moment the state becomes orphan-eligible. The early-return-on-empty optimization is fine for the no-runs case but it silently fails the no-enrollment case — paired enrollment + prune is the contract.

### FIXED [detection-pattern]: sectioned-reply splitter broke on markdown H2 headings (2026-05-24)

- **Symptom:** answer-amygdala-fractal three-section reply rendered as ONE big assistant bubble with the section markers as literal H2 text inside the markdown (`## 💬 ANSWER`, `## 🧠 AMYGDALA`, `## 🌿 FRACTAL` visible as headings instead of being parsed away).
- **Root cause:** Opus has started emitting the section markers as markdown H2/H3 headings (`## 💬 ANSWER` etc.) instead of bare emoji+label. The splitter regexes at `tinker-ui/src/app.ts:3474-3477` only tolerated optional `**`/`__` bold wrapping, not `#` heading marks. With `## ` (non-whitespace) before the emoji, `(^|\n)\s*💬` failed to match → `text.search(ANS_MARKER_RE)` returned -1 for all three markers → `splitSectionedReply` returned null → `renderSectionedReply` never fired → fallback regular-assistant-bubble path rendered the entire reply with markers as literal H2 text.
- **Fix:** insert `#{0,4}\s*(?:\*\*|__)?\s*` after the `(^|\n)\s*` anchor in all three marker regexes (`AMY_MARKER_RE`, `ANS_MARKER_RE`, `FRA_MARKER_RE`). Tolerates `#` through `####` headings and optional bold wrapping in either order around the emoji. Confirmed matches against all six observed shapes: `💬 ANSWER:` `💬 **ANSWER**` `💬 **ANSWER:**` `## 💬 ANSWER` `### 💬 ANSWER` `**💬 ANSWER**`.
- **File:** `tinker-ui/src/app.ts` (`AMY_MARKER_RE` / `ANS_MARKER_RE` / `FRA_MARKER_RE`)
- **Commit:** `d32e44cc24` (shipped together with the cc-bridge dual-path fix above)
- **Rule:** marker-detection regexes for content emitted by an LLM must tolerate the model's natural surface variants (heading marks, bold wrapping, mixed casing) instead of pinning to one shape. When the splitter returns null the entire reply falls through to a generic render and the user sees raw markers as text — far worse than a slightly permissive regex.

### FIXED [ui-state-clear]: Unsent composer draft lost on hard refresh (2026-06-06)

- **Symptom:** text typed into a tab's chat composer but not yet sent was lost on a hard refresh / crash. Oscar lost a 20-minute prompt this way.
- **Root cause:** drafts lived only in the in-memory `tabStates` Map (`TabState.draft`), which a hard refresh wipes, plus a SINGLE global `localStorage` key `DRAFT_STORAGE_KEY="tinker-draft"`. On reload only that one global slot was restored — so per-tab drafts were lost and all tabs shared one draft.
- **Fix:** persist drafts PER TAB in `localStorage` keyed by tab id (`tinker-draft:<tabId>`), replacing the single global key; the composer input listener write-throughs to the active tab's per-tab key + `TabState.draft` on every keystroke; the connect/init flow rehydrates each restored tab's draft and loads the active tab's into the composer; a successful send clears both.
- **Status / files:** `tinker-ui/src/app.ts` (`saveDraftFor`/`loadDraftFor`/`clearDraftFor`, `DRAFT_STORAGE_KEY_PREFIX`). HMR-live; **uncommitted** (recovery patch jarvis-icu `9fe305a`; lands on develop at next commit). Task `task-mpzzs5nc`.
- **Recovery tip:** the OLD global `tinker-draft` key is never deleted, so a draft lost under the old code is still recoverable via `localStorage.getItem('tinker-draft')` in the browser console.
- **Rule:** any in-memory editor state the user can lose to a refresh/crash must write-through to `localStorage` on edit, keyed per owner (per tab), and clear on the success path — never rely on a single global slot.

### FIXED [ui-state-clear]: Auto/renamed tab titles did not survive refresh/restart (reverted to fortune cookie) (2026-06-06)

- **Symptom:** a tab the user renamed or auto-named reverted to its random `FORTUNE_COOKIES` name after a hard refresh or gateway restart.
- **Root cause:** tab titles persist to `localStorage` (so they survive in storage), but `loadSessions()` re-synced `tab.title` from the server `cookiePhrase` on every `sessions.list` response, clobbering the custom/auto title. The existing protection was a HEURISTIC (`LEGACY_2WORD_PHRASE_RE`) that mis-classified some custom titles as replaceable.
- **Fix:** an EXPLICIT per-tab `titleLocked` flag (persisted in `localStorage["tinker.tabs"]`), set true on manual rename AND on a successful auto-name; `loadSessions()` no longer overwrites a locked tab's title — it only syncs the server phrase into tabs still showing a default/fortune title. Custom/auto names now survive both refresh and restart. `🏠 Main` force-reset preserved.
- **Status / files:** `tinker-ui/src/app.ts` (`titleLocked`, `loadSessions` reconciliation). HMR-live; **uncommitted** (recovery patch jarvis-icu `9fe305a`). Task `task-mq0mcb8h`. See `session-naming.md` (the canonical naming contract this amends).
- **Rule:** protect user-meaningful titles with an EXPLICIT lock flag, not a format heuristic — a heuristic that infers "is this a custom name?" from the string shape will misfire. The server `cookiePhrase` may only fill a tab that has no locked title.

---
