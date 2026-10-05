import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { augmentChatHistoryWithCliSessionImports } from "./cli-session-history.js";

// FORK 2026-08-26 — IMPORT FLOOD SAFETY VALVE + B043 symmetry hardening, import boundary only.
//
// A cc-bridge tool loop appends one JSONL entry per step, so a single long run can mint hundreds
// of importable messages in minutes. Observed live: 457 imports against 46 local messages drove
// chat.history serves to 18.5-41.5 s — past the client timeout, which renders as "my chat is
// gone". When the import payload exceeds IMPORT_FLOOD_MAX_RATIO (3x) the local count the valve
// TRUNCATES it to the newest `ratio * local` records and merges normally, warning once; it never
// fires against an EMPTY local store (then the import IS the history — a reset / 4am wipe must
// not become a deletion).
//
// FORK 2026-08-27: the first cut returned the local store outright. That was a deletion dressed
// as a size guard — it discarded the newest imports, which are precisely what a turn in flight
// (or one an interrupted restart never coalesced) is emitting, and it skipped the merge entirely
// so tripping tabs also lost per-step segmentation. Bounding beats deleting, and the coverage
// timestamps must come from the SURVIVING payload or a discarded import silently deletes a local
// answer that nothing re-provides.
//
// HONESTY (also in the commit message): the text-less-cover hardening was replayed offline
// against the live work-tab inputs and rescues ZERO of the 5 currently-suppressed answers
// (each is covered by 11-24 TEXT-BEARING imports). It hardens the B043 shape; it is NOT that fix.

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, logWarn: mocks.logWarn };
});

const ORIGINAL_HOME = process.env.HOME;

const LOCAL_USER_TS = Date.parse("2026-08-26T10:00:00.000Z");
const LOCAL_ASSISTANT_TS = Date.parse("2026-08-26T10:00:05.000Z");
const IMPORT_BASE_TS = Date.parse("2026-08-26T10:20:00.000Z");

function importUserLine(i: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `flood-user-${i}`,
    timestamp: new Date(IMPORT_BASE_TS + i * 60_000).toISOString(),
    message: {
      role: "user",
      content: `imported prompt number ${i} with plenty of distinctive text`,
    },
  });
}

function importAssistantLine(params: { uuid: string; ts: string; text?: string }): string {
  return JSON.stringify({
    type: "assistant",
    uuid: params.uuid,
    timestamp: params.ts,
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content:
        params.text === undefined
          ? [{ type: "tool_use", id: "toolu_flood_1", name: "Bash", input: { command: "pwd" } }]
          : [{ type: "text", text: params.text }],
      stop_reason: params.text === undefined ? "tool_use" : "end_turn",
    },
  });
}

function localMessagesFixture(): unknown[] {
  return [
    { role: "user", content: "the local question", timestamp: LOCAL_USER_TS },
    {
      role: "assistant",
      content: [{ type: "text", text: "the real local answer" }],
      timestamp: LOCAL_ASSISTANT_TS,
    },
  ];
}

async function withTranscript<T>(
  lines: string[],
  run: (params: { homeDir: string; cliSessionId: string }) => Promise<T> | T,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-flood-"));
  const homeDir = path.join(root, "home");
  const cliSessionId = "f100d000-0000-4000-8000-000000000001";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(path.join(projectsDir, `${cliSessionId}.jsonl`), lines.join("\n"), "utf-8");
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, cliSessionId });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function entryFor(cliSessionId: string) {
  return {
    sessionId: "openclaw-session-flood",
    updatedAt: Date.now(),
    cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
  };
}

const ORIGINAL_FLOOD_RATIO = process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;

function restoreFloodRatio(): void {
  if (ORIGINAL_FLOOD_RATIO === undefined) {
    delete process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;
  } else {
    process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO = ORIGINAL_FLOOD_RATIO;
  }
}

// FORK 2026-10-03 (the architect: "There are still tabs where the history has been erased") — the valve is
// OFF unless OPENCLAW_IMPORT_FLOOD_MAX_RATIO sets a ratio. A Claude-backed tab's local store holds
// little more than its prompts, so 3x the local rows cut 9 live tabs to their prompts: 592 imported
// rows to 99 on one, 577 to 63 on another (journal, 2026-10-02/03). Measured offline on the live
// store, the merge of every import took 24-341 ms against 45-623 ms with the valve on, and the reply
// is windowed by `limit` since the 2026-09-23 rehaul. The valve's mechanics stay, opt-in.
describe("no flood valve unless one is configured", () => {
  beforeEach(() => {
    mocks.logWarn.mockClear();
    delete process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;
  });
  afterEach(() => {
    restoreFloodRatio();
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("merges every import of a tab whose local store holds little more than its prompts", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => importUserLine(i + 1));
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      expect(out).toHaveLength(42); // 2 local + all 40 imports, 20x the local rows
      expect(rendered).toContain("imported prompt number 1 ");
      expect(rendered).toContain("imported prompt number 40");
      expect(rendered).toContain("the real local answer");
      expect(mocks.logWarn).not.toHaveBeenCalled();
    });
  });
});

describe("import flood safety valve", () => {
  beforeEach(() => {
    mocks.logWarn.mockClear();
    // Opt-in since 2026-10-03: these cases pin the valve's mechanics at the old ratio.
    process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO = "3";
  });
  afterEach(() => {
    restoreFloodRatio();
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("trips at ratio > 3 and TRUNCATES to the newest N — the tail survives, the head is dropped", async () => {
    // 7 imports vs 2 locals = 3.5x > 3x. Budget = floor(2 * 3) = 6, so the single OLDEST
    // import is dropped and the six newest are merged. The tail is the whole point: the newest
    // imports are what a turn in flight (or one an interrupted restart left uncoalesced) is
    // emitting, so a valve that dropped the entire payload would hide exactly what the user
    // is waiting on.
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      expect(out).toHaveLength(8); // 2 local + 6 surviving imports
      expect(rendered).toContain("imported prompt number 7"); // newest kept
      expect(rendered).toContain("imported prompt number 2");
      expect(rendered).not.toContain("imported prompt number 1"); // oldest dropped
      expect(rendered).toContain("the real local answer"); // local store never deleted
    });
  });

  it("a TRUNCATED-AWAY import must not still cover (and delete) a local answer", async () => {
    // REGRESSION GUARD. dropImportCoveredLocalAssistants deletes a local coalesced answer on the
    // promise that an import re-provides it in segmented form. If the coverage timestamps are
    // derived from the FULL pre-truncation payload, an import the valve just discarded still
    // "covers" the local answer — and nothing then re-provides it, destroying the only copy.
    // Here the covering assistant shares the local answer's ~5-min slot but is the OLDEST record,
    // so truncation drops it; the local answer must survive.
    const covering = importAssistantLine({
      uuid: "flood-cover-old",
      ts: new Date(LOCAL_ASSISTANT_TS).toISOString(),
      text: "imported segmented answer that covers the local one",
    });
    const lines = [covering, ...[1, 2, 3, 4, 5, 6, 7].map(importUserLine)];
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      expect(rendered).not.toContain("imported segmented answer"); // truncated away
      expect(rendered).toContain("the real local answer"); // therefore must NOT be dropped
    });
  });

  it("a turn STRADDLING the truncation boundary keeps its local answer", async () => {
    // THE BLOCKER GUARD. Coverage is a symmetric +/-5 min window while truncation keeps only the
    // NEWEST records, so a survivor belonging to a LATER turn can cover a local answer whose own
    // re-providing segments were truncated away — deleting an answer that is then served by
    // neither store. The previous guard in this file cannot catch it: it leaves
    // importAssistantTimestamps EMPTY, so dropImportCoveredLocalAssistants early-returns and the
    // covering path is never exercised.
    //
    // Turn A (10:00:01-10:00:05) re-provides the local answer at 10:00:05.
    // Turn B (10:04:20-10:05:10) is a later, unrelated turn.
    // 10 imports vs 2 locals trips the valve; budget = 6, so the 6 newest (all turn B) survive and
    // every turn-A segment is dropped. The oldest survivor is 255 s from the local answer — inside
    // the 300 s cover window — so without the floor it deletes the answer.
    const turnA = [1, 3, 5].map((s) =>
      importAssistantLine({
        uuid: `straddle-a-${s}`,
        ts: new Date(Date.parse("2026-08-26T10:00:00.000Z") + s * 1000).toISOString(),
        text: `turn A segment ${s} which re-provides the answer`,
      }),
    );
    const turnB = [260, 270, 280, 290, 300, 310, 320].map((s) =>
      importAssistantLine({
        uuid: `straddle-b-${s}`,
        ts: new Date(Date.parse("2026-08-26T10:00:00.000Z") + s * 1000).toISOString(),
        text: `turn B segment ${s} unrelated to the answer`,
      }),
    );
    await withTranscript([...turnA, ...turnB], ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      // Turn A really was truncated away, so the local store is the ONLY remaining source —
      // this is what stops the assertion below from passing vacuously.
      expect(rendered).not.toContain("turn A segment");
      expect(rendered).toContain("turn B segment");
      expect(rendered).toContain("the real local answer");
    });
  });

  it("honours OPENCLAW_IMPORT_FLOOD_MAX_RATIO as a runtime escape hatch", async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const previous = process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;
      process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO = "10"; // 7 imports vs 2 locals is now under cap
      try {
        const out = augmentChatHistoryWithCliSessionImports({
          entry: entryFor(cliSessionId),
          localMessages: localMessagesFixture(),
          homeDir,
        });
        expect(out).toHaveLength(9); // 2 local + all 7 imports
        expect(mocks.logWarn).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO;
        } else {
          process.env.OPENCLAW_IMPORT_FLOOD_MAX_RATIO = previous;
        }
      }
    });
  });

  it("does NOT trip at ratio <= 3 — exactly 3x still merges normally", async () => {
    // 6 imports vs 2 locals = exactly 3x, which is NOT > 3x.
    const lines = [1, 2, 3, 4, 5, 6].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      expect(out).toHaveLength(8); // 2 local + 6 imported, nothing suppressed
      expect(mocks.logWarn).not.toHaveBeenCalled();
    });
  });

  it("warns exactly once, naming sessionKey, cliSessionId and both counts", async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        sessionKey: "agent:main:webchat",
        localMessages: localMessagesFixture(),
        homeDir,
      });
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
      const message = String(mocks.logWarn.mock.calls[0]?.[0]);
      expect(message).toContain("agent:main:webchat");
      expect(message).toContain(cliSessionId);
      expect(message).toContain("2 local");
      expect(message).toContain("7 imported");
      expect(message).toContain("newest 6"); // what survived
      expect(message).toContain("1 dropped"); // and what did not
    });
  });

  it("never fires against an EMPTY local store — a reset must not become a deletion", async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: [],
        homeDir,
      });
      expect(out).toHaveLength(7);
      expect(mocks.logWarn).not.toHaveBeenCalled();
    });
  });

  // Plan task 5 (chat.history seq cursors): an afterSeq delta hands this function only the NEW
  // local rows. Sized by that slice, the valve would cut imports the whole-store call keeps —
  // the first test in this block is the control (same 2 locals + 7 imports → 1 dropped).
  it("sizes the valve by floodValveLocalCount when the caller passes a slice of the store", async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        floodValveLocalCount: 40, // the whole store: 7 imports vs 40 locals is far under 3x
        homeDir,
      });
      expect(out).toHaveLength(9); // 2 local + all 7 imports
      expect(JSON.stringify(out)).toContain("imported prompt number 1");
      expect(mocks.logWarn).not.toHaveBeenCalled();
    });
  });

  it("an EMPTY slice of a non-empty store trips exactly as the whole store would", async () => {
    // The empty-store exemption above is about the STORE, not the slice: a caller whose slice is
    // empty but whose store holds 2 rows gets the whole-store decision (budget 6 of 7).
    const lines = [1, 2, 3, 4, 5, 6, 7].map(importUserLine);
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: [],
        floodValveLocalCount: 2,
        homeDir,
      });
      expect(out).toHaveLength(6);
      expect(JSON.stringify(out)).not.toContain("imported prompt number 1");
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("B043 symmetry — only a TEXT-BEARING import assistant may cover a local answer", () => {
  beforeEach(() => {
    mocks.logWarn.mockClear();
  });

  it("a text-less import (tool_use-only) no longer covers the real local answer", async () => {
    const lines = [
      importAssistantLine({ uuid: "flood-toolonly-1", ts: "2026-08-26T10:00:03.000Z" }),
    ];
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      expect(rendered).toContain("the real local answer");
      expect(out).toHaveLength(2); // locals intact; the covered text-less import is suppressed
    });
  });

  it("a text-bearing import assistant still covers the local coalesced blob", async () => {
    const lines = [
      importAssistantLine({
        uuid: "flood-segmented-1",
        ts: "2026-08-26T10:00:03.000Z",
        text: "imported segmented answer with the tool narration folded correctly",
      }),
    ];
    await withTranscript(lines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: localMessagesFixture(),
        homeDir,
      });
      const rendered = JSON.stringify(out);
      expect(rendered).toContain("imported segmented answer");
      expect(rendered).not.toContain("the real local answer");
    });
  });
});

// Plan task 5, review fix round 1: the merge's prehistory floor (layer 1: imports older than the
// earliest LOCAL row minus 15 min are dropped) must be anchored at the whole store's earliest row
// when the caller merges a slice, like the flood valve's size.
describe("prehistory floor for a slice of the local store", () => {
  const T0 = Date.parse("2026-08-26T11:00:00.000Z");
  const loopLines = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({
      type: "user",
      uuid: `loop-${i}`,
      timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
      message: { role: "user", content: `loop step ${i} with distinctive text` },
    }),
  );
  const answerOnly = () => [
    {
      role: "assistant",
      content: [{ type: "text", text: "the answer after 31 minutes" }],
      timestamp: T0 + 31 * 60_000,
    },
  ];
  const importCount = (out: unknown[]) =>
    out.filter(
      (m) => (m as { __openclaw?: { importedFrom?: unknown } }).__openclaw?.importedFrom != null,
    ).length;

  it("anchors at wholeStoreEarliestLocalTs, and at the slice when it is absent", async () => {
    await withTranscript(loopLines, ({ homeDir, cliSessionId }) => {
      // CONTROL: a slice holding only the answer floors at t0+16 min and keeps 15 of 30 steps.
      // Both calls pin the flood valve to the whole store (40 rows) so only the floor differs.
      const sliceFloored = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: answerOnly(),
        floodValveLocalCount: 40,
        homeDir,
      });
      expect(importCount(sliceFloored)).toBe(15);
      const wholeFloored = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: answerOnly(),
        floodValveLocalCount: 40,
        wholeStoreEarliestLocalTs: T0 - 60 * 60_000,
        homeDir,
      });
      expect(importCount(wholeFloored)).toBe(30);
    });
  });

  it("floors an EMPTY slice of a non-empty store as the whole store would", async () => {
    // Without a local row the merge used to skip layer 1 entirely; given the store's earliest
    // row it floors like the whole store: steps older than that row minus 15 min are prehistory.
    await withTranscript(loopLines, ({ homeDir, cliSessionId }) => {
      const out = augmentChatHistoryWithCliSessionImports({
        entry: entryFor(cliSessionId),
        localMessages: [],
        floodValveLocalCount: 40,
        wholeStoreEarliestLocalTs: T0 + 20 * 60_000, // floor at t0+5 min: steps 0-3 are older
        homeDir,
      });
      expect(importCount(out)).toBe(26);
    });
  });
});
