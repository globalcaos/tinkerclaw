# tinkerclaw-control-panel — Plugin Spec

**Status:** Spec v3.1 — implementation pending
**Author:** Jarvis (Opus 4.7) for Oscar
**Last revised:** 2026-05-12 (v3.3 — `back_burner` status: indefinite snooze that hides tasks from every filter except the new `💤 Snoozed` chip while keeping them in their axis; `task_axis` + `task_est_preset` taxonomy tables replace the prior hardcoded `EXEC_AXIS_ORDER` JS constant and free-numeric `est_minutes` input — user can add/edit/delete/reorder categories and estimation presets via the new `control-panel.axes.*` and `control-panel.est-presets.*` gateway RPCs. Settings overlay UI for inline taxonomy management is scheduled (RPCs ship first so Jarvis can mutate via tool call in the meantime).)
**Previous:** 2026-05-12 (v3.2 — reschedule overlay scrolls vertically past the initial 2-week window, soft-cap 12 weeks ahead; `due_date` hidden from collapsed task row, surfaced as a colored `📅 Due …` header at the top of the expanded card with a `[change]` shortcut to the reschedule picker)
**Previous:** 2026-05-11 (v3.1 — task board refinement: dismiss-vs-drop, expandable context, all/unfinished filter + progress indicator anchored to the briefing pass, reschedule to another day, and a 7-day calendar strip between graphs and tasks)

This is the buildable contract for the **Control Panel** plugin. The user-facing concept is "Control Panel" — a tailored dashboard of life-and-system metrics plus a live task board, surfaced two ways: inline graphs between markdown blocks in any chat output, AND a persistent left-panel HUD in **Exec mode** that keeps state visible while you work.

The plugin replaces ad-hoc prose tables in the morning briefing and elsewhere with graph-first rendering wherever the data has a time-series shape, AND replaces the "scroll back to find what's open" pattern with an always-visible task list that updates as we resolve things in conversation — with proper personal-efficiency affordances: dismiss-on-disagreement, reschedule-to-a-better-day, expandable-on-click context, and progress against the briefing's original set.

---

## 0. Stack decision (carried from v2)

Pure Node + `better-sqlite3` + in-house SVG renderers + `uPlot` for client-side time-series. No Grafana, no Docker, no Prometheus, no external service of any kind. Inline graphs are SVG strings emitted directly into the markdown stream. ~3 MB resident footprint, updates with the fork.

Auth is zero-step: the plugin runs in-process with the gateway, owns its SQLite store, never opens an outbound port.

---

## 0a. Dev vs Exec mode (NEW in v3)

Tinker UI gains a **mode toggle** in the top bar — a button switches between two layouts:

| Mode                      | Right panel                                           | Left panel                                        | Use when                                                                  |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| **Dev** (current default) | Prefrontal tree + Control Panel tab + other dev tools | Hidden                                            | Building/debugging the system itself; orchestration mechanics matter      |
| **Exec** (new)            | Hidden or collapsed                                   | **Control Panel HUD** (graphs + calendar + tasks) | Working on real life issues; want persistent state visible while chatting |

The toggle persists in `localStorage` and the user's Tinker UI session state so reloads stay in mode. Default = Dev for backwards compatibility; users opt into Exec via the button or a preference setting.

### Exec mode layout (v3.1 — adds calendar strip)

```
┌──┬──────────────────────────────────┬────────────────────┐
│  │   EXEC LEFT PANEL (~360px wide)  │                    │
│U │  ┌────────────────────────────┐  │                    │
│P │  │  GRAPHS (top ~40%)          │  │                    │
│S │  │  ─ traffic-light strip      │  │                    │
│T │  │  ─ 4–6 small panels grid    │  │      CHAT          │
│R │  ├────────────────────────────┤  │                    │
│E │  │  📅 CALENDAR STRIP (~10%)   │  │                    │
│A │  │  Mon Tue Wed Thu Fri Sat Sun│  │  (full chat width  │
│M │  │  ░░░ ░░░ ▓▓▓ ░ ░░  ─ ░     │  │  minus left panel) │
│  │  ├────────────────────────────┤  │                    │
│I │  │  TASKS (bottom ~50%, MD)    │  │                    │
│C │  │  ─ filter chips + progress  │  │                    │
│O │  │    [All 8/12] [Unfinished]  │  │                    │
│N │  │    [Dismissed] [Tomorrow]   │  │                    │
│S │  │    ▓▓▓▓▓▓▓░░░░░ 67%         │  │                    │
│  │  │  ─ tasks grouped by axis    │  │      (input bar)   │
│  │  │  ⬜ Caixa signature 58h ›   │  │                    │
│  │  │  ⬜ Outlook re-auth Day 7 › │  │                    │
│  │  │  ✅ Develop pushed (1m)     │  │                    │
│  │  │  …                          │  │                    │
│  │  └────────────────────────────┘  │                    │
└──┴──────────────────────────────────┴────────────────────┘
```

Default split: 40% graphs / 10% calendar / 50% tasks. Two vertical splitters between sections, both drag-resizable, both persisted. Either non-tasks section can be collapsed to a 24px header bar to give more room to tasks.

### Update behaviour

The Exec left panel is **live**:

- Graphs re-render on every relevant observation insert (LIVE) or snapshot tick (SNAPSHOT).
- Calendar strip re-renders when the calendar sync poller writes new events.
- Tasks slide in/out as they are added, resolved, dismissed, rescheduled, or auto-resolved during the conversation.
- The panel never requires the user to scroll the chat to find the open list — it stays pinned.

---

## 1. Architectural surface

```
extensions/tinkerclaw-control-panel/
├── docs/
│   ├── SPEC.md                          # this file
│   ├── METRICS.md                       # registered metrics inventory (generated)
│   ├── TASKS.md                         # task lifecycle + signal-resolution patterns
│   └── PANEL-TEMPLATES.md               # the five panel shapes (see §6)
├── src/
│   ├── index.ts                          # plugin entry — registers RPCs, UI surfaces, MCP tools, alert + task + calendar watchers
│   ├── store/
│   │   ├── observations.ts               # better-sqlite3 store (metrics)
│   │   ├── tasks.ts                      # better-sqlite3 store (tasks + briefing_pass)
│   │   ├── calendar.ts                   # better-sqlite3 store (calendar_event_cache)
│   │   ├── schema.sql                    # all tables in one schema file
│   │   └── migrations.ts                 # forward-only migrations
│   ├── ingest/
│   │   ├── live.ts                       # record() from in-process events
│   │   └── snapshot.ts                   # cron-scheduled pollers for external sources
│   ├── tasks/
│   │   ├── import.ts                     # diff-aware import from briefing manifests
│   │   ├── auto-resolve.ts               # signal-watcher — auto-resolves on inferred_signal match
│   │   ├── lifecycle.ts                  # transitions (open ⇄ in_progress → resolved / dropped / dismissed)
│   │   ├── dismiss.ts                    # dismissal logic + briefing-feedback loop (don't re-propose dismissed)
│   │   ├── reschedule.ts                 # due_date manipulation + filtering today vs upcoming
│   │   ├── progress.ts                   # compute "X / Y done" against the user-delivered briefing pass
│   │   └── rendering.ts                  # markdown renderer for the left-panel task list
│   ├── calendar/
│   │   ├── sync.ts                       # 30-min poller; pulls google + (when MSAL works) outlook for next 14 days
│   │   ├── query.ts                      # date-range queries, density-per-day, event-titles-for-day
│   │   └── strip-data.ts                 # shapes the 7-day strip data for the renderer
│   ├── query/
│   │   ├── window.ts                     # range queries with downsampling
│   │   └── aggregate.ts                  # rate, delta, percentile, distinct-count
│   ├── alerts/
│   │   ├── watcher.ts
│   │   ├── rules.ts
│   │   └── router.ts                     # presence-aware routing
│   ├── render/
│   │   ├── sparkline.ts                  # SVG
│   │   ├── single-stat.ts                # SVG
│   │   ├── traffic-light.ts              # SVG
│   │   ├── streak.ts                     # SVG calendar heatmap
│   │   ├── bar-trend.ts                  # SVG vertical bars
│   │   └── calendar-strip.ts             # SVG 7-day strip (server-side first paint; uPlot for live)
│   ├── rpcs/
│   │   ├── control-panel.list.ts
│   │   ├── control-panel.add-metric.ts
│   │   ├── control-panel.add-panel.ts
│   │   ├── control-panel.inline.ts
│   │   ├── control-panel.record.ts
│   │   ├── control-panel.query.ts
│   │   ├── control-panel.propose.ts
│   │   ├── control-panel.tasks.list.ts
│   │   ├── control-panel.tasks.import.ts
│   │   ├── control-panel.tasks.update.ts
│   │   ├── control-panel.tasks.add.ts
│   │   ├── control-panel.tasks.remove.ts
│   │   ├── control-panel.tasks.dismiss.ts        # NEW v3.1
│   │   ├── control-panel.tasks.reschedule.ts     # NEW v3.1
│   │   ├── control-panel.tasks.progress.ts       # NEW v3.1 — returns {numerator, denominator, pass_id}
│   │   └── control-panel.calendar.list.ts        # NEW v3.1
│   ├── markdown/
│   │   └── control-panel-fence.ts        # markdown-it plugin for ctrl-panel block
│   ├── mcp/
│   │   └── tools.ts                       # MCP tool registrations
│   └── ui/
│       ├── exec-mode-toggle.ts            # top-bar button + mode state
│       ├── exec-left-panel.ts             # the HUD container, splitter, layout
│       ├── exec-graphs-section.ts         # top — graph grid + traffic-light strip
│       ├── exec-calendar-strip.ts         # NEW v3.1 — middle 7-day calendar
│       ├── exec-tasks-section.ts          # bottom — filter chips + progress + grouped task list
│       ├── exec-progress-bar.ts           # NEW v3.1 — anchored "X of Y" bar
│       ├── exec-filter-chips.ts           # NEW v3.1 — All/Unfinished/Dismissed/Rescheduled-today
│       ├── exec-task-row.ts               # NEW v3.1 — collapsed row
│       ├── exec-task-row-expanded.ts      # NEW v3.1 — inline expansion with context + actions
│       ├── exec-task-context-menu.ts      # NEW v3.1 — right-click menu (resolve / dismiss / reschedule / snooze / drop / open-in-chat)
│       ├── exec-reschedule-picker.ts      # NEW v3.1 — overlay date picker with calendar density context
│       ├── exec-dismiss-reason-popover.ts # NEW v3.1 — small popover capturing dismissal_kind + note
│       ├── control-panel-tab.ts           # right-panel tab (Dev mode)
│       ├── chart-uplot.ts                 # uPlot wrapper for live-updating panels
│       └── add-panel-dialog.ts            # wizard for adding new panels
├── openclaw.plugin.json                   # plugin manifest (configSchema mandatory per fork rule)
├── package.json
└── README.md
```

**External dependencies** (unchanged from v2): `better-sqlite3` (already a fork dep), `uplot` (~50KB gzipped), in-house SVG renderers. No Chromium, no Docker, no Grafana.

---

## 2. Data model

### 2.1 Metrics (LIVE vs SNAPSHOT — unchanged from v2)

| Class        | When data is captured                                            | Ingest path                                         | Cadence                                       |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| **LIVE**     | Pushed by cron events / internal handlers on every relevant tick | `live.record(id, value, labels?)` called in-process | Whenever the event fires                      |
| **SNAPSHOT** | Polled on demand from an external API or scrape                  | `snapshot.poll(id)` from a registered cron entry    | Configured per-metric; min 5 min, default 1 h |

Decision rule:

```
Is the source of truth inside OpenClaw?
  ├─ Yes → LIVE
  └─ No → does each pull cost a network round-trip?
            ├─ Yes → SNAPSHOT
            └─ No  → LIVE (call live.record from the file-event source)
```

### 2.2 Tasks (extended in v3.1)

Tasks share the same SQLite file as metrics but live in their own tables. The schema below is the v3.1 superset — new columns vs v3 marked `(v3.1)`.

```sql
CREATE TABLE briefing_pass (                        -- NEW v3.1
  id TEXT PRIMARY KEY,                              -- "2026-05-11.pass-1"
  date TEXT NOT NULL,                               -- "2026-05-11"
  pass_number INTEGER NOT NULL,                     -- 1, 2, 3, ...
  delivered_to_user_at INTEGER,                     -- when user actually saw it in webchat (NULL if cron-only)
  initial_task_count INTEGER NOT NULL DEFAULT 0,    -- frozen at delivery; progress denominator
  created_at INTEGER NOT NULL
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,                              -- stable id, e.g. "caixa-signature-2026-05-06"
  text TEXT NOT NULL,                               -- markdown content, single line preferred
  context_md TEXT,                                  -- (v3.1) expandable rich content shown on click
  status TEXT NOT NULL CHECK(status IN (
    'open','in_progress','resolved','dropped','dismissed'  -- v3.1 adds 'dismissed'
  )),
  source TEXT NOT NULL,                             -- 'briefing' | 'conversation' | 'manual' | 'cron' | 'auto'
  source_ref TEXT,                                  -- e.g. briefing file path + line, or message id
  briefing_pass_id TEXT REFERENCES briefing_pass(id),-- (v3.1) which /new pass introduced this task
  priority_axis TEXT CHECK(priority_axis IN ('online','family','me','serra','meta')),
  priority_rank INTEGER NOT NULL DEFAULT 50,        -- 0 = top, 100 = bottom within axis
  carry_days INTEGER NOT NULL DEFAULT 0,            -- how many briefings has this survived
  age_seconds INTEGER NOT NULL DEFAULT 0,           -- updated on every read
  due_date TEXT,                                    -- (v3.1) ISO date or datetime; NULL = today/anytime
  dismissal_kind TEXT CHECK(dismissal_kind IN (     -- (v3.1) why was this dismissed
    'not_a_task','not_relevant','wrong_priority','duplicate','out_of_scope','other'
  )),
  dismissal_note TEXT,                              -- (v3.1) free-form explanation
  est_minutes INTEGER,                              -- ballpark, optional
  hands TEXT CHECK(hands IN ('user','assistant','either')),  -- who acts
  inferred_signal_json TEXT,                        -- optional auto-resolution condition
  metadata_json TEXT,                               -- free-form: links, contact_ids, file refs
  recurrence_rule_text TEXT,                        -- (v3.1) iCal RRULE format for recurring tasks ("FREQ=WEEKLY;BYDAY=TU")
  recurrence_parent_id TEXT REFERENCES task(id),    -- (v3.1) parent of a recurring-task chain; NULL for one-shot or root
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX task_recurring ON task(recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;

CREATE INDEX task_open_priority ON task(status, priority_axis, priority_rank) WHERE status IN ('open','in_progress');
CREATE INDEX task_resolved_recent ON task(resolved_at DESC) WHERE status = 'resolved';
CREATE INDEX task_due_date ON task(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX task_briefing_pass ON task(briefing_pass_id);
CREATE INDEX task_dismissed ON task(status, dismissal_kind) WHERE status = 'dismissed';

CREATE TABLE task_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                               -- 'created' | 'status_changed' | 'note' | 'auto_resolved' | 'dismissed' | 'rescheduled' | 'context_added'
  payload_json TEXT
);
```

#### Status semantics (v3.1, refined)

| Status                     | Meaning                                                                                  | Counts against progress?                                              | Re-proposable in next briefing?                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `open`                     | Pending action, due today (or no due_date)                                               | Yes, denominator                                                      | N/A (still open)                                                                         |
| `in_progress`              | User started working on it; "currently active"                                           | Yes, denominator                                                      | N/A                                                                                      |
| `resolved`                 | Completed by user, by me, or by inferred signal                                          | Yes, numerator                                                        | No (skip in next pass unless `force_reopen`)                                             |
| `dropped`                  | Was a task, no longer is — state of the world changed (e.g. obsoleted by external event) | Yes, numerator-equivalent (treat as "no longer relevant" = "handled") | No                                                                                       |
| `dismissed`                | **User rejected the proposal — "I don't accept this as a task."** Distinct from dropped. | **No — removed from denominator entirely**                            | **Briefing reads `dismissal_kind`; doesn't re-propose unless a fresh signal forces it.** |
| `open` + future `due_date` | Rescheduled — out of today's view but findable in "Upcoming" filter                      | No (current day's denominator only counts due_date = today or NULL)   | Yes (returns on the due date)                                                            |

**The dismiss feedback loop** is the key v3.1 personal-efficiency move: when the user dismisses a task, the briefing's next pass reads the `dismissal_kind` and decides whether to re-propose. The default behaviour:

| `dismissal_kind` | Briefing behaviour on next pass                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| `not_a_task`     | **Don't re-propose, ever** (unless the source signal changes materially)               |
| `not_relevant`   | **Don't re-propose for 30 days** (might become relevant later)                         |
| `wrong_priority` | Re-propose but **lower the priority_rank** (user said it shouldn't be top)             |
| `duplicate`      | **Don't re-propose** + add a note to the kept task pointing to the dismissed duplicate |
| `out_of_scope`   | **Don't re-propose** (user said "this isn't my problem")                               |
| `other`          | Re-propose with the user's `dismissal_note` shown as context                           |

This shapes the briefing into a learning loop: my proposals get better because dismissals teach me what shouldn't be proposed.

#### Reschedule semantics

Reschedule = change `due_date`. Status stays `open`. The task is hidden from today's view (which filters `due_date IS NULL OR due_date <= today`) and appears in "Upcoming" / "Tomorrow" / "This week" filters.

Short pushes are exposed in the right-click menu as one-clicks: "Snooze 1 h" / "Snooze 4 h" / "Tonight" / "Tomorrow morning" / "Next Monday" — each sets `due_date` to a precomputed timestamp. Longer pushes open the reschedule picker (§7.4) with calendar density context.

#### Task lifecycle (v3.1 — extended)

```
                              ┌─────────────┐
                  created  →  │    open     │  ←─── (re-opened by user
                              └──┬───┬──┬───┘         or briefing force_reopen)
                                 │   │  │
                       starts ───┘   │  └─── due_date set future
                                     │      (filtered out of today)
                              ┌──────▼─────────────┐
                              │   in_progress      │
                              └──┬──┬───┬───┬──────┘
                                 │  │   │   │
                resolves         │  │   │   └── dismissed (with kind + note)
                                 │  │   │
                                 │  │   dropped
                                 │  │
                                 │  inferred_signal fires
                                 │  → resolved (source = 'auto')
                                 │
                                 ▼
                            ┌────────┐
                            │resolved│ (fades 30s in UI, persists in DB)
                            └────────┘
```

#### `inferred_signal_json` — the auto-resolution contract (unchanged from v3)

Examples:

```json
{ "type": "metric_below", "metric_id": "gmail_unread_caixa_enginyers", "threshold": 1 }
{ "type": "metric_below", "metric_id": "msal_token_age_seconds", "threshold": 3600 }
{ "type": "event", "channel": "gmail.thread", "match": { "thread_id": "abc123", "label_added": "TRASH" } }
{ "type": "metric_above", "metric_id": "github_open_prs", "threshold": 0 }
{ "type": "calendar_event_past", "event_id": "google.primary.xyz" }
```

If the signal evaluates true, the task auto-resolves with `source = 'auto'`, `kind = 'auto_resolved'`. The user sees the task fade out in the Exec panel within ~1 s with a brief "✨ auto-resolved by <signal>" tooltip.

### 2.3 Calendar event cache (NEW in v3.1)

Caches calendar events from external sources for fast date-range queries (used by the strip + the reschedule picker). Synced by `src/calendar/sync.ts` every 30 min for the next 14 days.

```sql
CREATE TABLE calendar_event_cache (
  source TEXT NOT NULL,                             -- 'google.primary' | 'outlook.serra' | 'manual'
  event_id TEXT NOT NULL,                           -- provider's event id
  date TEXT NOT NULL,                               -- ISO date for the event's start (local TZ)
  start_ts INTEGER NOT NULL,                        -- unix ms
  end_ts INTEGER,                                   -- unix ms; NULL for all-day events
  all_day INTEGER NOT NULL DEFAULT 0,               -- bool
  title TEXT NOT NULL,
  attendees_json TEXT,
  location TEXT,
  metadata_json TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (source, event_id)
);
CREATE INDEX calendar_event_date ON calendar_event_cache(date);
CREATE INDEX calendar_event_start ON calendar_event_cache(start_ts);
```

Density-per-day = sum of (end_ts − start_ts) per date, normalised against a 10-hour working day for the heat color. Title list per-day is read raw for hover tooltips and the reschedule picker.

---

## 3. Inline graph fence-block contract

Unchanged from v2.

````markdown
```ctrl-panel
id: ci_pass_rate
range: 7d
size: small
template: sparkline   # optional — defaults to the panel's registered template
```
````

Resolution: server emits inline SVG if the metric exists, or an `__ASK_ADD_PANEL__` chip if it doesn't. Sizes: `tiny` (80×24), `small` (280×120), `medium` (560×280), `large` (800×400).

---

## 4. RPC surface

### 4.1 Metrics RPCs (unchanged from v2)

| RPC                        | Purpose                                | Auth     |
| -------------------------- | -------------------------------------- | -------- |
| `control-panel.list`       | List registered metrics + dashboards   | read     |
| `control-panel.add-metric` | Register a new metric                  | operator |
| `control-panel.add-panel`  | Pin a metric to the Control Panel      | operator |
| `control-panel.inline`     | Resolve fence-block → SVG or ASK chip  | read     |
| `control-panel.record`     | Push an observation (LIVE)             | write    |
| `control-panel.query`      | Read values for a window               | read     |
| `control-panel.propose`    | Queue a "I want to track X" suggestion | write    |

### 4.2 Tasks RPCs (v3.1 — extended)

| RPC                                         | Purpose                                                                                                 | Auth     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| `control-panel.tasks.list`                  | List tasks filtered by `{status?, axis?, due_date_filter?, briefing_pass_id?, since_ts?, limit?}`       | read     |
| `control-panel.tasks.import`                | Diff-aware import from a structured task manifest (used by the briefing)                                | operator |
| `control-panel.tasks.update`                | Change status, text, priority, inferred_signal, context_md                                              | operator |
| `control-panel.tasks.add`                   | Create a new task ad-hoc                                                                                | operator |
| `control-panel.tasks.remove`                | Hard-delete a task (rare; usually use update→dropped/dismissed)                                         | operator |
| **`control-panel.tasks.dismiss`** (v3.1)    | Transition `open` → `dismissed` with `{dismissal_kind, dismissal_note?}`                                | operator |
| **`control-panel.tasks.reschedule`** (v3.1) | Set `due_date` to a future timestamp; status stays `open`                                               | operator |
| **`control-panel.tasks.progress`** (v3.1)   | Return `{pass_id, denominator, numerator, by_axis: [...]}` for the current user-delivered briefing pass | read     |

#### `tasks.import` diff semantics (v3.1 — refined)

The morning briefing emits a structured task manifest at the end of its run. The import RPC reconciles the manifest against the current task table:

| Manifest vs DB                                                | Action                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task in manifest, not in DB                                   | Insert as `open`, `source = 'briefing'`, `briefing_pass_id = current_pass`, `carry_days = 0`                                                                                   |
| Task in manifest AND DB, both `open`                          | Update text/priority/inferred_signal/context_md (no status change), bump `carry_days += 1`                                                                                     |
| Task in manifest AND DB, DB is `resolved`                     | Skip — don't re-open a closed task unless the manifest sets `force_reopen: true`                                                                                               |
| Task in manifest AND DB, DB is `dismissed`                    | **(v3.1)** Consult `dismissal_kind` rule (§2.2 dismiss feedback loop) — skip, re-propose with lower rank, or re-propose with `dismissal_note` shown as context                 |
| Task in DB, not in manifest, status `open`, source `briefing` | Mark as `dropped` with `source_note = 'manifest_omission'` (unless the manifest sets `prune_missing: false`, in which case leave alone — the briefing may have just missed it) |
| Task in DB, not in manifest, source ≠ `briefing`              | Untouched (manual/conversation tasks survive briefings)                                                                                                                        |
| Task in DB, status `open`, `due_date > today`                 | Untouched (rescheduled — out of today's view but still owned)                                                                                                                  |

### 4.3 Calendar RPCs (NEW in v3.1)

| RPC                              | Purpose                                                                                                                                   | Auth     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `control-panel.calendar.list`    | Return events for a date range `{from, to, source?}`. Used by the strip + the reschedule picker + me when answering "what's on Thursday?" | read     |
| `control-panel.calendar.sync`    | Force a re-sync from external sources (normally runs every 30 min on cron)                                                                | operator |
| `control-panel.calendar.density` | Return `{date: count, total_minutes}[]` for a date range; used by the strip + picker heat                                                 | read     |

---

## 5. MCP tool surface (for me, the LLM)

### 5.1 Metrics tools (unchanged from v2)

`control_panel_add_metric`, `control_panel_record`, `control_panel_query`, `control_panel_inline`, `control_panel_propose`.

### 5.2 Task tools (v3.1 — extended)

| Tool                                        | Description                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control_panel_tasks_list`                  | Query tasks with filters. Args: `{status?, axis?, due_date_filter?, briefing_pass_id?, limit?, since_ts?}`                                            |
| `control_panel_tasks_add`                   | Create a task ad-hoc during conversation. Args: `{id?, text, axis, rank?, context_md?, inferred_signal?, metadata?, due_date?, est_minutes?, hands?}` |
| `control_panel_tasks_update`                | Change status / text / signal / context. Args: `{id, status?, text?, context_md?, inferred_signal?, note?}`                                           |
| `control_panel_tasks_import`                | Bulk import from a manifest. Args: `{pass_id, manifest: [{...}], prune_missing?: bool}`                                                               |
| **`control_panel_tasks_dismiss`** (v3.1)    | Mark dismissed with reason. Args: `{id, dismissal_kind, dismissal_note?}`                                                                             |
| **`control_panel_tasks_reschedule`** (v3.1) | Reschedule. Args: `{id, due_date}` (ISO date or datetime)                                                                                             |
| **`control_panel_tasks_progress`** (v3.1)   | Current progress against the user-delivered briefing pass. Returns `{pass_id, denominator, numerator, by_axis: [...]}`                                |
| **`control_panel_calendar_list`** (v3.1)    | Read calendar events for a date range. Args: `{from, to, source?}`                                                                                    |

**Behaviour contract**: when in conversation I declare a task resolved, I call `control_panel_tasks_update(id, status: 'resolved')`. When the user says "drop that, I don't think it's a task" I call `control_panel_tasks_dismiss` with `dismissal_kind: 'not_a_task'` + their words as `dismissal_note` so the briefing learns. When the user says "let's do that tomorrow", I call `control_panel_tasks_reschedule(id, due_date: tomorrow)`.

`tasks_update`, `tasks_add`, `tasks_dismiss`, `tasks_reschedule` are all **auto-approve** (reversible — `task_event` retains the full audit trail). Logged in `~/.openclaw/cognitive/audit.log`.

---

## 6. Panel templates (unchanged from v2)

Five native SVG templates: `sparkline`, `single-stat`, `traffic-light`, `streak`, `bar-trend`. Right-panel tab uses `uPlot` for live-updating panels. Server-side inline rendering always produces SVG strings.

v3.1 adds a sixth template internal to the Exec panel: `calendar-strip` (§7.3). Not exposed via the inline fence-block; only rendered as part of the Exec left panel.

---

## 7. UI surfaces (v3.1 — three vertical sections in Exec, expanded task interactions)

### 7.1 Top-bar Dev/Exec toggle

| Element           | Spec                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Where             | Tinker UI top bar, near the existing model/session indicators                                 |
| Visual            | Two-state pill button: `[ DEV ]` (default, neutral color) ↔ `[ EXEC ]` (active, accent color) |
| Click behaviour   | Toggles the mode; persists to `localStorage.tinker_mode` and to the session state             |
| Keyboard shortcut | `Ctrl+Shift+E` toggles modes (configurable)                                                   |
| Default           | `dev` for backwards compatibility                                                             |
| Per-user override | Settings: "Default mode on launch" → `dev` / `exec` / `last-used`                             |

### 7.2 Exec mode — left HUD panel container

**Container** (`src/ui/exec-left-panel.ts`):

- Width: 360px default, drag-resizable in 8px steps from 280px to 520px, persisted
- **Three sections vertically** with two drag-resizable splitters
- Default split: 40% graphs / 10% calendar strip / 50% tasks
- Each non-tasks section can be collapsed to a 24px header strip (click the section title)
- Border-right matching the existing right-panel styling

### 7.3 Exec — top section: Graphs

(Unchanged from v3 — but the calendar strip moves to its own section below.)

- Top row: traffic-light strip — one block per "watch" metric, horizontally scrollable if > 8
- Below: 2-column grid of `small`-size panels
- "Add Panel" button at bottom of the section
- Per-panel: click to expand to `medium` in overlay; right-click for edit/remove

### 7.4 Exec — middle section: Calendar strip (NEW v3.1)

A compact 7-day horizontal strip showing event density per day + count of tasks rescheduled to that day.

```
┌──────────────────────────────────────────────────────────────┐
│   Mon 11   Tue 12   Wed 13   Thu 14   Fri 15   Sat 16   Sun  │
│   ▓▓▓      ▓        ▓▓▓▓▓    ─        ▓▓       ─        ▓    │
│   3 evts   1 evt    5 evts   free     2 evts   free     1    │
│   +1 tsk            +2 tsks                                   │
└──────────────────────────────────────────────────────────────┘
```

| Element                 | Detail                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Day cell                | Day name + date number                                                                                                                 |
| Density bar             | Height proportional to total event minutes / 600 (10-hour normalised day); color: green (<2h), yellow (2–5h), orange (5–8h), red (>8h) |
| Event count             | "5 evts" / "free" — subtle text below bar                                                                                              |
| Rescheduled-tasks badge | "+N tsks" — count of tasks with `due_date = this day`; click to filter task list to this day                                           |
| Hover                   | Tooltip showing the day's event titles (first 8) + rescheduled task titles                                                             |
| Click                   | Filters the task list below to `due_date = this day` (sets a chip in §7.5)                                                             |
| Today's column          | Highlighted with a subtle accent border                                                                                                |
| Settings                | Toggle to hide the strip (some users may want max task room)                                                                           |

Data comes from `control-panel.calendar.density` for the heat + `control-panel.tasks.list` for the rescheduled-task badge.

### 7.5 Exec — bottom section: Tasks (v3.1 — full UX)

**Top of the tasks section: filter chips + progress bar.**

```
┌────────────────────────────────────────────────────────────┐
│  [ All today 8/12 ]  [ Unfinished 4 ]  [ Rescheduled 3 ]   │
│  [ Dismissed 1 ]     [ Resolved 8 ]    [ Group: axis ▼ ]   │
│                                                              │
│  ▓▓▓▓▓▓▓▓░░░░░░░░  67% (8 of 12)                            │
└────────────────────────────────────────────────────────────┘
```

| Filter chip   | Shows                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `All today`   | Tasks where (`due_date IS NULL` OR `due_date = today`) AND status ≠ `dismissed` |
| `Unfinished`  | Same scope, status ∈ (`open`, `in_progress`)                                    |
| `Rescheduled` | Tasks where `due_date > today` (out of today's view; shows when picked)         |
| `Dismissed`   | Tasks where status = `dismissed` (toggleable visibility)                        |
| `Resolved`    | Tasks where status = `resolved` (toggleable visibility)                         |

| Progress bar | Detail                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Denominator  | Count of tasks where `briefing_pass_id = today's first user-delivered pass` AND status ≠ `dismissed`                                                                                                         |
| Numerator    | Count of those where status = `resolved` or `dropped`                                                                                                                                                        |
| Visual       | Solid horizontal bar with a percentage label; color: red (<25%), amber (25–66%), green (≥67%)                                                                                                                |
| Anchor       | "Today's pass" — anchored to the user-delivered briefing pass, not the cron pass. (Connects to the `feedback_briefing_cron_vs_user_pass.md` lesson: a cron-only pass doesn't count until the user reads it.) |
| Empty state  | "No briefing yet today — type /new"                                                                                                                                                                          |

**Group selector**: dropdown changes the grouping in the list below. Default = by axis. Alternatives: by `hands`, by `est_minutes`, by `due_date` (today / tomorrow / this week / later).

**Task list** (grouped by selected dimension, default axis):

```
💰 Online (3)
  ⬜ Push 19 commits to develop branch                 3d  30s  me   ⋯
  ⬜ Fix CI workflow-file startup_failure (5d streak)  5d  ~5m  me   ⋯
  ⬜ Reply to NevaMind/memU thread (22 days dark)      22d ~5m  user ⋯

👨‍👩‍👧 Family (2)
  ⬜ Classify Ivo (friend / family / kid / adult)      T-4 10s  user ⋯
  ⬜ Sasha-Apr-4 flowers (Day 37, firm nudge zone)     37d 2m   user ⋯

🏃 Me (1)
  ⬜ Sign Caixa Enginyers loan document                58h 3m   user ⋯

🏭 SERRA (2)
  ⬜ Re-auth Microsoft (Day 7 daily ritual)            7d  3m   user ⋯
  ✅ Develop branch pushed (auto-resolved)             1m  —    me   (fading)
```

| Row element          | Detail                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Status icon          | `⬜` open · `🟡` in_progress · `✅` resolved (fading) · `🚫` dropped (grey) · `🗑` dismissed (grey, hidden by default) |
| Text                 | Single-line markdown (links, emoji, inline code)                                                                       |
| Age chip             | `2h` · `3d` · `Day 37` · `T-4` (date-anchored) — right-aligned                                                         |
| Est-minutes chip     | `30s` · `2m` · `5m` — right-aligned                                                                                    |
| Hands chip           | `me` / `user` / `either` — right-aligned, color-coded                                                                  |
| `⋯` menu             | Opens the right-click context menu (also fires on right-click anywhere in the row)                                     |
| **Click row** (v3.1) | **Expands inline** — see §7.6                                                                                          |

### 7.6 Expandable inline task context (NEW v3.1)

Click on a task row → expands inline showing:

```
┌───────────────────────────────────────────────────────────────┐
│ ⬜ Sign Caixa Enginyers loan document         58h 3m  user ⋯ │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  Context                                                       │
│  ─────────                                                     │
│  Loan paperwork from May 6, escalated to "sign-now" status on  │
│  Saturday 21:01. The signature link is in the original email   │
│  (gmail thread id #abc123). Total cost of inaction: 58h of     │
│  weekend non-action on a 5-minute financial obligation.        │
│                                                                │
│  Linked artifacts:                                             │
│  📧 Original email (May 6) → opens in Gmail                    │
│  📧 Sign-now reminder (Sat 21:01) → opens in Gmail             │
│  📝 Loan terms attachment → opens in browser                   │
│                                                                │
│  History (3 events)                            [Expand log ▾]  │
│                                                                │
│  Actions                                                       │
│  ─────────                                                     │
│  [ Mark resolved ]  [ Reschedule… ]  [ Snooze 4h ]            │
│  [ Dismiss… ]       [ Open in chat ]  [ Edit text ]            │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

| Section              | Detail                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Context**          | Rendered markdown from `task.context_md`. Briefing-generated tasks include rationale + consequence-of-inaction. Conversation-generated tasks include the snippet of conversation that birthed them.                                                                                  |
| **Linked artifacts** | Parsed from `metadata_json`. Each artifact is a clickable button — emails open via the existing `gog` deep-link pattern, files open via the existing `config.openExternalFile` RPC, calendar events open in the user's default calendar app, contacts open the people-profile panel. |
| **History**          | Collapsed by default. Expand to see the `task_event` log (created → status_changed → context_added → etc.). Useful when "wait, when did this become urgent?" comes up.                                                                                                               |
| **Actions**          | Inline buttons for the most common transitions; same set as the right-click menu but more discoverable.                                                                                                                                                                              |

Click again on the row header to collapse.

### 7.7 Right-click context menu (NEW v3.1)

Triggered by right-click on a row OR click on the `⋯` glyph:

```
┌─────────────────────────────────┐
│  Mark resolved            ⌘↵    │
│  Mark in-progress         ⌘.    │
│  ─────────────────────────────  │
│  Reschedule to ▸                │  ──→ submenu:
│  Snooze ▸                       │      ┌──────────────────┐
│  ─────────────────────────────  │      │ Tomorrow morning │
│  Dismiss…                       │      │ Tomorrow night   │
│  Drop (no longer relevant)      │      │ This Friday      │
│  ─────────────────────────────  │      │ Next Monday      │
│  Expand context                 │      │ Pick a date…  ›  │
│  View history                   │      └──────────────────┘
│  Edit text…                     │
│  ─────────────────────────────  │
│  Open in chat                   │  ──→ Sends "Let's work on: <task text>" to the chat input
└─────────────────────────────────┘
```

**Dismiss…** opens a small popover capturing `dismissal_kind` + an optional note:

```
┌──────────────────────────────────────────────────┐
│  Why are you dismissing this task?               │
│                                                   │
│   ○ Not a task                                    │
│   ○ Not relevant                                  │
│   ○ Wrong priority — should be lower             │
│   ○ Duplicate of another task                    │
│   ○ Out of scope                                 │
│   ○ Other                                         │
│                                                   │
│  Note (optional):                                 │
│  [_______________________________________]        │
│                                                   │
│   [ Cancel ]                       [ Dismiss ]    │
└──────────────────────────────────────────────────┘
```

The choice feeds the briefing's dismiss-feedback loop (§2.2) — your dismissals teach the next briefing what not to propose.

**Reschedule to → Pick a date…** opens the reschedule picker (§7.8).

### 7.8 Reschedule picker overlay (NEW v3.1 — scrollable in v3.2)

A scrollable calendar grid overlay shown when the user picks "Reschedule to → Pick a date…". The overlay opens showing 2 weeks (this week + next) above the fold; the grid body scrolls vertically to reveal additional weeks. Each day cell shows:

- Day name + date
- Event count and density bar (same heat as the strip)
- Top 3 event titles inline (or "+N more" tooltip)
- Number of tasks already rescheduled to that day
- Click → set `due_date` on the task and close the overlay

```
┌────────────────────────────────────────────────────────────────────┐
│  Reschedule "Sign Caixa Enginyers loan document" to…              │
│                                                                     │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐  ▲             │
│  │Mon 11│Tue 12│Wed 13│Thu 14│Fri 15│Sat 16│Sun 17│  │             │
│  │░░ 3  │░ 1   │▓▓ 5  │─     │░ 2   │─     │─     │  │ This week   │
│  │+1tsk │      │+2tsks│      │      │      │      │  │             │
│  ├──────┼──────┼──────┼──────┼──────┼──────┼──────┤  │             │
│  │Mon 18│Tue 19│Wed 20│Thu 21│Fri 22│Sat 23│Sun 24│  │ Next week   │
│  │─     │░ 2   │░░ 4  │░ 1   │─     │─     │░ 1   │  │             │
│  ├──────┼──────┼──────┼──────┼──────┼──────┼──────┤  │  scroll     │
│  │Mon 25│Tue 26│Wed 27│Thu 28│Fri 29│Sat 30│Sun 31│  │ ↓ down for  │
│  │░ 2   │─     │░ 1   │─     │▓ 3   │─     │─     │  │  weeks 3+   │
│  ├──────┼──────┼──────┼──────┼──────┼──────┼──────┤  │             │
│  │Mon 01│Tue 02│Wed 03│Thu 04│Fri 05│Sat 06│Sun 07│  │             │
│  │░ 1   │░░ 4  │─     │░ 2   │░ 1   │─     │─     │  ▼             │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘                │
│                                                                     │
│   ◀ Earlier        Today is highlighted        Later ▶              │
└────────────────────────────────────────────────────────────────────┘
```

This sidesteps blind rescheduling — you see "Wednesday has 5 events and 2 already-rescheduled tasks; maybe push to Thursday which is empty."

**Scroll behaviour (v3.2)**: the grid body is a fixed-height scroll container (~340 px, ≈ 2 visible weeks at 160 px/row + header). Wheel/trackpad scrolls reveal weeks 3, 4, 5… up to a soft cap of **12 weeks** ahead (covers any plausible reschedule horizon; beyond that, use the briefing or `control-panel.tasks.add` with an explicit `due_date`). The calendar-density cache poller (§5.3) already pre-fetches the next 14 days; weeks beyond that lazy-load via `control-panel.calendar.density {from, to}` as they scroll into view (skeleton density bars during the request). The "◀ Earlier / Later ▶" buttons remain as a fallback / discoverability hint and jump the scroll position by ±2 weeks.

### 7.9 Live updates over WebSocket

The Exec panel subscribes to three channels:

- `observations.changed` — re-render graphs containing the changed metric
- `tasks.changed` — slide tasks in/out, update progress bar, refresh filter chip counts
- `calendar.synced` — re-render the calendar strip

All payloads are deltas (changed IDs only), so the wire cost stays small even when watching many panels.

### 7.10 Dev mode — right-panel Control Panel tab (unchanged from v2)

A native Tinker UI tab below Prefrontal in Dev mode. Same uPlot rendering. This is the **mirror** view of the Exec graphs section; both consume the same observations, so they stay in sync.

In Exec mode this tab is hidden (the data is in the left HUD instead).

---

## 8. Alert routing (unchanged from v2 — and now can create tasks)

In-process `src/alerts/watcher.ts` evaluates per-metric thresholds on every observation insert. Routes via user-presence:

| User state                                          | Where the alert lands                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Active in Tinker UI (last interaction < 5 min)      | `__ALERT__` chip injected into the assistant's next reply + Exec panel traffic-light flips |
| Active in WhatsApp recently (last message < 30 min) | WhatsApp DM via `tinkerclaw-whatsapp` outbound                                             |
| Away across all channels                            | Email digest at the next briefing tick                                                     |

In Exec mode, alerts ALSO flash the corresponding traffic-light cell in the top strip for 5 seconds (CSS pulse) regardless of routing.

**v3 addition (carried)**: a fired alert can also **auto-create a task** if `alert_rule.create_task = true`. The task carries the alert's `metric_id` as `source_ref` and gets an `inferred_signal` that auto-resolves it when the metric goes green again.

---

## 9. Lifecycle (v3.1 — adds calendar sync poller)

| Phase             | Behaviour                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First install** | Plugin's `register()` hook: runs `schema.sql` against `~/.openclaw/data/control-panel/store.db`, registers RPCs + MCP tools + markdown-it block + UI surfaces. No Docker, no binary download. Install time: < 1 s.                             |
| **Boot**          | Verifies SQLite store, runs pending migrations, starts: (a) the alert watcher, (b) the task auto-resolve watcher, (c) **the calendar sync poller** (v3.1, runs every 30 min for next 14 days). Logs `[control-panel] healthy`.                 |
| **Runtime**       | LIVE metrics: `live.record()` in-process. SNAPSHOT metrics: per-metric cron entries. Calendar sync: every 30 min (Google primary by default; Outlook when MSAL token valid). Alerts fire synchronously. Tasks update via RPC or auto-resolver. |
| **Backup**        | `store.db` (metrics + tasks + briefing_pass + calendar_event_cache) included in nightly backup.                                                                                                                                                |
| **Uninstall**     | Removes data dir, cron entries, markdown block, UI surfaces, calendar poller.                                                                                                                                                                  |

**Transparency**: from the user's perspective, they install the fork, the plugin's already in the allowlist, the Control Panel tab appears in Dev mode's right panel, and pressing the EXEC toggle reveals the left panel with the default graph strip, calendar strip, and task board seeded from the most recent briefing.

---

## 10. Integration points (v3.1 — extends briefing manifest contract)

| Surface                                     | Change                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRIEFING.md`                               | Rewrite to (a) emit `ctrl-panel` fence-blocks for time-series data, (b) emit a **task manifest** at end-of-run including `context_md` per task, (c) **consult dismissed tasks before re-proposing** per the §2.2 dismiss-feedback loop. |
| Briefing skill code                         | Calls `control-panel.tasks.import` at end of run with the manifest + `pass_id`. Calls `briefing_pass` creation at the start of the user-delivered pass (not the cron-only pass).                                                        |
| `tinker-ui/src/app.ts:22`                   | Register the `ctrl-panel` markdown-it custom block.                                                                                                                                                                                     |
| `tinker-ui/src/topbar.ts` (or equivalent)   | Add the DEV/EXEC mode toggle.                                                                                                                                                                                                           |
| `tinker-ui/src/layout.ts` (or equivalent)   | Three-column layout switch (DEV vs EXEC).                                                                                                                                                                                               |
| `tinker-ui/src/panels/exec-left-panel.ts`   | New file — the three-section HUD.                                                                                                                                                                                                       |
| `tinker-ui/src/panels/control-panel-tab.ts` | New file — the right-panel tab.                                                                                                                                                                                                         |
| `tinker-ui/src/styles.css`                  | Layout grid, splitters, fade animations, filter-chip styling, task-row expansion, reschedule-picker overlay (~150 lines).                                                                                                               |
| `openclaw.json`                             | Add `tinkerclaw-control-panel` to `plugins.allow`.                                                                                                                                                                                      |
| `~/.openclaw/cron/`                         | One cron entry per SNAPSHOT metric + one for calendar sync (30 min cadence).                                                                                                                                                            |
| `TINKER_UI_DESIGN_BIBLE.md`                 | New §X — DEV/EXEC contract, left-panel three sections, calendar strip, reschedule picker, dismiss popover.                                                                                                                              |
| `~/.openclaw/data/control-panel/`           | New data directory.                                                                                                                                                                                                                     |

**No port additions** — the plugin opens no listening sockets.

---

## 11. Briefing → task manifest contract (v3.1 — extended)

The morning briefing's `/new` output ends with a code block the plugin consumes:

````markdown
```ctrl-panel-tasks
{
  "version": 2,
  "pass_id": "2026-05-11.pass-1",
  "delivered_to_user_at": 1715418000000,
  "prune_missing": false,
  "tasks": [
    {
      "id": "caixa_signature_2026-05-06",
      "text": "Sign Caixa Enginyers loan document",
      "context_md": "Loan paperwork from May 6, escalated to sign-now status Saturday 21:01. **58 hours** of weekend non-action on a 5-minute financial obligation. [Open original email](gmail://thread/abc123). [Open sign-now reminder](gmail://thread/def456).",
      "priority_axis": "me",
      "priority_rank": 1,
      "carry_days": 5,
      "est_minutes": 3,
      "hands": "user",
      "source_ref": "memory/morning-briefings/2026-05-11.md#caixa",
      "metadata": {
        "gmail_thread_ids": ["abc123", "def456"],
        "linked_files": []
      },
      "inferred_signal": {
        "type": "event",
        "channel": "gmail.thread",
        "match": { "thread_id": "abc123", "label_added": "TRASH" }
      }
    },
    {
      "id": "outlook_msal_reauth_daily",
      "text": "Re-auth Microsoft sign-in (daily ritual day 7)",
      "context_md": "Microsoft's SPA refresh token has expired every morning since 2026-05-04 (7 consecutive days). The structural fix is a confidential-client-app token with months-long lifetime — scheduled for May 19. Until then, the daily ritual unblocks SERRA + Teams calendar visibility for the rest of the day.",
      "priority_axis": "serra",
      "priority_rank": 1,
      "carry_days": 7,
      "est_minutes": 3,
      "hands": "user",
      "inferred_signal": {
        "type": "metric_below",
        "metric_id": "msal_token_age_seconds",
        "threshold": 3600
      }
    }
  ]
}
```
````

This block is **invisible in the rendered chat** (the markdown-it plugin strips it during render after passing it to `control-panel.tasks.import`).

Manifest version 2 (v3.1) adds: `context_md`, `metadata.gmail_thread_ids`, `metadata.linked_files`, `delivered_to_user_at` (to set the `briefing_pass.delivered_to_user_at` field), and structured `inferred_signal` objects (was a string in v3).

---

## 12. Open decisions (defaults stand unless overridden)

1. **Chart library**: `uPlot` (default, ~50KB) vs `chart.js`. Default = uPlot.
2. **Default retention**: 90 d SNAPSHOT, 30 d high-frequency LIVE. Per-metric override at creation.
3. **Exec default split**: 40/10/50 graphs/calendar/tasks. Per-user override persisted.
4. **Default left-panel width**: 360 px. Per-user override persisted.
5. **Default mode on launch**: `dev`. Settings allow `dev` / `exec` / `last-used` per-user.
6. **Resolved-task fade duration**: 30 s default. Per-user override.
7. **Auto-import from briefing**: yes by default. Disable via plugin config flag.
8. **(v3.1) Calendar sync cadence**: 30 min default. Per-source override (`google.primary: 15min`, `outlook.serra: 60min` once MSAL works). The sync respects API quotas.
9. **(v3.1) Calendar sources enabled**: Google primary by default; Outlook off until MSAL re-auth lands; users can enable/disable each source in settings.
10. **(v3.1) Default visible filter on Exec open**: `Unfinished` (most actionable view). Per-user override = `last-used`.
11. **(v3.1) Show dismissed tasks by default**: no — hidden behind the `Dismissed` filter chip. Click to reveal.
12. **(v3.1) Dismiss-feedback decay**: a `not_relevant` dismissal mutes the task for 30 days by default. Override per-task or globally.

---

## 13. Visual design language (NEW in v3.1)

The Exec Control Panel is the user's primary working surface. It earns 360 px of screen real estate by making every pixel informative AND by being something the user actually wants to look at. Goal: dense without being noisy, alive without being twitchy, restrained without being boring.

### 13.1 Aesthetic references

| Reference            | What we borrow                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Linear**           | Typography hierarchy, restrained palette, dense-but-readable rows, smooth motion           |
| **Vercel dashboard** | Subtle elevation cues, clear status colors, dark-first                                     |
| **Things 3**         | Soft and inviting axis grouping, the satisfying feel of completing a task                  |
| **Reflect**          | Markdown rendered inside structured cards — informative without being engineering-flavored |
| **Sentry**           | Alerting that informs without screaming                                                    |

**Anti-references**: Grafana defaults (too engineering, too dense), Jira (too form-heavy), Trello (too card-grid). This is a **personal HUD**, not a corporate dashboard.

### 13.2 Color tokens

All colors are CSS variables, themed via `[data-theme="dark|light"]`. Default = dark.

```css
:root[data-theme="dark"] {
  /* Background elevations */
  --bg-base: #0a0a0c; /* chat column */
  --bg-panel: #111114; /* left panel container */
  --bg-section: #16161a; /* graphs / calendar / tasks containers */
  --bg-row-hover: #1c1c22; /* task row on hover */
  --bg-row-expand: #1f1f26; /* expanded task row (drawer) */

  /* Status colors */
  --status-open: #a3a3ad; /* neutral grey */
  --status-active: #d4a627; /* warm amber for in_progress */
  --status-done: #4eb069; /* calm green */
  --status-dropped: #6a6a73; /* faded grey */
  --status-dismiss: #8b5cf6; /* purple — semantically distinct from dropped */
  --status-error: #ef5350; /* red, used sparingly */

  /* Severity gradient (alerts, calendar density, age chips) */
  --sev-0: #4eb069; /* green: good */
  --sev-1: #d4a627; /* yellow: watch */
  --sev-2: #f59e0b; /* orange: action */
  --sev-3: #ef5350; /* red: urgent */

  /* Priority axis accents (subtle 2 px left border on group headers) */
  --axis-online: #f5b800; /* gold */
  --axis-family: #e8849e; /* warm pink */
  --axis-me: #6cb1e8; /* soft blue */
  --axis-serra: #8a8a92; /* slate */
  --axis-meta: #6a6a73; /* faded */

  /* Typography */
  --fg-primary: #eaeaee;
  --fg-secondary: #a3a3ad;
  --fg-muted: #6a6a73;
  --fg-link: #8aa9d6;

  /* Borders */
  --border-subtle: #232328;
  --border-strong: #2a2a30;
  --border-accent: #3a3a45;

  /* Overlay shadows */
  --shadow-overlay: 0 16px 48px rgba(0, 0, 0, 0.6);
}
```

Light theme inverts the elevations (white-tinted base, slightly darker sections), keeps the same hue families for status / severity / axis.

### 13.3 Typography

```css
--font-sans: "Inter", "SF Pro Text", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace;
```

| Element                                    | Size                    | Weight | Family                          | Color            |
| ------------------------------------------ | ----------------------- | ------ | ------------------------------- | ---------------- |
| Section header (GRAPHS / CALENDAR / TASKS) | 11 px                   | 600    | sans, ALL-CAPS, 0.05em tracking | `--fg-muted`     |
| Axis group header (💰 Online (3))          | 12 px                   | 600    | sans                            | `--fg-secondary` |
| Task text (primary)                        | 13 px                   | 400    | sans                            | `--fg-primary`   |
| Context preview (multi-line under text)    | 12 px                   | 400    | sans                            | `--fg-secondary` |
| Meta chips (age / est / hands)             | 10 px                   | 500    | sans, lowercase                 | `--fg-muted`     |
| Status icon (emoji)                        | 14 px                   | —      | system emoji                    | inherit          |
| Calendar day label                         | 11 px                   | 600    | sans                            | `--fg-secondary` |
| Calendar event count                       | 10 px                   | 400    | sans                            | `--fg-muted`     |
| Progress percentage                        | 14 px                   | 600    | mono, tabular-nums              | `--fg-primary`   |
| Filter chip label                          | 11 px                   | 500    | sans                            | inherit          |
| Action button label                        | 12 px                   | 500    | sans                            | inherit          |
| Expanded-row context (markdown body)       | 13 px / 1.5 line-height | 400    | sans                            | `--fg-primary`   |
| Tooltip body                               | 11 px / 1.4 line-height | 400    | sans                            | `--fg-primary`   |

### 13.4 Motion language

| Event                    | Motion                                                                 | Timing                                                        |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| Task marked resolved     | Row fades to 30% opacity, then collapses height to 0                   | 300 ms ease-out fade · 200 ms ease-in collapse · 100 ms delay |
| New task slides in       | Slides down from top of group, brief amber-to-neutral background flash | 250 ms ease-out · 800 ms color fade                           |
| Auto-resolved by signal  | ✨ icon flashes overlaid on row, then standard resolved fade           | 600 ms flash · then standard sequence                         |
| Filter chip change       | List re-layouts with FLIP-style animations on remaining rows           | 200 ms per row, staggered 20 ms                               |
| Row hover                | Background tint to `--bg-row-hover`, `⋯` glyph fades in on right       | 150 ms ease                                                   |
| Row click (expand)       | Drawer slides down underneath with height-grow                         | 220 ms ease-out                                               |
| Progress bar fill        | Width animates smoothly when numerator increments                      | 400 ms cubic-bezier(0.2, 0.8, 0.2, 1)                         |
| Calendar sync complete   | Subtle pulse on each day cell as data lands                            | 600 ms opacity 0.7 → 1 → 0.7                                  |
| Today's column pulse     | Quiet accent-border opacity loop, every 4 s                            | 1.5 s ease-in-out, infinite                                   |
| Overlay (picker/popover) | Fades in over dimmed background                                        | 180 ms ease                                                   |

Motion respects `prefers-reduced-motion: reduce` — all transitions collapse to instant changes (opacity fades stay; they don't trigger vestibular issues).

### 13.5 Component visuals

#### Traffic-light cell (top strip)

```
┌─────────┐
│   🟢    │  ← 16 px emoji, soft radial fill behind
│ Gmail   │  ← 10 px label, --fg-muted
│  green  │  ← 9 px status word, color = severity
└─────────┘
   40×52
```

- Cell background `--bg-section`, 2 px colored left border keyed to severity
- Emoji slot has a subtle radial gradient of the severity color (10% opacity)
- Hover: cell elevates to `--bg-row-hover`, tooltip shows last 5 values + threshold
- Click: opens the metric's full panel in a `medium`-size overlay
- A failing surface pulses for 5 s on green→yellow→red transition

#### Calendar strip cell

```
┌──────────┐
│  Mon     │  ← 11 px day name (today: bold, --axis-me accent)
│   11     │  ← 14 px date number
│  ▓▓▓     │  ← density bar; height = minutes/600; color by --sev-N
│  3 evts  │  ← 10 px count, or "free"
│  +1 tsk  │  ← 10 px rescheduled-task badge (only if > 0)
└──────────┘
   ~50×80
```

- Today's column has 1 px `--border-accent` left+right edges and a quiet 4 s pulse
- Hover: tooltip popover above the strip with event titles (first 8 + "+N more")
- Click: filters tasks list to that day

#### Task row (collapsed)

```
┌─────────────────────────────────────────────────────────────┐
│ ⬜  Sign Caixa Enginyers loan document    58h  3m  user  ⋯  │
└─────────────────────────────────────────────────────────────┘
   ↑    ↑                                    ↑    ↑    ↑    ↑
   icon text (truncates with ellipsis)       age  est  hands menu
   18px                                      chips right-aligned
```

- Three-zone grid: icon (24 px) · content (flex-grow) · chips+menu (right)
- 32 px tall by default, 40 px when context-preview is shown beneath
- Meta chips: `age` (color-shifted by age), `est_minutes` (always neutral), `hands` (`me` blue, `user` amber, `either` neutral)
- **`due_date` is intentionally NOT shown in this row** (v3.2). The collapsed row stays at glance-density — current filter chip (`All today` / `Upcoming` / `Rescheduled`) already communicates the temporal bucket the user is looking at, and the per-row date would create visual noise across a list of 8–12 items. Due dates surface in the expanded card (below) and in the per-day filter that fires when the user clicks a column in the calendar strip (§7.3).
- The `⋯` glyph is invisible by default, fades in on hover (60% then 100% opacity)
- 1 px `--border-subtle` between rows · 12 px gap at axis-group boundaries
- Group header has the 2 px axis-accent left border

**Age chip color shift over time** — subtle but informative subliminal urgency:

- 0–4 h: `--fg-muted` (no urgency yet)
- 4–24 h: `--sev-0` (still fresh)
- 24–72 h: `--sev-1` (yellow — getting old)
- 72–168 h: `--sev-2` (orange — overdue)
- > 168 h: `--sev-3` (red — really overdue)

#### Task row (expanded)

```
┌─────────────────────────────────────────────────────────────┐
│ ⬜  Sign Caixa Enginyers loan document    58h  3m  user  ⋯  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  📅  Due Thu 14 May  (in 2 days)                  [change]   │
│                                                               │
│  CONTEXT                                                      │
│  ───────                                                      │
│  Loan paperwork from May 6, escalated to "sign-now"          │
│  status Saturday 21:01. 58 h of weekend non-action on a      │
│  5-minute financial obligation.                              │
│                                                               │
│  📧 Original email (May 6)                                    │
│  📧 Sign-now reminder (Sat 21:01)                             │
│  📝 Loan terms attachment                                     │
│                                                               │
│  History (3 events)                          [Expand log ▾]  │
│                                                               │
│  ┌──────────────┬─────────────┬─────────────┐                │
│  │Mark resolved │ Reschedule… │ Snooze 4 h  │                │
│  └──────────────┴─────────────┴─────────────┘                │
│  ┌──────────────┬─────────────┬─────────────┐                │
│  │ Dismiss…     │Open in chat │ Edit text   │                │
│  └──────────────┴─────────────┴─────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

- Drawer background `--bg-row-expand`, 1 px `--border-strong` top edge
- **Due-date row (v3.2)**: rendered at the top of the drawer as `📅 Due <weekday> <day> <month> (<relative>)` — e.g. `Due Thu 14 May (in 2 days)`, `Due today`, `Due tomorrow`, `Due Mon 19 May (next week)`. Color uses `--sev-N` matching how overdue the row is: `--fg-muted` for `≥ +2 days`, `--sev-1` for tomorrow, `--sev-2` for today, `--sev-3` for past-due. **Omitted entirely if `due_date IS NULL`** (no placeholder, no "Due: —") — keeps the drawer clean for the common "due whenever / today" case. The `[change]` button is a shortcut to the reschedule picker (§7.8).
- Linked-artifact buttons: chip-style, 28 px tall, leading icon, hover shows the deep-link URL in a footer tip
- Action buttons: 3-column grid, 32 px tall; primary action ("Mark resolved") tints `--status-done` on hover

#### Filter chips + progress bar (top of tasks section)

```
┌─────────────────────────────────────────────────────────────┐
│  ▓ All today 8/12   ◯ Unfinished 4   ◯ Rescheduled 3        │
│  ◯ Dismissed 1      ◯ Resolved 8     Group: axis ▾          │
│                                                               │
│  ████████████░░░░░░░░  67%                                    │
└─────────────────────────────────────────────────────────────┘
```

- Active chip: filled `--bg-row-expand`, white text, 1 px `--border-accent`
- Inactive chip: transparent, `--fg-secondary` text, 1 px `--border-subtle`
- Count badge in each chip: mono tabular-nums, 10 px
- Progress bar: 4 px tall, full-width, gradient from `--sev-3` (low) through `--sev-1` to `--status-done` (high)
- Clicking the bar copies "67% done — 8 of 12" to clipboard (small affordance for sharing status)

#### Dismiss popover

```
┌──────────────────────────────────────────────────┐
│  Why are you dismissing this task?               │
│                                                   │
│   ○ Not a task                                    │
│   ○ Not relevant                                  │
│   ○ Wrong priority — should be lower             │
│   ○ Duplicate of another task                    │
│   ○ Out of scope                                 │
│   ○ Other                                         │
│                                                   │
│  Note (optional):                                 │
│  ┌───────────────────────────────────────────┐    │
│  │                                            │    │
│  └───────────────────────────────────────────┘    │
│                                                   │
│   [ Cancel ]                       [ Dismiss ]    │
└──────────────────────────────────────────────────┘
```

- Centered above the dismissed row, anchored with a subtle arrow connector
- Dimmed backdrop (`rgba(0,0,0,0.4)`) so the user knows it's modal
- Dismiss button colored `--status-dismiss` (purple — distinct from "destructive red")
- Cancel button neutral; pressing `Esc` cancels

### 13.6 Density gradient (top → bottom)

The Exec panel is intentionally **denser top-to-bottom**:

| Section  | Cognitive mode                                   | Density                                  |
| -------- | ------------------------------------------------ | ---------------------------------------- |
| Graphs   | **Glance** — eye sweeps for color anomalies      | Sparse, large color blocks, minimal text |
| Calendar | **Scan** — eye reads left-to-right across 7 days | Medium, equal columns with text + bar    |
| Tasks    | **Read** — eye stops on rows, scans details      | Dense rows with rich chip metadata       |

The eye warms up before hitting the dense content — by the time you reach the task board you're in close-reading mode. Putting tasks at the top would invert that and exhaust the user.

### 13.7 Affordances and discoverability

- **`⋯` glyph** on every task row (visible on hover) signals the right-click menu is also click-accessible
- **Tooltip** on the DEV/EXEC toggle reads "Toggle modes (⌘⇧E)" so the keyboard shortcut is discoverable
- **Hover-elevate** on every interactive element (rows, chips, cells) — never on non-interactive elements
- **Cursor changes**: pointer on click targets, col-resize on vertical splitters, default elsewhere
- **Empty states**: friendly copy ("Nothing pending — go outside" / "No briefing yet today — type /new"); subtle illustration in muted color
- **Drag-handle visibility**: splitters are invisible until hover, then a 2 px line + grab cursor

### 13.8 CSS architecture

- All colors via CSS variables, themed at `:root[data-theme]`
- Container queries on the left panel (`@container exec-panel`) for responsive behaviour at different widths
- All transitions wrapped in `@media (prefers-reduced-motion: no-preference)` so accessibility is automatic
- High-contrast mode override increases all border opacities by 60% and removes background tints
- No CSS-in-JS — vanilla CSS in `tinker-ui/src/styles.css` extending the existing token system
- Total CSS budget: ~250 lines for the entire Exec panel including motion

### 13.9 The "alive" feeling (polish budget ~250 lines CSS + 50 lines JS)

These touches make the panel feel like a living thing, not a static dashboard:

1. **Today's calendar column quietly pulses** — 1.5 s ease-in-out border-opacity loop, just enough to draw the eye periodically
2. **Auto-resolve ✨ sparkle** — when a task auto-resolves via signal, a brief sparkle flashes for 600 ms before the standard fade. Builds trust in the automation.
3. **Age chip color shift** — gradually shifts hue as the task ages. Subliminal urgency cue.
4. **Progress bar fill animation** — when a task completes, the bar eases smoothly into the new width, doesn't jump
5. **Traffic-light pulse on alert** — a failing surface pulses for 5 s when it transitions red
6. **Empty-state warmth** — "Nothing pending — go outside" instead of stark "0 tasks"
7. **Hover-then-reveal `⋯` menu** — discoverable but not noisy
8. **Click-to-expand drawer easing** — feels physical, not jumpy

Together these convert the panel from "a list of stuff" into a working environment that feels good to be in.

---

## 14. Replacing Todoist (NEW v3.1)

The Control Panel's task subsystem is designed to replace **Todoist** as Oscar's primary task store. Three honest gaps relative to Todoist that need plans before the migration is clean — all addressable.

### 14.1 Gap A — Mobile / away-from-Tinker capture

Tinker UI is a desktop web app. Today Todoist gets used from phone (add a task while walking, Siri shortcut, share sheet, widget).

The Control Panel's mobile-capture path is **already mostly built**: WhatsApp / Jarvis chat is the ingress. Oscar can DM Jarvis "add 'pick up dry cleaning' under family" and the MCP tool `control_panel_tasks_add` fires — same goes for voice calls (existing voice-call plugin), iMessage (existing bluebubbles channel), email (existing himalaya skill).

To make it seamless:

- Jarvis recognizes a short natural-language pattern for task adds (regex + LLM intent classification — already handles richer flows)
- (Optional, later) Telegram bot mirroring the task MCP tools for users without WhatsApp
- (Optional, later) Tinker UI as a PWA, so it's mobile-installable for direct access

### 14.2 Gap B — Recurring tasks (added to v3.1 schema)

Todoist supports natural-language recurrence ("every Tuesday", "monthly on the 15th"). The v3.1 task table now carries:

```sql
recurrence_rule_text TEXT,                  -- iCal RRULE format
recurrence_parent_id TEXT REFERENCES task(id);
```

On resolution of a task with `recurrence_rule_text`, the auto-resolver spawns a new task with the next `due_date` computed from the RRULE and `recurrence_parent_id` set to the root. A single "every Tuesday at 9 AM" task becomes a chain of weekly instances.

Implementation is ~150 lines: an iCal RRULE parser (`rrule` npm package, ~30 KB) + spawn-on-resolve logic in `src/tasks/lifecycle.ts`. Adds to the v3.1 build.

### 14.3 Gap C — Direct ad-hoc task creation in Tinker UI

The Exec panel's "Add Task" button (§7.5) opens a wizard with: text · axis · priority_rank · due_date · est_minutes · hands · context_md · inferred_signal (advanced, optional) · recurrence_rule_text (advanced, optional).

This covers the "I'm at my desk, I want to add a task" case that's currently Todoist's web app.

### 14.4 Migration path

| Step | Decision / action                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Choose: import or start fresh.** Current Todoist API token is expired (broken 15 days, per preflight). Import requires one-time token rotation; start-fresh requires nothing.                                                                                                                                                                                           |
| 2a   | **If importing**: rotate the Todoist token once, call `todoist.tasks.list` for both projects (`SERRA Work` `6g4Hq9fWCGwGWqvj` + `PROJECT Workshop` `6g4HvJ57235xpC7m`), map each task → `control_panel_tasks_add` with `priority_axis = 'serra'` and the original due dates / labels preserved in `metadata_json`. One-shot script in `scripts/migrate-from-todoist.mjs`. |
| 2b   | **If starting fresh**: skip the import. Todoist's recent state is sparse anyway (subscription on the brink, token broken 15 days). Briefing's daily passes naturally re-surface what matters.                                                                                                                                                                             |
| 3    | Use the Control Panel for **2 weeks** while Todoist subscription stays paid (rollback safety net).                                                                                                                                                                                                                                                                        |
| 4    | After 2 weeks of confident usage: **cancel Todoist subscription**. Resolves three carry items in MEMORY.md naturally: "Todoist token rotation pending", "card-on-file update", "recurring failed-payment emails".                                                                                                                                                         |

**Recommendation**: start fresh (2b). Lower friction, the SERRA tasks worth keeping will reappear via the briefing within the first few days.

### 14.5 Net consequences

- **Saves $7 / month** (Todoist subscription).
- **Resolves four pending items** from the morning briefing: Todoist token rotation · card-on-file update · two recurring failed-payment emails.
- **Removes one recurring auth-failure point** from preflight (Todoist 401 goes away forever).
- **Single source of truth**: tasks live in the Control Panel store, no sync conflicts.
- **Better semantics**: Todoist had projects + labels + priorities, but no notion of `priority_axis` / `hands` / `inferred_signal` / `dismissal_kind`. The Control Panel's task model is genuinely richer for an LLM-assisted workflow.

### 14.6 Future capture endpoints (post v3.1)

Oscar already has the `apple-reminders` (`remindctl`) and `things-mac` skills installed. Both are candidates for future capture endpoints into the Control Panel:

| Surface             | Direction                                                                                                                                                                                                                    | When                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Apple Reminders** | Bidirectional sync via `remindctl` polling. Tasks added via Siri / Reminders.app appear in Control Panel; Control Panel tasks tagged `surface_in_reminders` mirror to a "Tinker" reminders list for cross-device visibility. | Post v3.1, after Control Panel is proven |
| **Things 3**        | Read-only mirror via the `things` URL scheme. Tasks display in Things 3's Today view. Not bidirectional (Things 3 doesn't expose a clean inbound API).                                                                       | Post v3.1, optional                      |

These are NOT in scope for the initial Control Panel build. They become attractive once the core is proven and Oscar wants cross-device task visibility on iOS / Mac.

---

Anything you'd add or revise?
