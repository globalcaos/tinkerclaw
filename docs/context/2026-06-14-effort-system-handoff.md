# Effort system — handoff brief for Claude Code (ultracode)

> Author: Jarvis (Opus 4.8), 2026-06-14. Grounded by 3 parallel recon agents.
> Status: **diagnosis only — no fix applied.** This brief asks you to design the fix.
> Scope: the "effort" feature has THREE distinct problems. They interlock. Please
> read all three, then propose an architecture before editing.

## TL;DR — the one-sentence headline

From the Tinker UI today there is **no working path to set the model's thinking
budget**: the effort-router only injects advisory prose (never sets the budget),
the effort **slider** persists nothing (it calls a gateway method that doesn't
exist, and webchat clients are blocked from session-metadata patches anyway), and
the **EEG** faithfully shows the resulting un-raised (Auto/Low) budget. So "Use
Max effort" — by prose OR by slider — currently changes nothing the model enforces.

There are two faces to "effort": **the doing** (how many thinking tokens I'm
actually allotted) and **the visualizing** (the EEG seismograph). The EEG is
correct. The doing is broken in two independent places.

---

## Problem 1 — THE DOING: effort-router is advisory-only, never wired to the budget

**Two mechanisms that never touch each other.**

1. **Effort-router (prose only).** The prefrontal `before_prompt_build` hook
   classifies the prompt (`classifyComplexity` → trivial/standard/deep/ultra) and
   injects an `<effort_adaptation>` text block — a `thinkingHint` ("maximum
   reasoning…") and a `modelTier` hint. It is returned ONLY as
   `{ prependSystemContext }`. It sets no budget, no model, no `thinkLevel`.
   - `extensions/tinkerclaw-prefrontal/effort-router.ts:285-339` (classify + buildEffortGuidance)
   - `extensions/tinkerclaw-prefrontal/index.ts:876-877, 1080-1081` (pushed as prose, returned as prependSystemContext only)

2. **The real thinking budget.** `MAX_THINKING_TOKENS` is a strict function of
   `params.thinkLevel` (max→28000, high→16000, off/unknown→omit).
   - `extensions/tinkerclaw-cc-bridge/src/thinking-budget.ts:25-63` (level→budget map)
   - `extensions/tinkerclaw-cc-bridge/src/worker.ts:681-687` (env set from thinkLevel)
   - `extensions/tinkerclaw-cc-bridge/src/stream.ts:178-203` (reads `__openclawThinkLevel`)
   - `src/agents/embedded-agent-runner/run/attempt.ts:1916-1925` (pipes `__openclawThinkLevel: params.thinkLevel`)

**Where `params.thinkLevel` actually comes from** (NOT the router):
`resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking`

- `src/agents/agent-command.ts:591, 303-304, 1178` (request `thinking`/`thinkingOnce` + persisted)
- `src/agents/command/session.ts:334-337` (persisted session `thinkingLevel`)
- `src/gateway/server-methods/sessions.ts:1738` (resume reads persisted `thinkingLevel`)

**Why a plugin physically can't fix it today:** the `before_prompt_build` /
`before_agent_start` result contract exposes ONLY systemPrompt/prependContext/
appendContext/prependSystemContext/appendSystemContext — **no thinkLevel field**
(compile-time-asserted complete list). The only override hook is
`before_model_resolve` (modelOverride/providerOverride) — still no thinkLevel,
and the effort-router doesn't use it.

- `src/plugins/hook-before-agent-start.types.ts:28-50, 14-19`

**Root cause:** the effort-router is a _prompt-injection_ mechanism, not a
_control-plane_ mechanism. `thinkLevel` is resolved once at request time and never
re-derived from prompt classification.

---

## Problem 2 — THE VISUALIZING: the EEG is FAITHFUL (not a bug)

The EEG's x-axis is the 8-stop thinking-budget ladder (Auto, Minimal, Low,
Medium, Adaptive, High, xHigh, Max). Each run's `chosenLevel` is the cc-bridge
`thinkLevel` carried on the gateway's `stream:"effort"` event — NOT the
effort-router's prose classification.

- `tinker-ui/src/app.ts:3380-3401` (`r.thinkLevel = d.thinkLevel`), `:3426-3444` (`chosenLevel: r.thinkLevel ?? ""`)
- `tinker-ui/src/panels/eeg-trace.ts:21-30` (stops; index 0 = "" = Auto), `:173-202` (Auto/empty resolution)

**Auto rendering nuance:** when the budget is unraised, `thinkLevel` is absent →
`chosenLevel=""` → `eegEffectiveLevel()` substitutes the **measured** thinkingChars
bucket (so Auto shows the effort actually _spent_), falling back to the leftmost
Auto column only when no chars are known yet. So an un-raised budget correctly
renders at the low/Auto end and never fabricates a high stop. **The instrument is
honest; it was reporting that nothing raised the budget.** (Subagent branches were
wired 2026-06-14: `app.ts` commit `cfbd6b4953` + hover labels `0668ac93e7`.)

Minor open question the agent flagged: very early in a run (chosenLevel="" and
chars not yet known) the line briefly parks at the literal Auto column — cosmetic.

---

## Problem 3 — THE SLIDER: selection snaps back to Auto on send (doubly broken)

The slider in the Models panel has **no stored value of its own** — its position is
recomputed every render from `sessions[].thinkingLevel`.

- `tinker-ui/src/app.ts:8405-8414` (THINK_STOPS), `:8552-8587` (renderThinkingSlider derives idx from the session)

On change it fires `req("sessions.update", { key, patch: { thinkingLevel } })` —

- **`sessions.update` is not a real gateway method** (only `sessions.patch` exists). The promise rejects (unknown method) and `.catch(()=>{})` swallows it. Nothing persists; the local `sessions[]` array is never updated either.
  - `tinker-ui/src/app.ts:9361-9373` (the broken persist site), `:2650-2659` (req rejects unknown method)
  - `src/gateway/server-methods/sessions.ts:625-1646` (handler table — no `sessions.update`)
- **Even the correct `sessions.patch` would be rejected**: the Tinker UI connects as a _webchat_ client, and `rejectWebchatSessionMutation` blocks all session-metadata patches except display-name.
  - `src/gateway/server-methods/sessions.ts:253-292`

So the selection lives only as a transient DOM `.active` class. The first
`updateBudgetPanel()` re-render after send (driven by stream/tool/effort events)
rebuilds the slider from the unchanged `sessions[].thinkingLevel` (still Auto) →
**snaps back to Auto.**

- `tinker-ui/src/app.ts:7857-7990` (updateBudgetPanel rebuilds innerHTML, calls renderThinkingSlider at :7986)
- Same nonexistent-`sessions.update` bug also affects the Sessions alt-view `<select>` at `app.ts:13594-13602`.

Desired behavior (your words): **the selected effort persists for the CURRENT
session only, sticky across sends; other sessions' sliders stay untouched.**

Precedent for per-sessionKey client-side state already exists:

- `tinker-ui/src/app.ts:1540-1548` (`eegStores`/`eegInputByRun` are `Map<sessionKey, …>`)
- `tinker-ui/src/app.ts:939-966` (per-tab `TabState` container)

---

## How the three interlock (the real fix is unified, not three patches)

The slider's whole job is to set `thinkingLevel`, which IS `params.thinkLevel`,
which IS the real budget the EEG shows. So fixing the slider to actually persist +
reach the model **is the same fix** as making effort settable at all. The
effort-router (Problem 1) is the _automatic_ path to the same `thinkLevel`; the
slider (Problem 3) is the _manual_ path. Both currently fail to write `thinkLevel`.

Key constraint discovered: **webchat clients cannot mutate session metadata.** So
the slider can't persist via `sessions.patch`. The likely working channel is the
**send payload** — `sessions.send` carrying a per-turn `thinking`/`thinkingOnce`
option (which becomes `thinkOnce`/`thinkOverride` at `agent-command.ts:591`,
ahead of `persistedThinking`). That path is webchat-allowed and already feeds
`params.thinkLevel`. Verify this is the right seam.

---

## My PROPOSED direction — please CHALLENGE it, don't just build it

This is a starting point from someone who mapped the code, not a spec. Use
ultracode to map the full pipeline yourself and propose the cleanest architecture.

1. **Make the slider sticky per session (client-side first).** A
   `Map<sessionKey, ThinkLevel>` override (mirroring `eegStores`); render reads the
   override before falling back to `sessions[].thinkingLevel`; never reset on send.
2. **Make the slider actually reach the model.** Since webchat can't patch session
   metadata, thread the selected level into the **send payload** as a per-turn
   `thinking`/`thinkingOnce` option so it lands in `params.thinkLevel`. Decide:
   one-shot per send, or sticky-applied to every send until changed?
3. **Wire the effort-router → budget (the automatic path).** Give the effort path a
   real control-plane channel: EITHER extend the hook-result contract with an
   optional `thinkLevelOverride` applied in the runner, OR move classification into
   a `before_model_resolve`-style seam, OR map the router's level onto the request's
   thinking option when the user hasn't set one.
4. **Precedence, made explicit & visible.** Likely: explicit slider > per-turn prose
   request > router auto-detection. An explicitly-chosen low MUST NOT be overridden
   upward by an "ultra" classification. The EEG already encodes user-pinned as the
   dashed trace — keep that semantic.
5. **Level vocabulary mismatch to reconcile:** `classifyComplexity` emits 4 levels
   (trivial/standard/deep/ultra) but `thinkLevelToMaxThinkingTokens` keys are
   minimal/low/medium/adaptive/high/xhigh/max. Define the mapping deliberately.

## Open design questions (from the recon agents)

- Should "Use Max effort" (or an ultra classification) raise the budget at all, or
  is prose-driven escalation undesirable (cost/surprise)? Who decides — user-pinned
  always wins?
- If a `thinkLevelOverride` is added: one-shot (not persisted) so a prose-detected
  effort doesn't stick to the session? What precedence vs. an explicit slider?
- Should the router's `modelTier` hint also become an enforced `modelOverride` via
  `before_model_resolve`, or stay advisory? (Note: Fable is US-gov-disabled today —
  do not route to it.)
- The effort-router runs ONLY on the primary `:main` chat turn (subagents/cron/
  heartbeat excluded, `index.ts:831-837`). Should enforced escalation propagate to
  subagents/recipes, or stay main-only?
- Fix the alt-view `<select>` (`app.ts:13594-13602`) in the same change so both
  effort controls behave consistently?
- On `/clear` the slider repaints for the rotated key (`app.ts:4888-4891`) — should
  a per-sessionKey override map survive `/clear`, or reset?

## Operational notes

- Tinker UI is served from `tinker-ui/dist` (per-request, no restart) — a UI-only
  fix deploys with `cd tinker-ui && pnpm build` (or `npx vite build`); gateway picks
  it up on reload. A backend/hook change needs `pnpm build` of the gateway + a
  gateway restart — and `pnpm build` clean-wipes `dist` on failure (brick risk),
  so build to completion.
- Verify the ARTIFACT, not just exit code. The model-override `agent({model})`
  path in workflows is currently broken (namespaced id reaches `claude --model`
  which wants a bare id) — omit model in any orchestration you run.
