import { describe, expect, it } from "vitest";
import {
  HISTORY_INDICATOR_DELAY_MS,
  historyIndicators,
  isGatewayWait,
  retryLabel,
  type HistoryLoad,
} from "./history-loading.js";

// FORK 2026-10-06 (the architect: "make sure there are 'loading...' indicators when loading the chat
// history, indicators that have some movement … Also, use the loading indicator for when we
// scroll backwards").

const same = (a: string, b: string) => a === b;
const at = 10_000;
const late = at + HISTORY_INDICATOR_DELAY_MS;
const load = (kind: HistoryLoad["kind"], key = "k", startedAt = at): HistoryLoad => ({
  key,
  kind,
  startedAt,
});
const run = (over: Partial<Parameters<typeof historyIndicators>[0]>) =>
  historyIndicators({
    loads: [],
    viewedKey: "k",
    matches: same,
    pageHasRows: false,
    retryReason: null,
    now: late,
    ...over,
  });

describe("historyIndicators", () => {
  it("centres 'Loading chat history' on an empty page once the read has taken a moment", () => {
    expect(run({ loads: [load("tail")] })).toEqual([
      { place: "center", kind: "tail", label: "Loading chat history" },
    ]);
  });

  it("shows a read on an empty page at once: there is nothing to flash over", () => {
    expect(run({ loads: [load("tail")], now: at })[0]?.label).toBe("Loading chat history");
  });

  // FORK 2026-10-06 (the architect: "Make the message 'connecting to gateway' also as fast as possible and
  // also moving").
  it("says 'Connecting to the gateway' while an empty page has no connection, before any tab is known", () => {
    expect(run({ connecting: true, viewedKey: "" })).toEqual([
      { place: "center", kind: "tail", label: "Connecting to the gateway" },
    ]);
  });

  // FORK 2026-10-06 (the architect: "Consider what the front-end has loaded, and do not try to reload that
  // which is already loaded").
  it("draws nothing for the newest rows over a page that holds rows: connecting, catching up or retrying", () => {
    expect(run({ connecting: true, pageHasRows: true })).toEqual([]);
    expect(run({ loads: [load("tail")], pageHasRows: true, now: late + 60_000 })).toEqual([]);
    expect(
      run({
        loads: [load("tail")],
        pageHasRows: true,
        retryReason: "chat.history unavailable during gateway startup",
      }),
    ).toEqual([]);
  });

  it("still shows a scroll back at the top over rows, and only that, when a catch-up runs too", () => {
    const shown = run({ loads: [load("older"), load("tail")], pageHasRows: true });
    expect(shown).toEqual([{ place: "top", kind: "older", label: "Loading earlier turns" }]);
    expect(run({ loads: [load("older", "k", late - 1)], pageHasRows: true })).toEqual([]);
  });

  it("shows a read being retried at once, in words that say why it waits", () => {
    const shown = run({
      loads: [load("tail")],
      now: at,
      retryReason: "chat.history unavailable during gateway startup",
    });
    expect(shown).toEqual([
      { place: "center", kind: "tail", label: "Waiting for the gateway to start" },
    ]);
  });

  it("only counts reads of the tab on screen", () => {
    expect(run({ loads: [load("tail", "other"), load("older", "other")] })).toEqual([]);
    expect(run({ loads: [load("tail")], viewedKey: "" })).toEqual([]);
  });
});

describe("isGatewayWait and retryLabel", () => {
  it("treats the startup refusal and a down socket as waits, not errors", () => {
    expect(isGatewayWait("chat.history unavailable during gateway startup")).toBe(true);
    expect(isGatewayWait("disconnected")).toBe(true);
    expect(isGatewayWait("unknown session")).toBe(false);
    expect(isGatewayWait("timeout: chat.history did not respond in 60000ms")).toBe(false);
  });

  it("names each wait in plain words", () => {
    expect(retryLabel("disconnected")).toBe("Reconnecting to the gateway");
    expect(retryLabel("timeout: chat.history did not respond in 60000ms")).toBe(
      "The gateway is slow, still loading the chat",
    );
    expect(retryLabel("overloaded")).toBe("Retrying the chat history");
  });
});
