# Thalamus, fully on: pass 1, architecture choices

2026-10-02. Source: the architect's request of 12:57 (memory `project_thalamus_full_deploy_requirements`), the J19 paper,
and the v4 design (`docs/plans/2026-09-30-thalamus-v4-design.md`, cited as "v4 §n"). This pass explains the
choices. The detailed tests come with the build.

## What runs today (measured 2026-10-02)

- **The main chats are Claude Code turns, and the core router picks their model once per turn.** On an Auto tab,
  `model-selection.ts` calls `thalamusPlan` with every reachable model, each subscription's usage, the task domain
  (keyword classifier) and the dial. The dial is one value, `~/.openclaw/orca-bias.json`, now 6 (smart).
- **A pin from the model picker beats the plan.** `~/.openclaw/thalamus-tier-defaults.json` holds smart → Opus 5.5,
  balanced → Sonnet 5.5, fast → Grok 4.7. When the dial's band has a pin, the pin runs and the plan only supplies the
  recovery chain behind it.
- **The planner can already skip a supply that just hit a limit** (`cooling` veto in `thalamus-feasibility.ts`) and a
  family that refuses a subject (`engagement` veto). The live router passes neither (v4 F10), so a model that hit
  its limit is picked again on the next turn unless the usage snapshot already says "spent".
- **Limit errors are recognised and their reset times read** (`failover-error.ts`, `rate-limit-reset.ts`). Inside a
  turn, the chain fails over. Nothing remembers the limit for the next turn.
- **The v4 plugin runs in shadow.** 85 decisions, 0 that would change a pick. Jev reads now ride (2,884: 27 task,
  2,822 step, 35 outcome) but are only counted; no refusal has been recorded.
- **Rewind exists.** `sessions.rewind` for built-in tabs, `amygdala2.rewind` for Claude Code tabs.

## The shape

Thalamus stays two layers. The **router** decides each Auto turn of every chat. The **v4 plugin** decides calls
inside background runs, asks Jev, detects refusals and learns at night. Turning Thalamus on means four things:
the router treats the architect's picks as suggestions; the router remembers limits; the plugin goes from shadow to
enforce for background calls; and a detected refusal shows two buttons in the chat.

## Choices

| #   | Choice                                                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                        | Instead of                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | The dial reads **budget · default · smart**. An unset dial sits on **default**, the middle stop (bias 3).                                                                                                                                                                                                                                                                                                                         | the architect's words.                                                                                                                                             | fast · balanced · smart, unset = smart.                            |
| 2   | Each stop holds a **suggestion: model and effort**, in the same file: `{"smart": {"model": "…", "effort": "max"}, …}`. The old string form is still read, as model with no effort.                                                                                                                                                                                                                                                | One file, written by the picker as today.                                                                                                                  | A second file for efforts.                                         |
| 3   | **A suggestion is a prior, not a pin.** The router scores every rung as it does now and gives the suggested rung a bonus of 10 % of its own score. The suggestion runs unless another rung still beats it for this task's domain, or the suggestion cannot run (limit, cooling, context too small, outside the allowlist). The THALAMUS card says which: "kept your Opus 5.5" or "moved to Fable 5: +14 % on research".           | Autonomy with his preference weighted, and one number to tune. A relative bonus survives a vendor rescaling its index; a fixed number of points would not. | The pin beating everything (today), or ignoring the picks.         |
| 4   | When the suggestion runs, so does its effort. When another rung wins, its effort comes from the dial, as today.                                                                                                                                                                                                                                                                                                                   | His example: smart = Opus 5.5 at max.                                                                                                                      | One effort per stop for every model.                               |
| 5   | **A limit cools its supply.** A usage, rate or credit limit (as `failover-error.ts` already classifies it) marks that supply cooling until the reset time the error gives, or 30 minutes when it gives none. The router passes `cooling` to the planner, so the next turn goes to the best supply still open. The state lives in a small gateway file, so a restart keeps it. Inside a turn, the existing chain still fails over. | His ask; every part but the memory exists.                                                                                                                 | Waiting for the usage snapshot to notice.                          |
| 6   | **The plugin goes to enforce** with `perCall` on (background runs switch model per call), `midThread` off (switch only at fresh points, v4 §11.3), `orchestrateAuto` on. `digest`, `check`, `finish` and `hedge` stay off.                                                                                                                                                                                                        | These carry the asked behaviour. The other four rewrite outputs or double the spend, and were not asked.                                                   | Every flag on.                                                     |
| 7   | **Refusals are detected, never re-routed.** The plugin's end-of-turn outcome read (Jev) marks a refusal and emits `thalamus.refusal` with the session, the run, the refusing family and a pick from another family. No veto is applied to routing: the router keeps not passing `refusals`. Learning still writes refusal records for later.                                                                                      | His observation: once a refusal is in the context, the next model tends to agree with it.                                                                  | An automatic retry.                                                |
| 8   | **Two buttons under a reply marked refused:** "Rewind" (the existing rewind; the prompt comes back to the box) and "Rewind and retry with ‹model›" (rewind, then resend the same prompt once on Thalamus's pick: the best rung for that domain from another family that is not cooling). The model's name is in the button.                                                                                                       | His words.                                                                                                                                                 | A retry with a model chosen at click time.                         |
| 9   | **The turn pick keeps the keyword domain classifier.** The Jev task read arrives after the turn has started (it rides on the prompt hook inside the worker), so it cannot steer that turn. It feeds the nightly learning, which tunes the per-domain strengths the router uses.                                                                                                                                                   | The Claude Code lane fixes its model at spawn (v4 §3.1).                                                                                                   | Holding every turn for a Jev read (0.4 s and one more dependency). |

## Module map

- **Core router** (`src/auto-reply/reply/model-selection.ts`, `src/infra/thalamus-tier-defaults.ts`,
  `src/shared/thalamus-plan.ts`, `src/shared/thalamus-frontier.ts`): dial bands and default, suggestion file with
  effort, the prior bonus, `cooling` passed in.
- **Cooling store** (new, `src/infra/thalamus-cooling.ts`): written from the failover path when a limit error is
  classified, read by the router; one JSON file under `~/.openclaw/`.
- **Turn telemetry** (`src/infra/thalamus-turn-telemetry.ts`): tier names, `why` = suggestion-kept | moved |
  cooling | best-of.
- **v4 plugin** (`extensions/tinkerclaw-thalamus`): enforce flags; refusal event; `thalamus.retryPick` method that
  answers "which model would the retry button use for this session".
- **Tinker page** (`tinker-ui/src/app.ts`, `panels/thalamus-turn.ts`): dial wording; picker right-click sets model
  then effort per stop, marked "suggestion"; card line; the two buttons.

## Build order

1. Router: dial names and default; suggestion file with effort; prior bonus; tests on recorded boards.
2. Cooling store and its wiring; a test that a 429 with a reset time skips that supply on the next plan.
3. Page: dial wording, picker, card line.
4. Plugin: refusal event, `thalamus.retryPick`, enforce flags staged.
5. Page: the two buttons, driven in a browser against the mock gateway.
6. Deploy with `tinker-rebuild full`; check a live Auto turn's card, a forced limit, and a staged refusal.

## Cutover

The router change is live the moment the build is. To see it before it matters, the build replays the last 85
recorded decisions through the new router and lists every pick that would change, before the merge. The plugin's
enforce flags go in the staged config and apply at the same restart. Rolling back is one revert and a rebuild.

## Lines not to cross

- A model chosen on a tab (not Auto) stays chosen. Suggestions apply only on Auto.
- Never route outside the agent's allowlist, and never to OpenRouter (unfunded by the architect's policy).
- No automatic retry after a refusal.
- WhatsApp and other channel sources stay away from Jev (`privacy.privateSources`).

## Open items

**the architect decides (defaults taken, nothing waits):**

1. The prior: 10 % of the suggestion's own score.
2. Cooling when the error gives no reset time: 30 minutes.
3. The enforce flags in choice 6.

**Unverified:**

- Whether every vendor's limit error carries a reset time (the Claude subscription message, the Codex plan limit).
- How often Jev's refusal read is wrong on real turns: 35 outcome reads so far, none refused.

## UI choices (pass 2, the architect's answers of 2026-10-02 13:29)

Page: `~/Documents/AI_reports/Papers/J19_maestro/design-full-deploy/`, answers in `feedback/latest.json`.

- **Dial (keep):** budget · default · smart, unset = default, one line under it names the stop's suggestion.
- **Picker (change):** the right-click on a model that assigns it to a role stays as it is today. A model newly
  assigned to a role gets effort **low** by default. The role shows as a letter, **S**, **D** or **B**, next to the
  model, and the same letter next to the effort level assigned to that role. To change the effort, right-click
  the effort level (its button or word) of a model that already holds a role; the menu offers "assign this effort
  to ‹role›".
- **Card (keep):** one line per turn: kept your suggestion, moved (and why), or cooling (until when).
- **Refusal (change):** the retry button names the model **with its logo**, as the picker shows it.

## Detail (phase A, 2026-10-02)

**What this is for.** The map from each choice (1–9) and each UI choice to the function that carries it, so the build
units B, C and D can be sent without re-reading the code. **How it was derived:** every row below was read in
the worktree at `5b8cca37a5f`; the evidence column names what was opened. **What would change it:** a unit that
finds a row wrong writes the correction in its own status file.

### Corrections to pass 1 (technical choices, built as stated here)

1. **`enforce.perCall` and `enforce.midThread` do not exist yet.** The v4 design lists them (§11.3), but
   `extensions/tinkerclaw-thalamus/src/config.ts` has neither key, and the per-call seam is observe-only:
   `src/agents/embedded-agent-runner/call-router.ts` calls `router.observe(...)` and sends the original `model`
   (header comment: "The router can neither change what is sent"). Choice 6 therefore cannot switch a model per call
   today. Built now: both keys in the config (default false), `midThread=false` honoured by `routeCall` (a thread is
   never switched, only fresh points), the flags in the staged file, and `perCall` reported honestly as "flag on,
   seam observe-only" (records stay `acted:false`). **Recommendation:** the swap itself needs a decision of its
   own (the call's auth and API shape follow the provider, so a cross-provider swap inside a streaming call is not
   a one-line change); `orchestrateAuto` (the leaf resolver) is the part of enforce that really acts today.
   **Master's ruling, 2026-10-02 14:44:** `perCall` stays off and unbuilt (the staged file says `false`; none of
   the architect's asks needs a model change inside a running call, the turn router picks before each run), and the short
   list (correction 6) ships on behind its own switch `enforce.shortlist` (default true; false = enforce routes but
   injects no list and the hook route answers empty, as shadow does).
2. **The prior is beaten only by measured, task-specific evidence.** The prior is 10 % of the suggestion's own
   score, and the score is the measured domain strength `p` of the task's domain. A `general` task, or a suggestion
   with no measured row for the domain, has nothing to move it and keeps the turn. Comparing on the AA index instead
   (tried first, dropped before commit) lets every rung at least as smart as the anchor beat a suggestion set at a low
   effort by well over 10 % (Sonnet@low against Opus@max), so the "default" stop would almost never run what the architect
   picked. Pass 1's "another rung still better for this task" is read as exactly that: better _for this task_.
   Rivals are the dial's own band (its floor, its cost cap) and never the suggestion's own model at another effort.
3. **Cooling is per supply, as the planner already is.** A limit on Opus alone (a model-specific weekly cap) cools
   the whole `anthropic` supply for the reset time, so Sonnet is skipped too. `supplyOfKey` has no finer unit and
   decision 3 says "their supply". Unverified: whether Claude's message names a model when only one is capped.
4. **"Another family" for the retry button means another vendor** (`supplyOfKey` differs from the refusing model's),
   not another model line. Same-vendor models share the policy that refused (the architect's own observation), and the
   vendor is the unit the cooling store and the allowlist already use.
5. **Turning the plugin to `enforce` does more than the three flags.** The shortlist seam hands the agent the
   enhancement short list (which skills, recipes and plugins fit the task) on every prompt in enforce mode, and answers
   the Claude Code hook's route too; in shadow it answers empty. Pass 1 and decision 7 do not mention it. Not changed
   here (it is the mode's definition, v4 §11.2); listed as a decision for the architect in the C status.
6. **Private sources never retry elsewhere.** If the session's source is private (`privacy.privateSources`), the
   retry pick is limited to `privacy.approvedProviders`; with only `claude-code` approved the pick is `null` and the
   page shows Rewind only.

### Choices 1–9 to code

| #   | Where (file: function)                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                | Unit |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `src/shared/thalamus-frontier.ts: THALAMUS_DEFAULT_BIAS_IDX` becomes 3; `src/infra/thalamus-tier-defaults.ts: thalamusTierForBias` returns `budget`/`default`/`smart`; `thalamus-turn-telemetry.ts: thalamusTurnTier`                   | The constant is `THALAMUS_BIAS_GAP.length - 1` = 6 today; `clampBiasIdx`, `readOrcaBias() ?? …` in `thalamus-board.ts` and the page's `BIAS_DEFAULT_IDX` all read it                    | B1   |
| 2   | `thalamus-tier-defaults.ts: readThalamusTierDefaults` returns `{smart,default,budget}: {model,effort?}`; accepts `high/medium/low` and bare strings; new `writeThalamusSuggestion`; `prefrontal.thalamusDefaults` (extension) writes it | The live file is `{"medium":"claude-code/claude-sonnet-5-5","low":"xai/grok-4.7","high":"claude-code/claude-opus-5-5"}`; the writer is `extensions/tinkerclaw-prefrontal/index.ts` ~966 | B1   |
| 3   | `thalamus-frontier.ts: thalamusRoute` gains `suggestion` and `SUGGESTION_PRIOR = 0.10`; `thalamus-plan.ts: thalamusPlan` passes it and reports the outcome; `model-selection.ts` Auto block drops the "pin beats plan" branch           | Today `tierDefaultKey ? … : route` at `model-selection.ts` ~652 overrides the plan; `thalamusRoute` has the band, the strengths and the cost cap the prior is compared in               | B1   |
| 4   | `thalamusRoute`: the suggestion's rung is the one with the named effort; no effort named → the suggestion's rung nearest the dial pick; a moved turn takes the winning rung's own effort                                                | Rungs are `(key, effort)` pairs (`FrontierRung`); the old code already picks "the nearest rung" for a pin without effort                                                                | B1   |
| 5   | `src/infra/thalamus-cooling.ts` (new): `recordSupplyLimit`, `readThalamusCooling`; written from `src/agents/model-fallback.ts: recordFailedCandidateAttempt`; read in `model-selection.ts` and `thalamus-board.ts`                      | `recordFailedCandidateAttempt` is the one place every failed candidate passes with provider, model, `described.reason` and the raw error; `resolveRetryAfterSeconds` reads the reset    | B2   |
| 6   | `extensions/tinkerclaw-thalamus/src/config.ts` (`perCall`, `midThread`), `src/shared/thalamus-route-call.ts` (`midThread`), staged file `build-full/staged-thalamus-enforce.json`                                                       | See correction 1                                                                                                                                                                        | C2   |
| 7   | `extensions/tinkerclaw-thalamus/src/refusal.ts` (new), `reads/provider.ts` (outcome read carries session and turn), `runtime.ts` (handler, `retryPick`), `index.ts` (`thalamus.retryPick` method, `thalamus.refusal` broadcast)         | `observe` already calls `onRead({kind:"outcome"})` with `state:"refused"` possible (`localOutcomeRead`, `OUTCOMES`); the router still never passes `refusals`                           | C1   |
| 8   | The same retry rule as a pure function, `src/shared/thalamus-retry-pick.ts`, used by `thalamus.retryPick` and by the event; the page wires the two buttons in phase D                                                                   | Rewind: `rewindCall` in `tinker-ui/src/amygdala-ui.ts` (amygdala for Claude Code tabs, then `sessions.rewind` when "unsupported"); the retry send is `chat.send {model}`                | C1/D |
| 9   | Unchanged: `classifyTaskDomain` feeds `thalamusPlan`; Jev task reads stay counted                                                                                                                                                       | The prompt hook runs inside the worker, after model selection                                                                                                                           | —    |

**Where cooling is written, and what counts as a limit.** `recordFailedCandidateAttempt` receives every failed
candidate from `runWithModelFallback` (the auto-reply path, cron and the title suggester go through it). A limit is
`described.reason` of `rate_limit` or `billing`; `overloaded` (a 529) is the server being busy, not the supply being
spent, so it does not cool. Reset: `resolveRetryAfterSeconds(rawError, now)` (handles "~262 min", "resets 3:10pm
(Europe/Madrid)", an ISO instant); none → 30 minutes; at most 12 h (its own cap). A later limit never shortens an
earlier longer one. File `~/.openclaw/thalamus-cooling.json`, keyed by supply, written through a temp file and a
rename; expired entries are dropped on the next write and ignored on read. Under vitest with no injected path the
write is skipped, so no suite can touch the operator's file.

**The v4 per-call router reads the same rule.** `thalamus-board.ts: readThalamusBoard` adds `suggestion` (the dial
stop's entry, from the same `readThalamusTierDefaults`) and `cooling` to `ThalamusBoardLike`; `shadow.ts` passes
both to `routeCall` (`suggestion`, `cooling`, and `midThread` only in enforce). In `routeCall` the suggestion's
thread option is the pick unless it was vetoed or another option's quality beats `suggestion.quality × 1.10`
(`quality` is the AA index moved by the measured domain strength, `qualityOf`). `handPicked` still wins first.
`isHandPicked` is unchanged: a tab with a stored model override is never touched.

### UI choices to code (phase D, mapped now)

| UI choice                         | Where                                                                                                                                                                        | Evidence                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Dial wording                      | `tinker-ui/src/app.ts: BIAS3_STOPS` (`fast · balanced · smart` → `budget · default · smart`), `renderBiasDialRow`; the card chip `${d.tier} dial` follows the new wire names | `BIAS3_STOPS` indices 0/3/6; `whyPhrases` prints `d.tier` verbatim                                                                    |
| Suggestion line under the dial    | `renderBiasDialRow` + the new `thalamusSuggestions` map read from `prefrontal.thalamusDefaults` (`suggestions`)                                                              | The RPC keeps returning the old `defaults` view (high/medium/low → model string) so today's page does not break before D lands        |
| Picker right-click (kept)         | `app.ts` `budgetPanelEl.addEventListener("contextmenu", …)` ~26334, menu of `THALAMUS_TIER_LABELS`                                                                           | Calls `prefrontal.thalamusDefaults {tier, model}`; the tier keys become smart/default/budget; a newly assigned model gets effort low  |
| S / D / B letters                 | `thalamusTiersOf(modelId)` (model rows) and the effort buttons in `.model-think-slider-row` (`readThinkStop`)                                                                | The effort row is drawn by `renderSliderStops`; the effort pin is client-side (`effortPinBySession`), the role's effort is the file's |
| Right-click an effort assigns it  | a `contextmenu` listener on the effort stops → `prefrontal.thalamusDefaults {tier, model, effort}`                                                                           | Only for a model that already holds a role                                                                                            |
| Card: kept / moved / cooling      | `tinker-ui/src/panels/thalamus-turn.ts: whyPhrases` (`kept`, `moved`, `cooling`, `suggestion` block with `gainPct`, `untilMs`)                                               | Wire fields defined in B (`ThalamusTurnDecision.suggestion`)                                                                          |
| Two buttons with the model's logo | `amygdala-ui.ts: renderRefusalStrip` (the amygdala already draws a refusal strip with Rewind) + `thalamus.refusal` event + `thalamus.retryPick`                              | `rewindCall` then `chat.send {model}` for one turn (`chat.send` carries a per-turn `model`, protocol `logs-chat.ts` line 90)          |

**Both rewind paths.** Claude Code tabs: `amygdala2.rewind {sessionKey, turnId}`; built-in tabs: `sessions.rewind
{key}` (refused while a reply runs; branches the transcript before the last prompt; `undo` restores). The page already
tries the amygdala first and falls back on `capability:"unsupported"`. The one-turn retry is a plain `chat.send` with
`model: <retryPick.model>` after the rewind has put the prompt back; the per-turn model is the client's, so nothing
sticks after that turn.

### Tests per unit

- **B1** `thalamus-tier-defaults.test.ts` (names, default 3, new/old/mixed file, effort kept, bad ref dropped, write
  keeps the other stops); `thalamus-frontier.test.ts` (default 3; suggestion kept in general, kept inside 10 %, moved
  beyond it, unmeasured keeps, effort exact and nearest, reserved suggestion admitted); `thalamus-plan.test.ts`
  (vetoed suggestion → cause cooling/spent/capacity, absent from board → ignored, counterfactual cooling shift,
  chain behind a kept suggestion); `thalamus-turn-telemetry.test.ts` (kept / moved / cooling / best-of / bias);
  `model-selection.thalamus.test.ts` (kept, moved, cooling skip, unset dial = default stop, old file);
  `prefrontal` writer test (new keys, effort, legacy keys migrate, the `defaults` view stays).
- **B2** `thalamus-cooling.test.ts` (reset parsing three ways, 30 min default, billing yes, overloaded no, unknown supply
  no, never shortens, survives a fresh module, corrupt file, the vitest skip); `model-fallback` test (a rate-limit
  failure writes the injected file); `model-selection.thalamus.test.ts` (a 429 with a reset skips that supply on the
  next plan and the card says cooling).
- **B3** a replay over a copied decisions file, run from `scripts/thalamus-replay.ts`, report in the B status.
- **C1** `refusal.test.ts` (refused read → one event per turn, family, retry pick; unsure read → none; private source →
  null pick; dedup), `thalamus-retry-pick.test.ts` (best of another vendor, not cooling, not unfunded, capacity,
  approved providers), method test for `thalamus.retryPick`.
- **C2** `config` test (new keys, defaults false), `thalamus-route-call.test.ts` (midThread gate; suggestion kept /
  moved / vetoed), `shadow.test.ts` (suggestion and cooling reach `routeCall`; midThread only in enforce), `entry` or
  `leaf-and-preview` test (the staged file parses to decision 7 and `orchestrateAuto` picks in enforce with Jev mocked).
