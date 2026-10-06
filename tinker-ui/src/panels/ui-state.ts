// FORK 2026-07-25 (the user): right-rail panel collapse persistence.
// FORK 2026-08-02 (the user): grown into the single owner of every piece of persisted UI
// chrome — things that fold, on/off top-bar buttons, and single-choice selections.
// Design spec: jarvis-icu docs/superpowers/specs/2026-08-02-unified-ui-state-persistence-design.md
//
// Before this module, exactly ONE right panel remembered whether it was collapsed — the
// sessions panel, via a hand-rolled `sessions-collapsed` localStorage key written inline
// in app.ts. Every other panel forgot on refresh, and the buttons and tabs that did
// persist each owned a private key of their own shape. Here a control opts in with
// nothing but an id and a default.
//
// ── THE INVARIANT: ABSENT MEANS THE CALLER'S STATED DEFAULT ────────────────────────
// An entry is written ONLY when the value DIFFERS from the default the caller passed;
// a value that agrees with the default DELETES the entry. Every getter therefore takes
// that default too, and no namespace here invents one of its own. Consequences, all
// deliberate:
//   - the maps stay small — a never-touched control costs zero bytes;
//   - clearing a key restores every default at once;
//   - a default changed in code later is picked up by every untouched control;
//   - default-expanded rpanels and default-collapsed model groups share ONE contract.
//     v1 hard-coded "absent = expanded", which could not express MODELS / MORE MODELS.
// Read it that way everywhere: code that assumes "absent means expanded" would boot the
// whole rail closed on a fresh profile, or boot MODELS open against its own default.
//
// Four keys, one module. The unification is the MODULE and the CONTRACT, not literally
// one key: `tinker.rpanelCollapsed` keeps its v1 name because it holds live user data,
// and reshaping a live key in place buys nothing but risk.
//
// ── THE FOURTH KEY IS NOT A MAP ────────────────────────────────────────────────────
// FORK 2026-08-16 (the user: "when I close the browser and restart it, the tinker ui tabs
// that I had opened are not anymore"). `tinker-tabs` — the OPEN TAB LIST, owned and
// shaped by app.ts — joined the durable snapshot. Until then the durable layer carried
// `tab:active` (WHICH tab had focus) but never the tabs themselves, so on the cold start
// that wipes localStorage the UI restored a pointer to a tab list that no longer existed
// and fell back to a lone "🏠 Main". A refresh kept them only because a refresh does not
// clear site data. The sessions behind the tabs were never lost — they live on the
// gateway — so restoring the list is all that was ever missing.
//
// It is deliberately OPAQUE here: an array of plain objects, carried verbatim, never
// interpreted. `Tab` is app.ts's type and gains fields regularly (titleLocked,
// titleGenerating…); a per-field schema in this module would silently drop each new one
// on its first cold boot. This module owns DURABILITY, app.ts owns SHAPE.
//
// The map invariant above ("absent means the caller's stated default") does NOT apply to
// it, and could not: a tab list is one whole value, not a set of independently-defaulted
// controls. Its rule is the plainer one — absent means "no answer", present replaces.
//
// Pure storage model, no DOM deps, so the whole thing is unit-testable without a
// browser. The optional trailing `store` argument exists ONLY for those tests;
// production callers pass nothing and get globalThis.localStorage.
//
// ── DURABILITY: THE FILE IS THE TRUTH, localStorage IS THE CACHE ───────────────────
// the user's Chrome drops all site data on exit (cookies SESSION_ONLY + clear-on-exit, a
// setting he keeps deliberately), so localStorage is EMPTY on every cold start. The
// durable copy therefore lives in a JSON file behind the dev server at
// `UI_STATE_ENDPOINT`, and the three keys above are a SYNCHRONOUS CACHE in front of it.
// Nothing about the existing API changes: the ~25 render sites in app.ts still call the
// same synchronous getters and setters, and those still read and write localStorage and
// only localStorage. The durable layer wraps them; it does not replace them.
//   1. THE FILE WINS ON HYDRATE. `hydrateUiState` replaces the three local maps
//      WHOLESALE from the server snapshot. It can afford to: the cache is empty at cold
//      start anyway, and inside a session the mirror re-writes the file within ~250ms of
//      any change, so the file is never meaningfully staler than the cache. The payload
//      gets the SAME defensive parsing as a stored map (`coerceMap`) — a malformed or
//      non-object body seeds NOTHING and leaves the local store untouched, and one
//      wrong-typed entry inside a map is dropped alone. A namespace the file omits
//      hydrates as empty: that is what "the file wins" means, and the invariant above
//      turns absence straight back into the caller's stated defaults.
//   2. HYDRATE NEVER THROWS AND NEVER HANGS. `AbortController`, 1500ms by default;
//      timeout, network error, non-200 or bad JSON all answer `false` with the local
//      store untouched. app.ts awaits it at module scope, so a rejection would black-page
//      the whole UI — and the UI must still boot on a machine where the endpoint does
//      not exist at all.
//   3. THE MIRROR IS DEBOUNCED AND COALESCING. Every setter tails into
//      `scheduleUiStateMirror`, and a burst of setter calls collapses into ONE POST of
//      the FINAL snapshot, read at FLUSH time rather than at schedule time.
//      Routine mirrors are ORDINARY requests whose response body is always read; only the
//      `pagehide` flush uses `keepalive` (2026-09-24: every mirror used to, nothing read the
//      responses, Chrome never released its 64 KB keepalive budget, and the 10th mirror of
//      every page — and all after it — failed inside the browser). A failed mirror never
//      throws into the session, but it is NOT silent: it warns and retries on a backoff.
//   4. LAST WRITER WINS ACROSS TABS. The POST carries the WHOLE snapshot, so two tabs
//      changing different controls clobber each other down to the most recent write.
//      Accepted deliberately: a per-key merge cannot express the delete-on-agreement
//      half of the invariant above — an absent key is indistinguishable from a key the
//      other tab just reset to its default, so a merge would resurrect stale entries
//      forever. A wrong panel fold is cheap; an un-resettable control is not.
//      EXCEPTION (2026-09-21): closed-tab tombstones (`closedTabs`) are UNIONED at every
//      layer, the server included, so no stale writer can resurrect a closed tab.
//   5. NO DOM, STILL. `fetch` and `AbortController` are feature-detected, never assumed:
//      without them hydrate resolves `false` and the mirror is a silent no-op, so the
//      module stays unit-testable in a bare Node/vitest process, which is an existing
//      invariant of this file.

/** Anything that folds: `.rpanel` element ids, `model:*`, `exec:*`. */
export const COLLAPSED_KEY = "tinker.rpanelCollapsed";
/** On/off top-bar buttons: `topbar:*`. */
export const FLAGS_KEY = "tinker.uiFlags";
/** Single-choice selections: `tab:active`, `exec:tab`, `exec:filter`. */
export const CHOICES_KEY = "tinker.uiChoices";
/**
 * The open tab list. Pre-unification name, kept because it holds live user data (same
 * reasoning as COLLAPSED_KEY). app.ts imports this rather than re-declaring the literal:
 * two spellings of one key is a drift bug that only shows up as "my tabs vanished".
 */
export const TABS_KEY = "tinker-tabs";

/** Control id → boolean. An absent id means the caller's stated default. */
export type BoolMap = Record<string, boolean>;
/** Control id → chosen value. An absent id means the caller's stated default. */
export type StringMap = Record<string, string>;

// The pre-unification keys, folded in once at boot and then deleted. Named rather than
// inlined: the list doubles as the migration table read by `migrateLegacyUiState`.
const LEGACY_SESSIONS_COLLAPSED = "sessions-collapsed";
const LEGACY_EXEC_GROUP_PREFIX = "tinker.execGroupCollapsed.";
const LEGACY_BOTTOM_COLLAPSED = "tinker.bottomCollapsed";
const LEGACY_RIGHT_COLLAPSED = "tinker.rightCollapsed";
const LEGACY_EXEC_MODE = "tinker.execMode";
const LEGACY_INJECT_TOGGLES = "tinker-amy-fra-toggles";
const LEGACY_ACTIVE_TAB = "tinker-active-tab";
const LEGACY_EXEC_TAB = "tinker.execTab";
const LEGACY_EXEC_FILTER = "tinker.execFilter";

// --- storage primitives ----------------------------------------------------
// Every read and every write is wrapped. A disabled, private-mode or quota-full Storage
// degrades to "nothing saved" — it never propagates an exception into the UI.

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Any already-parsed value coerced into one of the two map shapes. The type guard is
 * passed in so both shapes share this block without a cast at either call site. Lives
 * apart from `readMap` because the durable snapshot arrives as JSON off the network and
 * must survive EXACTLY the same hostility as a hand-edited localStorage value — one
 * parser, one owner, no second opinion about what counts as a map.
 */
function coerceMap<T>(
  value: unknown,
  isValue: (candidate: unknown) => candidate is T,
): Record<string, T> {
  // An array, string or number is not a map. Treat any of them as "nothing saved"
  // rather than letting a stale or hand-edited value drive arbitrary controls.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, T> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    // A wrong-typed value is ONE corrupt entry, not a corrupt map — drop it and keep
    // the rest, so a single bad id cannot reset every other control.
    if (isValue(entry)) {
      out[id] = entry;
    }
  }
  return out;
}

/** One stored map, defensively parsed. */
function readMap<T>(
  key: string,
  isValue: (value: unknown) => value is T,
  store: Storage,
): Record<string, T> {
  try {
    const raw = store.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return coerceMap(parsed, isValue);
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>, store: Storage): void {
  try {
    store.setItem(key, JSON.stringify(map));
  } catch {
    /* quota or disabled storage — ignore */
  }
}

// --- tab list (the non-map namespace) --------------------------------------

/**
 * One persisted tab, carried verbatim. See the header: app.ts owns the shape, this module
 * only guarantees it survives a browser exit, so anything JSON-shaped rides along.
 */
export type TabRecord = Record<string, unknown>;

/**
 * Ceiling on persisted tabs. Not a product limit — the UI has never come near it — but a
 * bound on what a corrupt or runaway writer can push into a 256KB endpoint body. Tabs
 * past it are dropped from the DURABLE copy only; the live localStorage list app.ts
 * writes is untouched.
 */
export const MAX_PERSISTED_TABS = 200;

/**
 * Any already-parsed value coerced into a tab list. Same hostility budget as `coerceMap`:
 * a non-array is "nothing saved", and one non-object entry is dropped alone rather than
 * costing the user every other tab. Arrays are rejected as entries too — `Tab` is an
 * object, and letting one through would put a value app.ts cannot render into the list.
 */
export function coerceTabs(value: unknown): TabRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: TabRecord[] = [];
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      out.push(entry as TabRecord);
    }
    if (out.length >= MAX_PERSISTED_TABS) {
      break;
    }
  }
  return out;
}

/** The tab list as stored, defensively parsed. `[]` for absent, unparseable or wrong-shaped. */
export function loadTabList(store: Storage = globalThis.localStorage): TabRecord[] {
  try {
    const raw = store.getItem(TABS_KEY);
    if (!raw) {
      return [];
    }
    return withoutClosedTabs(coerceTabs(JSON.parse(raw) as unknown), loadClosedTabs(store));
  } catch {
    return [];
  }
}

/**
 * Overwrite the stored tab list. Same silent-failure contract as `writeMap`. Tombstoned
 * ids are dropped on the way in, so no writer — a stale second window, a hydrate from an
 * old file — can put a closed tab back into the cache.
 */
export function writeTabList(tabs: TabRecord[], store: Storage = globalThis.localStorage): void {
  try {
    store.setItem(TABS_KEY, JSON.stringify(withoutClosedTabs(tabs, loadClosedTabs(store))));
  } catch {
    /* quota or disabled storage — ignore */
  }
}

// --- closed-tab tombstones --------------------------------------------------
// FORK 2026-09-21 (the architect: "When I do ctrl+shift+R the tinker ui shows tabs I had deleted …
// whatever is closed or deleted stays that way"). Closing a tab used to be recorded ONLY as
// its absence from a list, and absence meant "no information" to every other layer: the boot
// hydrate let the file's list overwrite the cache, the re-hydrate merge re-added "file-only"
// tabs on purpose, the server kept whichever list was POSTed last, and a mirror still in its
// 250ms debounce died with the page. Any of those resurrected a closed tab. Measured that
// day: the durable file held 4 tabs whose sessions were already soft-deleted, one since
// 2026-09-17. A close is now a POSITIVE fact — tab id → closedAt — that is only ever UNIONED
// (cache ∪ file ∪ every POST, also on the server), and every tab list is filtered through it.
// Tab ids are minted fresh per tab (generateTabId), so a tombstone can never block a reopen.

/** localStorage key of the tombstone map (tab id → epoch ms it was closed). */
export const CLOSED_TABS_KEY = "tinker.closedTabs";
/** Newest tombstones kept. Ids are never reused, so an evicted one costs nothing but a
 *  resurrection risk from a writer older than the last 500 closes. */
export const MAX_CLOSED_TABS = 500;

export type ClosedTabs = Record<string, number>;

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Union of tombstone maps: latest close time wins, newest MAX_CLOSED_TABS kept. */
export function unionClosedTabs(...maps: Array<ClosedTabs | undefined>): ClosedTabs {
  const all: ClosedTabs = {};
  for (const map of maps) {
    for (const [id, at] of Object.entries(coerceMap(map, isEpoch))) {
      all[id] = Math.max(all[id] ?? 0, at);
    }
  }
  const newest = Object.entries(all)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, MAX_CLOSED_TABS);
  return Object.fromEntries(newest);
}

export function loadClosedTabs(store: Storage = globalThis.localStorage): ClosedTabs {
  return readMap(CLOSED_TABS_KEY, isEpoch, store);
}

/** A tab list minus every tombstoned id. `tab-main` cannot be closed, so it is never dropped. */
export function withoutClosedTabs(tabs: TabRecord[], closed: ClosedTabs): TabRecord[] {
  return tabs.filter(
    (t) => typeof t.id !== "string" || t.id === "tab-main" || typeof closed[t.id] !== "number",
  );
}

/** Tombstone one tab. Written to the cache synchronously, mirrored to the file like any setter. */
export function recordClosedTab(
  tabId: string,
  store: Storage = globalThis.localStorage,
  now: number = Date.now(),
): void {
  if (!tabId || tabId === "tab-main") {
    return;
  }
  writeMap(CLOSED_TABS_KEY, unionClosedTabs(loadClosedTabs(store), { [tabId]: now }), store);
  console.info(`[tabs] closed ${tabId} — tombstoned (build ${uiBuild()})`);
  scheduleUiStateMirror(store);
}

// Reads go through `typeof`, never `map[id] !== undefined` or `id in map`: the maps are
// plain objects, so a control id that collides with an inherited name (`constructor`,
// `toString`) would otherwise answer with something off the prototype chain.

// --- collapsed -------------------------------------------------------------

/** The whole collapse map, for callers that render many controls in one pass. */
export function loadCollapsed(store: Storage = globalThis.localStorage): BoolMap {
  return readMap(COLLAPSED_KEY, isBoolean, store);
}

/**
 * `defaultCollapsed` defaults to `false`, so `isCollapsed(id)` is bit-identical to v1's
 * `isRpanelCollapsed(id)` for the `.rpanel` call sites that predate the unification.
 */
export function isCollapsed(
  id: string,
  defaultCollapsed = false,
  store: Storage = globalThis.localStorage,
): boolean {
  const stored = loadCollapsed(store)[id];
  return isBoolean(stored) ? stored : defaultCollapsed;
}

export function setCollapsed(
  id: string,
  collapsed: boolean,
  defaultCollapsed = false,
  store: Storage = globalThis.localStorage,
): void {
  const map = loadCollapsed(store);
  if (collapsed === defaultCollapsed) {
    // Agreement with the default is stored as absence, not as a written value.
    delete map[id];
  } else {
    map[id] = collapsed;
  }
  writeMap(COLLAPSED_KEY, map, store);
  // The cache is now correct; the file is not. Debounced, coalescing, best-effort.
  scheduleUiStateMirror(store);
}

// --- flags -----------------------------------------------------------------

function loadFlags(store: Storage): BoolMap {
  return readMap(FLAGS_KEY, isBoolean, store);
}

export function getFlag(
  id: string,
  fallback: boolean,
  store: Storage = globalThis.localStorage,
): boolean {
  const stored = loadFlags(store)[id];
  return isBoolean(stored) ? stored : fallback;
}

export function setFlag(
  id: string,
  value: boolean,
  fallback: boolean,
  store: Storage = globalThis.localStorage,
): void {
  const map = loadFlags(store);
  if (value === fallback) {
    delete map[id];
  } else {
    map[id] = value;
  }
  writeMap(FLAGS_KEY, map, store);
  scheduleUiStateMirror(store);
}

// --- choices ---------------------------------------------------------------

function loadChoices(store: Storage): StringMap {
  return readMap(CHOICES_KEY, isString, store);
}

export function getChoice(
  id: string,
  fallback: string,
  store: Storage = globalThis.localStorage,
): string {
  const stored = loadChoices(store)[id];
  return isString(stored) ? stored : fallback;
}

export function setChoice(
  id: string,
  value: string,
  fallback: string,
  store: Storage = globalThis.localStorage,
): void {
  const map = loadChoices(store);
  if (value === fallback) {
    delete map[id];
  } else {
    map[id] = value;
  }
  writeMap(CHOICES_KEY, map, store);
  scheduleUiStateMirror(store);
}

// --- order -----------------------------------------------------------------

// FORK 2026-08-19 — a persisted ORDER, for controls the architect can physically
// rearrange. It rides the CHOICES tier rather than adding a fifth namespace: a
// JSON array in a string value needs no new snapshot/hydrate/mirror plumbing, and
// the tier's "agreement with the default deletes the entry" invariant then gives
// an untouched panel zero bytes for free.
//
// JSON, not a `,`-joined list, because the ids these lists hold are FREE TEXT —
// one id containing a comma would silently corrupt every position after it.

/** An empty order is the stated default, so writing `[]` DELETES the entry. */
export const ORDER_DEFAULT = "[]";

/**
 * Never throws. A corrupt or hand-edited entry must degrade to "no stored order"
 * — i.e. fall back to whatever order the caller was given — because the
 * alternative is a panel that renders nothing.
 */
export function getOrderedIds(id: string, store: Storage = globalThis.localStorage): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(getChoice(id, ORDER_DEFAULT, store));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isString);
}

export function setOrderedIds(
  id: string,
  ids: string[],
  store: Storage = globalThis.localStorage,
): void {
  setChoice(id, JSON.stringify(ids), ORDER_DEFAULT, store);
}

/**
 * Listed ids take positions 0..n-1; everything else keeps its INCOMING relative
 * order after them. Pure — no storage access — so it is testable without a
 * `Storage` double.
 *
 * This is deliberately the same rule as `reorderItems` in
 * `extensions/tinkerclaw-cron-panel/src/board-store.ts`, one scale up: a card
 * follows the rule its own subitems already follow. Two consequences are the
 * whole point of writing it this way rather than as a strict sort:
 *
 *   - An id the stored list does not mention lands AFTER the arranged ones, so
 *     something newly registered appears at the bottom instead of jumping into a
 *     position the architect never chose.
 *   - An id in the stored list with no matching item is skipped for this render
 *     and is NOT pruned from the list by the caller. An item missing for a single
 *     poll would otherwise permanently lose the place it was put in.
 */
export function applyStoredOrder<T>(
  items: T[],
  orderedIds: string[],
  idOf: (item: T) => string,
): T[] {
  if (orderedIds.length === 0) return items;
  const wanted = new Map<string, number>();
  orderedIds.forEach((id, index) => {
    // First occurrence wins, so a duplicated id cannot emit an item twice.
    if (!wanted.has(id)) wanted.set(id, index);
  });
  const listed = items
    .filter((item) => wanted.has(idOf(item)))
    .sort((a, b) => (wanted.get(idOf(a)) ?? 0) - (wanted.get(idOf(b)) ?? 0));
  const rest = items.filter((item) => !wanted.has(idOf(item)));
  return [...listed, ...rest];
}

// --- migration -------------------------------------------------------------

function readLegacy(key: string, store: Storage): string | null {
  try {
    return store.getItem(key);
  } catch {
    /* disabled storage — nothing to migrate */
    return null;
  }
}

function removeLegacy(key: string, store: Storage): void {
  try {
    store.removeItem(key);
  } catch {
    /* quota or disabled storage — ignore */
  }
}

// The new store WINS whenever it already holds an entry for `id`: the user may have
// changed that control since the upgrade, and the legacy value is stale. That check —
// not a "migration done" marker — is what makes a second boot a no-op. The fold itself
// goes through the public setter, so the invariant holds during migration too: a legacy
// value that equals the default folds to no entry at all.

function foldCollapsed(
  id: string,
  collapsed: boolean,
  defaultCollapsed: boolean,
  store: Storage,
): void {
  if (isBoolean(loadCollapsed(store)[id])) {
    return;
  }
  setCollapsed(id, collapsed, defaultCollapsed, store);
}

function foldFlag(id: string, value: boolean, fallback: boolean, store: Storage): void {
  if (isBoolean(loadFlags(store)[id])) {
    return;
  }
  setFlag(id, value, fallback, store);
}

function foldChoice(id: string, value: string, fallback: string, store: Storage): void {
  // Every legacy choice was read as `getItem(...) || <default>`, so an empty string
  // meant the default. Folding "" verbatim would persist a selection that never existed.
  if (value === "" || isString(loadChoices(store)[id])) {
    return;
  }
  setChoice(id, value, fallback, store);
}

/**
 * The exec axis ids are not known statically, so the legacy keys are found by scanning
 * the store. Collect them ALL first and mutate afterwards — removing while iterating by
 * index reshuffles the very indices being walked and silently skips half the matches.
 */
function legacyExecGroupKeys(store: Storage): string[] {
  const keys: string[] = [];
  try {
    const count = store.length;
    for (let i = 0; i < count; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(LEGACY_EXEC_GROUP_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    /* disabled storage — nothing to enumerate */
    return [];
  }
  return keys;
}

/** `null` when the blob is unreadable; otherwise the fractal toggle it held. */
function parseLegacyFractal(raw: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    // Mirrors app.ts loadInjectToggles(): only an explicit `false` turns it off, so an
    // absent field means on. Get this wrong and the upgrade silently kills fractal.
    return (parsed as Record<string, unknown>).fractal !== false;
  } catch {
    return null;
  }
}

/**
 * One-shot fold of every pre-unification key into the three namespaces above. Idempotent,
 * so it is safe to call on every boot: each legacy key is removed as it is folded, and an
 * already-removed key reads as absent and is skipped. Absorbs v1's `migrateLegacyCollapsed`
 * so there is one entry point instead of two. A legacy key is never removed speculatively —
 * only inside the branch that found it — so a fresh profile does zero writes here.
 */
export function migrateLegacyUiState(store: Storage = globalThis.localStorage): void {
  // sessions-collapsed → collapsed `sessions-panel`. Any value other than "1" ("0", junk)
  // meant expanded, which is already the default: nothing is written, the key just retires.
  const sessions = readLegacy(LEGACY_SESSIONS_COLLAPSED, store);
  if (sessions !== null) {
    foldCollapsed("sessions-panel", sessions === "1", false, store);
    removeLegacy(LEGACY_SESSIONS_COLLAPSED, store);
  }

  // tinker.execGroupCollapsed.<axisId> → collapsed `exec:<axisId>`, one key each.
  // `exec:__unsorted__` needs no special case — the prefix scan picks it up like any axis.
  for (const key of legacyExecGroupKeys(store)) {
    const axisId = key.slice(LEGACY_EXEC_GROUP_PREFIX.length);
    if (axisId !== "") {
      foldCollapsed(`exec:${axisId}`, readLegacy(key, store) === "1", false, store);
    }
    removeLegacy(key, store);
  }

  // tinker.bottomCollapsed / tinker.rightCollapsed → flags, INVERTED: the legacy keys
  // stored "is it collapsed", the flags store "is it showing".
  const bottom = readLegacy(LEGACY_BOTTOM_COLLAPSED, store);
  if (bottom !== null) {
    foldFlag("topbar:timeline", bottom !== "1", true, store);
    removeLegacy(LEGACY_BOTTOM_COLLAPSED, store);
  }
  const right = readLegacy(LEGACY_RIGHT_COLLAPSED, store);
  if (right !== null) {
    foldFlag("topbar:models", right !== "1", true, store);
    removeLegacy(LEGACY_RIGHT_COLLAPSED, store);
  }

  // tinker.execMode → flag `topbar:exec`. "exec" is on; "dev" and junk are off.
  const execMode = readLegacy(LEGACY_EXEC_MODE, store);
  if (execMode !== null) {
    foldFlag("topbar:exec", execMode === "exec", false, store);
    removeLegacy(LEGACY_EXEC_MODE, store);
  }

  // tinker-amy-fra-toggles.fractal → flag `topbar:fractal`. An unreadable blob folds
  // nothing but still retires the key: leaving it would re-attempt the same doomed parse
  // on every boot, and v1 could not have read it either.
  const injectToggles = readLegacy(LEGACY_INJECT_TOGGLES, store);
  if (injectToggles !== null) {
    const fractal = parseLegacyFractal(injectToggles);
    if (fractal !== null) {
      foldFlag("topbar:fractal", fractal, true, store);
    }
    removeLegacy(LEGACY_INJECT_TOGGLES, store);
  }

  // The three single-choice selections carry their string across as-is; each default is
  // what the old call site fell back to.
  const activeTab = readLegacy(LEGACY_ACTIVE_TAB, store);
  if (activeTab !== null) {
    foldChoice("tab:active", activeTab, "", store);
    removeLegacy(LEGACY_ACTIVE_TAB, store);
  }
  const execTab = readLegacy(LEGACY_EXEC_TAB, store);
  if (execTab !== null) {
    foldChoice("exec:tab", execTab, "today", store);
    removeLegacy(LEGACY_EXEC_TAB, store);
  }
  const execFilter = readLegacy(LEGACY_EXEC_FILTER, store);
  if (execFilter !== null) {
    foldChoice("exec:filter", execFilter, "unfinished", store);
    removeLegacy(LEGACY_EXEC_FILTER, store);
  }

  // Unconditional, not "only if something folded": a legacy fold is a one-shot chance.
  // The legacy keys are already gone from the store by now, so if the folded values were
  // left to wait for the user's next click they would die with the next Chrome exit.
  scheduleUiStateMirror(store);
}

// --- durable mirror --------------------------------------------------------
// See "DURABILITY" in the header. Everything below is ADDITIVE: nothing above awaits it,
// nothing above changed shape. The synchronous API tails a debounce timer and returns.

/** Dev-server endpoint owning the durable copy: GET returns the snapshot, POST replaces it. */
export const UI_STATE_ENDPOINT = "/api/ui-state";
// FORK 2026-10-06 (the user: "each user needs to have his own tabs, and have them reopen on reconnect
// exactly as they were"). When the page is served by the gateway plugin (no dev server, no prod-ui
// proxy), the root path above answers 404 and the state file lives under the app's base path. The
// first 404 switches this page to the plugin's endpoint for the rest of its life; a 200 never does.
export const UI_STATE_PLUGIN_ENDPOINT = "/tinker/api/ui-state";
let uiStateEndpoint = UI_STATE_ENDPOINT;
/** Which endpoint this page settled on (exported for tests and the boot trace). */
export function currentUiStateEndpoint(): string {
  return uiStateEndpoint;
}
/** Tests only: forget the settled endpoint. */
export function resetUiStateEndpointForTests(): void {
  uiStateEndpoint = UI_STATE_ENDPOINT;
}

/**
 * The four namespaces in one payload — exactly what the endpoint stores on disk.
 *
 * `tabs` is OPTIONAL, and that is the whole upgrade story. A store written before
 * 2026-08-16 has no `tabs` key, and a hydrate from one must mean "I have no answer about
 * tabs", NEVER "you have no tabs" — the latter would blank the live list on the first
 * refresh after this shipped, i.e. cause the exact bug it fixes. `readUiStateSnapshot`
 * therefore always EMITS it and `writeUiStateSnapshot` only applies it when PRESENT, so
 * the first mirror from any hydrated page upgrades the file in place.
 */
export type UiStateSnapshot = {
  collapsed: Record<string, boolean>;
  flags: Record<string, boolean>;
  choices: Record<string, string>;
  tabs?: TabRecord[];
  /** Closed-tab tombstones. Optional like `tabs`, and only ever UNIONED, never replaced. */
  closedTabs?: ClosedTabs;
};

/** Long enough for a busy dev server, short enough that boot never visibly stalls. */
const HYDRATE_TIMEOUT_MS = 1500;
/**
 * FORK 2026-09-16 (the architect: "sometimes I switch to a tab and it is just empty … sometimes it
 * never gets restored") — the retry budget for a hydrate that already failed once.
 *
 * The boot hydrate's 1500 ms is a page-start budget: the whole module awaits it, so it has to
 * be short. A RETRY is awaited by nobody (the hello path awaits it only on the failed branch,
 * and the timer below awaits nothing), so it can afford the budget the endpoint actually
 * needs on a machine that is still booting — the same UI server that just served the page.
 */
const REHYDRATE_TIMEOUT_MS = 4000;
/**
 * How long a page that could not read the file waits before asking again, by attempt. The
 * ladder tops out at one minute and then stays there: a page that is open for eight hours
 * with the mirror off is the failure this exists to end, and one GET a minute against a
 * local file server is the cheapest insurance there is.
 */
const REHYDRATE_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** A drag across a row of toggles must cost ONE POST, not thirty. */
const MIRROR_DEBOUNCE_MS = 250;
/**
 * FORK 2026-09-24 — how long a mirror that did not land waits before trying again, by
 * consecutive failure. Tops out at a minute and stays there, like REHYDRATE_BACKOFF_MS: a page
 * whose writes keep failing must keep asking, because every minute it does not is a minute of
 * tabs the next reboot will not bring back.
 */
const MIRROR_RETRY_MS = [2_000, 5_000, 15_000, 60_000];

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorStore: Storage | null = null;
/** The store of the last scheduled mirror, kept after the debounce consumes `mirrorStore`. */
let lastMirrorStore: Storage | null = null;
let hydrating = false;
/** Consecutive mirror POSTs that did not land (rejected, or answered non-2xx). */
let mirrorFailures = 0;
let mirrorRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** Routine (non-keepalive) mirror POSTs issued and not yet settled — see the pagehide flush. */
let mirrorsInFlight = 0;
/**
 * FORK 2026-09-16 — the self-retry. The 2026-09-16 morning fix retried a failed boot hydrate
 * on the next WebSocket `hello`; measured the same afternoon, the page loaded at 12:17 never
 * mirrored again (durable file frozen at 12:52 while the page opened and closed tabs until
 * 15:51), because its one retry failed too and nothing else ever asked. A gate that fails shut
 * with no retry is a slow leak: the file goes stale silently and the next reboot restores the
 * stale file over the live tabs. So a failed hydrate now ARMS a timer that keeps asking on a
 * backoff ladder until the file has been read once; a `hello` still retries immediately.
 */
let rehydrateTimer: ReturnType<typeof setTimeout> | null = null;
let rehydrateFailures = 0;
/**
 * FORK 2026-08-04 (the user: "the state of the UI is not kept after restart").
 *
 * Did THIS page ever read the durable file? Until it has, its local maps are not
 * authoritative and must never be posted back.
 *
 * The wipe path this closes, which needed no user interaction at all:
 * `app.ts` discards the result of `await hydrateUiState()`, and ~1600 lines later
 * `migrateLegacyUiState()` ends in an UNCONDITIONAL `scheduleUiStateMirror(store)`.
 * So a hydrate that failed for any transient reason — the 1500ms timeout on a cold
 * machine, Vite mid-restart, the dev server not yet listening when Chrome
 * session-restores the tab, the gateway crash-looping — left the maps empty and
 * then POSTed those empty maps over the good file 250ms later. The server accepts
 * it: it refuses only when the EXISTING store is unreadable, and
 * `{"collapsed":{},"flags":{},"choices":{}}` is perfectly well-formed.
 *
 * Failing shut costs durability on a page that could not hydrate. That is strictly
 * better than destroying everyone else's state, and it makes loading the UI from
 * the gateway's /tinker route (where the endpoint does not exist) safe by default.
 *
 * THREE states, not a boolean, and the distinction is load-bearing:
 *   "pending" — hydrate was never attempted. Mirroring is ALLOWED, because a caller
 *               that never hydrates (a unit test, a future embedder) has no stale
 *               file to clobber and blocking it would be a silent no-op.
 *   "ok"      — the file was read; these maps came FROM it. Mirroring allowed.
 *   "failed"  — hydrate ran and could not read the file. Mirroring BLOCKED: this is
 *               precisely the state in which the maps are defaults, not data.
 * `app.ts` awaits hydrate as its first statement, so in the browser the outcome is
 * always settled to ok/failed before any setter can fire — "pending" is unreachable
 * there by construction.
 */
type HydrateOutcome = "pending" | "ok" | "failed";
let hydrateOutcome: HydrateOutcome = "pending";

/**
 * Test seam. `hydrateOutcome` is module state, so without this a spec that
 * exercises a FAILED hydrate would silently gate every mirror assertion that runs
 * after it in the same file — an order-dependent suite that passes today and fails
 * the day someone reorders a describe. Production never calls this.
 */
export function __resetUiStateHydrationForTests(): void {
  hydrateOutcome = "pending";
  rehydrateFailures = 0;
  if (rehydrateTimer !== null) {
    clearTimeout(rehydrateTimer);
    rehydrateTimer = null;
  }
  mirrorFailures = 0;
  mirrorsInFlight = 0;
  lastMirrorStore = null;
  if (mirrorRetryTimer !== null) {
    clearTimeout(mirrorRetryTimer);
    mirrorRetryTimer = null;
  }
}

/** Arm the next self-retry of a failed hydrate. Idempotent: one timer, never two. */
function armRehydrateRetry(store: Storage): void {
  if (hydrateOutcome === "ok" || rehydrateTimer !== null) {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }
  const step = Math.min(Math.max(rehydrateFailures - 1, 0), REHYDRATE_BACKOFF_MS.length - 1);
  const delay = REHYDRATE_BACKOFF_MS[step] ?? 60_000;
  rehydrateTimer = setTimeout(() => {
    rehydrateTimer = null;
    void rehydrateUiState(store, REHYDRATE_TIMEOUT_MS);
  }, delay);
  unrefTimer(rehydrateTimer);
}

/** Node's timer handle can hold the process open; the browser's is a number and ignores this. */
type UnrefableTimer = { unref?: () => void };

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as UnrefableTimer;
  if (typeof handle.unref === "function") {
    // A pending mirror must never be the reason a vitest run refuses to exit.
    handle.unref();
  }
}

/**
 * The snapshot the endpoint should hold, built from the local store. Exported for the
 * tests and used by the mirror; it reads the maps VERBATIM and re-derives no defaults,
 * so an absent id stays absent and keeps meaning "the caller's stated default".
 */
export function readUiStateSnapshot(store: Storage = globalThis.localStorage): UiStateSnapshot {
  // Emitted only when non-empty: tombstones are union-only, so an empty map says nothing,
  // and leaving it out keeps the wire format unchanged for a profile that never closed a tab.
  const closedTabs = loadClosedTabs(store);
  return {
    collapsed: loadCollapsed(store),
    flags: loadFlags(store),
    choices: loadChoices(store),
    // Always emitted, never optional on this side: a POST that omitted it would leave the
    // file's tab list frozen at whatever it held when the key was introduced.
    tabs: loadTabList(store),
    ...(Object.keys(closedTabs).length > 0 ? { closedTabs } : {}),
  };
}

/**
 * Overwrite the local store from a snapshot. Exported for the tests and used by hydrate.
 * Also verbatim: it writes exactly the entries it was handed, so the delete-on-agreement
 * half of the invariant survives a round trip through the file — an entry the setters
 * deleted stays deleted instead of coming back as an explicit copy of the default.
 */
export function writeUiStateSnapshot(
  snap: UiStateSnapshot,
  store: Storage = globalThis.localStorage,
): void {
  writeMap(COLLAPSED_KEY, snap.collapsed, store);
  writeMap(FLAGS_KEY, snap.flags, store);
  writeMap(CHOICES_KEY, snap.choices, store);
  // Tombstones FIRST and as a union: a file that predates a local close must not undo it,
  // and writeTabList below filters through whatever this leaves in the store.
  writeMap(CLOSED_TABS_KEY, unionClosedTabs(loadClosedTabs(store), snap.closedTabs), store);
  // PRESENT-ONLY, and the asymmetry with the three maps above is the point. Those are
  // replaced wholesale because absence there is a MEANINGFUL value ("every control is at
  // its default"). For the tab list, absence is a store that predates the key — writing
  // `[]` for it would destroy a live list on the first reload after this shipped.
  if (snap.tabs !== undefined) {
    writeTabList(snap.tabs, store);
  }
}

/** `null` when the body is not a map at all — the caller then seeds NOTHING. */
function parseUiStateSnapshot(payload: unknown): UiStateSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  // FORK 2026-08-04: `degraded: true` is the server saying "I could not read the
  // store, this body is a placeholder — do NOT overwrite me". That contract was
  // written but never consumed: we used to coerce the empty maps, seed them over
  // the local cache, and return `true` (success), so a degraded response WIPED the
  // very state it was trying to protect. Treat it as no answer at all.
  if (raw.degraded === true) {
    return null;
  }
  return {
    collapsed: coerceMap(raw.collapsed, isBoolean),
    flags: coerceMap(raw.flags, isBoolean),
    choices: coerceMap(raw.choices, isString),
    // `undefined` (pre-2026-08-16 store) and `[]` (a genuinely empty list) must stay
    // DISTINCT all the way to `writeUiStateSnapshot` — see the note there. Anything
    // present but not an array coerces to `[]`, which is the same "unusable, so nothing
    // is saved" answer `coerceMap` gives, rather than a third state to reason about.
    tabs: raw.tabs === undefined ? undefined : coerceTabs(raw.tabs),
    closedTabs: raw.closedTabs === undefined ? undefined : coerceMap(raw.closedTabs, isEpoch),
  };
}

/**
 * Read the durable snapshot into the local store. Resolves `true` if it seeded, `false`
 * if the endpoint was unavailable, slow, unhappy or incoherent — in which case the local
 * store is left exactly as it was. NEVER rejects: app.ts awaits this at module scope, so
 * a rejection here is a black page, not a lost panel fold.
 */
function seatHeaders(): Record<string, string> {
  try {
    const id = sessionStorage.getItem("tinker.seatId");
    return id ? { "X-Tinker-Seat": id } : {};
  } catch {
    return {};
  }
}

// FORK 2026-09-21 — tab-resurrection tracing (the architect: closed tabs came back after a rebuild).
// Every POST names the bundle that sent it, so the server log shows whether a stale window
// or an old bundle wrote a tab back. `[tabs]` console lines trace the same path in the page.
declare const __UI_BUILD__: string;
function uiBuild(): string {
  return typeof __UI_BUILD__ === "string" ? __UI_BUILD__ : "unknown";
}
function tabIds(tabs: readonly TabRecord[] | undefined): string {
  return (tabs ?? [])
    .map((t) => `${String(t.id)}(${String(t.title ?? "").slice(0, 24)})`)
    .join(", ");
}

/**
 * One GET of the durable file, or `null`. Shared by the boot hydrate and the reconnect
 * re-hydrate so the two cannot drift on timeout, seat header or the `degraded` contract.
 * `hydrating` is held across the await so a mirror armed meanwhile cannot POST the
 * pre-hydrate cache over the very file it is being seeded from.
 */
async function fetchUiStateSnapshot(timeoutMs: number): Promise<UiStateSnapshot | null> {
  if (typeof fetch !== "function" || typeof AbortController !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  unrefTimer(timer);
  hydrating = true;
  try {
    const seat = seatHeaders();
    const get = (url: string) =>
      fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...seat },
        signal: controller.signal,
      });
    let res = await get(uiStateEndpoint);
    if (res.status === 404 && uiStateEndpoint === UI_STATE_ENDPOINT) {
      const alt = await get(UI_STATE_PLUGIN_ENDPOINT);
      if (alt.ok) {
        uiStateEndpoint = UI_STATE_PLUGIN_ENDPOINT;
        res = alt;
      }
    }
    if (!res.ok) {
      return null;
    }
    const payload: unknown = await res.json();
    return parseUiStateSnapshot(payload);
  } catch {
    // Aborted, offline, no such endpoint, or a body that is not JSON. All the same
    // answer: the UI boots on whatever the cache holds, which may be nothing.
    return null;
  } finally {
    clearTimeout(timer);
    hydrating = false;
  }
}

export async function hydrateUiState(
  store: Storage = globalThis.localStorage,
  timeoutMs: number = HYDRATE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const snap = await fetchUiStateSnapshot(timeoutMs);
    if (snap === null) {
      return false;
    }
    writeUiStateSnapshot(snap, store);
    console.info(
      `[tabs] boot hydrate (build ${uiBuild()}): file tabs [${tabIds(snap.tabs)}] · ` +
        `tombstones ${Object.keys(snap.closedTabs ?? {}).length} · restored [${tabIds(loadTabList(store))}]`,
    );
    // The only path that reached the file. Every other exit falls through to the
    // `finally`, which records "failed" and blocks the mirror.
    hydrateOutcome = "ok";
    return true;
  } finally {
    // Only promote from "pending". A page that hydrated cleanly once holds
    // authoritative maps, so a later transient failure must not silently stop it
    // mirroring; and a re-hydrate that succeeds flips "failed" back to "ok" above.
    if (hydrateOutcome === "pending") {
      hydrateOutcome = "failed";
      rehydrateFailures = 1;
      armRehydrateRetry(store);
      // Loud on purpose. This state used to be invisible for hours (2026-09-16): the page
      // kept working from its cache while nothing it did reached the file.
      console.warn(
        "[ui-state] boot hydrate failed — mirroring is OFF until the file has been read; retrying",
      );
    }
  }
}

/** Which way the boot hydrate went. `app.ts` consults it on every WebSocket handshake. */
export function uiStateHydrateOutcome(): HydrateOutcome {
  return hydrateOutcome;
}

/**
 * Fold the durable file INTO a live store instead of over it: an id the store already
 * holds keeps its local value, an id only the file knows is added. Tabs merge by `id` —
 * local list first, in its order, then the file's tabs the page has never seen. Exported
 * for the tests; `rehydrateUiState` is the one production caller.
 *
 * "Local wins" is the right bias for the only situation this runs in — a page that
 * booted WITHOUT the file. If Chrome wiped site data on exit, the local store is empty
 * and the file is taken wholesale. If it did not (crash, or a mid-session reload against
 * a restarting gateway), the local store IS the last good hydrate plus everything the
 * user did since, and that is newer than the file by construction. The one cost is a tab
 * closed while non-durable coming back from the file; a tab silently LOST for good is
 * the failure this replaces.
 */
export function mergeUiStateSnapshot(
  snap: UiStateSnapshot,
  store: Storage = globalThis.localStorage,
): void {
  writeMap(COLLAPSED_KEY, { ...snap.collapsed, ...loadCollapsed(store) }, store);
  writeMap(FLAGS_KEY, { ...snap.flags, ...loadFlags(store) }, store);
  writeMap(CHOICES_KEY, { ...snap.choices, ...loadChoices(store) }, store);
  // Before the tab merge: this is what stops the "file-only" tabs below being tabs this page
  // (or any page whose close reached the file) already closed.
  writeMap(CLOSED_TABS_KEY, unionClosedTabs(loadClosedTabs(store), snap.closedTabs), store);
  if (snap.tabs !== undefined) {
    const local = loadTabList(store);
    const seen = new Set(local.map((t) => t.id));
    const fileOnly = withoutClosedTabs(snap.tabs, loadClosedTabs(store)).filter(
      (t) => !seen.has(t.id),
    );
    writeTabList(coerceTabs([...local, ...fileOnly]), store);
  }
}

/**
 * FORK 2026-09-16 (the architect: "I just restarted the computer and Jarvis does not have the tabs
 * open the same way they were when I turned it off").
 *
 * The boot hydrate runs ONCE, as the first statement of app.ts. When it failed — the
 * gateway mid-restart (three crash-restarts between 23:26 and 00:18 that night), or the
 * 1500ms timeout on a cold machine — the mirror gate correctly refused to POST the
 * page's defaults over the file… and then nothing ever re-read the file. The page kept
 * working from its cache, looked perfectly normal, and for the next eight hours every
 * tab it opened, closed or renamed reached the server session store but NEVER the
 * durable file. The cold start after the reboot faithfully restored the file: the
 * evening's state, minus everything after the failed hydrate.
 *
 * This is the retry, and the WebSocket handshake is where it runs: a `hello` that just
 * landed proves the gateway is up, and app.ts calls this BEFORE the tab restore, so on
 * the first connect the tabs come from the merged truth, not the stale cache. A page
 * that hydrated cleanly at boot returns immediately — no second GET, no timing change
 * on the common path. On success the outcome flips to "ok" and a mirror is scheduled,
 * so the merged state lands on disk without waiting for the user to touch something.
 */
export async function rehydrateUiState(
  store: Storage = globalThis.localStorage,
  timeoutMs: number = HYDRATE_TIMEOUT_MS,
): Promise<boolean> {
  if (hydrateOutcome === "ok") {
    return true;
  }
  const snap = await fetchUiStateSnapshot(timeoutMs);
  if (snap === null) {
    // Still unreadable. Count it and keep asking — the ladder, not the next reconnect, is
    // now what ends this state (see `rehydrateTimer` above).
    rehydrateFailures += 1;
    armRehydrateRetry(store);
    return false;
  }
  if (rehydrateTimer !== null) {
    clearTimeout(rehydrateTimer);
    rehydrateTimer = null;
  }
  rehydrateFailures = 0;
  mergeUiStateSnapshot(snap, store);
  console.info(
    `[tabs] re-hydrate MERGE, local wins (build ${uiBuild()}): file tabs [${tabIds(snap.tabs)}] · ` +
      `restored [${tabIds(loadTabList(store))}]`,
  );
  hydrateOutcome = "ok";
  console.info("[ui-state] file re-read after a failed boot hydrate — mirroring is back ON");
  scheduleUiStateMirror(store);
  return true;
}

/**
 * FORK 2026-09-24 — read the response to the end, whatever it says. For a `keepalive` request
 * this is what hands Chrome's in-flight budget back (see `flushUiStateMirror`); for an ordinary
 * one it frees the connection sooner. A test double without a body is not an error.
 */
function drainResponse(res: Response): void {
  try {
    void res.text().catch(() => {
      /* the body failed mid-read — the status already said what we needed */
    });
  } catch {
    /* not a real Response */
  }
}

/**
 * FORK 2026-09-24 — a mirror that did not land is a durable file that is now BEHIND the page.
 * Say so, and ask again on a backoff: the snapshot is read when the retry fires, so the retry
 * carries the latest state, not the one that failed.
 */
function mirrorFailed(store: Storage, why: string): void {
  mirrorFailures += 1;
  const delay = MIRROR_RETRY_MS[Math.min(mirrorFailures - 1, MIRROR_RETRY_MS.length - 1)] ?? 60_000;
  console.warn(
    `[ui-state] mirror #${mirrorFailures} in a row did not land (${why}) — the durable file is ` +
      `behind this page; retrying in ${Math.round(delay / 1000)}s`,
  );
  if (mirrorRetryTimer !== null) {
    clearTimeout(mirrorRetryTimer);
  }
  mirrorRetryTimer = setTimeout(() => {
    mirrorRetryTimer = null;
    scheduleUiStateMirror(store);
  }, delay);
  unrefTimer(mirrorRetryTimer);
}

function mirrorLanded(): void {
  if (mirrorFailures > 0) {
    console.info(`[ui-state] mirror landed after ${mirrorFailures} failed attempt(s)`);
  }
  mirrorFailures = 0;
  if (mirrorRetryTimer !== null) {
    clearTimeout(mirrorRetryTimer);
    mirrorRetryTimer = null;
  }
}

/**
 * The debounce tail: reads the snapshot NOW, so a burst posts only its final state.
 * `finalFlush` is the pagehide path — the one request that must outlive the document.
 */
function flushUiStateMirror(finalFlush = false): void {
  mirrorTimer = null;
  const store = mirrorStore;
  mirrorStore = null;
  if (store === null) {
    return;
  }
  if (hydrating) {
    // A hydrate in flight is about to REPLACE these maps; posting them now would write
    // the state we are discarding back over the file. Re-arm instead — hydrate always
    // settles (it carries its own timeout), so this cannot spin forever.
    scheduleUiStateMirror(store);
    return;
  }
  if (hydrateOutcome === "failed") {
    // Hydrate ran and could not read the file (or read a `degraded` placeholder),
    // so these maps are whatever this page booted with — possibly empty defaults.
    // Posting them would overwrite good durable state. Drop the mirror; the next
    // page that hydrates cleanly resumes mirroring. See `hydrateOutcome`.
    return;
  }
  try {
    // FORK 2026-09-10 (the user: "upon restart, in the production tinker ui, the tabs open
    // before turning off don't appear open"). The seat header is CARRIED, never REQUIRED,
    // on the client. The hivemind-seats draft of 12:22 today returned early here whenever
    // sessionStorage held no `tinker.seatId` — and nothing sets one until the door lands
    // (plan units A/F) — so the laptop's production UI stopped mirroring altogether: the
    // desk file froze at 09:33 and the 17:52 reboot came back with a lone "🏠 Main" while
    // nine tabs sat in the file. Which desk a seat-less request lands on is the SERVER's
    // decision (owner desk, or 400 under TINKER_REQUIRE_SEAT=1 in a hive) — see
    // scripts/tinker-prod-ui.mjs, tinker-ui/vite.config.ts and the plugin route.
    //
    // FORK 2026-09-24 (the architect: "I have been deleting the SharePoint tab many times, and every time
    // I restart the machine it appears again, and the tab I leave open all the time goes back to
    // being closed"). Every mirror used to be `keepalive: true`, and nothing ever read the
    // response. Chrome counts a keepalive request's body against a 64 KB per-page budget until
    // its response has been consumed, so the budget was never handed back: a ~6.7 KB snapshot
    // meant the 10th mirror of every page was rejected INSIDE the browser ("TypeError: Failed to
    // fetch"), and so was every mirror after it, for the rest of the page's life. The rejection
    // went to a `.catch(() => {})`; the server never saw a request, so its tab trace had nothing
    // to log. Boot plus a few tab switches spent the nine; every close and open after that lived
    // only in localStorage, which this profile wipes on exit, and the reboot restored the file.
    // Measured headless against a private prod-ui: 9 landed, 37 rejected; with the body drained
    // or without keepalive, 36/36. So: routine mirrors are ordinary requests whose body is always
    // read; keepalive is reserved for the pagehide flush, the one POST that must outlive the page.
    const failures = mirrorFailures;
    if (!finalFlush) {
      mirrorsInFlight += 1;
    }
    void fetch(uiStateEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tinker-Build": uiBuild(),
        // Lets the server put a failure streak in its journal once a write gets through.
        ...(failures > 0 ? { "X-Tinker-Mirror-Failures": String(failures) } : {}),
        ...seatHeaders(),
      },
      body: JSON.stringify(readUiStateSnapshot(store)),
      keepalive: finalFlush,
    }).then(
      (res) => {
        if (!finalFlush) {
          mirrorsInFlight -= 1;
        }
        drainResponse(res);
        if (res.ok) {
          mirrorLanded();
        } else if (!finalFlush) {
          mirrorFailed(store, `HTTP ${res.status}`);
        }
      },
      (err: unknown) => {
        if (!finalFlush) {
          mirrorsInFlight -= 1;
          mirrorFailed(store, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        }
      },
    );
  } catch {
    /* a relative URL in a non-browser runtime throws synchronously — nothing to mirror */
  }
}

/**
 * Debounced, coalescing write-through of the whole snapshot to the durable endpoint.
 * Called at the tail of every setter and of the legacy migration. Never rejects, never
 * throws, and is a silent no-op wherever `fetch` does not exist.
 */
export function scheduleUiStateMirror(store: Storage = globalThis.localStorage): void {
  if (typeof fetch !== "function") {
    return;
  }
  // Last store wins, which is the same store at every production call site; the tests
  // are the only callers that pass a different one, and they pass it consistently.
  mirrorStore = store;
  lastMirrorStore = store;
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
  }
  mirrorTimer = setTimeout(flushUiStateMirror, MIRROR_DEBOUNCE_MS);
  unrefTimer(mirrorTimer);
}

/**
 * FORK 2026-09-21 — a mirror still inside its 250ms debounce used to die with the page: close a
 * tab, hit Ctrl+Shift+R, and the file (which then WINS the boot hydrate) still held the tab.
 * `pagehide` fires on reload, navigation and close alike; the flush posts with `keepalive`,
 * which is exactly the transport built to outlive the document.
 *
 * FORK 2026-09-24 — routine mirrors are no longer keepalive (see `flushUiStateMirror`), so one
 * still in flight when the page goes away could be cancelled with it. That is the case keepalive
 * used to cover, and it is covered here instead: a pending timer, a routine POST not yet
 * answered, or a failure streak all mean the file may be behind, so the last word is sent again
 * on the one transport built to survive the unload.
 */
export function flushPendingUiStateMirror(): void {
  const store = mirrorStore ?? (mirrorsInFlight > 0 || mirrorFailures > 0 ? lastMirrorStore : null);
  if (store === null) {
    return;
  }
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
  }
  mirrorStore = store;
  flushUiStateMirror(true);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushPendingUiStateMirror);
}
