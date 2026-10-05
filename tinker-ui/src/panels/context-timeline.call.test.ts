/**
 * context-window-panel.md §6.2 B6 — ONE consumer for `stream:"call"`, feeding both views.
 *
 * The ctx-timeline's only per-call feed used to be a per-round lifecycle pair whose producers never
 * had a caller (F9), so no call ever drew a column. B6 re-points it at the `call` contract through
 * the call timeline's own record of each call: one reader (parseCallFrame), one interpreter
 * (CallTimelineStore.applyCall), two views. Held here:
 *   - one call's send / usage / end fold into exactly ONE ctx-timeline column;
 *   - two calls the wire numbers 0 and 1 stay two calls. CONTROL: the first B5 store read the
 *     wire's 0-based callIndex as its own 1-based index, so call 2 landed on call 1;
 *   - a column carries only what its call measured (P5);
 *   - an anatomy row merged into its (run, round) keeps a pre-call composition, as the DB does;
 *   - the dead pair is gone from the UI source, and only call-timeline.ts reads the raw stream.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CallTimelineStore, outputTotal, parseCallFrame, type TimelineCall } from "./call-timeline";
import { callColumn, mountContextTimeline, type AnatomyEvent } from "./context-timeline";

const SK = "agent:main:tinker:b6";

/** The production path, as app.ts runs it: parse once, apply once. */
function feed(
  store: CallTimelineStore,
  runId: string,
  d: Record<string, unknown>,
  receivedAt: number,
): TimelineCall | null {
  const frame = parseCallFrame(d, receivedAt);
  return frame ? store.applyCall(runId, frame) : null;
}

/** Call-column repaints are coalesced to one per animation frame. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

function mount(): { host: HTMLElement; ctrl: ReturnType<typeof mountContextTimeline> } {
  const host = document.createElement("div");
  document.body.append(host);
  const ctrl = mountContextTimeline(
    host,
    () => undefined,
    () => SK,
    () => "",
  );
  return { host, ctrl };
}

describe("parseCallFrame — the one reader of the call stream", () => {
  it("keeps a measured count (a 0 stays 0), drops an unmeasured one, rejects an unknown phase", () => {
    expect(
      parseCallFrame(
        {
          phase: "usage",
          callIndex: 0,
          lane: "cc-bridge",
          t: 1_000,
          input: 0,
          cacheRead: 9_000,
          cacheWrite: -1,
          output: Number.NaN,
        },
        1_000,
      ),
    ).toEqual({ phase: "usage", at: 1_000, wireKey: "cc-bridge:0", input: 0, cacheRead: 9_000 });
    expect(parseCallFrame({ phase: "start", callIndex: 0 }, 0)).toBeNull();
    expect(parseCallFrame(null, 0)).toBeNull();
  });

  it("trusts the producer's clock only while it agrees with the browser's", () => {
    expect(parseCallFrame({ phase: "send", callIndex: 0, t: 1_000 }, 4_000)?.at).toBe(1_000);
    expect(parseCallFrame({ phase: "send", callIndex: 0, t: 1_000 }, 60_000)?.at).toBe(60_000);
  });
});

describe("CallTimelineStore — a call's identity is the wire's (lane, callIndex), never a position", () => {
  it("keeps the two calls the wire numbers 0 and 1 as two calls (CONTROL: the 1-based read merged them)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    feed(st, "r", { phase: "send", callIndex: 0, lane: "cc-bridge", t: 1_000 }, 1_000);
    feed(
      st,
      "r",
      { phase: "usage", callIndex: 0, lane: "cc-bridge", input: 100, cacheRead: 900 },
      1_200,
    );
    st.outputCumulative("r", "responseText", 70, 1_500);
    feed(
      st,
      "r",
      {
        phase: "end",
        callIndex: 0,
        lane: "cc-bridge",
        output: 10,
        stopReason: "tool_use",
        t: 3_000,
      },
      3_000,
    );
    st.toolStart("r", "t1", "bash", 3_100, 20);
    st.toolEnd("t1", 4_000, false);
    feed(st, "r", { phase: "send", callIndex: 1, lane: "cc-bridge", t: 5_000 }, 5_000);
    feed(
      st,
      "r",
      { phase: "usage", callIndex: 1, lane: "cc-bridge", input: 50, cacheRead: 1_000 },
      5_200,
    );
    feed(
      st,
      "r",
      {
        phase: "end",
        callIndex: 1,
        lane: "cc-bridge",
        output: 20,
        stopReason: "end_turn",
        t: 7_000,
      },
      7_000,
    );
    expect(
      st.calls.map((c) => [
        c.index,
        c.sendAt,
        c.endAt,
        c.stack.total,
        outputTotal(c),
        c.stopReason,
      ]),
    ).toEqual([
      [1, 1_000, 3_000, 1_000, 10, "tool_use"],
      [2, 5_000, 7_000, 1_050, 20, "end_turn"],
    ]);
  });

  it("keeps a failover lane's call 0 off the first lane's call 0 (the identity includes the lane)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    feed(st, "r", { phase: "send", callIndex: 0, lane: "embedded", t: 1_000 }, 1_000);
    feed(st, "r", { phase: "end", callIndex: 0, lane: "embedded", output: 5, t: 2_000 }, 2_000);
    feed(st, "r", { phase: "send", callIndex: 0, lane: "cc-bridge", t: 3_000 }, 3_000);
    expect(st.calls.map((c) => c.sendAt)).toEqual([1_000, 3_000]);
  });

  it("lets `end` re-report the parts it measured without shrinking the ones it did not", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "m");
    feed(
      st,
      "r",
      { phase: "usage", callIndex: 0, lane: "embedded", input: 100, cacheRead: 9_000 },
      10,
    );
    feed(st, "r", { phase: "end", callIndex: 0, lane: "embedded", input: 120, output: 5 }, 20);
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].prompt).toMatchObject({ exact: 9_120, input: 120, cacheRead: 9_000 });
  });
});

describe("the ctx-timeline hears the call stream (B6)", () => {
  it("folds one call's send, usage and end into exactly ONE column", async () => {
    const { host, ctrl } = mount();
    try {
      expect(host.querySelectorAll(".ct-col")).toHaveLength(0);
      const st = new CallTimelineStore();
      st.turnStart("r", 0, "claude-opus-5");
      const push = (d: Record<string, unknown>, t: number): void => {
        const c = feed(st, "r", { lane: "cc-bridge", ...d }, t);
        if (c) {
          ctrl.pushCall("r", callColumn(c, { runId: "r", sessionKey: SK }));
        }
      };
      push({ phase: "send", callIndex: 0, t: 1_000 }, 1_000);
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(1);
      push({ phase: "usage", callIndex: 0, input: 100, cacheRead: 9_000, cacheWrite: 900 }, 1_200);
      push({ phase: "end", callIndex: 0, output: 42, stopReason: "end_turn", t: 3_000 }, 3_000);
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(1);
      expect(host.querySelectorAll(".ct-resp-bar")).toHaveLength(1);
      push({ phase: "send", callIndex: 1, t: 5_000 }, 5_000);
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(2);
    } finally {
      host.remove();
    }
  });

  it("builds the column from the call's record, and only from what the call measured (P5)", () => {
    const st = new CallTimelineStore();
    st.turnStart("r", 0, "claude-opus-5");
    feed(
      st,
      "r",
      { phase: "send", callIndex: 0, lane: "cc-bridge", t: 1_000, promptTokensEstimate: 8_000 },
      1_000,
    );
    const sent = callColumn(st.calls[0], { runId: "r", sessionKey: SK, maxWindow: 1_000_000 });
    expect(sent).toMatchObject({
      callColumn: true,
      runId: "r",
      sessionKey: SK,
      roundNumber: 1,
      timestampMs: 1_000,
      model: "claude-opus-5",
      promptProvenance: "estimated",
      contextSent: { totalTokens: 8_000 },
      contextWindow: { maxTokens: 1_000_000 },
    });
    expect(sent.responseTokens).toBeUndefined();
    feed(
      st,
      "r",
      {
        phase: "usage",
        callIndex: 0,
        lane: "cc-bridge",
        input: 100,
        cacheRead: 9_000,
        cacheWrite: 900,
      },
      1_200,
    );
    feed(
      st,
      "r",
      {
        phase: "end",
        callIndex: 0,
        lane: "cc-bridge",
        output: 42,
        stopReason: "end_turn",
        t: 3_000,
      },
      3_000,
    );
    expect(callColumn(st.calls[0], { runId: "r" })).toMatchObject({
      promptProvenance: "exact",
      contextSent: { totalTokens: 10_000 },
      cacheReadTokens: 9_000,
      cacheCreationTokens: 900,
      responseTokens: 42,
      durationMs: 2_000,
      stopReason: "end_turn",
    });
    // An apportioned turn total is not a call's output: the column leaves it out.
    const st2 = new CallTimelineStore();
    st2.turnStart("q", 0, "m");
    st2.outputCumulative("q", "responseText", 350, 10);
    st2.turnOutput("q", 500, 20);
    expect(st2.calls[0].outProvenance).toBe("apportioned");
    expect(callColumn(st2.calls[0], { runId: "q" }).responseTokens).toBeUndefined();
  });

  it("puts a turn's anatomy column in its run's group, beside (never inside) the call columns", async () => {
    const { host, ctrl } = mount();
    try {
      const st = new CallTimelineStore();
      st.turnStart("r", 0, "m");
      const c = feed(st, "r", { phase: "usage", callIndex: 0, lane: "embedded", input: 500 }, 100);
      expect(c).not.toBeNull();
      ctrl.pushCall("r", callColumn(c as TimelineCall, { runId: "r" }));
      ctrl.pushEvent(
        {
          roundNumber: 0,
          snapshot: "post-turn",
          contextSent: { systemPromptTokens: 400, totalTokens: 400 },
        },
        "r",
      );
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(2);
      expect(host.querySelectorAll(".ct-group")).toHaveLength(1);
    } finally {
      host.remove();
    }
  });

  it("merges an anatomy row into its (run, round) and keeps a pre-call composition, as the DB does", () => {
    const { host, ctrl } = mount();
    try {
      const preSent = { systemPromptTokens: 600, userMessageTokens: 40, totalTokens: 640 };
      const pre: AnatomyEvent = {
        roundNumber: 0,
        snapshot: "pre-call",
        timestampMs: 1_000,
        turn: 3,
        contextSent: { ...preSent },
      };
      const post: AnatomyEvent = {
        roundNumber: 0,
        snapshot: "post-turn",
        timestampMs: 9_000,
        turn: 3,
        contextSent: {
          systemPromptTokens: 600,
          conversationHistoryTokens: 900,
          totalTokens: 1_500,
        },
        responseTokens: 77,
      };
      ctrl.pushEvent(pre, "r");
      ctrl.pushEvent(post, "r");
      expect(host.querySelectorAll(".ct-col")).toHaveLength(1);
      const sel = ctrl.getSelected();
      expect(sel?.contextSent).toEqual(preSent);
      expect(sel).toMatchObject({ snapshot: "pre-call", timestampMs: 1_000, responseTokens: 77 });
    } finally {
      host.remove();
    }
  });
});

describe("the dead per-round pair is gone, and the call stream has one reader (F9, B6)", () => {
  it("leaves no round consumer in app.ts, no round method in context-timeline.ts, one parse site", () => {
    // Resolved from the run root, NOT from import.meta.url: under jsdom that is an http:// URL.
    const panels = ["tinker-ui/src/panels", "src/panels", "panels"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "context-timeline.ts")));
    expect(panels, `context-timeline.ts not found from ${process.cwd()}`).toBeTruthy();
    const app = readFileSync(join(panels as string, "..", "app.ts"), "utf8");
    const timeline = readFileSync(join(panels as string, "context-timeline.ts"), "utf8");
    const owner = readFileSync(join(panels as string, "call-timeline.ts"), "utf8");
    for (const [name, src] of [
      ["app.ts", app],
      ["context-timeline.ts", timeline],
    ] as const) {
      expect(src.match(/round-start|round-complete|pushRoundComplete/g) ?? [], name).toEqual([]);
      // Single owner: only call-timeline.ts reads the raw `call` fields.
      expect(src.match(/callIndex|promptTokensEstimate/g) ?? [], name).toEqual([]);
    }
    expect(owner.match(/\.callIndex\b/g) ?? []).toHaveLength(1);
    // app.ts parses the stream in exactly one place and never hands the store a raw frame.
    expect(app.match(/parseCallFrame\(/g) ?? []).toHaveLength(1);
    expect(app).not.toMatch(/\.callEvent\(/);
  });
});

describe("B2 host half — the composition's badge comes from the row that carried it", () => {
  it("every anatomy-row composition assignment in app.ts sets compositionSnapshot from the SAME row", () => {
    // context-window-panel.md §6.2 B2: context-cache.ts renders `compositionSnapshot` ("pre-call" /
    // "post-turn") but, before this, no host ever set it, so the badge never appeared. app.ts is a
    // browser entry with no harness, so the wiring is pinned at the source: each
    // `<state>.contextSent = <row>.contextSent;` must be followed (comments allowed between) by
    // `<state>.compositionSnapshot = compositionSnapshotOf(<row>);`. CONTROL: at the parent commit
    // the two assignments exist and the paired count is 0, so this fails there.
    const srcRoot = ["tinker-ui/src", "src"]
      .map((p) => join(process.cwd(), p))
      .find((p) => existsSync(join(p, "app.ts")));
    expect(srcRoot, `app.ts not found from ${process.cwd()}`).toBeTruthy();
    const app = readFileSync(join(srcRoot as string, "app.ts"), "utf8");
    const assigned = app.match(/(\w+)\.contextSent = (\w+)\.contextSent;/g) ?? [];
    const paired =
      app.match(
        /(\w+)\.contextSent = (\w+)\.contextSent;\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*\1\.compositionSnapshot = compositionSnapshotOf\(\2\);/g,
      ) ?? [];
    expect(assigned.length).toBeGreaterThanOrEqual(2);
    expect(paired).toHaveLength(assigned.length);
    // The reader accepts only the two values A9 writes; anything else stays unset (no badge).
    expect(app).toMatch(/v === "pre-call" \|\| v === "post-turn" \? v : undefined/);
  });
});
