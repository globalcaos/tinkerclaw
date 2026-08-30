// FORK 2026-08-02 (the architect): unified UI-state persistence.
//
// v1 of this file was `rpanel-collapse.test.ts` — one namespace, one hard-coded
// default ("absent = expanded"). The module it covers now owns THREE namespaces
// and takes the default from the CALLER at every call site, which is the only
// thing that lets default-expanded rpanels and default-collapsed model groups
// share one contract. The injected-`Storage` harness below is inherited verbatim:
// no DOM, no browser, each test builds its own store so nothing leaks.
//
// THE INVARIANT under test, in all three namespaces: an entry exists ONLY when the
// user's choice DIFFERS from the caller's stated default. Agreement deletes it.
//
// The DURABLE layer (hydrate / mirror / snapshot) is covered at the BOTTOM of this file,
// in its own describe with its own `globalThis.fetch` stub and fake clock. Everything up
// to that point is the pure storage contract and stays exactly as it was.
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import {
  CHOICES_KEY,
  COLLAPSED_KEY,
  FLAGS_KEY,
  MAX_PERSISTED_TABS,
  ORDER_DEFAULT,
  TABS_KEY,
  UI_STATE_ENDPOINT,
  applyStoredOrder,
  coerceTabs,
  getChoice,
  getFlag,
  getOrderedIds,
  setOrderedIds,
  __resetUiStateHydrationForTests,
  hydrateUiState,
  isCollapsed,
  loadCollapsed,
  loadTabList,
  migrateLegacyUiState,
  readUiStateSnapshot,
  scheduleUiStateMirror,
  setChoice,
  setCollapsed,
  setFlag,
  writeTabList,
  writeUiStateSnapshot,
  type UiStateSnapshot,
} from "./ui-state";

/**
 * Legacy keys are mirrored from the module on purpose — the test pins the WIRE
 * FORMAT that already sits in the architect's browser, not the module's constants. If the
 * module renames one of these, that is a data-loss bug and this file must red.
 */
const LEGACY_SESSIONS = "sessions-collapsed";
const LEGACY_EXEC_GROUP = "tinker.execGroupCollapsed."; // + <axisId>
const LEGACY_BOTTOM = "tinker.bottomCollapsed";
const LEGACY_RIGHT = "tinker.rightCollapsed";
const LEGACY_EXEC_MODE = "tinker.execMode";
const LEGACY_AMY_FRA = "tinker-amy-fra-toggles";
const LEGACY_ACTIVE_TAB = "tinker-active-tab";
const LEGACY_EXEC_TAB = "tinker.execTab";
const LEGACY_EXEC_FILTER = "tinker.execFilter";

/** In-memory Storage double. Each test builds its own, so nothing leaks between cases. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
    clear: (): void => {
      m.clear();
    },
    key: (i: number): string | null => [...m.keys()][i] ?? null,
    get length(): number {
      return m.size;
    },
  } as Storage;
}

/** Storage whose writes always fail — real behaviour at quota, and in private mode. */
function writeThrowingStorage(seed: Record<string, string> = {}): Storage {
  const base = fakeStorage(seed);
  return {
    getItem: (k: string): string | null => base.getItem(k),
    setItem: (): void => {
      throw new Error("QuotaExceededError");
    },
    removeItem: (k: string): void => base.removeItem(k),
    clear: (): void => base.clear(),
    key: (i: number): string | null => base.key(i),
    get length(): number {
      return base.length;
    },
  } as Storage;
}

/** Storage that refuses deletions — migration must not die halfway retiring a key. */
function removeThrowingStorage(seed: Record<string, string> = {}): Storage {
  const base = fakeStorage(seed);
  return {
    getItem: (k: string): string | null => base.getItem(k),
    setItem: (k: string, v: string): void => base.setItem(k, v),
    removeItem: (): void => {
      throw new Error("SecurityError: removal denied");
    },
    clear: (): void => base.clear(),
    key: (i: number): string | null => base.key(i),
    get length(): number {
      return base.length;
    },
  } as Storage;
}

/** Storage that throws on every access — SSR, or storage disabled by browser policy. */
function deadStorage(): Storage {
  const boom = (): never => {
    throw new Error("SecurityError: storage is disabled");
  };
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    get length(): number {
      return boom();
    },
  } as Storage;
}

/** The bytes the module actually wrote — read raw, never through our own parser. */
const rawOf = (store: Storage, key: string): string => store.getItem(key) ?? "";

/** Parsed form of one namespace key, or null when the key was never written. */
function parsedOf(store: Storage, key: string): unknown {
  const raw = store.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

/**
 * The invariant, checked against the BYTES: agreement with the default must leave
 * no trace of the id, not merely round-trip through the getter (a getter can hide a
 * stored `false` behind an identical default).
 */
function expectNoEntry(store: Storage, key: string, id: string): void {
  expect(rawOf(store, key)).not.toContain(id);
}

/**
 * Everything the module owns, parsed — for "a second migration changes nothing" and for
 * every "leaves the store untouched" assertion. `tabs` is in here so those assertions
 * cover the tab list too: a failed hydrate that quietly blanked it would otherwise pass
 * every existing test in this file while losing exactly the data the key exists to keep.
 */
function snapshot(store: Storage): Record<string, unknown> {
  return {
    collapsed: parsedOf(store, COLLAPSED_KEY),
    flags: parsedOf(store, FLAGS_KEY),
    choices: parsedOf(store, CHOICES_KEY),
    tabs: parsedOf(store, TABS_KEY),
  };
}

describe("namespace keys", () => {
  it("are the exact keys app.ts and any hand-edited storage agree on", () => {
    expect(COLLAPSED_KEY).toBe("tinker.rpanelCollapsed");
    expect(FLAGS_KEY).toBe("tinker.uiFlags");
    expect(CHOICES_KEY).toBe("tinker.uiChoices");
  });

  it("reads a v1 rpanel map in place — the upgrade must not reset the rail", () => {
    // `tinker.rpanelCollapsed` keeps its v1 name because it holds LIVE user data.
    // No migration call: v1 bytes must already be legal v2 bytes.
    const s = fakeStorage({ [COLLAPSED_KEY]: '{"sessions-panel":true,"budget-panel":true}' });
    expect(isCollapsed("sessions-panel", false, s)).toBe(true);
    expect(isCollapsed("budget-panel", false, s)).toBe(true);
    expect(isCollapsed("eeg-panel", false, s)).toBe(false);
  });
});

describe("THE INVARIANT — an empty store returns the caller's stated default", () => {
  it("collapsed: both polarities, including the omitted default", () => {
    const s = fakeStorage();
    expect(isCollapsed("x", false, s)).toBe(false);
    expect(isCollapsed("x", true, s)).toBe(true);
    // `defaultCollapsed` is optional and falls back to false, so v1 `.rpanel`
    // call sites (`isCollapsed(id, undefined, store)`) stay bit-identical.
    expect(isCollapsed("x", undefined, s)).toBe(false);
  });

  it("flag: both polarities", () => {
    const s = fakeStorage();
    expect(getFlag("topbar:exec", false, s)).toBe(false);
    expect(getFlag("topbar:fractal", true, s)).toBe(true);
  });

  it("choice: the fallback string comes back verbatim", () => {
    const s = fakeStorage();
    expect(getChoice("exec:tab", "today", s)).toBe("today");
    expect(getChoice("tab:active", "", s)).toBe("");
    expect(getChoice("exec:filter", "unfinished", s)).toBe("unfinished");
  });

  it("nothing is written just by READING a default", () => {
    const s = fakeStorage();
    isCollapsed("x", true, s);
    getFlag("topbar:fractal", true, s);
    getChoice("exec:tab", "today", s);
    expect(s.length).toBe(0);
  });

  it("loadCollapsed on an empty store is {}", () => {
    expect(loadCollapsed(fakeStorage())).toEqual({});
  });

  it("a stored value beats the default in every namespace", () => {
    const s = fakeStorage({
      [COLLAPSED_KEY]: '{"model:models":false,"budget-panel":true}',
      [FLAGS_KEY]: '{"topbar:fractal":false,"topbar:exec":true}',
      [CHOICES_KEY]: '{"exec:tab":"sessions"}',
    });
    expect(isCollapsed("model:models", true, s)).toBe(false);
    expect(isCollapsed("budget-panel", false, s)).toBe(true);
    expect(getFlag("topbar:fractal", true, s)).toBe(false);
    expect(getFlag("topbar:exec", false, s)).toBe(true);
    expect(getChoice("exec:tab", "today", s)).toBe("sessions");
  });
});

describe("differ-writes / agree-deletes, in all three namespaces", () => {
  it("collapsed (default expanded): collapsing writes, expanding deletes", () => {
    const s = fakeStorage();
    setCollapsed("budget-panel", true, false, s);
    expect(isCollapsed("budget-panel", false, s)).toBe(true);
    expect(parsedOf(s, COLLAPSED_KEY)).toEqual({ "budget-panel": true });

    setCollapsed("budget-panel", false, false, s);
    expect(isCollapsed("budget-panel", false, s)).toBe(false);
    expectNoEntry(s, COLLAPSED_KEY, "budget-panel");
    expect(loadCollapsed(s)).toEqual({});
  });

  it("collapsed (default COLLAPSED): collapsing leaves nothing, expanding writes false", () => {
    const s = fakeStorage();
    setCollapsed("model:models", true, true, s);
    expect(isCollapsed("model:models", true, s)).toBe(true);
    expectNoEntry(s, COLLAPSED_KEY, "model:models");

    setCollapsed("model:models", false, true, s);
    expect(isCollapsed("model:models", true, s)).toBe(false);
    // The stored `false` is the whole reason v1's contract had to change: it cannot
    // be expressed by a map whose absence means "expanded".
    expect(loadCollapsed(s)).toEqual({ "model:models": false });
  });

  it("deleting one id leaves its siblings alone", () => {
    const s = fakeStorage();
    setCollapsed("sessions-panel", true, false, s);
    setCollapsed("budget-panel", true, false, s);
    setCollapsed("sessions-panel", false, false, s);
    expect(loadCollapsed(s)).toEqual({ "budget-panel": true });
  });

  it("flag (default on): off writes, on deletes", () => {
    const s = fakeStorage();
    setFlag("topbar:fractal", true, true, s);
    expect(getFlag("topbar:fractal", true, s)).toBe(true);
    expectNoEntry(s, FLAGS_KEY, "topbar:fractal");

    setFlag("topbar:fractal", false, true, s);
    expect(getFlag("topbar:fractal", true, s)).toBe(false);
    expect(parsedOf(s, FLAGS_KEY)).toEqual({ "topbar:fractal": false });

    setFlag("topbar:fractal", true, true, s);
    expect(getFlag("topbar:fractal", true, s)).toBe(true);
    expectNoEntry(s, FLAGS_KEY, "topbar:fractal");
  });

  it("flag (default off): on writes, off deletes", () => {
    const s = fakeStorage();
    setFlag("topbar:exec", true, false, s);
    expect(getFlag("topbar:exec", false, s)).toBe(true);
    expect(parsedOf(s, FLAGS_KEY)).toEqual({ "topbar:exec": true });

    setFlag("topbar:exec", false, false, s);
    expect(getFlag("topbar:exec", false, s)).toBe(false);
    expectNoEntry(s, FLAGS_KEY, "topbar:exec");
  });

  it("choice: a different value writes, the fallback deletes", () => {
    const s = fakeStorage();
    setChoice("exec:tab", "today", "today", s);
    expect(getChoice("exec:tab", "today", s)).toBe("today");
    expectNoEntry(s, CHOICES_KEY, "exec:tab");

    setChoice("exec:tab", "sessions", "today", s);
    expect(getChoice("exec:tab", "today", s)).toBe("sessions");
    expect(parsedOf(s, CHOICES_KEY)).toEqual({ "exec:tab": "sessions" });

    setChoice("exec:tab", "today", "today", s);
    expect(getChoice("exec:tab", "today", s)).toBe("today");
    expectNoEntry(s, CHOICES_KEY, "exec:tab");
  });

  it("choice: the empty string is a value, not an absence", () => {
    const s = fakeStorage();
    // Default is a real tab id, so "no tab active" DIFFERS from it and must persist —
    // a getter written as `map[id] || fallback` silently loses this.
    setChoice("tab:active", "", "chat-1", s);
    expect(getChoice("tab:active", "chat-1", s)).toBe("");
    expect(parsedOf(s, CHOICES_KEY)).toEqual({ "tab:active": "" });
  });
});

describe("the three namespaces are independent", () => {
  it("a setter touches only its own key", () => {
    const s = fakeStorage();
    setCollapsed("dup", true, false, s);
    expect(s.getItem(FLAGS_KEY)).toBeNull();
    expect(s.getItem(CHOICES_KEY)).toBeNull();

    setFlag("dup", true, false, s);
    expect(s.getItem(CHOICES_KEY)).toBeNull();
    expect(parsedOf(s, COLLAPSED_KEY)).toEqual({ dup: true });

    setChoice("dup", "v", "", s);
    expect(parsedOf(s, COLLAPSED_KEY)).toEqual({ dup: true });
    expect(parsedOf(s, FLAGS_KEY)).toEqual({ dup: true });
    expect(parsedOf(s, CHOICES_KEY)).toEqual({ dup: "v" });
  });

  it("one id can hold three unrelated states without collision", () => {
    const s = fakeStorage();
    setCollapsed("dup", true, false, s);
    setFlag("dup", false, true, s);
    setChoice("dup", "v", "", s);
    expect(isCollapsed("dup", false, s)).toBe(true);
    expect(getFlag("dup", true, s)).toBe(false);
    expect(getChoice("dup", "", s)).toBe("v");
  });

  it("an id present in one namespace does not leak into another", () => {
    const s = fakeStorage();
    setCollapsed("only-collapsed", true, false, s);
    expect(getFlag("only-collapsed", false, s)).toBe(false);
    expect(getFlag("only-collapsed", true, s)).toBe(true);
    expect(getChoice("only-collapsed", "fallback", s)).toBe("fallback");

    setFlag("only-flag", true, false, s);
    expect(isCollapsed("only-flag", false, s)).toBe(false);
    expect(isCollapsed("only-flag", true, s)).toBe(true);
    expect(loadCollapsed(s)).toEqual({ "only-collapsed": true });
  });
});

describe("defensive parsing — junk never collapses arbitrary controls", () => {
  const JUNK = ['["budget-panel"]', '"budget-panel"', "42", "null", "true", "{not json", ""];

  it("collapsed: every junk payload reads as an empty map", () => {
    for (const junk of JUNK) {
      const s = fakeStorage({ [COLLAPSED_KEY]: junk });
      expect(loadCollapsed(s)).toEqual({});
      expect(isCollapsed("budget-panel", false, s)).toBe(false);
      expect(isCollapsed("model:models", true, s)).toBe(true);
    }
  });

  it("flag: every junk payload falls back to the caller's default", () => {
    for (const junk of JUNK) {
      const s = fakeStorage({ [FLAGS_KEY]: junk });
      expect(getFlag("topbar:exec", false, s)).toBe(false);
      expect(getFlag("topbar:fractal", true, s)).toBe(true);
    }
  });

  it("choice: every junk payload falls back to the caller's default", () => {
    for (const junk of JUNK) {
      const s = fakeStorage({ [CHOICES_KEY]: junk });
      expect(getChoice("exec:tab", "today", s)).toBe("today");
    }
  });

  it("wrong-typed entries are dropped while good siblings survive", () => {
    const collapsed = fakeStorage({
      [COLLAPSED_KEY]: '{"a":true,"b":"yes","c":1,"d":null,"e":false}',
    });
    expect(loadCollapsed(collapsed)).toEqual({ a: true, e: false });
    expect(isCollapsed("b", false, collapsed)).toBe(false);
    expect(isCollapsed("b", true, collapsed)).toBe(true);

    const flags = fakeStorage({ [FLAGS_KEY]: '{"a":true,"b":"yes","c":1,"d":null}' });
    expect(getFlag("a", false, flags)).toBe(true);
    expect(getFlag("b", false, flags)).toBe(false);
    expect(getFlag("c", true, flags)).toBe(true);
    expect(getFlag("d", true, flags)).toBe(true);

    const choices = fakeStorage({ [CHOICES_KEY]: '{"a":"x","b":5,"c":true,"d":null}' });
    expect(getChoice("a", "z", choices)).toBe("x");
    expect(getChoice("b", "z", choices)).toBe("z");
    expect(getChoice("c", "z", choices)).toBe("z");
    expect(getChoice("d", "z", choices)).toBe("z");
  });

  it("a corrupt map does not wedge the toggle — the next write heals it", () => {
    const s = fakeStorage({
      [COLLAPSED_KEY]: "]]garbage[[",
      [FLAGS_KEY]: "]]garbage[[",
      [CHOICES_KEY]: "]]garbage[[",
    });
    setCollapsed("budget-panel", true, false, s);
    setFlag("topbar:exec", true, false, s);
    setChoice("exec:tab", "sessions", "today", s);
    expect(loadCollapsed(s)).toEqual({ "budget-panel": true });
    expect(parsedOf(s, FLAGS_KEY)).toEqual({ "topbar:exec": true });
    expect(parsedOf(s, CHOICES_KEY)).toEqual({ "exec:tab": "sessions" });
  });
});

describe("hostile storage never reaches the caller", () => {
  it("a read that throws yields the caller's default in every namespace", () => {
    const s = deadStorage();
    expect(loadCollapsed(s)).toEqual({});
    expect(isCollapsed("sessions-panel", false, s)).toBe(false);
    expect(isCollapsed("model:models", true, s)).toBe(true);
    expect(getFlag("topbar:exec", false, s)).toBe(false);
    expect(getFlag("topbar:fractal", true, s)).toBe(true);
    expect(getChoice("exec:tab", "today", s)).toBe("today");
  });

  it("writes and the migration are silent against dead storage", () => {
    const s = deadStorage();
    expect(() => setCollapsed("sessions-panel", true, false, s)).not.toThrow();
    expect(() => setFlag("topbar:exec", true, false, s)).not.toThrow();
    expect(() => setChoice("exec:tab", "sessions", "today", s)).not.toThrow();
    expect(() => migrateLegacyUiState(s)).not.toThrow();
  });

  it("a write that throws (quota / private mode) is swallowed", () => {
    const s = writeThrowingStorage({
      [LEGACY_SESSIONS]: "1",
      [LEGACY_EXEC_MODE]: "exec",
      [`${LEGACY_EXEC_GROUP}axis-a`]: "1",
    });
    expect(() => setCollapsed("budget-panel", true, false, s)).not.toThrow();
    expect(() => setFlag("topbar:exec", true, false, s)).not.toThrow();
    expect(() => setChoice("exec:tab", "sessions", "today", s)).not.toThrow();
    expect(() => migrateLegacyUiState(s)).not.toThrow();
    // Nothing persisted, and the getters still answer with the caller's default.
    expect(isCollapsed("budget-panel", false, s)).toBe(false);
    expect(getFlag("topbar:exec", false, s)).toBe(false);
  });

  it("a removeItem that throws does not abort the boot", () => {
    const s = removeThrowingStorage({
      [LEGACY_SESSIONS]: "1",
      [LEGACY_BOTTOM]: "1",
      [`${LEGACY_EXEC_GROUP}axis-a`]: "1",
      [LEGACY_AMY_FRA]: '{"fractal":false}',
    });
    expect(() => migrateLegacyUiState(s)).not.toThrow();
  });
});

describe("migrateLegacyUiState — the legacy table", () => {
  it("sessions-collapsed folds into the collapsed namespace and retires", () => {
    const on = fakeStorage({ [LEGACY_SESSIONS]: "1" });
    migrateLegacyUiState(on);
    expect(isCollapsed("sessions-panel", false, on)).toBe(true);
    expect(on.getItem(LEGACY_SESSIONS)).toBeNull();

    const off = fakeStorage({ [LEGACY_SESSIONS]: "0" });
    migrateLegacyUiState(off);
    expect(isCollapsed("sessions-panel", false, off)).toBe(false);
    expectNoEntry(off, COLLAPSED_KEY, "sessions-panel");
    expect(off.getItem(LEGACY_SESSIONS)).toBeNull();
  });

  it("tinker.execGroupCollapsed.<axisId> folds to collapsed exec:<axisId>", () => {
    const s = fakeStorage({
      [`${LEGACY_EXEC_GROUP}axis-a`]: "1",
      [`${LEGACY_EXEC_GROUP}axis-b`]: "0",
      [`${LEGACY_EXEC_GROUP}__unsorted__`]: "1",
    });
    migrateLegacyUiState(s);
    expect(isCollapsed("exec:axis-a", false, s)).toBe(true);
    expect(isCollapsed("exec:axis-b", false, s)).toBe(false);
    expect(isCollapsed("exec:__unsorted__", false, s)).toBe(true);
    expectNoEntry(s, COLLAPSED_KEY, "exec:axis-b");
    expect(s.getItem(`${LEGACY_EXEC_GROUP}axis-a`)).toBeNull();
    expect(s.getItem(`${LEGACY_EXEC_GROUP}axis-b`)).toBeNull();
    expect(s.getItem(`${LEGACY_EXEC_GROUP}__unsorted__`)).toBeNull();
  });

  it("the prefix scan does not skip entries while it mutates the store", () => {
    // A scan that walks key(i) upward while removing keys drops every other entry.
    // Five ids make that failure unmistakable; the decoy must survive untouched
    // because it is NOT an exec-group key.
    const ids = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const seed: Record<string, string> = { "tinker-unrelated": "keep-me" };
    for (const id of ids) {
      seed[`${LEGACY_EXEC_GROUP}${id}`] = "1";
    }
    const s = fakeStorage(seed);
    migrateLegacyUiState(s);
    for (const id of ids) {
      expect(isCollapsed(`exec:${id}`, false, s)).toBe(true);
      expect(s.getItem(`${LEGACY_EXEC_GROUP}${id}`)).toBeNull();
    }
    expect(s.getItem("tinker-unrelated")).toBe("keep-me");
  });

  it("tinker.bottomCollapsed INVERTS into flag topbar:timeline", () => {
    const collapsed = fakeStorage({ [LEGACY_BOTTOM]: "1" });
    migrateLegacyUiState(collapsed);
    expect(getFlag("topbar:timeline", true, collapsed)).toBe(false);
    expect(collapsed.getItem(LEGACY_BOTTOM)).toBeNull();

    const open = fakeStorage({ [LEGACY_BOTTOM]: "0" });
    migrateLegacyUiState(open);
    expect(getFlag("topbar:timeline", true, open)).toBe(true);
    expectNoEntry(open, FLAGS_KEY, "topbar:timeline");
    expect(open.getItem(LEGACY_BOTTOM)).toBeNull();
  });

  it("tinker.rightCollapsed INVERTS into flag topbar:models", () => {
    const collapsed = fakeStorage({ [LEGACY_RIGHT]: "1" });
    migrateLegacyUiState(collapsed);
    expect(getFlag("topbar:models", true, collapsed)).toBe(false);
    expect(collapsed.getItem(LEGACY_RIGHT)).toBeNull();

    const open = fakeStorage({ [LEGACY_RIGHT]: "0" });
    migrateLegacyUiState(open);
    expect(getFlag("topbar:models", true, open)).toBe(true);
    expectNoEntry(open, FLAGS_KEY, "topbar:models");
    expect(open.getItem(LEGACY_RIGHT)).toBeNull();
  });

  it("tinker.execMode folds to flag topbar:exec — only the literal exec is on", () => {
    const on = fakeStorage({ [LEGACY_EXEC_MODE]: "exec" });
    migrateLegacyUiState(on);
    expect(getFlag("topbar:exec", false, on)).toBe(true);
    expect(on.getItem(LEGACY_EXEC_MODE)).toBeNull();

    const off = fakeStorage({ [LEGACY_EXEC_MODE]: "dev" });
    migrateLegacyUiState(off);
    expect(getFlag("topbar:exec", false, off)).toBe(false);
    expectNoEntry(off, FLAGS_KEY, "topbar:exec");
    expect(off.getItem(LEGACY_EXEC_MODE)).toBeNull();
  });

  it("tinker-amy-fra-toggles .fractal folds to flag topbar:fractal", () => {
    const off = fakeStorage({ [LEGACY_AMY_FRA]: '{"fractal":false}' });
    migrateLegacyUiState(off);
    expect(getFlag("topbar:fractal", true, off)).toBe(false);
    expect(off.getItem(LEGACY_AMY_FRA)).toBeNull();

    const on = fakeStorage({ [LEGACY_AMY_FRA]: '{"fractal":true}' });
    migrateLegacyUiState(on);
    expect(getFlag("topbar:fractal", true, on)).toBe(true);
    expectNoEntry(on, FLAGS_KEY, "topbar:fractal");
    expect(on.getItem(LEGACY_AMY_FRA)).toBeNull();
  });

  it("malformed tinker-amy-fra-toggles is skipped without throwing, and still retires", () => {
    for (const junk of ["{not json", '["fractal"]', '"fractal"', "null", "42"]) {
      const s = fakeStorage({ [LEGACY_AMY_FRA]: junk });
      expect(() => migrateLegacyUiState(s)).not.toThrow();
      expect(getFlag("topbar:fractal", true, s)).toBe(true);
      expectNoEntry(s, FLAGS_KEY, "topbar:fractal");
      expect(s.getItem(LEGACY_AMY_FRA)).toBeNull();
    }
  });

  it("tinker-active-tab folds to choice tab:active", () => {
    const s = fakeStorage({ [LEGACY_ACTIVE_TAB]: "tab-7" });
    migrateLegacyUiState(s);
    expect(getChoice("tab:active", "", s)).toBe("tab-7");
    expect(s.getItem(LEGACY_ACTIVE_TAB)).toBeNull();
  });

  it("tinker.execTab and tinker.execFilter fold to their choices", () => {
    const s = fakeStorage({ [LEGACY_EXEC_TAB]: "sessions", [LEGACY_EXEC_FILTER]: "all" });
    migrateLegacyUiState(s);
    expect(getChoice("exec:tab", "today", s)).toBe("sessions");
    expect(getChoice("exec:filter", "unfinished", s)).toBe("all");
    expect(s.getItem(LEGACY_EXEC_TAB)).toBeNull();
    expect(s.getItem(LEGACY_EXEC_FILTER)).toBeNull();

    // A legacy value that already equals the default leaves no entry behind.
    const same = fakeStorage({ [LEGACY_EXEC_TAB]: "today" });
    migrateLegacyUiState(same);
    expect(getChoice("exec:tab", "today", same)).toBe("today");
    expectNoEntry(same, CHOICES_KEY, "exec:tab");
    expect(same.getItem(LEGACY_EXEC_TAB)).toBeNull();
  });

  it("folds a whole pre-unification profile in one pass", () => {
    const s = fakeStorage({
      [LEGACY_SESSIONS]: "1",
      [`${LEGACY_EXEC_GROUP}axis-a`]: "1",
      [`${LEGACY_EXEC_GROUP}__unsorted__`]: "1",
      [LEGACY_BOTTOM]: "1",
      [LEGACY_RIGHT]: "1",
      [LEGACY_EXEC_MODE]: "exec",
      [LEGACY_AMY_FRA]: '{"fractal":false}',
      [LEGACY_ACTIVE_TAB]: "tab-7",
      [LEGACY_EXEC_TAB]: "sessions",
      [LEGACY_EXEC_FILTER]: "all",
    });
    migrateLegacyUiState(s);

    expect(loadCollapsed(s)).toEqual({
      "sessions-panel": true,
      "exec:axis-a": true,
      "exec:__unsorted__": true,
    });
    expect(getFlag("topbar:timeline", true, s)).toBe(false);
    expect(getFlag("topbar:models", true, s)).toBe(false);
    expect(getFlag("topbar:exec", false, s)).toBe(true);
    expect(getFlag("topbar:fractal", true, s)).toBe(false);
    expect(getChoice("tab:active", "", s)).toBe("tab-7");
    expect(getChoice("exec:tab", "today", s)).toBe("sessions");
    expect(getChoice("exec:filter", "unfinished", s)).toBe("all");

    for (const legacy of [
      LEGACY_SESSIONS,
      `${LEGACY_EXEC_GROUP}axis-a`,
      `${LEGACY_EXEC_GROUP}__unsorted__`,
      LEGACY_BOTTOM,
      LEGACY_RIGHT,
      LEGACY_EXEC_MODE,
      LEGACY_AMY_FRA,
      LEGACY_ACTIVE_TAB,
      LEGACY_EXEC_TAB,
      LEGACY_EXEC_FILTER,
    ]) {
      expect(s.getItem(legacy)).toBeNull();
    }
  });
});

describe("migrateLegacyUiState — idempotent, and the new store always wins", () => {
  it("a second boot changes nothing", () => {
    const s = fakeStorage({
      [LEGACY_SESSIONS]: "1",
      [`${LEGACY_EXEC_GROUP}axis-a`]: "1",
      [LEGACY_BOTTOM]: "1",
      [LEGACY_EXEC_MODE]: "exec",
      [LEGACY_EXEC_TAB]: "sessions",
    });
    migrateLegacyUiState(s);
    const first = snapshot(s);
    migrateLegacyUiState(s);
    expect(snapshot(s)).toEqual(first);
  });

  it("cannot resurrect a value the user changed after the upgrade", () => {
    const s = fakeStorage({ [LEGACY_SESSIONS]: "1", [LEGACY_EXEC_TAB]: "sessions" });
    migrateLegacyUiState(s);
    setCollapsed("sessions-panel", false, false, s); // the user expands it
    setChoice("exec:tab", "today", "today", s); // …and goes back to Today
    migrateLegacyUiState(s); // …and reboots
    expect(isCollapsed("sessions-panel", false, s)).toBe(false);
    expect(getChoice("exec:tab", "today", s)).toBe("today");
    expectNoEntry(s, COLLAPSED_KEY, "sessions-panel");
    expectNoEntry(s, CHOICES_KEY, "exec:tab");
  });

  it("never clobbers an explicit entry the new store already owns", () => {
    // Seeded raw, because an explicit `false` under a default-expanded id is exactly
    // what the setter refuses to write — and it must still survive the migration.
    const s = fakeStorage({
      [COLLAPSED_KEY]: '{"sessions-panel":false}',
      [LEGACY_SESSIONS]: "1",
    });
    migrateLegacyUiState(s);
    expect(isCollapsed("sessions-panel", false, s)).toBe(false);
    expect(s.getItem(LEGACY_SESSIONS)).toBeNull();
  });

  it("never clobbers a newer value with a stale legacy one", () => {
    const s = fakeStorage();
    setCollapsed("exec:axis-a", true, false, s); // user collapsed it after the upgrade
    setFlag("topbar:exec", true, false, s);
    setChoice("exec:tab", "sessions", "today", s);
    // …while the legacy keys still say the opposite.
    s.setItem(`${LEGACY_EXEC_GROUP}axis-a`, "0");
    s.setItem(LEGACY_EXEC_MODE, "dev");
    s.setItem(LEGACY_EXEC_TAB, "people");

    migrateLegacyUiState(s);

    expect(isCollapsed("exec:axis-a", false, s)).toBe(true);
    expect(getFlag("topbar:exec", false, s)).toBe(true);
    expect(getChoice("exec:tab", "today", s)).toBe("sessions");
    expect(s.getItem(`${LEGACY_EXEC_GROUP}axis-a`)).toBeNull();
    expect(s.getItem(LEGACY_EXEC_MODE)).toBeNull();
    expect(s.getItem(LEGACY_EXEC_TAB)).toBeNull();
  });

  it("is a no-op on a store with no legacy keys at all", () => {
    const s = fakeStorage({
      [COLLAPSED_KEY]: '{"budget-panel":true}',
      [FLAGS_KEY]: '{"topbar:fractal":false}',
      [CHOICES_KEY]: '{"exec:filter":"all"}',
    });
    const before = snapshot(s);
    migrateLegacyUiState(s);
    expect(snapshot(s)).toEqual(before);
  });
});

describe("the store argument is optional", () => {
  it("a getter with no store degrades instead of throwing", () => {
    // Read-only on purpose: this project runs with `isolate: false`, so a write to
    // the shared jsdom localStorage would leak into every other test file.
    expect(() => isCollapsed("ui-state-test:absent-probe", false)).not.toThrow();
    expect(() => getFlag("ui-state-test:absent-probe", true)).not.toThrow();
    expect(() => getChoice("ui-state-test:absent-probe", "fallback")).not.toThrow();
  });
});

// ── the durable layer: the three namespaces, backed by a file ─────────────────────────
// localStorage is per browser PROFILE: a new browser, a cleared profile or a second
// machine booted the rail back to defaults with no way to get the old shape back. The
// durable layer mirrors all three maps to the gateway behind UI_STATE_ENDPOINT and
// hydrates from it once, at boot. localStorage stays the READ path — it is synchronous
// and the UI paints from it — so the file is a backup that wins exactly once.
//
// The two rules easiest to break by accident, both pinned below:
//   1. THE FILE WINS at hydration. It REPLACES the local maps; it does not merge under
//      them, or a stale local entry outlives the very restore meant to erase it.
//   2. `writeUiStateSnapshot` is VERBATIM. differ-writes/agree-deletes is the SETTERS'
//      rule — they are handed the caller's default and hydration never is. Re-deriving it
//      here silently drops every entry that happens to equal today's default.
// And the whole layer is best-effort in BOTH directions: a gateway that is down must
// never wipe, freeze or throw into the rail.

/** Comfortably past the ~250ms mirror debounce, on a fake clock or a real one. */
const MIRROR_SETTLE_MS = 600;

/** `[url, init]` as recorded by the fetch spy. */
type FetchCall = [input: unknown, init?: RequestInit];

/** Three empty maps and no tabs — what an untouched profile mirrors. */
function emptySnapshot(): UiStateSnapshot {
  return { collapsed: {}, flags: {}, choices: {}, tabs: [] };
}

/**
 * One entry per map namespace; small enough to assert whole, in a single `toEqual`.
 * `tabs` stays EMPTY here on purpose: `writeSampleWithSetters` below produces this
 * snapshot through the ordinary setters, and none of them writes a tab. The tab list
 * gets its own fixtures rather than being smuggled into the shared one.
 */
function sampleSnapshot(): UiStateSnapshot {
  return {
    collapsed: { "budget-panel": true },
    flags: { "topbar:exec": true },
    choices: { "exec:tab": "sessions" },
    tabs: [],
  };
}

/**
 * A tab list as app.ts actually persists one. Deliberately carries `titleLocked` — a
 * field this module has never heard of — because carrying unknown fields THROUGH is the
 * contract, not an accident of the fixture.
 */
function sampleTabs(): Record<string, unknown>[] {
  return [
    { id: "tab-main", sessionKey: "agent:main:main", title: "🏠 Main", isAttached: true },
    {
      id: "tab-abc",
      sessionKey: "agent:main:tinker:abc",
      title: "🏷️ Fix the outbox",
      isAttached: true,
      titleLocked: true,
    },
  ];
}

/** The setter calls that produce exactly `sampleSnapshot()`, so the two stay in step. */
function writeSampleWithSetters(store: Storage): void {
  setCollapsed("budget-panel", true, false, store);
  setFlag("topbar:exec", true, false, store);
  setChoice("exec:tab", "sessions", "today", store);
}

/** A store holding a hand-written entry in each namespace — the "untouched" baseline. */
function seededStore(): Storage {
  return fakeStorage({
    [COLLAPSED_KEY]: '{"budget-panel":false,"stale-panel":true}',
    [FLAGS_KEY]: '{"topbar:fractal":false}',
    [CHOICES_KEY]: '{"exec:filter":"all"}',
  });
}

/** Response double over raw bytes — `json()` REJECTS on junk, exactly like the real one. */
function rawResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: (): Promise<unknown> => new Promise((resolve) => resolve(JSON.parse(text) as unknown)),
    text: (): Promise<string> => Promise.resolve(text),
  } as unknown as Response;
}

/** Response double carrying a JSON-encoded value. */
function jsonResponse(value: unknown, status = 200): Response {
  return rawResponse(JSON.stringify(value), status);
}

/** Install or restore `globalThis.fetch` without repeating the cast at every call site. */
function setFetch(impl: unknown): void {
  (globalThis as unknown as { fetch: unknown }).fetch = impl;
}

/** One recorded fetch call, typed. */
function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  return mock.mock.calls[index] as FetchCall;
}

/** The parsed JSON body of a recorded request. */
function bodyOf(init: RequestInit | undefined): unknown {
  expect(typeof init?.body).toBe("string");
  return JSON.parse(String(init?.body)) as unknown;
}

/** One request header, whichever of the three HeadersInit shapes the caller happened to use. */
function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  const wanted = name.toLowerCase();
  if (headers === undefined) {
    return "";
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === wanted)?.[1] ?? "";
  }
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? "";
  }
  const found = Object.entries(headers as Record<string, string>).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return found?.[1] ?? "";
}

describe("the durable layer — the three namespaces, backed by a file", () => {
  const realFetch: unknown = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    // Every setter now schedules a mirror, so the tests above left ONE debounced REAL
    // timer pending. Drain it against a throwaway stub while the clock is still real —
    // otherwise that stray POST lands inside whichever test below is counting calls.
    setFetch(vi.fn(() => Promise.resolve(jsonResponse(emptySnapshot()))));
    await new Promise((resolve) => setTimeout(resolve, MIRROR_SETTLE_MS));
    setFetch(realFetch);
  });

  beforeEach(() => {
    // Fake timers for EVERY test here, not only the debounce ones: a test that left a
    // real 250ms mirror pending would fire it inside a later test's call count.
    // `vi.useRealTimers()` in afterEach discards whatever this test scheduled.
    vi.useFakeTimers();
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(sampleSnapshot())));
    setFetch(fetchMock);
    // The mirror is gated on the hydrate outcome, which is MODULE state. Without this
    // reset, a spec exercising a failed hydrate would gate every later mirror
    // assertion in this file and the suite would depend on describe order.
    __resetUiStateHydrationForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    setFetch(realFetch);
  });

  describe("readUiStateSnapshot / writeUiStateSnapshot", () => {
    it("reads back exactly what the setters wrote, one namespace each", () => {
      const s = fakeStorage();
      writeSampleWithSetters(s);
      expect(readUiStateSnapshot(s)).toEqual(sampleSnapshot());
    });

    it("an empty store snapshots to three empty maps, never to undefined", () => {
      expect(readUiStateSnapshot(fakeStorage())).toEqual(emptySnapshot());
    });

    it("round-trips into a different store, through the ordinary getters", () => {
      const source = fakeStorage();
      writeSampleWithSetters(source);

      const target = fakeStorage();
      writeUiStateSnapshot(readUiStateSnapshot(source), target);

      expect(readUiStateSnapshot(target)).toEqual(readUiStateSnapshot(source));
      expect(isCollapsed("budget-panel", false, target)).toBe(true);
      expect(getFlag("topbar:exec", false, target)).toBe(true);
      expect(getChoice("exec:tab", "today", target)).toBe("sessions");
    });

    it("keeps the three namespaces separate — one id, three unrelated values", () => {
      const s = fakeStorage();
      writeUiStateSnapshot(
        { collapsed: { dup: true }, flags: { dup: false }, choices: { dup: "v" } },
        s,
      );
      expect(parsedOf(s, COLLAPSED_KEY)).toEqual({ dup: true });
      expect(parsedOf(s, FLAGS_KEY)).toEqual({ dup: false });
      expect(parsedOf(s, CHOICES_KEY)).toEqual({ dup: "v" });
      expect(isCollapsed("dup", false, s)).toBe(true);
      expect(getFlag("dup", true, s)).toBe(false);
      expect(getChoice("dup", "", s)).toBe("v");
    });

    it("writes the maps VERBATIM — it must not re-derive the agree-deletes rule", () => {
      // Each of these entries AGREES with the default its call site uses, so a SETTER
      // would have deleted it. Hydration is not told the caller's default and must copy
      // the file through untouched — dropping them here is how a restored profile
      // silently loses the controls the user had explicitly pinned.
      const s = fakeStorage();
      writeUiStateSnapshot(
        {
          collapsed: { "budget-panel": false },
          flags: { "topbar:exec": false },
          choices: { "exec:tab": "today" },
        },
        s,
      );
      expect(parsedOf(s, COLLAPSED_KEY)).toEqual({ "budget-panel": false });
      expect(parsedOf(s, FLAGS_KEY)).toEqual({ "topbar:exec": false });
      expect(parsedOf(s, CHOICES_KEY)).toEqual({ "exec:tab": "today" });
      expect(rawOf(s, COLLAPSED_KEY)).toContain("budget-panel");
      expect(readUiStateSnapshot(s).collapsed).toEqual({ "budget-panel": false });
    });

    it("REPLACES the local maps wholesale — it does not merge under them", () => {
      const s = seededStore();
      writeUiStateSnapshot(sampleSnapshot(), s);
      expect(readUiStateSnapshot(s)).toEqual(sampleSnapshot());
      expectNoEntry(s, COLLAPSED_KEY, "stale-panel");
      expect(getChoice("exec:filter", "unfinished", s)).toBe("unfinished");
    });
  });

  // FORK 2026-08-16 (the architect: "when I close the browser and restart it, the tinker ui tabs
  // that I had opened are not anymore. Make them reopen as if I just refreshed the
  // page"). The tab list was the one piece of UI chrome still living ONLY in
  // localStorage, so it was the one piece a clean browser exit destroyed. `tab:active`
  // was already durable, which is why the UI came back pointing at a tab that no longer
  // existed and settled on a lone "🏠 Main".
  describe("the tab list — the fourth namespace, and the only non-map one", () => {
    it("uses the key app.ts already had, so an existing list is picked up, not orphaned", () => {
      // The whole upgrade rests on this: adopt the live key rather than mint a new one,
      // or every user starts from zero tabs the day this ships.
      expect(TABS_KEY).toBe("tinker-tabs");
    });

    it("round-trips a tab list, unknown fields and all", () => {
      const s = fakeStorage();
      writeTabList(sampleTabs(), s);
      expect(loadTabList(s)).toEqual(sampleTabs());
      expect(readUiStateSnapshot(s).tabs).toEqual(sampleTabs());
    });

    it("an absent, empty or unparseable value reads as no tabs, never as a throw", () => {
      expect(loadTabList(fakeStorage())).toEqual([]);
      expect(loadTabList(fakeStorage({ [TABS_KEY]: "" }))).toEqual([]);
      expect(loadTabList(fakeStorage({ [TABS_KEY]: "{not json" }))).toEqual([]);
      expect(loadTabList(deadStorage())).toEqual([]);
      // A write that cannot land must not propagate either — same contract as writeMap.
      expect(() => {
        writeTabList(sampleTabs(), writeThrowingStorage());
      }).not.toThrow();
    });

    it("anything that is not an array of objects is not a tab list", () => {
      for (const junk of [{ id: "tab-main" }, "tabs", 42, null, true, undefined]) {
        expect(coerceTabs(junk)).toEqual([]);
      }
      // One junk ENTRY costs that entry alone — never the user's other tabs. A nested
      // array is junk too: `Tab` is an object, and app.ts could not render anything else.
      expect(coerceTabs([{ id: "a" }, null, "x", 7, ["nested"], { id: "b" }])).toEqual([
        { id: "a" },
        { id: "b" },
      ]);
    });

    it("caps the persisted list so a runaway writer cannot fill the endpoint body", () => {
      const many = Array.from({ length: MAX_PERSISTED_TABS + 50 }, (_, i) => ({ id: `tab-${i}` }));
      expect(coerceTabs(many)).toHaveLength(MAX_PERSISTED_TABS);
      expect(coerceTabs(many)[0]).toEqual({ id: "tab-0" });
    });

    // THE UPGRADE CASE, and the one that would have re-created the bug. A store written
    // before this key existed has no `tabs`. If hydrate read that absence as "you have no
    // tabs" it would blank the live list on the first reload after shipping — a fix that
    // causes its own bug, on every existing profile, exactly once, invisibly.
    it("a snapshot with NO tabs section leaves the stored list alone", () => {
      const s = fakeStorage();
      writeTabList(sampleTabs(), s);
      writeUiStateSnapshot({ collapsed: {}, flags: {}, choices: {} }, s);
      expect(loadTabList(s)).toEqual(sampleTabs());
    });

    it("an EMPTY tabs section is an answer, and does clear the list", () => {
      // The distinction absent/empty is the whole reason `tabs` is optional. A user who
      // genuinely closed every tab but Main must not have old tabs resurrected.
      const s = fakeStorage();
      writeTabList(sampleTabs(), s);
      writeUiStateSnapshot({ collapsed: {}, flags: {}, choices: {}, tabs: [] }, s);
      expect(loadTabList(s)).toEqual([]);
    });

    it("hydrating from a legacy file keeps the local tabs while replacing the maps", async () => {
      const s = seededStore();
      writeTabList(sampleTabs(), s);
      setFetch(
        vi.fn(() =>
          Promise.resolve(
            jsonResponse({
              collapsed: { "budget-panel": true },
              flags: {},
              choices: {},
            }),
          ),
        ),
      );
      await expect(hydrateUiState(s)).resolves.toBe(true);
      expect(isCollapsed("budget-panel", false, s)).toBe(true);
      expect(loadTabList(s)).toEqual(sampleTabs());
    });

    // The restart the architect reported, end to end: localStorage comes back EMPTY and the only
    // surviving copy is the file.
    it("hydrating into an EMPTY store restores the tabs from the file", async () => {
      const s = fakeStorage();
      expect(loadTabList(s)).toEqual([]);
      setFetch(
        vi.fn(() => Promise.resolve(jsonResponse({ ...emptySnapshot(), tabs: sampleTabs() }))),
      );
      await expect(hydrateUiState(s)).resolves.toBe(true);
      expect(loadTabList(s)).toEqual(sampleTabs());
    });

    it("a tabs section that is present but junk hydrates as empty, not as a failure", async () => {
      const s = fakeStorage();
      setFetch(vi.fn(() => Promise.resolve(jsonResponse({ ...emptySnapshot(), tabs: "nope" }))));
      await expect(hydrateUiState(s)).resolves.toBe(true);
      expect(loadTabList(s)).toEqual([]);
    });

    it("the mirror POSTs the tab list verbatim, unknown fields intact", async () => {
      const s = fakeStorage();
      writeTabList(sampleTabs(), s);
      scheduleUiStateMirror(s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = bodyOf(callAt(fetchMock, 0)[1]) as UiStateSnapshot;
      expect(body.tabs).toEqual(sampleTabs());
    });

    // The mirror gate applies here for the same reason it applies to the maps, and the
    // stakes are higher: this is the only copy of the tab list that survives an exit.
    it("a mirror after a FAILED hydrate must not post the tab list either", async () => {
      const s = fakeStorage();
      writeTabList(sampleTabs(), s);
      setFetch(vi.fn(() => Promise.reject(new Error("dev server down"))));
      await hydrateUiState(s);

      const postMock = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      setFetch(postMock);
      scheduleUiStateMirror(s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe("hydrateUiState — the file wins, or nothing moves", () => {
    it("a valid snapshot resolves true and OVERWRITES the local store", async () => {
      const s = seededStore();
      await expect(hydrateUiState(s)).resolves.toBe(true);
      expect(readUiStateSnapshot(s)).toEqual(sampleSnapshot());
      // The seeded local values said the opposite in all three namespaces.
      expect(isCollapsed("budget-panel", false, s)).toBe(true);
      expect(getFlag("topbar:exec", false, s)).toBe(true);
      expect(getChoice("exec:tab", "today", s)).toBe("sessions");
      expectNoEntry(s, COLLAPSED_KEY, "stale-panel");
      expect(getChoice("exec:filter", "unfinished", s)).toBe("unfinished");
    });

    it("asks the one endpoint the gateway serves", async () => {
      expect(UI_STATE_ENDPOINT).toBe("/api/ui-state");
      await hydrateUiState(fakeStorage());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(callAt(fetchMock, 0)[0])).toContain(UI_STATE_ENDPOINT);
    });

    // `degraded: true` is the server saying "I could not read the store, this body is a
    // placeholder — do not overwrite me". It was sent from day one and never consumed:
    // we coerced its empty maps over the local cache and returned TRUE, so the one
    // signal designed to prevent data loss caused it instead.
    it("a DEGRADED response is treated as no answer: store untouched, resolves false", async () => {
      const s = fakeStorage();
      setCollapsed("budget-panel", true, false, s);
      const before = readUiStateSnapshot(s);

      setFetch(
        vi.fn(() =>
          Promise.resolve(jsonResponse({ collapsed: {}, flags: {}, choices: {}, degraded: true })),
        ),
      );

      await expect(hydrateUiState(s)).resolves.toBe(false);
      expect(readUiStateSnapshot(s)).toEqual(before);
    });

    it("a fetch that REJECTS resolves false and leaves the store untouched", async () => {
      const s = seededStore();
      const before = snapshot(s);
      setFetch(vi.fn(() => Promise.reject(new Error("network down"))));
      await expect(hydrateUiState(s)).resolves.toBe(false);
      expect(snapshot(s)).toEqual(before);
    });

    it("a non-200 response resolves false and leaves the store untouched", async () => {
      for (const status of [400, 404, 500, 503]) {
        const s = seededStore();
        const before = snapshot(s);
        setFetch(vi.fn(() => Promise.resolve(jsonResponse(sampleSnapshot(), status))));
        await expect(hydrateUiState(s)).resolves.toBe(false);
        expect(snapshot(s)).toEqual(before);
      }
    });

    it("a malformed JSON body resolves false and leaves the store untouched", async () => {
      for (const junk of ["{not json", "]]garbage[[", ""]) {
        const s = seededStore();
        const before = snapshot(s);
        setFetch(vi.fn(() => Promise.resolve(rawResponse(junk))));
        await expect(hydrateUiState(s)).resolves.toBe(false);
        expect(snapshot(s)).toEqual(before);
      }
    });

    it("a non-object body resolves false and leaves the store untouched", async () => {
      // An array, string, number, null or boolean is not a snapshot. Letting one through
      // would hand `writeUiStateSnapshot` something whose three maps are all undefined.
      for (const body of [[1, 2, 3], "hello", 42, null, true]) {
        const s = seededStore();
        const before = snapshot(s);
        setFetch(vi.fn(() => Promise.resolve(jsonResponse(body))));
        await expect(hydrateUiState(s)).resolves.toBe(false);
        expect(snapshot(s)).toEqual(before);
      }
    });

    it("no global fetch at all (bare Node) resolves false without throwing", async () => {
      const s = seededStore();
      const before = snapshot(s);
      setFetch(undefined);
      await expect(hydrateUiState(s)).resolves.toBe(false);
      expect(snapshot(s)).toEqual(before);
    });

    it("hostile storage cannot turn a hydration into a throw", async () => {
      await expect(hydrateUiState(deadStorage())).resolves.toBeTypeOf("boolean");
      await expect(hydrateUiState(writeThrowingStorage())).resolves.toBeTypeOf("boolean");
    });
  });

  describe("scheduleUiStateMirror — one debounced POST, carrying the last word", () => {
    it("collapses a burst of calls into ONE POST with the FINAL snapshot", async () => {
      const s = fakeStorage();
      setChoice("exec:tab", "people", "today", s);
      scheduleUiStateMirror(s);
      setChoice("exec:tab", "sessions", "today", s);
      scheduleUiStateMirror(s);
      setCollapsed("budget-panel", true, false, s);
      setFlag("topbar:exec", true, false, s);
      scheduleUiStateMirror(s);
      // Nothing may leave before the window closes — a leading-edge send would ship the
      // half-built state and never correct it.
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(callAt(fetchMock, 0)[1])).toEqual(sampleSnapshot());
    });

    // FORK 2026-08-04. The regression these two pin cost the architect his whole panel layout:
    // app.ts discards hydrate's result, and migrateLegacyUiState() ends in an
    // unconditional scheduleUiStateMirror(). A hydrate that failed for ANY transient
    // reason therefore POSTed empty maps over the good file 250ms later, with no user
    // interaction at all. The file is the only copy — Chrome wipes localStorage on exit.
    it("a mirror scheduled after a FAILED hydrate must NOT post", async () => {
      const s = fakeStorage();
      setFetch(vi.fn(() => Promise.reject(new Error("dev server down"))));
      await expect(hydrateUiState(s)).resolves.toBe(false);

      setFetch(fetchMock);
      setFlag("topbar:exec", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a mirror after a SUCCESSFUL hydrate still posts", async () => {
      const s = fakeStorage();
      await expect(hydrateUiState(s)).resolves.toBe(true);
      fetchMock.mockClear();

      setFlag("topbar:exec", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(callAt(fetchMock, 0)[1]?.method).toBe("POST");
    });

    it("POSTs JSON to UI_STATE_ENDPOINT", async () => {
      const s = fakeStorage();
      setFlag("topbar:exec", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);

      const [url, init] = callAt(fetchMock, 0);
      expect(String(url)).toContain(UI_STATE_ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(headerOf(init, "content-type")).toContain("application/json");
      expect(typeof init?.body).toBe("string");
    });

    it("a change after the window closes mirrors again", async () => {
      const s = fakeStorage();
      setFlag("topbar:exec", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      setChoice("exec:tab", "sessions", "today", s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(callAt(fetchMock, 1)[1])).toEqual({
        collapsed: {},
        flags: { "topbar:exec": true },
        choices: { "exec:tab": "sessions" },
        // Always on the wire, even when this store has no tabs — a POST that omitted the
        // section would leave the file's tab list frozen forever.
        tabs: [],
      });
    });

    it("a rejected mirror neither throws nor leaks an unhandled rejection", async () => {
      // Real timers on purpose: an unhandled rejection is only observable once the
      // process has actually turned its microtask queue over.
      vi.useRealTimers();
      const rejecting = vi.fn(() => Promise.reject(new Error("gateway down")));
      setFetch(rejecting);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const s = fakeStorage();
        expect(() => setFlag("topbar:exec", true, false, s)).not.toThrow();
        expect(() => scheduleUiStateMirror(s)).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, MIRROR_SETTLE_MS));
        expect(rejecting).toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("mirroring against dead storage neither throws nor posts junk", async () => {
      expect(() => scheduleUiStateMirror(deadStorage())).not.toThrow();
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      for (const call of fetchMock.mock.calls) {
        expect(bodyOf((call as FetchCall)[1])).toEqual(emptySnapshot());
      }
    });
  });

  describe("every writer schedules a mirror", () => {
    it("setCollapsed does", async () => {
      const s = fakeStorage();
      setCollapsed("budget-panel", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(callAt(fetchMock, 0)[1])).toEqual({
        ...emptySnapshot(),
        collapsed: { "budget-panel": true },
      });
    });

    it("setFlag does", async () => {
      const s = fakeStorage();
      setFlag("topbar:exec", true, false, s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(callAt(fetchMock, 0)[1])).toEqual({
        ...emptySnapshot(),
        flags: { "topbar:exec": true },
      });
    });

    it("setChoice does", async () => {
      const s = fakeStorage();
      setChoice("exec:tab", "sessions", "today", s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(callAt(fetchMock, 0)[1])).toEqual({
        ...emptySnapshot(),
        choices: { "exec:tab": "sessions" },
      });
    });

    it("migrateLegacyUiState does — the one-shot fold must reach the file too", async () => {
      // Without this, a profile upgraded on machine A mirrors nothing until the user
      // happens to touch a control, and machine B restores the PRE-upgrade shape.
      const s = fakeStorage({
        [LEGACY_SESSIONS]: "1",
        [LEGACY_EXEC_MODE]: "exec",
        [LEGACY_EXEC_TAB]: "sessions",
      });
      migrateLegacyUiState(s);
      await vi.advanceTimersByTimeAsync(MIRROR_SETTLE_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(callAt(fetchMock, 0)[1])).toEqual({
        collapsed: { "sessions-panel": true },
        flags: { "topbar:exec": true },
        choices: { "exec:tab": "sessions" },
        tabs: [],
      });
    });
  });
});

// FORK 2026-08-19 — the ORDER helpers. Added for the Crons tab's card drag, but the
// contract under test is generic: any control the architect can physically rearrange.
// `applyStoredOrder` is covered as a PURE function because that is the whole reason it
// is separate from storage — and because the same rule lives in the cron-panel board
// store, so a drift here is a drift between two scales of the same behaviour.
describe("persisted order — arranged ids first, everything else keeps its place", () => {
  type Row = { id: string };
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
  const idsOf = (list: Row[]): string[] => list.map((r) => r.id);
  const byId = (r: Row): string => r.id;

  it("puts the listed ids at the front, in the order given", () => {
    const out = applyStoredOrder(rows("a", "b", "c"), ["c", "a"], byId);
    expect(idsOf(out)).toEqual(["c", "a", "b"]);
  });

  it("leaves unlisted items in their incoming relative order behind the arranged ones", () => {
    // "b" and "d" were never dragged, so they must still read b-then-d, not d-then-b.
    const out = applyStoredOrder(rows("a", "b", "c", "d"), ["c", "a"], byId);
    expect(idsOf(out)).toEqual(["c", "a", "b", "d"]);
  });

  it("returns the items untouched when nothing has been arranged yet", () => {
    const out = applyStoredOrder(rows("a", "b", "c"), [], byId);
    expect(idsOf(out)).toEqual(["a", "b", "c"]);
  });

  it("emits an item once even when the stored list names it twice", () => {
    const out = applyStoredOrder(rows("a", "b"), ["b", "b", "a"], byId);
    expect(idsOf(out)).toEqual(["b", "a"]);
  });

  it("skips stored ids that match no item instead of leaving a hole", () => {
    // A job that has been removed must not disturb the positions around it.
    const out = applyStoredOrder(rows("a", "b"), ["gone", "b", "a"], byId);
    expect(idsOf(out)).toEqual(["b", "a"]);
  });

  it("puts a brand-new id at the BOTTOM, never into a position nobody chose", () => {
    const out = applyStoredOrder(rows("a", "b", "fresh"), ["b", "a"], byId);
    expect(idsOf(out)).toEqual(["b", "a", "fresh"]);
  });

  it("round-trips an order through the store", () => {
    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", ["c", "a", "b"], s);
    expect(getOrderedIds("cron:cardOrder", s)).toEqual(["c", "a", "b"]);
  });

  it("stores NOTHING for an empty order, because [] is the stated default", () => {
    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", ["a"], s);
    expect(parsedOf(s, CHOICES_KEY)).toEqual({ "cron:cardOrder": '["a"]' });

    setOrderedIds("cron:cardOrder", [], s);
    expectNoEntry(s, CHOICES_KEY, "cron:cardOrder");
  });

  it("reads an absent key as no stored order", () => {
    expect(getOrderedIds("cron:cardOrder", fakeStorage())).toEqual([]);
  });

  it("degrades to no stored order rather than throwing on a corrupt value", () => {
    // Every one of these must fall back to the caller's order, because the
    // alternative is a panel that renders nothing.
    for (const raw of ["not json", '{"a":1}', '"a"', "17", "null"]) {
      const s = fakeStorage({ [CHOICES_KEY]: JSON.stringify({ "cron:cardOrder": raw }) });
      expect(getOrderedIds("cron:cardOrder", s)).toEqual([]);
    }
  });

  it("drops non-string members instead of trusting the whole array", () => {
    const s = fakeStorage({
      [CHOICES_KEY]: JSON.stringify({ "cron:cardOrder": '["a",3,null,"b"]' }),
    });
    expect(getOrderedIds("cron:cardOrder", s)).toEqual(["a", "b"]);
  });

  it("keeps one control's order out of another's", () => {
    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", ["a"], s);
    expect(getOrderedIds("rail:panelOrder", s)).toEqual([]);
  });
});

// FORK 2026-08-19 (second pass) — the describe above pins the ORDERING RULE. This one pins the
// three properties that rule quietly leans on, none of which fail visibly when they break:
//
//   - ZERO BYTES for an untouched panel is not a special case in `setOrderedIds`; there isn't
//     one. It holds only while the bytes written for `[]` are byte-identical to `ORDER_DEFAULT`.
//   - The WIRE FORMAT is JSON rather than a `,`-joined list because the ids are free text. The
//     module says so; nothing asserted it, so the cheaper encoding stayed one edit away.
//   - `applyStoredOrder` sorts, and `.sort()` is in place. It sorts a filtered copy today, so
//     the caller's array survives — but a return value that looks correct is exactly what makes
//     the mutating version of this function hard to notice.
//
// Each case therefore carries the CONTROL: first that the broken spelling really does misbehave,
// then that the shipped one does not. Kept as a separate block so nothing above is modified.
describe("persisted order — the properties the ordering rule leans on", () => {
  type Row = { id: string };
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
  const idsOf = (list: Row[]): string[] => list.map((r) => r.id);
  const byId = (r: Row): string => r.id;

  it("spells an empty order exactly as the tier's default, which is what buys the zero bytes", () => {
    expect(JSON.stringify([])).toBe(ORDER_DEFAULT);

    // CONTROL: a default that is merely EQUIVALENT rather than identical — one space inside the
    // brackets — stores an explicit copy of "no order" instead of deleting the entry. That is the
    // regression this pins, and it is invisible through the getter, which reads [] either way.
    const control = fakeStorage();
    setChoice("cron:cardOrder", JSON.stringify([]), "[ ]", control);
    expect(parsedOf(control, CHOICES_KEY)).toEqual({ "cron:cardOrder": "[]" });

    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", [], s);
    expectNoEntry(s, CHOICES_KEY, "cron:cardOrder");
  });

  it("reads a half-written or hand-edited value as no stored order", () => {
    // "" is what an interrupted write leaves behind; the truncated forms are what devtools
    // leaves behind. `[1,2]` parses fine and is still not an order. None may throw: a throw
    // inside a render blanks the panel, which is strictly worse than the server's own order.
    for (const raw of ["", "[", '["a"', "true", "undefined", "[1,2]"]) {
      const s = fakeStorage({ [CHOICES_KEY]: JSON.stringify({ "cron:cardOrder": raw }) });
      expect(() => getOrderedIds("cron:cardOrder", s)).not.toThrow();
      expect(getOrderedIds("cron:cardOrder", s)).toEqual([]);
    }
  });

  it("round-trips an id containing a comma, which is why the stored form is JSON", () => {
    const s = fakeStorage();
    const ids = ["cron:a,b", "plain", "spaced , id"];
    setOrderedIds("cron:cardOrder", ids, s);
    expect(getOrderedIds("cron:cardOrder", s)).toEqual(ids);

    // CONTROL: the same three ids through a `,`-joined encoding come back as FIVE, so every
    // position after the offending id shifts and two ids match no card at all.
    expect(ids.join(",").split(",")).toHaveLength(5);
  });

  it("leaves the caller's own array in its incoming order while arranging a copy", () => {
    const incoming = rows("a", "b", "c");
    const arranged = applyStoredOrder(incoming, ["c", "b", "a"], byId);
    expect(idsOf(arranged)).toEqual(["c", "b", "a"]);
    expect(idsOf(incoming)).toEqual(["a", "b", "c"]);

    // CONTROL: an in-place sort of an identical array reorders it under its owner and returns
    // the same correct-looking list — the failure mode the assertion above exists to catch.
    const mutated = rows("a", "b", "c");
    expect(idsOf(mutated.sort((x, y) => y.id.localeCompare(x.id)))).toEqual(["c", "b", "a"]);
    expect(idsOf(mutated)).toEqual(["c", "b", "a"]);
  });

  it("renders what was stored, from the store through to the arranged list", () => {
    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", ["gamma", "alpha"], s);
    const out = applyStoredOrder(
      rows("alpha", "beta", "gamma", "delta"),
      getOrderedIds("cron:cardOrder", s),
      byId,
    );
    expect(idsOf(out)).toEqual(["gamma", "alpha", "beta", "delta"]);
  });

  it("renders the incoming list again once an arrangement is reset, not the old one", () => {
    const s = fakeStorage();
    setOrderedIds("cron:cardOrder", ["gamma", "alpha"], s);
    setOrderedIds("cron:cardOrder", [], s);
    const out = applyStoredOrder(
      rows("alpha", "beta", "gamma"),
      getOrderedIds("cron:cardOrder", s),
      byId,
    );
    expect(idsOf(out)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("degrades instead of throwing when read with no store at all", () => {
    // Read-only, for the reason given by "the store argument is optional" above: this project
    // runs with `isolate: false`, so a write to the shared jsdom localStorage would leak into
    // every other test file.
    expect(() => getOrderedIds("ui-state-test:absent-probe")).not.toThrow();
    expect(getOrderedIds("ui-state-test:absent-probe")).toEqual([]);
  });
});
