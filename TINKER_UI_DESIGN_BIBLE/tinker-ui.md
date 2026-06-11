---
file: tinker-ui.md
purpose: Tinker UI — layout, visual language, and the feature registry of UI behaviors
audience: AI
last_verified: 2026-06-10
last_verified_commit: 18e618d241
single_owner: yes — UI-visual + UI-feature facts live here. Migrated from bible.md §3, §4, §5.1-§5.65 on 2026-05-11.
see_also: flows.md (F1 chat.send pipeline that feeds the UI), lifecycles.md (L5 chat.send run states the UI subscribes to), topology.md (Tinker UI Vite process)
note: this is the original prose from the bible, relocated verbatim. Some sections cross-reference §X.Y numbers that now resolve here in this file rather than the old bible.md.
verify:
  - name: Tinker UI source file exists at the expected path
    cmd: test -f ~/src/tinkerclaw/tinker-ui/src/app.ts
  - name: UI snapshot probe is reachable and the snapshot file is on disk
    cmd: python3 -c 'import subprocess,os; subprocess.run(["openclaw","gateway","call","debug.dumpUiSnapshot"],capture_output=True,text=True,timeout=25); assert os.path.isfile(os.path.expanduser("~/.openclaw/data/tinker-ui-snapshot.html"))'
  - name: fs-link click handler is wired in app.ts (canonical fork pattern, not duplicated elsewhere)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "fs-link" in t and "config.openExternalFile" in t'
  - name: generated FORK registry markers present (spliceable region exists)
    cmd: python3 -c 'import os; t = open(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/tinker-ui.md")).read(); assert "BEGIN GENERATED-FORK-REGISTRY" in t and "END GENERATED-FORK-REGISTRY" in t, "registry markers missing — run scripts/gen-tinker-ui-registry.mjs --apply"'
  - name: gen-tinker-ui-registry.mjs is runnable end-to-end
    cmd: python3 -c 'import subprocess,os; r=subprocess.run(["node",os.path.expanduser("~/src/tinkerclaw/scripts/gen-tinker-ui-registry.mjs")],capture_output=True,text=True,timeout=25); assert r.returncode == 0, f"generator failed: {r.stderr[-300:]}"; assert "anchor" in r.stdout.lower() and "|" in r.stdout, "generator output unexpected shape"'
  - name: §5.65 recipe decision-trail visual elements exist (provenance chip CSS + recipe-supersede trail icon)
    cmd: python3 -c 'import os; css=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/styles/base.css")).read(); ts=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/prefrontal-tree.ts")).read(); assert ".pf-decisions-recipe" in css and ".pf-subtask" in css, "decision-trail CSS classes missing"; assert "TRAIL_ICON_BY_KIND" in ts and "recipe-supersede" in ts and "pf-subtask" in ts, "trail-icon map or subtask render missing"'
  - name: §5.75 BROCA visibility — skill-highlight token + broca.ts render module + RECIPES-panel coloring (committed 35f46d2/4825c74/041e3e7)
    cmd: python3 -c 'import os; css=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/styles/base.css")).read(); b=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/broca.ts")).read(); pt=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/prefrontal-tree.ts")).read(); assert "--skill-highlight" in css and ".broca-skill" in css, "skill-highlight token/class missing in base.css"; assert "renderBrocaProgram" in b and "colorSkillTokens" in b, "broca.ts render module missing"; assert "colorSkillTokens" in pt, "RECIPES-panel structured skill-coloring missing"'
  - name: §5.8d narration/answer separation — splitLeadingNarration helper + Commentary block in sectioned-reply.ts
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/sectioned-reply.ts")).read(); assert "splitLeadingNarration" in t and "narration-details" in t and "Commentary" in t, "narration-split helper / narration-details block / Commentary label missing in sectioned-reply.ts"'
  - name: §5.8d narration/answer separation — plain-path render sites in app.ts call splitLeadingNarration
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "splitLeadingNarration" in t and "narration-details" in t, "splitLeadingNarration / narration-details not wired into app.ts plain-path render sites"'
  - name: §5.8e native-reasoning stream consumer — app.ts handles stream=="thinking" and renders an _isReasoning bubble
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "p?.stream === \"thinking\"" in t, "event:agent stream==thinking handler missing in app.ts"; assert "_isReasoning" in t, "_isReasoning marker missing in app.ts"'
  - name: §5.8e DON'T-REGRESS — _isReasoning is excluded from the positional thinking classifier (skip guard) and gets a dedicated .msg-thinking renderMsg branch
    cmd: python3 -c 'import os,re; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); occ=[m.start() for m in re.finditer("_isReasoning", t)]; assert len(occ) >= 2, "_isReasoning must appear in both the classifier skip-guard and the renderMsg branch"; assert "msg-thinking" in t, ".msg-thinking render path missing"'
  - name: §5.8e _turnIncomplete ⚠ badge — incomplete-badge element exists in app.ts
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "msg-incomplete-badge" in t, "msg-incomplete-badge (turn-incomplete ⚠ badge) missing in app.ts"'
  - name: §5.8e generic unknown-stream fallback — KNOWN_STREAMS denylist routes unknown streams to renderSystemMsg
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "KNOWN_STREAMS" in t, "KNOWN_STREAMS denylist for the unknown-stream fallback missing in app.ts"'
  - name: §5.8f per-tab thinking slider — model-think-slider element exists in app.ts (rendered into #budget-panel under the active tab's model row, NOT the removed chat-area strip)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "model-think-slider" in t, "model-think-slider (per-tab thinking slider in the Models panel) missing in app.ts"'
---

# Tinker UI — layout, visual language, feature registry

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
- **Files:** `app.ts` (tracking + rendering), `base.css` (animation), `server-chat.ts` (enrichment), `embedded-agent-subscribe.handlers.lifecycle.ts` (authProfileId source)
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
  - **Layer 1 — Agent events:** `emitReasoningStream()` in `embedded-agent-subscribe.ts` already emitted `emitAgentEvent({ stream: "thinking" })`. Added `emitAgentEvent({ stream: "thinking", data: { phase: "end" } })` to `emitReasoningEnd()` in `handlers.messages.ts`.
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
  2. **`streamReasoning` required `onReasoningStream` callback** — `embedded-agent-subscribe.ts` line 48 gated `streamReasoning` on callback existence. But the `emitAgentEvent` broadcast to the gateway is independent of the callback. Fixed: `streamReasoning = reasoningMode === "stream"` (no callback check). Callback called with optional chaining.
  3. **Thinking temps stripped on finalization** — `app.ts` final handler removed ALL non-tool temporary messages, including thinking temps. Fixed: both finalization paths now preserve `type: "thinking"` temporary messages (promoted to permanent alongside tool messages).
- **2026-03-16 Fix round 2 — 3 deeper rendering bugs (commit `19a1c0278`):** 4. **`isCurrentRun` oscillation** — `streamMsgIdx` is -1 between tool calls and during thinking-only streaming. `isCurrentRun` only checked `streamMsgIdx >= 0`, so text temps flipped between thinking/normal style on each `updateChat()`. Fixed: now also checks `thinkingMsgIdx >= 0` and presence of `_temporary` messages in the run. 5. **"Reasoning:" prefix in agent events** — `formatReasoningMessage()` wraps text in `Reasoning:\n_italic_` for WhatsApp/Telegram. Agent events passed this formatted text → Tinker UI showed "Thinking: Reasoning: _italic text_". Fixed: agent events send raw trimmed text; only the messaging callback gets formatted text. 6. **Multi-round thinking duplication** — `extractAssistantThinking(msg)` returns ALL thinking blocks from the partial message. Round 2's thinking temp got round 1 + round 2 text. Fixed: new `currentThinkingBlock` state field tracks per-block text using SDK deltas. Reset on `thinking_end` along with `lastStreamedReasoning`, so each round starts fresh. 7. **All streaming text is thinking** (commit `f9b0eb50a`) — ~~during streaming, ALL text temps render as thinking bubbles~~ **SUPERSEDED by 2026-03-20 rework**: text is never classified as thinking. The model's own `thinking`/`text` block type classification is trusted. 8. **Promote temps, don't replace with server text** (commit `d349a325c`, -72 lines) — ~~ROOT CAUSE of "thinking prepended to answer" — promoted temps keep segmented text, thinkingSet classifies all-but-last as intermediates~~ **SUPERSEDED by 2026-03-20 rework**: temps are promoted AND text segments merged into one using server's authoritative text. The thinkingSet heuristic that classified text as thinking was the actual root cause of 4 bugs (repeated thinking, stale bubbles, Jarvis prefix in thinking box, thinking patterns in answer). See §5.8.
- **Fork maintenance:** Merge guardian checks for `phase.*end` in `handlers.messages.ts`, `thinking_delta`/`thinking_end` in `server-chat.ts`, `currentThinkingBlock` in `handlers.types.ts`. After upstream merge: verify `get-reply-directives.ts` still has the `thinkingActive → "stream"` branch, `embedded-agent-subscribe.ts` `streamReasoning` is not re-gated on callback, and `currentThinkingBlock` exists in the subscribe state.
- **Files:** `embedded-agent-subscribe.handlers.messages.ts`, `embedded-agent-subscribe.handlers.types.ts`, `embedded-agent-subscribe.ts`, `get-reply-directives.ts`, `server-chat.ts`, `app.ts`, `merge-guardian.sh`

### 5.8d Inter-tool narration / answer separation

- **Status:** `DEPLOYED` (2026-06-10)
- **What — the failure mode:** With the cc-bridge brain (claude-cli `-p` print mode), Claude Code emits its between-step narration — "let me check X", "I'll read the config", "now let me verify Y" — as **visible assistant text**, not as native `thinking` blocks. Confirmed by streaming inspection: this narration arrives as `text_delta` at a **single `contentIndex` across the whole turn**, so it is NOT split into a separate intermediate text message the way §5.8/§5.8c rely on. Because the narration and the final answer share one content block, the thinking/answer separation machinery (§5.8c `thinkingSet`, §5.8b reasoning-group) cannot peel them apart — the narration **fuses into the same bubble as the final answer** and surfaces as a run of "let me…" sentences sitting at the **top of the answer bubble**. This is distinct from §5.8c (which handles native `thinking` blocks and per-tool intermediate text temps) and from §5.8 (cross-tool text segmentation); here there is only one block and no segmentation hook to grab.
- **The fix — content-local leading-narration peel:** A pure, content-local helper `splitLeadingNarration` in `tinker-ui/src/sectioned-reply.ts` inspects only the answer's own text (no run/streaming state) and peels a **leading run of narration-shaped sentences** off the front. The peeled narration is moved into a **collapsed `Commentary` block** — CSS class `narration-details`, reusing the existing reasoning-group look (§5.8b) — rendered **next to the reasoning group**, so the narration is **relocated, never dropped**, and the answer bubble is **never blanked** (if the peel would empty the answer, nothing is peeled). This runs at **final-answer render ONLY** (`!isThinking`) — never on a live/streaming bubble — in both `renderSectionedReply` and the **two plain-path `app.ts` render sites** that bypass the sectioned renderer.
- **Heuristic (deliberately conservative):** Only a _leading_ run of narration sentences is eligible, matching the "let me &lt;action-verb&gt;…" / "I'll &lt;verb&gt;…" shape, and the peel only fires when there is a **trailing non-narration sentence** to keep as the real answer. No trailing answer ⇒ no peel (the text is treated as the answer as-is). This keeps genuine answers that happen to start with "Let me explain…" from being eaten while still catching the cc-bridge "let me check / I'll read" preamble.
- **Relationship to §5.8 / §5.8c:** §5.8c separates native `thinking` from `text`; §5.8 segments text across tool-call boundaries. §5.8d is the **single-block fallback** for the cc-bridge case where Claude Code's narration is plain `text` at one `contentIndex` and neither prior mechanism gets a seam to cut on — so a content-local heuristic peels it at render time.
- **CSS:** `.narration-details` (collapsed Commentary block; inherits the reasoning-group visual language — see §5.8b `.reasoning-group`/`.reasoning-header`)
- **Files:** `tinker-ui/src/sectioned-reply.ts` (`splitLeadingNarration`, `Commentary` block, `narration-details`), `app.ts` (two plain-path render sites call `splitLeadingNarration`), `base.css` (`.narration-details`)

### 5.8e Native extended-thinking stream consumer (`stream:"thinking"`)

- **Status:** `DEPLOYED` (2026-06-11)
- **What — the capability:** A NEW consumer on the `event:"agent"` channel that renders the model's **native extended-thinking** stream. It handles `p?.stream === "thinking"` frames — fed by the cc-bridge `pushThinkingDelta` and by the embedded path's `emitReasoningStream` (both gated on `reasoningMode === "stream"`, see §5.8c layers 1–2) — and accumulates them into a **per-`runId` `_isReasoning` TEXT bubble**. This is the model _thinking out loud_ (extended reasoning), surfaced live, and is **DISTINCT from the §5.8/§5.8c positional narration-text `thinkingSet`**: the `thinkingSet` machinery classifies ordinary assistant-`text` messages by their _position_ in a run (all-but-last = intermediate); an `_isReasoning` bubble is **explicitly tagged at ingest** from the reasoning stream and never participates in that positional logic.
- **DON'T-REGRESS invariant (the whole point of §5.8e):** `_isReasoning` messages MUST stay **out of the positional classifier**. There is an explicit **skip-guard in the classifier loop at `app.ts` (~line 6342)** that excludes any `_isReasoning` message before the all-but-last / `slice(0,-1)` reasoning-grouping math runs. They are rendered instead by a **dedicated `renderMsg` branch** that emits **`.msg-thinking` text directly** — **NOT** as a `type:"thinking"` _content block_ (renderMsg's per-block loop has **no thinking arm**; routing a reasoning bubble through a block would render nothing). Because `_isReasoning` bubbles are removed from the positional set, they **cannot perturb `slice(0,-1)`** (they will never be mistaken for "the last text = the answer", nor shift which real text message is) and **cannot reintroduce the `isCurrentRun` flicker** retired in §5.8/§5.8c (they are not part of the streaming-text temp set that the flicker math touched).
- **`_turnIncomplete` ⚠ badge (dual hook):** When a turn ends without a clean completion, the bubble carries a `_turnIncomplete` flag rendered as a `msg-incomplete-badge` ⚠ element. It is set via **two independent hooks** because the two brains signal incompleteness differently:
  1. **Model-gated end branch** — inspects `livenessState` / `stopReason` on the lifecycle end path (the embedded/native model channel).
  2. **cc-bridge sibling handler** — a `phase: "turn-incomplete"` event handler (cc-bridge does not flow the model `stopReason`, so it emits an explicit phase instead).
     Either hook independently raises the badge, so an incomplete cc-bridge turn and an incomplete native turn both get the ⚠.
- **Generic unknown-stream fallback:** A `KNOWN_STREAMS` **denylist** guards the `event:"agent"` dispatch tail: any `p.stream` not in the known set (`tool`, `lifecycle`, `thinking`, …) falls through to `renderSystemMsg` so a future/unrecognized stream is **surfaced rather than silently dropped**. To avoid flooding the chat with transient frames, this fallback is **throttled to `end`/`error` phases only** (mid-stream deltas of an unknown stream are ignored; only its terminal frame renders as a system message).
- **Relationship to §5.8 / §5.8c / §5.8d:** §5.8c routes native `type:"thinking"` _content blocks_ into per-tool intermediate temps; §5.8 segments assistant `text` across tool boundaries; §5.8d peels leading narration off a single-block cc-bridge answer. §5.8e is the **live extended-reasoning channel**: it consumes the `stream:"thinking"` agent events into a self-tagged `_isReasoning` bubble that is deliberately _fenced off_ from all three positional mechanisms, so adding live reasoning display can never regress the thinking/answer separation those sections established.
- **CSS:** `.msg.msg-thinking` (reused from §5.8 — earth-thinking texture, 12px, `#d4c4a8`), `.msg-incomplete-badge` (⚠ turn-incomplete badge)
- **Files:** `app.ts` (`stream==="thinking"` handler, `_isReasoning` accumulation + classifier skip-guard at ~6342 + dedicated `.msg-thinking` `renderMsg` branch, `_turnIncomplete` dual hook, `KNOWN_STREAMS` fallback), `extensions/tinkerclaw-cc-bridge/src/worker.ts` (`pushThinkingDelta`, `phase:"turn-incomplete"`), `embedded-agent-subscribe.ts` (`emitReasoningStream`, `reasoningMode=="stream"` gate), `base.css` (`.msg-incomplete-badge`)

### 5.8f Per-tab thinking slider (in the Models side panel)

- **Status:** `DEPLOYED` (2026-06-11) — **relocated 2026-06-11** from the chat-area strip into the Models side panel; **render-anchor corrected 2026-06-11** (now appended inline inside the FALLBACK CHAIN card after the PRIMARY model row — see Placement).
- **What — the capability:** An **8-stop thinking slider** that lets the user dial the reasoning budget for the **current tab** without opening the Sessions alt-view. The 8 stops, in order, are: **Off · Minimal · Low · Medium · Adaptive · High · xHigh · Max**. It reads/writes the **active session's `thinkingLevel`** and **follows the active tab** (its stop reflects whichever tab is selected).
- **Placement (relocated):** the slider lives in the **Models side panel** (`#budget-panel`, rendered by `updateBudgetPanel()` in `app.ts`), rendered **INLINE inside the FALLBACK CHAIN `.model-group` card, directly UNDER the PRIMARY (#1-selected) model row**. Mechanics: `updateBudgetPanel()` builds the fallback-chain card by looping the chain (`primary` + `fallbacks`); when **`i === 0`** (the primary/#1 row) it appends `renderThinkingSlider()` to the group HTML right after that row's markup, so the slider is part of the panel's initial `innerHTML` and lands immediately under the primary model. The slider carries the class token **`model-think-slider`** (the `verify:` gate asserts `app.ts` contains this string).
- **WHY the old `data-model-id` anchor approach was REMOVED:** the previous mechanic stamped a **`data-model-id`** anchor on each model row and, after the panel's `innerHTML` was set, did a `querySelector('.model-row[data-model-id="<activeModel>"]')` keyed on the **active session's `.model`** and injected the slider via **`insertAdjacentHTML("afterend", …)`**. That **never showed the slider**: a session's `.model` field is **empty until a run actually reports the resolved model**, so on a fresh/idle tab `activeModel` was falsy, the querySelector found no row, and nothing was injected. Anchoring to the deterministic **primary row inside the fallback-chain loop** (always present whenever there is a chain) removes that dependency on run-reported state.
- **REMOVED — the old chat-area strip:** the previous always-visible `.tab-think-strip` (a `.chat-area` child inserted before `.chat-input`, carrying the now-gone `tab-think-slider` token) was **deleted**. Do not re-add a chat-area strip; the slider's single home is the Models panel under the active model row.
- **Per-tab semantics / follows the active tab:** the slider's stop reflects the **active tab's session `thinkingLevel`** (read by `renderThinkingSlider()` from the viewed session), and the Models panel **re-renders on tab switch via `refreshViewedSessionIndicators()`** (which triggers `updateBudgetPanel()`), so switching tabs re-paints the fallback-chain card and re-reads the newly-active tab's level into the slider position. The slider's DOM anchor stays the **primary model row** (it does not chase the active tab's model row); only its value follows the active tab. Switching the Models panel's Session/All scope does not change which session the slider targets — it always targets the **active tab**.
- **DON'T-REGRESS invariants** (each is load-bearing — the slider was relocated _into_ machinery that punishes the obvious shortcut):
  1. **It saves via `sessions.update { thinkingLevel }` ONLY.** The save call patches **only** `thinkingLevel` (mirroring the per-row select at `app.ts` ~line 12569: `req("sessions.update", { key, patch: { thinkingLevel: value || null } })`). Any **other** session field sent from a webchat client hits the **`rejectWebchatSessionMutation`** guard (`app.ts` ~line 3899) and the whole patch is rejected — so the slider never bundles model or any other field into the same `sessions.update`.
  2. **Moving the slider applies on the NEXT message, not the in-flight turn.** The thinking budget is read **at cc-bridge worker spawn time** (see `tool-loop.md`), so changing the stop mid-turn cannot retro-budget the running turn — it takes effect on the next user message. This is intended; surface it as expected behavior, not a bug.
  3. **The slider is appended exactly once, after the PRIMARY row, by the fallback-chain loop.** `updateBudgetPanel()` appends `renderThinkingSlider()` to the FALLBACK CHAIN card's HTML only when **`i === 0`** (the primary/#1 row), so it renders under exactly one row regardless of run state. Don't gate the placement on the active session's `.model` (it is empty until a run reports it — that was the removed `data-model-id` querySelector bug), and don't append it inside the per-row helper or the configured-models loop (it would render under every model / under the wrong row).
- **Cross-references:** the budget mechanism the slider drives (where/when `thinkingLevel` is consumed at worker spawn) lives in **`tool-loop.md`**; the reasoning bubble the budget _lights up_ (the live extended-thinking `_isReasoning` stream) is **§5.8e**. The Models panel render path the slider hooks into (`updateBudgetPanel()` / `renderModelRow()`) is **§5.13a**. The per-session-row equivalent control (the `<select>` in the Sessions alt-view) is §5.13.
- **Files:** `app.ts` (`updateBudgetPanel()` fallback-chain loop appends `renderThinkingSlider()` after the PRIMARY row at `i === 0`; `renderThinkingSlider()` builds the `model-think-slider` markup from the viewed session's `thinkingLevel`; `model-think-slider` change handler; the per-tab `sessions.update { thinkingLevel }` save; `refreshViewedSessionIndicators()` → `updateBudgetPanel()` re-render on tab switch), `base.css` (slider styling)

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
  - Backend: `emitRoundStart()`, `emitRoundComplete()`, `emitToolExec()` in `attempt-hooks.ts`; wired in `attempt.ts` (round counter `_forkRoundNumber`) and `embedded-agent-subscribe.handlers.tools.ts` (tool events)
  - Frontend: `pushRoundComplete()`, `pushToolExec()` methods on `TimelineController`; handlers in `app.ts` for all 4 phases
  - Design doc: `docs/plans/2026-03-09-timeline-round-level-observability-design.md`
  - Plan: `docs/plans/2026-03-09-timeline-round-level-observability.md`
- **Legend:** Grid overlay approach — `.ct-legend-anchor` lives on the container's parent (not inside the scroll container), placed in the same grid cell (`grid-column: 1/3; grid-row: 3`) with `pointer-events: none`. Inner `.ct-legend` is `position: absolute; right: 8px; top: 4px` with `pointer-events: auto`. Never scrolls.
- **Capacity line:** `.ct-capacity-line` dashed line at 100% capacity, spans full scrollable width
- **Toggle switch CSS:** `.ct-switch`, `.ct-switch-track`, `.ct-switch-thumb`, `.ct-switch-label`
- **CSS:** `.ct-bar`, `.ct-capacity-line`, `.ct-legend-anchor`
- **Files:** `context-timeline.ts`, `app.ts` (wiring), `attempt-hooks.ts` (event emission), `attempt.ts` (round counter), `embedded-agent-subscribe.handlers.tools.ts` (tool events), `base.css`

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
- **Performance tier ranking (legacy keyword-bucket):** frontier (opus/pro-preview/o-series) → strong (sonnet/pro/gpt-4.x/gpt-5.x/gpt-4o) → balanced (flash) → balanced-low (haiku) → lightweight (mini/nano/lite). Implemented in `modelPerfRank()` for fallback when the openclaw.json `rank` field is absent.
- **Global ordering (2026-05-09 rewrite):** the in-app sort uses the **explicit `rank` field on each entry of `agents.defaults.models` in `~/.openclaw/openclaw.json`** as the primary key. Tier-bucket matching is the tiebreaker. This gives finer-grained intra-tier ordering than the legacy four-bucket scheme — e.g. gpt-5.5 (rank 1) above gpt-5.4-pro (rank 4) above gpt-5.4 (rank 8) within tier-1, instead of arbitrary insertion-order.
- **Source of truth for `rank` values:** [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/leaderboards/models) — composite score across MMLU-Pro / GPQA / AIME / HumanEval / MATH-500 / etc. AA's `/api/v2/data/llms/models` endpoint requires an API key; the rendering page is publicly scrapable via WebFetch + an LLM extraction step. **Fallback source:** [LMSYS Chatbot Arena Leaderboard](https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard) (Elo-based). Update mechanism is the `model-rank-refresh` skill — see §5.13a.

### 5.13a Model Rank Auto-Refresh (2026-05-09)

- **Status:** `DEPLOYED` (skill + cron entry; first run will fire at next 06:30 Europe/Madrid).
- **What:** Daily cron job dispatches Jarvis to invoke the `model-rank-refresh` skill at `~/.openclaw/workspace/skills/model-rank-refresh/SKILL.md`. The skill fetches the current Artificial Analysis leaderboard, maps AA model names to OpenClaw model IDs via a provider-mapping table (OpenAI → `openai/<id>`, Anthropic → `claude-code/<id>` for the subscription path, Google → `google/<id>`), updates the `rank` field on existing entries, and **auto-adds new frontier models from supported providers** that weren't yet in the config. Models from unsupported providers (Kimi, MiMo, Grok, Qwen, DeepSeek, GLM, MiniMax) are surfaced in the cron summary so the user can decide whether to add provider integration.
- **Cron:** id `model-rank-refresh`, schedule `30 6 * * * Europe/Madrid`, isolated session, payload calls `Skill model-rank-refresh`.
- **Safety rails:** never auto-flip `agents.defaults.model.primary`, never auto-edit `fallbacks`, never auto-remove existing models (drift them to bottom rank instead so the user can prune manually), never touch `auth.profiles` or `auth.order`.
- **Failure modes:** if AA is unreachable, fall back to LMSYS Arena. If both fail, log + exit nonzero, no config change. The next cron tick retries.
- **Files:** `~/.openclaw/workspace/skills/model-rank-refresh/SKILL.md` (the skill), `~/.openclaw/cron/jobs.json` (the cron entry), `~/.openclaw/openclaw.json` `agents.defaults.models[*].rank` (the data the skill writes).
- **Why a skill not a code module:** keeps the provider-mapping table editable in a markdown file (single source of truth for "AA name → OpenClaw model-id"). Adding a new provider integration = edit the table + add a routing case. No fork code change required.
- **Error badges:** Red uppercase badge scoped per-profile or per-model (never per-provider — a billing cap on opus won't bleed to sonnet/haiku rows)
- **Error row styling:** `.model-errored` applies transparent red backfill (`rgba(255,60,60,0.08)`) with faint red border, strikethrough on model name, 0.85 opacity. Immediately visible when a provider fails.
- **Error lookup chain:** `providerErrors.get(keyId)` → `providerErrors.get(modelId)` (NO bare provider fallback)
- **Health poll:** 60s interval checks `provider.health`, auto-clears error badges (provider-level, per-profile `provider:*`, and per-model `provider/*` keys)
- **Provider icons:** Inline SVGs (14px) for anthropic, google, openai, ollama, meta, mistral, deepseek
- **Scope changes:** the Session/All switch goes through `setBudgetScope()` (the single `budgetScope` mutator — see panels.md §147), which re-renders BOTH the Models panel (`updateBudgetPanel()`) and the Prefrontal panel (`updatePrefrontalTree()`). `updateBudgetPanel()` itself renders the Models panel only and does NOT call the prefrontal updater — the pre-2026-05-17 note claiming it did was stale, and that gap is exactly why scope changes never reached prefrontal.
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
- **Files:** `context-anatomy-db.ts` (compression + no prune), `context-anatomy.ts` (type extended, JSONL removed), `context-anatomy-http.ts` (limit param + raised caps), `attempt-hooks.ts` (SQLite write path), `embedded-agent-subscribe.ts` + handlers (response breakdown capture), `context-timeline.ts` (authedFetch + toggle fix + buffer safety + /recent for All mode), `app.ts` (relative URLs + auth headers), `extensions/tinker/index.ts` (decompressJson + limit support + raised hour caps)

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

### 5.43 Colored Brain Systems — AMYGDALA & FRACTAL Tags (2026-03-23, AMYGDALA tag removed 2026-06-10)

- **Status:** `FRACTAL DEPLOYED; AMYGDALA RETIRED 2026-06-10`
- **What:** System-generated messages from the FRACTAL (recursive reflection) cognitive subsystem render with a distinct colored tag in the chat — fern green (`#2ECC71`). Tags use markdown bold+italic (`***TAG***`) instead of HTML spans for cross-channel compatibility (WhatsApp, Telegram).
- **FORK 2026-06-10 (amygdala retirement):** the pink `🧠 AMYGDALA:` inline-tag styling was **removed** from `md()` in `app.ts`. The per-turn amygdala reply section is retired (the always-on Amygdala side panel is the gate-decision surface now); any residual amygdala text the model emits from session-history habit renders as plain inline prose, not a pink-highlighted line. FRACTAL green stays.
- **Detection:** Messages containing a `FRACTAL` prefix in system event text.
- **Files:** `app.ts` (renderMsg detection + `md()` green-styling), `base.css` (tag color classes)

### 5.44 WhatsApp Thinking Reaction — persona-aware heartbeat + done-separator (2026-02-18, **upgraded 2026-05-04, verified end-to-end 2026-05-09**)

- **Status:** `DEPLOYED & VERIFIED` — confirmed in DM smoke-test 2026-05-09: 🤔↔🤖 alternates while Jarvis thinks, reaction clears when the answer lands, reply starts with `🤖`, and a separate `⚡` message follows the reply.
- **What:** While processing a WhatsApp message, the bot reacts to the user's message with an **alternating heartbeat** (default `🤔` ↔ persona icon `🤖`), then clears the reaction on final delivery, then sends a separate `⚡` plain-text message as a turn-end separator. The user gets visible "still thinking" liveness, an unambiguous "done" signal, and a clean visual break before the next turn.
- **Heartbeat alternation:** `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thinking-reaction.ts` toggles between `DEFAULT_THINKING_PRIMARY_EMOJI` (🤔) and the persona icon extracted from `outbound-prefix.ts` (🤖 by default; whatever the cloner sets `channels.whatsapp.messagePrefix` to in `~/.openclaw/openclaw.json`). Same `outbound-prefix.ts` source-of-truth means changing the persona icon flows automatically into the heartbeat alternation.
- **Final clear:** when the agent run ends (success or error), the reaction is cleared by sending an empty `""` reaction — whatsmeow-node's `sendReaction(chat, sender, id, "")` removes the prior emoji. Safety-net timeout still in place if the lifecycle event is missed.
- **Done-separator:** after the last reply chunk lands, `auto-reply/deliver-reply.ts:deliverWebReply` sends `DEFAULT_DONE_SEPARATOR_MESSAGE` (`⚡`) as a separate plain text message. Configurable via `channels.whatsapp.doneSeparator` (set `""` to disable). Runs after the prefixed reply chunks so the order is always: persona-prefixed reply → ⚡ separator.
- **Cfg plumbing — important regression-class:** `sendReactionWhatsApp` requires the runtime config; the heartbeat module fetches it via `getRuntimeConfig()`. Without cfg the reaction silently no-ops — `requireRuntimeConfig` throws and the `.catch(() => {})` swallows. Any function in the WhatsApp plugin that calls `requireRuntimeConfig` must have config plumbed in or fetched at call-time; silent failure is the default.
- **Wire path — important regression-class:** reactions go through `wmClient.sendReaction(chat, sender, id, reaction)`, NOT `sendMessage({react: …})`. Baileys-shaped `{react}` payloads silently no-op at the whatsmeow wire (proto mismatch — same class as the poll bug). Routing happens in `extensions/tinkerclaw-whatsapp/src/baileys-adapter-wm.ts:sendMessage` which detects `"react" in content`.
- **Files:** `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/thinking-reaction.ts` (alternation lifecycle, final-empty clear), `extensions/tinkerclaw-whatsapp/src/auto-reply/monitor/process-message.ts` (heartbeat start/stop wiring), `extensions/tinkerclaw-whatsapp/src/auto-reply/deliver-reply.ts` (done-separator emit), `extensions/tinkerclaw-whatsapp/src/baileys-adapter-wm.ts` (reaction wire-routing), `extensions/tinkerclaw-whatsapp/src/outbound-prefix.ts` (single source for persona icon + done-separator default).
- **Diagnostic taps (still live):** `[thinking-reaction] *` and `[wm-adapter] reaction send/fail` markers — keep until the integration is stable for a week then prune.

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

### 5.65 Recipe Visual Indicators — decision-trail provenance chip + subtask line (2026-04-08, decision-trail elements 2026-06-01)

- **Status:** `DEPLOYED`
- **Owner:** prefrontal-panel visual language for recipe provenance. Renders inside the Prefrontal right-panel decision trail (`tinker-ui/src/panels/prefrontal-tree.ts`). For WHEN these paint (the `treeIdle` gate; decision trail itself is NOT idle-gated, recipe header + action trail are), see panels.md; for the producer that feeds `recipeState` / `trail` (`prefrontal-recipe-state` + trail-event WS phases), see subagents-and-recipes.md.
- **`.pf-decisions-recipe`** — the always-visible recipe-provenance chip inside the decision-trail `summary` row. Names the matched recipe + confidence + live step (`🎯 <recipe> · conf <x> · step M/N · semantic`) so the collapsed trail carries real information instead of just "N decisions · <prose>". Gold (`var(--gold, #d8b25a)`), `font-weight:600`, `flex-shrink:0` (never compresses), `white-space:nowrap`, `font-variant-numeric:tabular-nums`. Built by `buildProvenanceChip()` walking recent `matched/merged/composed` decisions newest-first for the first structured `recipeId/confidence`, falling back to the live recipe header id. `recipe-apply/reject/supersede` are evolution events and deliberately do NOT relabel the chip.
- **`.pf-decisions-latest`** — the "<icon> <label> · <message>" tail of the same summary row. Given `flex:1; min-width:0` (2026-06-01) so it ellipsises beside the `flex-shrink:0` provenance chip instead of pushing it out.
- **`.pf-subtask`** — the per-subagent `↳ <task>` sub-line rendered above `.pf-vitals` (the vitals line is owned by §5.12's `.pf-*` registry). Carries `node.summary` (the subagent's task text). `10.5px`, `opacity:.82`, single-line ellipsis (`white-space:nowrap; text-overflow:ellipsis`), full text on hover via the `title` attribute. Only rendered for non-root nodes when `summary` is present and differs from the row label.
- **Decision-trail icons (`TRAIL_ICON_BY_KIND` in prefrontal-tree.ts):** the autonomous recipe-evolution kinds added 2026-05-31 map to `♻` (`recipe-apply` — Jarvis rewrote one of its own recipes at consolidation), `⊘` (`recipe-reject` — declined a proposed rewrite), `⇄` (`recipe-supersede` — superseded a contradicting memory chunk). These make the unsupervised self-edit loop legible in the panel instead of RPC-only; they appear in both the collapsed-summary `.pf-decisions-latest` line and the expanded `.pf-decision-row` list.
- **Files:** `tinker-ui/src/panels/prefrontal-tree.ts` (`renderDecisionTrail`, `buildProvenanceChip`, `TRAIL_ICON_BY_KIND`, `.pf-subtask` in `renderNodeRecursive`), `tinker-ui/src/styles/base.css` (`.pf-decisions-recipe`, `.pf-decisions-latest`, `.pf-subtask`).

### 5.66 **SYS_PLAN_RESUME** chip family (2026-05-13)

- **Status:** `DEPLOYED`
- **What:** A grey system chip injected into the chat timeline when the gateway boots and resumes an in-progress plan. Signals to the user that Jarvis is autonomously picking up where it left off.
- **Trigger:** `chat.inject` call from `prefrontal.runRestartContinue()` with sentinel string `__SYS_PLAN_RESUME__:<label>`.
- **CSS class:** `.chip-sys-plan-resume`
- **Visual style:** Grey background (similar to `.chip-sys` but distinct from the orange `__ERR_ENV__` restart chip). Renders under the orange restart chip in the same timeline position when both are present.
- **Sentinel format:** `__SYS_PLAN_RESUME__:Resuming step N: <step title>`
- **Rendering:** Parsed in `app.ts` alongside `__ERR_ENV__` detection. The label after the colon is displayed as the chip's body text.
- **See also:** flows.md F-PLAN-RESUME; lifecycles.md L-PLAN.

### 5.67 "Current Plan" section in prefrontal-tree.ts panel (2026-05-13, idle-blank 2026-05-23)

- **Status:** `DEPLOYED`
- **What:** The Prefrontal right-panel (`tinker-ui/src/panels/prefrontal-tree.ts`) shows a "Current Plan" section when a plan is active for the current session.
- **Layout:**
  - **Header row:** plan `intent` (truncated to 60 chars) + total elapsed since plan creation
  - **Kit-source row:** shown only when `kitRef` is set — displays the kit origin (e.g., `from globalcaos/feature`)
  - **Per-step rows:** for each step in the plan:
    - Step marker: `●` pending, `▶` in_progress, `✓` done, `✗` error
    - Step title
    - Journal note (if present) — shown in muted text below the title
    - Per-step elapsed (only for done/in_progress steps)
  - **Progress bar:** anchored below the step list showing `done / total` steps
- **Data source:** `prefrontal.plan.get({ sessionKey })` polled at 3s interval while a plan is active
- **Idle-blank for verbose state (commit `fab44c7579`, 2026-05-23):** `render()` derives `treeIdle = !tree.active || !tree.root` and gates the **recipe header** + **action trail** behind `!treeIdle`. When the last subagent completes and the tree returns to "No active LLM calls", the recipe header + accumulated trail fold away. The plan section stays — it's a persistent task tracker per `panels.md` always-on contract, not an in-flight indicator. Recipe + trail state stay in memory for the next job's resumption; the UI just stops painting them. Without this gate the panel kept looking verbose for hours after work ended.
- **Files:** `tinker-ui/src/panels/prefrontal-tree.ts` (renderPlanSection, treeIdle gate), `tinker-ui/src/styles/base.css` (`.plan-step-row`, `.chip-sys-plan-resume`)

### 5.68 Today card / Exec panel — Control Panel surface (2026-05-22/23)

- **Status:** `DEPLOYED` (v3.5 of the control-panel plugin)
- **Surface:** `#exec-panel` HUD on the left side of Tinker UI when the Dev/Exec topbar toggle is set to Exec. Primary task interface; replaced Todoist 2026-05-11 (bible §14 / `project_control_panel_plugin` memory).
- **Data store:** `extensions/tinkerclaw-control-panel/` SQLite, plugin v3.5. See `config-shape.md` for the `task_axis` / `task` schema, and `topology.md` for the plugin entry.
- **Hierarchy render — 2-level tree (commit `a4cec8e517`):** `renderExecGroups` builds a 2-level tree from `axes.list` (top-level groups + sub-groups via `task_axis.parent_id`). Top-level groups are collapsible sections; sub-groups render indented inside their parent with their own count chip and affordances. Collapsed state of each group/sub-group persists in `localStorage` (existing `.exec-group-collapsed` pattern). Empty sub-groups still render so tasks can be dragged into them.
- **+ buttons (commits `a102c80509`, `371fe91e6e`, `67b0ab5e9a`):**
  - **`+ Add group`** chip at the panel top → inline form → `control-panel.axes.add {parent_id:null}`.
  - **`+ Add sub-group`** affordance inside each top-level group header → inline form → `axes.add {parent_id:<group.id>}`.
  - **Per-group `+` Add task** button on each (sub-)group header (replaced the pre-v3.5 single bottom form so the user creates tasks in context).
- **Group-level affordances:** ✏️ inline rename on the group header (commit `69c1b35d2d`, double-click or pencil) and 🗑 delete-when-empty (commit `43259f4976`, faint-on-hover; refuses to delete a group that still has open tasks or sub-groups).
- **Drawer simplification (commits `d08cd06ca9`, `13eb379d70`, `d1a0a8c340`, `ac97f46189`, `7575564e62`, `b7d5195fa6`, `f9880c893b`, `50595032d1`):**
  - **Checkbox at the collapsed-head left edge** (18px round) replaces the drawer's Resolve + Start buttons. Click toggles `status` open ↔ resolved. `in_progress` is reserved for system-set state (Jarvis can set it via `control-panel.tasks.update` when an agent is actively working on it); no manual drawer affordance.
  - **Title wraps in place** in the head when the card is expanded — the old duplicate `.exec-task-fulltitle` block in the drawer is gone. The head pencil hides when expanded because the drawer carries an inline-pencil that covers it.
  - **Drawer block order**: title → due+est meta row (clickable inline edit) → context body (inline-edit `<textarea>`, Ctrl+Enter saves) → metadata strip → actions (Reschedule / Snooze-or-Bring-back / Delete / Refer in chat). The old popup editors are gone — title and body both edit in-place.
  - **Todoist surface dropped:** entire `m.todoist_*` chip render block removed (commit `13eb379d70`). Paired with the `stripTodoistMetadata` one-shot migration (see `config-shape.md` + `failures.md`).
- **Dropped/dismissed are unconditionally invisible (commit `2a34dae51c`):** the `Deleted` filter chip is gone; tasks with `status='dropped'` or `'dismissed'` never appear in any filter view. Recovery is RPC-only.
- **Pointer-event drag-and-drop (commits `5312227ebf` → `f1a5d0dc37`, `7b91d26a6a`, `ce1da137bf`, `c0ebbf6b8b`):** HTML5 native DnD was deleted entirely (commit `9e3513a13b`) and replaced with a custom pointer-event implementation. No external library.
  - **Trigger surface:** pointerdown anywhere on `.exec-task-head` (tasks), `.exec-group-header` or `.exec-subgroup-header` (categories). Interactive children (buttons, chips, `<input>`, `<textarea>`) are excluded so clicks on the checkbox / pencil / + don't start a drag. The visible `⋮⋮` grip is replaced by `cursor: grab` on the whole row (grip is now a 6px invisible hit-target inherited from the prior implementation; pointerdown surface was widened to the row).
  - **Click vs drag:** `DRAG_START_THRESHOLD_PX = 4` separates a click (expand/collapse-toggle fired manually in pointerup) from a drag (commit via RPC on drop). Without this threshold the DnD takeover silently stole every click on the row.
  - **Lifecycle:** pointerdown → state captured → pointermove (document-level) updates a `position:fixed` ghost clone + a 2px `var(--accent)` drop indicator → pointerup commits via parallel `tasks.update` RPCs (see rank renumber below) → pointercancel or Esc aborts cleanly (no RPC). `pointercancel` covers OS-level interruptions (alt-tab, Esc, focus loss).
  - **Auto-scroll:** when the cursor is within 60px of the top or bottom of `#exec-tasks-body`, the container auto-scrolls at a speed proportional to edge proximity.
  - **Cross-group drops** reassign `priority_axis` to the destination group/sub-group's id. Drop on the source itself is a no-op (silent cancel — no RPC).
- **Rank-renumber-on-drop (commit `76df31f68d`, extended to groups + walk-ordering hardened `912922950a` + `ffbc4cb5cc`):** `priority_rank` AND `task_axis.position` are both `INTEGER` in the schema. The old midpoint arithmetic `(prevRank + nextRank) / 2` compressed adjacent ranks to identical values over multiple reorders — live data had 21 tasks at `rank=30` and 17 at `rank=40` in `ventures` before the task-side fix; the same collision class hit group reorder until `912922950a` mirrored the pattern to `axes.update`. On every drop the client walks the destination axis (or group container) in DOM order treating the indicator as the dragged element's new slot, skipping `.exec-task-source` / `.exec-group-source`, then fires parallel `tasks.update {priority_rank:(i+1)*100}` / `axes.update {position:(i+1)*100}` RPCs for every peer. Strategy: "fresh ranks on every move." Schema stays `INTEGER`; spacing 100 leaves headroom. ~50 tasks renumber in well under a second. See `failures.md` M11.
  - **Architectural ordering invariant (commit `ffbc4cb5cc`, **don't regress**):** the pointerup commit handler MUST walk the destination subtree BEFORE removing `drag.indicator` or stripping `.exec-task-source` / `.exec-group-source` from the source row. The walk depends on the indicator (to slot `drag.id` at the new position) AND on the source-class marker (to skip the source row at its OLD position). Stripping either FIRST was the cause of the recurrent "always lands at end" bug: the walk found zero indicator hits → `insertedSource` stayed false → the trailing `if (!insertedSource) push(drag.id)` fallback pushed drag.id at end → meanwhile the source row (now unmarked) was pushed at its old slot → drag.id appeared TWICE in `orderedIds` → the higher-index RPC won the rank race on the server. The "push at end" fallback is also GONE — indicator-not-found now logs a `console.warn` and bails; silent fallbacks were what hid the bug across two prior fix commits. See `failures.md` M11 and `[[feedback_walk_before_teardown]]` in jarvis-icu memory.
  - **Indicator placement uses HEAD bounding rect (commit `912922950a`):** the pointermove drop-indicator midpoint test reads `:scope > .exec-task-head` bounding rect, NOT the outer `.exec-task` rect. With an expanded card (~200px tall including drawer), using the outer rect put the midpoint deep inside the drawer and made indicator placement disagree with cursor position. The head is consistent ~32px regardless of expand state.
  - **Source-row hover doesn't move the indicator:** if `closest('.exec-task:not(.exec-task-source)')` returns null because the cursor is over the source row, the pointermove handler explicitly returns instead of falling through to the subgroup/group fallback. Prior behaviour appended the indicator to the bottom of the enclosing group every time the cursor crossed the source row, producing "I dropped here but it went to the bottom" reports. The subgroup/group fallback now only fires when that container is genuinely EMPTY (no `.exec-task` children other than the source).
  - **Post-drag click suppression (`912922950a`):** the browser still fires a synthetic `click` on the source row after pointerup despite `preventDefault()` in pointerdown — `setPointerCapture` + DOM mutations during the drag bypass the usual suppression. Stamp `execLastDragEndAt = Date.now()` in the drag branch of pointerup (not the click branch); both the row's expand-toggle handler AND the group's collapse-toggle handler ignore clicks within `EXEC_POST_DRAG_CLICK_SUPPRESS_MS = 300`. Without this, every drag-to-new-group landed with the dragged task expanded ("it expands upon landing").
- **Expanded card — dark brown + yellow ring + horizontal inset (commits `912922950a` → `2f9a6fe367` → `16d2713246`):** `.exec-task-expanded` background is `#4a3826` (clear brown, lifted from prior `#3a2e26` which read too light). Drawer is `#3e2e1e` (hairline darker so the head/drawer boundary stays visible). `.exec-task-expanded .exec-task-head` carries an explicit matching `#4a3826` bg so the title row doesn't inherit the row's base shade and show as a lighter band above the drawer. Ring is a `box-shadow: 0 0 0 2px #d4a84a` gold halo (not `outline:` — `outline` cannot honor `border-radius` cross-browser). `margin-left/right: 8px` inset so the ring renders cleanly on the left + right edges instead of being clipped against `#exec-tasks-body`'s inner edge / scrollbar. Collapsed rows are unaffected (rule scoped to `.exec-task-expanded`), so collapse/expand has no jolt.
- **Task duration in decimal hours (commit `5449a3a60e`):** `est_minutes` column stays INTEGER (storage unchanged; per `[[feedback_minimal_blast_radius_collapse]]`). UI converts at the display + input boundary via `formatEstHoursValue(minutes)` (= `(minutes/60).toFixed(2)` with trailing-zero trim — `60 → "1h"`, `30 → "0.5h"`, `6 → "0.1h"`, `45 → "0.75h"`). Chip + tooltip + reschedule-picker EVENTS/TASKS totals all surface as hours. Inline editor is `<input type="number" step="0.1">` and rounds via `Math.round(hours * 60)` so 0.1h stores cleanly as 6 minutes. Backward-compatible: every existing task surfaces unchanged in the new unit on next render.
- **Inline-edit refresh-suppression (commit `de2002d2eb`):** the 10s exec-panel poll skips its DOM rebuild when `document.activeElement` is an `<input>` or `<textarea>` inside `#exec-panel`. Without this guard the textarea/input would be wiped out of the DOM mid-edit, losing in-progress typing.
- **Layout fixes (commits `a68132b180`, `747cffb4cb`, `3f5b3a1fc6`, `54268a94d4`, `50595032d1`):**
  - **Logo z-index 50 → 70** so it renders above the exec-mode HUD panel (which lives at z-index 60).
  - **Topbar `min-width: 0`** so the topbar grid item can shrink below its content's min-content — many tabs no longer steal width from the right panel.
  - **Chrome-style tab strip on its own row**: `.tab` uses `flex: 0 1 auto; min-width: 64px; max-width: 200px` so tabs shrink uniformly before the ◀▶ scroll arrows appear.
- **EXEC_AXIS_ORDER / EXEC_AXIS_LABEL deleted (commit `839b7cc5ab`)** — the live `axes.list` tree is now the single source of truth; the old hardcoded constants are gone (superseded by v3.3 axis taxonomy, fully obsolete with v3.5 hierarchy).
- **Files:** `tinker-ui/src/app.ts` (`renderExecGroups`, pointer-event DnD handlers, rank-renumber, inline-edit handlers), `tinker-ui/src/styles/base.css` (sub-group indent, expanded-task warm-brown background, `.exec-task-source` fade, `.exec-drag-ghost`, `.exec-add-group-form` / `.exec-add-subgroup-form`), `extensions/tinkerclaw-control-panel/` (schema + axes + tasks + gateway, plugin v3.5).
- **Spec:** `~/src/jarvis-icu/docs/superpowers/specs/2026-05-22-today-card-redesign-design.md`.

### 5.69 Sessions list — server-resolver hardening + client-side resolution order (2026-05-23)

- **Status:** `DEPLOYED` (commits `cd0ad59239`, `c438842cef`, `54268a94d4`)
- **What:** Two-part fix for the right-panel sessions list rendering "Tinker UI" as every session's label. The Tinker UI WS-client identifies itself with `client.displayName = "Tinker UI"` at connect time (`tinker-ui/src/app.ts:1211`) for pairing + security audit; that string was inheriting into every chat-originated session's `origin.label`, and the displayName resolver was falling through to it.
- **Server-side filter (`src/gateway/session-utils.ts:1271-1285`):** new `GENERIC_WS_CLIENT_LABELS = {"Tinker UI", "webchat-ui", "openclaw-cli"}` set. Both `entry.displayName` and `origin.label` are filtered through it before participating in the displayName resolution chain. Meaningful origin labels (e.g. `"jarvis-inject"`, group titles via `buildGroupDisplayName`) pass through unchanged.
- **Client-side resolution order (`renderSessionRow`):**
  1. `tab.title` (persisted localStorage — "Main" for tab-main, Gemini-generated titles for sub-tabs). Lookup uses `sessionKeyMatches` for prefix-tolerant matching since pre-canonicalised `tinker:xxx` may match server's `agent:main:tinker:xxx`.
  2. `s.label` (server label, generic-filtered)
  3. `s.displayName` (server displayName, generic-filtered)
  4. `shortLabel` (key-derived synthetic fallback)
- **Defensive client-side mirror:** the same `GENERIC_WS_CLIENT_LABELS` set is mirrored client-side as a backstop via `meaningfulSessionLabel(s)` (returns `undefined` when input is in the generic set), so even if persisted server data still carries "Tinker UI", rendering falls to `shortLabel`. **Keep the server-side and client-side sets in lockstep** when either side changes.
- **Verified live:** 6 sessions that previously resolved to `displayName="Tinker UI"` now resolve to `displayName=""`; new `chat.send`-originated sessions inherit the same fix automatically.
- **Files:** `src/gateway/session-utils.ts` (server filter), `tinker-ui/src/app.ts` (client resolver + mirror set).

### 5.70 Tab name summary — right-click rename + recency-weighted auto-name (2026-06-04)

- **Status:** `DEPLOYED-UNTESTED` (HMR-live in `tinker-ui/src/app.ts`, uncommitted; entangled with parallel WIP in the same file)
- **What the user sees:** Right-clicking any non-Main tab opens a small context menu (reuses the `.exec-context-menu` styling) with two actions:
  - **Rename…** — a floating manual-rename input pops over the tab; the user types a title and it sticks (persisted as the tab's `tab.title`, the highest-priority label per §5.69's resolution order).
  - **Auto-name** — fires the existing Ollama `generateTabTitle` to summarise the conversation into a short tab label. It is now **recency-weighted**: the newest turn gets a 500-char budget vs 150 for older turns, and the prompt explicitly asks for the _current_ topic (a long-running tab may have drifted off its original subject). Auto-generated titles are prefixed with the distinct `AUTO_NAME_ICON` sentinel **🏷️** so an auto-name reads differently from a hand-typed one at a glance.
- **Main tab excluded:** the Main tab has no context menu / no auto-name — its title is force-restored to "Main" (it is the one tab whose label must stay stable).
- **Unified path:** the periodic background auto-titler now goes through the same code path + 🏷️ icon as the manual "Auto-name" action, so a tab named by the timer and a tab named by the menu look identical.
- **How it's used:** rename a tab to pin a meaningful label you chose; or hit Auto-name to let Ollama re-summarise after the conversation has moved on. The 🏷️ prefix tells you a label came from the model, not from you.
- **See also:** §5.69 (sessions-list label resolution order — `tab.title` is rank 1); panels.md (Sessions panel render). Task `task-mpzcjw6n`.
- **Files:** `tinker-ui/src/app.ts` (tab context menu reusing `.exec-context-menu`, floating rename input, `generateTabTitle` recency weighting, `AUTO_NAME_ICON`, Main-tab exclusion + force-restore, periodic-titler unification).

### 5.71 Binary chat thinking indicator — one consolidated busy row (2026-06-04)

- **Status:** `DEPLOYED-UNTESTED` (HMR-live in `tinker-ui/src/app.ts`, uncommitted)
- **What the user sees:** the chat thinking indicator is now **binary** — a single consolidated row when the _viewed_ session is busy, instead of one row per active run (main + each subagent). The old per-run rendering was the "multiple indicators at once" complaint: a turn that spawned subagents stacked several bouncing-dot rows in the chat.
- **Subagent count:** when subagents are running, their number shows as a small **`▸N`** badge on the single row rather than as extra rows. The per-run / per-subagent breakdown is NOT shown in chat anymore — it lives only in the **RECIPES panel** (and in the collapsible subagent chat bubbles).
- **Stop:** one Stop button is correct — it already called the session-level `abort()`, which stops the whole run (main + its subagents) at once.
- **How it's used:** glance at the chat to know "Jarvis is busy / idle" without parsing N rows; open the RECIPES panel when you actually want to see which subagent is doing what.
- **See also:** §5.7 / §5.7.1 (thinking-indicator base behaviour + restart continuity); panels.md (RECIPES / prefrontal panel = where the per-run breakdown now lives); done-signals.md (which signal is authoritative for "busy"). Task `task-mpzgsvbo` (chat-binary part).
- **Files:** `tinker-ui/src/app.ts` (`renderThinkingIndicator` consolidated-row + `▸N` subagent badge).

### 5.72 Answer/amygdala/fractal bubble rendered as FINAL by structure (2026-06-04)

- **Status:** `DEPLOYED-UNTESTED` (HMR-live in `tinker-ui/src/app.ts`, uncommitted)
- **What the user sees:** a completed reply that carries the three-section answer / amygdala / fractal structure now always renders as a proper **final answer** bubble — even if it landed in a non-final stream slot. Previously such a bubble could show up as a plain thinking bubble with the raw section markers visible, because the splitter (`splitSectionedReply`) was gated behind `!isThinking` (a POSITION-based test): a structured reply that didn't occupy the last slot was never split.
- **Why it changed:** appearance is now decided by **structure, not position** — `splitSectionedReply` runs unconditionally at both `renderMsg` detection sites. Because the check is content-local, it cannot reintroduce the earlier "blinking" class flicker.
- **How it's used:** nothing to do — structured replies just look right (clean answer + collapsed fractal section) regardless of where in the stream they finalised. **(2026-06-10: amygdala is no longer a recognised section — see §5.74.)**
- **See also:** §5.8 / §5.8c (thinking-vs-final classification); §5.74 (amygdala section retired); bug-log.md (root cause of the raw-markers-in-a-thinking-bubble regression). Task `task-mpwf4x8s`.
- **Files:** `tinker-ui/src/sectioned-reply.ts` (`splitSectionedReply` run unconditionally at both `renderMsg` detection sites; extracted from `app.ts` 2026-06-10).

### 5.74 Amygdala per-turn reply section RETIRED — UI no longer compacts (or fabricates) it (2026-06-10)

- **Status:** `DEPLOYED` (vite build + gateway restart) — split/render logic extracted to a unit-tested module.
- **What the user sees:** the per-turn `🧠 AMYGDALA` "gut read" bubble is **gone**. The chat no longer renders a collapsed `🧠` reasoning block, and — critically — no longer **fabricates** one out of pre-answer narration. The per-turn reply is just `💬 ANSWER` (expanded, inline) → `🌿 FRACTAL` (collapsed). The Amygdala lives only in the always-on right-rail side panel (live gate-decision stream) now.
- **Two root causes fixed (both in the UI, the only place that still touched amygdala):** (1) the splitter still recognised a `🧠/🫀 AMYGDALA` marker and carved a collapsed `<details class="msg msg-amygdala">` block; (2) `renderSectionedReply` **fabricated** an amygdala block from `sec.other` (pre-answer narration) whenever ANY marker (answer OR fractal) was present — so even an amygdala-free reply with one leading sentence got a phantom collapsed `🧠` block. Both removed. (The produce-side was already clean: per-turn injection asks only `💬 ANSWER → 🌿 FRACTAL`; `worker.ts` PROMPT_FILES dropped amygdala-prompt.md; live SOUL.md + fractal-prompt clean. Residual emissions are claude-cli `--resume` session-history habit, which decays.)
- **New behaviour:** `splitSectionedReply` recognises only `💬 ANSWER` / `🌿 FRACTAL`. A residual `🧠 AMYGDALA` header the model still emits falls into `other`/answer and folds **inline** into the ANSWER bubble; the bare marker line is scrubbed by `scrubResidualSectionMarkers` so it reads as clean prose — no `🧠` label, no collapsed block. (Per Oscar 2026-06-10: show inline as plain text, lossless — the habit fades over new turns.)
- **Don't-regress:** keep the `🌿 FRACTAL` split + collapsed `<details class="fractal-details">` render intact; keep the live `#amygdala-panel` side panel + `amygdala.feed` RPC + `amygdala-scope-toggle`; keep `reconstructInjectionFields`'s `"Structure this turn's reply as labelled sections"` sentinel (the live ANSWER→FRACTAL injection still emits it). Do NOT re-add a `🧠` marker to the splitter or a `msg-amygdala` emitter.
- **Files:** `tinker-ui/src/sectioned-reply.ts` (NEW — pure, `md`/`esc` injected), `tinker-ui/src/sectioned-reply.test.ts` (NEW — 10 cases incl. the two regression bugs above), `tinker-ui/src/app.ts` (imports the module; twin call sites; removed pink `🧠 AMYGDALA:` styling + dead `InjectToggles.amygdala`), `extensions/tinkerclaw-cc-bridge/personas/jarvis-default.md` (dropped `🧠` from the marker list), **deleted** `extensions/tinkerclaw-learned-intuition/amygdala-prompt.md` (orphaned).

### 5.73 Queued prompts render as a trailing "queued" bubble (2026-06-04)

- **Status:** `DEPLOYED-UNTESTED` (HMR-live in `tinker-ui/src/app.ts`, uncommitted)
- **What the user sees:** if you send a new prompt while Jarvis is still answering, your queued message now shows as a **trailing "queued" bubble** at the very bottom of the transcript and stays there until the current turn finishes — then it flushes into the transcript in correct chronological order (after the full answer). Previously the queued user bubble was pushed straight into `messages[]`, so the still-streaming turn's own continuation/tool bubbles landed _after_ it — the queued prompt appeared "in the middle of the last answer" until a hard refresh re-fetched the correct server order.
- **Mechanism (user-relevant):** the queued bubble is held in a separate `pendingQueuedSends` buffer (OUT of `messages[]`) and rendered as a trailing bubble; on turn-final it's flushed into `messages[]`.
- **Mid-turn steer/blend — IMPLEMENTED (FORK P4, 2026-06-10):** for a cc-bridge session, a message sent while a turn is in flight now **folds into the current answer** instead of running as a separate next turn. The steer dispatch (`runs.ts flushSteerBuffer`) routes through the in-flight-steer hook → `worker.steer()` writes the message to the live `claude` subprocess's stdin, which drains it between its internal tool rounds (verified: `claude -p --input-format stream-json` consumes mid-turn user lines). Only when there is NO live worker (between turns) does it fall back to the pi-agent-core steeringQueue → next-turn `worker.send` (the old behaviour). The two paths are mutually exclusive (no double-delivery). See `tool-loop.md` (the cc-bridge in-flight-steer owner) + `inflight-steer-hook.ts` / `inflight-worker-registry.ts`.
- **See also:** flows.md / tool-loop.md (cc-bridge turnQueue / drainQueue = next-turn semantics, NOT mid-turn steer); bug-log.md (the "queued prompt in the middle of the answer" root cause). Task `task-mpwfiot2`.
- **Files:** `tinker-ui/src/app.ts` (`pendingQueuedSends` buffer, trailing-bubble render, flush-on-turn-final).

### 5.74 Background tabs hydrate proactively on connect (2026-06-04)

- **Status:** `DEPLOYED-UNTESTED` (HMR-live in `tinker-ui/src/app.ts`, uncommitted)
- **What the user sees:** restored background tabs now have their transcripts ready immediately — switching to a previously-attached tab shows the conversation right away instead of being momentarily empty. Previously tabs were born empty (`freshTabState` → `messages: []`) and only the _active_ tab's transcript was fetched on connect; a background tab only hydrated on `switchToTab → loadChat`, so the first switch to it flashed blank while it loaded.
- **Mechanism (user-relevant):** a new `hydrateTab()` proactively fetches each restored attached tab's `chat.history` into its OWN `TabState` at connect time, batched via `Promise.allSettled` so one slow/failed tab doesn't block the others.
- **How it's used:** nothing to do — multi-tab workspaces feel instant on reconnect / page reload.
- **See also:** §5.5 (tab/session lifecycle + detach), §5.69 (per-tab `tab.title`). Task `task-mppceqsu`.
- **Files:** `tinker-ui/src/app.ts` (`hydrateTab`, `Promise.allSettled` fan-out on connect).

### 5.75 BROCA recipe visibility — skill-token highlighting + clickable recipe titles + recipe page (2026-06-06)

- **Status:** MIXED. `DEPLOYED` (committed develop, HMR-live): the theme token + `broca.ts` render module + RECIPES-panel skill coloring (`35f46d2`, `4825c74`, `041e3e7`). `DEPLOYED-UNTESTED` (HMR-live in `app.ts`/`prefrontal-tree.ts`, **uncommitted** — recovery patch jarvis-icu `9fe305a`): clickable recipe titles + the `recipe-detail` page + per-tab draft persistence + panel recipe-link. `TBD`: the live "this-prompt" composition panel (needs the server `recipe.read` deployed on a clean build).
- **Goal:** make the user aware Jarvis is composing recipes on the fly with the **BROCA** recipe-programming system — a colored skill name reads as a _token in a BROCA program_; a recipe title is a doorway into that program.
- **What the user sees:** (1) skill names render in a distinct, swappable color (yellow now) wherever the system STRUCTURALLY names them — RECIPES panel, the chat recipe banner, recipe-tab cards. (2) recipe titles are clickable → a dedicated single-recipe **page** rendering the recipe as interleaved code + prose. (3) (planned) the RECIPES panel shows THIS prompt's composition live with the current step highlighted.
- **Mechanism:** one CSS variable `--skill-highlight` (+ `--skill-highlight-dim`) in `styles/base.css` drives `.broca-skill` / `.broca-recipe-link` / `.broca-kw`. A pure render module `tinker-ui/src/panels/broca.ts` (`renderBrocaProgram`, `colorSkillTokens`, types `BrocaRecipe`/`BrocaStep`) does the rendering. `colorSkillTokens` is **structured-only** — it wraps a label ONLY when it exactly matches a known skill id (no prose matching → no false positives). The recipe page calls `prefrontal.recipe.read` and degrades to the recipe-list metadata until that RPC is deployed.
- **See also:** `subagents-and-recipes.md` (the `prefrontal.recipe.read` RPC + `turnId`/`skillId` composition events that feed this), `session-naming.md` (tab-title persistence interplay), `bug-log.md` (the draft + tab-name fixes shipped alongside). Spec/plan: jarvis-icu `docs/superpowers/{specs,plans}/2026-06-06-broca-recipe-visibility*`.
- **Files:** `tinker-ui/src/styles/base.css` (`--skill-highlight*`, `.broca-*`), `tinker-ui/src/panels/broca.ts` (+ `broca.test.ts`, 10/10 green), `tinker-ui/src/panels/prefrontal-tree.ts` (`colorSkillTokens` on node/trail labels + recipe-name link), `tinker-ui/src/app.ts` (`recipe-detail` AltTab, `renderRecipeDetail`, `[data-recipe-ref]` click delegation, recipe-card link).
- **Don't regress:** keep `colorSkillTokens` STRUCTURED-only — never regex skill names out of free chat prose (the deliberate decision; prose matching false-positives on common words like "verify"). The color is a single variable — keep it a `var(--skill-highlight)`, never hard-code yellow.

## Generated FORK registry

<!-- BEGIN GENERATED-FORK-REGISTRY -->

> Auto-generated by `scripts/gen-tinker-ui-registry.mjs`. Do not hand-edit between the markers below.

Files with at least one `// FORK YYYY-MM-DD:` anchor — sorted by most-recent edit. Total anchors: **95** across **3** files.

| File                            | Anchors | First      | Last       |
| ------------------------------- | ------- | ---------- | ---------- |
| `src/app.ts`                    | 75      | 2026-04-17 | 2026-05-11 |
| `src/styles/base.css`           | 18      | 2026-04-17 | 2026-05-11 |
| `src/panels/prefrontal-tree.ts` | 2       | 2026-04-20 | 2026-04-27 |

<!-- END GENERATED-FORK-REGISTRY -->
