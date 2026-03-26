# Tinker UI — Design Bible

> Living document. Updated every time we work on Tinker UI features, fixes, or design changes.
> Location: `~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE.md` (tracked in GitHub fork)
> Last updated: 2026-03-26 (Gateway crash loop — missing dist/index.js after build wipe)

---

## 1. What Tinker Is

Tinker UI is the fork's **standalone command center** — a completely separate webchat frontend, not a skin on upstream. It replaces upstream's Lit-based webchat with a Vite + TypeScript + vanilla DOM single-page app.

**Why it exists:** Upstream `ui/` is kept 100% vanilla (zero fork patches) to eliminate merge conflicts forever. All UI customization lives exclusively in `tinker-ui/`, a fork-only directory that upstream never touches.

**Created:** 2026-02-27 (commit `5070018f0`)
**Migration:** Moved from patching `ui/` to standalone `tinker-ui/`, removing ~14 upstream touchpoints.

---

## 2. Architecture

```
tinker-ui/              ← Fork-only, zero merge risk
├── src/
│   ├── app.ts          ← Entire frontend (~5900+ lines)
│   ├── styles/base.css ← All styles (~510 lines)
│   ├── styles/*.jpg/png ← Natural textures (bark, moss, marble, earth, wood, sandpaper)
│   └── panels/
│       ├── context-timeline.ts   (772 lines)
│       ├── context-treemap.ts    (1038 lines)
│       ├── response-treemap.ts   (703 lines)
│       └── overseer-graph.ts     (541 lines)
├── index.html
├── package.json
└── vite.config.ts

extensions/tinker/      ← Fork-only gateway plugin
├── index.ts            ← Serves UI via registerHttpRoute
└── openclaw.plugin.json

extensions/hippocampus/ ← Fork-only plugin stub
├── index.ts            ← No-op register (code lives in src/memory/engram/)
└── openclaw.plugin.json
```

**Stack:** Vite 6 + TypeScript 5.7 + vanilla DOM (no framework)
**Dependencies:** `markdown-it` (rendering), `lit` (imported but unused — legacy)
**Port:** 18790 (dev), served at `/tinker/` via gateway plugin (prod)
**Auth:** Gateway token injected as `window.__TINKER_CONFIG` by plugin into `index.html`
**Client identity:** `webchat-ui`, role `operator`, scopes `["operator.admin"]`, caps `["tool-events"]`

### Communication with Gateway

| Channel                         | Purpose                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| WebSocket `/api/events`         | Lifecycle events, chat deltas, fallback errors, tool events, **context-anatomy push** |
| RPC `req(method, params)`       | Chat, history, session mgmt, anatomy data, forensic, overseer                         |
| REST `/api/context-anatomy/:sk` | Context token breakdown per turn (fallback polling)                                   |

---

## 3. Layout

```
┌────┬─────────────────────────────┬──────────────────┐
│LOGO│ Topbar      [📊🧠] [status]│                  │
│  ↘ │─────────────────────────────┤ Right Panels     │
│    │                             │ (3fr:1fr ratio)  │
│ 🖼 │ Chat Area (messages +       │ ┌──────────────┐ │
│ 💬 │  input + send button)       │ │Sessions      │ │
│────│                             │ ├──────────────┤ │
│ 📊 │  — OR —                     │ │Models [S/All]│ │
│ 🔗 │                             │ ├──────────────┤ │
│ 📄 │ Alt View (full-width tab    │ │Overseer Pills│ │
│ 📈 │  content when non-chat tab  │ └──────────────┘ │
│ ⏰ │  selected)                  ├──────────────────┤
│────│                             │                  │
│ 📁 │─────────────────────────────┤ Treemap tabs     │
│ ⚡ │ Context Timeline (bottom)   │                  │
│ 🖥️ │                             │                  │
│────│                             │                  │
│ ⚙️ │                             │                  │
│ 🐛 │                             │                  │
│ 📜 │                             │                  │
└────┴─────────────────────────────┴──────────────────┘

Grid: 48px sidebar | 3fr content | 1fr right
Rows: 48px topbar | 3fr content | 1fr bottom
Sidebar: spans rows 1-2 (column 1), padding-top 140px for logo clearance
Topbar: column 2 only, row 1. padding-left 140px to clear logo overhang
Right panels: span rows 1-2 (touch top of window)
Alt-view: spans columns 2-3, rows 1-3 when active (hides chat + right + bottom)
Logo: position:absolute in topbar, z-index 50, overlaps sidebar + chat corner
```

### Floating Logo (2026-03-08)

Logo (108px, `icon.png`) floats over the sidebar/chat corner via `position:absolute` on `.topbar .logo`.

- **Position:** `top:12px; left:-38px` (relative to topbar col 2 — bleeds left over sidebar)
- **z-index:** 50 (above all grid content)
- **Effect:** `drop-shadow(0 2px 8px rgba(0,0,0,.6))` for depth
- **Click:** "New session" button (`#new-session-btn`)
- **Sidebar clearance:** `padding-top:140px` pushes nav icons below the logo
- **Topbar clearance:** `padding-left:140px` pushes toolbar icons right of the logo

### Sidebar Navigation (2026-03-08)

48px left sidebar with 13 Lucide-style SVG icon buttons matching upstream tabs.
Buttons grouped with `nav-sep` dividers into 4 groups (same as upstream):

1. **Chat** (olive green `#6b8e23`)
2. **Control:** Overview (`#4ade80`), Channels (`#60a5fa`), Sessions (`#c084fc`), Usage (`#f59e0b`), Cron (`#fb923c`)
3. **Agent:** Agents (`#34d399`), Skills (`#facc15`), Nodes (`#38bdf8`)
4. **Settings:** Config (`#a1a1aa`), Debug (`#f87171`), Logs (`#94a3b8`)

Active tab shown with `nav-active` class: surface2 bg + inset 3px accent left border.
Tooltip text on mouseover via `data-hint` attribute + global hint system.

### Alt-View Panel (2026-03-08)

When a non-chat tab is clicked, the chat area, topbar, timeline, and right panels
are hidden (`display:none`) and a full-width `.alt-view` panel takes over columns 2-3.
Content fetched from gateway RPC methods and rendered as `.alt-card` elements.

| Tab      | RPC Method(s)                                        | Content                                                                                                                                                                 |
| -------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | `status`, `health`, `system-presence`, `cron.status` | Connection card, system stats, presence list, health JSON                                                                                                               |
| Channels | `channels.status`                                    | Per-channel cards (status/running/connected/linked), account cards, WhatsApp QR/Relink/Probe/Logout, Telegram probe                                                     |
| Sessions | `sessions.list`                                      | Filterable table (active-within/sort/limit/global/unknown), thinking-level dropdown per row, input/output/total token split, model+provider columns, delete             |
| Usage    | `sessions.usage`, `usage.cost`                       | Date range presets (Today/7d/30d/90d), 4-card summary (tokens/cost/insights/breakdown), CSS bar chart for daily cost, session usage table sorted by tokens, export JSON |
| Cron     | `cron.status`, `cron.list`, `cron.runs`              | Summary strip, job cards with schedule/payload/delivery/status, per-job actions (enable/disable/run/run-if-due/remove), run history panel with job filter               |
| Agents   | `agents.list`, `tools.catalog`                       | Agent cards with emoji/description/model/provider/fallback chain/channels/skills, tool profiles grid with tool chips, tool groups                                       |
| Skills   | `skills.status`                                      | Grouped cards with version/author, enable/disable toggle, missing deps detail, API key status, issue indicators                                                         |
| Nodes    | `node.list`, `device.pair.list`                      | Pending device requests (approve/reject), paired devices with roles/last-seen/token, exec node cards with online/offline badge + capabilities                           |
| Config   | `config.get`, `config.schema`, `models.list`         | Status card, models list, section navigation buttons, section detail view, validation issues, apply/export actions, full config JSON                                    |
| Debug    | `status`, `health`, `last-heartbeat`, `models.list`  | Local state card, JSON snapshots (scrollable), RPC console with preset buttons, call history with replay, clear history                                                 |
| Logs     | `logs.tail` (polled 3s)                              | Structured log parsing (time/level/subsystem/message columns), text filter + level toggles, auto-follow, export/clear, line counter, 2000-line DOM cap                  |

Clicking Chat tab returns to normal layout with all panels restored.

### Collapsible Panels (2026-03-08)

Two toolbar icons toggle panel visibility with smooth CSS grid animations:

| Button      | Icon           | Hint       | Toggles                                            | CSS class               |
| ----------- | -------------- | ---------- | -------------------------------------------------- | ----------------------- |
| 📊 Timeline | `#tb-timeline` | "Timeline" | Bottom row (context-timeline + bottom-right-panel) | `#app.bottom-collapsed` |
| 🧠 Models   | `#tb-models`   | "Models"   | Right column (right-panels + bottom-right-panel)   | `#app.right-collapsed`  |

- **Animation:** `grid-template-rows` / `grid-template-columns` transition 0.5s with `cubic-bezier(.25,.1,.25,1)`. Uses matching `fr` units (`3fr 1fr` → `3fr 0fr`) for smooth interpolation.
- **Opacity stagger:** On collapse, content fades out fast (0.15s) before the grid shrinks. On expand, content fades in after a 0.15s delay.
- **Active state:** `.tb-active` class gives icon a warm glow (`box-shadow: 0 0 8px rgba(193,154,107,.35)`) + accent color + surface2 background.
- Both start active (panels visible). Both can be collapsed simultaneously.

---

## 4. Visual Language

### Theme — "Earth" (dark, textured)

- **Dark earthy color scheme**, `color-scheme: dark`
- Background: `#1a1510` (deep brown-black)
- Surface: `#2a2318` / `#332b1f` (warm dark brown)
- Text: `#e8e0d4` (warm off-white)
- Accent: `#c19a6b` (sandstone gold)
- Natural textures layered via CSS `background-image` with `background-blend-mode: multiply`:
  - Chat area: `earth-chat-bg.jpg` (opacity 0.15)
  - User bubbles: `moss-input.jpg` on `#4B5338` (olive green)
  - Assistant bubbles: `marble-assistant.jpg` on `#5a4a3a` (warm brown)
  - Input bar: `moss-input.jpg` on `#4B5338`
  - Right panels: `wood-panel.jpg` on `#6B5545`
  - Overseer graph: `wood-panel.jpg` on `#4E3B31` with multiply blend (darker variant)
  - Timeline / bottom-right: `bark-timeline.jpg` on `#4E3B31`
  - Thinking messages: `earth-thinking.jpg` (opacity 0.10)
  - Treemap footer: `bark-timeline.jpg` on `#4E3B31`
- Timeline/panel text: `#7CFC00` (lawn green) for data readouts
- Muted text: `#9a8e7a` (warm grey)

### User Bubbles

- Background: moss texture on `#4B5338` (olive)
- Text: `#dce8cc` (pale green)
- Border: `rgba(107,142,35,0.5)` (olive green)

### Assistant Bubbles

- Background: marble texture on `#5a4a3a` (warm brown)
- Text: `#f0c878` (warm amber-gold)

### Provider Colors (used across model glow, timeline, treemap)

| Provider  | Color       | Hex       |
| --------- | ----------- | --------- |
| Anthropic | Olive Green | `#6b8e23` |
| Google    | Green       | `#16a34a` |
| OpenAI    | Gray        | `#6b7280` |
| Ollama    | Amber       | `#ca8a04` |
| DeepSeek  | Blue        | `#2563eb` |
| Meta      | Blue        | `#1877f2` |
| Mistral   | Orange      | `#f97316` |

### Treemap Segment Colors

| Segment       | Color              |
| ------------- | ------------------ |
| systemPrompt  | `#6366f1` (indigo) |
| injectedFiles | `#22c55e` (green)  |
| skills        | `#eab308` (yellow) |
| toolSchemas   | `#f97316` (orange) |
| conversation  | `#ef4444` (red)    |
| toolResults   | `#a855f7` (purple) |
| userMessage   | `#94a3b8` (slate)  |

### Error Styling

- Background: `rgba(239, 68, 68, 0.15)`
- Text: `#fca5a5`
- Border: `rgba(239, 68, 68, 0.3)`

### Animations

- **Model breathe:** 2s ease-in-out infinite box-shadow pulse in olive green (`rgba(107,142,35,…)`)
- **Thinking dots:** 3 bouncing spans with olive green `--thinking-dot-color: #6b8e23`
- ~~**Timeline placeholder:**~~ Removed 2026-03-08. Bars only appear when real data arrives.
- **Message flash:** `msg-flash` box-shadow pulse when scrolling to a message from timeline
- **Panel collapse/expand:** 0.5s grid-template transition with staggered opacity (content fades before/after grid resizes)
- **Toolbar icon glow:** `.tb-active` warm accent glow with 0.25s box-shadow transition

---

## 5. Feature Registry

### Status Legend

| Status              | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `CONFIRMED`         | Code deployed, manually tested and verified working. Includes date.     |
| `DEPLOYED-UNTESTED` | Code is in the codebase and built, but not verified after latest merge. |
| `NOT-WORKING`       | Known broken. Includes reason.                                          |
| `PLANNED`           | Design exists, code not yet written.                                    |

---

### 5.1 Markdown Rendering

- **Status:** `CONFIRMED` (2026-03-06)
- **Deployed:** 2026-03-04 (commit `b8b6caf19`)
- **What:** Replaced basic regex `md()` with `markdown-it` parser
- **Config:** `html: false, linkify: true, breaks: true`
- **Post-processing:** Jarvis voice styling — `**Jarvis:** *text*` → `.jarvis-voice` (purple italic)
- **Table fix (2026-03-06):** `md()` pre-inserts a blank line before table-header rows (`| ... |\n|---...|\n`) so markdown-it parses them even when directly after a list or paragraph. Tables also get `overflow-x:auto;display:block;max-width:100%` for horizontal scroll on wide tables.
- **CSS:** Styles for `.msg a/ul/ol/li/blockquote/h1-h6/table/th/td/hr`
- **Files:** `app.ts` (import + parser init + md function), `base.css` (element styles)
- **Dep:** `markdown-it@^14.1.1` in tinker-ui/package.json
- **Known side effect:** `pnpm add` in tinker-ui can break `better-sqlite3` hoisted symlinks — fix with `pnpm add -w better-sqlite3 bindings` at root

### 5.2 Active Model Breathing Glow

- **Status:** `CONFIRMED` (2026-03-17, glow isolation verified)
- **Deployed:** 2026-03-02 (commits `81800be95`, `5f9a1f5c1`)
- **What:** Model rows in right panel glow with provider-colored breathing animation when a run is active on that model. Per-model agent count badge shows parallel usage. For multi-key providers (e.g., anthropic with 3 auth profiles), only the active auth profile row glows.
- **Architecture:** Runner emits lifecycle `start` events with `model`, `modelProvider`, and `authProfileId`. Gateway (`server-chat.ts`) preserves runner-provided fields when present, falls back to `resolveSessionModelRef()` for events without model info (e.g., CLI providers). UI maintains `activeRuns` Map keyed by runId, derives per-model/per-profile counts, re-renders budget panel.
- **State:** `activeRuns` Map keyed by runId → `{ model, provider, authProfileId, startedAt }`. Persisted to `sessionStorage["tinker-activeRuns"]`. Stale runs pruned after 5 min.
- **CSS:** `@keyframes model-breathe`, `.model-row.model-live`, `.model-agent-count`
- **Gateway patch:** `server-chat.ts` — prefers runner-provided model/provider/authProfileId over session-entry resolution
- **Files:** `app.ts` (tracking + rendering), `base.css` (animation), `server-chat.ts` (enrichment), `pi-embedded-subscribe.handlers.lifecycle.ts` (authProfileId source)
- **Bug fix #1 (2026-03-05):** Multi-key providers never glowed. `getAuthKeyCounts` stored count under model ID (authProfileId was undefined), but multi-key rendering looked up by auth profile key — always 0. Fix: fall back to model-level count when per-key count is 0.
- **Bug fix #2 (2026-03-05):** All 3 auth key rows glowed simultaneously instead of just the active one. Root cause: `server-chat.ts` enrichment was overwriting the runner-provided `model`/`modelProvider` with session-entry values via `resolveSessionModelRef()`, discarding the runner-provided `authProfileId` context. Fix: when lifecycle events already carry `model` and `modelProvider` from the runner, preserve them and pass through `authProfileId` instead of overwriting with session-entry resolution.
- **Bug fix #3 (2026-03-17):** All 3 auth key rows STILL glowed simultaneously. Root cause: model-fallback system doesn't pass `authProfileId` to the `run` callback, so embedded agent's `handleAgentStart` emits lifecycle `start` without `authProfileId`. UI fallback `modelCount` caused all rows to glow. Fix: two-part — (a) UI infers `authProfileId` from `modelConfigData.authOrder` on `start` events, preferring profiles with fresh budget data and no errors; (b) `renderAuthKeyRows` only broadcasts `modelCount` to all rows when NO per-key counts exist (`hasAnyKeyCount` guard).
- **Bug fix #4 (2026-03-17):** Stale `providerErrors` in localStorage caused wrong profile to show errors after gateway restart. Fix: `loadBudget()` now clears `providerErrors` for profiles that have fresh `claudeProfiles` usage data.
- **Bug fix #5 (2026-03-22):** Glow never appeared for any run. Root cause: upstream lifecycle `start`/`end`/`error` events (from `agent-command.ts`) carry `sessionKey` at the top level of the WS payload (enriched by `server-chat.ts`) but NOT inside `data`. The UI checked only `p.data.sessionKey`, silently dropping all upstream lifecycle events — so `activeRuns` was never populated. Fix: fall back to `p.sessionKey` when `p.data.sessionKey` is absent (`p.data.sessionKey ?? p.sessionKey`). Fork-specific events (`round-start`, `fallback-error`, etc.) still use their explicit `data.sessionKey`.

### 5.3 Per-Profile Fallback Error Visibility

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03 (multiple commits)
- **What:** When model fallback fires, each failed attempt shows as a red error bubble in chat:
  - Per-profile: `↳ model profileId [profile N/M] — reason → trying next-profile`
  - Per-model: `⚠ [N/M] model (profileId) failed (reason) → falling back to next-model (provider)`
- **Fallback chain visibility (2026-03-21):** Error messages now show what comes next in the fallback chain instead of generic "jumping to backup". Profile-level errors show `→ trying cli-gm` (next auth profile). Model-level errors show `→ falling back to gemini-3.1-pro (google)` (next model+provider). When no next target exists, the suffix is omitted.
- **Retry button:** `↻` on each error bubble — clears error state, re-sends last user message
- **Error descriptions:** `describeError()` translates raw codes to plain English (billing cap, rate limited, OAuth revoked, overloaded, etc.)
- **Error scoping (2026-03-09):** `providerErrors` Map keys are scoped to the most specific level available:
  - `fallback-profile-error` → keyed by `profileId` (e.g., `"anthropic:cli-sv"`)
  - `fallback-error` → keyed by `failedProfileId || failedModel || failedProvider` (prevents provider-level bleed)
  - Rendering lookups fall back to `modelId` (not bare provider) — errors only show on the specific model that failed
  - **Per-profile clearing (2026-03-09):** Lifecycle `start` handler only clears the specific `authProfileId` that succeeded + the `startModel` key. Does NOT wipe all profiles of the same provider — so when cli-sv hits rate limit and cli-gm succeeds, cli-sv's error badge persists correctly.
  - Clearing logic (start phase, health poll, retry) also clears model-keyed entries (`provider/model` pattern)
- **Gateway patches:** `run.ts` (6 emission sites for `fallback-profile-error`), `model-fallback.ts` (`onError` for cooldown skips), `followup-runner.ts` + `agent-runner-execution.ts` (`failedProfileId` extraction + `onError` for `fallback-error`)
- **Files:** `app.ts` (handlers + rendering + retry), `run.ts`, `model-fallback.ts`, `followup-runner.ts`, `agent-runner-execution.ts`
- **Merge-guardian checks:** `fallback-profile-error` in run.ts, `failedProfileId` in followup-runner.ts
- **Auth chain cleanup (2026-03-22):** Removed `anthropic:cli-sv` from config (SV account deleted — org rejects OAuth with 403 `permission_error`). Also purged ghost `anthropic:oauth-gm` profile from `auth-profiles.json` store (stale OAuth token, was being rediscovered by profile resolver despite not being in `openclaw.json` auth.order — caused spurious 403 errors before fallback to `cli-gm`). Cleared stale `anthropic:api` billing cooldown. Auth order now: `cli-gm → api` (two profiles only, no ghosts). Known issue: first-profile failure in `run.ts:812` catch block doesn't emit `fallback-profile-error` event — silent skip makes it invisible in the side panel.

### 5.4 Error Message Persistence

- **Status:** `CONFIRMED` (2026-03-09)
- **Deployed:** 2026-03-03 (chat bubbles), 2026-03-09 (provider error state)
- **What:** Two persistence layers:
  1. **Chat error bubbles:** survive page refresh via `localStorage["tinker-errors"]`. Functions: `persistErrorMsg(sk, msg)`, `loadPersistedErrors(sk)`, `clearPersistedErrors(sk)`. Clear trigger: successful response (`state === "final"`)
  2. **Provider error state:** `providerErrors` Map persisted to `localStorage["tinker-providerErrors"]` with 2-hour TTL. Functions: `persistProviderErrors()`, `restoreProviderErrors()`. Restored on page load — errored model rows show red backfill immediately after refresh. Entries older than 2h are auto-pruned on restore.
- **Files:** `app.ts` (persist call sites + load on init + clear on success)

### 5.5 Session Delete from Right Panel

- **Status:** `CONFIRMED` (2026-03-05)
- **Deployed:** 2026-03-04 (commit `b8b6caf19`)
- **What:** Users can delete non-main sessions from the sessions panel. Upstream blocks webchat from deleting sessions.
- **Gateway patch:** `sessions.ts` — 3-line early return before the webchat rejection guard. Guard string: `"Allow webchat delete"`. Auto-applied by `apply-fork-wiring.mjs` → `patchSessions()`.
- **Files:** `app.ts` (delete button + handler), `sessions.ts` (bypass guard)

### 5.6 Live Tool Call Display

- **Status:** `CONFIRMED` (2026-03-08)
- **Deployed:** 2026-03-03 (commit `98f72f4c1`), **rewritten 2026-03-08** (commit `b4da1e0d5`)
- **What:** Tool `start`/`result` events render immediately in chat as expandable rows with human-readable summaries. Tool calls are interlaced with thinking bubbles during live streaming.
- **Architecture (2026-03-08):** Tool events push `_temporary` messages into `messages[]` (`tool_use` on start, `tool_result` on result). No separate `liveToolCalls` Map — tools render through the same `renderMsg()` path as finalized messages.
- **Tool summaries:** `toolSummary()` covers 20+ tools (exec, read, edit, write, web_search, browser, message, whatsapp_history, sessions_spawn, subagents, tts, etc.)
- **Expanded detail view:** Shows actual command/diff with del/ins formatting (red strikethrough old, green new)
- **Status icons:** `⋯` (pending), `✓` (ok), `✗` (error)
- **Files:** `app.ts` (toolSummary + toolExpandedDetail + rendering)

### 5.7 Thinking Indicator (Animated)

- **Status:** `CONFIRMED` (2026-03-10)
- **Deployed:** 2026-03-03 (commit `98f72f4c1`), updated 2026-03-10 (commit `d623c8181`)
- **What:** During active runs, bouncing dots in provider color + model name + elapsed timer. Hover reveals "Stop" alongside the dots and label (not replacing them).
- **States:** Pending (olive "sending..." + Stop on hover), Active (colored dots + model + timer + Stop on hover)
- **Stop button:** Both pending and active states show Stop on hover. Delegated click handler on `#messages` matches `.thinking-stop` inside any `.thinking-run` (no longer requires `data-run-id`). Calls `abort()` which sends `chat.abort` + clears `activeRuns` optimistically.
- **Hover behavior (2026-03-10):** Dots, model name, and elapsed time stay visible on hover — Stop button appears to the right via `margin-left:auto` (no longer an absolute overlay that hides everything). Red hover tint applies to both pending and active states.
- **Timer:** `startThinkingTick()` updates `.thinking-elapsed` span every 1s without re-rendering
- **Cleanup:** 3s delay after run ends to prevent flash
- **CSS:** `.thinking-run`, `.thinking-dots span` (bounce animation), `.thinking-stop` (inline, right-aligned)
- **Files:** `app.ts`, `base.css`
- **Bug fix (2026-03-06):** Stop button didn't work — see Bug Fix Log §7

### 5.8 Thinking Bubble Interlacing

- **Status:** `CONFIRMED` (2026-03-09), **REWORKED** (2026-03-20), **FIXED** (2026-03-23, 2026-03-26)
- **Deployed:** 2026-03-03 (commit `98f72f4c1`), rewritten 2026-03-08 (commit `b4da1e0d5`), fixed 2026-03-09 (commit `f211e5015`), reworked 2026-03-20 (commits `ceb73596b` + `1792fdaf6` + `49d28965f` + `0b71592c1`), **fixed 2026-03-23** (restored intermediate text classification), **fixed 2026-03-26** (segment preservation + thinking flicker)
- **What:** Native `type: "thinking"` blocks render as thinking bubbles. Intermediate text messages (model preamble/commentary before tool calls) are classified as thinking and collapse into the reasoning group. Only the last text message in a finalized run is the visible answer.
- **Architecture (2026-03-23 fix — hybrid classification):**
  - **Core principle:** Native `thinking` blocks always get thinking styling. Intermediate text messages (all except the last in a run) are also classified as thinking — they're the model's reasoning process, not the final answer.
  - **Implicit state transitions:** `delta` handler resets `thinkingMsgIdx` to -1 (guards against dropped `thinking_end`). `thinking_delta` handler resets `streamMsgIdx` to -1 (freezes text segment when thinking starts).
  - **During streaming:** `frozenTextEnd` splits text at tool-call boundaries into separate temps. Frozen text messages (not the active stream at `streamMsgIdx`) are classified as thinking. The active stream renders as normal assistant text.
  - **On finalization (2026-03-26 fix):** Segmented temp text bubbles are preserved (promoted as-is). Only the last text segment (after last tool call) is updated with the server's authoritative text to catch throttled tokens. Previous behavior concatenated ALL text segments into one blob, destroying the thinking/answer separation.
  - **thinkingSet (2026-03-26 fix):** Messages with exclusively `thinking` blocks (no text) are always added. All text messages except the last are added regardless of streaming state. Previous `isCurrentRun` check emptied the thinking set during streaming, causing bubbles to flicker between thinking and normal style on every delta/tool event cycle.
  - **Thinking flicker bug (2026-03-26):** `isCurrentRun` guard (`streamMsgIdx >= 0 → intermediates = []`) caused all bubbles to flash yellow on every delta, then restore thinking style on every tool start. Removed — `slice(0,-1)` already excludes the live bubble correctly.
  - **Reasoning group:** Contains thinking blocks + tool calls + intermediate text messages. Only the last text message renders as the final answer outside the group.
  - `isRunBoundary()` skips `role: "user"` messages that only contain `tool_result` blocks — keeps the entire response as one run for proper grouping.
  - **Reset points (7):** ws.onclose, final/error/abort, tool_start (frozenTextEnd only), loadChat, retryProvider, abort(), new-session
  - **Removed (2026-03-20):** `findSentenceEnd()`, `mergeSentenceContinuations()`, `[final-debug]` console.warn calls
  - **Restored (2026-03-23):** `assistantTextIndices` classification. **Removed (2026-03-23):** server text merge (replaced all text with accumulated buffer). **Removed (2026-03-26):** `isCurrentRun` guard (caused thinking flicker). **Fixed (2026-03-26):** finalization now preserves segmented text bubbles instead of concatenating into one blob.
- **CSS:** `.msg.msg-thinking` (earth-thinking texture overlay at 10% opacity, 12px font, #d4c4a8 color), `.thinking-label` (uppercase brown label)
- **Files:** `app.ts`, `base.css`

### 5.8a Sentence Continuation Merge

- **Status:** `REMOVED` (2026-03-20)
- **Deployed:** 2026-03-09 (commit `ccd302837`), **removed 2026-03-20** (commit `0b71592c1`)
- **What:** Was: merge sentence fragments split by tool calls back into previous bubbles. Superseded by §5.8 text segment merge — all text temps are now merged into a single answer message using the server's authoritative text on finalization. The sentence-level heuristic is no longer needed.
- **Removed code:** `findSentenceEnd()`, `mergeSentenceContinuations()`, call site in `chat:final` handler

### 5.8b Reasoning Group Auto-Collapse

- **Status:** `CONFIRMED` (2026-03-09)
- **Deployed:** 2026-03-08 (commit `584294a2b`), **updated 2026-03-09** (commit `f211e5015`)
- **What:** When a run completes, all intermediate content (thinking bubbles, tool rows, system messages) auto-collapses into a single expandable "Reasoning (N steps, M tool calls)" header. Chat primarily shows user prompts and final answers.
- **Architecture:**
  - `updateChat()` render loop splits messages into runs (bounded by `isRunBoundary()` — real user messages, NOT tool_result user messages).
  - For each completed run (no `_temporary` messages, `streamMsgIdx < 0`), intermediate messages wrap in `.reasoning-group`.
  - Collapsed by default. Toggle via `expandedTools` Set, keyed by `rg-{firstIntermediateIdx}`.
  - During streaming: intermediates render with thinking style, active stream renders normally. After finalization: auto-collapse with thinking style on intermediates.
  - After 2026-03-26 fix: thinking style applies consistently during streaming (no more flicker). Finalization preserves segmented text bubbles — each message keeps its streamed content.
  - Tool count only includes tools in intermediates (not the final answer).
- **CSS:** `.reasoning-group` (margin wrapper), `.reasoning-header` (green left border, surface2 bg, clickable), `.reasoning-content` (indented, border-left)
- **Files:** `app.ts`, `base.css`

### 5.8c Thinking Block Preservation (Thinking vs Final Output)

- **Status:** `CONFIRMED` (2026-03-15), **FIXED** (2026-03-16, commits `dea649781` + `19a1c0278` + `f9b0eb50a` + `d349a325c`)
- **Deployed:** 2026-03-15 (commit `fff191450`), **fixed 2026-03-16** (commits `dea649781` + `19a1c0278` + `f9b0eb50a` + `d349a325c`)
- **What:** Anthropic's native `type: "thinking"` content blocks are now routed through the gateway as distinct `chat` events, so the Tinker UI can render thinking text in dedicated thinking bubbles cleanly separated from the final answer. Previously, `dropThinkingBlocks()` stripped thinking from all messages, and the gateway only emitted `type: "text"` — making thinking and output indistinguishable.
- **Architecture:**
  - **Layer 1 — Agent events:** `emitReasoningStream()` in `pi-embedded-subscribe.ts` already emitted `emitAgentEvent({ stream: "thinking" })`. Added `emitAgentEvent({ stream: "thinking", data: { phase: "end" } })` to `emitReasoningEnd()` in `handlers.messages.ts`.
  - **Layer 2 — Gateway:** `server-chat.ts` now handles `evt.stream === "thinking"` events. Thinking deltas → `state: "thinking_delta"` (150ms throttled, `thinking:${clientRunId}` key). Thinking end → `state: "thinking_end"`. Both suppressed for heartbeat runs.
  - **Layer 3 — Tinker UI:** `thinkingMsgIdx` (parallel to `streamMsgIdx`) tracks the current streaming thinking temporary message. `thinking_delta` creates/updates thinking temp messages with `content: [{ type: "thinking", text }]`. `thinking_end` freezes the thinking message (`thinkingMsgIdx = -1`).
  - **Rendering:** `type: "thinking"` content blocks always render with `.msg-thinking` class + "Thinking:" label, regardless of position in the run. `thinkingSet` detection: messages with ONLY `type: "thinking"` blocks (no text) are added to `thinkingSet`. Text messages are NEVER in thinkingSet — the model's classification is trusted (see §5.8 2026-03-20 rework). Messages with both thinking + text blocks are treated as text messages — thinking blocks render via their own handler, text blocks get normal styling.
  - **What stays untouched:** `dropThinkingBlocks()` (still strips thinking from transcripts/history), the `state: "delta"` text path (only carries final output), other delivery channels (WhatsApp). ~~sentence-continuation merging~~ removed in 2026-03-20 rework (§5.8a).
  - **Bug fix (2026-03-20):** Error-path `_partial` preservation checked `c.thinking?.trim()` but thinking blocks use `c.text`. Thinking temps on error path were never detected as having content → filtered out instead of preserved. Fixed to `c.text?.trim()`.
  - **Non-Anthropic providers:** Models without native thinking blocks (Ollama, Google, OpenAI) continue as before — all text arrives as `type: "text"` with no separation. Heuristic splitting noted as future enhancement.
  - **Tab state:** `thinkingMsgIdx` included in `TabState` interface for tab-switching consistency.
  - **Reset points (7):** ws.onclose, final/error/abort, send, retryProvider, abort(), clear, thinking_end
- **2026-03-16 Fix — 3 bugs prevented thinking from working:**
  1. **`reasoningLevel` defaulted to "off" when thinking active** — `get-reply-directives.ts` line 420 blocked auto-enable when `thinkingActive`. Fixed: now auto-enables `"stream"` (not `"on"`) — stream mode only affects WebSocket broadcast, NOT messaging block replies (WhatsApp/Telegram).
  2. **`streamReasoning` required `onReasoningStream` callback** — `pi-embedded-subscribe.ts` line 48 gated `streamReasoning` on callback existence. But the `emitAgentEvent` broadcast to the gateway is independent of the callback. Fixed: `streamReasoning = reasoningMode === "stream"` (no callback check). Callback called with optional chaining.
  3. **Thinking temps stripped on finalization** — `app.ts` final handler removed ALL non-tool temporary messages, including thinking temps. Fixed: both finalization paths now preserve `type: "thinking"` temporary messages (promoted to permanent alongside tool messages).
- **2026-03-16 Fix round 2 — 3 deeper rendering bugs (commit `19a1c0278`):** 4. **`isCurrentRun` oscillation** — `streamMsgIdx` is -1 between tool calls and during thinking-only streaming. `isCurrentRun` only checked `streamMsgIdx >= 0`, so text temps flipped between thinking/normal style on each `updateChat()`. Fixed: now also checks `thinkingMsgIdx >= 0` and presence of `_temporary` messages in the run. 5. **"Reasoning:" prefix in agent events** — `formatReasoningMessage()` wraps text in `Reasoning:\n_italic_` for WhatsApp/Telegram. Agent events passed this formatted text → Tinker UI showed "Thinking: Reasoning: _italic text_". Fixed: agent events send raw trimmed text; only the messaging callback gets formatted text. 6. **Multi-round thinking duplication** — `extractAssistantThinking(msg)` returns ALL thinking blocks from the partial message. Round 2's thinking temp got round 1 + round 2 text. Fixed: new `currentThinkingBlock` state field tracks per-block text using SDK deltas. Reset on `thinking_end` along with `lastStreamedReasoning`, so each round starts fresh. 7. **All streaming text is thinking** (commit `f9b0eb50a`) — ~~during streaming, ALL text temps render as thinking bubbles~~ **SUPERSEDED by 2026-03-20 rework**: text is never classified as thinking. The model's own `thinking`/`text` block type classification is trusted. 8. **Promote temps, don't replace with server text** (commit `d349a325c`, -72 lines) — ~~ROOT CAUSE of "thinking prepended to answer" — promoted temps keep segmented text, thinkingSet classifies all-but-last as intermediates~~ **SUPERSEDED by 2026-03-20 rework**: temps are promoted AND text segments merged into one using server's authoritative text. The thinkingSet heuristic that classified text as thinking was the actual root cause of 4 bugs (repeated thinking, stale bubbles, Jarvis prefix in thinking box, thinking patterns in answer). See §5.8.
- **Fork maintenance:** Merge guardian checks for `phase.*end` in `handlers.messages.ts`, `thinking_delta`/`thinking_end` in `server-chat.ts`, `currentThinkingBlock` in `handlers.types.ts`. After upstream merge: verify `get-reply-directives.ts` still has the `thinkingActive → "stream"` branch, `pi-embedded-subscribe.ts` `streamReasoning` is not re-gated on callback, and `currentThinkingBlock` exists in the subscribe state.
- **Files:** `pi-embedded-subscribe.handlers.messages.ts`, `pi-embedded-subscribe.handlers.types.ts`, `pi-embedded-subscribe.ts`, `get-reply-directives.ts`, `server-chat.ts`, `app.ts`, `merge-guardian.sh`

### 5.9 Context Timeline

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03 (commit `1ba87b077`), improved 2026-03-06 (commit `ddd82e8f0`)
- **What:** Horizontal scrollable bar chart at bottom showing per-round (per-API-call) context usage. Each LLM API call = one bar. A turn with 3 tool-use rounds shows 3 bars grouped together.
- **Ring buffer:** Last 200 entries
- **Bar content:** Provider icon (SVG) + model name + timestamp + stacked token segments by type
- **Click behavior:** Scrolls chat to matching user message (smooth scroll + flash highlight), loads context/response treemap
- **Response bar click (2026-03-10):** Shows round detail panel — output tokens, duration, stop reason, and per-tool breakdown (name, duration, chars, error status)
- **Modes:** "session" (current session) vs "all sessions" filter — toggle switch (replaced button in `ddd82e8f0`)
- **No placeholders:** Bars only appear when real anatomy data arrives (placeholder system removed 2026-03-08, commit `6656b1c63`). No more pending/active/failed states or glowing animations.
- **Instant rendering via WebSocket push (2026-03-09):** Anatomy events pushed over WebSocket (`phase: "context-anatomy"`) immediately after JSONL write — no more 800ms polling delay. Pre-prompt bar appears instantly when prompt is sent; post-turn bar updates with response tokens when turn completes. HTTP polls kept as fallback. Forensic dump made fire-and-forget so it doesn't block anatomy delivery. Files: `attempt-hooks.ts` (emitAgentEvent), `app.ts` (handler).
- **Round-level observability (2026-03-10):** Each LLM API call gets its own timeline bar. Four new lifecycle event phases:
  - `round-start` → new bar appears immediately (translucent placeholder until anatomy arrives)
  - `round-complete` → purple response bar appears with real output tokens, duration, stop reason
  - `tool-exec-start` / `tool-exec-complete` → tool executions tracked per-round, visible in response detail
  - No more estimated response tokens — purple bar absent until real data exists
  - `pushEvent` merges into existing bar when `runId` + `roundNumber` match (avoids duplicates when anatomy enriches round bars)
  - Tooltip: `R2 · sonnet · 46.8k in · 856 out · 2.1s · 2 tools`
  - Backend: `emitRoundStart()`, `emitRoundComplete()`, `emitToolExec()` in `attempt-hooks.ts`; wired in `attempt.ts` (round counter `_forkRoundNumber`) and `pi-embedded-subscribe.handlers.tools.ts` (tool events)
  - Frontend: `pushRoundComplete()`, `pushToolExec()` methods on `TimelineController`; handlers in `app.ts` for all 4 phases
  - Design doc: `docs/plans/2026-03-09-timeline-round-level-observability-design.md`
  - Plan: `docs/plans/2026-03-09-timeline-round-level-observability.md`
- **Legend:** Grid overlay approach — `.ct-legend-anchor` lives on the container's parent (not inside the scroll container), placed in the same grid cell (`grid-column: 1/3; grid-row: 3`) with `pointer-events: none`. Inner `.ct-legend` is `position: absolute; right: 8px; top: 4px` with `pointer-events: auto`. Never scrolls.
- **Capacity line:** `.ct-capacity-line` dashed line at 100% capacity, spans full scrollable width
- **Toggle switch CSS:** `.ct-switch`, `.ct-switch-track`, `.ct-switch-thumb`, `.ct-switch-label`
- **CSS:** `.ct-bar`, `.ct-capacity-line`, `.ct-legend-anchor`
- **Files:** `context-timeline.ts`, `app.ts` (wiring), `attempt-hooks.ts` (event emission), `attempt.ts` (round counter), `pi-embedded-subscribe.handlers.tools.ts` (tool events), `base.css`

### 5.10 Context Treemap

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03 (commit `1ba87b077`)
- **What:** Squarified treemap (Bruls et al. algorithm) visualizing LLM prompt token composition with 3-level drill-down. Footer shows token count, model, and cost — centered vertically with asymmetric padding.
- **Levels:** L1 (categories) → L2 (sub-items, fetched on-demand from forensic dumps) → L3 (text preview overlay)
- **Data source:** `/api/context-anatomy/:sessionKey` REST endpoint (fork-only)
- **AI summary:** Double-click triggers `forensic.summarize` gateway method for overlay. Uses **Google Gemini 2.0 Flash** (switched from Anthropic Haiku 2026-03-08 due to API spending cap). Key in `google:default` auth profile.
- **On-demand L2 drill-down (2026-03-08):** L1 boxes from anatomy events lack children. Clicking fetches forensic dump via `forensic.getCallLive`, matches by timestamp, extracts children from slim data (`extractChildrenFromSlim()`). Supports system_prompt sections, tool definitions, and conversation messages.
- **Lollipop click (2026-03-08):** Clicking the brown lollipop in the timeline switches to context tab and shows the prompt's anatomy in the treemap (`switchBrpTab("context")` + `__treemapShowAnatomy`).
- **Navigation:** Click to drill down, back button to go up
- **Files:** `context-treemap.ts` (~1100 lines), `app.ts` (mount + wiring), `base.css`
- **Backend:** `src/gateway/server-methods/forensic.ts` — `summarizeText()` uses Gemini API, `getGoogleApiKey()` reads from `google:default` profile

### 5.11 Response Treemap

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03 (commit `1ba87b077`)
- **What:** Same squarified treemap for output token usage. Purple tones. Side-by-side with context treemap via tabs.
- **Files:** `response-treemap.ts` (703 lines), `app.ts`, `base.css`

### 5.12 Overseer Panel (Pills)

- **Status:** `DEPLOYED-UNTESTED`
- **Originally deployed:** 2026-03-03 as force-directed SVG graph (commit `98f72f4c1`)
- **Redesigned:** 2026-03-05 (commit `4885b7bd0`) — replaced 541-line SVG graph with 128-line pill visualization
- **What:** Horizontal flex-wrap pill layout showing active runs. Each pill = one active run with provider icon, model name, auth label, and provider-colored breathing glow.
- **Data source:** Driven by `activeRuns` Map (same data as model panel glow), synced via `updateOverseerPanel()` called from `updateBudgetPanel()`. Zero polling — no `overseer.topology` calls.
- **Empty state:** Telescope icon + "Overseer watching — waiting for config"
- **Pill states:** Active (breathing glow animation `overseer-pill-breathe`), error (red border, dimmed), inactive (dimmed 40% opacity)
- **Removed:** Session filter button, `overseerFilterActive` state, 5s polling interval, force-directed physics, SVG rendering
- **CSS:** `.overseer-pills`, `.overseer-pill`, `.overseer-pill--active`, `.overseer-pill--error`, `.overseer-empty-state`
- **Files:** `overseer-graph.ts` (128 lines), `app.ts` (`updateOverseerPanel()`), `base.css`

### 5.13 Models Panel

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-02 (commit `fd164f50b` + `81800be95`)
- **Unified layout (2026-03-05, commit `1cdb6c9ba`):** Flattened into two collapsible sections:
  - **FALLBACK CHAIN** — primary + fallbacks (all use circled numbers ①②③④). Contains ALL auth profile rows for each model.
  - **CONFIGURED** — other models not in fallback chain, sorted by performance tier. **Starts collapsed** on page load (fallback chain starts open).
  - When collapsed, only active (glowing) models remain visible
- **Data source:** `config.models` gateway method (fork-only, commit `1cdb6c9ba`) — reads config + auth store, returns labels, auth order, cooldown-aware profile resolution
- **Per-auth-profile rows:** Provider SVG icons, model name, auth key label (from `authProfiles[keyId].label`), mode suffix
- **Performance tier ranking:** frontier (opus/pro-preview/o1) → strong (sonnet/gpt-4o) → balanced (flash/haiku) → lightweight (mini/nano)
- **Error badges:** Red uppercase badge scoped per-profile or per-model (never per-provider — a billing cap on opus won't bleed to sonnet/haiku rows)
- **Error row styling:** `.model-errored` applies transparent red backfill (`rgba(255,60,60,0.08)`) with faint red border, strikethrough on model name, 0.85 opacity. Immediately visible when a provider fails.
- **Error lookup chain:** `providerErrors.get(keyId)` → `providerErrors.get(modelId)` (NO bare provider fallback)
- **Health poll:** 60s interval checks `provider.health`, auto-clears error badges (provider-level, per-profile `provider:*`, and per-model `provider/*` keys)
- **Provider icons:** Inline SVGs (14px) for anthropic, google, openai, ollama, meta, mistral, deepseek
- **Triggers overseer sync:** `updateBudgetPanel()` calls `updateOverseerPanel()` at the end
- **Files:** `app.ts` (`updateBudgetPanel()`, `renderAuthKeyRows()`, `renderModelRow()`, `renderAuthKeyRow()`, `modelPerfRank()`), `base.css`

### 5.22 Token Usage Tracker (Inline Bars)

- **Status:** `CONFIRMED` (2026-03-08, expanded to 3 providers)
- **Deployed:** 2026-03-07 (Anthropic), 2026-03-08 (OpenAI + Gemini)
- **What:** Two thin stacked horizontal bars (3px each) per model row showing real-time utilization. Top bar = short window (green `#4ade80`), bottom bar = long window (orange `#f59e0b`). All three providers use the same `getModelUsage()` → `renderUsageBarsOnly()` pipeline.
- **Anthropic (Claude):**
  - Top bar: 5h utilization, Bottom bar: 7d utilization (or `seven_day_sonnet` for sonnet models)
  - Per-account: single GM Claude Max subscription fetched via `resolveApiKeyForProfile` (SV account deleted 2026-03-22)
  - Data source: live from `api.anthropic.com/api/oauth/usage` per profile → `claudeProfiles` keyed by `"cli-gm"`
  - Rate limit handling: per-ACCESS-TOKEN limit (~5 reqs). On 429, returns cached data instead of refreshing tokens (avoids Anthropic strict rotation invalidating agent runner's in-memory tokens — root cause of dual-profile auth failures 2026-03-09). Sequential fetch, 30min cache per profile
  - Tooltip: `{profile}: 5h {pct}%\n7d: {pct}% — resets {relative}`
- **OpenAI (GPT):**
  - Top bar: today's spend vs $50 monthly cap, Bottom bar: month-to-date spend vs $50 cap
  - Data source: OpenAI Admin API (`/v1/organization/costs`) via `OPENAI_ADMIN_API_KEY` env var (set in systemd service + openclaw.json)
  - Admin key stored in `~/.openclaw/.env` and systemd `Environment=` line
  - Returns `openaiCosts: { monthSpend, dailyBreakdown: [{date, amount}] }` in `budget.usage` response
  - Cache: 30min TTL, null results NOT cached (prevents transient failures from blocking data)
  - Tooltip: `Today: $X.XX/$50 (N%)\nMonth: $XX.XX/$50 (N%)`
- **Gemini (Google):**
  - Top bar: RPM (requests per minute vs RPM limit), Bottom bar: RPD (requests per day vs RPD limit)
  - Data source: Google Cloud Monitoring API (`serviceruntime.googleapis.com/api/request_count`) for the `generativelanguage.googleapis.com` service
  - Auth: service account JWT (`~/.config/gcloud/service-account.json`, project `organic-storm-486018-u9`). Google access token cached 1h
  - Prerequisite: `generativelanguage.googleapis.com` API must be ENABLED on the GCP project (enabled 2026-03-08), service account needs Billing Account Viewer role
  - Queries two time windows in parallel: 1min (RPM) and 24h (RPD). Rate limits read from `gemini-usage.json` (uses highest model's limits: gemini-2.0-flash = 15 RPM, 1500 RPD)
  - Cache: 10min TTL, null results not cached
  - Tooltip: `RPM: X/15 (N%)\nRPD: X/1500 (N%)`
- **Model name compression:** opus->op, sonnet->sn, haiku->hk
- **CSS classes:** `.usage-bars-col`, `.usage-bars-wrap`, `.usage-bar`, `.usage-bar-fill` — all spans need `display:block` for height/width to apply
- **CSS grid column:** Bars occupy the `1fr` column (2nd of 4) in `.model-group-body` subgrid
- **Files:** `extensions/budget-panel/index.ts` (all provider fetches), `app.ts` (`getModelUsage()`, `renderUsageBarsOnly()`, `fmtReset()`), `base.css`
- **Bug fix (2026-03-07):** Bars showed as faint white lines with no colored fill. Fix: `display:block` on `.usage-bar` and `.usage-bar-fill`.
- **Bug fix (2026-03-08):** OpenAI graph disappeared after gateway restart. Root cause: `fetchOpenAICosts` cached null on transient failure, served stale null for 30min. Fix: skip cache when `data` is null.
- **Bug fix (2026-03-09):** SV and GM showed identical usage (both 5h=50%, 7d=33%). Root cause: Claude Code logged in as SV → `.credentials.json` has SV tokens → `external-cli-sync` overwrote `cli-gm` with SV tokens. Fix: dedicated `~/.claude/.credentials-gm.json` — GM tokens fully decoupled from Claude Code's login. `cli-credentials.ts` got `readClaudeCliGmCredentials`+write, `external-cli-sync.ts`+`oauth.ts`+`budget-panel` all switched to GM-specific file. Login script updated to write GM to `.credentials-gm.json`.
- **Disconnected profile visual (2026-03-09, updated 2026-03-17):** When a profile has no usage data (token missing/expired), bars render as amber dashed/striped pattern (`repeating-linear-gradient`, `#f59e0b40`) instead of blank. Tooltip shows `{profile}: disconnected` or `{profile}: api key (no usage)` for API key profiles. `ModelUsageInfo.disconnected` flag drives the alternate render path in `renderUsageBarsOnly()`.
- **Disabled profile visual (2026-03-09, updated 2026-03-17):** `config.models` API now exposes `disabled: true` + `disabledReason` from `usageStats` cooldown state. Profiles in billing cap / cooldown show **red-tinted dashed bars** (100% width, `#ef444480`), vs amber dashes for plain disconnected. Tooltip shows `{profile}: billing`. Gateway reads `store.usageStats[profileId].disabledUntil` and compares to `Date.now()`.
- **Billing persistence (2026-03-17):** Billing failures now persist in `config.models` response even after cooldown (`disabledUntil`) expires. `config.ts` checks `failureCounts.billing > 0` — a billing cap is permanent until the billing period resets. Previously, billing cap info disappeared after the 15min cooldown.
- **Per-profile data isolation (2026-03-17):** Each profile row shows ONLY its own usage data. `getModelUsage()` no longer falls back to shared `budgetUsageData.claude` when `keyId` is provided. Missing profiles show disconnected state instead of shared data. Fixes: all profiles (cli-gm, api) showing identical graphs.
- **Stale error clearing (2026-03-17):** `loadBudget()` clears `providerErrors` for profiles that have fresh `claudeProfiles` data. Also seeds billing errors for disabled profiles from `config.models` authProfiles. Prevents stale auth errors persisting in localStorage after OAuth tokens are refreshed.
- **Bug fix (2026-03-20):** All opus rows showed dashed lines (disconnected). Root cause: `refreshAnthropicOAuthToken()` in `credential-file.ts` passed `scope: "user:inference"`, downscoping every refreshed token and stripping `user:profile` → 403 on usage API. Fix: removed `scope` from refresh request. See §7 FIXED entry for full cascade.

### 5.23 Inline File Viewer

- **Status:** `CONFIRMED` (2026-03-07)
- **Deployed:** 2026-03-07
- **What:** Clickable file path links in system messages open a collapsible inline viewer below the message. Supports code files (with line numbers) and markdown files (rendered via `md()`).
- **Backend:** New `/tinker/api/file-read?path=...` endpoint in `extensions/tinker/index.ts`. Requires absolute path. Tries exact path first, then workspace prefixes (`~/.openclaw/workspace/memory/`, `~/.openclaw/workspace/`, `~/`). Max file size 512KB.
- **Frontend:** Click toggles viewer. Re-clicking same link collapses. Only one viewer open at a time. Active link gets `.file-viewer-open` class (green highlight).
- **Rendering:** JSON files get pretty-printed. Markdown (`.md`/`.mdx`) rendered via `md()`. All others get line-numbered monospace display.
- **Dev proxy:** `/tinker-api` in `vite.config.ts` rewrites to `/tinker/api` on gateway
- **CSS:** `.file-viewer-inline`, `.file-viewer-header`, `.file-viewer-content`, `.file-viewer-code`, `.file-viewer-md`, `.fv-ln`, `.sys-file-link`
- **Files:** `extensions/tinker/index.ts` (endpoint), `app.ts` (click handler + rendering), `base.css` (styles), `vite.config.ts` (dev proxy)

### 5.24 Unified Message Rendering (renderMsg rewrite)

- **Status:** `CONFIRMED` (2026-03-07)
- **Deployed:** 2026-03-07
- **What:** `renderMsg()` rewritten to render content blocks in document order (text → tool_use → tool_result interlaced) instead of grouping by type. Enables proper interleaving of tool calls with text responses.
- **Global result map:** `updateChat()` builds `globalResultMap` and `globalToolNames` across ALL messages, so `tool_use` blocks can find their paired `tool_result` even if it's in a different message.
- **Tool result suppression:** For `edit`/`write` tools, the expanded detail already shows the content, so the "What came back" result block is hidden unless it's an error.
- **Orphan tool_result handling:** `tool_result` blocks with no matching `tool_use` anywhere are only shown if the message also has non-tool content. Pure tool_result-only messages are hidden.
- **Files:** `app.ts` (`renderMsg()`, `updateChat()`)

### 5.25 Topbar Toolbar with Collapsible Panels

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-08
- **What:** Sidebar removed. All navigation moved to a centered `.toolbox` in the topbar. Two icons toggle collapsible panels:
  - 📊 (`#tb-timeline`, hint "Timeline"): collapses bottom row (context-timeline + bottom-right-panel)
  - 🧠 (`#tb-models`, hint "Models"): collapses right column (right-panels + bottom-right-panel)
- **Logo:** 70px (2.5x bigger), left side of topbar, still triggers `/new` session
- **Grid change:** `48px 1fr 416px` → `3fr 1fr` (sidebar column removed). Rows: `48px 3fr 1fr` (topbar matches sidebar width).
- **Topbar:** Only spans column 1 (chat width). Right panels span rows 1-2 (touch window top).
- **Animation:** CSS `grid-template-rows`/`grid-template-columns` transition 0.5s. Uses `fr` units on both sides for smooth interpolation. Opacity stagger: content fades 0.15s before/after grid resize.
- **Active state:** `.tb-active` class — warm glow, accent color, surface2 background
- **Connection status:** Single indicator (right side): green dot + "Connected" / red dot + "Disconnected". Previous redundant left dot removed.
- **Remaining icons:** 💬 Chat, 📈 Metrics — not yet wired to actions
- **Files:** `app.ts` (HTML + click handlers), `base.css` (grid, `.toolbox`, `.tb-active`, collapse classes)

### 5.14 Session Grouping & Management

- **Status:** `CONFIRMED` (2026-03-05)
- **Deployed:** 2026-03-03
- **What:** Sessions panel groups sessions by type with collapsible headers.
- **Groups:** pinned (main, heartbeat — always visible), whatsapp, cron, subagent, other (collapsed by default)
- **Per-session info:** Token count, time-ago display
- **Delete button:** Trash icon on hover per session row (calls `sessions.delete`)
- **New session:** Logo click clears UI immediately (messages, tool calls, stream state, errors), aborts active runs, then sends `/new` (improved in `ddd82e8f0`)
- **Files:** `app.ts`

### 5.20 Smart Auto-Scroll (Stick-to-Bottom)

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-07
- **What:** Chat only auto-scrolls when the user is already near the bottom (within 80px). If the user has scrolled up to read older messages, new content arrives without disturbing the viewport.
- **Behavior:**
  - At bottom → new messages push older ones up, scroll follows (classic chat UX)
  - Scrolled up → viewport stays put, user keeps reading undisturbed
- **Implementation:** Two-layer approach:
  1. `updateChat()` checks `wasAtBottom` (80px threshold) BEFORE `innerHTML` replacement. If at bottom → `scrollTop = scrollHeight` immediately after. If scrolled up → restores `prevScrollTop`. This prevents the browser's scroll reset on DOM replacement.
  2. `scrollChat()` (called via rAF) acts as a secondary guard with the same 80px threshold check.
- **Key insight:** `innerHTML` replacement resets browser scroll position. Must save/restore synchronously — `requestAnimationFrame` is too late.
- **Files:** `app.ts` (`updateChat()` scroll preservation, `scrollChat()`)

### 5.21 Auto-Expanding Textarea

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-07
- **What:** Chat input textarea grows vertically as user types (up to 40vh), shrinks back to one line on send. No horizontal scroll arrows.
- **Implementation:** `autoResizeTA()` sets `height: auto` then `height: scrollHeight`. Called on `input` event and on page load (for restored drafts). Reset to `auto` on send (Enter key + button click). Auto-focuses on page load.
- **CSS:** `max-height: 40vh; overflow-y: auto` (was `max-height: 120px`)
- **Files:** `app.ts` (`autoResizeTA()`, input/send handlers), `base.css`

### 5.19 Fallback-Aware Streaming

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-06 (commit `ddd82e8f0`)
- **What:** During model fallback, the same runId gets a chat `error` event for the failed model then a new `start` + deltas for the fallback model. Previous behavior cleared streaming state on every chat event including intermediate errors, causing visual flash.
- **Changes:**
  - Chat error events (`state === "error"`) no longer clear `streamRunId` or trigger budget/treemap refresh. `streamMsgIdx` is always reset to -1 (even on error) to prevent stale streaming slots.
  - `pendingRunDeletes` Map tracks delayed run cleanup (3s timeout). Cancelled if fallback re-uses the same runId with a new `start` event.
  - `sending` only cleared when both `activeRuns` and `pendingRunDeletes` are empty
  - Lifecycle `start` re-asserts `sending = true` in case chat error cleared it during fallback
- **Files:** `app.ts`

### 5.15 Forensic Mode Toggle

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03 (commit `1ba87b077`)
- **What:** Toggles forensic mode via `forensic.setMode`/`forensic.getMode`. When on, prompts dumped to disk.
- **Visual:** Red glow (`forensic-active` CSS class), red dot indicator
- **Note:** Originally in sidebar; sidebar removed 2026-03-08. Button not yet re-wired to topbar toolbox.
- **Files:** `app.ts`, `base.css`

### 5.16 System Message Rendering (Redesigned)

- **Status:** `CONFIRMED` (2026-03-07)
- **Deployed:** 2026-03-07 (replaced overseer toggle)
- **What:** System messages render as collapsible summaries with file path detection. No more "Sys" toggle button — all system messages always visible, collapsed by default.
- **File path detection:** `extractFilePaths()` finds absolute paths in system text. Paths render as clickable `📄 filename` links that open an inline file viewer (see §5.23).
- **Alert styling:** Messages containing `⚠️`/`⚠` get `.system-alert` class (orange background, larger font)
- **User message splitting:** Lines starting with `System:` in user messages are extracted and rendered as separate system rows above the user bubble
- **Removed:** `showOverseerChat` variable, "Sys" toggle button, `chat-header` div
- **Files:** `app.ts` (`renderSystemMsg()`, `extractFilePaths()`), `base.css`

### 5.17 Draft Persistence

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03
- **What:** Textarea draft saved to `localStorage["tinker-draft"]` on every keystroke, restored on load, cleared on send.
- **Files:** `app.ts`

### 5.18 Active Run State Persistence

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-03
- **What:** `sessionStorage["tinker-activeRuns"]` saves active runs so model glow survives page refresh. Unconfirmed runs pruned after 5s if no lifecycle event confirms them.
- **Files:** `app.ts`

### 5.26 Sidebar Alt-View Tabs — Full Command Center (2026-03-08)

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-08
- **What:** 11 sidebar tabs (Overview, Channels, Sessions, Usage, Cron, Agents, Skills, Nodes, Config, Debug, Logs) replace upstream's entire Lit webchat view system with vanilla DOM + gateway RPC. All tabs now fully functional with data from 54+ RPC methods.
- **Architecture:**
  - `switchTab(tab)` hides chat area + topbar + timeline + right panels, shows `.alt-view` spanning grid columns 2-3
  - `renderAltView(tab)` dispatches to per-tab async render function, shows loading state, catches errors
  - Delegated click handler on `altView` + delegated change handler (for `<select>` elements)
  - Per-tab color theming via `TAB_COLORS` map
  - Module-level filter state: `sessFilterActive`, `sessSortBy`, `sessFilterLimit`, `sessIncludeGlobal/Unknown`, `usagePeriod`, `cronSelectedJobId`
- **Tab details:**
  - **Sessions:** Filter bar (active-within/sort/limit/global/unknown), input/output/total token columns, model+provider, thinking-level `<select>` per row (saves via `sessions.update`), delete button
  - **Usage:** Period presets (Today/7d/30d/90d), 4-card grid (tokens/cost/insights/model breakdown), CSS horizontal bar chart for daily costs, session table sorted by tokens, export JSON
  - **Cron:** Summary strip, job cards with schedule/payload/delivery, per-job actions (enable/disable/run/run-if-due/remove), run history panel with job selector, cron run cards with delivery status
  - **Agents:** Agent cards with emoji/description/fallback chain/channels/skills/tool profile, tool profile grid with tool name chips, tool groups with descriptions
  - **Skills:** Grouped cards with version/author, enable/disable toggle, missing binaries as code-styled tags, API key status, group headers show enabled/total
  - **Nodes:** Pending device requests (approve/reject with proper event listeners), paired devices with roles/last-seen/token, exec node cards in 2-col grid with online/offline badge + capabilities chips
  - **Config:** Status card, models list, section navigation buttons (highlighted active), section detail viewer, validation issue cards with schema paths, apply config button, export JSON
  - **Debug:** Local state card, scrollable JSON snapshots, RPC console with 12 preset method buttons, persistent call history with replay, clear history
  - **Logs:** Structured log parsing (time/level/subsystem/message columns when pattern matches), text filter + level toggles, auto-follow, export .txt, clear, line counter, 2000-line DOM cap to prevent memory leaks
- **Helpers:** `altRelTime()`, `altDuration()`, `altEsc()`, `altTokens()`, `altJson()`, `altRow()`, `altRefreshBtn()`, `wireSessionFilters()`, `renderCronJob()`, `renderCronRun()`, `renderChannelAccounts()`
- **Files:** `app.ts` (all tab logic), `base.css` (`.alt-view`, `.alt-card`, `.alt-view-header`, `.alt-view-body`, `.alt-placeholder`)

### 5.27 Per-Tab State Isolation (2026-03-10)

- **Status:** `DEPLOYED-UNTESTED`
- **Deployed:** 2026-03-10
- **What:** Each chat tab runs as a fully independent session with isolated state. No cross-tab leakage of messages, streaming, sending indicators, or drafts.
- **Architecture:**
  - `TabState` interface holds per-session mutable state (messages, streamMsgIdx, streamRunId, frozenTextEnd, lastDeltaLen, sending, currentTurnNumber, expandedTools, draft)
  - `tabStates` Map keyed by tab ID stores all TabState objects
  - `saveCurrentTabState()` / `loadTabState()` atomically swap globals on tab switch
  - `switchToTab()` does: save → load → sync render → background `loadChat()` with key guard
  - `sessionKeyMatches()` handles suffix-based comparison during pre-canonicalization window
- **Session key canonicalization:** Client creates `tinker:xxx`, server returns `agent:main:tinker:xxx`. `loadSessions()` does suffix matching to upgrade keys. Only 2 event filters need fallback — chat (line 1039) and lifecycle (line 1388).
- **loadChat guard:** Captures `sessionKey` at start. If tab changed during async, writes to TabState map (not globals). `loadSessions()` no longer calls `loadChat()` — only on initial connect and explicit switches.
- **createTab:** Eagerly assigns `tinker:xxx` key with `isAttached: true` + fresh TabState. Sessions panel shows tab immediately.
- **/new handler:** Resets current tab in place (new `tinker:xxx` key, fresh TabState). Never switches to main.
- **Right panel reorder:** Sessions → Models → Overseer (was Models → Sessions → Overseer)
- **Session/All scope toggle:** `budgetScope` global ("session"|"all"), toggle buttons in Models header, `getAuthKeyCounts()` filters by scope. CSS: `.scope-toggle`, `.scope-btn`, `.scope-btn-active`
- **Sessions panel improvements:** `classifySession` recognizes `:tinker:` as "pinned", `renderSessionRow` uses tab titles for tinker sessions and main tab title for main session, unattached tabs injected as synthetic entries, `updateSessionsPanel()` called after title generation and run completion
- **Queued message indicator:** Messages sent while current session has active run get `_queued: true`. Rendered with dashed border + "queued" badge (`.msg-queued`, `.queued-badge`). Un-queued on delta/final when LLM absorbs via steer.
- **generateTabTitle:** Uses `tabStates` for non-active tabs. Lifecycle end trigger uses per-tab turn count via TabState.
- **closeTab:** Cleans up TabState from map.
- **Global vs per-tab:** `activeRuns`, `providerErrors`, `budgetData`, `sessions`, `ws`, `connected` stay global. All chat state is per-tab.
- **Backend support:** `steer-backlog` queue mode for webchat (settings.ts), 300ms debounce batching in runs.ts, per-session dispatch lanes in run.ts
- **Design doc:** `docs/plans/2026-03-10-per-tab-state-isolation-design.md`
- **Files:** `app.ts`, `base.css`

### 5.28 Per-Session Thinking Indicator Filter (2026-03-14, updated 2026-03-17)

- **Status:** `DEPLOYED`
- **What:** Thinking indicator now only shows for runs belonging to the active session. Previously, `renderThinkingIndicator()` used the unfiltered global `activeRuns` map, so any run from any session showed thinking dots on the current tab.
- **Fix:** `renderThinkingIndicator()` filters `activeRuns` by `sessionKeyMatches()`. `startThinkingTick()` skips DOM updates when no session runs are active. Lifecycle start only sets `sending = true` when event matches current session (not subagent pass-through).
- **2026-03-17 cross-tab cleanup fix:** Lifecycle `end`/`error` events were gated by session filter — runs from inactive tabs never got removed from `activeRuns`, leaving stale thinking indicators when switching back. Fix: `end`/`error` events now bypass the session filter (rendering filter already handles per-tab visibility). `sending` flag clears based on current-session runs, not global `activeRuns.size`.
- **Files:** `app.ts`

### 5.29 Collapsible Right Panel Sections (2026-03-14)

- **Status:** `DEPLOYED`
- **What:** Sessions, Models, and Overseer right panel sections are individually collapsible. Click header to toggle. Arrow indicator (▾/▸) rotates. State persists in localStorage (`tinker-collapsed-panels`).
- **Architecture:** `data-rpanel` / `data-rpanel-toggle` attributes on panel/header elements. Delegated click handler on `.right-panels`. Guards against collapsing when clicking interactive children (scope toggle, refresh button). CSS: `.rpanel-collapsed .rpanel-body{display:none}`, `.rpanel-arrow` for indicator.
- **Files:** `app.ts`, `base.css`

### 5.30 Session/All Scope Toggle — iOS Switch (2026-03-14, fixed 2026-03-26)

- **Status:** `DEPLOYED`
- **What:** Models panel Session/All toggle now uses the same iOS-style switch (`.ct-switch` track + thumb) as the timeline, instead of button-pair toggle. Labels render in proper case ("Session" / "All") — `text-transform:none` override on `.ct-switch-label` prevents `.rpanel-header`'s `uppercase` from affecting switch labels.
- **2026-03-26 fix:** HTML still used old `.scope-btn` button-pair markup (no CSS backing it — looked like plain text). Replaced with `ct-switch` markup (`ct-switch-label` + `ct-switch-track` + `ct-switch-thumb`) matching the timeline toggle. JS handler updated to toggle `ct-switch-label--active` and `ct-switch-track--on` classes.
- **Files:** `app.ts`, `base.css`

### 5.31 Timeline SQLite Persistence + Response Breakdown (2026-03-16, updated 2026-03-26)

- **Status:** `DEPLOYED`
- **What:** Timeline now persists all LLM calls to SQLite (`~/.openclaw/data/anatomy-timeline.db`) and survives reboots. Data kept indefinitely (no pruning). On fresh boot, loads chronological feed for the current session. "All" mode loads last 7 days across all sessions via `/recent` endpoint. Existing JSONL files were migrated on first open (user_version=2). JSONL storage fully replaced.
- **Response segments:** Three new bar segments added to the timeline visualization alongside the 7 input segments:
  - `responseThinking` (cyan `#06b6d4`) — thinking/reasoning tokens
  - `responseText` (emerald `#10b981`) — text output tokens
  - `responseToolCalls` (amber `#f59e0b`) — tool call input tokens
- **Data captured:** `responseThinkingTokens`, `responseTextTokens`, `responseToolCallTokens`, `cacheReadTokens`, `cacheCreationTokens` — estimated from char counts during streaming (chars / 3.5)
- **REST API:** `GET /api/context-anatomy/recent?hours=48&limit=500` serves cross-session feed (hours max 8760, limit max 2000). Existing `/{sessionKey}` endpoint reads from SQLite.
- **Zlib compression (2026-03-26):** JSON columns (`context_sent`, `context_window`, `tools_triggered`, `topics`, `topic_transition`, `memories_injected`) are zlib-compressed before storage (~60-70% size reduction). Read path handles both compressed BLOBs (new rows) and plain-text JSON (legacy rows) transparently via `decompressJson()`. At ~1-1.5 MB/day compressed, 45 GB free disk = ~80+ years.
- **No pruning (2026-03-26):** Removed 24h auto-prune. Data kept indefinitely. `updateAnatomyResponse` fallback INSERT (which created orphan empty-key rows with `session_key=''`, `turn=0`) also removed — response-only stubs without context data are not useful for the timeline.
- **Session dividers:** When `sessionKey` changes between consecutive events, a new group boundary is created in the timeline.
- **Session/All toggle (2026-03-26, FIXED):**
  - Legend + toggle always rendered, even when buffer is empty (so user can switch to "All" on a new session)
  - Toggle updates visual state immediately (no full re-render flash)
  - "Session" mode: `loadSession(sessionKey)` fetches by session key from DB. Sessions persist across gateway restarts.
  - "All" mode: `loadAllSessions()` fetches via `/recent?hours=168&limit=200` across all sessions (was per-session from gateway's live session list, which lost data across restarts)
  - Buffer preserved on fetch failure (was cleared before fetch, causing data loss on 401/network error)
- **Auth fix (2026-03-26):** Timeline `fetch()` calls now use `authedFetch()` with Bearer token headers. Vite dev server (port 18790) proxies `/tinker/api` to gateway with auth, but `getGatewayBase()` was returning `"http://localhost:18789"` in dev mode — bypassing the proxy and hitting the gateway directly without auth (401). Fixed: `getGatewayBase()` now always returns `""` (relative URLs), so Vite proxy handles auth in dev and gateway serves natively in prod.
- **Route registration (2026-03-22, FIXED):** Tinker extension must be in `plugins.entries` + `plugins.allow` in `openclaw.json` with `auth: "gateway"`. Gateway registry rejects `auth: "none"` — silently drops the route. Without this, the `/tinker/api/*` HTTP endpoints are unreachable and the historical feed never loads (only live WebSocket events appear).
- **SQLite fallback in extension (2026-03-22, updated 2026-03-26):** Extension's `getAnatomyDb()` opens the DB directly via `better-sqlite3` when `globalThis.__anatomyDb` bridge isn't set yet (before first LLM call). Includes `decompressJson()` for zlib BLOB + legacy TEXT handling, and `parseRow()` for snake_case→camelCase conversion. `queryRecentEvents` supports `limit` parameter.
- **Right-justification (2026-03-22):** Flex spacer before first group pushes bars right when content doesn't overflow; shrinks to 0 when it does.
- **Session events order fix (2026-03-22):** `loadSession()` now reverses DESC-ordered API results to chronological order before displaying.
- **Files:** `context-anatomy-db.ts` (compression + no prune), `context-anatomy.ts` (type extended, JSONL removed), `context-anatomy-http.ts` (limit param + raised caps), `attempt-hooks.ts` (SQLite write path), `pi-embedded-subscribe.ts` + handlers (response breakdown capture), `context-timeline.ts` (authedFetch + toggle fix + buffer safety + /recent for All mode), `app.ts` (relative URLs + auth headers), `extensions/tinker/index.ts` (decompressJson + limit support + raised hour caps)

### 5.32 Duplicate Thinking Bubble Fix (2026-03-17)

- **Status:** `DEPLOYED`
- **What:** After `loadChat()` loaded server history, messages with both `type: "thinking"` and `type: "text"` blocks (canonical server format) rendered two "Thinking:" bubbles — the thinking block and the text block (actual answer) both got thinking styling.
- **Root cause:** `thinkingSet` classification marked any message with a thinking block as thinking (via `continue`, skipping the text check). `renderMsg` then applied "Thinking:" prefix to ALL blocks in the message — thinking blocks via `block.type === "thinking"` handler (correct), and text blocks via the `isThinking` flag (incorrect).
- **Fix:** `thinkingSet` now only marks messages with ONLY thinking blocks (no text). Messages with both types are treated as text messages and added to `assistantTextIndices`. The thinking blocks within them render correctly via `renderMsg`'s unconditional `block.type === "thinking"` handler; text blocks get normal assistant styling.
- **Streaming unaffected:** During streaming, temp messages have single block types (either thinking or text), so the old logic was correct. The bug only manifested after `loadChat()` merged blocks into canonical form.
- **Files:** `app.ts`

### 5.33 Partial Streamed Text Preservation on Error (2026-03-18)

- **Status:** `DEPLOYED`
- **What:** When Anthropic returns 529 overloaded mid-stream, the partial thinking and text that was already rendered in webchat was being wiped. User saw blank screen + error bubble instead of partial response + error bubble.
- **Root cause:** `messages.filter((m) => !m._temporary)` in the `state === "error"` handler deleted all streaming temporary messages. Only the error message was added back.
- **Fix:** Before filtering, converts temporary messages with actual content (text or thinking) to permanent `_partial` messages. Empty temporaries are still cleaned up. User now sees partial Opus response preserved above the error bubble.
- **Files:** `app.ts`

### 5.34 Fallback Profile Error Bubbles — API Call Failures (2026-03-18)

- **Status:** `DEPLOYED`
- **What:** `fallback-profile-error` lifecycle events were only emitted for cooldown skips and key resolution failures. The much more common case — API call failure followed by profile rotation — emitted nothing. Tinker UI handler existed but never fired.
- **Fix:** Added `emitAgentEvent` calls in both prompt and assistant error paths in `run.ts`, BEFORE `advanceAuthProfile()` or `FailoverError` throw. UI now shows red bubbles for each profile that fails during actual API calls (overloaded, billing, auth, etc.).
- **Files:** `run.ts` (3 emit sites), `app.ts` (handler already existed)

### 5.35 Generic Multi-Subscription Auth (2026-03-18)

- **Status:** `DEPLOYED`
- **What:** Replaced hardcoded SV/GM auth profile handling with config-driven generic system. Any user can configure N subscriptions per provider via `openclaw.json` `auth.profiles` with optional `credentialFile` field. Upstream `advanceAuthProfile()` rotation handles fallback between profiles automatically.
- **Key change:** New `credential-file.ts` module handles all credential file I/O. Removed `CLAUDE_CLI_PROFILE_ID`/`CLAUDE_CLI_SV_PROFILE_ID` constants and 8 SV/GM-specific functions (151 lines).
- **Proactive refresh:** Runs on gateway startup + every 15 min. Uses fork's own `refreshAnthropicOAuthToken()` with proper User-Agent header (pi-ai's lacked it → Cloudflare blocked refreshes).
- **Overloaded (529) fix:** On overloaded, skips profile rotation entirely and throws FailoverError immediately for model fallback. Prevents retry storms (was 3+ min, now instant).
- **Files:** `credential-file.ts` (new), `oauth.ts`, `proactive-refresh.ts`, `constants.ts`, `types.auth.ts`, `zod-schema.ts`, `doctor-auth.ts`, `cli-credentials.ts`, `run.ts`, `server.impl.ts`, `budget-panel/index.ts`, `merge-guardian.sh`, `anthropic-oauth-login.mjs`
- **Spec:** `jarvis-icu/docs/superpowers/specs/2026-03-18-generic-multi-subscription-auth-design.md`

### 5.36 Voice Mute Button (2026-03-19)

- **Status:** `DEPLOYED`
- **What:** Topbar 🔊 icon (`#tb-voice`) toggles Jarvis TTS on/off. State persists to `~/.openclaw/data/jarvis-muted.json`. The `~/.local/bin/jarvis` TTS script checks the file and exits early when muted.
- **API:** `GET/POST /tinker/api/jarvis-mute` on the tinker extension handler. POST body: `{"muted": bool}`. Response: `{"muted": bool}`. OPTIONS handler included for CORS preflight.
- **Visual:** `.tb-active` = unmuted (glow, accent color, opacity 1). No class = muted (opacity 0.5, no glow). `.tb-error` = red outline (2px solid, 1px offset) shown for 5s on API failure.
- **Bug fix (2026-03-19):** Button was non-functional — original code bypassed Vite proxy by hardcoding `http://localhost:18789` (cross-origin), causing CORS preflight rejection by gateway auth middleware. Silent `.catch(() => {})` hid the failure. Fix: route through Vite proxy (`base = ""`) like all other Tinker API calls; removed `Content-Type: application/json` header to avoid preflight. Same base-URL fix applied to all context-anatomy fetch calls.
- **UX fix (2026-03-20):** Optimistic toggle — button state changes immediately on click, then syncs with server response. On API failure: reverts to previous state and shows `.tb-error` red outline for 5 seconds. Added `Content-Type: application/json` header and `r.ok` guard on fetch responses.
- **Merge wipe (2026-03-23):** Upstream merge `541df66197` (2026-03-21) wiped both the `#tb-voice` HTML element and the init handler from `app.ts`. Restored manually. Added `patchVoiceMuteButton()` to `apply-fork-wiring.mjs` (patch #15) to auto-restore on future merges.
- **Files:** `app.ts` (toggle handler), `extensions/tinker/index.ts` (API endpoint), `vite.config.ts` (`/tinker/api` proxy with auth), `~/.local/bin/jarvis` (mute guard), `apply-fork-wiring.mjs` (patch #15)

### 5.37 Cost-Aware Model Routing (2026-03-20)

- **Status:** `DEPLOYED`
- **What:** Billing gate in `model-fallback.ts` blocks metered models (GPT, o3, Gemini) when the flat-rate primary (Anthropic subscription) has headroom. Why pay per-token when a flat-rate subscription is healthy?
- **Billing tiers** (set in `openclaw.json` per model):
  - `flat` — Anthropic subscription (unlimited within quota)
  - `metered` — OpenAI / Google pay-per-use
  - `free` — Ollama local inference
- **Headroom check:** If Anthropic `seven_day` utilization < 70%, all `metered` models are blocked from the fallback chain. Gate only opens for metered models when flat-rate is saturated (or data is stale).
- **Per-model cap:** Optional `monthlyCapUsd` per model in `agents.defaults.models`. Checked against total provider spend tracked in the budget-panel extension.
- **Data bridge:** `budget-panel/index.ts` (writer) → `usage-snapshot-store.ts` singleton → `billing-gate.ts` (consumer). Bridge decouples the HTTP fetch cycle from the synchronous gate check in `model-fallback.ts`.
- **Safety bag (missing/stale data):** If snapshot is absent or older than 1 hour, gate defaults to blocking all metered models and falling back to primary. Prevents accidental spend during data outages.
- **Model-router skill:** Skill v2.0.0 rewritten with billing-aware tiers and budget pressure tables. AGENTS.md bootstrap snippet updated with 5-line routing rules.
- **Merge safety:** Only 1 upstream file touched (`model-fallback.ts`, 4 lines). Auto-fixable by `patchBillingGate()` in `apply-fork-wiring.mjs`.
- **Config fields:** `billing` (tier name) + `monthlyCapUsd` (optional cap) added per model in `agents.defaults.models`.
- **Files:** `billing-gate.ts` (gate logic), `usage-snapshot-store.ts` (bridge singleton), `extensions/budget-panel/index.ts` (snapshot writer), `model-fallback.ts` (gate wiring)

### 5.38 Auth Reload & In-UI Re-Authentication (2026-03-21)

- **Status:** `DEPLOYED` (backend 2026-03-21, UI wired 2026-03-23)
- **What:** File watcher detects credential changes on disk and auto-refreshes the models panel. Clickable error badges on Anthropic OAuth profiles offer "Reload from disk" (force cache invalidate + cooldown clear) and "Re-authenticate" (full OAuth PKCE flow with popup auto-capture + paste fallback).
- **Extension:** `extensions/auth-reload/` (fork-only, zero merge friction)
  - `watcher.ts` — chokidar on `auth-profiles.json`, 500ms debounce, broadcasts `auth.profiles.updated`
  - `reauth.ts` — PKCE session management (max 5, 5min TTL), token exchange, credential writes via `updateAuthProfileStoreWithLock`, cooldown clear
  - `index.ts` — Registers 3 RPC methods (`auth.reload`, `auth.reauth.start`, `auth.reauth.exchange`) + HTTP route (`/auth/oauth/callback`)
- **UI changes (app.ts):**
  - `auth.profiles.updated` event handler in `onEvent()` — preserves `billing` and `auth_permanent` errors in `providerErrors` instead of clearing all, then refreshes budget panel with `{ forceRefresh: true }` to bust backend `usageCache`
  - `loadBudget()` seeds clickable "AUTH ERROR" badges for OAuth profiles with dead/expired tokens (budget API returns null usage). Previously, dead tokens only showed dashed bars — no clickable badge meant users couldn't trigger re-auth
  - Error badges on `anthropic:cli-*` profiles get `auth-clickable` class + popover with reload/re-auth actions
  - `startOAuthReauthFlow()` — opens popup, 15s timeout, falls back to paste modal
  - `showPasteModal()` — overlay with link + code input for manual paste fallback
  - `showToast()` — success/error notifications
  - `authProfileListeners` Set — concurrent popup flow support
  - All auth flow catch blocks (`reload`, `reauth.start`, `exchange`) extract `err.message || err.error` instead of string-coercing the raw gateway error object (which showed `[object Object]`)
- **OAuth flow:** Uses `state` param as session ID (CSRF + lookup), PKCE S256. Primary redirect to `localhost:18789/auth/oauth/callback` (auto-capture). Fallback to Anthropic's hosted callback (paste). Gateway exchanges code server-side — tokens never transit through browser.
- **Token exchange fix (2026-03-21):** `exchangeCodeForTokens()` in `reauth.ts` was sending `Content-Type: application/json` but Anthropic's token endpoint requires `application/x-www-form-urlencoded`. Also added missing `state` parameter to the exchange body. Code parsing improved to accept `code#state` (auto-capture redirect fragment), bare authorization code, or full callback URL with `?code=` query param.
- **Force-refresh after re-auth (2026-03-21):** `loadBudget({ forceRefresh: true })` busts the backend `usageCache` so the budget panel fetches with the newly exchanged token instead of serving stale null data from the 30min cache.
- **Billing error preservation (2026-03-21):** The `auth.profiles.updated` handler preserves `billing` and `auth_permanent` errors in `providerErrors` instead of clearing them unconditionally. Previously, the file watcher broadcasting after a billing error would clear the error badge, hiding real billing caps.
- **Broadcast:** Captures `context.broadcast` from gateway method handlers (stored in module scope by watcher.ts). File watcher + RPC + OAuth callback all broadcast `auth.profiles.updated`.
- **Config:** Added `auth-reload` to `plugins.allow` in `openclaw.json`.
- **CSS:** `.auth-clickable`, `.auth-action-popover`, `.auth-action-btn`, `.toast`, `.auth-paste-modal-overlay`, `.auth-paste-modal`, `.auth-paste-input` in `base.css`.
- **Spec:** `jarvis-icu/docs/superpowers/specs/2026-03-21-auth-reload-reauth-design.md`
- **Files:** `extensions/auth-reload/{index,watcher,reauth}.ts`, `extensions/budget-panel/index.ts`, `tinker-ui/src/app.ts`, `tinker-ui/src/styles/base.css`

### 5.39 Chat Message Deduplication (2026-03-21)

- **Status:** `DEPLOYED`
- **What:** Duplicate chat messages appeared when WebSocket delivered the same `final`/`error`/`aborted` event twice (network retry). First final promoted temps (`hadTemps=true`), second final saw no temps → pushed `p.message` again. Same issue with tool events — duplicate `tool_use`/`tool_result` bubbles.
- **Fix:** Three dedup Sets:
  - `finalizedRunIds` — tracks runIds whose final/error/aborted events have been processed. Duplicate finals short-circuit with early return.
  - `seenToolCallIds` — tracks tool_use `start` events by `toolCallId`. Duplicate tool starts are skipped.
  - `seenToolCallIds` (with `:result` suffix) — tracks tool_result events separately from starts.
- **Cleanup:** All three sets cleared in `loadChat()` on session switch/reconnect to prevent unbounded growth.
- **Files:** `app.ts`

### 5.40 Subagent Model Glow in Session Scope (2026-03-21)

- **Status:** `DEPLOYED`
- **What:** When `budgetScope="session"`, subagent runs (spawned from current session) were filtered out of `getAuthKeyCounts()` because their sessionKey (`:subagent:...`) didn't match the main session via `sessionKeyMatches()`. Model rows didn't glow and collapsed panels didn't show active subagent models.
- **Fix:** Added `!info.sessionKey.includes(":subagent:")` guard to the session filter in `getAuthKeyCounts()`. Subagent runs always count toward glow regardless of scope toggle. Overseer panel already showed them (no filter), now models panel matches.
- **Collapsed behavior preserved:** `.model-group:not(.open) > .model-group-body > .model-row:not(.model-live)` CSS rule keeps glowing rows visible when section is collapsed. The fix flows through `getAuthKeyCounts()` → `count > 0` → `.model-live` class → row stays visible.
- **Files:** `app.ts`

### 5.41 Gateway Restart Messages — Orange Centered Bubbles (2026-03-26)

- **Status:** `DEPLOYED`
- **What:** Gateway restart messages (`⚠️ Gateway restarted while processing your message...`) were rendering as green right-justified user bubbles because they arrive via `agentCommand` as `role: "user"`. Now detected by `⚠️`/`⚠` prefix and routed through `renderSystemMsg()`, which applies `.system-alert` — centered, orange (`#fb923c`), with subtle background.
- **Fix:** Added `/^⚠️|^⚠/.test(userText)` check in both user-text rendering paths (legacy string format + content blocks) before the default user bubble fallback.
- **Files:** `app.ts` (two sites: ~line 2262, ~line 2313)

### 5.42 Fortune Cookie Predictions & Session Title Persistence (2026-03-26)

- **Status:** `DEPLOYED`
- **What:** New session tabs display a spiritual seer prediction (fortune cookie) as their title. Predictions are Buddhist/mindfulness-themed (shamatha, vipassana, metta, mind mastery) and serve as positive affirmations encouraging thought awareness and inner sovereignty.
- **Fortune array:** 217 predictions in `FORTUNE_COOKIES[]`, each 12-25 words. ~50% conditional format with varied structures (imperatives, "the moment you...", "whoever...", "catch/master/refuse..."). 106 unique emoji icons (max 4 of any single icon). Categories: Shamatha, Vipassana, Mastering the Mind, Metta, Awareness, Non-Attachment, Karma, Impermanence, Equanimity, The Seer's Crystal Ball, Abundance, Connection, Destiny, Protection, Transformation, Joy, Wisdom, New Beginnings.
- **Title persistence:** `tinker-fortune-map` localStorage key stores `sessionKey → title` map. `saveFortuneTitle()` / `getFortuneTitle()` functions. Persisted on tab create + every `saveTabs()` call. Survives tab close — orphaned server sessions retain their original fortune.
- **Auto-assign:** `renderSessionRow()` auto-assigns a random fortune to tinker sessions with no stored title (prevents generic "Tinker UI" label from server's `displayName`).
- **Click consistency:** Both `attachSessionToTab()` and session-row click handler check `getFortuneTitle(key)` before falling back to `sess.label`. A session's fortune never changes once assigned.
- **Tab clamping:** `.tab-title` has `max-width: 180px` + `text-overflow: ellipsis`. Full text visible via `data-hint` tooltip (existing `#global-hint` system). Session labels use same `data-hint` approach.
- **Global hint:** `#global-hint` CSS changed from `white-space: pre` to `pre-wrap` so longer fortune text wraps within the 320px tooltip.
- **Files:** `app.ts` (FORTUNE_COOKIES array, persistence functions, renderTabs, renderSessionRow, attachSessionToTab, createTab, classifySession), `base.css` (.tab-title, #global-hint)

### 5.43 Colored Brain Systems — AMYGDALA & FRACTAL Tags (2026-03-23)

- **Status:** `DEPLOYED`
- **What:** System-generated messages from the AMYGDALA (personality thermostat) and FRACTAL (recursive reflection) cognitive subsystems render with distinct colored tags in the chat. AMYGDALA tags render in pink (`#ff69b4`), FRACTAL tags in fern green (`#2ECC71`). Tags use markdown bold+italic (`***TAG***`) instead of HTML spans for cross-channel compatibility (WhatsApp, Telegram).
- **Detection:** Messages containing `AMYGDALA` or `FRACTAL` prefixes in system event text.
- **Files:** `app.ts` (renderMsg detection), `base.css` (tag color classes)

### 5.44 WhatsApp Thinking Reaction (2026-02-18)

- **Status:** `DEPLOYED`
- **What:** When processing a WhatsApp message, the bot adds a 🤔 reaction as a progress indicator. Reaction is removed on final delivery + a safety-net timeout after dispatch. Isolated in its own module for merge safety.
- **Files:** `src/fork/thinking-reaction.ts` (extracted module), `attempt.ts` (hook point)

---

## 6. Backend Fork Patches That Feed Tinker

These are upstream files modified to support Tinker features. They require re-application after every merge.

| File                               | Patch                                                         | Auto-applied                     | Guardian Check                                            |
| ---------------------------------- | ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `server-chat.ts`                   | Enrich lifecycle with `model`/`modelProvider`                 | Yes (`apply-fork-wiring.mjs`)    | `resolveSessionModelRef`                                  |
| `run.ts`                           | 6x `emitAgentEvent` for `fallback-profile-error`              | Yes                              | `fallback-profile-error`                                  |
| `model-fallback.ts`                | `onError` callback for provider-level cooldown skips          | Yes                              | `onError`                                                 |
| `followup-runner.ts`               | `failedProfileId` extraction + `onError` for `fallback-error` | Yes                              | `failedProfileId`                                         |
| `agent-runner-execution.ts`        | Same as followup-runner                                       | Yes                              | `failedProfileId`                                         |
| `attempt.ts`                       | Pass `authProfileId` through lifecycle events                 | Yes                              | `authProfileId`                                           |
| `sessions.ts`                      | "Allow webchat delete" bypass                                 | Yes (`patchSessions()`)          | `Allow webchat delete`                                    |
| `tsdown.config.ts`                 | `external: ["better-sqlite3", "bindings"]` on all 8 entries   | Yes (`patchTsdownConfig()`)      | `external`                                                |
| `get-reply-run.ts`                 | `import { getSessionResetPrompt }`                            | Yes                              | `session-reset-prompt`                                    |
| `config-state.ts`                  | `"tinker"` in `BUNDLED_ENABLED_BY_DEFAULT`                    | Manual                           | `tinker` in config-state                                  |
| `extensions/tinker/index.ts`       | `/tinker/api/file-read` endpoint                              | Fork-only (no merge risk)        | —                                                         |
| `extensions/budget-panel/index.ts` | `writeCredentialFile` + `resolveCredentialFilePath` (generic) | Fork-only (no merge risk)        | `writeCredentialFile`                                     |
| `credential-file.ts`               | Generic credential file I/O + Anthropic OAuth refresh         | Fork-only (no merge risk)        | `resolveCredentialFilePath`, `refreshAnthropicOAuthToken` |
| `proactive-refresh.ts`             | Proactive OAuth refresh for all profiles                      | Fork-only (no merge risk)        | `startProactiveOAuthRefresh`                              |
| `get-reply.ts`                     | `clearSessionResume` moved after `runPreparedReply`           | Manual                           | `clearSessionResume` after `runPreparedReply`             |
| `server-startup.ts`                | Session resume via `agentCommand` (not heartbeat)             | Manual                           | `agentCommand` in server-startup                          |
| `context-anatomy-db.ts`            | SQLite persistence for timeline (replaces JSONL)              | Fork-only (no merge risk)        | `anatomy-timeline.db`                                     |
| `context-anatomy.ts`               | Extended `ContextAnatomyEvent` type + JSONL functions removed | Yes (type may need re-extension) | `responseThinkingTokens`                                  |
| `attempt-hooks.ts`                 | `insertAnatomyEvent` + `updateAnatomyResponse` calls          | Yes (write path may revert)      | `insertAnatomyEvent`                                      |
| `pi-embedded-subscribe.ts`         | `responseBreakdown` char counters                             | Yes (state may revert)           | `responseBreakdown`                                       |

---

## 7. Bug Fix Log

### FIXED: Gateway Crash Loop — Missing dist/index.js (2026-03-26)

- **Symptom:** Gateway systemd service in crash loop (85+ restarts, ~5s interval). Jarvis fully offline — no WhatsApp, no webchat, no LLM sessions. Tinker UI disconnected.
- **Root cause:** `dist/index.js` (gateway entry point) was missing — the entire `dist/` directory was empty. Node threw `MODULE_NOT_FOUND` on every startup attempt. Likely caused by an interrupted build or merge that cleared `dist/` without completing the write.
- **Fix:** Cleared stale caches (`dist/.cache`, `node_modules/.cache`) and rebuilt with `pnpm build`. Restarted gateway with `openclaw-restart` (SIGUSR1, 1s recovery).
- **Rule:** After any build failure or upstream merge, verify `dist/index.js` exists before restarting. Consider adding a pre-start guard to the systemd unit and a `dist/index.js` check to `merge-guardian.sh`.

### FIXED: WhatsApp Plugin Runtime Unavailable — Two Layered Failures (2026-03-21)

- **Symptom:** Every message in Tinker UI returns `WhatsApp plugin runtime is unavailable`. Two distinct errors surfaced sequentially.
- **Root cause 1 — stale workspace shadow:** `~/.openclaw/workspace/extensions/whatsapp/` was a 15-day-old copy (from 2026-03-06 workspace sync) that overrode the freshly-merged bundled version. It lacked `light-runtime-api.ts` and `runtime-api.ts` introduced by upstream commit `30a94dfd3`. Workspace extensions (rank 1) override bundled (rank 3) by design.
- **Root cause 2 — boundary discovery gap:** After removing the workspace copy, the runtime boundary's independent `loadPluginManifestRegistry()` call (no `workspaceDir`, different cache key than startup) only found 46/85 plugins. WhatsApp is an optional bundled cluster excluded from tsdown build — no `dist/extensions/whatsapp/` entry exists. The boundary's discovery silently dropped it.
- **Fix 1:** Removed stale `~/.openclaw/workspace/extensions/whatsapp/`.
- **Fix 2:** Added `OPENCLAW_BUNDLED_PLUGINS_DIR=/home/globalcaos/src/tinkerclaw/extensions` to `~/.config/systemd/user/openclaw-gateway.service`. This upstream-supported env var bypasses auto-detection and ensures the boundary discovers all source extensions including optional clusters.

### FIXED: Auth Error Badge Not Seeded for Dead OAuth Tokens (2026-03-21)

- **Symptom:** When an OAuth profile (cli-sv, cli-gm) had a dead/expired token, the models panel showed disconnected dashed bars but no clickable error badge. Users couldn't trigger re-auth because there was nothing to click.
- **Root cause:** `loadBudget()` only seeded error badges from `config.models` `disabledReason` (billing/cooldown). Dead tokens returned null from the usage API, but null was treated as "disconnected" (dashed bars) without also setting a `providerErrors` entry.
- **Fix:** `loadBudget()` now seeds a clickable `AUTH ERROR` badge in `providerErrors` for any OAuth profile (`cli-*`) where the budget API returns null usage data. The badge gets the `auth-clickable` class, enabling the reload/re-auth popover.
- **File:** `tinker-ui/src/app.ts` (`loadBudget`)

### FIXED: OAuth Re-Auth Token Exchange Wrong Content-Type (2026-03-21)

- **Symptom:** In-UI re-authentication flow completed (popup captured code) but token exchange returned an error from Anthropic's token endpoint.
- **Root cause:** `exchangeCodeForTokens()` in `extensions/auth-reload/reauth.ts` sent `Content-Type: application/json` with a JSON body, but Anthropic's `/v1/oauth/token` endpoint requires `application/x-www-form-urlencoded`. Also missing `state` parameter in the exchange request.
- **Fix:** Changed Content-Type to `application/x-www-form-urlencoded` with `URLSearchParams` body encoding. Added `state` parameter. Improved code parsing to accept three formats: `code#state` (auto-capture redirect fragment), bare authorization code, or full callback URL with `?code=` query param.
- **File:** `extensions/auth-reload/reauth.ts` (`exchangeCodeForTokens`)

### FIXED: Auth Flow Errors Showing [object Object] (2026-03-21)

- **Symptom:** When auth reload, re-auth start, or token exchange failed, the toast notification showed `[object Object]` instead of a human-readable error message.
- **Root cause:** Catch blocks in all three auth flow handlers string-coerced the raw gateway error object (which is `{ error: "message" }`) instead of extracting the message field.
- **Fix:** All auth flow catch blocks now extract `err.message || err.error` before displaying in toast.
- **File:** `tinker-ui/src/app.ts` (3 catch blocks: `auth.reload`, `auth.reauth.start`, `auth.reauth.exchange`)

### FIXED: Budget Panel Extension Crash on Startup (2026-03-21)

- **Symptom:** Budget panel extension failed to register ANY gateway methods (`budget.usage`, `budget.status`, `config.models`), causing all model panel data to be unavailable.
- **Root cause:** `extensions/budget-panel/index.ts` called `registerPluginHttpRoute()` which doesn't exist in the plugin SDK. The crash on this call prevented all subsequent `registerMethod()` calls from executing.
- **Fix:** Changed to `api.registerHttpRoute()` (the correct plugin SDK method, same as used in the tinker extension).
- **File:** `extensions/budget-panel/index.ts`

### FIXED: Billing Error Badges Cleared by File Watcher (2026-03-21)

- **Symptom:** When a model hit a billing cap, the error badge appeared briefly then disappeared. Re-sending a message hit the same billing cap again.
- **Root cause:** The `auth.profiles.updated` handler (triggered by file watcher on credential changes) unconditionally cleared all `providerErrors` entries before refreshing the budget panel. A billing cap error would trigger a credential file write (cooldown update), which triggered the file watcher, which cleared the billing error badge.
- **Fix:** The handler now preserves `billing` and `auth_permanent` errors in `providerErrors` during the clearing phase. Only transient errors (rate limits, overloaded, auth) are cleared on profile updates.
- **File:** `tinker-ui/src/app.ts` (`auth.profiles.updated` handler)

### FIXED: Stale Usage Cache After Re-Auth (2026-03-21)

- **Symptom:** After successfully re-authenticating via the in-UI OAuth flow, the models panel still showed dashed bars (disconnected) for up to 30 minutes.
- **Root cause:** The budget panel cached null usage results with 2min TTL and real data with 30min TTL. After re-auth, the `auth.profiles.updated` handler called `loadBudget()` which hit the backend cache — still serving the pre-re-auth null data until the 30min TTL expired.
- **Fix:** `loadBudget()` now accepts `{ forceRefresh: true }` which passes `forceRefresh` to the `budget.usage` RPC call. The backend `usageCache` is busted when this flag is set, forcing a fresh fetch with the new token. The `auth.profiles.updated` handler always passes this flag.
- **Files:** `tinker-ui/src/app.ts` (`loadBudget`), `extensions/budget-panel/index.ts` (`budget.usage` handler)
- **Scope:** 46 of 49 workspace extensions were stale duplicates of bundled extensions — all potential shadow failures. Only 3 are genuinely workspace-specific (`google-gemini-cli-auth`, `minimax-portal-auth`, `test-utils`).
- **Files:** systemd service file, `~/.openclaw/workspace/extensions/whatsapp/` (deleted)
- **Full report:** `memory/knowledge/whatsapp-light-runtime-api-incident-2026-03-21.md`

### FIXED: Cloudflare Blocks OAuth Refresh — Root Cause of Sleep Recovery Failure (2026-03-18)

- **Root cause:** pi-ai's `refreshAnthropicToken()` calls `fetch()` without a `User-Agent` header. Cloudflare blocks these with error 1010. Token refresh silently fails → access token stays expired → all Anthropic requests fail → falls to qwen3.
- **Why Claude Code works:** Claude Code's SDK includes proper headers. Same OAuth tokens, same API, different HTTP client behavior.
- **Fix:** `refreshAnthropicOAuthToken()` in `credential-file.ts` sends `User-Agent: openclaw-gateway/1.0`. Used by both `oauth.ts` and `proactive-refresh.ts` for Anthropic refreshes. pi-ai's function kept for other providers.
- **Files:** `credential-file.ts`, `oauth.ts`, `proactive-refresh.ts`

### FIXED: Overloaded (529) Retry Storm (2026-03-18)

- **Root cause:** On 529, gateway retried 4+ times per profile with backoff, then rotated to next profile, retried again. 3+ minutes wasted hammering an overloaded API — made the overload worse.
- **Fix:** On `reason === "overloaded"`, skip `advanceAuthProfile()` entirely. Throw `FailoverError` immediately so model fallback picks qwen3 in seconds. 529 = provider is stressed, not per-key issue.
- **Files:** `run.ts` (prompt path + assistant path)

### FIXED: Partial Streamed Text Wiped on Error (2026-03-18)

- **Root cause:** `messages.filter(!_temporary)` cleared all streaming messages on error. Partial Opus response (thinking + text) disappeared.
- **Fix:** Convert temporary messages with content to permanent `_partial` messages before filtering.
- **Files:** `app.ts`

### FIXED: Session Resume Silent Failure (2026-03-18)

- **Root cause:** `requestHeartbeatNow({ reason: "session-resume" })` routed through 5 heartbeat gates that silently blocked it — "session-resume" was classified as "other" by the reason classifier, causing HEARTBEAT.md content check, quiet hours, disabled heartbeat, and wrong-prompt failures
- **Fix:** Replaced heartbeat-based resume with direct `agentCommand()` call (same pattern as `boot.ts`). Added "session-resume" → "wake" in `heartbeat-reason.ts` as defense in depth. Added guardian check.
- **Files:** `server-startup.ts` (main), `heartbeat-reason.ts` (defense), `merge-guardian.sh` (guard)

### FIXED: Send Button Never Enabled (2026-03-03)

- **Root cause:** `updateBtn()` never called after `connected = true`
- **Fix:** Added `updateBtn()` calls after gateway handshake and in `ws.onclose`
- **Verification:** Enter key always worked (bypassed button state)

### FIXED: Plugin API Wrong Method (2026-03-04)

- **Root cause:** Used `api.registerHttpHandler()` which doesn't exist in the plugin SDK
- **Fix:** Rewrote to `api.registerHttpRoute({ path: "/tinker", auth: "gateway", match: "prefix", handler })`

### FIXED: \_\_filename ESM Crash (2026-03-03)

- **Root cause:** `tsdown` bundled `bindings` inline into ESM where `__filename` is undefined
- **Symptom:** Gateway crashed every ~8 min when WhatsApp history DB accessed
- **Fix:** `external: ["better-sqlite3", "bindings"]` in ALL 8 `tsdown.config.ts` entries
- **Rule:** After every build: `grep -r '__filename' dist/ --include='*.js' | grep -v node_modules` should return nothing

### FIXED: Missing Import Broke Model Glow (2026-03-03)

- **Root cause:** `getSessionResetPrompt` used but never imported in `get-reply-run.ts`
- **Symptom:** ReferenceError killed reply handler → no lifecycle events → no model glow
- **Fix:** Added import, added to wiring script + guardian checks

### FIXED: Error Badges Bleeding Across Models (2026-03-05)

- **Root cause:** `fallback-error` handler stored errors keyed by bare provider name (e.g., `"anthropic"`). Rendering fell back to `providerErrors.get(provider)`, so ALL models from that provider showed the same error badge (opus, sonnet, haiku × 3 keys = 6 rows all showing "billing cap").
- **Fix:** 4 changes in `app.ts`:
  1. `fallback-error` handler: key by `failedProfileId || failedModel || failedProvider` (not bare provider)
  2. Rendering: fall back to `providerErrors.get(modelId)` instead of `providerErrors.get(provider)`
  3. Start-phase clearing: also delete model-keyed entries
  4. Health poll + retryProvider: also clear `provider/*` pattern entries
- **Rule:** `providerErrors` keys must never be bare provider names — always use profileId, modelId, or at minimum `provider/model`

### FIXED: Fallback Errors Never Emitted to UI (2026-03-05)

- **Root cause:** `agent-runner-execution.ts` and `followup-runner.ts` had no `onError` callback → `fallback-error` lifecycle events never reached Tinker UI. Also `run.ts` only had 4 of 6 `fallback-profile-error` emission paths wired.
- **Fix:** Added `onError` callbacks in both runners emitting `fallback-error`. Extended `run.ts` to emit on all 6 failure paths with provider/model fields. Added `onError` in `model-fallback.ts` for provider-level cooldown skips.
- **Commit:** `29ff272d4`

### FIXED: onlyBuiltDependencies Wiped by Merge (2026-03-05)

- **Root cause:** Upstream merge wiped `pnpm.onlyBuiltDependencies` → `better-sqlite3` native addon never built → crash on WhatsApp DB access
- **Fix:** Restored `better-sqlite3`, `@discordjs/opus`, `opusscript` to `onlyBuiltDependencies`
- **Commit:** `033526256`

### FIXED: configSchema Mandatory (2026-03-05)

- **Root cause:** Upstream made `configSchema` mandatory in plugin manifests
- **Fix:** Added field to `openclaw.plugin.json`
- **Commit:** `033526256`

### FIXED: Stop Button Not Working During Streaming (2026-03-06)

- **Root cause:** Two issues: (1) Click listener attached directly to `.thinking-run` elements inside `updateChat()` — during streaming, `innerHTML` replacement between mousedown and mouseup detached the element before the click event fired. (2) `abort()` didn't clear `activeRuns`, so even successful aborts showed no visual feedback until server events arrived.
- **Fix:** (1) Moved click handler to delegated listener on `#messages` container, registered once in `init()` — survives innerHTML wipes. (2) Added `activeRuns.clear()` in `abort()` for immediate UI response.
- **Rule:** Never attach per-element click listeners on DOM that gets replaced by innerHTML during streaming. Use event delegation.

### FIXED: WhatsApp Lifecycle Events Contaminating Main Session (2026-03-03)

- **Root cause:** `enqueueSystemEvent()` for WA connect/disconnect/relink routed to main because `resolveAgentRoute()` with no `peer` → `peerId=""` → all `dmScope` branches fall through to `buildAgentMainSessionKey()` → `agent:main:main`
- **Fix:** Removed 4 `enqueueSystemEvent` calls in `src/web/auto-reply/monitor.ts` (journal still logs these)
- **Rule:** `enqueueSystemEvent` without a peer WILL go to main session. Don't use for channel lifecycle.
- **Commit:** `1ba87b077`

### FIXED: Usage Bar Fills Invisible (2026-03-07)

- **Root cause:** `.usage-bar` and `.usage-bar-fill` were `<span>` elements (inline by default). CSS `height` and `width` percentages are ignored on inline elements — bars rendered as 3px background tracks but fills had 0 effective width.
- **Fix:** Added `display:block` to both `.usage-bar` and `.usage-bar-fill` in `base.css`
- **Rule:** When using `<span>` for visual elements with dimensional properties, always set `display:block` or `display:inline-block`

### FIXED: Budget Panel Token Rotation Breaking Agent Auth (2026-03-09)

- **Root cause:** On usage API 429, budget-panel called `forceRefreshToken()` which rotated the OAuth token via Anthropic strict rotation — immediately invalidating the agent runner's in-memory token. Both cli-sv AND cli-gm got 401 errors simultaneously.
- **Fix:** On 429, return cached data instead of refreshing tokens. `usageCache[label]` updated with current timestamp to prevent re-fetching during the rate limit window.
- **Rule:** Budget panel must NEVER call `forceRefreshToken()` — it's a read-only consumer of OAuth tokens, not a token lifecycle participant.
- **Commit:** `f7e552f44`

### FIXED: Error Clearing Too Aggressive (2026-03-09)

- **Root cause:** Lifecycle `start` handler cleared ALL `providerErrors` entries matching the starting model's provider. When cli-gm succeeded after cli-sv hit rate limit, cli-sv's error badge was wiped.
- **Fix:** Only clear the specific `authProfileId` from the start event + the `startModel` key. Other profiles' errors persist until they individually succeed or health poll clears them.
- **Commit:** `9d1162aa8`

### FIXED: Session Resume Not Working After Gateway Restart (2026-03-08)

- **Root cause:** Two bugs: (1) `clearSessionResume` in `get-reply.ts` fired _before_ `runPreparedReply`, so the resume file was deleted before the crash-prone LLM streaming phase. (2) `enqueueSystemEvent` in `server-startup.ts` is passive — it only prepends text to the next LLM call's context but never triggers one, so the resumed prompt sat idle until the user manually sent a new message.
- **Fix:** (1) Moved `clearSessionResume` to after `runPreparedReply` completes. (2) Added `requestHeartbeatNow({ reason: "session-resume", sessionKey })` to actively trigger an LLM run on the interrupted session (same pattern as `/hooks/wake` with `mode=now`).
- **Files:** `src/auto-reply/reply/get-reply.ts`, `src/gateway/server-startup.ts`
- **Commit:** `11c7dfa5e`
- **Rule:** Resume files must persist through the entire LLM streaming phase. Passive system events need `requestHeartbeatNow` to trigger active processing.

### FIXED: Hippocampus Plugin Not Found Warning (2026-03-10)

- **Root cause:** Hippocampus was configured as enabled in `openclaw.json` (`plugins.entries.hippocampus`) but had no extension directory with `openclaw.plugin.json`. The config validator scans `extensions/` for manifests to build `knownIds` — missing manifest = "plugin not found" warning on every gateway start.
- **Fix:** Created `extensions/hippocampus/` with manifest + no-op `index.ts` stub. The actual hippocampus code (importance scoring, dedup, episodic buffer) lives in `src/memory/engram/` and is wired at build time — the extension exists solely for plugin discovery.
- **Commit:** `92580a562`
- **Rule:** Any fork-only subsystem referenced in `openclaw.json` plugin entries must have a corresponding `extensions/<id>/openclaw.plugin.json` manifest, even if the code is wired elsewhere.

### FIXED: Gateway Draining Deadlock — Orphan Processes (2026-03-11)

- **Root cause:** `KillMode=process` in `openclaw-gateway.service` meant systemd only killed the main gateway PID on restart. Child processes (agent runs, channel workers, cron tasks) survived as orphans in the cgroup, accumulating across restarts (200 tasks, 10.8GB memory). When Jarvis used the gateway restart tool mid-task, the drain couldn't complete because orphaned tasks held the "draining" state — all new LLM requests rejected with "Gateway is draining for restart; new tasks are not accepted".
- **Fix:** Changed `KillMode=control-group` in `~/.config/systemd/user/openclaw-gateway.service` + `systemctl --user daemon-reload`. Now systemd kills the entire cgroup on restart — no orphans survive.
- **Rule:** After `openclaw gateway install --force`, verify `KillMode=control-group` is preserved (upstream default is `process`). If draining errors recur, check `systemctl --user status openclaw-gateway` for orphan child processes with old PIDs.
- **Symptom path:** UI shows "sending" → no response → all 4 fallback models fail with same drain error → `Agent failed before reply: Gateway is draining for restart`

### FIXED: Stuck Cron Session Resurrecting Across Restarts (2026-03-11)

- **Root cause:** Cron task `fdc72836` got stuck during the drain deadlock above. The gateway persists incomplete cron runs as `.jsonl` files in `~/.openclaw/cron/runs/`. On every boot, the gateway restores them from disk and re-runs them — immediately re-entering the stuck state. Cleaning `overseer-state.json` alone was insufficient; the cron run file kept resurrecting the session.
- **Fix:** Deleted `~/.openclaw/cron/runs/fdc72836-*.jsonl` + purged 15 accumulated cron entries from `overseer-state.json`.
- **Rule:** If a cron task is stuck and survives gateway restarts, check `~/.openclaw/cron/runs/` for its `.jsonl` file. Delete it to break the resurrection loop. Also: Jarvis should never use the gateway restart tool while his own tasks are active — the SIGUSR1 drain will deadlock if the draining task is the one being drained.

### FIXED: Heartbeat Contaminating Webchat (2026-02-21, config)

- **Root cause:** Heartbeat ran in main session, its prompt+response persisted to transcript, webchat loaded from history
- **Fix:** Config-only: `heartbeat.session: "heartbeat"`, `heartbeat.target: "none"`
- **Lesson:** When suppression patches don't work, check the PERSISTENCE layer

### FIXED: Mute Button Not Toggling (2026-03-19)

- **Root cause:** All dev-mode API calls (`jarvis-mute`, `context-anatomy`) hardcoded `http://localhost:18789` as base URL, bypassing Vite proxy. Cross-origin POST with `Content-Type: application/json` triggered CORS preflight (OPTIONS) which gateway auth middleware rejected with 401. `.catch(() => {})` silently swallowed all errors — button appeared functional but never toggled.
- **Fix:** Changed all API base URLs to `""` (routes through Vite proxy at `/tinker/api` which injects `Authorization: Bearer` header). Removed `Content-Type: application/json` from mute POST. Added `/tinker/api` proxy route to `vite.config.ts`. Added defensive OPTIONS handler to mute endpoint.
- **Lesson:** Never bypass Vite proxy for gateway API calls in dev mode — the proxy handles auth injection. Silent `.catch(() => {})` hides real failures; at minimum log the error during development.

### FIXED: Context-Anatomy 400 "Absolute path required" (2026-03-19)

- **Root cause:** Gateway loaded the tinker extension 3 times (source repo + workspace + gateway reload). Source version had a broad `pathname.startsWith("/tinker/api/")` catch-all for the file-read API that matched ALL `/tinker/api/` routes — including context-anatomy and mute — returning 400 before specialized handlers ran.
- **Fix:** Synced source extension from workspace version (mute → context-anatomy → file-read API ordering). Replaced `~/.openclaw/workspace/extensions/tinker/` with a symlink to `~/src/tinkerclaw/extensions/tinker/` to prevent future desync.
- **Lesson:** The gateway loads extensions from both source and workspace dirs. Keep them in sync via symlink. Specific routes must come before catch-all routes.

### FIXED: "Overloaded" Label Persisting Indefinitely (2026-03-19)

- **Root cause:** Three clearing mechanisms all broken: (1) health poll called `provider.health` which doesn't exist on gateway; (2) `loadBudget` clearing skipped profiles with null usage data (cli-gm always null due to 403 scope error); (3) 2h TTL never expired because each new error re-set the timestamp.
- **Fix:** Clear provider errors for `authProfileId` and `provider/model` on successful run completion (`phase=end`). `loadBudget` clearing no longer requires usage data — clears transient errors for any profile in the response (preserves `billing`/`auth_permanent`).
- **Files:** `app.ts` (onEvent `phase=end` handler + `loadBudget` clearing)

### FIXED: Proactive Refresh Failing Silently (2026-03-19)

- **Root cause:** When credential file had expired tokens and the refresh API returned null (stale refresh token), no log was emitted — just "token expired" then silence. Made it impossible to diagnose dead OAuth profiles from logs.
- **Fix:** Added 3 log lines in `proactive-refresh.ts`: credential file expired (with minutes ago), credential file unreadable, refresh returned null (with actionable `anthropic-oauth-login.mjs` command).

### FIXED: Usage Cache 30min Lockout After Boot (2026-03-19)

- **Root cause:** Budget-panel cached failed usage fetches (`null`) with same 30min TTL as successful ones. On boot, if token wasn't ready yet (proactive refresh still running), null was cached for 30 minutes → dashed lines even after token refreshed seconds later.
- **Fix:** `CACHE_TTL_FAILED_MS = 2min` for null results, `CACHE_TTL_MS = 30min` for real data. Boot-time token races self-heal in 2 minutes.
- **File:** `extensions/budget-panel/index.ts`

### FIXED: OAuth Refresh Downscoping All Tokens (2026-03-20)

- **Root cause:** `refreshAnthropicOAuthToken()` in `credential-file.ts` passed `scope: "user:inference"` in the refresh request body. OAuth 2.0 `scope` in a refresh request is a **downscope** — it restricts the new token to only the listed scopes. Every refreshed token lost `user:profile`, `user:file_upload`, `user:mcp_servers`, etc. The `/api/oauth/usage` endpoint requires `user:profile` → 403 on all budget-panel usage fetches → dashed lines on all opus model rows.
- **Cascade:** Downscoped tokens were written back to BOTH `auth-profiles.json` AND credential files (`.credentials-sv.json`, `.credentials-gm.json`), corrupting the credential files that were supposed to be source of truth. cli-sv's refresh token was also invalidated by Anthropic strict rotation after 2 days, making it unrecoverable without re-login.
- **Fix:** Removed `scope: "user:inference"` from `refreshAnthropicOAuthToken()`. Omitting `scope` preserves the original grant's full scope set per OAuth 2.0 spec. Manually re-synced tokens from Claude Code's `.credentials.json` (full scopes) and re-logged cli-sv via `anthropic-oauth-login.mjs --profile sv`.
- **File:** `src/agents/auth-profiles/credential-file.ts`
- **Commit:** `b11812feb`
- **Rule:** Never pass `scope` in OAuth refresh requests unless intentionally downscoping. The refresh grant inherits all scopes from the original authorization.

### FIXED: WhatsApp QR Pairing 515 Restart Dead Code (2026-03-20)

- **Root cause:** Fork inlined `getStatusCode()` from upstream's `session-errors.ts` but missed the `err.error?.output?.statusCode` fallback added in upstream PR #27910. Baileys wraps errors as `{ error: { output: { statusCode: 515 } } }` — without the fallback, `login.errorStatus` was always `undefined` and the entire 515 restart path in `waitForWebLogin` was dead code. QR scan succeeded but the phone showed "cannot log in" because the restart socket was never created.
- **Cascade:** Two additional issues compounded: (1) single global creds save queue instead of per-authDir queues meant creds weren't reliably flushed before restart, (2) even with proper detection, the restart socket connected too fast (368ms) — WhatsApp servers need ~3s to finalize device registration after `pair-device-sign`.
- **Fix:** Added `err.error?.output?.statusCode` to `getStatusCode()`, ported per-authDir `credsSaveQueues` Map + `waitForCredsSaveQueueWithTimeout()`, added 3s delay before restart socket creation.
- **Files:** `extensions/whatsapp/src/session.ts`, `extensions/whatsapp/src/login-qr.ts`, `extensions/whatsapp/src/login.ts`
- **Commit:** `cd30d97cb`
- **Rule:** After upstream merges, verify fork's inlined `getStatusCode` matches upstream's `session-errors.ts`. The error unwrapping depth is critical for Baileys disconnect handling.

---

## 8. Design Principles

1. **Zero upstream overlap.** All UI lives in `tinker-ui/`. Never patch `ui/`. If a feature needs a gateway change, it gets a wiring function in `apply-fork-wiring.mjs` and a guardian check.

2. **Operator-first.** Tinker is for the operator, not end users. Show everything: tool calls, fallback chains, token costs, context anatomy, agent topology. Hide nothing.

3. **Pub-sub, zero polling (where possible).** Use lifecycle events from WebSocket, not timers. Health poll (60s) is the exception — only used for error badge recovery.

4. **Degrade gracefully.** If no active runs, show empty state in overseer panel. If forensic mode isn't available, hide the toggle. If anatomy API returns empty, show "No data" instead of crashing.

5. **Persist what matters.** Error messages to localStorage (survive refresh). Active runs to sessionStorage (survive navigation). Draft to localStorage (survive everything).

6. **Provider-colored everything.** Model glow, timeline bars, thinking dots, treemap segments — all use the provider color palette consistently.

7. **No framework, no abstraction.** Vanilla DOM manipulation. One file for the app (`app.ts`). Each panel is one file. This isn't scalable engineering — it's a power tool for one operator.

---

## 9. Post-Merge Verification Checklist

After any upstream merge, verify:

```bash
# Guardian checks (automated)
grep "fallback-profile-error" src/agents/pi-embedded-runner/run.ts  # 6 matches
grep "agent-events" src/agents/pi-embedded-runner/run.ts
grep "failedProfileId" src/auto-reply/reply/followup-runner.ts
grep "onError" src/auto-reply/reply/agent-runner-execution.ts
grep "authProfileId" src/agents/pi-embedded-runner/attempt.ts
grep "session-reset-prompt" src/auto-reply/reply/get-reply-run.ts
grep "Allow webchat delete" src/gateway/server-methods/sessions.ts
grep "external" tsdown.config.ts  # 8+ matches
grep "tinker" src/plugins/config-state.ts
grep "onlyBuiltDependencies" package.json  # better-sqlite3, opusscript, @discordjs/opus
grep "resolveApiKeyForProfile" extensions/budget-panel/index.ts
grep "ensureAuthProfileStore" extensions/budget-panel/index.ts
grep "getModelUsage" tinker-ui/src/app.ts
grep "claudeProfiles" tinker-ui/src/app.ts
grep "OPENCLAW_BUNDLED_PLUGINS_DIR" ~/.config/systemd/user/openclaw-gateway.service  # must point to extensions/

# Workspace shadow check — no workspace extension should duplicate a bundled one
comm -12 <(ls extensions/ | sort) <(ls ~/.openclaw/workspace/extensions/ 2>/dev/null | sort) | head -5
# If output is non-empty, stale workspace copies are shadowing bundled extensions — remove them

# Build check
cd tinker-ui && pnpm build
grep -r '__filename' ../dist/ --include='*.js' | grep -v node_modules  # should be empty

# Manual smoke test
# 1. Gateway starts without crash
# 2. /tinker/ loads in browser
# 3. Send a message — get a response
# 4. Model glow appears during response (only active model row, not all)
# 5. Fallback errors show per-model, NOT per-provider
# 6. Error badges clear when provider recovers
# 7. Overseer pills show active runs with breathing glow
# 8. Context timeline populates after response
```

---

## 10. File Quick Reference

| File                                          | Lines | Purpose                                                             |
| --------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `tinker-ui/src/app.ts`                        | ~2300 | Entire frontend app                                                 |
| `tinker-ui/src/styles/base.css`               | ~450  | All styles (earth theme + textures)                                 |
| `tinker-ui/public/favicon.png`                | —     | Tab favicon (TheTinkerZone icon_rounded, B&W, transparent bg)       |
| `tinker-ui/public/icon.png`                   | —     | Topbar logo (wood-textured "The Tinker Zone" sign) — DO NOT replace |
| `tinker-ui/src/panels/context-timeline.ts`    | ~780  | Bottom bar token chart (round-level)                                |
| `tinker-ui/src/panels/context-treemap.ts`     | 1038  | Token composition treemap                                           |
| `tinker-ui/src/panels/response-treemap.ts`    | 703   | Output token treemap                                                |
| `tinker-ui/src/panels/overseer-graph.ts`      | 128   | Overseer pill visualization                                         |
| `extensions/tinker/index.ts`                  | ~140  | Gateway plugin (serves UI + file-read API)                          |
| `extensions/tinker/openclaw.plugin.json`      | ~15   | Plugin manifest                                                     |
| `extensions/hippocampus/index.ts`             | ~22   | Plugin stub (registers ID; code in src/memory/engram/)              |
| `extensions/hippocampus/openclaw.plugin.json` | ~11   | Plugin manifest                                                     |

---

## 11. Fork Backend Systems (Non-UI)

These are fork-exclusive backend systems that run server-side. They are not part of the Tinker UI but represent significant divergence from upstream and are visible through Tinker's treemap (prompt composition), timeline (token usage), and model panel (provider selection).

### 11.1 WhatsApp whatsmeow Backend (2026-03-26)

- **Status:** `DEPLOYED` (opt-in via env var)
- **What:** Alternative WhatsApp backend using `whatsmeow-node` (Go-based, more reliable than Baileys for multi-device). Env var `OPENCLAW_WHATSAPP_BACKEND=whatsmeow` activates it; default remains `baileys` (zero behavior change).
- **Architecture:**
  - `baileys-adapter-wm.ts` — wraps whatsmeow-node client to expose the Baileys socket interface (`sendMessage`, `sendPresenceUpdate`, `readMessages`, `groupMetadata`, `ev` events) so the existing 400+ line `monitor.ts` pipeline works without rewrite
  - `monitor-wm.ts` — creates whatsmeow client + adapter, passes to `monitorWebInbox`
  - `backend-selector.ts` — reads `OPENCLAW_WHATSAPP_BACKEND` env var, exports `getWhatsappBackend()`
  - `monitor.ts` — wired with static imports (dynamic imports were tree-shaken by tsdown bundler — 3 fix iterations)
  - `channel.ts` — `loginWithQrStart`/`loginWithQrWait` route to whatsmeow versions when backend=whatsmeow
  - `auth-store.ts` — `webAuthExists` checks `whatsmeow.db` (>8KB) instead of `creds.json` when backend=whatsmeow
- **Login flow fixes:** Timeout increased to 180s for QR scan + pairing + 515 restart cycle. `defaultRuntime` dependency removed (undefined in dynamic import context). `force=true` only on first Relink call, not refresh polls (prevented active login from being killed).
- **History backfill:** Per-chat backfill using each chat's own last message as anchor (not global latest). Uses `sendPeerMessage` (peer=true). No artificial limits — backfills ALL stale chats (DMs + groups) where last message >24h old, excluding `status@broadcast`.
- **Files:** `extensions/whatsapp/src/baileys-adapter-wm.ts`, `monitor-wm.ts`, `backend-selector.ts`, `auth-store.ts`, `channel.ts`, `inbound/monitor.ts`, `login-qr-wm.ts`, `session-wm.ts`; `src/whatsapp-history/live-capture-wm.ts`

### 11.2 AMYGDALA — Personality Thermostat (2026-03-23)

- **Status:** `PHASE 1 (Shadow) DEPLOYED` — text-based nudge injection only. No neural networks trained or deployed yet.
- **What:** Personality steering system that injects context-aware nudges into the system prompt to adjust the agent's behavioral traits toward a target personality vector. Phase 1 of the AMYGDALA architecture described in the [Learned Intuition paper](docs/papers/learned-intuition/learned-intuition.md).
- **Paper vs Reality:** The paper describes a 10-neural-network ensemble (5 Prudence for safety gating + 5 Personality for behavioral modulation) with PPO training, conformal prediction, ONNX inference, and a 4-phase trust ramp. **Current implementation is Phase 1 (Shadow) only** — a 15-dimension personality target vector with text-based nudge templates. No neural networks, no Prudence gating, no conformal prediction. The Prudence family (action gating, stop/allow/escalate) is entirely unimplemented.
- **Deployed components:**
  - **Target vector (15 dimensions):** 8 core personality dimensions + 5 curiosity attractors + 2 fractal depth parameters. Hand-crafted initial values (PPO calibration planned for Phase 2).
  - **Personality decoder:** Compares current embedding vs target, produces natural language nudges.
  - **Nudge pipeline:** Wired into system prompt via `buildSystemPrompt()`. Nudges are context-aware templates.
  - **Humor-aware templates:** Reference the [Humor Embeddings paper](docs/papers/humor-embeddings/humor-embeddings.md) for bridge discovery patterns.
  - **Curiosity decomposition:** 5 genuine interest attractors (supersedes the [Curiosity Motivation paper](docs/papers/curiosity-motivation/curiosity-motivation.md)'s CCA architecture, which is NOT implemented).
  - **Fractal reflection:** 4-level metacognition in `attempt-hooks.ts` (`maybeTriggerFractalReflection`, lines 527-711). Fires on success, not just failure. FRACTAL_PROMPT template with 4 levels: (1) specific event, (2) pattern it belongs to, (3) system/architecture producing the pattern, (4) worldview assumptions. Original system-event approach disabled (race conditions with user messages) — now inline: model appends `🌿 FRACTAL Level X:` tags to its own response. Includes ripple scan for cross-domain effects. Note: the [Fractal Reasoning paper](docs/papers/fractal-reasoning/fractal-reasoning.md)'s FMI data structures (Hilbert-curve index, IFS compression, Be-tree) are NOT implemented — they remain a theoretical research agenda. The metacognition formalism (R_1, R_2, R_3 reasoning scales) IS deployed via the prompt-level implementation.
  - **Visible influence tags:** `***AMYGDALA***` and `***FRACTAL***` in system messages (see §5.43).
  - **Shadow logging:** All decisions logged for observability.
- **Not yet implemented:** Prudence family (5 networks), neural network training (PPO), conformal prediction, ONNX inference, Catastrophic Failure Database, trust ramp Phases 2-4.
- **Files:** `src/amygdala/`, `attempt-hooks.ts` (fractal reflection hook), wired in `attempt.ts`

### 11.3 ENGRAM — Memory & Retrieval System (2026-02 → 2026-03)

- **Status:** `DEPLOYED` (progressive rollout across 30+ commits)
- **What:** Fork-exclusive memory infrastructure replacing upstream's basic session history with a multi-phase cognitive memory system. Visible in Tinker UI treemap as retrieval pack tokens injected into the system prompt.
- **Phases:**
  - **Phase 0+1A:** Metrics collection, event store (per-turn ingestion), artifact store, test harness
  - **Phase 1B-1D:** Pointer compaction (reduces repeated context), push pack (proactive recall), recall tool (agent-initiated retrieval), contradiction gate (pre-action state conflict detection)
  - **Phase 2:** Async embeddings with task-conditioned scoring (relevance depends on what the agent is doing)
  - **Phase 3:** Sleep consolidation — cron-driven episode detection, overnight memory reorganization
  - **Entity extraction:** Daily log cache, multilingual entity recognition, single DB connection pooling
  - **Global FTS5 index:** Replaced per-session JSONL search with SQLite FTS5 full-text index for retrieval pack
  - **Retrieval pack injection:** Wired into system prompt pre-prompt path behind `ENGRAM_POINTER_COMPACTION` flag
- **Extension:** `extensions/hippocampus/` — plugin stub that registers the hippocampus ID; actual code lives in `src/memory/engram/`
- **Files:** `src/memory/engram/`, `extensions/hippocampus/`, `src/fork/hooks/` (hippocampus-hook), wired in `attempt.ts`

### 11.4 CORTEX / LIMBIC / SYNAPSE — Cognitive Subsystems (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Three fork-exclusive cognitive modules that enhance the agent's behavioral layer. All inject into the system prompt pipeline.
- **CORTEX (Identity Persistence):** [Paper](docs/papers/identity-persistence/identity-persistence.md) — 4,974 LOC, 368 tests, 100% pass
  - `PersonaState` loaded from `SOUL.md` / `VOICE.md`, injected as priority context
  - SyncScore automation with EWMA drift detection (measured SyncScore 0.977 in production)
  - Behavioral probes, consistency metric, convergence monitor
  - Mid-context re-injection and observational memory
  - E_phi persona feature space (8 linguistic features + 128 dense embedding = 136-dim)
  - **Paper claims validated:** drift recovery 0.027→0.980, 442× separation, human eval alpha=0.81
  - Files: `src/memory/cortex/` (`persona-state.ts`, `drift-detection.ts`, `behavioral-probes.ts`, `priority-injection.ts`, `consistency-metric.ts`, `convergence-monitor.ts`, `voice-markers.ts`)
- **LIMBIC (Humor Pipeline):** [Paper](docs/papers/humor-embeddings/humor-embeddings.md) — 1,348 LOC core + 700 LOC runtime, fully implemented Phase 6
  - **h_v2 scoring:** `humorPotentialV2(A, B, bridge, index)` = distance × validity × surprise. Configurable thresholds: δ*min=0.6, δ_max=0.95, τ_v=0.15, τ*σ=0.3
  - **Bridge discovery cascade** — 5 methods in priority: (1) midpoint search, (2) analogy via vector arithmetic, (3) orthogonal blending, (4) graph traversal (placeholder for ConceptNet), (5) LLM-guided generate-then-score (fallback when quality < q_min)
  - **12-pattern taxonomy** in 4 meta-categories: Semantic (antonymic inversion, hyperbolic extension, reductio), Pragmatic (expectation subversion, register shift, overload), Structural (domain transfer, similarity-in-dissimilarity, frame collision), Temporal (callback, escalation, bathos). All 12 fully implemented with vector math scoring.
  - **Sensitivity gate:** 13 hard-block categories (death, grief, suicide, child_abuse, etc.). Audience modeling with familiarity function. Calibration from PersonaState (humorFrequency, sensitivityThreshold, preferredPatterns).
  - **Humor associations:** Persistent memory with staleness model (λ=0.3/use, μ=0.001/hour), callback bonus with 3-month onset decay, running gag detection.
  - **Runtime:** Session-scoped `LimbicRuntime` + `HumorTrigger` with rate limiting (1 attempt per 10 turns). Positive reaction detection (emoji/laugh patterns). All attempts/reactions logged to ENGRAM event store.
  - **Embedding gap:** Currently uses deterministic FNV-1a hash embeddings (128-dim, not semantic). Bridge discovery is mathematically valid but not semantically meaningful. Connecting a real embedding service (OpenAI, local model) via the `AnnIndex` interface would activate the full semantic pipeline.
  - **Validation gap:** h_v1 falsified in pilot (n=15). h_v2 proposed but full validation protocol (N≥64 raters) has NOT been executed.
  - Files: `src/memory/limbic/` (8 files), `src/agents/pi-extensions/limbic-runtime.ts`, `humor-trigger.ts`. Tests: 3 test files + benchmarks.
- **SYNAPSE (Multi-Model Debate):** [Paper](docs/papers/round-table/round-table.md) — reported 63.6% on GPQA Diamond (single run)
  - CDI (Cognitive Diversity Index), RAAC 5-phase protocol (Propose/Challenge/Defend/Synthesize/Ratify)
  - 5 parallelism patterns (Fan-Out, Moderated Tribunal, Full RT, Tournament, Editorial Swarm)
  - Persistent deliberation with 3 artifact tiers
  - Exposed as agent tool for on-demand use
  - **Note:** GPQA Diamond result from single run — needs multi-run confidence intervals.
  - Files: `src/memory/synapse/` (`cognitive-diversity.ts`, `raac-protocol.ts`, `debate-architectures.ts`, `persistent-deliberation.ts`)

### 11.5 Research Papers — Implementation Status

11 papers in `docs/papers/`. Status of each relative to deployed code:

| Paper                        | System      | Status        | Notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fractal Reasoning            | AMYGDALA    | `DEPLOYED`    | Metacognition deployed: 4-level FRACTAL_PROMPT in `attempt-hooks.ts`, inline depth climbing (🌿 tags). FMI data structures (Hilbert-curve, IFS, Be-tree) remain theoretical — paper is research agenda                                                                                                           |
| Humor Embeddings             | LIMBIC      | `DEPLOYED`    | 1,348 LOC core + 700 LOC runtime. h_v2 scoring, 5-method bridge discovery, all 12 patterns, sensitivity gate, humor associations with staleness. Uses deterministic FNV-1a embeddings (not semantic) — connecting real embedding service would activate full pipeline. h_v2 unvalidated (needs N≥64 rater study) |
| Agent Security (AEGIS)       | —           | `DESIGN ONLY` | Conceptual security framework. No AEGIS-specific code — describes OS/network/process-level controls                                                                                                                                                                                                              |
| Learned Intuition (AMYGDALA) | AMYGDALA    | `PHASE 1`     | Text nudge injection deployed (15-dim target vector). 10-network ensemble, PPO training, Prudence gating NOT built                                                                                                                                                                                               |
| Total Recall                 | ENGRAM      | `DEPLOYED`    | Best-implemented paper. Event store, pointer compaction, retrieval packs all match paper claims                                                                                                                                                                                                                  |
| Sleep Consolidation          | ENGRAM      | `DEPLOYED`    | Documents actual operational behavior (30 days, 14 mutations). Post-hoc formalization of emergent behavior                                                                                                                                                                                                       |
| Identity Persistence         | CORTEX      | `DEPLOYED`    | Well-implemented. 4,974 LOC, 368 tests. Metrics match paper claims                                                                                                                                                                                                                                               |
| Instant Recall               | Hippocampus | `DEPLOYED`    | Pre-computed concept index, FTS5. 2,286 LOC, 158 tests                                                                                                                                                                                                                                                           |
| Round Table                  | SYNAPSE     | `DEPLOYED`    | CDI, RAAC protocol, debate architectures implemented. GPQA result needs multi-run validation                                                                                                                                                                                                                     |
| Curiosity Motivation         | —           | `DESIGN ONLY` | CCA/LoRA architecture NOT implemented. Curiosity handled via 5 personality attractors in AMYGDALA instead                                                                                                                                                                                                        |
| Corporate Swarm (HIVEMIND)   | —           | `DESIGN ONLY` | Enterprise swarm design paper. No implementation exists                                                                                                                                                                                                                                                          |

### 11.6 WhatsApp Feature Enhancements (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Fork-specific WhatsApp improvements beyond upstream's basic integration.
- **SQLite History Storage:** `better-sqlite3` with FTS5 full-text search for WhatsApp message history. Replaces in-memory storage. Files: `src/whatsapp-history/`
- **Offline Message Recovery:** On reconnect, recovers messages received during the offline window (6h). Messages annotated as `offline-recovered` for review-before-action.
- **Audio Transcription Gate:** Audio messages are transcribed _before_ triggerPrefix check (not blanket bypass). Ensures voice notes go through the same routing as text.
- **Sent Message ID Tracking:** Tracks outbound message IDs to prevent voice note echo re-ingestion (bot hearing its own TTS output).
- **Group Typing Indicators:** `presenceSubscribe` for groups before composing, for both inbound monitor and outbound API.
- **515 Stream Error Auto-Restart:** WhatsApp's 515 disconnect handled with automatic reconnection.
- **Strict 3-Rule Group Gate:** No bypasses for media or owner messages — all group messages go through triggerPrefix + whitelist + rate limit.
- **triggerPrefix for DMs:** DM conversations also require triggerPrefix (upstream doesn't enforce this).
- **senderE164 Resolution:** Resolves sender phone number for `fromMe` group messages where Baileys lacks the `participant` field.
- **Files:** `extensions/whatsapp/src/`, `src/whatsapp-history/`

### 11.7 Fork Infrastructure (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Merge automation and hook architecture that allows the fork to absorb upstream changes without manual patching.
- **Fork Hook Architecture (`src/fork/`):**
  - `attempt.ts` refactored: 10 inline blocks → 2 hook imports
  - All fork-specific logic extracted to `src/fork/hooks/` for merge independence
  - Marked with `// FORK:` comments throughout codebase for visibility
- **Merge Automation:**
  - `merge-upstream.sh` — automated upstream merge with conflict resolution
  - `apply-fork-wiring.mjs` — 12+ patch functions that re-apply fork hooks after merge (imports + call sites)
  - `merge-guardian.sh` — checks 20+ wiring points, builds, learns from failures
  - `safe-cron-merge.sh` — daily at 04:45 with self-healing retry
  - 13 TIER1 files auto-resolved via `--theirs` + re-wiring
  - Documented in §6 (Backend Fork Patches) and §9 (Post-Merge Checklist)
- **Session Resume on Gateway Restart:**
  - Multi-session resume with liveness watchdog and scope-isolated restart
  - TTL bumped from 60s to 300s
  - System event sent to main session after SIGUSR1 restart
  - Files: `src/fork/session-resume.ts`, wired in `server-startup.ts`
- **Proactive OAuth Refresh:**
  - Generic refresh for all OAuth profiles (not just hardcoded SV/GM)
  - `credentialFile` config option in auth profiles for external token files
  - Generic credential file I/O module
  - Files: `src/auth/proactive-refresh.ts`, `credential-file.ts`
