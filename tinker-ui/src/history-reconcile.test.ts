import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_RECONCILE_DEPS as deps,
  historyRowIdentity,
  historyRowTime,
  isLiveClientRow,
  reconcileHistoryIntoPage,
  WATCHED_WINDOW_SLACK_MS,
  watchedRowTest,
} from "./history-reconcile.js";
import {
  resumedRunWatchedFrom,
  resumedTurnOf,
  resumedTurnStart,
  runTurnStart,
} from "./live-continuation.js";

// FORK 2026-09-08 — the paper model. See history-reconcile.ts for the rule; these pin it.

const T0 = Date.parse("2026-09-08T04:00:00Z");
const srv = (id: string, role: string, atMs: number, text = `${role}:${id}`) => ({
  role,
  content: [{ type: "text", text }],
  timestamp: atMs,
  __openclaw: { id, seq: 0 },
});
const live = (runId: string, atMs: number, text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  _runId: runId,
  _bubbleStartedAt: atMs,
  _bubbleEndedAt: atMs + 3_000,
});

describe("reconcileHistoryIntoPage — the page is paper", () => {
  it("a blank page is written once: mode fresh, nothing to append (the page becomes incoming)", () => {
    const r = reconcileHistoryIntoPage(
      [],
      [srv("a", "user", T0), srv("b", "assistant", T0 + 1)],
      deps,
    );
    expect(r.mode).toBe("fresh");
    expect(r.added).toEqual([]);
  });

  it("a page with only a client-side prompt is still fresh, so older history is not rejected as behind", () => {
    const optimisticPrompt = {
      role: "user",
      content: [{ type: "text", text: "new prompt" }],
      _clientMsgId: "client-1",
      _promptStartedAt: T0 + 60_000,
    };
    const r = reconcileHistoryIntoPage(
      [optimisticPrompt],
      [srv("u1", "user", T0), srv("a1", "assistant", T0 + 1_000)],
      deps,
    );
    expect(r.mode).toBe("fresh");
    expect(r.skippedBehind).toBe(0);
  });

  it("the same history served again adds NOTHING — however many times it arrives", () => {
    const page = [srv("a", "user", T0), srv("b", "assistant", T0 + 1_000)];
    for (let i = 0; i < 5; i++) {
      const r = reconcileHistoryIntoPage(
        page,
        [srv("a", "user", T0), srv("b", "assistant", T0 + 1_000)],
        deps,
      );
      expect(r.mode).toBe("gapfill");
      expect(r.added).toHaveLength(0);
      expect(r.skippedKnown).toBe(2);
    }
  });

  it("a run the client WATCHED live is already on paper: the server's split copy is skipped", () => {
    // The client painted run R live: one cumulative reasoning bubble + one answer bubble.
    const page = [
      srv("u1", "user", T0),
      {
        role: "assistant",
        content: [{ type: "text", text: "thinking…" }],
        _isReasoning: true,
        _reasoningRunId: "R",
        _bubbleStartedAt: T0 + 2_000,
      },
      live("R", T0 + 2_000, "the answer"),
    ];
    // The server now serves that run as three rows inside the same window.
    const incoming = [
      srv("u1", "user", T0),
      srv("t1", "assistant", T0 + 2_500, "step 1"),
      srv("t2", "assistant", T0 + 4_000, "step 2"),
      srv("f1", "assistant", T0 + 5_500, "the answer"),
    ];
    const r = reconcileHistoryIntoPage(page, incoming, deps);
    expect(r.added).toHaveLength(0);
    expect(r.skippedWatched).toBe(3);
    expect(r.skippedKnown).toBe(1);
  });

  it("a run the page JOINED mid-way is covered from its prompt, not from its first live bubble", () => {
    // FORK 2026-09-23 — the page read history at T0+60s (prompt + first rows of the run), the tab
    // was then viewed and the live writer continued the run at T0+300s. The rows the run wrote in
    // between are ALREADY SHOWN, inside the continued live bubble (the stream is cumulative).
    const page = [
      srv("u", "user", T0),
      srv("a1", "assistant", T0 + 30_000),
      { ...live("R", T0 + 300_000, "rest of the run"), _watchedFrom: T0 },
    ];
    const between = srv("a2", "assistant", T0 + 120_000, "written while the tab was not viewed");
    const r = reconcileHistoryIntoPage(page, [...page.slice(0, 2), between], deps);
    expect(r.added).toEqual([]);
    expect(r.skippedWatched).toBe(1);
    // Without the stamp the same row is appended — the duplicate this closes.
    const unstamped = [...page.slice(0, 2), live("R", T0 + 300_000, "rest of the run")];
    expect(reconcileHistoryIntoPage(unstamped, [...page.slice(0, 2), between], deps).added).toEqual(
      [between],
    );
  });

  it("a turn that happened while the client was NOT listening is a real gap and is appended, in order", () => {
    const page = [srv("u1", "user", T0), live("R1", T0 + 2_000, "answer one")];
    const later = T0 + 10 * 60_000; // ten minutes later, socket was dead
    const incoming = [
      srv("u1", "user", T0),
      srv("a1", "assistant", T0 + 3_000, "answer one"), // watched → skipped
      srv("u2", "user", later, "second question"),
      srv("a2", "assistant", later + 4_000, "second answer"),
    ];
    const r = reconcileHistoryIntoPage(page, incoming, deps);
    expect(r.added.map((m) => historyRowIdentity(m))).toEqual(["oc:u2", "oc:a2"]);
    expect(r.skippedWatched).toBe(1);
  });

  it("never goes back: a server row older than everything the page holds is skipped", () => {
    const page = [srv("u5", "user", T0 + 60_000), srv("a5", "assistant", T0 + 61_000)];
    const incoming = [
      srv("u1", "user", T0 - 3_600_000),
      srv("a1", "assistant", T0 - 3_599_000),
      ...page,
    ];
    const r = reconcileHistoryIntoPage(page, incoming, deps);
    expect(r.added).toHaveLength(0);
    expect(r.skippedBehind).toBe(2);
    expect(r.skippedKnown).toBe(2);
  });

  it("a row with neither identity nor instant cannot be placed on paper and is declined", () => {
    const page = [srv("u1", "user", T0)];
    const r = reconcileHistoryIntoPage(page, [{ role: "assistant", content: "orphan" }], deps);
    expect(r.added).toHaveLength(0);
    expect(r.skippedUnplaceable).toBe(1);
  });

  it("R28: each optimistic prompt is its own instant — a row between two sends arriving later IS merged", () => {
    // Two sends 20 minutes apart; a cron / another device / a reconnect wrote a turn in between that
    // this client never watched. Folding both prompts into ONE span from the first send to the last
    // swallowed it as "watched" (fix round 3, review NEW-1 / out-of-scope note).
    const prompt = (id: string, at: number) => ({
      role: "user",
      content: [{ type: "text", text: id }],
      _clientMsgId: id,
      _promptStartedAt: at,
    });
    const page = [srv("u0", "user", T0), prompt("p1", T0 + 60_000), prompt("p2", T0 + 20 * 60_000)];
    const between = srv("cron", "assistant", T0 + 10 * 60_000, "a turn this client never saw");
    const r = reconcileHistoryIntoPage(page, [srv("u0", "user", T0), between], deps);
    expect(r.added).toEqual([between]);
    // …while the server copy of each prompt, persisted a few seconds after it, is still skipped.
    const echo1 = srv("p1-srv", "user", T0 + 63_000, "p1");
    const echo2 = srv("p2-srv", "user", T0 + 20 * 60_000 + 4_000, "p2");
    expect(reconcileHistoryIntoPage(page, [echo1, echo2], deps).skippedWatched).toBe(2);
  });

  it("R28: a run watched live after each of two sends is still never written twice", () => {
    const prompt = (id: string, at: number) => ({
      role: "user",
      content: [{ type: "text", text: id }],
      _clientMsgId: id,
      _promptStartedAt: at,
    });
    const page = [
      srv("u0", "user", T0),
      prompt("p1", T0 + 60_000),
      { ...live("R1", T0 + 70_000, "thinking one"), _watchedFrom: T0 + 60_000 },
      live("R1", T0 + 5 * 60_000, "answer one"),
      prompt("p2", T0 + 20 * 60_000),
      { ...live("R2", T0 + 20 * 60_000 + 8_000, "answer two"), _watchedFrom: T0 + 20 * 60_000 },
    ];
    // The server's copies of both runs: prompts, steps and answers, spread across each run.
    const incoming = [
      srv("u0", "user", T0),
      srv("p1s", "user", T0 + 62_000, "p1"),
      srv("r1a", "assistant", T0 + 2 * 60_000, "step"),
      srv("r1b", "assistant", T0 + 5 * 60_000 + 2_000, "answer one"),
      srv("p2s", "user", T0 + 20 * 60_000 + 3_000, "p2"),
      srv("r2a", "assistant", T0 + 20 * 60_000 + 9_000, "answer two"),
    ];
    const r = reconcileHistoryIntoPage(page, incoming, deps);
    expect(r.added).toEqual([]);
    expect(r.skippedWatched).toBe(5);
  });

  it("client-only NOTES do not widen a watched window", () => {
    // A warning bubble raised long after the run must not swallow a genuine later gap.
    const page = [
      srv("u1", "user", T0),
      live("R", T0 + 2_000, "answer"),
      {
        role: "assistant",
        content: [{ type: "text", text: "⚠️ retrying" }],
        _isWarning: true,
        _arrivedAt: T0 + 9 * 60_000,
      },
    ];
    const incoming = [srv("u1", "user", T0), srv("u2", "user", T0 + 9 * 60_000 + 5_000, "later")];
    const r = reconcileHistoryIntoPage(page, incoming, deps);
    expect(r.added.map((m) => historyRowIdentity(m))).toEqual(["oc:u2"]);
  });

  it("a CLI-IMPORT row that is the newest thing on the page is appended ONCE, then known — never once per serve", () => {
    // FORK 2026-09-08 (the ClawHub tab still doubled): a cc-bridge turn reaches history as a
    // claude-cli import whose only identity is `__openclaw.externalId`. While it is newer than every
    // local row, a reader that cannot see that identity re-appends it on EVERY serve (it is neither
    // known, nor watched, nor behind). Reproduced on the real payload: 3 copies of one answer.
    const imp = (ext: string, atMs: number, text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: atMs,
      __openclaw: { importedFrom: "claude-cli", cliSessionId: "c", externalId: ext },
    });
    const page = [srv("u1", "user", T0), srv("t1", "toolResult", T0 + 1_000)];
    const incoming = [...page, imp("e1", T0 + 60_000, "the answer")];
    const first = reconcileHistoryIntoPage(page, incoming, deps);
    expect(first.added.map((m) => historyRowIdentity(m))).toEqual(["ext:e1"]);
    const page2 = [...page, ...first.added];
    for (let i = 0; i < 5; i++) {
      const again = reconcileHistoryIntoPage(page2, incoming, deps);
      expect(again.added).toHaveLength(0);
      expect(again.skippedKnown).toBe(3);
    }
  });

  it("the slack is finite and symmetric", () => {
    expect(WATCHED_WINDOW_SLACK_MS).toBeGreaterThan(0);
    expect(WATCHED_WINDOW_SLACK_MS).toBeLessThan(60_000);
  });

  it("never mutates its inputs", () => {
    const page = [srv("u1", "user", T0)];
    const incoming = [srv("u1", "user", T0), srv("a1", "assistant", T0 + 1_000)];
    const pageJson = JSON.stringify(page);
    const incomingJson = JSON.stringify(incoming);
    reconcileHistoryIntoPage(page, incoming, deps);
    expect(JSON.stringify(page)).toBe(pageJson);
    expect(JSON.stringify(incoming)).toBe(incomingJson);
  });
});

describe("default deps", () => {
  it("identity prefers the transcript id, then the CLI import's __openclaw.externalId, else none", () => {
    expect(historyRowIdentity({ __openclaw: { id: "x", externalId: "e" } })).toBe("oc:x");
    // The shape cli-session-history.claude.ts actually writes: no id, externalId INSIDE __openclaw.
    expect(
      historyRowIdentity({
        __openclaw: { importedFrom: "claude-cli", cliSessionId: "c", externalId: "e" },
      }),
    ).toBe("ext:e");
    expect(historyRowIdentity({ externalId: "e" })).toBe("ext:e"); // fallback only
    expect(historyRowIdentity({ __openclaw: { importedFrom: "claude-cli" } })).toBeNull();
    expect(historyRowIdentity({ role: "assistant" })).toBeNull();
    expect(historyRowIdentity(null)).toBeNull();
  });

  it("time reads the server stamp first, then the client's own stamps", () => {
    expect(historyRowTime({ timestamp: 5, _arrivedAt: 9 })).toBe(5);
    expect(historyRowTime({ timestamp: "2026-09-08T04:00:00Z" })).toBe(T0);
    expect(historyRowTime({ _promptStartedAt: 7 })).toBe(7);
    expect(historyRowTime({ _arrivedAt: 9 })).toBe(9);
    expect(historyRowTime({})).toBeNull();
  });

  it("a live row is one the client wrote while watching: run stamp or client id, and no server identity", () => {
    expect(isLiveClientRow(live("R", T0, "x"))).toBe(true);
    expect(isLiveClientRow({ role: "user", content: "q", _clientMsgId: "c1" })).toBe(true);
    expect(isLiveClientRow(srv("a", "assistant", T0))).toBe(false);
    expect(isLiveClientRow({ role: "assistant", content: "note", _isWarning: true })).toBe(false);
  });
});

// FORK 2026-10-03 — THE GAP-FILLED TWIN (bug-log [chat-divergence] cause 8, caught on a page). A run's
// watched window ended 15 s after its newest live row OPENED, but a claude-cli import row is stamped
// when its block FINISHED. An answer that streamed for longer than the slack was therefore not
// "watched" when the history read that the first final releases landed, and the gap-fill appended the
// served answer under the live one: the October-plan tab (2026-10-02 22:52) drew the whole answer
// twice, served once. Times below are that turn's, measured on the gateway journal.
describe("a live bubble covers its run until it was last written, not only until it opened (2026-10-03)", () => {
  const PROMPT_AT = Date.parse("2026-10-02T20:37:32.700Z");
  const ANSWER_OPENED = PROMPT_AT + 876_385; // the answer bubble opened at 22:52:09.085
  const LAST_DELTA = ANSWER_OPENED + 16_000; // its last delta, just before the CLI wrote the block
  const FINAL_AT = ANSWER_OPENED + 16_500; // the first final promoted it at 22:52:25.58
  const ANSWER =
    "The October plan is on Sasha's page now: Maui, the San Jose days, the cliff hike.";
  /** The page after the first final: both bubbles promoted (no `_temporary`), end-stamped. */
  const page = (
    answerOpened = ANSWER_OPENED,
    lastWrite = LAST_DELTA,
  ): Record<string, unknown>[] => [
    srv("o1", "assistant", PROMPT_AT - 60_000, "an older answer"),
    {
      role: "user",
      content: [{ type: "text", text: "plan October" }],
      _clientMsgId: "R",
      _promptStartedAt: PROMPT_AT,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Big brief, and a good one." }],
      _runId: "R",
      _bubbleStartedAt: PROMPT_AT + 60_000,
      _lastWriteAt: PROMPT_AT + 60_400,
      _bubbleEndedAt: FINAL_AT,
      _watchedFrom: PROMPT_AT,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: ANSWER }],
      _runId: "R",
      _bubbleStartedAt: answerOpened,
      _lastWriteAt: lastWrite,
      _bubbleEndedAt: FINAL_AT,
      _watchedFrom: PROMPT_AT,
    },
  ];
  const served = (id: string, atMs: number, role = "assistant", text = ANSWER) => ({
    role,
    content: [{ type: "text", text }],
    timestamp: atMs,
    __openclaw: { importedFrom: "claude-cli", externalId: id },
  });

  it("skips the served copy of an answer the page streamed for 16.2 s", () => {
    const r = reconcileHistoryIntoPage(page(), [served("dca877e6", ANSWER_OPENED + 16_219)], deps);
    expect(r.added).toHaveLength(0);
    expect(r.skippedWatched).toBe(1);
  });

  it("an older page skips it the same way (one rule for every writer)", () => {
    expect(watchedRowTest(page(), deps)(served("dca877e6", ANSWER_OPENED + 16_219))).toBe(true);
  });

  it("still appends a row stamped after the bubble's last write plus the slack", () => {
    const r = reconcileHistoryIntoPage(
      page(),
      [served("later", LAST_DELTA + WATCHED_WINDOW_SLACK_MS + 1)],
      deps,
    );
    expect(r.added).toHaveLength(1);
  });

  it("an answer that streamed for less than the slack is covered, as before", () => {
    const r = reconcileHistoryIntoPage(
      page(FINAL_AT - 3_300, FINAL_AT - 600),
      [served("short", FINAL_AT - 280)],
      deps,
    );
    expect(r.added).toHaveLength(0);
  });

  // FORK 2026-10-03, review round 1 — why the end is the LAST WRITE of a CLOSED bubble, and not the
  // moment something promoted it: promotion says nothing about what the page showed.
  it("a bubble still open (or frozen when the page stopped watching) is not extended", () => {
    // The tab was left while the answer streamed: no final reached this page, every bubble of
    // the run is still a live temp with no end stamp.
    const open = page();
    for (const m of open.slice(2)) {
      delete m._bubbleEndedAt;
      m._temporary = true;
    }
    const r = reconcileHistoryIntoPage(open, [served("dca877e6", ANSWER_OPENED + 16_219)], deps);
    expect(r.added).toHaveLength(1); // as before the fix: a partial copy, never hidden text
  });

  it("a Stop that end-stamps a stale bubble an hour later does not stretch its run's window", () => {
    const stale = page();
    stale[3]._bubbleEndedAt = ANSWER_OPENED + 3_600_000; // abort() promotes every leftover temp
    const r = reconcileHistoryIntoPage(
      stale,
      [
        served(
          "phone",
          ANSWER_OPENED + 600_000,
          "assistant",
          "a reply to a prompt sent from the phone",
        ),
      ],
      deps,
    );
    expect(r.added).toHaveLength(1);
  });

  it("an answer only the second final carried is added when the page missed that final", () => {
    // Final #1 promoted the narration (its stream ended a minute earlier); the answer never
    // streamed, the second final was missed, and history is the only way the answer arrives.
    const missed = page().slice(0, 3);
    missed[2]._bubbleStartedAt = FINAL_AT - 61_000;
    missed[2]._lastWriteAt = FINAL_AT - 60_000;
    missed.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      _runId: "R",
      _arrivedAt: FINAL_AT - 40_000,
    });
    const r = reconcileHistoryIntoPage(missed, [served("answer", FINAL_AT - 2_000)], deps);
    expect(r.added).toHaveLength(1);
  });

  it("a prompt typed elsewhere is tested against the window without the last-write extension", () => {
    const at = ANSWER_OPENED + 20_000; // after the answer opened + slack, before its last write + slack
    const r = reconcileHistoryIntoPage(
      page(),
      [
        served("phone-prompt", at, "user", "also book the cliff hike for Tuesday"),
        served("answer-part", at + 1),
      ],
      deps,
    );
    expect(r.added.map((m) => (m as { role: string }).role)).toEqual(["user"]);
  });

  it("a thought frozen at the final is covered until its last write", () => {
    const thoughtAt = ANSWER_OPENED - 30_000;
    const withThought = [
      ...page().slice(0, 3),
      {
        role: "assistant",
        content: [{ type: "text", text: "Weighing the three October windows." }],
        _isReasoning: true,
        _reasoningRunId: "R",
        _runId: "R",
        _arrivedAt: thoughtAt,
        _lastWriteAt: thoughtAt + 20_000,
      },
    ];
    const r = reconcileHistoryIntoPage(
      withThought,
      [
        served(
          "thinking-row",
          thoughtAt + 20_500,
          "assistant",
          "Weighing the three October windows.",
        ),
      ],
      deps,
    );
    expect(r.added).toHaveLength(0);
  });
});

describe("REAL DATA — the served window that doubled on the work tab", () => {
  // tinker-ui/src/__fixtures__/mtjwloe0-thinking-window.json is a 168-row slice of a real
  // chat.history payload (agent:main:tinker:mtjwloe0, 2026-09-08 06:11 CEST), text elided. Under
  // the old merge, each reload of this window grew the page (1→2→3→4 copies of every thinking
  // row). Under the paper rule a reload adds nothing.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__", "mtjwloe0-thinking-window.json"), "utf-8"),
  ) as { messages: unknown[] };

  it("first load writes the page; every later reload of the same window adds zero rows", () => {
    const first = reconcileHistoryIntoPage([], fixture.messages, deps);
    expect(first.mode).toBe("fresh");
    const page = fixture.messages.slice(); // the page IS the first payload
    for (let i = 0; i < 3; i++) {
      const again = reconcileHistoryIntoPage(page, fixture.messages, deps);
      expect(again.mode).toBe("gapfill");
      expect(again.added).toHaveLength(0);
      expect(again.skippedKnown).toBe(fixture.messages.length);
    }
    expect(page).toHaveLength(fixture.messages.length);
  });

  it("every row in the real window carries a stable identity, so identity — not text — is enough", () => {
    for (const m of fixture.messages) {
      expect(historyRowIdentity(m)).not.toBeNull();
    }
  });
});

describe("incremental payloads — a delta or a refreshed tail is merged, never swapped in (plan task 8)", () => {
  const pageOf = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      srv(`s${i + 1}`, i % 2 === 0 ? "user" : "assistant", T0 + i * 1_000),
    );

  it("a tail delta appends exactly the new rows, and every row already on the page stays the same object", () => {
    const page: unknown[] = pageOf(100);
    const before = page.slice();
    const delta = [srv("s101", "user", T0 + 100_000), srv("s102", "assistant", T0 + 101_000)];
    const r = reconcileHistoryIntoPage(page, delta, deps);
    expect(r.mode).toBe("gapfill");
    expect(r.added).toEqual(delta);
    for (const row of r.added) {
      page.push(row);
    }
    expect(page).toHaveLength(102);
    before.forEach((row, i) => expect(page[i]).toBe(row));
    expect(page[100]).toBe(delta[0]);
    expect(page[101]).toBe(delta[1]);
  });

  it("a cursor RESET for the same session (the last N rows again) keeps every page row and adds only the new ones", () => {
    // R22: an afterSeq the server cannot honour (restart, R10 overflow) is answered with the last
    // `limit` rows and `cursor.reset`. The page keeps everything it shows; identity fills the gap.
    const page: unknown[] = pageOf(100);
    const before = page.slice();
    const resetReply = [...pageOf(130).slice(30)];
    const r = reconcileHistoryIntoPage(page, resetReply, deps);
    expect(r.mode).toBe("gapfill");
    expect(r.skippedKnown).toBe(70);
    expect(r.added.map((m) => historyRowIdentity(m))).toEqual(
      Array.from({ length: 30 }, (_, i) => `oc:s${101 + i}`),
    );
    for (const row of r.added) {
      page.push(row);
    }
    before.forEach((row, i) => expect(page[i]).toBe(row));
  });

  it("a refreshed payload that no longer lists a row the page shows never removes it (hydrateTab merges)", () => {
    // The forced background refresh used to REPLACE the saved page with the payload. A page row
    // the payload does not carry (here: one older than the served window) must survive the merge.
    const page = pageOf(10);
    const payload = [...pageOf(10).slice(5), srv("s11", "user", T0 + 10_000)];
    const r = reconcileHistoryIntoPage(page, payload, deps);
    expect(r.added.map((m) => historyRowIdentity(m))).toEqual(["oc:s11"]);
    expect(r.skippedKnown).toBe(5);
  });
});

describe("REAL DATA — the served window that still doubled on the ClawHub tab after the paper rule", () => {
  // tinker-ui/src/__fixtures__/mtr04ruw-import-window.json is a 150-row slice of the real served
  // chat.history window (agent:main:tinker:mtr04ruw, 2026-09-08 16:12 CEST), text elided, ending on
  // the session's last claude-cli IMPORT row. 123 of its rows are imports whose only identity is
  // `__openclaw.externalId`. Measured on the live page: 79 duplicate pairs, one answer 3×.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__fixtures__", "mtr04ruw-import-window.json"), "utf-8"),
  ) as { messages: Array<{ __openclaw?: { importedFrom?: string } }> };
  const isImport = (m: { __openclaw?: { importedFrom?: string } }) =>
    Boolean(m.__openclaw?.importedFrom);

  it("the window really is the shape that leaked: over a hundred import rows, and the newest row is one", () => {
    expect(fixture.messages.filter(isImport).length).toBeGreaterThan(100);
    expect(isImport(fixture.messages[fixture.messages.length - 1])).toBe(true);
  });

  it("every row — import or local — carries a stable identity", () => {
    for (const m of fixture.messages) {
      expect(historyRowIdentity(m)).not.toBeNull();
    }
  });

  it("the live failure: import rows newer than every local row are appended once and never again", () => {
    let lastLocal = -1;
    fixture.messages.forEach((m, i) => {
      if (!isImport(m)) {
        lastLocal = i;
      }
    });
    const trailingImports = fixture.messages.length - 1 - lastLocal;
    expect(trailingImports).toBeGreaterThan(0);
    // The page holds everything up to the last local row; the server now serves the whole window.
    const page = fixture.messages.slice(0, lastLocal + 1);
    const first = reconcileHistoryIntoPage(page, fixture.messages, deps);
    expect(first.added).toHaveLength(trailingImports);
    const page2 = [...page, ...first.added];
    for (let i = 0; i < 3; i++) {
      const again = reconcileHistoryIntoPage(page2, fixture.messages, deps);
      expect(again.added).toHaveLength(0);
      expect(again.skippedKnown).toBe(fixture.messages.length);
    }
  });
});

describe("a turn a gateway restart froze, replayed under a NEW run (bug-log [chat-divergence], cause 4)", () => {
  // FORK 2026-10-01 — the cc-bridge hands the frozen turn to a run with a new id and replays it from
  // its first byte. That run names the turn on its events (cc-bridge stream.ts), and the live writer
  // anchors the replay through resumedTurnStart / resumedRunWatchedFrom (app.ts runTurnStartOf,
  // runWatchedFrom). Live: tab mue2cvin, 2026-10-01 11:11, the same answer twice, one copy served.
  const RESTART = T0 + 10 * 60_000;
  const isPrompt = (m: unknown) => (m as { role?: unknown } | null)?.role === "user";
  // The prompt that opened the frozen turn, sent from this page under that run's key.
  const prompt = {
    role: "user",
    content: [{ type: "text", text: "build it" }],
    _clientMsgId: "R1",
    _promptStartedAt: T0,
  };
  // A prompt typed after the restart that took the held turn: today's anchor for the replay.
  const late = {
    role: "user",
    content: [{ type: "text", text: "still there?" }],
    _clientMsgId: "R2",
    _promptStartedAt: RESTART + 5_000,
  };
  // What the frozen turn wrote before the freeze, served after the restart.
  const frozenRows = [
    srv("r1a", "assistant", T0 + 60_000, "step one"),
    srv("r1b", "assistant", T0 + 8 * 60_000, "step two"),
  ];
  const replay = (watchedFrom: number | undefined) => ({
    ...live("R2", RESTART + 30_000, "step one step two and the rest"),
    ...(watchedFrom === undefined ? {} : { _watchedFrom: watchedFrom }),
  });
  // What the bridge carried: the frozen turn's run, and when it started (after its prompt).
  const named = { runId: "R1", startedAt: T0 + 20_000 };

  it("reads the turn an event names, and nothing from one that names none", () => {
    expect(
      resumedTurnOf({ phase: "start", resumesRunId: "R1", resumesTurnStartedAt: T0 + 20_000 }),
    ).toEqual(named);
    expect(resumedTurnOf({ phase: "final", resumesTurnStartedAt: T0 })).toEqual({ startedAt: T0 });
    // An announce, a cron, a heartbeat, every ordinary turn: no anchor of any kind.
    expect(resumedTurnOf({ phase: "start", model: "claude-opus-5" })).toBeNull();
    expect(resumedTurnOf({ resumesRunId: "", resumesTurnStartedAt: Number.NaN })).toBeNull();
    expect(resumedTurnOf(null)).toBeNull();
  });

  it("the replay is covered from the frozen turn's prompt, so the turn's served rows are skipped as watched", () => {
    const base = [srv("u0", "user", T0 - 60_000), prompt, late];
    const own = historyRowTime(late) ?? undefined;
    const from = resumedRunWatchedFrom(base, own, named, historyRowTime);
    expect(from).toBe(T0);
    const r = reconcileHistoryIntoPage([...base, replay(from)], frozenRows, deps);
    expect(r.added).toEqual([]);
    expect(r.skippedWatched).toBe(2);
  });

  it("CONTROL: a run that names no turn keeps today's anchor, and the frozen rows are written again", () => {
    const base = [srv("u0", "user", T0 - 60_000), prompt, late];
    const own = historyRowTime(late) ?? undefined;
    expect(resumedRunWatchedFrom(base, own, undefined, historyRowTime)).toBe(own);
    expect(resumedRunWatchedFrom(base, undefined, undefined, historyRowTime)).toBeUndefined();
    const r = reconcileHistoryIntoPage([...base, replay(own)], frozenRows, deps);
    // The duplicate this closes: the frozen turn's rows land again, under text the replay shows.
    expect(r.added).toEqual(frozenRows);
  });

  it("with no key for the prompt on the page, the start the bridge carried anchors the replay", () => {
    // The served copy of the prompt carries no key (a first prompt never keyed, a cron, an import).
    const base = [srv("u0", "user", T0 - 60_000), srv("p1", "user", T0, "build it")];
    const from = resumedRunWatchedFrom(base, undefined, named, historyRowTime);
    expect(from).toBe(T0 + 20_000);
    const r = reconcileHistoryIntoPage([...base, replay(from)], frozenRows, deps);
    expect(r.added).toEqual([]);
    expect(r.skippedWatched).toBe(2);
  });

  it("anchors combine and never narrow: a keyed row with a late time cannot push the anchor past the carried start", () => {
    const redrawn = { ...prompt, _promptStartedAt: RESTART + 1_000 };
    expect(resumedRunWatchedFrom([redrawn], undefined, named, historyRowTime)).toBe(T0 + 20_000);
    expect(resumedRunWatchedFrom([prompt], T0 - 5_000, named, historyRowTime)).toBe(T0 - 5_000);
  });

  it("the replay's turn start moves back to the frozen turn's prompt, by key or by the carried start, and only ever back", () => {
    const page = [srv("u0", "user", T0 - 60_000), prompt, ...frozenRows, late];
    const own = runTurnStart(page, "R2", isPrompt);
    expect(own).toBe(4);
    const start = (resumed: Parameters<typeof resumedTurnStart>[2], from = own) =>
      resumedTurnStart(page, from, resumed, isPrompt, historyRowTime);
    expect(start(named)).toBe(1);
    // No key on this page: the prompt that opened the turn running at the carried start.
    expect(start({ runId: "not-on-this-page", startedAt: T0 + 20_000 })).toBe(1);
    expect(start({ startedAt: T0 + 20_000 })).toBe(1);
    // A run that names nothing, or a start before every prompt, keeps its own start.
    expect(start(undefined)).toBe(own);
    expect(start({ runId: "not-on-this-page" })).toBe(own);
    expect(start({ startedAt: T0 - 120_000 })).toBe(own);
    // Never later than its own start, and a page-wide scan stays page-wide.
    expect(start(named, 0)).toBe(0);
    expect(start(named, -1)).toBe(-1);
  });
});
