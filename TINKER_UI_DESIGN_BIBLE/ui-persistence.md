---
file: ui-persistence.md
purpose: How a piece of Tinker UI chrome remembers its state across a reload, and how to make a new control do it. Owns the unified UI-state persistence contract — the invariant, the two storage tiers (a durable JSON file plus a synchronous localStorage cache), the owning module, the namespaces and keys (three maps plus the tab list), the id registry, the legacy migration, and the browser wipe that made the file tier necessary.
audience: AI
status: DEPLOYED — both tiers landed 2026-08-02 and ALL EIGHT gates are green (re-run 2026-08-19; the count is the verify list's length, so it moves whenever a gate is added — do not read an older tally as a claim about today). The file tier was additionally exercised live against the running Vite dev server on :18790 (GET 200, POST 200, malformed body 400, DELETE 405) and ~/.openclaw/data/tinker-ui-state.json holds real mirrored state. Gate 4 caught a genuine regression on the way in — see the build.target invariant below. 2026-08-16 — the tab LIST joined the store as a fourth namespace, REVERSING this file's own "deliberately OUT" ruling; see that section for why the reversal was correct. Verified by 82 unit tests, the endpoint contract against an isolated dev server, and a 9/9 real-browser restart test. 2026-08-18 — the Crons-tab folds (`cron:card:*`, `cron:dismissed:*`) opted in; proven with a headless cold-start test against the live dev server (collapse 2 of 18 cards → fresh browser context with empty localStorage → both still collapsed, the other 16 still open, and re-expanding deleted both keys). 2026-08-19 — the Crons-tab card ARRANGEMENT (`cron:cardOrder`) joined the choices namespace, with the order rule extracted as a pure, unit-tested `applyStoredOrder()`. Same day, later: filter + groups (`cron:filter`, `cron:taxonomy`, `cron:group:*`) joined as chrome, not findings — they do not borrow the task-axis tree. Card drag left HTML5 `draggable` for pointer-event DnD so a collapsed header can move without fighting the fold click. Subitem order needed no change — it was already durable server-side in the cron-panel board store.
last_verified: 2026-08-19
last_verified_commit: a63e41ea3af
single_owner: yes — persistence-of-chrome facts live here. panels.md owns which panels are VISIBLE when; right-rail-interaction.md owns per-session vs global scoping; tinker-ui.md owns the visual language. This file owns what SURVIVES a reload and how.
see_also: panels.md (visibility contract, and the right-rail inventory that no longer lists the EEG as its own panel), right-rail-interaction.md (per-session vs global state), design-principles.md (#18 one canonical derivation per concept — ui-state.ts is that derivation for chrome persistence), session-naming.md (tab names went server-side for exactly the wipe documented below — the precedent this file-backed tier follows), tinker-ui.md (the EEG seismograph itself; this file owns only its collapse ids and the binding consequences of where it sits)
invariants:
  - absent means the caller's stated default — an entry exists only when the user's choice differs from the default, and agreeing with the default deletes the entry. The two-tier split does not touch it; it holds through hydrate and through the mirror POST, because both move the same three maps verbatim. It governs the three MAPS only: the tab list is one whole value with no per-entry defaults to express, so its rule is the plainer absent-means-no-opinion one below
  - the DURABLE truth is ~/.openclaw/data/tinker-ui-state.json over GET|POST /api/ui-state; localStorage is a synchronous CACHE of it, never the source of truth
  - hydrateUiState() never rejects — it is awaited at module top level in app.ts, so a rejection would abort module evaluation and black-page the whole UI; every failure path resolves quietly and leaves the cache as it was
  - the file wins on hydrate — a successful GET overwrites the three localStorage maps before any state is read
  - top-level await is a BUILD constraint, not a style choice; tinker-ui/vite.config.ts must carry a build.target of esnext or es2022+, because Vite otherwise defaults to ESBUILD_MODULES_TARGET (es2020, chrome87) under which esbuild refuses to emit top-level await
  - tinker.rpanelCollapsed / tinker.uiFlags / tinker.uiChoices / tinker-tabs are written ONLY by tinker-ui/src/panels/ui-state.ts — the gate is stricter still, the key literals appear in NO other tinker-ui source file, so even reads route through the module; app.ts imports TABS_KEY rather than re-spelling the literal
  - no namespace invents a default of its own — the caller states the default at every call site
  - migrateLegacyUiState() is idempotent, and an existing new-store entry always wins over a legacy value
  - in the tabs namespace ABSENT and EMPTY are different answers, and conflating them is a data-loss bug — an absent `tabs` section means "no opinion" (hydrate leaves the cached list alone, and a POST omitting it carries the on-disk list forward), while `[]` means "no tabs" and is applied. A store written before 2026-08-16 has no `tabs`, so reading absence as empty would blank the live list on the first reload after any deploy
  - the tab list is carried VERBATIM through both tiers and the endpoint — app.ts owns the Tab shape, ui-state.ts owns only its durability, so no layer between them may filter Tab fields or each new field is dropped on its first cold boot
verify:
  - name: UI-chrome store keys are referenced only inside ui-state.ts (single-writer, any quote style or accessor shape)
    cmd: python3 -c 'import os,glob; root=os.path.expanduser("~/src/tinkerclaw/tinker-ui/src"); files=[f for f in glob.glob(root+"/**/*.ts",recursive=True) if os.path.basename(f) not in ("ui-state.ts","ui-state.test.ts")]; hits=[(os.path.relpath(f,root),k) for f in files for k in ("tinker.rpanelCollapsed","tinker.uiFlags","tinker.uiChoices","tinker-tabs") if k in open(f).read()]; assert not hits, "UI-chrome store keys referenced outside ui-state.ts (single-writer broken) -> " + str(hits)'
  - name: ui-state.ts exports the one-shot legacy migration (endstate gate for the 2026-08-02 unification)
    cmd: python3 -c 'import os; u=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/ui-state.ts")).read(); assert "export function migrateLegacyUiState" in u, "ui-state.ts does not export migrateLegacyUiState — the one-shot legacy fold is missing"'
  - name: the owning module is ui-state.ts and rpanel-collapse.ts stays renamed away
    cmd: python3 -c 'import os; p=os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels"); assert os.path.exists(os.path.join(p,"ui-state.ts")), "ui-state.ts missing"; assert not os.path.exists(os.path.join(p,"rpanel-collapse.ts")), "rpanel-collapse.ts is back — two owners for UI-chrome persistence"'
  - name: the durable tier is wired — /api/ui-state middleware, an exported hydrateUiState, and a build target that permits the top-level await it needs
    cmd: python3 -c 'import os,re; v=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/vite.config.ts")).read(); u=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/ui-state.ts")).read(); a=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "/api/ui-state" in v, "vite.config.ts has no /api/ui-state middleware — the durable JSON tier is gone and chrome state is browser-only again, which Chrome SESSION_ONLY then wipes"; assert re.search(r"export\s+(async\s+)?(function|const|let)\s+hydrateUiState\b", u), "ui-state.ts does not export hydrateUiState — nothing reads the durable tinker-ui-state.json back at boot"; tla=re.search(r"(?m)^await\s+hydrateUiState\s*\(", a); m=re.search(r"target\s*:\s*[\x22\x27](esnext|es(\d{4}))[\x22\x27]", v); assert (not tla) or (m and (m.group(1)=="esnext" or int(m.group(2) or 0)>=2022)), "app.ts top-level-awaits hydrateUiState but tinker-ui/vite.config.ts sets no build.target of esnext or es2022+ — Vite falls back to ESBUILD_MODULES_TARGET (es2020, chrome87) and esbuild REFUSES top-level await, so pnpm build fails while vite dev on 18790 keeps working"'
  - name: the Crons-tab folds route through ui-state and have not drifted back into in-memory Sets
    cmd: python3 -c 'import os; a=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); assert "cronCardFoldKey" in a and "cronDismissedFoldKey" in a, "app.ts no longer builds the cron:card / cron:dismissed ids — the Crons-tab folds are off the durable store and a collapsed card will reopen on the next browser restart"; assert "cronPanelCardsCollapsed" not in a and "cronPanelDismissedOpen" not in a, "an in-memory Set for the cron folds is back alongside the durable ids — two owners for one fold, and the Set silently wins for the rest of the session"'
  - name: the Crons-tab card ARRANGEMENT is still wired — ui-state exports the order helpers, app.ts writes the order, and the card header is still a drag handle
    cmd: python3 -c 'import os,re; u=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/ui-state.ts")).read(); a=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); [__import__("sys").exit("ui-state.ts no longer exports "+n+" — the persisted-order tier is gone and every drag the architect performs is forgotten on the next reload") for n in ("applyStoredOrder","getOrderedIds","setOrderedIds") if not re.search(r"export\s+function\s+"+n+r"\b", u)]; assert "cron:cardOrder" in a, "app.ts no longer names cron:cardOrder — the Crons tab reads server order again and the cards snap back to jobs.json order on every load"; assert "cronPersistCardOrder" in a and "cronOrderJobs" in a, "app.ts lost cronPersistCardOrder/cronOrderJobs — one half of the round-trip is missing, so the order is either never written or never applied"; assert "cron-card-head" in a and "endCronCardPtr" in a, "the pointer-event card-drag path is gone — collapsed cards will not move, which is the HTML5-vs-click fight this path exists to solve"'
  - name: the Crons-tab taxonomy (filter + groups) is chrome, not findings, and still rides ui-state
    cmd: python3 -c 'import os; a=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/panels/cron-taxonomy.ts")).read(); assert "cron:taxonomy" in t and "cron:filter" in t, "cron-taxonomy.ts lost the key literals — groups and the filter chip have no durable id"; assert "CRON_TAXONOMY_KEY" in a and "CRON_FILTER_KEY" in a, "app.ts stopped importing the taxonomy keys — the Crons tab will reset groups/filter on every browser restart"; assert "parseCronTaxonomy" in t, "cron-taxonomy.ts is missing parseCronTaxonomy — the Crons tab has no group model of its own and must not borrow the task-axis tree"; assert "paintCronBoard" in a and "exec-cron-filter-bar" in a, "the grouped Crons paint or the filter bar is gone"'
  - name: the EEG body and the CACHE body are each declared once and are NOT emitted from inside updateBudgetPanel (the bind-once latches would die on the first repaint)
    cmd: python3 -c 'import os; t=open(os.path.expanduser("~/src/tinkerclaw/tinker-ui/src/app.ts")).read(); q=chr(34); mark="id="+q+"eeg-panel-body"+q; cache="id="+q+"cache-panel-body"+q; s=t.find("function updateBudgetPanel"); e=t.find(chr(10)+"}"+chr(10), s); assert t.count(mark)==1, "the EEG body must be declared exactly once, in the static right-panels shell"; assert s>0 and e>s, "updateBudgetPanel was renamed or reshaped — this containment gate can no longer see it, so fix the gate before trusting it"; assert mark not in t[s:e], "updateBudgetPanel emits the EEG body — it rewrites budget-panel.innerHTML wholesale, so the bind-once eegPanelBound latch on eeg-panel-body dies on the first repaint while the latch stays true, and wheel-zoom plus prompt-click go silently dead"; assert t.count(cache)==1, "the CACHE body must be declared exactly once, in the static right-panels shell"; assert cache not in t[s:e], "updateBudgetPanel emits the CACHE body — same failure as the EEG twin above, and since 2026-08-06 the context-cache card is a static .model-group inside #models-panel, so the boot-bound fold handler and the flashCachePanel target both die on the first repaint"'
---

# UI-state persistence — the unified chrome store

This file owns one fact: **how a piece of Tinker UI chrome remembers its state across a reload, and how a new control opts in.** Design source: `~/src/jarvis-icu/docs/superpowers/specs/2026-08-02-unified-ui-state-persistence-design.md` (approved 2026-08-02).

One contract, **two storage tiers**: a durable JSON file on disk is the truth, and `localStorage` is a synchronous cache of it. A control opts in exactly as before — it states an id and a default, and never learns which tier answered.

## THE INVARIANT — absent means the caller's stated default

An entry exists in the store **only when the user's choice differs from the default the caller stated**. Setting a control back into agreement with its default **deletes** the entry. Every consequence is intentional:

- **The maps stay small.** A never-touched control costs zero bytes.
- **Clearing the three keys restores every default at once.**
- **A default changed in code is followed by every untouched control** — no migration needed.
- **No namespace invents a default of its own.** The caller states it at every call site.

That last point is the whole reason the contract is shaped this way: it is what lets default-EXPANDED right-rail panels and default-COLLAPSED model groups share one store. The pre-2026-08-02 module (`rpanel-collapse.ts`) hard-coded "absent = expanded", which could not express MORE MODELS (default-collapsed).

## Two storage tiers — a durable file, a synchronous cache

Both tiers hold the SAME three maps. Only their durability and their access mode differ.

| Tier        | Where                                                                  | Access          | Role                                                                        |
| ----------- | ---------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| **durable** | `~/.openclaw/data/tinker-ui-state.json` via `GET`/`POST /api/ui-state` | async (`fetch`) | **the truth.** Survives the browser wiping its own storage.                 |
| **cache**   | `localStorage` (the three keys below)                                  | **synchronous** | what `isCollapsed` / `getFlag` / `getChoice` actually read on every render. |

**Why there is a cache at all.** `isCollapsed`, `getFlag` and `getChoice` are called from **16 sites** in `app.ts` (9 / 4 / 3), 14 of them inside **synchronous** render paths — every model group, every rpanel header, every topbar toggle. Making the three accessors async would have meant rewriting all of them and every renderer above them. The cache keeps the read path synchronous; the file keeps the data. That is the only reason localStorage survives this redesign.

**The endpoint.** `/api/ui-state` is a **Vite dev-server middleware** in `tinker-ui/vite.config.ts` — a sibling of the pre-existing `/api/open-file`, `/api/kit-content` and `/api/save-file` endpoints, following the same house pattern including the atomic `.tmp` + rename write. `GET` returns the snapshot (an empty object when the file does not exist yet); `POST` replaces it.

**Boot order — the file wins.** `hydrateUiState()` is awaited at **module top level in `app.ts`, before any state is read** — specifically before the module-scope `activeTabId` initializer, which itself reads `getChoice("tab:active", …)`. A successful `GET` overwrites the three localStorage maps, so the file's value is what every later synchronous read returns. **`hydrateUiState()` never rejects**: a rejected top-level await aborts module evaluation and would black-page the entire UI, so every failure (endpoint absent, malformed JSON, network error) resolves quietly and leaves the cache as it was.

**Top-level await is a BUILD constraint, not a style choice.** `tinker-ui/vite.config.ts` must set `build.target` to `esnext` or `es2022`+. Vite's default is `ESBUILD_MODULES_TARGET` (`es2020`, `chrome87`, `edge88`, `firefox78`, `safari14`), under which **esbuild refuses to emit top-level await**. The failure is asymmetric and nasty: Vite's DEV transform targets esnext, so :18790 — the only surface the architect uses — works perfectly, and only `pnpm build` (the pre-push gate) explodes. The fourth verify gate asserts the target whenever `app.ts` actually top-level-awaits, so the two cannot drift apart.

**Write path — a debounced, coalescing mirror.** Every setter writes the cache synchronously and then schedules a **~250 ms debounced, coalescing** `POST` of the **full snapshot**. Coalescing is what stops a slider drag or a burst of collapses from emitting one request per event. The mirror uses `keepalive`, so a POST **already in flight** survives the page closing.

**What `keepalive` does NOT buy — say it out loud so nobody assumes otherwise.** It rescues a request that has already been ISSUED. A change made inside the debounce window is a **pending timer**, not an in-flight request, and a pending timer dies with the document — the same moment the cache gets wiped. So a setting changed in the last ~250 ms before the window closes is lost from BOTH tiers. Closing that hole needs an explicit flush of the pending mirror on `pagehide` / `visibilitychange`; `keepalive` is what makes that flush survive, not a substitute for it.

### Two limitations, stated plainly

1. **Last-writer-wins across browser tabs.** The mirror POSTs a WHOLE snapshot and the server replaces the file with it. A field-level merge cannot work here, and the reason is THE INVARIANT itself: "the user set this back to its default" is expressed as a **deleted key**, and a merge cannot distinguish a deletion from a key the other tab simply never had. Two tabs changing different chrome concurrently means the last POST wins for all of it. Accepted — the alternative is a per-key tombstone protocol for chrome state, which is not worth it.
2. **Dev-server only.** The middleware is `apply: "serve"`, so it exists only under `vite dev` on **:18790**. If the UI is loaded from the gateway's built `/tinker` route instead, `/api/ui-state` is absent: `hydrateUiState()` resolves as a no-op and each mirror POST fails harmlessly, so the client degrades to **localStorage-only** — exactly the pre-2026-08-02 behaviour, no worse. Accepted because :18790 is the architect's actual serving path. Promoting the endpoint into the gateway plugin (beside `/tinker/api/save-file`) is the known next move if `/tinker` ever becomes the primary surface.

## The owning module

`tinker-ui/src/panels/ui-state.ts` — renamed from `rpanel-collapse.ts` on 2026-08-02. The **synchronous accessors are DOM-free and browser-free by design**, so they are unit-testable without a browser (`ui-state.test.ts` injects a fake `Storage`); the optional trailing `store: Storage` parameter on each of them exists ONLY for those tests. `hydrateUiState()` and the mirror POST are the only functions that touch the network, and deliberately the only asynchronous ones. Every function swallows storage errors (quota, disabled storage, private mode) **and transport errors** and degrades to cached/default behaviour — callers rely on this.

It is the ONLY writer of the three keys below. The first verify command enforces something stricter than "only writer": the key literals may not appear in any other `tinker-ui/src` file at all, in any quote style or accessor shape — so even reads must route through the module, and a new panel re-forking the store is caught at the merge gate.

## The four namespaces and their keys

| Namespace | Key                      | Value                     | For                      |
| --------- | ------------------------ | ------------------------- | ------------------------ |
| collapsed | `tinker.rpanelCollapsed` | `Record<string, boolean>` | anything that folds      |
| flag      | `tinker.uiFlags`         | `Record<string, boolean>` | on/off buttons           |
| choice    | `tinker.uiChoices`       | `Record<string, string>`  | single-choice selections |
| tabs      | `tinker-tabs`            | `Array<object>`           | the open tab LIST        |

**Why four keys and not one:** the unification is the **module and the contract**, not the key count. `tinker.rpanelCollapsed` and `tinker-tabs` keep their pre-unification names because they hold live user data, and reshaping a live key in place buys nothing but risk.

### The tabs namespace is the odd one out, in three ways

It is the only **array**, the only one whose entries this module refuses to interpret, and the only one where **absent and empty mean different things**. All three follow from the same fact: a tab list is ONE value owned by `app.ts`, not a set of independently-defaulted controls.

1. **Carried verbatim.** The entries are `app.ts`'s `Tab` objects. `Tab` gains fields regularly (`titleLocked`, `titleGenerating`), so a per-field schema in `ui-state.ts` or in the endpoint would silently drop each new field on its first cold boot. Both layers validate only the CONTAINER: an array, of plain objects, bounded by `MAX_PERSISTED_TABS` (200). **`ui-state.ts` owns durability; `app.ts` owns shape.**
2. **Absent ≠ empty.** Absent is "no opinion": hydrate leaves the cached list alone, and a POST that omits the section carries the on-disk list forward. `[]` is a real answer and clears the list, so closing every tab but Main sticks.
3. **The invariant above does not apply.** "Absent means the caller's stated default" is a per-ENTRY rule for maps. There is no per-tab default to express.

**The carry-forward in the endpoint is NOT the per-key merge that was banned here.** That ban (see the POST handler's own note, and limitation #1 below) exists because a map's entries are individually deletable to express "back to default", so a merge cannot tell a deletion from a key a tab never had and resurrects every deletion forever. The tab list has no such deletions to confuse: the client either states the whole list or says nothing at all. Whole-snapshot replace still governs the three maps, untouched.

## Id registry

Ids are namespaced by prefix so one flat map per namespace cannot collide.

| Namespace | Id                                                                                     | Default                     |
| --------- | -------------------------------------------------------------------------------------- | --------------------------- |
| collapsed | `sessions-panel`, `models-panel`, `budget-panel`, `prefrontal-panel`, `amygdala-panel` | expanded                    |
| collapsed | `model:models`, `model:more-models`                                                    | **collapsed**               |
| collapsed | `model:eeg` (seismograph), `model:cache`, `model:thinking` (sliders), `model:thalamus` | expanded                    |
| collapsed | `exec:<axisId>`, `exec:__unsorted__`                                                   | expanded                    |
| collapsed | `cron:card:<jobId>`                                                                    | expanded                    |
| collapsed | `cron:dismissed:<jobId>`                                                               | **collapsed**               |
| flag      | `topbar:exec`                                                                          | off                         |
| flag      | `topbar:fractal`                                                                       | **on**                      |
| flag      | `topbar:timeline`, `topbar:models`                                                     | **on**                      |
| choice    | `tab:active`                                                                           | `""`                        |
| choice    | `exec:tab`                                                                             | `today`                     |
| choice    | `exec:filter`                                                                          | `unfinished`                |
| choice    | `exec:focus-order` (JSON array of taskIds)                                             | `[]`                        |
| choice    | `cron:cardOrder` (JSON array of jobIds)                                                | `[]`                        |
| choice    | `cron:filter`                                                                          | `all`                       |
| choice    | `cron:taxonomy` (JSON `{groups, membership}`)                                          | `{groups:[],membership:{}}` |
| collapsed | `cron:group:<groupId>` (incl. `__unsorted__`)                                          | expanded                    |

The bare (unprefixed) `.rpanel` ids in the first row are **deliberate v1 carry-overs**: they are the keys already stored in the live map, and re-prefixing them would discard the user's current rail state for no benefit.

**2026-08-06 — `cache-panel` left the first row.** The context-cache card stopped being a top-level `.rpanel` and became a Models subtitle above the EEG (the architect: "move the context cache panel on top of the EEG, inside MODELS"), so its fold state is now `model:cache`. The stale `cache-panel` key is simply never read again — no migration, because the only thing it holds is one panel's fold state. The `cache-panel` **id itself survives on the new wrapper**: `flashCachePanel()` and the two `#cache-panel.cache-flash-*` rules target it, so the id is doing double duty (dead as a persistence key, live as a style/flash hook) — do not "tidy" it away.

**2026-08-18 — the two `cron:*` rows are the Crons tab's folds** (the architect: "when I turn off the computer and restart the browser, the cron cards should show exactly as I left them... if they were compacted, they should remain so"). They were in-memory `Set`s in app.ts's Crons-tab state block, which bought exactly one repaint of survival — correct for that block's stated job (surviving the wholesale re-render of `#exec-crons-body`), wrong for a reload, and invisible in normal use because a refresh keeps localStorage while only a browser EXIT clears it. This is the **third** control to arrive at this file by that route, after the rail panels (2026-07-25) and the tab list (2026-08-16). The pattern is worth naming: _a `Set`/`Map` declared next to genuinely ephemeral render state inherits its lifetime by accident, not by decision_ — so when adding state to such a block, say out loud which half it belongs to. The dismiss form (`cronPanelDismissTarget`, `cronPanelDismissDrafts`) stays in memory deliberately and is the useful contrast: an unfinished action is not a layout choice, and restoring a half-typed dismissal reason days later would resurrect a thought the architect already walked away from.

**2026-08-19 — `cron:cardOrder` is the Crons tab's card ARRANGEMENT** (the architect: "I should be able to drag-and-drop the cron cards and subitems to change their order, and it should also keep the order upon browser restart"). Half of that request already shipped and the other half did not, which is the first thing to know before touching it: the **subitems** were already draggable and their order was already durable, written server-side by `cronpanel.board.reorder` into each board's own JSON. Only the **card** level was missing. So the request was not evidence of a gap at both scales — a compound ask is two independent claims, and each needs checking against the code separately.

**Why this row lives in `choices` and not in the board store.** The split is the useful part: the cron-panel board store owns _what a cron FOUND_ — items, their order, their dismissals, everything the next nightly run reads and compounds onto. `ui-state` owns _how the architect ARRANGED THE ROOM_, which no cron ever reads. Card order is unambiguously the second, so it goes here; and it survives a browser exit for the same reason the folds do, because this store's durable half is a server-side file.

Three shape decisions worth not re-litigating:

- **ONE key holds the whole order**, unlike the per-job `cron:card:*` folds. A fold is an independent fact about one card; an order is a single fact about the set, and splitting it across 18 keys would make a reorder an 18-write transaction that can tear.
- **A JSON array, never a `,`-joined list.** jobIds are free text — one id containing a comma would silently corrupt every position after it. This is the same reasoning that makes `cronCardElement()` scan for `data-job` instead of interpolating a jobId into a CSS selector.
- **The rule is `applyStoredOrder()`**: listed ids take positions 0..n-1, everything else keeps its incoming order behind them. That is deliberately the rule `reorderItems` in `extensions/tinkerclaw-cron-panel/src/board-store.ts` already applies to subitems, one scale up — a card follows the rule its own children follow. Two consequences are the point of expressing it this way rather than as a strict sort: a **newly registered** cron lands at the BOTTOM instead of jumping into a position nobody chose, and an id in the stored list with **no matching job** is skipped for that render and is _never pruned from the list_, because a job absent for a single poll would otherwise permanently lose its place. Extracting the rule was triggered by the THIRD occurrence, not the second.

This is the **fourth** control to arrive at this file by the same route — rail panels (2026-07-25), the tab list (2026-08-16), the cron folds (2026-08-18), and now the card order. The recurring shape, stated once: _in-memory state survives a repaint but not a reload, and a browser configured to clear site data on exit turns "not a reload" into "every cold start."_ The gap is invisible during development, where a refresh preserves localStorage, and total in use.

One thing that is NOT persistence and was fixed in the same pass: the card header is now both the fold toggle and the drag handle, and it carries no click-suppression flag on purpose. Per the drag spec a `click` is not dispatched once a drag has begun, and a press that never becomes a drag never fires `dragstart` — so each gesture reaches exactly one handler. A flag would be strictly worse: a stale one eats the _next_ genuine click, while a leaked click costs one recoverable fold.

The ids are **per job**, so an untouched card writes nothing (THE INVARIANT), and 18 cards cost 0 bytes until one is folded. A `<jobId>` that disappears from `jobs.json` leaves a dead key — harmless for the same reason `eeg-panel` is, and likewise not worth a migration.

`eeg-panel` is **gone from that row**: the EEG stopped being a `.rpanel` on 2026-08-02 (see below), so nothing reads or writes that id any more. A leftover `eeg-panel` entry in a live map is harmless — an id nobody queries has no effect, a direct consequence of THE INVARIANT — but it is not weightless now that the mirror POSTs the WHOLE snapshot: the dead key gets copied into `tinker-ui-state.json` and kept there indefinitely. Still not worth a migration entry; just do not read this table as "the file contains only live ids".

## The EEG moved into the Models panel (2026-08-02)

The seismograph used to be its own right-rail `.rpanel` (`#eeg-panel`, peer to Models). It is now a **`.model-group` inside the Models panel** with `data-section="eeg"`. Three consequences, all of which have bitten or would bite:

**1. The ids swapped meaning.** `model:eeg` is now the **seismograph** group; `model:thinking` is the **sliders** group (the per-tab thinking slider plus the model-force slider). The sliders group previously carried `data-section="eeg"` and was renamed to `thinking` — matching the label it already displayed — precisely to free the `eeg` name. Stated so nobody debugs it later: **a user who had collapsed the sliders group before the rename comes back expanded, and their pre-existing `model:eeg` entry now applies to the seismograph instead.** Both groups default to expanded, so this is a one-time, self-correcting cosmetic reshuffle, not worth a migration entry.

**2. `MODEL_SECTION_DEFAULT_COLLAPSED` must gain a `thinking` key.** The render read becomes `isCollapsed("model:thinking", MODEL_SECTION_DEFAULT_COLLAPSED["thinking"])`; with no `thinking` entry that second argument is `undefined` — a caller that states NO default, which is exactly what the third invariant forbids ("no namespace invents a default of its own"). The `?? false` on the click-handler write path does not rescue the read, and leaving it would make read and write derive the default from two different places. Renaming the section and adding the map key are ONE change, not two.

**3. The EEG group needs its OWN collapse binding.** `updateBudgetPanel()` delegates collapse clicks via `el.querySelectorAll(".model-group-label")` where `el` is `#budget-panel` — so that one binding reaches every model-group it just rendered and **nothing outside it**. Because the seismograph group is deliberately outside `#budget-panel` (next paragraph), it is not covered: without a binding of its own, `model:eeg` is an id that is read on every render and never written, and the group looks collapsible while refusing to collapse. "It is a `.model-group`" no longer implies "it collapses like the others" — that is now two facts, not one.

**Structural constraint — the EEG markup MUST stay OUTSIDE `#budget-panel`.** (The spatial contract belongs to `panels.md`; it is spelled out here because it is inseparable from the collapse ids above and from the binding note.) The seismograph group is a SIBLING of `#budget-panel` inside the Models `.rpanel`, never a child of it. `updateBudgetPanel()` rewrites `#budget-panel.innerHTML` **wholesale** on every repaint, whereas the EEG's wheel-zoom and prompt-click handlers are attached ONCE, guarded by the `eegPanelBound` bind-once latch on `#eeg-panel-body`. Nesting the EEG inside `#budget-panel` would destroy that element on the first repaint while leaving the latch still `true`, so the handlers would never be re-attached: the EEG would go **silently dead** — no zoom, no click-to-prompt, no error anywhere. The LAST verify gate tests this directly, by asserting the EEG body is not emitted from inside `updateBudgetPanel`'s function body. (Named by position, not by ordinal: this pointer read "fifth" and went stale twice in two days as gates were inserted ABOVE it — 08-18's folds gate made it sixth, 08-19's card-order gate seventh. It is the final entry, so "LAST" survives the next insertion.) The seismograph's own visuals and behaviour are owned by `tinker-ui.md`.

## How to opt a new collapsible in

State an id and a default. **Nothing else** — no new storage key, no migration entry, no wiring:

```ts
if (isCollapsed("my-panel", /* defaultCollapsed */ false)) {
  /* render folded */
}
setCollapsed("my-panel", nowCollapsed, /* defaultCollapsed */ false); // click handler
```

Flags (`getFlag`/`setFlag`) and single-choice selections (`getChoice`/`setChoice`) work identically: the caller passes the default/fallback at every call site.

## Legacy migration

`migrateLegacyUiState()` runs once at boot, folds each legacy key into its namespace, then removes it. **Idempotent** — an already-removed key is a no-op — and **the new store always wins** over a legacy value (the user may have changed the setting since the upgrade).

| Legacy key                          | Becomes                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `sessions-collapsed`                | collapsed `sessions-panel` (already handled by v1; kept) |
| `tinker.execGroupCollapsed.<id>`    | collapsed `exec:<id>`                                    |
| `tinker.bottomCollapsed`            | flag `topbar:timeline` (inverted: collapsed → off)       |
| `tinker.rightCollapsed`             | flag `topbar:models` (inverted)                          |
| `tinker.execMode`                   | flag `topbar:exec` (`"exec"` → on)                       |
| `tinker-amy-fra-toggles` `.fractal` | flag `topbar:fractal`                                    |
| `tinker-active-tab`                 | choice `tab:active`                                      |
| `tinker.execTab`                    | choice `exec:tab`                                        |
| `tinker.execFilter`                 | choice `exec:filter`                                     |

Legacy `tinker.execGroupCollapsed.*` keys are enumerated by scanning `localStorage` for the prefix — the axis ids are not known statically.

## Deliberately OUT of the store

Composer drafts, EEG traces, per-session model/effort pins, `tinker-pf-debug`, `tinkerDisableRunSet`. These are data or dev switches, not UI chrome. Widening the store to cover them adds blast radius for no gain and is **explicitly rejected**.

### `tinker-tabs` WAS on this list. The exclusion was wrong, and was reversed on 2026-08-16

This file used to rule the tab list out on the grounds that it "is a data structure with its own lifecycle, not chrome", and that widening the store bought "no gain". The first half is still true and is exactly why the tabs namespace is shaped differently from the three maps. The second half was **falsified by the bug it caused**:

> "when I close the browser and restart it, the tinker ui tabs that I had opened are not anymore. Make them reopen as if I just refreshed the page."

The tab list was the **last** piece of UI state living only in `localStorage`, on a profile whose whole documented premise (see the section below) is that a clean browser exit destroys `localStorage`. The gain was never zero: it was precisely the difference between a restart restoring the workspace and a restart discarding it.

The exclusion was also **internally inconsistent**, which is the part worth learning from. `tab:active` — WHICH tab has focus — was already durable as a choice. So the store faithfully restored a pointer into a list it had deliberately refused to keep, and the UI came back pointing at a tab that no longer existed and settled on a lone "🏠 Main". **A pointer and its target must share a durability tier.** When a future control is considered for exclusion, check first whether anything already-durable references it.

What survived the reversal: the _reason_ for the original ruling. The tab list is not chrome, so it did not get chrome's contract — it got its own, documented above.

## Why the durable tier is a FILE — Chrome discards localStorage on clean exit

localStorage durability is **NOT guaranteed by this design, and never will be.** Chrome's `profile.default_content_setting_values.cookies = 4` (SESSION_ONLY) combined with `browser.clear_data.cookies = true` discards all cookies **and localStorage** on clean exit — which presents EXACTLY as "survives F5, lost on machine restart". Verified in `~/.config/google-chrome/Default/Preferences` on 2026-08-02; a crashed exit skips the wipe, which is why some keys appeared to survive at random. It is also the likely cause of the recurring dead-auth Chrome profile.

**This is a deliberate user preference, not a misconfiguration.** The architect was shown the one-click remedy — Chrome → Settings → Privacy → "Delete cookies and site data when you close all windows" — and **declined it**: clearing site data on exit is how he gets a clean slate for UI and code updates, and that is worth more to him than browser-side durability. So the DESIGN changed instead of the browser. Do not propose the setting change again; it has been decided.

That is the entire reason the durable tier is a **file on disk** rather than the browser's own storage. The two tiers divide exactly along this line:

- what the browser may wipe at any moment → the **cache** (localStorage), and losing it costs nothing, because
- what must survive → the **file** (`~/.openclaw/data/tinker-ui-state.json`), which `hydrateUiState()` reads back before the first render.

**Keep this finding.** It explains a whole class of phantom "persistence bugs": in this profile, anything that looks like "it forgot my setting overnight" is this wipe until proven otherwise. It also bounds what the file tier can promise — with the dev server down (limitation 2 above) the cache is all there is, and the cache is exactly what gets wiped. `session-naming.md` is the precedent for the next step if that ever bites: tab names went server-side for this same wipe, and the gateway plugin — not the browser — is where this store would go.

## The chat transcript is NOT chrome — and client-only rows had no tier at all

FORK 2026-08-23 (the architect: "the chat should be immutable, meaning that once something is written it
should not be erased ... make them stick (no disappearences allowed)").

**The defect.** Rows the UI synthesises and the SERVER never stores — phase timings, the
per-plugin breakdown, warnings, retries, stop notices — vanished on every page reload. Half of
the machinery already worked, which is why it read as intermittent: `_isPhaseTiming` has been in
`CLIENT_ONLY_FLAGS` since 2026-08-15, so `loadChat` preserves these rows across a RECONNECT
(`isClientOnlyBubble` collects → `messages = incoming` → `reinsertByTurnAnchor` restores). A
gateway restart never lost them.

The half that did not exist: **`messages` is persisted nowhere.** This file's contract covers
chrome — collapse flags, choices, the tab list. The transcript was never in any tier. So a reload
starts with an empty list, `loadChat` fills it from server history, and a row the server never had
has nothing to come back from. Preserving something in memory cannot survive the memory going away.

**Why it did NOT join the two-tier store.** The unified store is a small bounded key/value map for
chrome, hydrated before first render. Transcript rows are CONTENT: hundreds per session, belonging
to a session rather than to the UI, and unbounded in a way `tinker-ui-state.json` must not become.
`outbox.ts` and `tinker-prompt-journal` already set the precedent — content-bearing browser stores
live outside the chrome contract. `tinker-client-rows` (`tinker-ui/src/client-rows.ts`) follows it:
keyed by session, carrying each row's TURN ANCHOR so it returns to its place rather than the tail,
idempotent on `_clientRowId`, capped at 400 rows × 24 sessions oldest-first, and quota-safe (sheds
the oldest half and retries once — the lesson `writeOutbox` paid for).

**THE LIMIT, and it is this file's own finding.** `tinker-client-rows` is in `localStorage`, and
the section above documents that this Chrome profile **discards localStorage on clean exit** by
deliberate user preference. So the guarantee is exactly:

| event                          | rows survive?                                          |
| ------------------------------ | ------------------------------------------------------ |
| gateway restart / reconnect    | yes — and did before this change (`CLIENT_ONLY_FLAGS`) |
| page reload, F5, tab switch    | **yes — this is what the change fixed**                |
| clean browser exit and restart | **NO** — the profile wipes localStorage                |

Do not read "the chat is immutable" as stronger than that row. Closing the browser cleanly still
loses client-only rows, for the same reason the tab list used to disappear. The remedy is the one
this file already names: the store goes SERVER-SIDE, `session-naming.md` being the precedent. That
is a real decision and not a tidy-up — it puts CLIENT-measured numbers into the durable transcript,
where they sit beside gateway-measured ones that mean a different thing (`turn-latency.md` §7 is the
record of what happens when those two get conflated). It has not been taken.
