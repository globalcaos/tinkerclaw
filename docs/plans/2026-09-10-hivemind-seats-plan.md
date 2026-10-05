# Hivemind seats — one agent, N operators

Date: 2026-09-10
Status: A–E written, not running. Unit F (hive deploy / stop-inject / device-auth) not started.

**Landed 2026-09-12 in `381d6d3c726`** (swept into a parallel session's `fix(tinker-ui): sessions.list omits default filters` commit while staged; that subject names only its own two files — this note is the record). Units A–E server-side + desk + the owner-desk fallback (C1 amendment below); `tinker-ui/src/app.ts` (login redirect, banner, seat wiring) is still uncommitted because its seat hunks sit among unrelated WIP; `extensions/tinkerclaw-task-panel/package.json` rename excluded as unrelated. Contact first names → Alice/Bob and home paths → `~` for the public fork.
Repository: tinkerclaw
Spec: derived from the owner's notes of 2026-09-09 13:56 + 15:56 (door / conductor / desk / sessions list / tasks). Canonical design note: private, kept in the agent memory, not in this repo.
Recipe: `extensions/tinkerclaw-prefrontal/recipes/implementation-plan/recipe.md` v2.1.0
First hive: a second agent (called HIVE in this plan) on a lab server, URL `http://<server>:18899/tinker/`

This file is the audit trail. Implementation amends it in the same commit as any departure.

## Purpose, evidence, revision

Upgrade tinkerclaw so **one agent** can be used by **more than one human** without cloning the house. The product is seats, not houses. The hive agent is the first hive (Alice, Bob, the owner). The same code path must work for Jarvis later; do not special-case the hive agent in the UI.

Evidence: live hive config 2026-09-09/10 (proxy injects Bearer; `dangerouslyDisableDeviceAuth` on; one `tinker-ui-state.json`; tasks.hands is user/assistant/either; sessions.list has no operator filter; `#agent-name-text` paints `agent.identity.get` name only; the hive agent's `USER.md` blank). The owner’s 15:56 correction: tasks and the sessions _list_ are personal; the archive is not; secrecy is not the goal; tabs must survive tomorrow; IT must not wander in.

Revise this plan when a store named below is found to already key by device, or when device-auth cannot carry a human name. Do not invent a second gateway because a UI filter is missing.

## 0. Vocabulary (load-bearing)

| Word               | Meaning                                                                                                | Fork?                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **House / genome** | Soul, recipes, skills, MEMORY on disk, models, keys, spend, crons, graphs, code, forensic-of-the-agent | **No.** One hive agent.                                                                            |
| **Archive**        | Every session jsonl on disk                                                                            | **No.** The hive agent reads across seats.                                                         |
| **Door**           | Who may talk to the house at all                                                                       | **Yes, as a gate.** Token known by the humans and the owner. A new computer without it is refused. |
| **Seat**           | A paired browser / device, mapped to a human name                                                      | **Yes.** This is Alice vs Bob.                                                                     |
| **Conductor**      | The human sitting here, from the agent’s point of view                                                 | **Yes.** Banner `HIVE (Alice)`. Injected into the turn.                                            |
| **Desk**           | Open tabs, folds, pins, drafts, EEG, Exec layout                                                       | **Yes.** “The tabs you have open remain so next day.”                                              |
| **Board**          | Tasks                                                                                                  | **Yes, as a filter.** Same SQLite; rows tagged with the operator.                                  |
| **Pulse**          | Graphs / department KPIs, crons                                                                        | **No.** Company-wide.                                                                              |

**This is not:** `agents.list` home/work (two personalities). `openclaw --profile alice` (two hive agents). A second Jetson port that still auto-injects (IT still walks in). Hiding the token in the URL _and_ injecting it (hide = good, inject = the hole).

Secrecy between Alice and Bob is **not** the product. Practicality is: my tabs, my list, my tasks, the hive agent knows it is me.

## 1. Intended end state (owner-visible)

A stranger on the lab net / tailnet opens `http://<server>:18899/tinker/` and **does not get the hive agent**. They see a login (or a pairing prompt). The owner, Alice, or Bob types the token once; that browser stores it; the URL stays clean.

After pairing, the top bar reads **`HIVE (Alice)`** (or Bob, or the owner). A turn started from that browser is told who the conductor is. Alice’s Sessions panel lists Alice’s threads. Bob’s lists Bob’s. The hive agent still has every jsonl on disk and may draw from all of them. Alice’s Today is not Bob’s. Graphs and crons are the same board. Closing Chrome and coming back tomorrow restores **that person’s** tabs.

Green is what the owner can see on the hive agent’s URL, not a unit test.

## 2. Current vs target (the five stores)

| #   | Split             | Today (measured)                                                                                                                                                                                                                                                                                                                                             | Target                                                                                                                                                                                                                                                                                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Door**          | The Jetson door proxy injects `Authorization: Bearer` on every request. `dangerouslyDisableDeviceAuth` + `allowInsecureAuth` on. A new PC on `<server>:18899` is already in. Tinker route is `auth: "gateway"` (Bearer only; `?token=` 401s). Plugin also injects `window.__TINKER_CONFIG={token}` into HTML once past the gate.                             | Stop injecting at the proxy. Browser presents Bearer (login page stores it in that origin). No token → 401 / login, never the hive agent. URL still has no `?token=`. Optional later: 4-digit page in front.                                                                           |
| 2   | **Conductor**     | `#agent-name-text` = `agent.identity.get` → `ui.assistant.name` (`HIVE`). `USER.md` on the hive agent is the blank stock file. No per-seat overlay in bootstrap.                                                                                                                                                                                             | Banner `HIVE (Alice)`. Bootstrap injects a short conductor overlay (name, how to address them) for this turn only. Genome `USER.md` can stay a department note; the overlay is the person in the chair.                                                                                |
| 3   | **Desk**          | One file `~/.openclaw/data/tinker-ui-state.json`. Endpoint `GET/POST /api/ui-state` (prod: `scripts/tinker-prod-ui.mjs`; Vite: `tinker-ui/vite.config.ts`; **native `/tinker/` on the hive agent does not host this file** — last-writer-wins was designed in `tinker-ui/src/panels/ui-state.ts`). Chrome wipes localStorage on exit; the file is the truth. | Key the file by seat id: `tinker-ui-state.<seatId>.json` (or a `seats/` dir). Hydrate/mirror send `X-Tinker-Seat` (or the device token). Last-writer-wins **per seat**, not across humans. Native `/tinker/` must grow the same endpoint so the hive agent is not a special snowflake. |
| 4   | **Sessions list** | `sessions.list` returns the pool. UI filters by recency/tokens/key, not by operator (`tinker-ui/src/app.ts` `renderSessionsTab`).                                                                                                                                                                                                                            | RPC grows `operatorId` (or `seatId`). Panel default = this conductor’s threads. A “all / hive” toggle is allowed (secrecy is not the goal) but must not be the default. Archive on disk unchanged.                                                                                     |
| 5   | **Tasks**         | One SQLite `~/.openclaw/data/control-panel/store.db`. `hands` ∈ {user, assistant, either} — a _role_, not a person (`extensions/tinkerclaw-control-panel/docs/SPEC.md`).                                                                                                                                                                                     | Add `operator_id TEXT` (nullable = shared/department). Today filter defaults to this conductor. Graphs stay unfiltered. Crons stay shared.                                                                                                                                             |

Device auth is the **seat**, not the door. Turn `dangerouslyDisableDeviceAuth` back off **after** the door is real, otherwise the pairing prompt is how IT walks in under a friendlier name. Map `device.pair` record → operator display name (`Alice` / `Bob` / `Owner`). Existing Nodes tab already lists pending/paired devices (`device.pair.list`).

## 3. File map (product)

Paths relative to the tinkerclaw repo unless marked host-local.

| File                                                                           | Responsibility                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/tinkerclaw-tinker/index.ts`                                        | `/tinker/` auth posture; stop baking the gateway token into HTML once the browser holds it; add `/tinker/api/ui-state` (parity with prod server) keyed by seat. |
| `tinker-ui/src/panels/ui-state.ts`                                             | Hydrate/mirror pass seat id; do not POST a missing seat onto the shared file.                                                                                   |
| `tinker-ui/src/app.ts`                                                         | Login-or-token bootstrap; `refreshAgentNameHeader` paints `NAME (Conductor)`; Sessions panel default filter; pass seat on `sessions.list`.                      |
| `scripts/tinker-prod-ui.mjs`                                                   | `/api/ui-state` path becomes `tinker-ui-state.<seatId>.json`; refuse writes with no seat **only under `TINKER_REQUIRE_SEAT=1`** (amended 2026-09-10, see C1).   |
| `tinker-ui/vite.config.ts`                                                     | Same ui-state keying (dev parity). Keep until Vite is fully gone.                                                                                               |
| `src/gateway` sessions list handler (locate in implement: `sessions.list` RPC) | Accept `operatorId` / `seatId`; filter keys owned by that seat; unfiltered remains available to the agent runtime.                                              |
| `extensions/tinkerclaw-control-panel/` schema + RPCs                           | `operator_id` column + Today default. `hands` unchanged.                                                                                                        |
| `src/agents/workspace.ts` + bootstrap helpers                                  | Optional conductor overlay file or in-memory bootstrap chunk, not a second `USER.md` in the genome.                                                             |
| `extensions/tinkerclaw-identity-persistence/`                                  | Do not impersonate the conductor; do not overwrite SOUL. Conductor is a _context_, not a personality swap.                                                      |

**Host-local (first hive, not the public genome):**

| File                                          | Responsibility                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Jetson `~/<agent>/proxy.py` (live door)       | **Stop injecting Authorization.** Forward headers the browser sent. 401s pass through. |
| Hive `openclaw.json`                          | After door is real: `dangerouslyDisableDeviceAuth: false`. Origins unchanged.          |
| Hive workspace `operators/*.md` or equivalent | Per-human conductor blurb (how to address Alice). Not SOUL.                            |
| Laptop `~/.openclaw/<agent>-tunnel/tunnel.py` | Already disabled. Do not resurrect as a second door.                                   |

## 4. Interfaces (owned names)

```ts
/** Stable id of a paired browser. Gateway device-auth token id, not a display name. */
export type SeatId = string;

/** Human in the chair. Displayed. Known to the agent this turn. */
export type OperatorId = "oscar" | "alice" | "bob" | string;

export type Seat = {
  seatId: SeatId;
  operatorId: OperatorId;
  displayName: string; // "Alice"
  pairedAtMs: number;
};

/** Banner contract. Identity plugin paints agent name; Tinker appends conductor. */
export function formatAgentBanner(agentName: string, conductor?: string): string {
  const a = agentName.trim();
  const c = conductor?.trim();
  return c ? `${a} (${c})` : a;
}

/** Durable desk. One snapshot per seat. Missing seat => 404, never the shared file. */
// GET  /api/ui-state            header X-Tinker-Seat: <seatId>
// POST /api/ui-state            header X-Tinker-Seat: <seatId>  body: UiStateSnapshot
// store: ~/.openclaw/data/seats/<seatId>/tinker-ui-state.json

/** Sessions list. Default filter is this operator's threads. */
// sessions.list({ operatorId?, includeHive?: boolean, ...existing })
// includeHive true => current unfiltered behaviour (archive view)
// default includeHive false when a seat is bound

/** Tasks. Same DB. */
// ALTER TABLE task ADD COLUMN operator_id TEXT;  -- NULL = department / shared
// control-panel.tasks.list({ operatorId, includeShared?: boolean })
// Today chip: operatorId = this conductor, includeShared true (department tasks still show)
```

Door contract (no new RPC):

- Browser origin stores the gateway token in `sessionStorage` or a non-URL credential (never `localStorage` if the owner’s Chrome wipes it — prefer a tiny HttpOnly cookie set by a `/tinker/login` POST, or `sessionStorage` plus a “remember this browser” that writes through device-auth).
- `window.__TINKER_CONFIG.token` must **stop** being the gateway token copied from config once the door is real. Today that injection is how a loaded page authenticates the WS hello. After the door: the page only loads if the request already carried Bearer (or a session cookie the proxy does not mint). The plugin reads the presented token; it does not gift one.
- `?token=` stays 401. Measured 2026-09-07; do not reopen.

Conductor overlay (bootstrap, one chunk, evictable):

```
## Conductor this turn
You are talking to **Alice**. Address him as Alice. Department context stays in USER.md.
Do not become Alice. Do not hide the owner’s existence. This overlay is who is in the chair, not who owns the house.
```

## 5. Phases (edit-units)

Wave **isolate** first (each has its own test, no mutual writes). Wave **integrate** after. Do not ship the hive agent a half-door.

### Unit A — Door (wave: isolate) `complexity: complicated`

**A1.** Login surface: a `/tinker/login` page (woody/cream, no genome leak) POSTs the token, sets a same-origin session (cookie or in-memory + device pair). Verify: `curl -sI http://127.0.0.1:18789/tinker/` → 401; `curl -sI -H 'Authorization: Bearer <real>'` → 200 HTML.

**A2.** Stop HTML token gift: `getIndexHtml()` in `extensions/tinkerclaw-tinker/index.ts` must not interpolate `gateway.auth.token` once A1 is live. WS hello uses the browser-held credential. Verify: view-source of a 200 `/tinker/` contains **no** gateway token string (grep the live HTML).

**A3.** Door proxy: remove `inject()` Authorization rewrite in Jetson `~/<agent>/proxy.py`. Forward `Authorization` if the client sent one. Verify from a machine on the lab net: no header → 401 body is the login page, **not** Tinker chrome. With header → Tinker.

**A4.** Only after A1–A3 green on the hive agent: `dangerouslyDisableDeviceAuth: false`. Pair the owner’s browser first, then Alice, then Bob. Verify: unpaired browser after token still cannot skip pairing; Nodes tab shows pending.

Rollback: re-enable inject + `dangerouslyDisableDeviceAuth: true` is the known-good hive door of 2026-09-09. Keep that as a one-command revert until A3 has been live a day.

### Unit B — Seat identity (wave: isolate)

**B1.** Map `device.pair` → `OperatorId`. Small table `~/.openclaw/data/seats/operators.json` (or gateway config `tinker.operators`) `{ deviceId, operatorId, displayName }`. The owner assigns names when approving a device (Nodes tab already has Approve). Verify: `device.pair.list` row carries `displayName`.

**B2.** `formatAgentBanner` + `refreshAgentNameHeader` in `tinker-ui/src/app.ts`. Verify: screenshot / DOM `#agent-name-text` equals `HIVE (Alice)` on a paired Alice seat. Unpaired-but-authed (the owner during rollout) stays `HIVE`.

**B3.** Conductor overlay in bootstrap. Verify: a probed turn’s system/bootstrap chunk contains `Conductor this turn` and the display name; SOUL/IDENTITY unchanged (diff those files = empty).

### Unit C — Desk (wave: isolate)

**C1.** Move store path to `~/.openclaw/data/seats/<seatId>/tinker-ui-state.json`. `scripts/tinker-prod-ui.mjs` + Vite middleware + **new** `/tinker/api/ui-state` on the plugin (the hive agent’s native path). Missing `X-Tinker-Seat` → 400, never write the legacy shared file. Verify: two seats POST different `tabs`; GET each returns only its own; legacy file is not overwritten.

> **Amended 2026-09-10 18:40 (regression, the owner: "upon restart, in the production tinker ui, the tabs open before turning off don't appear open").** The unconditional 400 shipped to the laptop's `:18793` (this script runs from the working tree, and `tinker-ui/dist` was rebuilt at 15:55 with the seat-gated client) before any door assigns a seat there. Result: every hydrate returned 400, the client's own `if (!seat) return` stopped mirroring, the desk file froze at 09:33, and the 17:52 reboot came back with a lone Main while nine tabs sat in the file. **New rule, in all three servers:** a seat-less request lands on the **owner desk** (`~/.openclaw/data/tinker-ui-state.json`, `ownerDeskPath()` / `uiStatePath(null)` in `src/shared/hivemind-seats.ts`); the 400 applies only in **hive mode, `TINKER_REQUIRE_SEAT=1`** in the serving process's environment (set it on the hive agent once unit A's door exists — unit F). The client CARRIES `X-Tinker-Seat` when `sessionStorage` names one and never treats its absence as a reason not to mirror. Verify (done on the laptop): fresh headless Chrome against `:18793` → GET 200, nine tabs restored, POST 200 lands on the owner desk; the C1 two-seat check stands unchanged with the header present.

**C2.** Client: `hydrateUiState` / `scheduleUiStateMirror` send the header. Cold start with empty localStorage still restores **this** seat’s tabs. Verify: the owner’s Chrome-clear-on-exit path — close browser, reopen, tab list matches last snapshot for that seat.

### Unit D — Sessions list (wave: isolate)

**D1.** Tag new webchat sessions with `operatorId` / `seatId` at creation (session metadata, not the jsonl filename). Existing sessions: untagged = hive/owner-era, visible to the owner, hidden from Alice/Bob defaults. Verify: `sessions.list({ operatorId: "alice" })` omits Bob’s keys; `includeHive: true` returns both.

**D2.** Panel default = this conductor. Optional “hive” chip. Verify: Alice’s Sessions panel count ≠ Bob’s on the same gateway, same minute.

### Unit E — Tasks (wave: isolate)

**E1.** Migration: `operator_id TEXT` nullable on `task`. RPCs accept it. Today filter: `operator_id = this OR operator_id IS NULL`. Graphs queries unchanged. Verify: insert one Alice task + one Bob task + one NULL; Alice Today shows Alice+NULL only; a graphs RPC row count is unchanged.

### Unit F — Integrate + first hive (wave: integrate)

**F1.** Build tinker-ui, dist-swap the hive agent (or copy dist + plugin source the way forensic logos shipped 2026-09-09). Restart the hive gateway once. Verify on the **served** URL, not source: login, banner, tabs, sessions count, Today.

**F2.** Pair the owner, then Alice, then Bob. Do not pair an IT laptop. Verify: a fourth unpaired browser with no token never paints `#agent-name-text`.

**F3.** Docs: this plan’s status table; `TOOLS.md` hive-agent section “door is real”; private seats note pointer. No public README claim until F1 is owner-green.

## 6. Test tiers (per unit, expected output)

| Unit       | Unit test                                              | Seam                           | Owner green                                          |
| ---------- | ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| A Door     | `authorize` without Bearer → 401                       | `curl -sI` two ways            | Browser without token sees login, not the hive agent |
| B Banner   | `formatAgentBanner("HIVE","Alice") === "HIVE (Alice)"` | `agent.identity.get` + overlay | `#agent-name-text` in a **looked-at** render         |
| C Desk     | two temp dirs, two seats, no cross-write               | GET/POST `/api/ui-state`       | Chrome exit + reopen restores _that_ tab list        |
| D Sessions | fixture jsonl tagged                                   | `sessions.list` counts         | Panel counts differ per human                        |
| E Tasks    | sqlite migration + list filter                         | Today RPC                      | Alice Today ≠ Bob Today; graphs count unchanged      |
| F Hive     | —                                                      | —                              | The owner does A–E on `<server>:18899` himself       |

Presence in source is not appearance. Native `/tinker/` on the hive agent is a different server than laptop `:18793`. Every ui-state change must land in **both** or the hive agent stays last-writer-wins.

## 7. Risks

| Risk                                   | Why                                                     | Carried by                               |
| -------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Stopping inject before login exists    | Locks the owner out of the hive agent                   | A1 before A3; revert script ready        |
| Device-auth on while inject still on   | Pairing is theatre; IT still in                         | A3 before A4                             |
| `__TINKER_CONFIG.token` leftover       | Token in HTML = token in every cache                    | A2 grep of served HTML                   |
| Ui-state on prod server only           | The hive agent's `/tinker/` never writes the file today | C1 plugin route                          |
| Filtering archive in the agent runtime | The hive agent would forget Bob when talking to Alice   | D filters the **panel**, not jsonl reads |
| Refreshing Grok on the hive agent      | Revokes Jarvis (`invalid_grant` 2026-09-10)             | Out of scope here; already guarded       |
| Second gateway as “shortcut”           | Two houses, two spends, two souls                       | Forbidden in §0                          |
| Conductor overlay mutating SOUL        | Personality swap                                        | B3 diff empty                            |

## 8. Proof (what “hivemind works” means)

1. Unauthed GET `<server>:18899/tinker/` is not the command center.
2. Authed Alice browser: banner `HIVE (Alice)`, her tabs, her session list, her Today.
3. Authed Bob browser, same minute, same gateway: different tabs / list / Today, same graphs.
4. The hive agent, asked a department question, can cite a thread that is not on the current Sessions panel (archive is shared).
5. Tomorrow, Alice’s Chrome still has yesterday’s tabs.
6. An IT laptop with the URL and no token cannot prompt.

## 9. Out of scope (this plan)

- Identity spine parity (the hive agent's `AGENTS.md` / `VOICE.md` / full Jarvis operating rules). Separate; the owner parked md files 2026-09-10.
- Password page in front of the proxy (optional extra door; token-required is the minimum).
- Per-user tokens (nice later; one house token + seats is enough for “IT must not wander”).
- Splitting crons, graphs, keys, models, MEMORY.
- Mia revival, Lia, `--profile` anything.
- Public cloner UX. Hivemind is a raised-child feature first; cloners get it when the artifact boots it.

## 10. Rulings ledger

- Ruling: Claude Code credit-dead + Codex Plus window exhausted — implemented in-tree rather than via coding-agent. Cost if wrong: less review coverage; mitigated by unit tests on helpers.
- Ruling: conductor overlay not injected into bootstrap this turn — banner + storage keys only. Cost: the hive agent will not yet be _told_ who is in the chair until B3 lands.
- Ruling: did not stop the door proxy inject or toggle device-auth (Unit F / A3–A4). Cost: door is source-only; live URL still unlocked.

## 11. Status

| Unit | Task                                                            | Status                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Door (login, no HTML gift, proxy stop-inject, then device-auth) | **A1–A3 LIVE on the hive agent 2026-09-15** (login asks name + token; token written into the page only for a request that presented it; Jetson proxy injection removed, backup `proxy-inject-backup-2026-09-15.py`). A4 device-auth still off |
| B    | Seat → conductor banner + overlay                               | **B1–B2 LIVE**: the seat is the name typed at the door (`operators.json`, `tinker_seat` cookie); headless Chrome through `<server>:18899` read `#agent-name-text` = "HIVE (<owner>)", second tab no re-login. B3 overlay not in bootstrap yet |
| C    | Desk keyed by seat                                              | client carries `X-Tinker-Seat` (seat copied before hydrate); server routes it; two-person check not run yet                                                                                                                                   |
| D    | Sessions list filter                                            | written, not running                                                                                                                                                                                                                          |
| E    | Tasks `operator_id`                                             | written, not running                                                                                                                                                                                                                          |
| F    | Hive deploy                                                     | **done by pull** (standard since 2026-09-15: code changes only arrive by `git pull`): origin/main `01bf3e2002b`, `pnpm build` + tinker-ui build rc 0, bundle `index-DC2Vsnq8.js` = laptop build hash                                          |

From here, implementation-detail choices are rulings, not questions — except irreversible steps (hive gateway restart, disabling inject, turning device-auth on). Those still ask, or use the already-granted “restart the hive agent freely” only inside unit F after A is green.

## 12. Why this order

Door first: everything else is cosmetics on an unlocked house. Seat identity second: banner, desk, list, and tasks all need a name to key. Desk before list because the owner’s actual pain was “tabs tomorrow,” not secrecy. Tasks last of the five because the board already exists; it needs a column, not a new product. Integrate only on the hive agent’s **served** URL — laptop `:18793` is a different door.
