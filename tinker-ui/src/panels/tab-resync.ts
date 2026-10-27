// FORK 2026-10-19 (the architect: phone app) — live tab re-sync, the adopt-or-not rule.
//
// The phone and the laptop open the same desk file. A page re-reads the file on focus, on
// becoming visible and every 20 s, and this module decides whether the list it read should
// REPLACE the page's own. Pure, no DOM, no storage: app.ts gathers the inputs and applies the
// answer (panels/ui-state.ts adoptServerTabList, then a re-render).
//
// Conservative by construction. The file only wins when nothing local could be newer than it:
//   - the page has read the file at least once (a page that never hydrated holds defaults);
//   - no local write is still on its way to the file (debounce armed, POST unanswered, retry);
//   - no local write was scheduled while the GET was out (the epoch did not move);
//   - no tab drag, rename, clone or auto-name is in flight (each holds a Tab object it is
//     about to write back into the array).
// And it never DROPS a tab on absence alone. A close is a tombstone (ui-state.ts, 2026-09-21);
// a tab the file lacks with no tombstone is a tab another page posted over before it had seen
// it, so it stays, appended after the file's order, and the caller pushes it back to the file.
//
// Review fix, same day: "the file wins" for a common tab was too blunt. A page that held a change
// back (hidden, ui-state.ts uiStateTabsMayBeStale) would lose it, and a page whose own edit the
// file had not yet seen could not tell it from the other device's. With `base` (the file's list
// as this page last knew it) the merge is three-way, per field: a field this page changed since
// `base` keeps the page's value, any other field takes the file's. Order the same way. Session
// keys compare as the app does (sessionKeyMatches): "tinker:x" and "agent:main:tinker:x" are one
// session, never a change; the merge keeps the longer, canonical one.

import { type ClosedTabs, type TabRecord, withoutClosedTabs } from "./ui-state.js";

export type TabResyncInput = {
  /** The page's tab list, in order. */
  local: readonly TabRecord[];
  /** The file's tab list, in order. */
  server: readonly TabRecord[];
  /** The file's list as this page last knew it (ui-state.ts uiStateFileTabs), if known. */
  base?: readonly TabRecord[] | null;
  /** Union of the page's and the file's tombstones. */
  closed: ClosedTabs;
  /** The page has read the file at least once (uiStateHydrateOutcome() === "ok"). */
  hydrated: boolean;
  /** A local write has not reached the file yet (uiStateMirrorPending()). */
  mirrorPending: boolean;
  /** A tab drag, rename, clone or auto-name is in flight. */
  busy: boolean;
  /** uiStateMirrorEpoch() before the GET and after it. */
  epochBefore: number;
  epochAfter: number;
};

export type TabResyncDecision =
  | { adopt: false; reason: string; pushBack?: boolean }
  | {
      adopt: true;
      tabs: TabRecord[];
      /** Ids new to this page: the caller sets up their state and prefetches them. */
      added: string[];
      /** Ids this page held that the file closed. */
      removed: string[];
      /** The merge differs from the file (tabs or edits only this page has): mirror once. */
      pushBack: boolean;
    };

function idOf(t: TabRecord): string | null {
  return typeof t.id === "string" && t.id !== "" ? t.id : null;
}

/** What two pages must agree on: id, session and title, in order. */
export function tabListSignature(tabs: readonly TabRecord[]): string {
  return JSON.stringify(
    tabs.map((t) => [
      idOf(t),
      typeof t.sessionKey === "string" ? t.sessionKey : null,
      typeof t.title === "string" ? t.title : "",
    ]),
  );
}

/** One session under two spellings, the app's sessionKeyMatches rule. */
export function sameSessionKey(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  return a.endsWith(":" + b) || b.endsWith(":" + a);
}

/** tabListSignature, with equivalent session keys counted as equal. */
function sameLists(x: readonly TabRecord[], y: readonly TabRecord[]): boolean {
  if (x.length !== y.length) return false;
  return x.every((t, i) => {
    const u = y[i];
    return (
      idOf(t) === idOf(u) &&
      (typeof t.title === "string" ? t.title : "") ===
        (typeof u.title === "string" ? u.title : "") &&
      sameSessionKey(t.sessionKey ?? null, u.sessionKey ?? null)
    );
  });
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** One tab, three ways: the file's record, with the fields this page changed since `base`. */
function mergeTab(base: TabRecord | undefined, local: TabRecord, server: TabRecord): TabRecord {
  const out: TabRecord = { ...server };
  for (const k of new Set([...Object.keys(local), ...Object.keys(server)])) {
    if (k === "titleGenerating") continue;
    const lv = local[k];
    const sv = server[k];
    if (same(lv, sv)) continue;
    if (k === "sessionKey" && sameSessionKey(lv, sv)) {
      out[k] = String(lv).length >= String(sv).length ? lv : sv;
      continue;
    }
    if (base !== undefined && !same(lv, base[k])) {
      if (lv === undefined) delete out[k];
      else out[k] = lv;
    }
  }
  return out;
}

export function decideTabResync(input: TabResyncInput): TabResyncDecision {
  if (!input.hydrated) return { adopt: false, reason: "not-hydrated" };
  if (input.busy) return { adopt: false, reason: "busy" };
  if (input.mirrorPending) return { adopt: false, reason: "mirror-pending" };
  if (input.epochBefore !== input.epochAfter) return { adopt: false, reason: "local-changed" };

  // The file's list, tombstones applied, one entry per id.
  const seen = new Set<string>();
  const next: TabRecord[] = [];
  for (const t of withoutClosedTabs([...input.server], input.closed)) {
    const id = idOf(t);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    next.push(t);
  }
  // An empty list is never adopted: no page writes one (Main cannot close), so it can only be a
  // fresh seat or a damaged file, and taking it would blank the tab bar.
  if (next.length === 0) return { adopt: false, reason: "server-empty" };

  // Tabs only this page holds, not closed anywhere: kept, after the file's order. Main is
  // always kept, and goes first when the file has none.
  const localKept = withoutClosedTabs([...input.local], input.closed);
  const localOnly = localKept.filter((t) => {
    const id = idOf(t);
    return id !== null && !seen.has(id);
  });
  const localCommon = localKept.filter((t) => !localOnly.includes(t));

  // Three-way, per tab and per field, against what the file held when this page last knew it.
  const localById = new Map(localCommon.map((t) => [idOf(t), t]));
  const baseById = new Map((input.base ?? []).map((t) => [idOf(t), t]));
  let common = next.map((s) => {
    const l = localById.get(idOf(s));
    return l ? mergeTab(baseById.get(idOf(s)), l, s) : s;
  });
  // Order: this page's, when it reordered the tabs it shares with the file since `base`.
  if (input.base) {
    const shared = (list: readonly TabRecord[]) =>
      list
        .map(idOf)
        .filter((id) => id !== null && localById.has(id) && baseById.has(id) && seen.has(id));
    if (!same(shared(localCommon), shared(input.base))) {
      const rank = new Map(localCommon.map((t, i) => [idOf(t), i]));
      common = [
        ...common
          .filter((t) => rank.has(idOf(t)))
          .toSorted((x, y) => rank.get(idOf(x))! - rank.get(idOf(y))!),
        ...common.filter((t) => !rank.has(idOf(t))),
      ];
    }
  }
  const pushBack = localOnly.length > 0 || !sameLists(common, next);
  // Same tabs in the same order, apart from the ones only this page has: nothing to take, and
  // those stay where they are instead of jumping to the end.
  if (localKept.length === input.local.length && sameLists(common, localCommon)) {
    return { adopt: false, reason: "same", pushBack };
  }
  const main = localOnly.find((t) => idOf(t) === "tab-main");
  const merged = [
    ...(main ? [main] : []),
    ...common,
    ...localOnly.filter((t) => idOf(t) !== "tab-main"),
  ];

  const localIds = new Set(input.local.map(idOf));
  const mergedIds = new Set(merged.map(idOf));
  return {
    adopt: true,
    tabs: merged,
    added: merged.map(idOf).filter((id): id is string => id !== null && !localIds.has(id)),
    removed: input.local.map(idOf).filter((id): id is string => id !== null && !mergedIds.has(id)),
    pushBack,
  };
}
