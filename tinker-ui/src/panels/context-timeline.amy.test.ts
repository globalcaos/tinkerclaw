/**
 * FORK 2026-10-15 (the architect: "little brain icons in the call timeline panel on the turn it
 * intervened"). The ctx-timeline draws one 🧠 per column that holds an Amygdala bubble, on the
 * column of the LLM call that issued the tool call. Held here:
 *   - no `amy` option → no mark, no behaviour change;
 *   - a mark lands on the column that lists its tool call id; else on the last column sent at or
 *     before it; a post-turn anatomy row whose span covers the time takes it over the previous
 *     turn's column; a column of another session (All mode) never takes it;
 *   - several marks on one column stack as ONE brain with a count, and clicks cycle the ids;
 *   - a click never reaches the column's own handlers (stopPropagation);
 *   - refresh() repaints when the marks change, coalesced to one frame; the style tag is one.
 */
import { describe, expect, it, vi } from "vitest";
import {
  mountContextTimeline,
  type AmyMark,
  type AnatomyEvent,
  type ContextTimelineAmyOptions,
} from "./context-timeline";

const SK = "agent:main:tinker:amy";

/** Call-column repaints are coalesced to one per animation frame. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

function mount(amy?: ContextTimelineAmyOptions): {
  host: HTMLElement;
  ctrl: ReturnType<typeof mountContextTimeline>;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const ctrl = mountContextTimeline(
    host,
    () => undefined,
    () => SK,
    () => "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    amy,
  );
  return { host, ctrl };
}

/** A call column as callColumn() builds it (B6): a send time, a size, no composition. */
function call(
  runId: string,
  round: number,
  sendAt: number,
  o: { tools?: string[]; sessionKey?: string } = {},
): AnatomyEvent {
  const ev: AnatomyEvent = {
    callColumn: true,
    runId,
    roundNumber: round,
    timestampMs: sendAt,
    sessionKey: o.sessionKey ?? SK,
    promptProvenance: "exact",
    contextSent: { totalTokens: 1_000 },
  };
  if (o.tools) {
    ev.toolsTriggered = o.tools.map((toolCallId) => ({ name: "bash", toolCallId }));
  }
  return ev;
}

const marks = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>(".ct-amy-mark"));

describe("timeline brains — no option, no mark", () => {
  it("draws nothing when the mount has no amy option (CONTROL for every test below)", async () => {
    const { host, ctrl } = mount();
    try {
      ctrl.pushCall("r", call("r", 1, 1_000));
      ctrl.pushCall("r", call("r", 2, 5_000));
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(2);
      expect(marks(host)).toHaveLength(0);
    } finally {
      host.remove();
    }
  });
});

describe("timeline brains — placement", () => {
  it("puts a mark on the last column sent at or before it, stacks several as one brain with a count", async () => {
    const list: AmyMark[] = [
      { id: "a", ts: 3_000, toolUseId: null },
      { id: "b", ts: 6_000, toolUseId: null },
      { id: "c", ts: 6_500, toolUseId: null },
    ];
    const { host, ctrl } = mount({ amyMarks: () => list });
    try {
      ctrl.pushCall("r", call("r", 1, 1_000));
      ctrl.pushCall("r", call("r", 2, 5_000));
      await nextFrame();
      const cols = Array.from(host.querySelectorAll<HTMLElement>(".ct-col"));
      expect(cols).toHaveLength(2);
      const m0 = cols[0].querySelector<HTMLElement>(".ct-amy-mark");
      const m1 = cols[1].querySelector<HTMLElement>(".ct-amy-mark");
      expect(m0?.textContent).toBe("🧠");
      expect(m0?.dataset.amyId).toBe("a");
      expect(m1?.textContent).toBe("🧠2");
      expect(m1?.dataset.amyId).toBe("b");
      expect(m1?.dataset.amyIds).toBe("b c");
      expect(m1?.title).toBe("Amygdala acted here — click to show");
      // Above the icon row: the mark precedes the provider icon inside the bar area.
      expect(m1?.nextElementSibling?.classList.contains("ct-provider")).toBe(true);
      expect(marks(host)).toHaveLength(2);
    } finally {
      host.remove();
    }
  });

  it("prefers the column that lists the mark's tool call id over the time rule", async () => {
    const { host, ctrl } = mount({
      amyMarks: () => [{ id: "x", ts: 6_000, toolUseId: "tu1" }],
    });
    try {
      ctrl.pushCall("r", call("r", 1, 1_000, { tools: ["tu1"] }));
      ctrl.pushCall("r", call("r", 2, 5_000));
      await nextFrame();
      const cols = host.querySelectorAll(".ct-col");
      expect(cols[0].querySelector(".ct-amy-mark")).not.toBeNull();
      expect(cols[1].querySelector(".ct-amy-mark")).toBeNull();
    } finally {
      host.remove();
    }
  });

  it("hands a mark to the post-turn row whose span covers it, not to the previous turn's call", async () => {
    const { host, ctrl } = mount({
      amyMarks: () => [
        { id: "in-span", ts: 4_000, toolUseId: null },
        { id: "before-all", ts: 500, toolUseId: null },
      ],
    });
    try {
      ctrl.pushCall("r1", call("r1", 1, 1_000));
      // A reloaded session's column: stamped at the turn's END, carrying the turn's duration.
      ctrl.pushEvent(
        {
          roundNumber: 0,
          snapshot: "post-turn",
          timestampMs: 9_000,
          durationMs: 8_000,
          sessionKey: SK,
          contextSent: { systemPromptTokens: 400, totalTokens: 400 },
        },
        "r2",
      );
      await nextFrame();
      const cols = host.querySelectorAll(".ct-col");
      expect(cols).toHaveLength(2);
      expect(cols[0].querySelector(".ct-amy-mark")).toBeNull();
      expect(cols[1].querySelector<HTMLElement>(".ct-amy-mark")?.dataset.amyId).toBe("in-span");
      // A mark older than every column, covered by no span, is drawn nowhere.
      expect(marks(host)).toHaveLength(1);
    } finally {
      host.remove();
    }
  });

  it("never lands on another session's column (All mode holds other sessions' calls)", async () => {
    const { host, ctrl } = mount({
      amyMarks: () => [{ id: "m", ts: 3_000, toolUseId: null }],
    });
    try {
      ctrl.setFilterMode("all");
      ctrl.pushCall("o", call("o", 1, 1_000, { sessionKey: "agent:other:tinker:x" }));
      ctrl.pushCall("r", call("r", 1, 5_000));
      await nextFrame();
      expect(host.querySelectorAll(".ct-col")).toHaveLength(2);
      expect(marks(host)).toHaveLength(0);
    } finally {
      host.remove();
    }
  });
});

describe("timeline brains — click", () => {
  it("cycles a stacked mark's ids on re-click and never bubbles to the column", async () => {
    const onAmyMarkClick = vi.fn();
    const { host, ctrl } = mount({
      amyMarks: () => [
        { id: "b", ts: 6_000, toolUseId: null },
        { id: "c", ts: 6_500, toolUseId: null },
      ],
      onAmyMarkClick,
    });
    const leaked = vi.fn();
    host.addEventListener("click", leaked);
    try {
      ctrl.pushCall("r", call("r", 1, 5_000));
      await nextFrame();
      const mark = host.querySelector<HTMLElement>(".ct-amy-mark");
      expect(mark).not.toBeNull();
      mark?.click();
      mark?.click();
      mark?.click();
      expect(onAmyMarkClick.mock.calls.map((c) => c[0])).toEqual(["b", "c", "b"]);
      expect(leaked).not.toHaveBeenCalled();
    } finally {
      host.remove();
    }
  });
});

describe("timeline brains — refresh and style", () => {
  it("repaints on refresh() when the marks change, and injects the style tag once", async () => {
    const list: AmyMark[] = [];
    const a = mount({ amyMarks: () => list });
    const b = mount({ amyMarks: () => list });
    try {
      a.ctrl.pushCall("r", call("r", 1, 1_000));
      b.ctrl.pushCall("r", call("r", 1, 1_000));
      await nextFrame();
      expect(marks(a.host)).toHaveLength(0);
      list.push({ id: "late", ts: 2_000, toolUseId: null });
      a.ctrl.refresh();
      b.ctrl.refresh();
      await nextFrame();
      expect(marks(a.host)).toHaveLength(1);
      expect(marks(b.host)).toHaveLength(1);
      expect(document.querySelectorAll("#ct-amy-mark-style")).toHaveLength(1);
    } finally {
      a.host.remove();
      b.host.remove();
    }
  });
});
