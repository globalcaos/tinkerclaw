# Chat thinking indicator missing while the tab glows

**Date:** 2026-08-15
**Status:** ANALYSIS ONLY — no code was changed. Written as a handoff for the session
that currently owns `tinker-ui/src/app.ts`.
**File under analysis:** `tinker-ui/src/app.ts` (line numbers as of 2026-08-15)
**Method:** static read of the render / repaint graph. NOT reproduced live in a
browser — the UI was left untouched because another session is editing it.

---

## 1. Problem

A tab shows its activity glow (the tab bar knows that session is thinking), but the
chat pane for that same session shows no thinking indicator. The two surfaces are
supposed to be governed by one mechanism.

This is the _residue_ of the 2026-07-29 unification, not a regression of it. The
opposite symptom (chat lit, tab dark) was fixed then and stays fixed.

---

## 2. Root cause

**The unification covered the PREDICATE. It never covered the REPAINT TRIGGER.**

`run-state.ts` is the single reference point for _what "live" means_ — one precedence
rule, one membership predicate, one freshness bound. Every surface honours it. So the
four surfaces can no longer disagree about **the answer**.

They can still disagree about **when they last asked**. Three of them are on a clock.
The chat is not. Its answer can therefore be arbitrarily stale — in the worst case,
never refreshed at all.

### 2.1 The three branches of the chat indicator

`renderThinkingIndicator()` — `app.ts:10018` — in order:

| #   | Branch                                                                       | Lane            | Lines       |
| --- | ---------------------------------------------------------------------------- | --------------- | ----------- |
| 1   | `activeRuns` filtered by `runBelongsToViewedSession` + `clientRunIsFresh`    | client (lane C) | 10019–10097 |
| 2   | `sessionHasActiveRuns(sessionKey, viewedRow)` over the `sessions[]` snapshot | **server**      | 10105–10129 |
| 3   | the `sending` pending pill                                                   | local           | 10137–10166 |

Branch 2 is the branch added by the 2026-07-29 fork _specifically_ to fix
"glowing tab, idle chat" — its own comment at `:10099-10104` says exactly that. It is
the **only** branch that can light the chat when this browser holds no client run.

### 2.2 The server lane never repaints the chat

- `sessions[]` has **exactly one writer**: `loadSessions()` — the assignment is
  `app.ts:6711`.
- `loadSessions()` ends with `updateSelect(); updateSessionsPanel();` (`:6788–6789`).
  **`updateChat()` is not called.**
- `updateSessionsPanel()` (`:13621`) calls `syncTabActivityGlow()` on its very first
  line (`:13626`) → `tabsRunningNow()` (`:10979`) → the tab glow.
- The 5-second liveness clock `startLivenessRepaint()` (`:390–403`) calls
  `updateSessionsPanel()` + `updateBudgetPanel()`. **`updateChat()` is not in it.**
- `startThinkingTick()` (`:10190`) only rewrites `.thinking-elapsed` text and calls
  `updatePrefrontalTree()`. It never re-renders the chat — and it **self-terminates
  when `activeRuns` is empty** (`:10191–10200`), which is precisely the state in which
  branch 2 is the only branch that could fire.

`updateChat()` runs on: tab switch (`refreshViewedSessionIndicators()`, `:11225`),
send, and inbound chat/lifecycle events for the viewed session. Nothing else.

**Net effect:** the server lane paints the tab bar, the session rows and the models
count on a timer, and paints the chat _never_. The chat is not _late_ — there is no
timer that will ever correct it. It stays blank until the user does something.

### 2.3 When it bites

Any turn that produces no client-side events for this tab:

- a run that **started while you were on another tab** — every `activeRuns` write is
  viewed-gated (lane C, `run-state.ts:13-16`), so no entry is ever created;
- a turn this browser did not originate: cron, WhatsApp, an orchestrator / ORCA leg;
- the window after a page reload or a WS reconnect mid-turn.

In all of these `activeRuns` is empty for the session, branch 1 cannot fire, branch 2
holds the correct `live:true`, and nothing asks it.

### 2.4 Why the invariant looked satisfied

Two written rules collide:

- `run-state.ts:26` — _"This module is the SINGLE REFERENCE POINT… Surfaces must not
  re-derive any of it."_ Honoured. The chat calls the same resolver.
- `done-signals.md` **R2** (`:128–136`) — _"there is no UI-side stale-run watchdog…
  never on a scheduled/polled timer."_ That is **why** the chat has no clock,
  deliberately.

R2 was written about the **client** lane, where liveness arrives as events. The
2026-07-29 fork then grafted a **poll-only** lane (branch 2) into the chat indicator —
a value that by construction can only change when `loadSessions()` runs. A branch that
can only change on a poll now lives in the one surface forbidden from polling.

That is the entire gap.

### 2.5 What is NOT the cause (checked and excluded)

- **Not a predicate divergence.** Both surfaces call the identical
  `sessionHasActiveRuns(key, row)` (`:3597`) with a row found by the identical
  `rows.find(s => sessionKeyMatches(s.key, key))` expression — chat at `:10107-10109`,
  tabs at `:10987-10989`. Same inputs ⇒ same output.
- **Not `sessionKeyMatches` asymmetry.** `:1840-1849` matches both suffix directions.
- **Not the `runSetDisabled()` kill switch** (`forLiveness`, `:382`) — it is applied
  inside the shared adapter, so it hits both surfaces equally.
- **Not a missing server row.** A session absent from `sessions[]` yields
  `row = undefined` for _both_ callers, and the resolver returns not-live for both.

---

## 3. Proposed solution

### 3.1 Narrow fix (recommended, ~2 lines)

Put the chat inside the same liveness funnel the other three surfaces already use:

1. add `updateChat()` to `startLivenessRepaint()`'s interval body (`app.ts:396-402`),
   alongside `updateSessionsPanel()` / `updateBudgetPanel()`;
2. add `updateChat()` to the tail of `loadSessions()` (after `:6789`), so the paint
   happens on the same tick the snapshot is replaced rather than up to 5 s later.

Guard for scroll: use `updateChat(true)` (`skipScroll`) on the timer path — the
signature already supports it (`:10485`), and it is the established idiom for a
repaint that must not yank the viewport (see the pill relabel at `:5656`).

**This does not violate R2.** R2 forbids a UI timer that _clears_ a run — one that
"lies about doneness". This timer never clears anything: it re-reads the server's own
authoritative answer, which is literally the same call `syncTabActivityGlow()` already
makes every 5 s. It can only ever _add_ an indicator that the server says should be
there. Worth adding that sentence to R2 so the next reader does not delete the fix on
principle.

**Cost check before shipping:** `updateChat()` rewrites the message list. Confirm that
a 5 s full repaint does not (a) collapse open tool-detail expansions, (b) drop text
selection, or (c) re-trigger `decorateFractalReplyBubbles` / fractal anchor hydration
work. If any of those bite, prefer 3.2.

### 3.2 Alternative if a full `updateChat()` is too heavy

Extract the indicator into its own DOM node with a dedicated
`repaintThinkingIndicator()` that only rewrites the `.thinking-indicator` container,
and call _that_ from the liveness clock. Same trigger, far smaller blast radius, no
risk to the message list. Slightly more code, and it introduces a second render path
for the indicator that must be kept in step with `updateChat()`'s.

### 3.3 The structural fix (do this regardless of 3.1 vs 3.2)

State the missing invariant where the predicate one already lives. Suggested wording,
for `run-state.ts`'s header block, cross-referenced from `done-signals.md` §R2:

> **One oracle is not enough — every surface governed by `resolveSessionRunState` must
> also repaint on the SAME trigger.** A surface that reads the server lane but is
> repainted only by client-lane events will hold a stale answer indefinitely, which is
> indistinguishable from disagreeing with the other surfaces. The governed surfaces
> are: chat thinking indicator, tab-bar glow, sessions-panel row glow, models-panel
> count. All four repaint from `startLivenessRepaint()`.

Candidate `verify:` block for the bible optic that owns this (`done-signals.md` or
`tinker-ui.md`): assert that the body of `startLivenessRepaint` in `app.ts` mentions
all four repaint entry points, so removing the chat from the funnel fails the merge
gate instead of silently regressing.

---

## 4. Verification for whoever ships it

Reproduce first, then fix, then re-run the same red check:

1. Open two tabs. In tab B send a turn, then switch to tab A **before** the first
   delta lands.
2. Watch tab B's glow come on (≤5 s, on the `loadSessions()` tick).
3. Switch to tab B **without** sending anything. Pre-fix the indicator DOES appear
   here, because the tab switch calls `refreshViewedSessionIndicators()` →
   `updateChat()`. This step is the control, not the bug.
4. The actual red case: sit **in** tab B while a run is started for it from outside
   the browser (cron / WhatsApp / an orchestrator leg), so no lifecycle event is
   admitted for the viewed session. Pre-fix the tab glows and the chat stays empty
   indefinitely. Post-fix the chat lights within one liveness tick.
5. Confirm `data-state="server"` on the rendered indicator (`:10121`) — that attribute
   is exactly the marker that branch 2 fired.
6. `cd tinker-ui && npx vite build` must stay clean, and the `run-state` unit tests
   green. Remember there is **no typecheck for `tinker-ui`** — `vite build` (esbuild)
   is the only gate; `tsconfig.test.ui.json` covers `ui/**`, not `tinker-ui/**`.
