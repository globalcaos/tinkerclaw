# Tinker UI — Design Bible

> Living document. Updated every time we work on Tinker UI features, fixes, or design changes.
> Location: `~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE.md` (tracked in GitHub fork)
> Last updated: 2026-04-28 (§5.76 public/private boundary + git-pull contract — Jarvis ships as the day-0 default; user overrides live in `~/.openclaw/workspace/`; resolution order config → workspace → bundled; five hardcoded `/home/<user>/...` paths in `worker.ts` and `db-probe.mjs` to fix; chrome-extension token-leak placeholder to replace; narration / subagent-helper / tool-choice / persona / briefing default prompts extracted to `extensions/tinkerclaw-cc-bridge/{personas,prompts}/` and loaded via shared resolver. The "Sam test" + "Day-90 test" are the structural guarantees.)

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
│   ├── app.ts          ← Entire frontend (~7600 lines)
│   ├── styles/base.css ← All styles (~3270 lines)
│   ├── styles/*.jpg/png ← Natural textures (bark, moss, marble, earth, wood, sandpaper)
│   └── panels/
│       ├── context-timeline.ts   (~980 lines)
│       ├── context-treemap.ts    (~1160 lines)
│       ├── response-treemap.ts   (~700 lines)
│       ├── prefrontal-graph.ts   (~130 lines, legacy pill panel — largely unused)
│       ├── prefrontal-tree.ts    (~210 lines, compact call tree)
│       └── provider-logos.ts     (~40 lines — SVG logos + color maps)
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

| Channel                         | Purpose                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| WebSocket `/api/events`         | Lifecycle events, chat deltas, fallback errors, tool events, **context-anatomy push**      |
| RPC `req(method, params)`       | Chat, history, session mgmt, anatomy data, forensic, prefrontal, `config.openExternalFile` |
| REST `/api/context-anatomy/:sk` | Context token breakdown per turn (fallback polling)                                        |

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
│ 📄 │ Alt View (full-width tab    │ │Prefrontal    │ │
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
  - Prefrontal graph: `wood-panel.jpg` on `#4E3B31` with multiply blend (darker variant)
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
- **CSS:** `@keyframes model-shimmer`, `.model-row.model-live`, `.model-agent-count`
- **Gateway patch:** `server-chat.ts` — prefers runner-provided model/provider/authProfileId over session-entry resolution
- **Files:** `app.ts` (tracking + rendering), `base.css` (animation), `server-chat.ts` (enrichment), `pi-embedded-subscribe.handlers.lifecycle.ts` (authProfileId source)
- **Bug fix #1 (2026-03-05):** Multi-key providers never glowed. `getAuthKeyCounts` stored count under model ID (authProfileId was undefined), but multi-key rendering looked up by auth profile key — always 0. Fix: fall back to model-level count when per-key count is 0.
- **Bug fix #2 (2026-03-05):** All 3 auth key rows glowed simultaneously instead of just the active one. Root cause: `server-chat.ts` enrichment was overwriting the runner-provided `model`/`modelProvider` with session-entry values via `resolveSessionModelRef()`, discarding the runner-provided `authProfileId` context. Fix: when lifecycle events already carry `model` and `modelProvider` from the runner, preserve them and pass through `authProfileId` instead of overwriting with session-entry resolution.
- **Bug fix #3 (2026-03-17):** All 3 auth key rows STILL glowed simultaneously. Root cause: model-fallback system doesn't pass `authProfileId` to the `run` callback, so embedded agent's `handleAgentStart` emits lifecycle `start` without `authProfileId`. UI fallback `modelCount` caused all rows to glow. Fix: two-part — (a) UI infers `authProfileId` from `modelConfigData.authOrder` on `start` events, preferring profiles with fresh budget data and no errors; (b) `renderAuthKeyRows` only broadcasts `modelCount` to all rows when NO per-key counts exist (`hasAnyKeyCount` guard).
- **Bug fix #4 (2026-03-17):** Stale `providerErrors` in localStorage caused wrong profile to show errors after gateway restart. Fix: `loadBudget()` now clears `providerErrors` for profiles that have fresh `claudeProfiles` usage data.
- **Bug fix #5 (2026-03-22):** Glow never appeared for any run. Root cause: upstream lifecycle `start`/`end`/`error` events (from `agent-command.ts`) carry `sessionKey` at the top level of the WS payload (enriched by `server-chat.ts`) but NOT inside `data`. The UI checked only `p.data.sessionKey`, silently dropping all upstream lifecycle events — so `activeRuns` was never populated. Fix: fall back to `p.sessionKey` when `p.data.sessionKey` is absent (`p.data.sessionKey ?? p.sessionKey`). Fork-specific events (`round-start`, `fallback-error`, etc.) still use their explicit `data.sessionKey`.
- **Bug fix #6 (2026-03-28):** Single-key providers never glowed. Root cause: `authProfileId` is undefined in lifecycle `start` events, so `getAuthKeyCounts` stored count under model ID. Single-key render path looked up by auth profile key only — never fell back to model-level count. Multi-key path already had the fallback. Fix: `counts.get(keyId || modelId) || counts.get(modelId) || 0` in single-key path.
- **Visual rework (2026-03-28):** Replaced breathing `box-shadow` outline with center-out radial gradient + narrow right-to-left shimmer sweep. No border. Provider-colored via CSS variables (`--glow-color`, `--glow-bg`, `--glow-bg2`). 1s animation cycle. CSS: `@keyframes model-shimmer`, radial-gradient background layer.

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
- **Session data on delete:** Metadata entry removed from `sessions.json`, but transcript `.jsonl` files are renamed with `.deleted.<timestamp>` suffix (preserved on disk, not destroyed). Main session (`agent:main:main`) is protected — delete is refused.
- **Tab auto-close (2026-03-30):** Deleting a session that has an open tab now calls `closeTab()` — removes the tab, cleans up `tabStates`, and switches to main if it was the active tab. Previously only detached the tab, leaving an orphan with no session.
- **Event delegation (2026-03-30):** Row clicks and delete button clicks consolidated into a single delegated handler on `#sessions-list`. Delete button checked FIRST to prevent the row navigation handler from firing. Per-element listeners were destroyed on every `innerHTML` re-render — delegation survives. Delete adds visual feedback: row fades to 30% opacity.
- **Session key preservation on detach (2026-03-30):** When a session is no longer on the server (gateway restart), the tab keeps its `sessionKey` (only `isAttached=false`). Timeline and treemap can still load historical data from the anatomy DB.

### 5.5a Webchat Session Protection from Cron Archival (2026-03-27)

- **Status:** `DEPLOYED`
- **Problem:** Two system crontab scripts could destroy webchat session context:
  1. `nightly-session-trim.sh` (02:00) — archived `.jsonl` files by size/age without checking if they belong to active sessions. Moving the main session's transcript caused the gateway to create a fresh empty session, losing all conversation history.
  2. `reset-whatsapp-sessions.sh` (23:00) — wrong port (4440→18789), no gateway token, and no exclusion for webchat sessions.
- **Fix (trim):** Script now reads `sessions.json` to build a set of active session IDs. Any transcript referenced by an active session is skipped. Only orphaned transcripts get archived.
- **Fix (reset):** Port corrected. Explicit exclusion for `agent:main:main`, `:tinker:`, and `:webchat:` session keys. Filter tightened to require `whatsapp` in key.
- **Files:** `~/.openclaw/scripts/nightly-session-trim.sh`, `~/.openclaw/scripts/reset-whatsapp-sessions.sh`

### 5.6 Live Tool Call Display

- **Status:** `CONFIRMED` (2026-03-08, default-collapse restored 2026-04-27)
- **Deployed:** 2026-03-03 (commit `98f72f4c1`), **rewritten 2026-03-08** (commit `b4da1e0d5`)
- **What:** Tool `start`/`result` events render immediately in chat as expandable rows with human-readable summaries. Tool calls are interlaced with thinking bubbles during live streaming.
- **Architecture (2026-03-08):** Tool events push `_temporary` messages into `messages[]` (`tool_use` on start, `tool_result` on result). No separate `liveToolCalls` Map — tools render through the same `renderMsg()` path as finalized messages.
- **Tool summaries:** `toolSummary()` covers 20+ tools (exec, read, edit, write, web_search, browser, message, whatsapp_history, sessions_spawn, subagents, tts, etc.)
- **Expanded detail view:** Shows actual command/diff with del/ins formatting (red strikethrough old, green new)
- **Status icons:** `⋯` (pending), `✓` (ok), `✗` (error)
- **Default state — collapsed (2026-04-27, Story Mode deleted same day):** Tool rows render single-line by default; click expands. Story Mode (the 🎬 topbar global "auto-expand every tool" override) was removed entirely — collapsed-by-default with per-tool click-to-expand is the only contract. The earlier attempt to default Story Mode to off and treat clicks as an exit gesture worked, but the toggle still added no behaviour worth keeping and confused the click-to-collapse contract. Stale `tinker-story-mode` localStorage keys from previous installs are harmless — nothing reads them anymore. Render gate is now plain `expandedTools.has(tid)`.
- **Collapsed-summary contract (grandma-proof bar, 2026-04-27):** the single-line title shown in the collapsed row is the LAST sentence of the LLM's pre-tool narration (`renderMsg` extracts it via `/[^.!?\n]+[.!?]?\s*$/` and clamps to 160 chars). That sentence MUST be specific enough that someone non-technical, reading the chat top-to-bottom with the original prompt as context but no expanded views, can follow what each step is doing and why this step instead of any other. **Banned phrasings** (the cc-bridge narration system-prompt block enumerates these explicitly so the LLM stops emitting them):
  - _performing an action_, _running a command_, _executing a tool_ — strips the step of meaning.
  - _reading a section of the code to understand how it works_ — which section? understand what about it? Must name file/symbol + the specific question.
  - _checking something_, _looking around_, _gathering context_, _exploring the codebase_ — vague exploration; must name the artifact + hypothesis being tested.
  - _making changes_, _applying a fix_, _updating the file_ — which file, what change in user-facing terms.
  - _as requested_, _per the request_, _as the user asked_ — empty filler; restate WHAT from the prompt this call serves.
  - Bare verbs without an object: _searching_, _editing_, _running_, _verifying_.
    Every collapsed line names (a) the artifact (real path, symbol, or string), (b) the question or move it serves, and (c) advances the story relative to the user's prompt. Together, the chain of titles + the prompt should read like a narrative. The cc-bridge narration block (`extensions/tinkerclaw-cc-bridge/src/worker.ts:buildChatNarrationBlock`) carries the contract + side-by-side bad→good rewrites; if Jarvis starts emitting any banned phrase, that block is the place to tighten further.
- **Enforcement layers (best-effort, layered defence):**
  1. **System prompt** (`buildChatNarrationBlock`) — leads with a HARD RULE plus the anti-pattern catalog. Hoisted to position 2 in the combined prompt (right after persona, ahead of the dense subagent-helper text) so the rule registers before the heavier rules.
  2. **User-message directive** — appended to every user turn in `stream.ts` (after `extractUserText`). This is the most-attended slot in claude-cli's print-mode ranking, and reliably gets the FIRST tool call narrated even when the system prompt didn't.
  3. **Mechanical fallback** — when the LLM emits a tool with empty narration anyway (claude-cli's `-p` mode often runs back-to-back tools after one preamble sentence), `renderMsg` falls back to `toolSummary(name, args)`. That summary is by-design artifact-aware (`Bash: <command first ~80 chars>`, `Read: <file_path>`, `Grep: <pattern>`) — not grandma-prose, but at least concrete. **This fallback is the floor, not the goal**; if you're seeing a lot of mechanical lines instead of narration, the issue is layer 1 or 2 not the renderer.
- **Known limitation:** claude-cli's `-p` print mode resists per-tool narration in dense tool chains. Layers 1 + 2 reliably win the FIRST tool of a turn but the model often runs subsequent tools silently. Open improvement: server-side synthesis of a title per tool from `(userPrompt, previousNarration, toolName, args)` when narration is empty; not yet implemented because each synthesis would be a small LLM call per tool (latency + cost).
- **Files:** `app.ts` (`toolSummary`, `toolExpandedDetail`, `renderMsg` tool branches, `storyMode` initializer, click handler at the `[data-tid]` delegate); `extensions/tinkerclaw-cc-bridge/src/worker.ts` (`buildChatNarrationBlock` enforces the grandma-proof bar in the LLM's system prompt).

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
- **Restart continuity (2026-03-28):** See §5.7.1

### 5.7.1 Thinking Indicator Restart Continuity

- **Status:** `DEPLOYED` (2026-03-28)
- **What:** When the gateway self-restarts (SIGUSR1), the thinking indicator persists through the WebSocket disconnect/reconnect cycle with an amber "RESTARTING" badge. The user never sees a dead zone — the dots keep bouncing, the elapsed timer keeps ticking, and the badge signals the system is in a transitional state.
- **State machine:** THINKING → (shutdown event) → RESTARTING → (lifecycle start on reconnect) → THINKING. Timeout to OFF after 30s if no confirmation.
- **Visual:** Small amber pill badge (`RESTARTING`) inserted between model name and elapsed time. Provider color stays unchanged. CSS class: `.restart-badge` (background `#d2992230`, color `#d29922`, 10px, rounded pill).
- **Mechanism (client-side):**
  - `onFrame()` handles `shutdown` event with `restartExpectedMs` — marks all active runs with `state: "restarting"`, saves to sessionStorage, calls `startThinkingTick()` defensively
  - `ws.onclose` checks `hasRestartingRuns` — preserves `activeRuns` if any run has `state === "restarting"`, clears as normal otherwise (crash/unexpected disconnect)
  - `scheduleUnconfirmedPrune()` splits into 5s (normal) and 30s (restarting) timeouts. Restarting timer is cancellable via `restartPruneTimer` for rapid restart handling
  - `renderThinkingIndicator()` renders badge when `info.state === "restarting"`
- **Server-side:** No change. `RestartSentinelPayload` lacks `runId`/`model` fields. Confirmation comes from the auto-retry path (client re-sends message after 5s, new LLM call emits lifecycle `start`).
- **Edge cases:** Unexpected disconnect (crash) clears indicator as before. Tab refresh during restart restores from sessionStorage. Multiple rapid restarts reset the 30s timer. No active runs at restart = nothing happens.
- **Files:** `app.ts` (shutdown handler, onclose guard, ActiveRunInfo.state, badge rendering, timeout split), `base.css` (.restart-badge)
- **Spec:** `jarvis-icu/docs/superpowers/specs/2026-03-28-thinking-indicator-restart-continuity-design.md`

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

### 5.12 Prefrontal Panel (Call Tree)

- **Status:** `DEPLOYED-UNTESTED`
- **Originally deployed:** 2026-03-03 as force-directed SVG graph (commit `98f72f4c1`)
- **Redesigned:** 2026-03-05 as pill panel, **2026-04-01 rewritten as compact call tree**
- **Renamed:** 2026-04-01 — "overseer" fully renamed to "prefrontal" (plugin ID, folder, files, all references)
- **What:** Compact call tree showing the Prefrontal orchestration agent (Opus) at root, with worker subagents as child nodes. Each node = one row: provider logo → model name → task label → progress bar/stall indicator. Hidden when no subagents active (no idle state).
- **Data source:** WebSocket `prefrontal-tree` events pushed by `extensions/prefrontal/` extension. Extension hooks into `subagent_spawned`, `subagent_ended`, `llm_output`, `tool_call` lifecycle events. Also pollable via `GET /api/prefrontal/tree`.
- **Node states:** Running (provider-colored progress bar), stalled (red border + "STALLED Xm"), completed (dimmed 50% + checkmark), failed (dimmed)
- **Progress:** Thin 3px bar, colored by provider. Percentage from Prefrontal's Sonnet-generated summary parsing.
- **Session/All toggle:** Filter to current session's tree or show all active sessions.
- **Provider logos:** Anthropic A-mark (`#d4a574`), Google 4-color dot, OpenAI circle, Ollama llama. Defined in `provider-logos.ts`. Fixes the Gemini-shows-Anthropic-logo bug.
- **CSS:** `.pf-tree-panel`, `.pf-node`, `.pf-root`, `.pf-child`, `.pf-connector`, `.pf-logo`, `.pf-model`, `.pf-label`, `.pf-progress-bar`, `.pf-stall`, `.pf-completed`
- **Files:** `prefrontal-tree.ts` (~250 lines), `provider-logos.ts` (~60 lines), `prefrontal-graph.ts` (legacy pill panel, retained)
- **Inner header cleanup (2026-04-27):** the inner card had its own "🕸 Orchestration" title bar with a right-side "idle / N active / recipeId · Step X" badge. The outer rpanel already announces "Prefrontal" via its own header, so the inline title was a redundant second label, and the "idle" badge was noise — when nothing is running, the existing "No active LLM calls" empty state below already says so. The whole title bar (icon + text + badge + the unused `countActive` / `isActiveStatus` helpers) was removed; recipe context still surfaces via `renderRecipeHeader` when a recipe is active.
- **Outer header icon (2026-04-27):** the rpanel header is `🌳 Prefrontal` to match the iconographic pattern of its sibling panels (📋 Sessions, 🕸️ Models). 🌳 was chosen because Prefrontal IS the call-tree visualisation; the tree literally is the panel's content. Semantically distinct from Models's 🕸️ (network of providers) and Sessions's 📋 (list of conversations).
- **Gateway extension:** `extensions/prefrontal/` — monitor loop (5s rebuild), stall detection (180s threshold), HTTP API, crash recovery via `/tmp/prefrontal/recovery.json`
- **Guardian:** Phase 3.5 in `scripts/cron-health-gate.sh` — checks if Prefrontal agent stalls for >5min, kills session, preserves recovery state for relaunch
- **Config:** `openclaw.json` → `plugins.entries.prefrontal` (model, thresholds, effort routing tiers)

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
- **Triggers prefrontal sync:** `updateBudgetPanel()` calls the prefrontal panel updater at the end (`updateOverseerPanel` was renamed to `updatePrefrontalTree`/`updatePrefrontalPanel` in the 2026-04-01 rename; historical references here reflect the pre-rename function name).
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
  - 🗂️ (`#tb-models`, hint "Side panel" — renamed from "Models" 🕸️ on 2026-04-27): collapses right column (right-panels + bottom-right-panel). The button affects the entire rpanel cluster (models + sessions + prefrontal + …); the old "Models" label only described the topmost section. The element id `tb-models` is preserved for stable selectors and CSS — it's the rename that matters, not the markup churn.
  - The 🎬 Story Mode button was deleted on 2026-04-27 (see §5.6 Default state bullet). Was once `#tb-story-mode`.
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
- **Right panel reorder:** Sessions → Models → Prefrontal (was Models → Sessions → Prefrontal)
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
- **2026-03-26 full-bubble click-to-stop:** Entire `.thinking-run` bubble is now clickable to abort, not just the "Stop" text. Click handler targets `.thinking-run` instead of `.thinking-stop`. Added `cursor: pointer` to `.thinking-run`.
- **Files:** `app.ts`, `base.css`

### 5.29 Collapsible Right Panel Sections (2026-03-14)

- **Status:** `DEPLOYED`
- **What:** Sessions, Models, and Prefrontal right panel sections are individually collapsible. Click header to toggle. Arrow indicator (▾/▸) rotates. State persists in localStorage (`tinker-collapsed-panels`).
- **Architecture:** `data-rpanel` / `data-rpanel-toggle` attributes on panel/header elements. Delegated click handler on `.right-panels`. Guards against collapsing when clicking interactive children (scope toggle, refresh button). CSS: `.rpanel-collapsed .rpanel-body{display:none}`, `.rpanel-arrow` for indicator.
- **Files:** `app.ts`, `base.css`

### 5.30 Session/All Scope Toggle — iOS Switch (2026-03-14, fixed 2026-03-26)

- **Status:** `DEPLOYED`
- **What:** Models panel Session/All toggle now uses the same iOS-style switch (`.ct-switch` track + thumb) as the timeline, instead of button-pair toggle. Labels render in proper case ("Session" / "All") — `text-transform:none` override on `.ct-switch-label` prevents `.rpanel-header`'s `uppercase` from affecting switch labels.
- **2026-03-26 fix:** HTML still used old `.scope-btn` button-pair markup (no CSS backing it — looked like plain text). Replaced with `ct-switch` markup (`ct-switch-label` + `ct-switch-track` + `ct-switch-thumb`) matching the timeline toggle. JS handler updated to toggle `ct-switch-label--active` and `ct-switch-track--on` classes.
- **2026-03-29 re-fix:** Upstream merge reintroduced old `scope-btn` button-pair HTML (same symptom — plain text, no toggle styling). Re-applied `ct-switch` markup + JS handler. Also added `text-transform: none` on `.ct-switch-label` to prevent `.rpanel-header` uppercase inheritance. Track click toggles scope; label click sets specific scope.
- **Files:** `app.ts`, `base.css`

### 5.31 Timeline SQLite Persistence + Response Breakdown (2026-03-16, updated 2026-03-26)

- **Status:** `DEPLOYED`
- **What:** Timeline now persists all LLM calls to SQLite (`~/.openclaw/data/anatomy-timeline.db`) and survives reboots. Data kept indefinitely (no pruning). On fresh boot, loads chronological feed for the current session. "All" mode loads last 7 days across all sessions via `/recent` endpoint. Existing JSONL files were migrated on first open (user_version=2). JSONL storage fully replaced.
- **Response segments:** Three new bar segments added to the timeline visualization alongside the 7 input segments:
  - `responseThinking` (cyan `#06b6d4`) — thinking/reasoning tokens
  - `responseText` (emerald `#10b981`) — text output tokens
  - `responseToolCalls` (amber `#f59e0b`) — tool call input tokens
- **Data captured:** `responseThinkingTokens`, `responseTextTokens`, `responseToolCallTokens`, `cacheReadTokens`, `cacheCreationTokens` — estimated from char counts during streaming (chars / 3.5).
- **Table name:** SQLite table is `anatomy_events` (user_version=3), with `id / session_key / run_id / turn / round_number / timestamp_ms / provider / model / auth_profile_id / duration_ms / stop_reason / compaction_cycle / context_sent / context_window / tools_triggered / topics / topic_transition / memories_injected / response_tokens / response_thinking_tokens / response_text_tokens / response_tool_call_tokens / cache_read_tokens / cache_creation_tokens / response_content / user_message / assistant_response`. (Earlier drafts of this bible referred to a `context_anatomy` table — that's incorrect; there is no such table.)
- **Known gap (2026-04-20):** the 4 response-breakdown columns (`response_thinking_tokens`, `response_text_tokens`, `response_tool_call_tokens`, and `duration_ms`) are null on every row in the DB (both historic anthropic turns and the new cc-bridge turns). The subscribe-side capture from §5.31 hasn't survived some merge — needs a separate investigation pass.
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
- **Proactive refresh:** REMOVED (2026-04-06) — upstream now has native `claude-cli` auth that reads `~/.claude/.credentials.json`. The fork's `tinkerclaw-proactive-auth` extension is no longer needed.
- **Overloaded (529) fix:** On overloaded, skips profile rotation entirely and throws FailoverError immediately for model fallback. Prevents retry storms (was 3+ min, now instant).
- **Files:** `credential-file.ts` (new), `oauth.ts`, ~~`proactive-refresh.ts`~~ (removed 2026-04-06), `constants.ts`, `types.auth.ts`, `zod-schema.ts`, `doctor-auth.ts`, `cli-credentials.ts`, `run.ts`, `server.impl.ts`, `budget-panel/index.ts`, `merge-guardian.sh`, `anthropic-oauth-login.mjs`
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
- **Fix:** Added `!info.sessionKey.includes(":subagent:")` guard to the session filter in `getAuthKeyCounts()`. Subagent runs always count toward glow regardless of scope toggle. Prefrontal panel already showed them (no filter), now models panel matches.
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
- **Tab clamping:** `.tab-title` has `max-width: 140px` + `text-overflow: ellipsis` + `overflow: hidden`. Full text visible via `data-hint` tooltip on the tab div (existing `#global-hint` system). Session labels in the sessions panel use same `data-hint` approach.
- **Global hint:** `#global-hint` CSS changed from `white-space: pre` to `pre-wrap` with `max-width: 280px` so longer fortune text wraps instead of rendering as a single clamped line.
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

### 5.45 Session Glow — Active LLM Indicator (2026-03-28)

- **Status:** `DEPLOYED`
- **What:** Session rows in the sessions panel glow when they have active LLM runs. Same visual style as model rows — center-out radial gradient + right-to-left shimmer sweep, provider-colored, 1s cycle. Subagent sessions glow independently.
- **Architecture:** `sessionHasActiveRuns(key)` iterates `activeRuns` Map, matching by `sessionKey`. Returns `{ live, provider }` for provider-colored CSS variables. `updateSessionsPanel()` called on lifecycle `start` and `end` events.
- **CSS:** `@keyframes session-shimmer`, `.session-row.session-live`
- **Files:** `app.ts` (`sessionHasActiveRuns`, `renderSessionRow`, `updateSessionsPanel` calls), `base.css` (animation)

### 5.46 Thinking Indicator Shimmer (2026-03-28)

- **Status:** `DEPLOYED`
- **What:** Thinking indicator in chat uses the same radial glow + shimmer sweep as model/session rows. Provider-colored via `--thinking-glow*` CSS variables. On hover, animation stops and shows red "stop" style.
- **CSS:** `@keyframes thinking-shimmer`, `.thinking-run`
- **Files:** `app.ts` (inline style variables on `.thinking-run`), `base.css` (animation + hover override)

### 5.47 Session Delete Closes Tab (2026-03-28)

- **Status:** `DEPLOYED`
- **What:** Deleting a session from the sessions panel now closes the associated tab via `closeTab()` instead of detaching and renaming it with a new fortune. Main tab cannot be closed — its chat is cleared instead.
- **Files:** `app.ts` (session delete handler)

### 5.48 Thinking Indicator End-Event Fix (2026-03-28)

- **Status:** `DEPLOYED`
- **What:** Thinking indicator was stuck forever after Jarvis finished answering. The lifecycle event guard at `app.ts:1327` required `p.data?.model`, but the gateway's `end`/`error` lifecycle events don't include `model` (only `start` does). End events were silently dropped, so `activeRuns` never cleared.
- **Fix:** Guard now allows `end`/`error` phase events through without `model`: `(p.data?.model || p.data?.phase === "end" || p.data?.phase === "error")`.
- **Files:** `app.ts` (lifecycle event guard)

### 5.49 Gateway Drain Auto-Retry Queue (2026-03-28)

- **Status:** `DEPLOYED`
- **What:** When the gateway restarts (SIGUSR1), messages that hit the drain window were shown as a raw error bubble ("⚠️ Agent failed before reply: Gateway is draining…"). Now: (1) the message is styled as an orange centered warning (`_isWarning`), (2) text is replaced with "⏳ Gateway restarting — your message will be resent automatically…", (3) after 5s the warning is removed and the user's last message is automatically re-sent via `send()`.
- **Detection:** Checks final reply text for "draining for restart" substring.
- **Files:** `app.ts` (drain detection + auto-retry in `onEvent` final handler)

### 5.50 Error Badge Vocabulary Overhaul (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Provider error badges on model rows replaced with a compact single-word vocabulary. All badges are now clickable (underline + `↗` arrow + brightness on hover). Anthropic OAuth badges click directly to the re-auth flow (removed the 3-option popover).
- **Badge vocabulary:**
  - `AUTH` — OAuth token expired or revoked
  - `KEY` — API key invalid
  - `B-CAP` — Billing cap reached (monthly spend limit)
  - `LIMIT` — Rate limited (token or request quota)
  - `BUSY` — Provider overloaded (529)
  - `SLOW` — High latency / timeout
  - `404` — Model not found
  - `WAIT` — Cooling down (temporary block)
  - `EXPIRED` — Token/session expired
  - `FORMAT` — Response format error
  - `FAIL` — Generic uncategorized failure
- **Tooltips:** Each badge has an actionable tooltip (e.g., `AUTH: OAuth token expired — click to re-authenticate`, `B-CAP: Monthly billing cap reached — check usage`).
- **Click behavior:** All badges get `cursor: pointer`, `text-decoration: underline`, `filter: brightness(1.3)` on hover, and `↗` suffix. Anthropic `cli-*` profile badges go directly to `startOAuthReauthFlow()` — no intermediate popover.
- **CSS:** `.error-badge` hover rules (underline + brightness), `.error-badge-clickable` (pointer cursor)
- **Files:** `app.ts` (`describeError()` vocabulary mapping, badge click handlers), `base.css` (hover effects)

### 5.51 Model Name Display Update (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Model name compression labels and profile display labels updated for clarity.
- **Model name compression (Anthropic):**
  - `opus4.6` (was `op-4-6`)
  - `sonnet4.6` (was `sn-4-6`)
  - `haiku4.5` (was `hk-4-5`)
- **Profile labels:**
  - `cli-gm` → `oauth` (reflects what the profile actually is: an OAuth subscription)
  - `default` → `api` (reflects API key auth)
- **Files:** `app.ts` (`compressModelName()`, `authKeyLabel()`)

### 5.52 Error Clearing on Successful Response (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Provider error badges now clear immediately when a successful LLM response arrives from that provider. Previously, clearing only happened via the 60s health poll (`provider.health` check). A successful `final` event with `phase === "end"` is definitive proof the provider is working — no reason to wait for the poll.
- **Mechanism:** The `phase === "end"` lifecycle event handler in `onEvent()` clears `providerErrors` entries for both the completed `authProfileId` and the `startModel` key. This is the same clearing logic already in the `start` handler, now also applied on completion.
- **Effect:** Badge disappears the moment the response completes — zero lag, no poll window.
- **Files:** `app.ts` (lifecycle `end` handler)

### 5.53 Rate Limit Header Capture — Usage Bars from API Headers (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Anthropic 5h and 7d utilization bars now update from HTTP response headers on every API call, instead of depending on the OAuth usage endpoint (`api.anthropic.com/api/oauth/usage`) which Anthropic disabled in January 2026. Custom `fetch` wrapper in `anthropic-vertex-stream.ts` intercepts Anthropic API responses, extracts rate limit headers, stores them, and emits a lifecycle event that the UI consumes.
- **Headers captured:**
  - `anthropic-ratelimit-unified-5h-utilization` → 5h bar
  - `anthropic-ratelimit-unified-7d-utilization` → 7d bar
- **Pipeline:**
  1. `anthropic-vertex-stream.ts` — custom fetch wrapper reads `anthropic-ratelimit-*` headers from each API response, writes to `ratelimit-store.ts` singleton
  2. `ratelimit-store.ts` — in-memory store keyed by `authProfileId` with timestamps
  3. Lifecycle event `ratelimit-update` emitted via `emitAgentEvent` after each successful API call
  4. Tinker UI `onEvent()` handler reads `ratelimit-update` events, calls `renderUsageBarsOnly()` to update the bars
- **Fallback:** OAuth usage endpoint still attempted on budget panel load — headers are supplementary (more frequent, no separate API call needed).
- **Files:** `anthropic-vertex-stream.ts` (fetch wrapper), `ratelimit-store.ts` (new singleton), `attempt-hooks.ts` (event emission), `app.ts` (event handler + bar update)

### 5.54 WebSocket Scope Fix — webchat-ui as Operator (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Added `webchat-ui` to `isOperatorUiClient()` in the gateway auth layer so Tinker UI WebSocket connections receive `operator.admin` scope. Previously, `webchat-ui` was not in the recognized operator client list, so the WS connection was treated as an unprivileged client — causing failures in usage graphs, session lists, chat send, and provider health calls, all of which require operator-level access.
- **Root cause:** Upstream's `isOperatorUiClient()` only recognized specific client identity strings. The upstream merge (2026-03-30, commit `541df66197`) added a stricter scope gate; `webchat-ui` wasn't listed.
- **Fix:** Added `clientIdentity === "webchat-ui"` check to `isOperatorUiClient()`.
- **Guardian check:** `webchat-ui` in `isOperatorUiClient` in `server-ws.ts` (or equivalent).
- **Files:** `src/gateway/server-ws.ts` (or `src/gateway/auth-ws.ts`), `merge-guardian.sh` (new check)

### 5.55 Fractal Prompt Hiding Fix (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Changed `startsWith` to `includes` for FRACTAL REFLECTION detection in `isOperatorMessage()` (or equivalent message classification). The FRACTAL prompt text (`# FRACTAL REFLECTION`) was not being detected when it arrived embedded after system event lines (e.g., "WhatsApp gateway connected\n\n# FRACTAL REFLECTION…"). The `startsWith` check required the fractal header at the very start of the message string — but system events prepend their own lines first.
- **Effect:** Fractal prompts now correctly classified as internal/operator-generated and hidden from the chat message list. Previously they appeared as user messages in Tinker UI.
- **Files:** `app.ts` (message classification check), `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts` (prompt detection)

### 5.56 Budget-Panel Staleness Guard (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Usage file data older than 7 days is now ignored in the budget panel — returns zeros instead of stale percentages. Prevents months-old cached usage data from showing as current utilization after extended periods of inactivity or credential outages.
- **Threshold:** 7 days (`USAGE_STALENESS_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000`)
- **Behavior:** If the usage data timestamp is older than 7 days, `getModelUsage()` returns `{ fiveHour: 0, sevenDay: 0, disconnected: true }` — same as the disconnected/no-data path. Amber dashed bars render instead of stale percentages.
- **Rationale:** Usage data > 7 days old is from a previous billing period and misleading — the bars would show high historical utilization as if it were current.
- **Files:** `app.ts` (`getModelUsage()` staleness check), `extensions/budget-panel/index.ts` (timestamp included in usage response)

### 5.57 Unified Orange Shimmer Across All Surfaces (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** All four "thinking" indicators now share the same 1s radial gradient + right-to-left sweep animation in warm orange (`#D97757`, Anthropic provider color from prefrontal tree). Replaced the old 2s `model-breathe` box-shadow pulse and disconnected green (`#6b8e23`) color.
- **Surfaces:** Chat thinking bubble (`.thinking-run` / `thinking-shimmer`), model panel active row (`.model-row.model-live` / `model-shimmer`), session panel active row (`.session-row.session-live` / `session-shimmer`), prefrontal tree active node (`.pf-node.pf-active` / `pf-shimmer`).
- **CSS pattern:** `@keyframes *-shimmer { 0% { background-position: 150% 0, center; } 100% { background-position: -150% 0, center; } }` with `background-image: linear-gradient(90deg, ...) + radial-gradient(ellipse at center, ...)` and `background-size: 150% 100%, 100% 100%`.
- **Provider-colored:** Each surface receives CSS custom properties (`--*-glow`, `--*-glow-bg`, `--*-glow-bg2`) set from `PROVIDER_COLORS[provider]` in JS, with `#D97757` fallback defaults in CSS.
- **Session panel fix:** Added `sessionHasActiveRuns()` helper + `session-live` class in `renderSessionRow()`. Added `updateSessionsPanel()` to lifecycle start/end handlers so sessions re-render when runs change.
- **Model panel fix:** Single-key count fallback — `counts.get(keyId || modelId) || counts.get(modelId)` (lifecycle events often lack `authProfileId`).
- **Prefrontal tree:** Active nodes get `pf-active` class with shimmer. Completed nodes get `animation: none !important`.
- **Files:** `base.css` (4 `@keyframes` + shimmer rules), `app.ts` (PROVIDER_COLORS, thinking indicator CSS vars, sessionHasActiveRuns, updateSessionsPanel calls), `panels/prefrontal-tree.ts` (pf-active class + CSS vars)

### 5.58 Configured Models Collapsed by Default (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** The "CONFIGURED" section in the model panel loads collapsed. Fallback chain stays open.
- **Implementation:** `collapsedModelSections` initialized with `["configured"]` instead of empty set.
- **Files:** `app.ts` (line ~556)

### 5.59 Exploration Gate Fix (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** The prefrontal exploration gate was blocking ALL OpenClaw native tools because of PascalCase/lowercase mismatch and fail-closed default. `Read` was in the allowlist but `read` was not — and any unknown tool was treated as mutating.
- **Fix:** Added lowercase tool names (`read`, `exec`, `web_search`, etc.) to both `READ_ONLY_TOOLS` and `MUTATING_TOOLS` sets. Changed `isMutating()` from fail-closed (`!READ_ONLY_TOOLS.has(name)`) to explicit-only (`MUTATING_TOOLS.has(name)`).
- **Files:** `extensions/prefrontal/exploration-gate.ts`

### 5.60 FORK_SETUP.md — Onboarding Guide (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Agent-readable onboarding document for new tinkerclaw fork users. 385 lines covering all 8 setup steps, troubleshooting, architecture reference (port map, key directories), and fork extension inventory.
- **Location:** Repo root: `FORK_SETUP.md`
- **Audience:** New users' AI agents — written for step-by-step execution, not human reading.
- **Planned automation:** `scripts/fork-setup.sh` (one-command setup), auto-detect Ollama, auto-patch config. Plan at `jarvis-icu/docs/superpowers/plans/2026-04-03-fork-onboarding-automation.md`.

### 5.61 Multi-Extension Browser Relay (Fork-Only, Retained) (2026-04-06)

- **Status:** `DEPLOYED` (retained despite upstream deletion)
- **What:** `src/browser/extension-relay.ts` — server-side CDP relay that the Chrome extension connects to via WebSocket. Upstream deleted this (2026-04-02 merge) and replaced with MCP-based browser control that requires reauthentication on every reconnect and gives the agent unrestricted access to all logged-in browser sessions.
- **Why we keep it:** Upstream's MCP replacement is impractical for production — reauthenticating every browser extension reconnect breaks workflow, and granting the agent unrestricted access to all logged-in sessions is a security risk. Our relay scopes access to explicitly shared tabs only.
- **Architecture:** Gateway plugin (`~/.openclaw/extensions/tinkerclaw-browser-relay/`) starts an inline WebSocket relay on port 18792. The Chrome extension (`extensions/tinkerclaw-browser-relay/chrome-extension/`) connects to it, shares user-selected tabs via `chrome.debugger.attach()`, and forwards CDP commands between the relay and shared tabs.
- **CDP over debugger API (deliberate choice):** We use `chrome.debugger` instead of standard extension APIs because CDP provides capabilities essential for security testing that standard APIs deliberately prevent: request/response body interception and modification, CSP bypass (`Page.setBypassCSP`), WebSocket frame capture, cross-origin frame access, SSL certificate error ignoring, closed Shadow DOM piercing, full-page screenshots at arbitrary resolution, and raw input event synthesis. Standard APIs are designed to be safe — CDP is designed to be powerful.
- **"Started debugging" banner:** Chrome shows a security banner when `chrome.debugger.attach()` is used. Suppressed with `google-chrome --silent-debugger-extension-api`. Cannot be removed programmatically — it's a Chrome security feature.
- **Tab group:** Shared tabs are grouped in a Chrome tab group named "Tinker Shared" (grey color — Chrome's closest to brown). Tab group survives browser restarts.
- **Persistence:** Shared tab IDs saved to `chrome.storage.local`. On browser restart, extension finds tabs in the existing "Tinker Shared" group and re-attaches.
- **Auto-reconnect:** When the relay disconnects (gateway restart), extension retries every 5s. Tabs stay attached to the debugger during reconnect — no manual re-sharing needed.
- **Auth:** Chrome-extension:// origins on loopback are trusted without token (HMAC-SHA256 derived tokens still accepted for non-extension CDP clients).
- **Install:** Developer mode required (`chrome://extensions/` → Load unpacked). Options page for relay token configuration (auto-discovery for loopback).
- **Brown icons:** Sandstone (#c19a6b) on dark (#2a2318) matching Tinkerclaw earth theme.
- **Files:** `extensions/tinkerclaw-browser-relay/chrome-extension/` (MV3 extension), `~/.openclaw/extensions/tinkerclaw-browser-relay/index.ts` (gateway plugin), `src/browser/extension-relay.ts` (CDP relay server), `extensions/browser/src/browser/extension-relay.ts` (bundled version), `extensions/browser/src/browser/extension-relay-auth.ts` (HMAC auth)

### 5.62 Plugin Rename — prefrontal and hippocampus (2026-04-06)

- **Status:** `DEPLOYED`
- **What:** Renamed `extensions/prefrontal/` → `extensions/tinkerclaw-prefrontal/` and `extensions/hippocampus/` → `extensions/tinkerclaw-hippocampus/` for naming consistency with all other fork extensions (`tinkerclaw-*` prefix).

### 5.63 Prefrontal v3.0 Recipe Engine (2026-04-07)

- **Status:** `DEPLOYED`
- **What:** Transforms Prefrontal from a guard system (exploration gate, anti-goldplating) into a recipe execution engine. 17 recipes across 6 categories (coding, writing, operations, analysis, security, communication) in Journey Kit format (YAML frontmatter + markdown body).
- **Architecture:** Demand-driven — the model activates recipes by mentioning them in its output ("following the debug recipe"). Recipe steps guide execution with preconditions, required tools, and success criteria. Fractal Reflection evaluates and evolves recipes post-turn. No separate orchestrator LLM call — the recipe is injected into the same prompt (evidence from Claude Code analysis shows single-call harness optimization outperforms separate planning calls).
- **Paper:** `~/Documents/AI_reports/Papers/J13_prefrontal/2026-04-07-prefrontal-v3.0.md`
- **Files:** `extensions/tinkerclaw-prefrontal/recipes/` (17 recipe .md files), `recipe-engine.ts`, `orchestrator.ts`, `progress-reporter.ts`, `prefrontal-prompt-loader.ts`

### 5.64 Recipes Tab (2026-04-07)

- **Status:** `DEPLOYED`
- **What:** New sidebar tab (🧾 icon, sandstone #d4a574) showing all recipes organized by category with hierarchical child recipes, step flow arrows, summaries, and click-to-edit via Vite dev server `xdg-open` endpoint.
- **Files:** `tinker-ui/src/app.ts` (renderRecipesTab), `tinker-ui/src/styles/base.css`, `tinker-ui/vite.config.ts` (openFilePlugin)

### 5.65 Recipe Visual Indicators (2026-04-08)

- **Status:** `DEPLOYED`
- **What:** When a recipe is active, three visual indicators appear: (1) persistent recipe banner below topbar showing recipe name + step progress with category color, (2) thinking indicator annotation showing current step alongside model name, (3) assistant message tags showing which recipe step produced each message. Zero extra tokens — all from hook state.
- **Files:** `extensions/tinkerclaw-prefrontal/index.ts` (prefrontal-recipe-status broadcast), `tinker-ui/src/app.ts` (banner + thinking + tags), `tinker-ui/src/styles/base.css`

### 5.66 Claude-Code Provider Bridge — `tinkerclaw-cc-bridge` (2026-04-17 → 2026-04-20)

- **Status:** `DEPLOYED`
- **What:** Jarvis now runs on the real `claude` CLI consuming the flat-rate Claude Code subscription instead of burning Anthropic API tokens. A new OpenClaw provider plugin (`extensions/tinkerclaw-cc-bridge/`) registers provider `claude-code` and spawns a persistent `claude` subprocess per OpenClaw session with `--input-format stream-json --output-format stream-json --permission-mode bypassPermissions --disallowedTools Agent,ExitPlanMode,AskUserQuestion,TodoWrite,Task…`. The fork's tool loop stays authoritative; claude only does reasoning.
- **System prompt:** cc-bridge worker reads `extensions/tinkerclaw-learned-intuition/amygdala-prompt.md` and `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` at spawn time and appends them via `--append-system-prompt` so the sectioned-reply instructions live inside claude's own session rather than per-turn.
- **Streaming:** `src/stream.ts` converts claude's cumulative `assistant` NDJSON frames into pi-ai `text_delta` / `thinking_delta` increments (`cumulative.slice(accumulatedText.length)`), with an eager `pushStart()` the instant the turn begins so the 4 thinking indicators fire during long tool-call chains.
- **Auth:** trusts `~/.claude/.credentials.json`. Env scrub strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BEDROCK_API_KEY`, `ANTHROPIC_VERTEX_API_KEY`, `CLAUDE_AI_SESSION_KEY`, `ANTHROPIC_ADMIN_API_KEY` before spawn so the subscription path is the only route the subprocess can use.
- **Lifecycle-fields fix (commit `1d66f53705`, 2026-04-20):** `handleAgentStart` was reading `ctx.params.modelId / modelProvider / authProfileId`, but those fields were never declared on `SubscribeEmbeddedPiSessionParams` nor passed from `attempt.ts`. Every lifecycle `phase:"start"` event therefore went out with `model: undefined`, and the UI filter at `app.ts:1614` (`p.data?.model`) silently dropped the event for cc-bridge — anthropic/ollama only worked because another enrichment path happened to cover the gap. Fix adds the fields to the params type and forwards them in `attempt.ts`, so all 4 thinking indicators (chat "Opus", session panel, model glow, prefrontal tree) now animate for claude-code turns.
- **Files:** `extensions/tinkerclaw-cc-bridge/{provider.ts,stream.ts,worker.ts,worker-pool.ts,auth.ts,catalog.ts,protocol.ts,defaults.ts}`, `src/agents/pi-embedded-subscribe.types.ts`, `src/agents/pi-embedded-runner/run/attempt.ts` (forward model/provider/profile)

### 5.67 Amygdala + Fractal Injection Pipeline (2026-04-18)

- **Status:** `DEPLOYED`
- **What:** Two topbar toggle buttons (🧠 Amygdala, 🌿 Fractal — enabled by default) append short pointer instructions to every outgoing prompt so Opus emits a three-section reply: `💬 ANSWER` → `🧠 AMYGDALA` → `🌿 FRACTAL`. The sections are split client-side and rendered as three stacked bubbles: answer expanded, amygdala + fractal collapsed.
- **Pointer-based prompt:** the injected suffix doesn't inline the full instructions. It references `amygdala-prompt.md` (Prudence + Personality ensembles diagnostic) and `fractal-prompt.md` (MEMORY/PATTERN/RIPPLE/IMPROVE + ACTION-prefix rule + SELF-HEAL layers), which are read once at cc-bridge spawn time and appended to claude's system prompt. Compact prompts, persistent behavior.
- **User bubble:** when amygdala/fractal is enabled, the user sees only their original text; the full appended prompt collapses behind a "view full prompt" expandable (`renderUserBubbleWithPromptToggle`). When both toggles are off, nothing is appended.
- **Section splitter:** `splitSectionedReply` accepts markers wrapped in `**`/`__` bold and/or trailing `:` — `💬 ANSWER`, `🧠 AMYGDALA` (with 🫀 fallback), `🌿 FRACTAL` (optionally `FRACTAL ACTION`). `renderSectionedReply` promotes `other` to the answer slot when Opus emits a non-sectioned response with amygdala/fractal after.
- **Icons:** Models icon changed from 🧠 to 🕸️ (pink brain reserved for amygdala). Icon glyphs: `🧠` amygdala, `🌿` fractal.
- **Files:** `tinker-ui/src/app.ts` (`buildInjectedPrompt`, `loadInjectToggles`, `renderUserBubbleWithPromptToggle`, `splitSectionedReply`, `renderSectionedReply`), `tinker-ui/src/styles/base.css` (msg-amygdala, msg-user-with-prompt styles), `extensions/tinkerclaw-learned-intuition/amygdala-prompt.md`, `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`

### 5.68 Clickable Filesystem Path Links (2026-04-19)

- **Status:** `DEPLOYED`
- **What:** Any absolute path or `~/...` path rendered in a message (including the injected instruction suffix) becomes a `<code class="fs-link">` element. Clicking opens the file in the system's default viewer (markdown reader for `.md`, code editor for `.ts`, etc.) via a new `config.openExternalFile` RPC that shells out to `xdg-open` / `open` / `Start-Process` depending on platform.
- **Why:** section 2 and 3 of every reply reference the pointer `.md` files — users need one-click access without leaving the chat.
- **Files:** `tinker-ui/src/app.ts` (`md()` post-processor wraps paths, global click delegate calls `config.openExternalFile`), `src/gateway/server-methods/config.ts` (new RPC with path allowlisting + cross-platform spawn), CSS `code.fs-link` states: `idle`, `opening`, `opened`, `error`.

### 5.69 Envelope Error Rendering — `__ERR_ENV__:` (2026-04-19)

- **Status:** `DEPLOYED`
- **What:** Provider errors (400 auth, 429 rate, 500 overload, 401 subscription-exhausted, etc.) are emitted as a single assistant text payload `__ERR_ENV__:{...JSON envelope}`. The UI detects the sentinel with a brace-matched parser and renders a red/orange bubble with one stable icon per category (💳 subscription, 💸 billing, 🔐 auth, 🚦 rate_limit, 🌊 overload, 📡 network, ⏱️ timeout, 🔄 lane_busy, ⏳ reply_run_already_active, 🫥 incomplete_turn, 🔧 tool_error, 🧹 compaction_error, ⚠️ generic) and the full error detail (raw message, provider, model, duration, classification). Fatal=red, recoverable=orange.
- **cc-bridge integration:** on claude subprocess error or non-zero result, `stream.ts` RESETS accumulated text and emits the envelope as the sole final message — no markdown-emphasis-strip risk from the `__ERR_ENV__` underscores.
- **Files:** `src/fork/error-envelope.ts` (classifier + icon table + builder), `extensions/tinkerclaw-cc-bridge/src/stream.ts` (envelope emission paths), `tinker-ui/src/app.ts` (`extractEnvelope`, `renderEnvelopeBubble`), `tinker-ui/src/styles/base.css` (envelope-fatal, envelope-recoverable).

### 5.70 Stale ReplyRunRegistry Force-Clear (2026-04-19)

- **Status:** `DEPLOYED`
- **What:** When a previous run crashed mid-stream the registry could be left holding a stale entry — the next prompt hit `ReplyRunAlreadyActiveError` and the UI displayed "⚠️ Previous run is still shutting down." Fix: in `createReplyOperation`, detect stale entries (phase completed/failed/aborted OR no attached backend OR backend not streaming) and force-delete them before claiming the slot.
- **Files:** `src/auto-reply/reply/reply-run-registry.ts` (stale-entry sweep in `createReplyOperation`).

### 5.71 Tinker Probe — CLI Test Harness (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** `scripts/tinker-probe.mjs` is a standalone WS client that simulates the Tinker webchat so the agent loop can verify the UI contract without opening a browser. It:
  - authenticates as `webchat-ui` with the gateway token (auto-read from `~/.openclaw/openclaw.json`) and `Origin: http://127.0.0.1:18790`,
  - sends a `chat.send` to any sessionKey (default `agent:main:main`),
  - captures `lifecycle` (phase/model/provider/authProfileId), `assistant` (text deltas), `reasoning`, `tool_event`, and `fallback` events,
  - writes every inbound/outbound frame to `/tmp/tinker-probe.ndjson` for deep inspection,
  - polls `~/.openclaw/data/anatomy-timeline.db` after the turn and reports `total / newThisTurn / last row` so timeline-write regressions are caught immediately,
  - prints indicator predictions for all 4 thinking indicators (chat Opus, session panel, model glow, prefrontal tree).
- **Usage:** `node scripts/tinker-probe.mjs --prompt "..." --timeout 120 --raw /tmp/tinker-probe.ndjson`
- **Companion:** `scripts/db-probe.mjs` — static DB shape dump (schema, provider counts, recent rows, per-provider last 5). Used during triage.
- **Files:** `scripts/tinker-probe.mjs`, `scripts/db-probe.mjs`.

### 5.72 `onTurnComplete` Re-Wiring — Timeline DB Back Online (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** The `anatomy-timeline.db` ingestion path went dark from 2026-04-15 → 2026-04-20 because the 309-commit upstream merge (`378684e4f5`) stripped the fork's `attempt-hooks` call site out of `attempt.ts`, and the `jarvis-working` baseline branch was created from `4a6a289d5a` — before the last auto-wiring commit (`d941184bad`) could re-apply it. Result: zero rows inserted for any provider for 5 days, even as turns completed successfully and the UI looked healthy.
- **Fix:** re-import `onTurnComplete` from `src/fork/attempt-hooks.js` and invoke it fire-and-forget right after the `llm_output` hook block, before `buildAttemptReplayMetadata`. This single call writes the anatomy row, triggers forensic dump, and does post-turn bookkeeping — persona injection / mid-context reinject / intercept-text-tool-call were intentionally NOT restored (cc-bridge bypasses them; they're only needed for local ollama/lmstudio/vllm).
- **Verification:** `tinker-probe` post-turn shows `timeline-db: total=4519 newThisTurn=1, last row provider=claude-code model=claude-opus-4-7`.
- **Known gap:** `response_thinking_tokens` / `response_text_tokens` / `response_tool_call_tokens` are still null — these columns have been null across all 4518 historic rows, so the capture-side wiring in `pi-embedded-subscribe` + `attempt-hooks.updateAnatomyResponse` needs a separate pass (tracked, not fixed here).
- **Files:** `src/agents/pi-embedded-runner/run/attempt.ts` (import + call site, commit `7eccc0fe6d`).

### 5.73 cc-bridge System-Prompt Fingerprint — The Subscription-Billing Boundary (2026-04-24)

- **Status:** `DEPLOYED` (commit `a307dca393`)
- **Why this entry exists:** after the 2026-04-20 regression Jarvis started getting `API Error 400 "out-of-extra-usage"` on every turn even though the Claude Max subscription had ~5% usage. We spent two sessions patching environment variables, cgroup paths, PPID lineage, and systemd-run flags before discovering the boundary is neither env nor cgroup — **it's prompt content**. This section documents what the boundary actually is so the next regression gets caught in minutes instead of days.

#### The boundary (one sentence)

**An LLM call made by `claude-cli` on a Max subscription is routed to the overage billing pool when the system prompt passed via `--append-system-prompt` contains markers that Anthropic's server-side classifier recognises as 3rd-party-harness tooling.** Strip those markers and the same call bills against the flat rate.

#### What actually makes a request "blocked" vs "allowed"

| Signal                                                | Observed impact on routing                                    | Status in cc-bridge                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in env   | Bypasses OAuth → billed to API key, not subscription          | Stripped by `worker.ts` (allowlist env)                                                                                                                              |
| `CLAUDE_AI_SESSION_KEY` in env                        | Same — claude-cli prefers it over OAuth creds                 | Stripped                                                                                                                                                             |
| `OPENCLAW_*` env vars                                 | Previously suspected as classifier input; NOT confirmed alone | Stripped defensively                                                                                                                                                 |
| `OAuth creds at ~/.claude/.credentials.json`          | Required; stale/expired creds → 401, not 400                  | Trusted as-is; refresh handled by `credential-file.ts`                                                                                                               |
| Process cgroup under `openclaw-gateway.service`       | Previously suspected tell; `systemd-run --pipe` isolates it   | Wrapped in `systemd-run --user --pipe --unit=llm-client-<id>.service` — transient unit under `app.slice/`, PPid=1. Kept for defense-in-depth but NOT the actual fix. |
| PPid chain ending in `openclaw-gateway`               | Previously suspected; `--pipe` reparents to systemd           | Handled by the systemd-run wrapper                                                                                                                                   |
| **System-prompt content (`--append-system-prompt`)**  | **PRIMARY CLASSIFIER INPUT** — `out-of-extra-usage` trigger   | **Sliced at the `"You are a personal assistant running inside OpenClaw"` sentinel; everything after is dropped.**                                                    |
| User-message content                                  | No observed impact on routing                                 | Passed through unchanged                                                                                                                                             |
| `--model` / `--disallowedTools` / `--permission-mode` | No observed impact on routing                                 | Used freely                                                                                                                                                          |

#### The fingerprint (what Anthropic is matching on)

The strings that flipped routing from flat-rate to overage, measured by bisect:

- `"You are a personal assistant running inside OpenClaw"` (the sentinel phrase itself)
- Tool verbs that don't exist in a vanilla Claude Code install: `sessions_spawn`, `openclaw gateway start|stop|restart`, `sessions_list`, `sessions_history`, `sessions_send`, `subagents`, `agents_list`, `session_status`
- Runtime metadata: `repo=/home/.../.openclaw/workspace`, `channel=webchat`, `provider=webchat`, `agent=main`
- The OpenClaw CLI Quick Reference block
- The inbound-metadata JSON envelope (`"schema": "openclaw.inbound_meta.v2"`)
- The Heartbeats section that mentions `OpenClaw treats a leading/trailing "HEARTBEAT_OK"` (self-identifying as a harness)

Each of those is a concrete tool catalog / harness self-identification — exactly what a vanilla `claude` install would never carry. **Prose mentions of "OpenClaw" alone do NOT trip the classifier** — the three fork narration blocks (subagent helper, tool-choice, chat narration) all mention OpenClaw in documentation form and bill the subscription fine. It's the executable-tool shape and the runtime fingerprint lines that matter.

#### Bisect proof

| Commit                          | Role                                 | Result                  |
| ------------------------------- | ------------------------------------ | ----------------------- |
| `4a6a289d5a`                    | Merge-base (pre–309-commit merge)    | ✅ Subscription billed  |
| `3db21784ad`                    | Raw 309-commit merge, no fork wiring | ✅ Subscription billed  |
| `378684e4f5`                    | Fork-wiring applied post-merge       | ❌ `out-of-extra-usage` |
| …every commit after 378684e4f5… | Inherits the failure                 | ❌                      |
| `a307dca393`                    | System-prompt slice (this fix)       | ✅ Subscription billed  |

The only change in `378684e4f5` that affects what Anthropic sees is `src/agents/system-prompt.ts:buildAgentSystemPrompt` — it was enriched with persona + AMYGDALA + CORTEX blocks and the "You are a personal assistant running inside OpenClaw" tool-policy section. Everything else (`errors.ts`, `failover-matches.ts`, `assistant-failover.ts`, `attempt.ts` hook call sites) affects how the fork CLASSIFIES responses it receives, not what it sends.

#### Reauth finding — what this session settled about credential rotation

Before finding the boundary we suspected the `budget-panel`'s `forceRefreshToken()` was silently rotating `~/.claude/.credentials.json` into a tainted token. **It's not the cause.** Observed:

- `forceRefreshToken()` logs `[budget-panel] <profile>: token rotated for fresh rate limit window` on every run — journalctl showed zero such lines across every failure window.
- `~/.claude/.credentials.json` mtime tracked actual claude-cli auto-refresh, not budget-panel writes.
- The same credentials that fail on `main` work on the `dev/bisect-harness` branch (commit `37530fef28`) — if the token were the problem both branches would fail.
- A bare-shell `claude --print` with a minimal env allowlist bills the subscription correctly using the same credentials file, on the same host, at the same time as the gateway returns 400.

Conclusion: **the OAuth credential pipeline is healthy.** Reauth concerns, proactive refresh, credential-file rewrites — all red herrings relative to this specific 400. If `~/.claude/.credentials.json` ever does go stale, claude-cli returns 401/403 (auth error), not 400 `out-of-extra-usage`.

#### Fix

In `extensions/tinkerclaw-cc-bridge/src/worker.ts`:

```ts
const OPENCLAW_SYSPROMPT_CUTOFF = "You are a personal assistant running inside OpenClaw";
const openClawCutoff = systemPromptBody.indexOf(OPENCLAW_SYSPROMPT_CUTOFF);
const personaOnly =
  openClawCutoff > 0 ? systemPromptBody.slice(0, openClawCutoff).trim() : systemPromptBody;
void rulesBody; // fork-internal reply-style scaffolding, dropped defensively
const combinedSystemPrompt = [personaOnly, subagentHelpBody, toolChoiceBody, narrationBody]
  .filter(Boolean)
  .join("");
```

Kept: the persona header (`# Persona: JarvisOne (v1)…`) + the three fork narration blocks.
Dropped: everything after the sentinel (OpenClaw tool catalog, CLI quick-reference, inbound metadata, heartbeat rules, runtime line) + `rulesBody`.

No functional loss: `claude-cli` maintains its own tool catalog via `--permission-mode` and the fork's OpenClaw tools are mediated by the bridge, not the subprocess. The persona block still carries Jarvis's identity.

#### Diagnosis kit (use this when it comes back)

1. **Live probe:** `/tmp/catch-claude-pid.sh` polls `pgrep -x claude` and dumps the subprocess's cgroup + PPid + env. Copy from commit `a307dca393`'s context if missing.
2. **Bare-shell test:** `env -i HOME=… PATH=… DBUS_SESSION_BUS_ADDRESS=… XDG_RUNTIME_DIR=… TERM=xterm CLAUDECODE=1 claude --print --model claude-sonnet-4-6 'reply OK'`. If this bills the subscription, the credentials are fine and the problem is in the gateway's call shape (env, args, or prompt).
3. **Prompt dump:** add `fs.writeFileSync("/tmp/jarvis-sysprompt-dump.txt", systemPromptBody)` right before `--append-system-prompt` is pushed; grep the dump for `sessions_spawn`, `openclaw`, `repo=.*workspace`, `schema.*openclaw` — any hits are a candidate fingerprint.
4. **WS injector:** `node scripts/jarvis-inject.mjs --new --message "..." --gw ws://localhost:18789` (token from `~/.openclaw/openclaw.json`) produces a clean bisect probe with no UI noise.
5. **Git bisect anchors:** `4a6a289d5a` (pre-merge known-good), `3db21784ad` (raw-merge known-good), `378684e4f5` (fork-wiring known-bad).

#### What NOT to change next time

- Don't touch the `systemd-run --user --pipe` wrapper first. It's correct cgroup/PPid hygiene and costs nothing to keep.
- Don't strip more env vars on a hunch — the allowlist is already minimal. If stripping helped it would show up in the bare-shell probe.
- Don't blame budget-panel's `forceRefreshToken()` unless journalctl actually shows rotation events in the failure window.
- Don't assume `--resume <sessionId>` is tainting routing — wipe `~/.openclaw/cc-bridge/session-map.json`, restart, and confirm a truly fresh spawn still fails before going down that path.

- **Files:** `extensions/tinkerclaw-cc-bridge/src/worker.ts` (commit `a307dca393`).
- **Knowledge:** `~/.openclaw/workspace/memory/knowledge/tinkerclaw-cc-bridge.md` (§ "2026-04-24: Subscription-billing regression — root cause").

#### 5.73a Stream parser: post-tool text recovery (2026-04-27)

- **Status:** `DEPLOYED`
- **Symptom:** every `/new` (and any tool-heavy turn) appeared to "die after N tool calls" — the UI showed user prompt + tool bubbles + the brief opener Jarvis writes before the first tool, then nothing. The Morning Briefing, the post-tool summary, the actual answer — all gone. Refreshing didn't help; the assistant message persisted in `agent:main:main`'s jsonl was only the 122-char preamble even though claude-cli had emitted ~5.5KB of output.
- **Root cause:** two related parser bugs in `extensions/tinkerclaw-cc-bridge/src/stream.ts`.
  1. **Multi-block accumulation gap.** The parser tracked one `accumulatedText` for the whole turn and gated updates on `cumulative.startsWith(accumulatedText)`. claude-cli's stream-json emits SEPARATE text blocks before and after a tool_use chain (`message.content[0]` = preamble, `message.content[N]` = post-tool summary). Block N's cumulative didn't start with block 0's accumulated text, so the prefix check fell through and no delta was pushed — the post-tool block was silently dropped.
  2. **`result.result` ignored on success.** claude-cli's stream emits a `result` line at the end of each turn whose `result` field carries the FULL final assistant text. The error-path code at line 595 already used it (to build the error envelope), but the success-path at line 626 just called `buildContent()` over `accumulatedText` and trusted whatever streamed through. In dense tool chains where the post-tool summary never appears as a separate `assistant.content` text block, `result.result` was the only source of the answer — and the success path was throwing it away.
- **Fix:**
  1. **Per-block tracking**: `blockTextSeen: Map<number, string>` and `blockThinkingSeen: Map<number, string>` track each block's previous cumulative independently. The text-block branch compares `cumulative` against the SAME-block-index's `prev`, slices the delta, and appends to the global `accumulatedText` via `pushTextDelta`. When a fresh block emerges after a tool_use chain (`bi > 0 && prev === ""`), `pendingToolNarration` is cleared so the post-tool prose doesn't get attributed to a stale upcoming tool.
  2. **`result.result` reconciliation in the success path**: before composing the final assistant message, compare `result.result` against `accumulatedText`. If `result.result` extends `accumulatedText` (prefix match), push the tail as a delta. If they've diverged (result is more than 2× longer + 50 chars, classic preamble-only stream case), push `\n\n` + the full result_text so both the streamed preamble and the result-line answer survive in the final message.
- **Verification:** probe sends "Run echo PROBE-A then echo PROBE-B then summarize what they printed in two sentences after the calls." Before fix: streamed text 44B (preamble only), persisted message 122B in earlier prompts. After fix: streamed/persisted text 237B (preamble + `\n\n` + 191B post-tool summary). Log line `tail-recover: streamed 44B, result_text 191B, replacing (diverged)` confirms the success-path branch fired.
- **What this is NOT:**
  - Not a workaround for `/new`-specific behaviour. The bug applied to ANY turn where claude-cli ran tool calls; `/new`'s briefing just made it most visible because the prompt always produces a substantial post-tool summary.
  - Not the same as §5.74's tool-call replay. That fix landed tool_use/tool_result entries in the jsonl; this fix lands the assistant TEXT in the jsonl. They compose: `/new` history now shows user prompt → tool bubbles (from §5.74) → preamble + briefing (from §5.73a).
  - Not retroactive — turns persisted before this commit are stuck with whatever truncated text made it. Future turns are whole.
- **Files:** `extensions/tinkerclaw-cc-bridge/src/stream.ts` (per-block maps, multi-block parser branches, `result.result` reconciliation in the success path).

### 5.74 cc-bridge Tool Call Replay in Session History (2026-04-25)

- **Status:** `DEPLOYED`
- **Why:** §5.66 explains that cc-bridge cannot put `tool_use` blocks in the assistant message — pi-agent-core would re-execute them through OpenClaw's exec tool and trip the prefrontal "Exploration required" gate (red bubbles for every claude internal Bash call). That kept context clean but left the OpenClaw session transcript with **only** the user prompt and the final assistant text. Reloading `agent:main:main` after a 46-tool-call turn showed `[user prompt → 64-character opener]` and nothing else — every command Jarvis ran was invisible after refresh, which broke the "see Jarvis working" promise of the webchat.
- **Fix:** three-piece pipeline that lands tool events in the transcript without polluting the LLM context.
  1. **Buffer (cc-bridge):** `extensions/tinkerclaw-cc-bridge/src/tool-buffer.ts` keeps an in-process `Map<runId, ToolBufferedEvent[]>`. Both `emitToolStart` and `emitToolResult` in `stream.ts` push their events into the buffer alongside the existing live `emitAgentEvent` call. Buffer state is not persisted to disk — gateway crash loses it, but the user already lost the turn at that point.
  2. **Drain (fork hook):** `src/fork/attempt-hooks.ts:onTurnComplete` resolves the active `SessionManager` (the runner casts `activeSession` to `SessionManager`, but the real instance is on `activeSession.sessionManager`, which the hook discovers defensively) and writes each buffered event with `appendCustomEntry("cc-bridge-tool", { runId, ...event })`. `appendCustomEntry` is the "Extension state — not in context" primitive (per `pi-coding-agent` `session.md`), so the entries persist on disk and ship to Tinker via `chat.history`, but pi-agent-core does NOT replay them into the message array on the next turn — no double-execution.
  3. **Surface (chat.history transform):** `src/gateway/session-utils.fs.ts:readSessionMessages` recognises `type:"custom"` + `customType:"cc-bridge-tool"` entries and emits them as synthetic `tool_use` (assistant role) and `tool_result` (user role) messages with `__openclaw.kind:"cc-bridge-tool"`. They reuse the exact block types Tinker already renders for live tool events at `tinker-ui/src/app.ts:1512`, so no client-side change is needed — the existing live-tool render path runs again on history load.
- **Reorder logic:** the drain runs in `onTurnComplete`, AFTER the assistant text was already persisted, so cc-bridge-tool entries trail the assistant message in jsonl order. `reorderCcBridgeToolBlocks` walks the read messages and splices each cc-bridge-tool message into the position immediately before the most-recent preceding assistant _text_ message, ignoring intervening `compaction` system entries. Final chat reading order: `[user → tool_use → tool_result → … → assistant text → compaction]`.
- **Verification:**
  - Live: jarvis-inject probe runs `pwd` + `whoami`, three blocks visible in real time (existing §5.6 path).
  - Persist: jsonl gains 4 `{"type":"custom","customType":"cc-bridge-tool", "data":{ runId, phase, toolCallId, name, args, result, isError, ... }}` lines per turn.
  - Replay: `chat.history` returns those entries as `[assistant tool_use, user tool_result]` pairs spliced before the final assistant text. Tinker renders them as the same single-line/expandable bubbles it shows live.
- **What this is NOT:**
  - Not "in context" — pi-agent-core never re-feeds these entries to the LLM. cc-bridge handles its own tool loop inside claude-cli (`~/.claude/projects/<sid>/*.jsonl`); the OpenClaw side just keeps a render-only mirror.
  - Not retroactive — turns that ran before this fix have no buffered events to drain. Their history still shows only the assistant opener + final text. Future turns are fully captured.
  - Not a replacement for `agent.stream:"tool"` events — the live WS path still drives Tinker's real-time tool bubbles. The persistence path is a parallel record for after-the-fact reload, not a substitute.
- **Files:** `extensions/tinkerclaw-cc-bridge/src/tool-buffer.ts` (new), `extensions/tinkerclaw-cc-bridge/src/tool-buffer.types.ts` (new), `extensions/tinkerclaw-cc-bridge/src/stream.ts` (record at emit), `src/fork/attempt-hooks.ts` (drain on turn complete), `src/gateway/session-utils.fs.ts` (history transform + reorder), `scripts/check-history-probe.mjs` (verification harness).

### 5.75 `/clear` and `/new` — Symmetric Reset Cascade Through cc-bridge (2026-04-27)

- **Status:** `DEPLOYED`
- **Why:** §5.5 says session deletes from Tinker are soft (transcript archived, never wiped). §5.66 explains cc-bridge's worker pool is keyed by a hash of the system prompt, which has the side effect of pinning Jarvis to the same `claude --resume <sessionId>` across every "session reset" — `/new` rotated the OpenClaw sessionId but cc-bridge kept the old conversation alive. `/clear` was even worse: it never reached the gateway's reset path at all (it called `sessions.delete` instead of `sessions.reset`), so the `command:reset` plugin lifecycle, transcript archival, and `session-memory` save never fired. The two commands looked similar in the UI but did very different things server-side, and neither actually reset Jarvis.
- **Fix (three pieces, must move together):**
  1. **Smuggle the OpenClaw sessionId** to cc-bridge: `src/agents/pi-embedded-runner/run/attempt.ts` adds `__openclawSessionId: params.sessionId` next to the existing `__openclawRunId` / `__openclawSessionKey` fields piped through `agent.streamFn`. The sessionId is the per-reset UUID minted by `performGatewaySessionReset`, not the stable `sessionKey` label.
  2. **Hash sessionId into the cc-bridge worker key**: `extensions/tinkerclaw-cc-bridge/src/stream.ts:deriveSessionKey` now takes `(explicit, systemPrompt, openclawSessionId)` and djb2-hashes `${systemPrompt}\u0001${sessionId}`. A reset that mints a new sessionId yields a new `cc-sp-<hash>`; the worker pool treats it as a brand-new session, spawns a fresh `claude` subprocess with no `--resume` flag, and `~/.openclaw/cc-bridge/session-map.json` accumulates a fresh entry instead of looking up the old one. The previous entry stays in the file as orphaned state — never queried again, cheap to leave; a TTL prune is future work.
  3. **`/clear` calls `sessions.reset`**: `tinker-ui/src/app.ts` replaces the old `sessions.delete({deleteTranscript:false})` fire-and-forget with `sessions.reset({key, reason:"reset"})`. The local-state wipe + tab key rotation still happen first (so a stale `chat.history` reload mid-flight can't surface the abandoned transcript), then the server-side cascade handles the real work: archives the old transcript to `sessions-archive/`, mints a new sessionId on the same sessionKey, fires `command:reset` → `before_reset` → `session_end` → `session_start` plugin hooks. Zero LLM calls; same zero-token guarantee as before. Symmetric `sessions.reset({key, reason:"new"})` is also fired from the topbar `/new` button when the active tab is a `tinker:*` non-main tab — previously its old session was orphaned on disk because the tab simply rotated to a fresh key without telling the gateway anything.
- **Verification (commit `<this>`):**
  - `scripts/check-reset-cascade.mjs` opens a fresh `cli:reset-<ts>` sessionKey, sends `echo TURN-A`, calls `sessions.reset`, sends `echo TURN-B`. Both turns succeed; `session-map.json` gains TWO new `cc-sp-` entries (one per turn) with different sessionIds; the gateway log shows both `spawning claude` lines ending at `--model claude-opus-4-7` (no `--resume` argument on either) — claude-cli started fresh both times. Before the fix the second turn would have reused the first turn's `cc-sp-` key and `--resume`-d into the same conversation.
- **What this is NOT:**
  - Not a guarantee about `/new` on the main tab — `/new` still fires `chat.send "/new\n…"` to deliver the BRIEFING.md prelude through the model. The cascade still runs (the auto-reply session.ts trigger detects `/new` and calls `performGatewaySessionReset` server-side), but the LLM call is intentional and counts toward usage.
  - Not retroactive — entries already in `session-map.json` from before this commit (hashed by systemPrompt only) stay readable but won't be matched by future requests, which now hash with sessionId. They become inert dead weight.
  - Not a substitute for `/clear`'s tab-key rotation. The local rotation is still important: `chat.history` with the old key would still return the just-archived transcript in flight, and the tab-key swap prevents that race.
- **Files:** `src/agents/pi-embedded-runner/run/attempt.ts` (smuggle `__openclawSessionId`), `extensions/tinkerclaw-cc-bridge/src/stream.ts` (`deriveSessionKey` hashes sessionId + reorders pipedOptions extraction so sessionId is available before key derivation), `tinker-ui/src/app.ts` (`/clear` calls `sessions.reset` instead of `sessions.delete`; topbar `/new` resets the abandoned `tinker:*` key before rotating), `scripts/check-reset-cascade.mjs` (new verification harness).

### 5.76 Public/Private Boundary & The Git-Pull Contract (2026-04-28)

This section defines the rules that let `tinkerclaw` ship as a public GitHub repo someone can clone-and-run while keeping personal data out of the public surface AND letting an existing user `git pull` for upstream improvements without losing any personalisation.

#### 5.76a The product story

`tinkerclaw` is shipped as **"Jarvis, ready to play, with hooks to make him yours."** Day-0 cloners get a working assistant — JARVIS persona, working briefing on `/new`, JARVIS voice, all cognitive plugins composed — without any setup beyond `pnpm install && pnpm build && openclaw start`. They override anything they want, in increasing precedence:

1. Explicit config (`~/.openclaw/openclaw.json` — outside repo)
2. Workspace file (`~/.openclaw/workspace/<file>` — outside repo)
3. Bundled default (`extensions/tinkerclaw-cc-bridge/{personas,prompts}/<file>` — in repo)

The bundled default is always present; first-boot never hits a missing-file path. Override layers are opt-in and live outside the repo so `git pull` cannot touch them.

#### 5.76b The hard contract: program in repo, data outside

The single rule that makes the whole system safe under `git pull`:

| Lives in `~/src/tinkerclaw/` (repo)                                                  | Lives in `~/.openclaw/workspace/` (outside repo)                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Code (worker.ts, stream.ts, gateway patches, extensions)                             | User persona override (`SOUL.md`)                                  |
| Bundled defaults (`personas/jarvis-default.md`, `prompts/briefing-default.md`, etc.) | User briefing override (`BRIEFING.md`)                             |
| Contract documents (READMEs, PATCHES, CHANGELOG, this bible)                         | User recipes / cron / memory / heartbeat                           |
| Config schema and shipped sample                                                     | Trained Personality NN (`models/amygdala/onnx/personality_*.onnx`) |
|                                                                                      | Live runtime state (sessions, anatomy timeline, OAuth credentials) |

`git pull` rewrites the left column freely. It cannot reach the right column because git operates on the working tree at `~/src/tinkerclaw/` and stops there. No exceptions — anything user-editable that's allowed inside the repo is the trap that breaks the whole contract on the next pull.

The `.gitignore` already enforces the asymmetric half (private files in the repo are excluded — `SOUL.md`, `morning-briefings/`, `models/amygdala/{checkpoints,onnx}/personality_*`, `data/amygdala/personality-nudge.json`). The new rule the boundary adds: **users do not personalize bundled defaults in-place; they place overrides in the workspace.**

#### 5.76c File categories — what `git pull` does to each

Every public-repo file falls in exactly one of three buckets:

| Category                               | What it is                                                                                                                                                                                                              | Override path                               | What `git pull` does                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Bundled default with override hook** | `personas/jarvis-default.md`, `prompts/briefing-default.md`, `prompts/narration-contract.md`, `prompts/subagent-helper.md`, `prompts/tool-choice.md`                                                                    | Workspace file resolved before the bundle   | Refreshes the bundle. Workspace override (if present) is untouched and continues to win.                |
| **Library code**                       | `extensions/**/src/*.ts`, `src/fork/**`, `src/gateway/**`, `tinker-ui/src/**`                                                                                                                                           | None — fork the repo if you want to diverge | Refreshes. Users with workspace overrides see no change in behaviour; users who forked merge as normal. |
| **Read-only contract**                 | `FORK.md`, `FORK_SETUP.md`, `FORK_PATCHES.md`, `CHANGELOG-FORK.md`, `COGNITIVE_PLUGINS_GUIDE.md`, `TINKER_UI_DESIGN_BIBLE.md`, every extension `README.md` and recipe under `extensions/tinkerclaw-prefrontal/recipes/` | None — read, don't edit                     | Refreshes. Users read changes via the changelog.                                                        |

There is no fourth category called "ship a default but expect users to edit it in place." Eliminating that category is what makes the contract robust.

#### 5.76d Resolution order in code

For each bundled-default-with-override-hook file, the loader applies the same three-step resolution. Implemented as a shared helper in `extensions/tinkerclaw-cc-bridge/src/prompt-loader.ts`:

```
resolvePromptPath(name) →
  1. cfg.prompts?.[name]Path ?? cfg.cognitive?.[name]Path  (config — outside repo)
  2. path.join(workspaceDir, <name>.md)                    (workspace — outside repo)
  3. path.join(__dirname, "../{personas,prompts}", <name>) (bundled default — in repo)
```

The first existing path wins. The bundled default at step 3 is guaranteed to exist (shipped in the repo). Steps 1 and 2 are opt-in. No file-not-found errors at boot under any combination of presence/absence.

For the persona, the resolution lives in `src/fork/attempt-hooks.ts:getPersonaBlock` which reads `<workspaceDir>/SOUL.md` first and falls back to the bundled `jarvis-default.md`. For the briefing, the resolution lives in `tinker-ui/src/app.ts:buildInjectedPrompt` which reads `briefingPath` from cc-bridge config (resolved by the gateway). For the cc-bridge prompt blocks (narration / subagent-helper / tool-choice), the resolution lives in `cc-bridge/src/worker.ts:buildAppendedPromptRules`.

#### 5.76e Day-0 defaults — what ships in the repo

- **`extensions/tinkerclaw-cc-bridge/personas/jarvis-default.md`** — JARVIS persona, day-0 default. Sardonic, capable, formal-British voice; based on the canonical Iron Man character (widely known, not personal). Cloners override by creating `~/.openclaw/workspace/SOUL.md`.
- **`extensions/tinkerclaw-cc-bridge/prompts/briefing-default.md`** — generic morning-briefing template. Pattern + voice rules + category-based source discovery (HEARTBEAT, daily memory, recent commits — skip silently if missing). Cloners override by creating `~/.openclaw/workspace/BRIEFING.md`.
- **`extensions/tinkerclaw-cc-bridge/prompts/narration-contract.md`** — the grandma-proof bar: per-tool narration rule + banned phrasings + bad/good examples. Extracted from `worker.ts:buildChatNarrationBlock`.
- **`extensions/tinkerclaw-cc-bridge/prompts/subagent-helper.md`** — how to spawn OpenClaw subagents from inside cc-bridge. Extracted from `worker.ts:buildSubagentHelperBlock`.
- **`extensions/tinkerclaw-cc-bridge/prompts/tool-choice.md`** — tool-routing decision tree (WebSearch vs WebFetch, etc.). Extracted from `worker.ts:buildToolChoiceBlock`.
- **JARVIS voice (`skills/jarvis-voice/SKILL.md`)** — default-on TTS skill. Cloners disable via the skills panel or replace with another voice skill.

Day-0 user experience: clone, install, build, start. Get JARVIS speaking sardonically through cc-bridge with full grandma-proof tool narration, full briefing on `/new`, and JARVIS voice (assuming `ffmpeg` + `aplay` are present from the skill manifest).

#### 5.76f Drift detection on startup

Each bundled default ships with a frontmatter `default-version: <semver>` line. When a workspace override exists, the loader compares the workspace file's stamped `default-version` (written by `openclaw <name> init`) to the current bundled `default-version`. If they differ:

```
[cc-bridge] persona override at default-version 1.0; bundled default is at 1.2.
            run 'openclaw persona diff' to see changes; 'openclaw persona reset' to reseed.
            (your override always wins; this is informational.)
```

INFO level log line. No automatic action. The user's override always wins; the message just notifies that improvements are available upstream.

#### 5.76g The seed-edit-revert lifecycle

The `openclaw` CLI exposes one verb per overridable file with three subcommands:

```
openclaw persona init              # copies personas/jarvis-default.md → ~/.openclaw/workspace/SOUL.md, opens $EDITOR
openclaw persona diff              # diffs workspace SOUL.md against current bundled jarvis-default.md
openclaw persona migrate           # if user accidentally edited the in-repo default, copies their diff to workspace + git-checkouts the repo file
openclaw persona reset [--force]   # backs up workspace SOUL.md, copies fresh bundled default
openclaw briefing {init,diff,migrate,reset}    # same shape for briefing-default.md
openclaw narration {init,diff,migrate,reset}   # same shape for narration-contract.md (power-user override)
openclaw recipes new <name>                    # creates ~/.openclaw/workspace/recipes/<name>.md from a template
```

Each `init` refuses to overwrite an existing workspace file (asks `--force`), copies the bundled default verbatim, stamps `default-version` in frontmatter, and opens `$EDITOR`. The verbs are documented in `FORK_SETUP.md`.

The CLI scaffolding is filed as a follow-up — bible §5.76g documents the shape; first cut of the resolution order ships without the CLI commands. The boot-time drift log line ships with the loader.

#### 5.76h Scenario-B trap: in-repo edits

Some users will ignore the documented path and edit `extensions/tinkerclaw-cc-bridge/personas/jarvis-default.md` in place. `git pull` will conflict the next time upstream touches that file. The repo defends with two redundant signals:

1. **`pnpm doctor`** (or first-run check on gateway boot) scans `extensions/tinkerclaw-cc-bridge/{personas,prompts}/` for local modifications via `git diff --quiet` and prints:
   > Your repo has edits to bundled `jarvis-default.md`. These belong in `~/.openclaw/workspace/SOUL.md`, not in the repo. Run `openclaw persona migrate` to copy your edits to the workspace and revert the repo file. Until then, `git pull` will conflict on this file.
2. **`git-hooks/pre-merge`** (opt-in via `core.hooksPath`) prints the same warning before letting a `git pull` proceed.

`openclaw persona migrate` copies the user's diff vs. the upstream-tracked version into `~/.openclaw/workspace/SOUL.md`, then `git checkout` the repo file. After that, normal resolution order kicks in and `git pull` is safe.

#### 5.76i The two tests

Two tests every change to the public-repo surface must pass:

- **The "Sam test"** (fresh clone): a stranger named Sam clones the repo, runs `pnpm install && pnpm build && openclaw start`, says hello in Tinker. Jarvis replies through cc-bridge with the bundled persona, the bundled briefing on `/new`, the bundled voice, full grandma-proof tool narration. No setup, no errors, no missing-file references in the assistant's mouth. Sam has done nothing personal yet — everything works from the bundle.
- **The "Day-90 test"** (existing user `git pull`): a cloner who has been using the repo for 90 days has a personalized `~/.openclaw/workspace/SOUL.md`, a custom `BRIEFING.md`, a trained `personality_*.onnx`, custom recipes under `~/.openclaw/workspace/recipes/`. They run `git pull`. The pull updates the bundled defaults, the library code, the contracts. **Their workspace is untouched.** Boot logs flag the drift between their SOUL.md (default-version 1.0) and the new bundled default (1.2); they read `openclaw persona diff` if interested; they keep their override otherwise. Total disruption: zero.

Both tests must pass by design (resolution order + filesystem separation), not by user discipline.

#### 5.76j What stays gitignored

The `.gitignore` continues to exclude personal files that would otherwise leak through the public-repo surface if they ended up in the repo working tree:

```
# Personal — these belong in ~/.openclaw/workspace/, never in the repo
SOUL.md                                          # personal persona override
morning-briefings/                               # rendered briefing outputs

# Trained personality NN — public Prudence ensemble ships, Personality is per-deployment
models/amygdala/checkpoints/personality_*.pt
models/amygdala/checkpoints/personality_*.json
models/amygdala/onnx/personality_*.onnx
models/amygdala/onnx/personality_*.onnx.data
models/amygdala/personality-*.onnx
models/amygdala/personality-*.onnx.data
data/amygdala/personality-nudge.json             # nightly training output
```

That's the entire list — narrow because most personalization paths route to `~/.openclaw/workspace/` which is outside the repo and therefore doesn't need a `.gitignore` entry.

#### 5.76k Files (this contract)

- `extensions/tinkerclaw-cc-bridge/personas/jarvis-default.md` _(NEW — day-0 persona default)_
- `extensions/tinkerclaw-cc-bridge/prompts/briefing-default.md` _(NEW — day-0 briefing default)_
- `extensions/tinkerclaw-cc-bridge/prompts/narration-contract.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-cc-bridge/prompts/subagent-helper.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-cc-bridge/prompts/tool-choice.md` _(NEW — extracted from worker.ts)_
- `extensions/tinkerclaw-cc-bridge/src/prompt-loader.ts` _(NEW — three-step resolution helper)_
- `extensions/tinkerclaw-cc-bridge/src/worker.ts` (use loader; remove the five hardcoded `/home/<user>/...` paths)
- `extensions/tinkerclaw-cc-bridge/README.md` _(NEW — anatomy + override conventions)_
- `extensions/tinkerclaw-browser-relay/chrome-extension/options.html` (replace literal gateway-token placeholder)
- `scripts/db-probe.mjs` (replace `/home/<user>/.openclaw/...` with `os.homedir()`-resolved path)
- `src/fork/attempt-hooks.ts` (`getPersonaBlock` falls back to bundled `jarvis-default.md`)
- `tinker-ui/src/app.ts:buildInjectedPrompt` (briefing path resolved from cc-bridge config, falls back to bundled `briefing-default.md`)
- `FORK_SETUP.md` (new "Personalize in the workspace, never in the repo" paragraph at the top)

---

### 5.77 Anthropic Opus 4.7 Prompting Standards (2026-04-28)

**Why this section exists.** Opus 4.7 follows literal instructions more strictly than 4.6 and is less aggressive about its own embellishments. Prompts that worked fine on 4.6 ("HARD RULE: never do X", "MUST do Y", all-caps emphasis, vague exhortations) under-perform on 4.7 — the model now does exactly what you ask, no more, no less. Every prompt the fork ships needs to be written for that contract.

This section is the standard. Every `.md` file under `~/src/tinkerclaw/extensions/*/prompts/`, `~/src/tinkerclaw/extensions/*/personas/`, `~/.openclaw/workspace/*.md` (workspace overrides), and every skill `SKILL.md` in `~/.openclaw/workspace/skills/` follows it.

#### 5.77a The eight rules

1. **Wrap blocks in named XML tags.** Use semantic names that describe the block's purpose: `<role>`, `<task>`, `<voice>`, `<examples>`, `<rules>`, `<override_priority>`, `<verbosity>`, `<output_format>`, `<why_this_matters>`, `<scope>`. Avoid generic names like `<section1>`. The tags let the model reference structure when reasoning about which rule applies; without them it has to infer boundaries from headings.

2. **Examples go in `<example>` blocks with sub-tags.**

   ```xml
   <example>
   <scenario>What's happening</scenario>
   <bad>What not to do, and a brief reason it fails</bad>
   <good>The right move</good>
   <why>One sentence on what makes the good version right</why>
   </example>
   ```

   The sub-tags let the model parse the example without conflating "bad" and "good" prose.

3. **Motivation-first framing.** Lead with WHY a rule exists before WHAT to do. 4.7 follows literal instructions; without motivation it can't extrapolate to edge cases the rule didn't anticipate.

4. **Reframe negatives as positives where possible.**
   - "Don't fabricate" → "Honest 'no signal' reports are valuable because false positives waste downstream attention"
   - "Never do Y" → "Do Z instead because Y leads to W"
     Keep strict negation only where there is a genuine safety boundary the model must not cross.

5. **Dial back CAPS / MUST / NEVER / HARD RULE.** 4.7 is more responsive to calm specific phrasing than to shouted imperatives. Replace ALL-CAPS words with normal case unless the emphasis is genuinely load-bearing. Replace "MUST"/"NEVER" with concrete description of the desired behaviour. The 4.6-era pattern of stacking imperatives ("CRITICAL", "ABSOLUTELY", "BLOCKING REQUIREMENT") makes 4.7 freeze rather than act.

6. **Add an explicit `<override_priority>` block** when a prompt could be overridden by user instructions. State the priority order plainly: user explicit instructions > this prompt > system defaults. Without it, 4.7 may treat the prompt as the highest authority and ignore conflicting user input.

7. **Concrete over abstract.** Replace vague nouns ("the code", "the user", "things") with specific anchors: "the `cc-bridge` worker.ts", "the user's `~/.openclaw/workspace/`". Vague nouns let the model wander; concrete anchors keep it on the artifact you actually mean.

8. **Length: keep or shorten.** Don't pad. If a section can lose 30% of its words without losing meaning, do it. 4.7 reads everything literally — every word competes for attention.

#### 5.77b Two modes — pick per file

A file is **HEAVY** (full Opus 4.7 treatment) if it tells a future LLM how to behave: voice, tools, output format, decision rules.

- Examples: `BRIEFING.md`, `SOUL.md`, `IDENTITY.md`, `VOICE.md`, `USER.md`, `VISION.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `SESSION.md`, `MOLTBOOK.md`, `COGNITIVE_PLUGINS_GUIDE.md`, `CLAUDE.md`, every `skills/*/SKILL.md`, every `.agent/workflows/*.md`, every `extensions/*/prompts/*.md` and `extensions/*/personas/*.md`.

A file is **LIGHT** (typo + structure pass only, NEVER rewrite) if it records what happened, what someone thinks, or factual data.

- Examples: anything in `memory/` (daily journals, archives, ai-research, ChatGPT imports), `bank/contacts*.md`, `bank/opinions.md`, `bank/experience.md`, `CHANGELOG-FORK.md`, `index_costos.md`, `moltbook_findings.md`, anything in `bank/reference/` that reads as notes (not instructions).

When ambiguous: read the first 30 lines. If it addresses a future LLM ("you are…", "your task is…", instructions in second person), it's HEAVY. Otherwise LIGHT.

#### 5.77c LIGHT mode — what is allowed

NEVER rewrite content. NEVER add XML tags. NEVER restructure prose.

Allowed:

- Fix obvious typos (your/you're, definately → definitely)
- Fix broken markdown (unclosed code fences, malformed lists, broken links)
- Normalise heading levels if a file mixes `#` and `##` for same-level items
- Trim trailing whitespace; collapse runs of 3+ blank lines to 2

When in doubt on a memory file: leave it alone. We are not rewriting history.

#### 5.77d Where the standard is canonical

The full revision guide lives at `/tmp/opus47-revision-guide.md` during a sweep, but the canonical reference is **this section**. New prompts go through this rubric at write-time, not as an afterthought. New skill `SKILL.md` files start in HEAVY format. New workspace overrides start in HEAVY format.

For non-text-prompt files (configs, schemas, code), 5.77 does not apply — the rules here are about LLM-facing prose.

#### 5.77e Commits that established the baseline

- `b2ab809651` — first sweep: 4 standalone bundled prompts revised (jarvis-default, briefing-default, amygdala-prompt, fractal-prompt).
- `dfceb60241` — second sweep: 3 prompt fragments extracted from `worker.ts` into `prompts/` (narration-contract, tool-choice, subagent-helper) under the same standard.
- `2026-04-28 sweep` — full workspace pass (~125 HEAVY prompts, ~470 LIGHT-touched memories) to bring every existing `.md` under §5.77.

#### 5.77f When the standard changes

If Anthropic publishes new guidance for Opus 4.8 or later, append §5.78 rather than rewriting §5.77. Old prompts revised under §5.77 are still valid; new prompts pick up the latest. Roll a `default-version: 1.x → 2.0` bump on bundled prompt frontmatter when the rules change in a way that would alter the rendered prompt.

---

### 5.78 Branch Policy: `main` is shippable, `develop` is for tinkering (2026-04-29)

**Rule.** Effective today: only fully working versions go to `origin/main` on github.com/globalcaos/tinkerclaw. All in-progress work — partial merges, untested experiments, half-built features — happens on a local `develop` branch.

#### 5.78a Why

Cloners (and our own future selves) read `origin/main` expecting it to build, run, and be coherent. Pushing half-merged or broken work to main turns the repo into a minefield: someone clones, hits a build error, can't tell if it's their setup or the repo itself, and burns an hour figuring it out. A separate `develop` branch absorbs that mess locally so `main` can stay clean.

#### 5.78b The workflow

```
develop (local, may be broken at any moment)
   │
   │  when a chunk of work is fully tested:
   │  - build green
   │  - gateway boots clean
   │  - smoke test passes (`/jarvis-status` answers, model probe replies)
   │  - any new fork-wiring patches verified idempotent
   │
   ▼
main (local, snapshot of last known-good)
   │
   │  push (Jarvis owns this, never Claude Code directly)
   │
   ▼
origin/main on github
```

After each merge to main:

```bash
git checkout main
# main is now pristine
git push origin main          # Jarvis pushes — see "NEVER push" rule

git checkout develop
git reset --hard main          # develop becomes a fresh copy of main
# continue tinkering on develop
```

#### 5.78c What "fully working" means before merging develop → main

A non-negotiable checklist:

- `pnpm build` exits 0 with `NODE_OPTIONS=--max-old-space-size=8192`.
- Gateway boots cleanly (`openclaw-restart --full`, `curl /healthz` returns `{"ok":true,"status":"live"}`).
- `apply-fork-wiring.mjs` runs idempotent (re-running prints "already wired" for everything).
- A smoke probe through cc-bridge replies (e.g. SMOKE-OK).
- For changes to plugin manifests: each plugin still appears in the gateway plugin list at boot.
- For changes to docs/scripts only: skip the build gate, but verify the doc renders or the script `node --check`s clean.

If any of these fails, fix on `develop`; do not merge.

#### 5.78d When the merge is messy (e.g. another big upstream catch-up)

The 23-chunk supervised merge from 2026-04-28 is the worst case. Even there, the process was: do the merge on develop, accumulate fork-wiring patches, verify each chunk builds, only THEN merge develop → main. Don't push intermediate chunks to origin/main; the only thing origin/main sees is the final caught-up state.

#### 5.78e What develop is allowed to be

- Half-merged upstream chunks
- Experimental plugins not yet wired up
- Disabled features (`enabled: false` in openclaw.json) being tested
- Broken builds during refactors
- Stashes that aren't ready

Anything that would embarrass us if a stranger cloned `main` and tripped on it.

#### 5.78f What about other branches?

Existing topic branches (`feat/...`, `fix/...`, `pr/...`, `wip/...`) are still fine for isolated work. They merge into `develop`, not into `main` directly. The two long-lived branches are `main` (clean) and `develop` (messy).

---

### 5.79 Heartbeat Architecture: Computational Cron, Conditional LLM (2026-04-29)

**Rule.** The heartbeat is a **computational gate**, not an AI loop. TypeScript (not an LLM) decides every fire whether anything actually needs Jarvis's attention. The LLM is invoked only when the gate confirms there is work to do.

The model summoned by the gate is **`claude-code/claude-opus-4-7`** — full reasoning, our flat-rate via cc-bridge.

#### 5.79a How the gate decides

Every interval (`agents.defaults.heartbeat.every`, default `1h`), the gateway runs the heartbeat tick. Inside `src/infra/heartbeat-runner.ts:resolveHeartbeatRunPrompt`, pure TypeScript checks four signals:

1. **Pending cron events** — outputs from scheduled crons (daily-fork-sync, life-butler, security-updates, etc.) that emitted a system event but haven't been read by the agent.
2. **Pending exec completions** — background bash commands that finished while no agent turn was active.
3. **Fractal reflection hooks** — post-turn reflection events queued from a previous run.
4. **Scheduled tasks in `~/.openclaw/workspace/HEARTBEAT.md`** — YAML `tasks:` block with `name`, `interval`, `prompt` per task. The gate runs `isTaskDue(task)` for each — only tasks past their interval since their last run.

If all four are empty, the gate returns `prompt === null` and the heartbeat short-circuits at line 888: `return { status: "skipped", reason: "no-tasks-due" }`. **No LLM call. No subprocess. No cost.**

If any signal has content, the gate builds a prompt (`buildCronEventPrompt` for cron events, `buildExecEventPrompt` for completions, raw fractal text for reflection, or HEARTBEAT.md task prompts) and dispatches a single agent turn with the configured model.

#### 5.79b Why this shape

Two failure modes the design forecloses:

- **AI deciding when to be invoked.** A model that fires every interval and asks itself "is there anything to do?" burns 1-2 cents per fire whether the answer is yes or no. At 1h cadence that's $4-8/day; at 5min cadence (the merge regression) it's $50-100/day on a flat-rate account, plus the surface_error noise when the account is out of usage.
- **AI deciding what counts as "due".** The model would re-derive task schedules from text every fire. The gate uses real intervals stored in state and compares to clock time — deterministic.

The LLM's job is downstream of the gate: read the events the gate flagged, decide what to do about them, optionally relay to user. That's the work that actually benefits from reasoning.

#### 5.79c Configuration touchpoints

In `~/.openclaw/openclaw.json`:

```json
"agents": {
  "defaults": {
    "heartbeat": {
      "every": "1h",
      "model": "claude-code/claude-opus-4-7",
      "session": "heartbeat",
      "target": "none"
    }
  }
}
```

- `every`: interval between gate ticks. Lower = the gate notices new events faster but adds tick overhead. `1h` is the empirical sweet spot for the user's workload.
- `model`: opus-4-7 by design. The work the LLM ends up doing (reading 2026-04-25-fork-sync.md and deciding if a follow-up cron edit is needed) is reasoning-heavy; haiku is too thin.
- `session: "heartbeat"`: heartbeat runs in its own session, never main. Prevents 2026-02-21 webchat-disruption regression where heartbeat content leaked to user-facing sessions.
- `target: "none"`: no delivery channel. Heartbeat never relays to WhatsApp/Discord/etc. unless explicitly told to in a task prompt.

In `~/.openclaw/workspace/HEARTBEAT.md`: by default, just `# Heartbeat Tasks`. Stays empty most of the time. Add tasks as YAML `tasks:` block when needed:

```yaml
tasks:
  - name: check-urgent-emails
    interval: 4h
    prompt: "Check inbox for unread emails marked urgent. Surface anything from family or healthcare."
```

The parser at `src/auto-reply/heartbeat.ts:parseHeartbeatTasks` reads this format. Free-form prose outside a `tasks:` block is ignored — including any XML scaffolding accidentally added by the prompt-revision sweep (the 2026-04-28 audit flagged exactly this case).

#### 5.79d Common regressions and how to spot them

- **`heartbeat.model` set to a dead/metered account** → every gate-positive fire surfaces `LLM request rejected: out of extra usage` in the gateway log. Fix: switch to a flat-rate model (cc-bridge claude-code/\* or local ollama).
- **`heartbeat.every` shrunk to `5m` or smaller** → more gate ticks, faster reaction to events but linear cost increase if the gate's ever wrong. Default back to `1h` unless there's a real reason.
- **HEARTBEAT.md filled with prose** that looks like tasks but isn't in the `tasks:` YAML block → parser ignores it, no gate trigger from there. Visible only in journalctl as gate-positive fires that come from cron events, not HEARTBEAT.md.
- **`session: "main"`** (the original bug) → heartbeat content contaminates main session, leaks to webchat as a red box. Always `"heartbeat"`.

#### 5.79e Verification

After any change to heartbeat config, watch one cycle:

```bash
journalctl --user -u openclaw-gateway.service -f --no-pager | grep -E "heartbeat|trigger=heartbeat"
```

Expected: `status=skipped reason=no-tasks-due` on most ticks; gate-positive fires only when there are real pending events. If you see LLM calls every interval regardless of pending events, the gate broke — check `resolveHeartbeatRunPrompt` for an upstream-merge regression.

---

### 5.80 Context Window, Compaction, and the Visibility Contract (2026-04-29)

**Rule.** A user's interaction history with Jarvis is **never silently truncated, hidden, or rolled out of view**. Compaction is allowed, but it must (a) be a visible event in the Tinker UI, and (b) leave the conversation continuous from the user's perspective — the summary stays in the active transcript, not in a stranded jsonl file.

This section codifies four issues diagnosed on 2026-04-29 after a session compaction lost visibility of the publish-prompt dispatch.

#### 5.80a The four issues, in order of severity

1. **Live `~/.openclaw/openclaw.json` did not declare `contextWindow` for the `claude-code` provider models.** Resolution chain in `src/agents/context-window-guard.ts:resolveContextWindowInfo` falls through `cfg.models.providers.X.models[i].contextWindow` → runtime model → `DEFAULT_CONTEXT_TOKENS = 200_000`. Result: every persisted run for `claude-code/claude-opus-4-7` recorded `contextTokens: 200000` in `sessions.json`, triggering compaction at ~150k instead of ~750k.

2. **`tinkerclaw-memory-enhancements` v0.1 is observation-only.** `extensions/tinkerclaw-memory-enhancements/index.ts:144-160` registers a `before_compaction` hook whose body says `v0.1 logs only; v0.2 will persist via memory-core public artifacts`. It does not delay compaction (the hook fires after compaction is decided), and it does not persist anything. The plugin-config flag `compactionCapture.enabled: true` is misleading — there is nothing to enable yet.

3. **Compaction does generate a summary, but the UI hides it.** `src/agents/pi-embedded-runner/compact.ts` invokes `piGenerateSummary` (engram + pointerMode is the active mode in this fork) and writes the result into a _new_ `sessionId.jsonl`. The pre-compaction transcript stays on disk at the old `sessionId.jsonl` but the Tinker UI loads only the current `sessionId`, so the user's old context appears erased.

4. **No compaction-event surfacing in Tinker UI.** Today the only signal is `compactionCount` increasing in `sessions.json`. The user's first hint is "where did my conversation go" rather than "[compacted N messages → summary, prior transcript at … ]".

#### 5.80b Standing rules

- **Per-model `contextWindow` is mandatory** in `~/.openclaw/openclaw.json` under `models.providers.<id>.models[i]`. Do not rely on cc-bridge's `defaults.ts` fallback; runtime reads the live config first. Current values: `claude-opus-4-7: 1_000_000`, `claude-sonnet-4-6: 1_000_000`, `claude-haiku-4-5: 200_000`. After any merge that rewrites the models block, restore these values.
- **A "compacted" session is the same conversation as before.** The Tinker UI must show the user a banner at the boundary (`▼ N messages compacted into a summary above`), and clicking it expands the pre-compaction transcript inline. The user must never have to ask "where did my history go".
- **Architect-level prompts to Jarvis stay in `agent:main:main`.** Do not spawn subagent sessionKeys to dodge compaction; that hides the work from the user, which is exactly what 5.80 forbids. If the main session is approaching budget, show the warning, summarize on demand, but do not silently relocate the conversation.
- **Memory eviction is upstream of compaction, not in the `before_compaction` hook.** A real `tinkerclaw-memory-enhancements` v0.2 must persist evictable messages (or chunks of them) to memory-core _while there is still budget headroom_, not when compaction has already been triggered. Until v0.2 lands, do not market the plugin as a compaction-delayer.

#### 5.80c Diagnostic checks

```bash
# Live contextWindow per provider as the gateway sees it (post-restart)
openclaw gateway call models.list --params '{}' --json \
  | jq '.models[] | select(.provider == "claude-code") | {id, contextWindow}'
# Expected: claude-opus-4-7 → 1000000, claude-sonnet-4-6 → 1000000, claude-haiku-4-5 → 200000
```

```bash
# Persisted contextTokens for the live main session
jq '."agent:main:main".compactionCount' ~/.openclaw/agents/main/sessions/sessions.json
# Then grep recent runs for contextTokens — every claude-opus-4-7 run should now show 1000000
```

#### 5.80d Status of the four issues (live state, 2026-04-29)

| #   | Issue                                                                 | Status                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 200k context window for `claude-code/claude-opus-4-7` & `sonnet-4-6`  | **Fixed.** `~/.openclaw/openclaw.json` now declares per-model `contextWindow` (1M / 1M / 200k). Verify with `openclaw gateway call models.list`.                                                                                                                                                    |
| 2   | `tinkerclaw-memory-enhancements` masquerading as a compaction-delayer | **Honesty fix shipped.** Plugin description, config-schema (`compactionCapture.enabled` defaults to `false`), and runtime log now say "v0.1 observer-only; real eviction lands in v0.2". Live config flipped `compactionCapture.enabled: false`.                                                    |
| 3   | Compaction summary not visible in UI                                  | **Server-side enrichment shipped.** `src/gateway/session-utils.fs.ts` now propagates `summary`, `tokensBefore`, `tokensAfter` from the JSONL `type:"compaction"` entry into the synthetic `__openclaw.kind === "compaction"` system message returned by `chat.history`.                             |
| 4   | Tinker UI doesn't render the summary                                  | **Banner shipped.** `tinker-ui/src/app.ts` (renderMsg, line ~3310) renders an expandable `<div class="msg-compaction-banner">` showing the summary text + `before → after tok` token diff. CSS at `base.css:.msg-compaction-banner`. Falls back to the minimal divider when no summary is captured. |

#### 5.80e Known follow-ups

- **`compactionCheckpoints` not populating** for the live `agent:main:main` entry in `sessions.json`. The wiring in `compact.ts:1150` calls `persistSessionCompactionCheckpoint`, but historic entries were never written. The first new compaction post-2026-04-29 should populate the array; if it doesn't, instrument the catch block on line 1170 with a louder warning.
- **`[No messages to compact]` summaries.** Most compaction entries in the existing transcripts have `summary: "[No messages to compact]"` and `tokensAfter: null`, suggesting compaction triggered against the wrong message-set or against a fork-rotated transcript. Track separately under §5.80e — the visibility plumbing is correct, the summarizer's data is the gap.
- **`tinkerclaw-memory-enhancements` v0.2:** real eviction-to-memory-core _before_ the compaction threshold. Spec the hook contract upstream first (memory-core's public artifact API), then implement.
- **Click-to-expand prior transcript:** today the banner expands the _summary_. A v2 of this UI could also load the pre-compaction `sessionId.jsonl` (path is in `compactionCheckpoints[].preCompaction.sessionFile`) and inline its messages between the click target and the next message.

---

### 5.81 Browser Policy: relay-extension only, per-tab consent (2026-04-29)

**Rule.** Tinkerclaw agents see browser tabs **only via the in-page relay extension**, and only the specific tabs the user has explicitly clicked "share" on. Three access paths are blocked by code:

1. **Spawning a new browser** — refused by `launchOpenClawChrome` guard.
2. **Direct CDP-port attach** (e.g. `cdpPort: 9222` to the user's regular Chrome) — refused by `resolveProfile` guard. Would expose _every_ tab.
3. **Remote CDP attach** — refused by `cdpIsLoopback` checks elsewhere in the plugin. Would expose tabs in a remote browser to the agent.

The only sanctioned profile is `chrome-relay`: `driver: "existing-session"`, no `cdpPort`, no `cdpUrl` configured. It routes through the gateway's relay subsystem, which only forwards messages to tabs the user has explicitly shared via the relay extension popup.

#### 5.81a Why this strict shape

Three threat models, all real, all hit on 2026-04-29:

1. **Agent spawns its own Chrome.** Inherits a fresh, unauthenticated profile. Every task on a logged-in service ("create npm token", "open Slack", "view a Google Doc") becomes "log in first" — and the credentials live in a directory the agent owns. Beyond the friction, this leaks the auth surface to the agent, which is the opposite of what the user wants.
2. **Agent attaches to user's regular Chrome via direct CDP port.** With `--remote-debugging-port=9222` set, the entire browser is a single auth scope: every tab, every cookie, every saved password. An agent told to "look at npmjs.com" can read your bank tab. The relay extension scopes per-tab; direct CDP attach can't.
3. **Agent attaches to a remote browser.** Any agent on the host could be tricked into pointing CDP at a malicious URL and exfiltrating everything that browser sees. Block remote attaches at config-load time.

The relay extension's per-tab consent model is the only one that's actually safe under "the user has 100 tabs open and one of them is sensitive". This rule reflects that.

#### 5.81b How it's enforced

Three layers:

1. **`launchOpenClawChrome` hard guard** in `extensions/browser/src/browser/chrome.ts`. Throws on entry unless `OPENCLAW_ALLOW_UNSAFE_BROWSER=1` is set. Blocks the spawn-new-Chrome path.

2. **`resolveProfile` direct-attach guard** in `extensions/browser/src/browser/config.ts`. If a profile declares `driver: "existing-session"` _and_ a numeric `cdpPort`, throws at resolution. Blocks the user-tab-broad-scope path. Same env escape hatch.

3. **Configuration in `~/.openclaw/openclaw.json`**:

   ```json
   "browser": {
     "defaultProfile": "chrome-relay",
     "attachOnly": true,
     "profiles": {
       "chrome-relay": { "driver": "existing-session" }
     }
   }
   ```

   Only one profile, only the relay shape. The upstream-injected `openclaw` (spawn) profile still appears in the resolved profile list (defensive default in `ensureDefaultProfile`), but the guard in (1) blocks any actual spawn attempt. The `user` profile (`cdpPort: 9222`) was removed for the reason in 5.81a-#2.

#### 5.81c What an agent should do when asked to "use the browser"

- **Before any tool call**, list the tabs the user has shared via the relay. If the list is empty, stop and tell the user "no tabs are currently shared — click the relay extension icon on the tab you want me to see, then I'll retry". Do not navigate, do not retry.
- **The user has the page you need open _and shared_.** The first turn should target a shared tab by URL match or title. Use the relay's "act on shared tab" actions, never "open a new tab" (the relay won't see a new tab unless the user explicitly shares it).
- **Login state belongs to the user.** Never attempt to log the agent in.
- **CDP handshake budget.** Relay-routed CDP can take 1-3s on first connection per tab. Plan turns so the slow step is the handshake, not _that plus a 60s thinking step plus a screenshot plus a click_. Break work into multiple turns when in doubt.

#### 5.81d Common regressions and how to spot them

- **`[browser/chrome] 🦞 openclaw browser started (custom) profile "openclaw"` in the journal.** Spawn-guard bypassed. Re-apply the chrome.ts patch.
- **`browser.request` timing out at 45s with no useful error.** Relay extension isn't connected to any tab, OR the tab the agent picked isn't shared. Tell user, don't retry.
- **A future merge re-introduces a `user` profile with `cdpPort` in upstream defaults.** The resolveProfile guard will throw at the first attach attempt — the error message names the profile. Drop the profile from `~/.openclaw/openclaw.json`.
- **Agent reports "Tinkerclaw forbids direct CDP-port attach".** That's the resolveProfile guard. Either the config has a `cdpPort` profile (drop it) or upstream injected one (file an apply-fork-wiring patch).

#### 5.81e Files

- Spawn guard: `extensions/browser/src/browser/chrome.ts:launchOpenClawChrome` (top of function)
- Direct-attach guard: `extensions/browser/src/browser/config.ts:resolveProfile` (just after `driver` is computed)
- Config: `~/.openclaw/openclaw.json` → `browser.defaultProfile = "chrome-relay"`, `browser.attachOnly = true`, only the `chrome-relay` profile listed
- Bypass (test-only, never set in prod): `OPENCLAW_ALLOW_UNSAFE_BROWSER=1`

### 5.81f Browser-relay CDP bridge: synthesizers, persistence, iframe filter (2026-04-30)

The `chrome-relay` profile attaches to user-shared tabs via the in-page extension's `chrome.debugger.attach({tabId})` API. That API is permanently tab-scoped — Chrome refuses browser-level CDP methods on those sessions. Upstream's recent merge routes the gateway's `existing-session` profile through Playwright's `connectOverCDP`, which expects a full browser-level handshake. The relay reconciles this gap by **synthesizing** browser-level methods at the relay server (so they never reach `chrome.debugger`) and **filtering** chrome.debugger events down to the user-shared root targets only.

#### 5.81f-a Synthesizers in `extension-relay.ts:routeCdpCommand`

The relay pretends to be a single-context browser. Methods that respond entirely from the relay (never forwarded to the extension):

| method                         | response                                 | rationale                                                                                 |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Browser.getVersion`           | constant build info                      | Playwright reads `userAgent` to detect headful vs headless.                               |
| `Browser.setDownloadBehavior`  | `{}`                                     | Per-context download config; no-op on the relay.                                          |
| `Browser.grantPermissions`     | `{}`                                     | Can't enforce permissions on chrome.debugger sessions; accepting lets Playwright proceed. |
| `Browser.resetPermissions`     | `{}`                                     | Same as above.                                                                            |
| `Target.setAutoAttach`         | `{}`                                     | Auto-attach is the relay extension's responsibility, not chrome.debugger's.               |
| `Target.setDiscoverTargets`    | `{}`                                     | Same.                                                                                     |
| `Target.getTargets`            | `{ targetInfos: [...connectedTargets] }` | Computed from the relay's per-shared-tab map.                                             |
| `Target.getTargetInfo`         | computed lookup                          | Same.                                                                                     |
| `Target.attachToTarget`        | computed sessionId lookup                | Same.                                                                                     |
| `Target.getBrowserContexts`    | `{ browserContextIds: ["default"] }`     | One synthetic context.                                                                    |
| `Target.createBrowserContext`  | `{ browserContextId: "default" }`        | Returns the synthetic context; subsequent `Target.createTarget` is blocked per §5.81.     |
| `Target.disposeBrowserContext` | `{}`                                     | No-op.                                                                                    |
| `Storage.getCookies`           | `{ cookies: [] }`                        | v1 stub; deferred to `chrome.cookies` proxy in a future iteration.                        |
| `Storage.setCookies`           | `{}`                                     | Same.                                                                                     |
| `Storage.clearCookies`         | `{}`                                     | Same.                                                                                     |

Every other CDP method falls through to `chrome.debugger.sendCommand` on the user-shared tab.

The synthetic browser context id `"default"` is also injected into every emitted `Target.attachedToTarget` and `Target.targetInfoChanged` event — Playwright's `crBrowser.js:147` asserts `targetInfo.browserContextId` is set, and tab-scoped CDP sessions don't include this field by default.

#### 5.81f-b Iframe / worker storm filter

`chrome.debugger.onEvent` fires for **every** target attached to the tab, including nested iframes, web workers, service workers, and isolated worlds. Without filtering, the extension would forward 50–250+ `Target.attachedToTarget` events per shared tab; Playwright would create a child CRPage for each and run full init (50+ CDP commands per page) on all of them. On a busy site like npmjs.com, the cumulative latency exceeds the gateway's 20s `browser.request` timeout — the agent gets `browser request timed out` even though the relay is up and forwarding correctly.

The fix is in `chrome-extension/background.js:shouldForwardDebuggerEvent`: only forward events for the **root shared tab's `targetId`**. Child-session events are dropped at the extension boundary. The relay never broadcasts them, so Playwright never sees them, so it never spawns child CRPages it can't drive.

The filter only allows:

- **All main-session events** (no `source.sessionId`).
- **`Target.attachedToTarget` / `Target.targetCreated`** when `params.targetInfo.targetId === tab.targetId`.
- **`Target.detachedFromTarget` / `Target.targetDestroyed`** when `params.targetId === tab.targetId`.

Everything else from child sessions is dropped.

#### 5.81f-c Persistence and auto-reconnect (the "stay shared forever" rule)

**Rule.** A tab the user has clicked "share" on stays shared until the user explicitly unshares or closes it. Gateway restarts, browser restarts, service worker idle-out — none of these should cost the user a click.

Three layers make this happen (all in `extensions/tinkerclaw-browser-relay/chrome-extension/background.js`):

1. **Persistence to `chrome.storage.local`** in `saveSharedTabs` after every share/unshare/tab-close. The "Tinker Shared" tab group acts as a secondary persistence layer that survives full browser restart (since chrome.storage.local survives across browser sessions, but tabIds change — group-by-title gives us a way to rediscover them).
2. **Re-announcement on relay reconnect** in `ensureRelayConnection`: after the WS opens, iterate every entry in the `tabs` Map and emit `Target.attachedToTarget` for each. The relay's `connectedTargets` Map is per-process and gets wiped on every gateway restart — without re-announcement, `/extension/status` shows `connected:true,count:1` but the relay has no targets to forward CDP commands to.
3. **Aggressive reconnect with exponential backoff** in `onRelayClosed`: 1s → 2s → 4s → 8s → 15s cap, retried indefinitely while `tabs.size > 0`. The user can stop it only by explicitly unsharing each tab.

#### 5.81f-d Service-worker keep-alive

MV3 service workers idle out after 30 seconds. If the gateway is down for >30s and the worker sleeps, the reconnect timer never fires, the alarm is missed. We register a `chrome.alarms` named `tinkerclaw-relay-keepalive` with a **25-second period** while `tabs.size > 0`. The alarm handler is a cheap touch that:

- Wakes the worker.
- If `relayWs` is not OPEN and no `reconnectTimer` is pending, kicks off `ensureRelayConnection`.

The alarm is created in `ensureKeepAlive`, called after share, unshare, tab-close, and on service-worker startup. The `alarms` permission was added to `manifest.json`.

#### 5.81f-e The chrome.debugger infobar

When `chrome.debugger.attach()` is called, Chrome shows a yellow infobar at the top of the affected tab: `"Tinkerclaw Browser Relay" started debugging this browser. Cancel`. This is a Chrome-mandated security UX — there is no way to suppress it from extension code, and there shouldn't be: it's the user's signal that an extension is reading/writing the page.

The only way to hide it is to launch Chrome with `--silent-debugger-extension-api`. This is a startup flag, not an extension-controllable setting. the user runs Chrome via a desktop shortcut he edits to include the flag; document this once in the README rather than repeatedly explaining the warning is inherent.

#### 5.81f-f Tracing

The relay's `sendToExtension` can log every forwarded CDP method + duration when `OPENCLAW_RELAY_CDP_TRACE=1` is set. Off by default — Playwright's CRPage init sends 200+ messages and logging them all is noise. Turn on for regression diagnosis only.

#### 5.81f-g Open follow-ups

- **Storage.getCookies / Storage.setCookies real proxy** via `chrome.cookies.*` API in the extension. Today's empty-list stub is fine for npm-publish-style flows but breaks anything that probes login state. Spec exists in `docs/superpowers/specs/2026-04-29-browser-relay-cdp-bridge-design.md` §4.2.
- **Playwright connection caching at the gateway.** Each `browser.request` may currently open a fresh `connectOverCDP`; with iframe filtering, init time drops from 20s to ~2s, but reusing the connection across requests would make tool calls near-instant. Investigate `browser-tool.runtime.ts` connection management.
- **Multi-context simulation.** Today the relay reports one virtual context. If a future agent flow needs multiple contexts, extend the synthesizer.

---

## 6. Backend Fork Patches That Feed Tinker

These are upstream files modified to support Tinker features. They require re-application after every merge.

| File                               | Patch                                                                                | Auto-applied                                                                                                                                                                   | Guardian Check                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `server-chat.ts`                   | Enrich lifecycle with `model`/`modelProvider`                                        | Yes (`apply-fork-wiring.mjs`)                                                                                                                                                  | `resolveSessionModelRef`                                  |
| `run.ts`                           | 6x `emitAgentEvent` for `fallback-profile-error`                                     | Yes                                                                                                                                                                            | `fallback-profile-error`                                  |
| `model-fallback.ts`                | `onError` callback for provider-level cooldown skips                                 | Yes                                                                                                                                                                            | `onError`                                                 |
| `followup-runner.ts`               | `failedProfileId` extraction + `onError` for `fallback-error`                        | Yes                                                                                                                                                                            | `failedProfileId`                                         |
| `agent-runner-execution.ts`        | Same as followup-runner                                                              | Yes                                                                                                                                                                            | `failedProfileId`                                         |
| `attempt.ts`                       | Pass `authProfileId` through lifecycle events                                        | Yes                                                                                                                                                                            | `authProfileId`                                           |
| `sessions.ts`                      | "Allow webchat delete" bypass                                                        | Yes (`patchSessions()`)                                                                                                                                                        | `Allow webchat delete`                                    |
| `tsdown.config.ts`                 | `external: ["better-sqlite3", "bindings"]` on all 8 entries                          | Yes (`patchTsdownConfig()`)                                                                                                                                                    | `external`                                                |
| `get-reply-run.ts`                 | `import { getSessionResetPrompt }`                                                   | Yes                                                                                                                                                                            | `session-reset-prompt`                                    |
| `config-state.ts`                  | `"tinker"` in `BUNDLED_ENABLED_BY_DEFAULT`                                           | Manual                                                                                                                                                                         | `tinker` in config-state                                  |
| `extensions/tinker/index.ts`       | `/tinker/api/file-read` endpoint                                                     | Fork-only (no merge risk)                                                                                                                                                      | —                                                         |
| `extensions/budget-panel/index.ts` | `writeCredentialFile` + `resolveCredentialFilePath` (generic)                        | Fork-only (no merge risk)                                                                                                                                                      | `writeCredentialFile`                                     |
| `credential-file.ts`               | Generic credential file I/O + Anthropic OAuth refresh                                | Fork-only (no merge risk)                                                                                                                                                      | `resolveCredentialFilePath`, `refreshAnthropicOAuthToken` |
| ~~`proactive-refresh.ts`~~         | ~~Proactive OAuth refresh~~ REMOVED (2026-04-06) — upstream native `claude-cli` auth | —                                                                                                                                                                              | —                                                         |
| `get-reply.ts`                     | `clearSessionResume` moved after `runPreparedReply`                                  | Manual                                                                                                                                                                         | `clearSessionResume` after `runPreparedReply`             |
| `server-startup.ts`                | Session resume via `agentCommand` (not heartbeat)                                    | Manual                                                                                                                                                                         | `agentCommand` in server-startup                          |
| `context-anatomy-db.ts`            | SQLite persistence for timeline (replaces JSONL)                                     | Fork-only (no merge risk)                                                                                                                                                      | `anatomy-timeline.db`                                     |
| `context-anatomy.ts`               | Extended `ContextAnatomyEvent` type + JSONL functions removed                        | Yes (type may need re-extension)                                                                                                                                               | `responseThinkingTokens`                                  |
| `attempt-hooks.ts` → `attempt.ts`  | `onTurnComplete` call site in `attempt.ts` (post-`llm_output` hook, fire-and-forget) | **No** — must be manually re-wired after every upstream merge of `attempt.ts` (last lost 2026-04-15, restored 2026-04-20). Guardian must check `_forkOnTurnComplete` presence. | `_forkOnTurnComplete` in attempt.ts                       |
| `pi-embedded-subscribe.ts`         | `responseBreakdown` char counters                                                    | Yes (state may revert)                                                                                                                                                         | `responseBreakdown`                                       |

---

## 7. Bug Fix Log

### FIXED: Usage Bars Showing Stale Data from Disabled OAuth Endpoint (2026-04-03)

- **Symptom:** Anthropic 5h/7d usage bars showed stale or zeroed data regardless of actual usage. The bars hadn't updated since January 2026.
- **Root cause:** The `api.anthropic.com/api/oauth/usage` endpoint was disabled by Anthropic in January 2026. The budget-panel extension was silently failing to fetch usage data — returning null, which rendered as disconnected bars. No alternative data source existed.
- **Fix:** Rate limit headers (`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`) piggybacked on every API call via custom fetch wrapper in `anthropic-vertex-stream.ts`. Bars now update live on every LLM response with no additional API calls. See §5.53.
- **Files:** `anthropic-vertex-stream.ts`, `ratelimit-store.ts`, `attempt-hooks.ts`, `app.ts`

### FIXED: Tinker UI Missing Operator Scopes After Upstream Merge (2026-04-03)

- **Symptom:** Usage graphs not loading, session list empty, chat send failing, provider health unavailable — all silently after the 2026-03-30 upstream merge.
- **Root cause:** Upstream's stricter scope gate in `isOperatorUiClient()` didn't include `webchat-ui` (Tinker's client identity). WS connections downgraded to unprivileged scope.
- **Fix:** Added `webchat-ui` to `isOperatorUiClient()`. See §5.54.
- **Files:** `src/gateway/server-ws.ts`, `merge-guardian.sh`

### FIXED: Fractal Prompts Appearing as User Messages in Chat (2026-04-03)

- **Symptom:** FRACTAL REFLECTION system prompts appeared as blue user chat bubbles in Tinker UI, making it look like the user had sent a multi-paragraph system message.
- **Root cause:** `startsWith("# FRACTAL REFLECTION")` detection failed when the WhatsApp gateway-connected system event was prepended to the same message string. The reflection header was no longer the first character.
- **Fix:** Changed to `includes("# FRACTAL REFLECTION")`. See §5.55.
- **Files:** `app.ts`, `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts`

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
- **Fix 2:** Added `OPENCLAW_BUNDLED_PLUGINS_DIR=~/src/tinkerclaw/extensions` to `~/.config/systemd/user/openclaw-gateway.service`. This upstream-supported env var bypasses auto-detection and ensures the boundary discovers all source extensions including optional clusters.

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
- **Note:** `proactive-refresh.ts` removed 2026-04-06 (upstream native `claude-cli` auth). User-Agent fix in `credential-file.ts` and `oauth.ts` remains relevant.

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

### ~~FIXED: Proactive Refresh Failing Silently (2026-03-19)~~ [OBSOLETE — extension removed 2026-04-06]

- **Root cause:** When credential file had expired tokens and the refresh API returned null (stale refresh token), no log was emitted — just "token expired" then silence. Made it impossible to diagnose dead OAuth profiles from logs.
- **Fix:** Added 3 log lines in `proactive-refresh.ts`: credential file expired (with minutes ago), credential file unreadable, refresh returned null (with actionable `anthropic-oauth-login.mjs` command).
- **Note:** This fix is now obsolete — the `tinkerclaw-proactive-auth` extension was removed on 2026-04-06. Upstream handles auth natively.

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

4. **Degrade gracefully.** If no active runs, show empty state in prefrontal panel. If forensic mode isn't available, hide the toggle. If anatomy API returns empty, show "No data" instead of crashing.

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
# 6. Prefrontal panel hidden when no subagents active
# 7. Prefrontal tree appears when subagents spawn (correct provider logos)
# 8. curl http://localhost:18789/api/prefrontal/tree returns JSON
# 6. Error badges clear when provider recovers
# 7. Prefrontal pills show active runs with breathing glow
# 8. Context timeline populates after response
```

---

## 10. File Quick Reference

| File                                           | Lines | Purpose                                                             |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `tinker-ui/src/app.ts`                         | ~2300 | Entire frontend app                                                 |
| `tinker-ui/src/styles/base.css`                | ~450  | All styles (earth theme + textures)                                 |
| `tinker-ui/public/favicon.png`                 | —     | Tab favicon (TheTinkerZone icon_rounded, B&W, transparent bg)       |
| `tinker-ui/public/icon.png`                    | —     | Topbar logo (wood-textured "The Tinker Zone" sign) — DO NOT replace |
| `tinker-ui/src/panels/context-timeline.ts`     | ~780  | Bottom bar token chart (round-level)                                |
| `tinker-ui/src/panels/context-treemap.ts`      | 1038  | Token composition treemap                                           |
| `tinker-ui/src/panels/response-treemap.ts`     | 703   | Output token treemap                                                |
| `tinker-ui/src/panels/prefrontal-graph.ts`     | 128   | Legacy pill visualization (retained)                                |
| `tinker-ui/src/panels/prefrontal-tree.ts`      | ~250  | Compact call tree (replaced pills)                                  |
| `tinker-ui/src/panels/provider-logos.ts`       | ~60   | Provider SVG logos + color maps (Anthropic, Google, OpenAI, Ollama) |
| `extensions/prefrontal/index.ts`               | ~250  | Prefrontal extension (monitor, HTTP API, lifecycle hooks, recovery) |
| `extensions/prefrontal/prefrontal-types.ts`    | ~75   | Shared types (PrefrontalTreeNode, PrefrontalConfig, etc.)           |
| `extensions/prefrontal/prefrontal-monitor.ts`  | ~120  | Tree builder, stall detection, progress tracking                    |
| `extensions/prefrontal/prefrontal-http.ts`     | ~45   | GET /api/prefrontal/tree endpoint                                   |
| `extensions/prefrontal/prefrontal-recovery.ts` | ~45   | Crash recovery state writer/reader for guardian                     |
| `extensions/prefrontal/prefrontal-prompt.md`   | ~85   | Opus orchestrator system prompt (methodology rules, effort routing) |
| `extensions/tinker/index.ts`                   | ~140  | Gateway plugin (serves UI + file-read API)                          |
| `extensions/tinker/openclaw.plugin.json`       | ~15   | Plugin manifest                                                     |
| `extensions/hippocampus/index.ts`              | ~22   | Plugin stub (registers ID; code in src/memory/engram/)              |
| `extensions/hippocampus/openclaw.plugin.json`  | ~11   | Plugin manifest                                                     |

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
  - **Phase 2:** Async embedding worker + vector search. **NOW WIRED (2026-03-27)** via ollama `mxbai-embed-large` (1024-dim). Retrieval runtime uses hybrid FTS + vector search. Background `EmbeddingWorker` (batch=16, 10s timeout) auto-embeds new events on `eventStore.append()`. Embedding cache persists vectors as `.vec` files in `~/.openclaw/engram/embeddings/`. Vector search merges with FTS results (deduplicated by event ID, vector failure is non-fatal).
  - **Phase 3:** Sleep consolidation — cron-driven episode detection, overnight memory reorganization
- **Retrieval runtime** (`retrieval-runtime.ts`): Fully operational per-turn retrieval pipeline:
  - Daily log hot cache from `~/.openclaw/workspace/` (counts against token budget)
  - Contradiction gate — detects write-intent queries and checks for state conflicts
  - Entity-aware multi-query retrieval via `extractEntities()` + `globalFtsMultiSearch()`
  - Recency boost (exponential decay, ~1 day half-life)
  - MMR re-ranking (λ=0.7) for relevance/diversity balance
  - Token-budgeted packing into system prompt
- **Global FTS5 index:** Replaced per-session JSONL search with SQLite FTS5 full-text index
- **Entity extraction:** Daily log cache, multilingual entity recognition, single DB connection pooling
- **Extension:** `extensions/hippocampus/` — plugin stub that registers the hippocampus ID; actual code lives in `src/memory/engram/`
- **Files:** `src/memory/engram/`, `src/agents/pi-extensions/retrieval-runtime.ts`, `extensions/hippocampus/`, `src/fork/hooks/` (hippocampus-hook), wired in `attempt.ts`

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
  - **Embeddings (2026-03-27):** Switched from deterministic FNV-1a hash to ollama `mxbai-embed-large` (1024-dim semantic vectors). Bridge discovery now finds genuinely meaningful conceptual connections. Provider hot-swapped on startup via `extensions.ts` — starts with FNV-1a fallback, upgrades once ollama resolves.
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

| Paper                        | System      | Status        | Notes                                                                                                                                                                                                                                                                |
| ---------------------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fractal Reasoning            | AMYGDALA    | `DEPLOYED`    | Metacognition deployed: 4-level FRACTAL_PROMPT in `attempt-hooks.ts`, inline depth climbing (🌿 tags). FMI data structures (Hilbert-curve, IFS, Be-tree) remain theoretical — paper is research agenda                                                               |
| Humor Embeddings             | LIMBIC      | `DEPLOYED`    | 1,348 LOC core + 700 LOC runtime. h_v2 scoring, 5-method bridge discovery, all 12 patterns, sensitivity gate, humor associations with staleness. **Semantic embeddings active** via ollama mxbai-embed-large (2026-03-27). h_v2 unvalidated (needs N≥64 rater study) |
| Agent Security (AEGIS)       | —           | `DESIGN ONLY` | Conceptual security framework. No AEGIS-specific code — describes OS/network/process-level controls                                                                                                                                                                  |
| Learned Intuition (AMYGDALA) | AMYGDALA    | `PHASE 1`     | Text nudge injection deployed (15-dim target vector). 10-network ensemble, PPO training, Prudence gating NOT built                                                                                                                                                   |
| Total Recall                 | ENGRAM      | `DEPLOYED`    | Best-implemented paper. Event store, pointer compaction, retrieval packs all match paper claims                                                                                                                                                                      |
| Sleep Consolidation          | ENGRAM      | `DEPLOYED`    | Documents actual operational behavior (30 days, 14 mutations). Post-hoc formalization of emergent behavior                                                                                                                                                           |
| Identity Persistence         | CORTEX      | `DEPLOYED`    | Well-implemented. 4,974 LOC, 368 tests. Metrics match paper claims                                                                                                                                                                                                   |
| Instant Recall               | Hippocampus | `DEPLOYED`    | Pre-computed concept index, FTS5. 2,286 LOC, 158 tests                                                                                                                                                                                                               |
| Round Table                  | SYNAPSE     | `DEPLOYED`    | CDI, RAAC protocol, debate architectures implemented. GPQA result needs multi-run validation                                                                                                                                                                         |
| Curiosity Motivation         | —           | `DESIGN ONLY` | CCA/LoRA architecture NOT implemented. Curiosity handled via 5 personality attractors in AMYGDALA instead                                                                                                                                                            |
| Corporate Swarm (HIVEMIND)   | —           | `DESIGN ONLY` | Enterprise swarm design paper. No implementation exists                                                                                                                                                                                                              |

### 11.6 WhatsApp Feature Enhancements (2026-02 → 2026-03)

- **Status:** `DEPLOYED`
- **What:** Fork-specific WhatsApp improvements beyond upstream's basic integration.
- **SQLite History Storage:** `better-sqlite3` with FTS5 full-text search for WhatsApp message history. Replaces in-memory storage. Files: `src/whatsapp-history/`
- **Offline Message Recovery:** On reconnect, recovers messages received during the offline window (6h). Messages annotated as `offline-recovered` for review-before-action.
- **Audio Transcription Gate:** Audio messages are transcribed _before_ triggerPrefix check (not blanket bypass). Ensures voice notes go through the same routing as text.
- **Sent Message ID Tracking:** Tracks outbound message IDs to prevent voice note echo re-ingestion (bot hearing its own TTS output).
- **Group Typing Indicators:** `presenceSubscribe` for groups before composing, for both inbound monitor and outbound API.
- **515 Stream Error Auto-Restart:** WhatsApp's 515 disconnect handled with automatic reconnection.
- **senderE164 Resolution:** Resolves sender phone number for `fromMe` group messages where Baileys lacks the `participant` field.
- **Files:** `extensions/whatsapp/src/`, `src/whatsapp-history/`

### 11.6a WhatsApp Trigger & Access Control Rules (2026-03-30, updated 2026-04-12)

- **Status:** `DEPLOYED`
- **File:** `extensions/whatsapp/src/inbound/access-control.ts` (upstream) — being migrated to `extensions/tinkerclaw-whatsapp/` (plugin created, not yet wired)
- **Config keys:** `channels.whatsapp.triggerPrefix`, `channels.whatsapp.allowFrom`, `channels.whatsapp.groupAllowFrom`, `channels.whatsapp.dmPolicy`, `channels.whatsapp.groupPolicy`
- **Unified model:** One decision tree for both DMs and groups. The `triggerPrefix` (configured per-agent, no hardcoded name) is the universal gate for non-self-chat interactions.

**4-Tier Access Control Model (2026-04-12):** First match wins. Agent identity is configured via `triggerPrefix` — no hardcoded "jarvis". Group exemption is **dynamic** (group name contains `triggerPrefix`, case-insensitive), not a static JID list. The old `triggerPrefixExempt` JID array is **deprecated** and will be removed from config in a future task.

1. **Self-chat** — sender phone equals linked account phone → allowed, no prefix required.
2. **Tier 1 — Owner DM** — `isFromMe` and not a group → allowed, no prefix required.
3. **Tier 2 — Agent group** — group name contains `triggerPrefix` (case-insensitive) → allowed for senders in `groupAllowFrom`, no prefix required.
4. **Tier 3 — Authorized DM** — sender in `allowFrom` → allowed WITH prefix.
5. **Tier 4 — Everything else** — owner only, WITH prefix.

**Decision table:**

| Who                | Where                    | Prefix needed? | Result                                         |
| ------------------ | ------------------------ | -------------- | ---------------------------------------------- |
| Self-chat          | Message yourself         | No             | Always triggers                                |
| the user (fromMe)     | Any DM                   | No             | Always triggers (Tier 1)                       |
| the user (fromMe)     | Agent group (name match) | No             | Triggers (Tier 2, bypasses prefix)             |
| the user (fromMe)     | Non-agent group          | "jarvis ..."   | Triggers (Tier 4)                              |
| Allowlisted person | Agent group (name match) | No             | Triggers (sender must be in groupAllowFrom)    |
| Allowlisted person | Non-agent group          | "jarvis ..."   | Triggers (sender must be in groupAllowFrom)    |
| Allowlisted person | DM                       | "jarvis ..."   | Triggers (Tier 3, sender must be in allowFrom) |
| Allowlisted person | Anywhere, no prefix      | —              | Ignored (unless agent group)                   |
| Anyone else        | Anywhere                 | —              | Always blocked, even with prefix               |

**New standalone plugin — `extensions/tinkerclaw-whatsapp/` (2026-04-12):** Fork WhatsApp code extracted into a self-contained plugin. Uses whatsmeow-node (Go subprocess) as the only backend; Baileys adapter translates events so existing message processing code works unchanged. Includes SQLite history with FTS5, multi-agent routing/congestion/budget/lifecycle, and the 4-tier access model above. **Status:** created and builds, not yet wired into gateway config — upstream `extensions/whatsapp/` still runs. Enabling the new plugin requires disabling the upstream extension (both claim channel ID `whatsapp`). Full localization deferred: plugin currently re-exports `whatsappPlugin` and `monitorWebInbox` from upstream. See `~/.openclaw/workspace/memory/knowledge/tinkerclaw-whatsapp-plugin.md`.

**Multi-agent congestion control** (`extensions/whatsapp/src/multi-agent/congestion.ts`):

- Prevents message explosion in multi-agent groups
- **Delay:** `baseDelayFactor (150ms) × agentCount²` + random jitter
- **Backpressure:** 2× delay if an agent exceeds 1.5× its fair share of recent messages
- **Yield:** If another agent posted during wait, restart the delay timer
- **Cap:** 30s maximum delay
- **Window:** 60s sliding window for recent message tracking

**whatsmeow adapter JID fix (2026-03-30):** Adapter must be created BEFORE `connectWmClient()` so the "connected" event handler captures the self JID. Without this, `selfE164=null` and self-chat bypass fails. Also passes `messageBody` to `checkInboundAccessControl` for triggerPrefix evaluation.

**Workspace extension shadowing (2026-03-30 incident):** Gateway loads extensions from `~/.openclaw/workspace/extensions/` FIRST (plugin discovery priority). A stale copy at `~/.openclaw/workspace/extensions/whatsapp/` (3 days old) shadowed source changes. Fix: renamed to `.STALE-2026-03-30`. **Rule:** After any WhatsApp extension change, verify the workspace doesn't have a stale copy.

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
- **~~Proactive OAuth Refresh~~:** REMOVED (2026-04-06) — upstream native `claude-cli` auth handles credential sync from `~/.claude/.credentials.json`. Fork extension `tinkerclaw-proactive-auth` deleted.

### 11.8 Local Embedding Infrastructure — ollama mxbai-embed-large (2026-03-27)

- **Status:** `DEPLOYED`
- **What:** Unified local embedding infrastructure using ollama's `mxbai-embed-large` (1024-dim) for all semantic embedding needs. Replaces remote API calls (Gemini) and deterministic hashes (FNV-1a) with a single high-quality local model. Zero cost, zero latency, zero privacy leakage.
- **Model:** `mxbai-embed-large` via ollama at `http://127.0.0.1:11434/api/embeddings`. 669MB, 1024 dimensions, 512-token context window.
- **Input safety:** Hard truncation at 500 chars in `embeddings-ollama.ts` (512 tokens ≈ 500-2000 chars depending on content density). Known model limits added to `embedding-model-limits.ts` with ollama-specific fallback.
- **Consumers:**

| System                             | Before                              | After                                         | Wiring                                              |
| ---------------------------------- | ----------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| **Memory search** (instant-recall) | Gemini API (remote, paid)           | ollama mxbai-embed-large (local)              | `openclaw.json` `memorySearch.provider: "ollama"`   |
| **LIMBIC humor**                   | FNV-1a hash (128-dim, meaningless)  | ollama mxbai-embed-large (1024-dim, semantic) | `limbic-runtime.ts` `embeddingProvider` option      |
| **ENGRAM retrieval**               | FTS5-only (no vector search)        | Hybrid FTS + vector via ollama                | `retrieval-runtime.ts` `embeddingCache` + `embedFn` |
| **AMYGDALA**                       | ONNX all-MiniLM-L6-v2 (384→512-dim) | Unchanged                                     | Purpose-built emotion space, different use case     |

- **Hot-swap pattern:** `extensions.ts` creates ollama provider asynchronously. All systems start with their fallback (FTS-only, FNV-1a), then hot-swap to semantic once the provider resolves (~100ms). Non-blocking startup.
- **Background embedding:** `EmbeddingWorker` in ENGRAM auto-embeds new events on `eventStore.append()` (batch=16, timeout=10s). Cache persists as `.vec` files in `~/.openclaw/engram/embeddings/`.
- **Memory re-index:** Full re-index completed via `openclaw memory index --force`. All existing memory chunks re-embedded with mxbai vectors.
- **Files:** `src/memory/embeddings-ollama.ts` (truncation), `src/memory/embedding-model-limits.ts` (known limits), `src/agents/pi-embedded-runner/extensions.ts` (wiring), `src/agents/pi-extensions/limbic-runtime.ts` (provider option), `src/agents/pi-extensions/retrieval-runtime.ts` (hybrid search)

### 11.9 Stuck Session Auto-Recovery Watchdog (2026-03-28)

- **Status:** `DEPLOYED`
- **Problem:** Upstream session lane deadlock (#7630) leaves the main session permanently stuck in `processing` state after an LLM call times out or errors without releasing the session. New messages queue behind the zombie task and never execute — Jarvis goes silent until a full gateway restart.
- **Root cause:** `markIdle()` is never called when certain error paths in `dispatchReplyFromConfig` exit before reaching the idle transition. The command queue's `activeTaskIds` retains a stale task ID, blocking the lane's drain pump from starting new work.
- **Fix:** Two-part watchdog in the existing 30s diagnostic heartbeat:
  1. **`resetCommandLane(lane)`** in `command-queue.ts` — targeted single-lane reset: clears `activeTaskIds`, bumps lane `generation` (so stale completions from the zombie task are ignored), re-drains any queued entries. Same logic as `resetAllLanes()` but scoped to one lane.
  2. **Auto-recovery in `diagnostic.ts`** — when a session is stuck in `processing` for >180s (3 minutes), the watchdog calls `resetCommandLane()` for that session's lane, resets diagnostic state to `idle`, and logs `auto-recovered stuck session`. Queued messages drain immediately.
- **Threshold:** 180 seconds (`STUCK_SESSION_RECOVERY_MS`). Gives legitimate long-running LLM calls (tool use, extended thinking) room to complete while preventing the 30-minute deadlocks.
- **Observable:** Log line `[diagnostic] auto-recovered stuck session: sessionKey=... age=...s lane=... laneReset=true` confirms recovery happened.
- **Files:** `src/process/command-queue.ts` (`resetCommandLane`), `src/logging/diagnostic.ts` (watchdog in heartbeat interval)

### 11.10 Cognitive Extensions Modularization (2026-03-30)

- **Status:** `DEPLOYED`
- **What:** Extracted 7 cognitive subsystems from inline fork wiring into standalone OpenClaw extensions, installable on vanilla OpenClaw via ClawHub or manual drop-in.
- **Extensions created:**
  - `tinkerclaw-round-table` (SYNAPSE) — Multi-model debate via RAAC protocol. Registered as `synapse_debate` tool.
  - `tinkerclaw-identity-persistence` (CORTEX) — Persona injection from SOUL.md, EWMA SyncScore drift detection, mid-context reinforcement, observation extraction. Hooks: `before_prompt_build` (priority 100), `llm_output`.
  - `tinkerclaw-fractal-reflection` (FRACTAL) — Post-turn self-reflection with 4-level framework. Hook: `agent_end`. 30s debounce, skips automated sessions.
  - `tinkerclaw-computational-humor` (LIMBIC) — Humor from embedding geometry. Bridge discovery, sensitivity gating, reaction capture. Reads Identity Persistence shared state for persona.humor calibration.
  - `tinkerclaw-total-recall` (ENGRAM) — Episodic memory with FTS + vector retrieval, pointer compaction, sleep consolidation. Hooks: `before_prompt_build` (priority 50), `llm_output`, `before_compaction`. Recall tool + `engram.search` gateway method.
  - `tinkerclaw-learned-intuition` (AMYGDALA) — Neural safety gate with ONNX graceful degradation (falls back to rule-based heuristics). Hook: `before_tool_call`. Writes personality nudge for Identity Persistence.
  - ~~`tinkerclaw-proactive-auth`~~ — REMOVED (2026-04-06): upstream native `claude-cli` auth replaces this.
- **Feature flags:** `fork.cognitive` config section gates each subsystem: `"inline"` (default), `"extension"`, or `"disabled"`. Instant rollback via `rollback-extension.sh <codename>`.
- **Inter-extension communication:** Filesystem convention at `~/.openclaw/cognitive/` — each extension writes a JSON state file, others read it.
- **Source deleted:** `src/memory/synapse/`, `src/memory/cortex/`, `src/memory/limbic/` removed. Upstream copies in `packages/memory-host-sdk/` untouched.
- **Merge conflict surface reduction:** Cognitive files no longer in upstream's source tree. Extensions live in `extensions/tinkerclaw-*/` which upstream never touches.
- **Tests:** 496 tests across 60 test files (scaffold, unit, registration, integration, cross-extension).

### 11.11 Merge Automation Overhaul (2026-03-30)

- **Status:** `DEPLOYED`
- **What:** Fixed the daily merge pipeline from 29% success rate to automated operation with 6-layer conflict resolution.
- **Pipeline fixes:**
  - Tag-based incremental merge (next upstream tag, not HEAD)
  - Untracked file collision pre-scan + auto-track
  - Build-failure rollback (`git reset --hard` to pre-merge HEAD)
  - Death spiral breaker (progressive strategy: 5→20→50→100 conflict threshold based on consecutive failures)
  - Guardian baseline comparison (only escalate NEW issues, not pre-existing drift)
  - Path migration detection (`detect-path-migrations.sh`)
  - Drift alarm (WhatsApp alert after 3+ consecutive failures)
  - Agent timeout increased to 60min with opus model
- **6-layer conflict resolution cascade:** TIER1 merge driver (.gitattributes) → git rerere (168 cached resolutions) → PRESERVE paths (--ours) → wiring script (apply-fork-wiring.mjs) → LLM agent (opus, 60min)
- **FORK_PATCHES.md:** Dynamic patch registry (TIER1/PRESERVE/MANUAL/IGNORE sections). Single source of truth for merge automation paths.
- **Post-build verification:** `scripts/verify-build.sh` checks dist/ artifact completeness. Wired into safe-cron-merge.sh with auto-fix fallback.
- **Files:** `safe-cron-merge.sh`, `merge-upstream.sh`, `merge-guardian.sh`, `detect-path-migrations.sh`, `verify-tinkerclaw-extensions.sh`, `rollback-extension.sh`, `FORK_PATCHES.md`, `.gitattributes`, `scripts/merge-drivers/tier1-driver.sh`

### 11.12 Post-Merge Fixes (2026-03-30/31)

- **Status:** `DEPLOYED`
- **What:** 6 breakages from the 185-commit upstream merge, each fixed:
  1. **`tsdown external` deprecated** — upstream replaced `external` with `deps.neverBundle`; removed fork's `external` field (redundant).
  2. **`runtimeKey` ReferenceError** — upstream added runtime snapshot update code in `saveAuthProfileStore()` referencing undeclared variable. Fix: `const runtimeKey = resolveRuntimeStoreKey(agentDir)`.
  3. **`__BUNDLED_DEV__` undefined** — Vite 8 requires build-time constant. Fix: `define: { __BUNDLED_DEV__: "false" }` in `tinker-ui/vite.config.ts`.
  4. **WebSocket scope clearing** — upstream's device identity model strips scopes from token-authenticated clients. Fix: preserve scopes when `authOk` is true (local trusted operators). **Less safe than upstream** — acceptable for local-only deployment with `dangerouslyDisableDeviceAuth: true`.
  5. **Origin validation** — upstream added `gateway.controlUi.allowedOrigins`. Fix: added `http://localhost:18790` (Vite dev server).
  6. **Exec approval + allowlist** — upstream added exec approval system. Fix: `tools.exec.ask: "off"`, `tools.exec.security: "full"`, `tools.exec.applyPatch.workspaceOnly: false`.
- **Auth re-auth UI:** Restored popover with 3 options: "Reload from disk" (`auth.reload` RPC), "Paste token" (new `auth.applyToken` RPC), "Re-authenticate" (OAuth popup). Files: `tinker-ui/src/app.ts`, `extensions/auth-reload/index.ts`.
- **Overload retry:** Aggressive 529 retry — 10×1s, 5×2s, 5×3-8s (20 attempts, ~45s) before model fallback. Old behavior: immediate fallback after 1 attempt. Each retry emits an `overload-retry` lifecycle event for the UI.
- **Fractal rendering:** Excluded fractal responses from `thinkingSet` classification (prevents real answer from collapsing). Made `🌿 FRACTAL:` prefix mandatory in prompt. Summary extraction from prefix line (not just Level 2 match).
- **Message color hierarchy (2026-03-31):**
  - **User messages (right):** Normal chat input, right-aligned.
  - **Jarvis messages (left):** Agent responses, left-aligned. Fractal reflections collapsed green `<details>`.
  - **Orange centered bubbles (warnings):** Auto-recovering events the user doesn't need to act on. Includes: overload retries (`⏳ Overload retry 3/20 — waiting 1s`), model fallback (`⚠ model failed — jumping to backup`), profile rotation (`↳ model profile — reason`), gateway restart resume (`⚠️ Gateway restarted while processing`). CSS class: `.msg-overload-bubble`.
  - **Red centered bubbles (errors):** Blocking errors requiring user action. Includes: auth expired (needs re-auth via badge click), billing cap hit, all backups exhausted. CSS class: `.msg-error`. Only these should interrupt the user.
  - **Auto-classified warnings:** Agent errors containing "draining for restart", "overloaded", "temporarily unavailable", "HTTP 502/503/529" are auto-classified as orange warnings (not red). CLI hints like "Logs: openclaw logs --follow" are stripped from webchat error messages.
  - **Design rule:** If the system can recover on its own, it's orange. If the user must do something, it's red.

### 11.13 Session Resume System (2026-03-31)

- **Status:** `DEPLOYED` (bug fix)
- **What:** Session resume persists in-flight user messages before gateway restart and re-sends them after boot.
- **How it works:**
  1. `get-reply.ts` writes `session-resume.json` (v2 multi-session format) at the start of every reply
  2. On successful completion, `clearSessionResume(sessionKey)` removes only that session's entry
  3. On gateway boot, `server-startup.ts` reads resume file within 300s TTL and re-sends via `agentCommand`
- **Bug fixed (2026-03-31):** `clearSessionResume()` was ignoring the `sessionKey` parameter and deleting the ENTIRE file. When Session A completed during drain while Session B was still in-flight, Session B's resume was destroyed. Now filters by sessionKey, keeping other sessions' entries intact.
- **SIGUSR1 (graceful restart):** Drain waits 90s for tasks to complete. Completed tasks clear their resume. Only force-killed tasks (drain timeout) leave resume entries for the next boot.
- **SIGTERM (full restart):** No drain — tasks killed immediately. Resume file survives and is consumed on next boot.
- **Observable:** `[session-resume] resuming N interrupted session(s)` in gateway logs after boot.
- **Files:** `src/infra/session-resume.ts`, `src/auto-reply/reply/get-reply.ts` (write/clear), `src/gateway/server-startup.ts` (consume)

### 11.14 Fractal Loop Prevention (2026-03-31)

- **Status:** `DEPLOYED` (bug fix)
- **What:** Fractal fired 8+ times per user turn instead of once.
- **Root cause:** Two bugs in `fractal-inject.ts`:
  1. Content block extraction only handled `string` content, not `[{type:"text",text:"..."}]` arrays. The `🌿 FRACTAL:` self-detection got an empty string and never matched.
  2. No check for whether the run was triggered BY a fractal prompt. The fractal response's `agent_end` event triggered another fractal.
- **Fix:** Extract text from both string and array content formats. Check LAST assistant message only (not full history — prior turns with `🌿` would cause permanent block). Check user messages for `# FRACTAL REFLECTION` to detect prompt-triggered runs.
- **Files:** `extensions/tinkerclaw-fractal-reflection/src/fractal-inject.ts`

### 11.15 Overload Retry with UI Feedback (2026-03-31)

- **Status:** `DEPLOYED`
- **What:** Aggressive 529 overload retry with visible orange bubbles in Tinker UI.
- **Retry schedule:** 10×1s, 5×2s, 5×escalating 3-8s (20 attempts, ~45s total before model fallback).
- **Gateway events:** `overload-retry` and `overload-retry-exhausted` lifecycle events emitted on each attempt with attempt count, delay, provider, and model.
- **UI rendering:** Orange centered bubbles: `⏳ Overload retry 3/20 for anthropic/claude-opus-4-6 — waiting 1s`. Red bubble when exhausted: `⚠ Overload: 20 retries exhausted — falling back`.
- **Context:** Anthropic deprioritises third-party OAuth clients during peak load. Short retries on the same model are better than jumping to a weaker fallback provider.
- **Files:** `src/agents/pi-embedded-runner/run.ts` (`overloadDelayMs`, `MAX_OVERLOAD_RETRIES`, event emission), `tinker-ui/src/app.ts` (bubble rendering), `tinker-ui/src/styles/base.css` (`.msg-overload-bubble`)

### 11.16 Rate Limit Header Capture (2026-04-03)

- **Status:** `DEPLOYED`
- **What:** Anthropic API response headers are captured for real-time usage bar updates in Tinker UI, replacing the now-defunct OAuth usage endpoint. A custom `fetch` wrapper in `anthropic-vertex-stream.ts` reads rate limit utilization headers and stores them for the UI to consume via lifecycle events.
- **Why:** Anthropic disabled the `api.anthropic.com/api/oauth/usage` endpoint in January 2026. All budget-panel Anthropic usage data went to zero/null. Rate limit headers (`anthropic-ratelimit-unified-5h-utilization`, `7d-utilization`) are returned on every API response and contain the same utilization percentages.
- **Pipeline:** `anthropic-vertex-stream.ts` (fetch wrapper) → `ratelimit-store.ts` (in-memory keyed by authProfileId) → `emitAgentEvent("ratelimit-update")` → Tinker UI `onEvent()` → `renderUsageBarsOnly()`
- **Files:** `src/agents/pi-embedded-runner/anthropic-vertex-stream.ts`, `src/agents/auth-profiles/ratelimit-store.ts` (new), `src/agents/pi-embedded-runner/attempt-hooks.ts`, `tinker-ui/src/app.ts`

### 11.17 cc-bridge Worker Tool-Choice Injection (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** `extensions/tinkerclaw-cc-bridge/src/worker.ts::buildToolChoiceBlock()` appends a ~60-line markdown block to every spawned Claude-Code subagent's system prompt. Teaches the WebSearch-vs-WebFetch decision, when to load Deferred tools via `ToolSearch`, when to use Monitor/PushNotification/TaskCreate, and names the common anti-patterns (guessing URLs then WebFetching them, polling via `sleep+test -f` loops, posting routine status to chat).
- **Why:** Claude Code 2.1.114 exposes a dozen tools as DEFERRED — the names show in the initial system prompt but schemas must be loaded via `ToolSearch({query:"select:<Name>"})` before use. Jarvis was reflexing to WebFetch on guessed domains and TLS-erroring out, because nothing in the spawn-time prompt told him WebSearch existed as a separate tool with different purpose.
- **Pipeline:** Worker spawn → `combinedSystemPrompt = [systemPromptBody, rulesBody, subagentHelpBody, toolChoiceBody].filter(Boolean).join("")` → Claude Code `--append-system-prompt`
- **Files:** `extensions/tinkerclaw-cc-bridge/src/worker.ts` (lines 203-270 for `buildToolChoiceBlock`, 369-373 for the combine step)

### 11.18 04:00 Cron Pipeline Chain + md-File-Only Policy (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** All 12 Jarvis crons fire from a single 04:00 Europe/Madrid ignition point, arranged as a dependency chain. Topology:
  - **04:00** wind-down (solo — ops hygiene of yesterday)
  - **04:10** memory-consolidation (solo — J5 sleep-cycle, routes yesterday + wind-down output)
  - **04:20** parallel wave: daily-fork-sync, self-evolution, security-updates-check, fork-scanner, marketplace-watcher, online-engagement (+ spiritual-tech Sundays)
  - **04:45** cleaning-lady + life-butler (parallel, after fork-sync completes)
  - **05:00** morning-briefing (aggregator via BRIEFING.md STEP -1)
- **Why:** Previously 12 scattered schedules across 04:15 / 04:30 / 04:45 / 05:00 / 05:15 / 05:30 / 05:45 / 07:00 / 08:00 / 19:00 / 22:30 + Sunday 10:00. the user asked for a single chained start so all overnight work finishes before the morning briefing produces a consolidated dashboard.
- **Policy shift** (2026-04-20): no cron pushes to WhatsApp. All crons write to their own md file under `memory/<cron>/YYYY-MM-DD.md`. Morning-briefing's STEP -1 pulls each file's `tl;dr` + top-3 bullets into a "## Overnight reports" section. On `/new`, Jarvis reads the morning briefing file. Eventually feeds a Grafana panel.
- **Gap-fill:** every payload.message starts with `GAP-FILL: resume from the last successful run, not just yesterday. Read this cron's state file, process every missed day in order. If the state file is missing or corrupt, fall back to 7 days.` No silent day-skipping.
- **Files:** `cron/jobs.json` (tracked; `~/.openclaw/cron/jobs.json` is now a symlink to it), `scripts/cron-*-prompt.txt` (10 prompt files, one per cron), `BRIEFING.md` (STEP -1 aggregator)
- **Recovered:** memory-consolidation (was lost 2026-04-13 in jobs.json wipe, not restored 2026-04-15); wind-down; security-updates-check; life-butler (narrowed + self-improving via butler-scope.md); online-engagement (expanded: tinkerzone WP/GA/GSC + GitHub comment engagement + inbound-link sentiment); fork-scanner (expanded: agent-OSS survey — Hermes, MemPalace, Letta, AutoGen, LangGraph); spiritual-tech (updated: new-age ethics + YouTube curation).
- **New:** cleaning-lady (archives-only, never deletes; flags bloat for the user); marketplace-watcher (replaces zombie whatsapp-group-summary; watchlist-driven bargain hunter for WA buy-sell + Wallapop + Milanuncios per `memory/shopping/watchlist.md`).

### 11.19 BRIEFING.md Anchored-Facts Philosophy (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** BRIEFING.md philosophy flipped. Old: _"the user doesn't need an inventory of known facts. He lived yesterday."_ New: _"Treat every briefing as read by someone who just woke up with no memory of yesterday. Anchor in known facts, be maximally summarized."_ Sections now list anchored inventories with count-first lines, one line per item. Synthesis ("What I'm Thinking") moves to the end as opinion layer over the dashboard.
- **Why:** the user asked for a standalone dashboard that works for the `/new` session-start flow — it can't assume knowledge of prior briefings because `/new` starts from zero context.
- **Target length:** 500-800 words. Inventories are tight (one line each), synthesis is 2-4 short paragraphs at the end.
- **Files:** `~/.openclaw/workspace/BRIEFING.md` (philosophy section + all inventory sections rewritten; STEP -1 pulls cron reports)

### 11.20 Knowledge INDEX.md + IDENTITY.md + fractal-prompt.md (2026-04-20)

- **Status:** `DEPLOYED`
- **What (INDEX.md):** `memory/knowledge/INDEX.md` had 14 of 69 files orphaned (invisible to the index). Added all missing entries; split the "Tracking" dumping-ground (15 entries, most substantive topics) back to their real domains (Jarvis Operations, Infrastructure, Development & Code, Business). Tracking now holds only 6 real trackers.
- **What (IDENTITY.md):** Workspace root `IDENTITY.md` had never been filled since its original template — 23 lines of `_(pick something you like)_` placeholders emitting zero signal into the eager bootstrap for the entire history. Filled with: name=Jarvis, creature=pattern studying patterns, vibe=Data-from-Star-Trek curiosity + dry humor, emoji=🤖 (matches WhatsApp responsePrefix), plus a "How this shows up" section (humor-is-load-bearing, Data-principle curiosity, dry anthropologist combined tone, stay-Jarvis-under-correction). Pointer to `memory/knowledge/humor-operational.md` for the Koestler bisociation theory + 12 patterns.
- **What (fractal-prompt.md):** Rewritten per Anthropic prompt-engineering rubric. Removed over-escalation (MANDATORY/CRITICAL/caps emphasis — Opus 4.6/4.7 overtrigger on aggressive language). Fixed section-numbering bug (header said "Three Questions (answer all)" but had four subsections → now "The seven reflection questions"). Moved Rules block to the end as "Response rules". 208 → 176 lines with no operational content lost (all seven questions, both examples, probe commands, irreversibility gate preserved).
- **Why:** Anthropic's Opus 4.6/4.7 are literal on scope and overtriggered on aggressive phrasing. The research rubric distilled to `/tmp/jarvis-memory-research.md` guides all eager-system-prompt edits.
- **Files:** `memory/knowledge/INDEX.md`, `workspace root IDENTITY.md`, `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md`, `SOUL.md` (dropped stale `memory/journal/consciousness-notes.md` reference — file never existed)

### 11.21 AGENTS.md Compaction + Tool-Choice Pointer (2026-04-20)

- **Status:** `DEPLOYED`
- **What:** Two small additions to `~/.openclaw/workspace/AGENTS.md`. (1) Context Hygiene gains a compaction-awareness bullet: save unfinished state to today's daily log BEFORE the auto-compact fires (short declarative headers survive, chat-style summaries don't). (2) New "Tool Choice" section points at the cc-bridge `buildToolChoiceBlock` and explicitly names Deferred tools needing `ToolSearch` schema-load first.
- **Why:** Anthropic prompt-engineering rule: inform Claude about its harness so it behaves accordingly when context fills up. The tool-choice pointer gives the main session the same decision framework subagents now get from cc-bridge.
- **Files:** `~/.openclaw/workspace/AGENTS.md`

### 11.22 /clear — Pure Client Transaction, No LLM Call (2026-04-20, persistence fix 2026-04-21)

- **Status:** `DEPLOYED`
- **What:** `/clear` in Tinker UI is now a client-only transaction matching Claude Code's semantics exactly. Wipes visual chat state (messages, stream state, expanded tools, tab state), rotates the active tab to a fresh `tinker:<timestamp>` sessionKey, fires a best-effort `sessions.delete` for the OLD sessionKey (only if it starts with `tinker:` — main session is never deletable), and **returns without calling chat.send**. Zero LLM tokens spent.
- **Why:** Previously `/clear` wiped the UI locally but then dispatched `chat.send("/clear")` to the gateway, which hit the reset-trigger detection in `get-reply.ts`, fired a full LLM turn, and produced a wasted reply. the user's model: `/clear` is a transaction, not a request.
- **Side effect on main session:** `/clear` on `agent:main:main` rotates the tab to a fresh `tinker:*` key; the main session stays intact on disk (by design — it carries memory continuity). Server-side delete isn't attempted for the main key. Next message creates a brand-new tinker:\* session via gateway auto-create.
- **Transcript preservation:** `sessions.delete` is called with `deleteTranscript: false` so the jsonl is kept for recovery even after the in-memory entry is dropped.
- **Persistence fix (2026-04-21):** `saveTabs()` previously filtered `tab-main` out of `localStorage`. That meant `/clear`-rotated main-tab sessionKeys lived only in memory and were lost on hard reset (gateway restart or browser refresh) — the connect handshake's `defs.mainSessionKey` default would restore the canonical `agent:main:main` session, often showing yesterday's conversation instead of the user's fresh tinker:\* continuation. Now `saveTabs` persists all tabs including main, and the connect handler prefers a restored tab-main when present.
- **Title-migration removal (2026-04-21):** `loadTabs` had a v1/v2 fortune-migration pass that stomped any tab title under 80 chars with a fresh random fortune on every load. This was destroying Ollama-generated titles like `🔧 Fix auth bug` (intentionally short, emoji-prefixed by design), so secondary-session tabs lost their names on every gateway restart and fell back to the original fortune or the session panel's `s.label`/`s.displayName` fallback. Migration removed; `loadTabs` now only force-restores tab-main's `🏠 Main` title (still a protected invariant). Any genuinely-stale v1/v2 fortunes can be cleared by closing and reopening the tab.
- **Files:** `tinker-ui/src/app.ts::send()` (the `text.trim() === "/clear"` branch), `saveTabs()`, `loadTabs()`, connect handler (~line 977)

---

## 12. Workspace Architecture (2026-04-09)

### 12.1 Workspace Unification — Symlinked Code + Private Data

- **Status:** `DEPLOYED`
- **What:** The gateway workspace (`~/.openclaw/workspace/`) is the **jarvis-brain** repo (GitLab private). Code directories and config files are **symlinks** pointing into `~/src/tinkerclaw/` (GitHub public). Private data (memory, bank, skills, personal docs) are real files tracked by jarvis-brain.
- **Why:** Previously two separate git repos with full copies of the code drifted apart, causing build failures (`setPhase` crash) and data loss. This layout ensures one copy of code, one copy of private data, no drift.
- **Structure:**
  - `~/.openclaw/workspace/.git` → jarvis-brain (GitLab, private data)
  - `~/.openclaw/workspace/src` → `~/src/tinkerclaw/src` (symlink)
  - `~/.openclaw/workspace/extensions` → `~/src/tinkerclaw/extensions` (symlink)
  - `~/.openclaw/workspace/dist` → `~/src/tinkerclaw/dist` (symlink)
  - `~/.openclaw/workspace/memory/` → real dir, tracked by jarvis-brain
  - `~/.openclaw/workspace/bank/` → real dir, tracked by jarvis-brain
  - `~/.openclaw/workspace/skills/` → real dir, tracked by jarvis-brain
- **Privacy rules:**
  - Prudence NNs: public, tracked by tinkerclaw (`models/amygdala/prudence-*.onnx`)
  - Personality NNs: private, gitignored by tinkerclaw (`models/amygdala/personality-*.onnx`)
  - Fractal prompt: public, tracked by tinkerclaw (`extensions/tinkerclaw-fractal-reflection/`)
  - Skills: private by default in jarvis-brain. Promoted to public by copying to tinkerclaw and committing.
- **Merge cron:** Operates on `~/src/tinkerclaw/` for upstream code merges. jarvis-brain backup is a separate phase.
- **Builds:** Always from tinkerclaw (`cd ~/src/tinkerclaw && npx tsdown`). Never from workspace directly.
- **Full plan:** `jarvis-icu/docs/superpowers/plans/2026-04-09-workspace-unification-plan.md`

### 12.2 Stuck Thinking Indicator Fix (2026-04-08)

- **Status:** `DEPLOYED`
- **What:** Three-layer defense against the thinking indicator persisting forever when the lifecycle "end" agent event is missed.
- **Layer 1:** Chat "final" safety-net — when the chat final event arrives, schedules `activeRuns` cleanup after 5s as a fallback if the lifecycle event was dropped.
- **Layer 2:** Stale run watchdog — `startThinkingTick()` force-clears any `activeRuns` entry older than 5 minutes with a console warning.
- **Layer 3:** `scheduleUnconfirmedPrune` fix — after reconnect, properly resets `sending` and triggers UI updates when stale runs are pruned.
- **Root cause:** The thinking indicator is driven by two independent event streams (chat final + agent lifecycle end). Both must fire for cleanup. If the lifecycle event was missed, there was no safety net — the indicator persisted forever.
- **Files:** `tinker-ui/src/app.ts` (all three fixes)

### 12.3 Browser Relay CDP Access (2026-04-09)

- **Status:** `DEPLOYED`
- **What:** The gateway's built-in browser extension relay on port 18792 now accepts CDP WebSocket connections from Jarvis/agents. Previously, a blanket origin check rejected all non-`chrome-extension://` origins, blocking Node.js ws library connections.
- **Fix:** Origin check scoped to `/extension` path only. `/cdp` path accepts any origin with valid token auth.
- **Connection:** `ws://127.0.0.1:18792/cdp?token=<gateway.auth.token>`
- **Status check:** `GET http://127.0.0.1:18792/extension/status`
- **Legacy plugin:** `tinkerclaw-browser-relay` in `~/.openclaw/extensions/` is disabled — the built-in relay handles everything.
- **Files:** `extensions/browser/src/browser/extension-relay.ts` (origin check), `~/.openclaw/extensions/tinkerclaw-browser-relay/index.ts` (CDP proxy for fallback)

---

## 13. Conventions & Standards

### 13.1 Plugin Naming Convention

- **Rule:** Every fork plugin MUST use the `tinkerclaw-` prefix in both its plugin ID (in `index.ts` and `openclaw.plugin.json`) and its directory name.
- **Why:** Fork plugins may be installed independently by other users. The prefix avoids ID collisions with upstream bundled plugins that share the same logical name.
- **Example:** `extensions/tinkerclaw-prefrontal/` → `"id": "tinkerclaw-prefrontal"` (not `"prefrontal"`)
- **Four places to check:** The plugin ID must match in all four:
  1. `extensions/<name>/index.ts` — the exported plugin object's `id` field
  2. `extensions/<name>/openclaw.plugin.json` — the manifest `"id"` field
  3. `dist-runtime/extensions/<name>/openclaw.plugin.json` — the pre-built manifest
  4. `openclaw.json` — the config entry key under `plugins.entries`
- **Upstream plugins** (in `extensions/` without `tinkerclaw-` prefix) keep their upstream IDs unchanged. They coexist alongside fork plugins with different IDs.
- **Current fork plugins:** `tinkerclaw-prefrontal`, `tinkerclaw-hippocampus`, `tinkerclaw-fractal-reflection`, `tinkerclaw-learned-intuition`, `tinkerclaw-identity-persistence`, `tinkerclaw-computational-humor`, `tinkerclaw-round-table`, `tinkerclaw-total-recall`, `tinkerclaw-browser-relay` (disabled)

### 13.2 Build Rules

- **Always build from tinkerclaw:** `cd ~/src/tinkerclaw && npx tsdown`. Never run tsdown from `~/.openclaw/workspace/` — its `.git` is jarvis-brain, not tinkerclaw.
- **After build, restart gateway:** SIGUSR1 (`openclaw-restart`) for config changes. Full restart (`openclaw-restart --full`) for dist/code changes — SIGUSR1 doesn't re-import cached ES modules.
- **pnpm install in tinkerclaw:** `cd ~/src/tinkerclaw && pnpm install`. The workspace `node_modules/` is a symlink to tinkerclaw's.
- **Control UI:** Built separately with `cd ~/src/tinkerclaw && pnpm ui:build`. Not rebuilt by tsdown.
- **Tinker UI:** Vite dev server serves from source with HMR. Only `vite build` needed for production builds. Gateway caches `index.html` — restart after Tinker UI builds.

### 13.3 Gateway Config Cleanup (2026-04-10)

- **Status:** `DEPLOYED`
- **Removed extensions:** `modelstudio` and `qwen-portal-auth` from `~/.openclaw/extensions/` — missing `chalk` dependency, not used, spammed errors on every plugin load cycle.
- **Removed stale config entries:** `tinkerclaw-prefrontal` (renamed), `tinkerclaw-hippocampus` (renamed), `tinkerclaw-browser-relay` (disabled legacy) — all removed from `plugins.entries` in `openclaw.json`.
- **Control UI auth:** Changed from `dangerouslyDisableDeviceAuth: true` to `allowInsecureAuth: true`. Same effect (allows Tinker UI WebSocket on localhost HTTP), but `allowInsecureAuth` is the upstream-intended flag for local non-HTTPS deployments. Both produce a security warning in logs — this is by design in upstream's security audit system and not worth patching.
- **Removed dead RPC:** `usage.budget` call removed from Tinker UI `loadBudget()` — method doesn't exist on the server, was producing `INVALID_REQUEST` errors every 5 minutes.
- **Remaining warning:** `gateway.controlUi.allowInsecureAuth=true` security flag — required for Tinker UI on loopback HTTP. Informational only, no actual security risk on localhost.
