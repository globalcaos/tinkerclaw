import { describe, expect, it } from "vitest";
import { HEARTBEAT_TRANSCRIPT_PROMPT } from "../auto-reply/heartbeat.js";
import { isShownHistoryUserRow, projectChatDisplayMessages } from "./chat-display-projection.js";
import {
  buildChatHistoryCursor,
  filterImportsToWindow,
  planChatHistoryWindow,
  type ChatHistoryWindowPlan,
} from "./chat-history-cursor.js";

// Plan task 5 (chat.history rehaul): the pure half of the seq cursors. The handler wiring and the
// end-to-end replies are covered in server-methods/chat.cursor.test.ts.

const EPOCH = "nonce:1:7:root";

/** A local row as readSessionMessagesWithCursor serves it: __openclaw.seq, ms timestamp. */
const row = (seq: number, ts = seq * 1000) => ({
  role: seq % 2 === 1 ? "user" : "assistant",
  content: [{ type: "text", text: `row ${seq}` }],
  timestamp: ts,
  __openclaw: { id: `e${seq}`, seq },
});
/** A stranded prompt (prompt-key-marker.ts): local, keyed, and deliberately seq-less. */
const stranded = (id: string, ts: number) => ({
  role: "user",
  content: [{ type: "text", text: `stranded ${id}` }],
  timestamp: ts,
  idempotencyKey: `idem-${id}`,
  __openclaw: { id, stranded: true },
});
const imported = (id: string, ts: number | undefined) => ({
  role: "assistant",
  content: [{ type: "text", text: `import ${id}` }],
  ...(ts === undefined ? {} : { timestamp: ts }),
  __openclaw: { importedFrom: "claude-cli", cliSessionId: "cli-1", externalId: id },
});
const seqs = (rows: unknown[]) =>
  rows.map((m) => (m as { __openclaw?: { seq?: number; id?: string } }).__openclaw?.seq ?? "s");

const transcript = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
const plan = (
  local: unknown[],
  request: { afterSeq?: number; beforeSeq?: number; epoch?: string },
  limit = 200,
  serverEpoch: string | null = EPOCH,
) => planChatHistoryWindow({ local, serverEpoch, request, limit });

describe("planChatHistoryWindow", () => {
  it("serves the legacy tail window when no cursor is sent, even with an epoch", () => {
    expect(plan(transcript(3), {})).toEqual({ kind: "tail", reset: false });
    expect(plan(transcript(3), { epoch: EPOCH })).toEqual({ kind: "tail", reset: false });
  });

  it("resets unless the client's epoch equals the server's non-null epoch (R22)", () => {
    const local = transcript(5);
    const reset = { kind: "tail", reset: true };
    expect(plan(local, { afterSeq: 2 })).toEqual(reset); // no client epoch
    expect(plan(local, { afterSeq: 2, epoch: "other" })).toEqual(reset);
    expect(plan(local, { beforeSeq: 3, epoch: "other" })).toEqual(reset);
    expect(plan(local, { afterSeq: 2, epoch: EPOCH }, 200, null)).toEqual(reset); // flat transcript
  });

  it("afterSeq keeps the rows after it and the import floor at that row's time", () => {
    const p = plan(transcript(6), { afterSeq: 4, epoch: EPOCH });
    expect(p.kind).toBe("after");
    const after = p as Extract<ChatHistoryWindowPlan, { kind: "after" }>;
    expect(seqs(after.local)).toEqual([5, 6]);
    expect(after.importFromTs).toBe(4000);
    expect(after.lastSeq).toBe(6);
  });

  it("afterSeq carries every stranded row, wherever it sits in time", () => {
    // A concurrent append can strand a prompt AFTER the client's last read while its send time
    // places it before row afterSeq; its idempotency key is what retires it from the outbox.
    const local = [row(1), row(2), stranded("late", 2500), row(3), row(4), row(5)];
    const after = plan(local, { afterSeq: 4, epoch: EPOCH }) as Extract<
      ChatHistoryWindowPlan,
      { kind: "after" }
    >;
    expect(seqs(after.local)).toEqual(["s", 5]);
  });

  it("afterSeq 0 is the whole transcript with no import floor; an empty delta is a slice", () => {
    const all = plan(transcript(3), { afterSeq: 0, epoch: EPOCH }) as Extract<
      ChatHistoryWindowPlan,
      { kind: "after" }
    >;
    expect(seqs(all.local)).toEqual([1, 2, 3]);
    expect(all.importFromTs).toBe(Number.NEGATIVE_INFINITY);
    const none = plan(transcript(3), { afterSeq: 3, epoch: EPOCH });
    expect(none).toMatchObject({ kind: "after", afterSeq: 3, local: [], lastSeq: 3 });
  });

  it("resets an afterSeq past the end or one whole window behind (R10)", () => {
    const local = transcript(12);
    expect(plan(local, { afterSeq: 13, epoch: EPOCH })).toEqual({ kind: "tail", reset: true });
    expect(plan(local, { afterSeq: 1, epoch: EPOCH }, 10)).toEqual({ kind: "tail", reset: true });
    expect(plan(local, { afterSeq: 2, epoch: EPOCH }, 10).kind).toBe("after"); // exactly 10 new
  });

  it("beforeSeq pages the `limit` rows before it, bounded in time by the page", () => {
    const p = plan(transcript(10), { beforeSeq: 7, epoch: EPOCH }, 3);
    expect(p).toMatchObject({ kind: "before", firstSeq: 4, lastSeq: 6 });
    const before = p as Extract<ChatHistoryWindowPlan, { kind: "before" }>;
    expect(seqs(before.local)).toEqual([4, 5, 6]);
    expect(before.importFromTs).toBe(4000);
    expect(before.importToTs).toBe(7000);
  });

  it("a page that reaches seq 1 opens its time floor and takes leading stranded rows", () => {
    const local = [stranded("early", 500), row(1), row(2), row(3), row(4)];
    const before = plan(local, { beforeSeq: 3, epoch: EPOCH }, 50) as Extract<
      ChatHistoryWindowPlan,
      { kind: "before" }
    >;
    expect(seqs(before.local)).toEqual(["s", 1, 2]);
    expect(before.importFromTs).toBe(Number.NEGATIVE_INFINITY);
    expect(before).toMatchObject({ firstSeq: 1, lastSeq: 2 });
  });

  it("beforeSeq one past the end pages the tail; further out, or seq 1, behave", () => {
    const local = transcript(4);
    const end = plan(local, { beforeSeq: 5, epoch: EPOCH }, 2);
    expect(end).toMatchObject({ kind: "before", firstSeq: 3, lastSeq: 4 });
    expect((end as { importToTs: number }).importToTs).toBe(Number.POSITIVE_INFINITY);
    expect(plan(local, { beforeSeq: 6, epoch: EPOCH })).toEqual({ kind: "tail", reset: true });
    expect(plan(local, { beforeSeq: 1, epoch: EPOCH })).toMatchObject({
      kind: "before",
      local: [],
      firstSeq: 0,
      lastSeq: 0,
    });
  });
});

describe("filterImportsToWindow", () => {
  const merged = [imported("old", 1500), row(2), imported("untimed", undefined), row(3)];
  const merged2 = [...merged, imported("mid", 3500), row(4), imported("new", 4500)];

  it("leaves the tail window untouched", () => {
    expect(filterImportsToWindow(merged2, { kind: "tail", reset: false })).toBe(merged2);
  });

  it("an afterSeq delta keeps imports at or after the floor, and untimed ones", () => {
    const out = filterImportsToWindow(merged2, {
      kind: "after",
      afterSeq: 3,
      local: [],
      importFromTs: 3500,
      lastSeq: 4,
    });
    expect(out.map((m) => (m as { content: Array<{ text: string }> }).content[0].text)).toEqual([
      "row 2",
      "import untimed",
      "row 3",
      "import mid",
      "row 4",
      "import new",
    ]);
  });

  it("a beforeSeq page keeps imports inside [floor, anchor], ties with the anchor included", () => {
    // Ruling R23: an import tied in time with the anchor row may sit before it in merge order and
    // be cut from the newer window; the older page must still deliver it.
    const out = filterImportsToWindow([...merged2, imported("tie", 4000)], {
      kind: "before",
      local: [],
      importFromTs: 2000,
      importToTs: 4000,
      firstSeq: 2,
      lastSeq: 3,
    });
    expect(
      out.filter((m) => (m as { __openclaw: { importedFrom?: string } }).__openclaw.importedFrom),
    ).toEqual([imported("untimed", undefined), imported("mid", 3500), imported("tie", 4000)]);
  });
});

describe("buildChatHistoryCursor", () => {
  const local = transcript(6);
  const tail = (reset = false): ChatHistoryWindowPlan => ({ kind: "tail", reset });

  it("an uncut tail covers the whole transcript", () => {
    const window = local.slice(1); // row 1 hidden by the projection: consumed, not owed
    const cursor = buildChatHistoryCursor({
      plan: tail(),
      epoch: EPOCH,
      local,
      window,
      served: window,
    });
    expect(cursor).toEqual({
      epoch: EPOCH,
      firstSeq: 1,
      lastSeq: 6,
      hasMoreBefore: false,
      reset: false,
      userRowsBefore: 0,
    });
    expect(
      buildChatHistoryCursor({ plan: tail(), epoch: EPOCH, local: [], window: [], served: [] }),
    ).toMatchObject({ firstSeq: 0, lastSeq: 0, hasMoreBefore: false });
  });

  it("a limited tail resumes after the newest CUT row, not at the oldest served one (R23)", () => {
    // LOCAL_TAIL_FLOOR kept rows 1-4 while the fill kept only import c: a and b were cut between
    // rows 2 and 3. Paging back from row 1 (the oldest served local row) would never deliver them.
    const [r1, r2, r3, r4] = local;
    const a = imported("a", 2500);
    const b = imported("b", 2600);
    const c = imported("c", 3500);
    const window = [r1, r2, a, b, r3, c, r4];
    const cursor = buildChatHistoryCursor({
      plan: tail(true),
      epoch: null,
      local: local.slice(0, 4),
      window,
      served: [r1, r2, r3, c, r4],
    });
    expect(cursor).toEqual({
      epoch: null,
      firstSeq: 3,
      lastSeq: 4,
      hasMoreBefore: true,
      reset: true,
      userRowsBefore: 1, // row 1
    });
  });

  it("a tail whose newest cut row has no local row after it resumes one past the end", () => {
    const [r1, r2] = local;
    const x = imported("x", 3000);
    expect(
      buildChatHistoryCursor({
        plan: tail(),
        epoch: EPOCH,
        local: [r1, r2],
        window: [r1, r2, x],
        served: [r1, r2],
      }),
    ).toMatchObject({ firstSeq: 3, lastSeq: 2, hasMoreBefore: true });
    // No local rows at all, imports cut: beforeSeq 1 is the page that serves them.
    const p = imported("p", 100);
    const q = imported("q", 200);
    expect(
      buildChatHistoryCursor({
        plan: tail(),
        epoch: EPOCH,
        local: [],
        window: [p, q],
        served: [q],
      }),
    ).toMatchObject({ firstSeq: 1, lastSeq: 0, hasMoreBefore: true });
  });

  it("an afterSeq delta covers afterSeq+1..lastSeq; an empty one pins both to afterSeq", () => {
    const after = (afterSeq: number): ChatHistoryWindowPlan => ({
      kind: "after",
      afterSeq,
      local: local.slice(afterSeq),
      importFromTs: afterSeq * 1000,
      lastSeq: 6,
    });
    // rows 5-6 hidden by the projection: still consumed
    expect(
      buildChatHistoryCursor({ plan: after(4), epoch: EPOCH, local, window: [], served: [] }),
    ).toEqual({ epoch: EPOCH, firstSeq: 5, lastSeq: 6, hasMoreBefore: true, reset: false });
    expect(
      buildChatHistoryCursor({ plan: after(6), epoch: EPOCH, local, window: [], served: [] }),
    ).toMatchObject({ firstSeq: 6, lastSeq: 6, reset: false });
  });

  it("an afterSeq delta the byte caps cut is a reset window, never a hole", () => {
    const window = local.slice(1);
    const cursor = buildChatHistoryCursor({
      plan: { kind: "after", afterSeq: 1, local: window, importFromTs: 1000, lastSeq: 6 },
      epoch: EPOCH,
      local,
      window,
      served: local.slice(4),
    });
    expect(cursor).toEqual({
      epoch: EPOCH,
      firstSeq: 5,
      lastSeq: 6,
      hasMoreBefore: true,
      reset: true,
      userRowsBefore: 2, // rows 1 and 3
    });
  });

  it("a beforeSeq page reports its planned range unless the caps cut it, and always moves back", () => {
    const page: ChatHistoryWindowPlan = {
      kind: "before",
      local: local.slice(1, 4),
      importFromTs: 2000,
      importToTs: 5000,
      firstSeq: 2,
      lastSeq: 4,
    };
    const [, r2, r3, r4] = local;
    const z = imported("z", 4500);
    const window = [r2, r3, r4, z];
    expect(
      buildChatHistoryCursor({ plan: page, epoch: EPOCH, local, window, served: window }),
    ).toEqual({
      epoch: EPOCH,
      firstSeq: 2,
      lastSeq: 4,
      hasMoreBefore: true,
      reset: false,
      userRowsBefore: 1,
    });
    expect(
      buildChatHistoryCursor({ plan: page, epoch: EPOCH, local, window, served: [r4, z] }),
    ).toMatchObject({ firstSeq: 4, lastSeq: 4, reset: false });
    // Only the import survived the caps: resume below the page's own anchor, never at it.
    expect(
      buildChatHistoryCursor({ plan: page, epoch: EPOCH, local, window, served: [z] }),
    ).toMatchObject({ firstSeq: 4, hasMoreBefore: true });
  });
});

// FORK 2026-09-24 — ruling R36: `cursor.userRowsBefore` = the user rows the display shows with a
// seq below `firstSeq`, so a client holding a partial page can number turns from the start.
describe("cursor.userRowsBefore (R36)", () => {
  const user = (seq: number, text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: seq * 1000,
    __openclaw: { id: `u${seq}`, seq },
  });

  it("counts the shown user rows below firstSeq: not heartbeats, empty prompts or seq-less rows", () => {
    const local = [
      row(1), // user
      row(2),
      user(3, HEARTBEAT_TRANSCRIPT_PROMPT), // hidden by the display projection
      user(4, "   "), // hidden: empty text
      stranded("s", 4500), // seq-less: not numbered
      row(5), // user
      row(6),
      row(7), // user, at firstSeq: not before it
      row(8),
    ];
    const window = local.slice(7);
    const cursor = buildChatHistoryCursor({
      plan: { kind: "tail", reset: false },
      epoch: EPOCH,
      local,
      window: local.slice(6),
      served: window,
    });
    expect(cursor).toMatchObject({ firstSeq: 7, userRowsBefore: 2 });
  });

  it("a beforeSeq page counts below ITS firstSeq; a plain afterSeq delta leaves it out", () => {
    const local = transcript(10);
    const page: ChatHistoryWindowPlan = {
      kind: "before",
      local: local.slice(4, 6),
      importFromTs: 5000,
      importToTs: 7000,
      firstSeq: 5,
      lastSeq: 6,
    };
    const served = local.slice(4, 6);
    expect(
      buildChatHistoryCursor({ plan: page, epoch: EPOCH, local, window: served, served }),
    ).toMatchObject({ firstSeq: 5, userRowsBefore: 2 }); // rows 1 and 3
    const delta = buildChatHistoryCursor({
      plan: { kind: "after", afterSeq: 8, local: local.slice(8), importFromTs: 8000, lastSeq: 10 },
      epoch: EPOCH,
      local,
      window: local.slice(8),
      served: local.slice(8),
    });
    expect(delta).toMatchObject({ firstSeq: 9, reset: false });
    expect("userRowsBefore" in delta).toBe(false); // the client keeps its own
  });

  it("isShownHistoryUserRow agrees with the display projection row by row", () => {
    const rows: unknown[] = [
      user(1, "a real prompt"),
      user(2, HEARTBEAT_TRANSCRIPT_PROMPT),
      user(3, ""),
      { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
      { role: "user", content: "plain string prompt" },
      { role: "USER", content: "upper-case role" },
      row(2), // assistant
      { role: "toolResult", content: "t" },
    ];
    for (const m of rows) {
      const shown = projectChatDisplayMessages([m]);
      const shownAsUser = shown.length === 1 && String(shown[0].role).toLowerCase() === "user";
      expect(isShownHistoryUserRow(m), JSON.stringify(m).slice(0, 80)).toBe(shownAsUser);
    }
  });

  // FORK 2026-09-24 (R36 residual: turn numbers on cc-bridge tabs) — claude-cli IMPORTED user rows
  // count too. The Tinker UI numbers turns over every `role: "user"` row on its page, imports
  // included, and subtracts only the LOCAL rows it holds below firstSeq.
  const importedUser = (id: string, ts: number | undefined, text = `imported prompt ${id}`) => ({
    role: "user",
    content: text,
    ...(ts === undefined ? {} : { timestamp: ts }),
    __openclaw: { importedFrom: "claude-cli", cliSessionId: "cli-1", externalId: id },
  });
  type CursorCount = { firstSeq: number; userRowsBefore?: number };
  /** The UI's turn number over one reply's page (tinker-ui history-paging.ts turnNumberOf). */
  const uiTurnNumber = (page: unknown[], cursor: CursorCount) => {
    const users = page.filter((m) => (m as { role?: unknown }).role === "user");
    const heldBelow = users.filter((m) => {
      const meta = (m as { __openclaw?: { seq?: number; importedFrom?: string } }).__openclaw;
      const seq = meta?.importedFrom == null ? meta?.seq : undefined;
      return typeof seq === "number" && seq < cursor.firstSeq;
    }).length;
    return Math.max(0, (cursor.userRowsBefore ?? 0) - heldBelow) + users.length;
  };

  it("a tail counts the imported user rows the limit cut before firstSeq, never those it served", () => {
    const local = transcript(4); // user rows 1 and 3
    const [r1, r2, r3, r4] = local;
    const a = importedUser("a", 1500);
    const b = importedUser("b", 2500);
    const c = importedUser("c", 3500);
    const step = imported("step", 3600); // an assistant import: not a user row
    const window = [r1, a, r2, b, r3, c, step, r4];
    const served = [r1, r2, b, r3, r4]; // LOCAL_TAIL_FLOOR kept rows 1-4; the fill kept b
    const cursor = buildChatHistoryCursor({
      plan: { kind: "tail", reset: false },
      epoch: EPOCH,
      local,
      window,
      served,
    });
    // Resumes at row 4, after the newest cut row: rows 1 and 3, plus the cut a and c (was 2).
    expect(cursor).toMatchObject({ firstSeq: 4, userRowsBefore: 4 });
    // 4, less rows 1 and 3 (held below firstSeq), plus the 3 user rows served: all 5 it held.
    expect(uiTurnNumber(served, cursor)).toBe(5);
  });

  it("a beforeSeq page counts the imported user rows below its floor, deduped against every local row", () => {
    const long = (n: number) =>
      `prompt ${n}, long enough that the import merge dedups a copy of it by its text alone`;
    const local = [
      user(1, long(1)),
      row(2),
      user(3, long(3)),
      row(4),
      row(5),
      row(6),
      row(7),
      row(8),
    ];
    const page = local.slice(4, 6); // rows 5-6
    const untimed = importedUser("untimed", undefined);
    const tie = importedUser("tie", 5000);
    const window = [untimed, page[0], tie, page[1]];
    const merged = [
      // The claude-cli copy of row 1, with the bridge's narration suffix: the window merge saw
      // rows 5-6 only and kept it; the whole-store merge drops it.
      importedUser("twin-1", 1050, `${long(1)}\n<!-- TINKERCLAW narration contract -->`),
      importedUser("injected", 2500, "Continue from where you left off."), // counted
      {
        role: "user",
        content: [{ type: "text", text: HEARTBEAT_TRANSCRIPT_PROMPT }],
        timestamp: 3500,
        __openclaw: { importedFrom: "claude-cli", cliSessionId: "cli-1", externalId: "hb" },
      }, // hidden by the display projection
      imported("step", 3600), // assistant
      untimed, // kept in every window, so never below one
      ...page,
      tie, // at the floor: inside the window
      importedUser("newer", 7500), // above the page
    ];
    const cursor = buildChatHistoryCursor({
      plan: {
        kind: "before",
        local: page,
        importFromTs: 5000,
        importToTs: 7000,
        firstSeq: 5,
        lastSeq: 6,
      },
      epoch: EPOCH,
      local,
      window,
      served: window,
      merged,
    });
    // Rows 1 and 3, plus "injected". Counted as the window merge left them it would be 4 (twin-1).
    expect(cursor).toMatchObject({ firstSeq: 5, userRowsBefore: 3 });
  });

  it("judges each claude-cli transcript against the merge's prehistory floor on its own", () => {
    const hour = 60 * 60_000;
    const local = Array.from({ length: 8 }, (_, i) => row(i + 1, hour + (i + 1) * 1000));
    const page = local.slice(4, 6);
    // A spawn whose whole transcript predates the local store by more than the merge's 15-minute
    // grace: augmentChatHistoryWithCliSessionImports merges it alone and its floor valve keeps it.
    const older = {
      ...importedUser("older", 0, "a prompt from a spawn before this local store began"),
      __openclaw: { importedFrom: "claude-cli", cliSessionId: "cli-0", externalId: "older" },
    };
    const recent = importedUser("recent", hour + 2500);
    const cursor = buildChatHistoryCursor({
      plan: {
        kind: "before",
        local: page,
        importFromTs: hour + 5000,
        importToTs: hour + 7000,
        firstSeq: 5,
        lastSeq: 6,
      },
      epoch: EPOCH,
      local,
      window: page,
      served: page,
      merged: [older, recent, ...page],
    });
    // Rows 1 and 3, plus both imports. One merge over both transcripts floors "older" away: 3.
    expect(cursor.userRowsBefore).toBe(4);
  });

  it("a plain afterSeq delta never reads the merge; a delta the caps cut counts below its floor", () => {
    const local = transcript(8);
    const untouchable = new Proxy([] as unknown[], {
      get() {
        throw new Error("a plain delta read the import merge");
      },
    });
    const delta = buildChatHistoryCursor({
      plan: { kind: "after", afterSeq: 6, local: local.slice(6), importFromTs: 6000, lastSeq: 8 },
      epoch: EPOCH,
      local,
      window: local.slice(6),
      served: local.slice(6),
      merged: untouchable,
    });
    expect("userRowsBefore" in delta).toBe(false);

    const cut = buildChatHistoryCursor({
      plan: { kind: "after", afterSeq: 4, local: local.slice(4), importFromTs: 4000, lastSeq: 8 },
      epoch: EPOCH,
      local,
      window: local.slice(4),
      served: local.slice(6),
      merged: [importedUser("early", 2500), ...local.slice(4)],
    });
    // Rows 1, 3 and 5 below the resumed firstSeq 7, plus the import older than row 4.
    expect(cut).toMatchObject({ firstSeq: 7, reset: true, userRowsBefore: 4 });
  });
});
