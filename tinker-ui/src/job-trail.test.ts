import { describe, expect, it, vi } from "vitest";
import {
  createJobTrailUi,
  mergeTrail,
  newJobTrail,
  renderJobTrail,
  trailCursor,
  trailIsLive,
  trailTid,
  type JobTrailDeps,
  type TrailWire,
} from "./job-trail.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function deps(expanded: Set<string> = new Set()): JobTrailDeps {
  return {
    esc,
    md: (s) => `<p>${esc(s)}</p>`,
    toolSummary: (name, input) => `${name} ${JSON.stringify(input)}`,
    toolDetail: (name) => `<div class="detail-of">${name}</div>`,
    isExpanded: (tid) => expanded.has(tid),
    modelIcon: (m) => `<i data-icon="${m}"></i>`,
    modelLabel: (m) => (m === "claude-opus-5-5" ? "Opus 5.5" : m),
    dotColor: () => "#abc",
    clock: (ms) => `T${ms}`,
  };
}

const T = 1_000_000;
/** What a chapter-weave run looked like: a prompt, then thinking blocks with no text (claude -p text mode). */
function weaveWire(): TrailWire {
  return {
    id: "ch01-weave",
    label: "Chapter 1 <weave>",
    session: "agent:main:tinker:abc",
    status: "running",
    startedAt: T,
    endedAt: null,
    agents: [
      {
        key: "9c65f49a",
        kind: "claude",
        label: "run1-6b",
        startedAt: T,
        running: true,
        next: 5000,
        entries: [
          { t: "prompt", text: "Read the brief and do all of it.", ts: T },
          { t: "req", ts: T + 1000 },
          { t: "thinking", text: "", ts: T + 30_000, model: "claude-opus-5-5" },
          { t: "text", text: "Reading the brief.", ts: T + 30_000, model: "claude-opus-5-5" },
          {
            t: "tool",
            id: "tu1",
            name: "Bash",
            input: { command: "cat brief.md" },
            ts: T + 31_000,
            model: "claude-opus-5-5",
          },
          { t: "result", id: "tu1", content: "# Brief", isError: false, ts: T + 32_000 },
          { t: "req", ts: T + 33_000 },
        ],
      },
    ],
  };
}

describe("mergeTrail", () => {
  it("appends each agent's entries after its cursor and reports a change only when there is one", () => {
    const t = newJobTrail({ id: "j", session: "s" });
    expect(trailIsLive(t)).toBe(true);
    expect(mergeTrail(t, weaveWire())).toBe(true);
    expect(t.status).toBe("running");
    expect(t.agents[0].entries).toHaveLength(7);
    expect(t.agents[0].openByDefault).toBe(true);
    expect(trailCursor(t)).toBe("9c65f49a:5000");
    expect(
      mergeTrail(t, {
        ...weaveWire(),
        agents: [{ key: "9c65f49a", running: true, next: 5000, entries: [] }],
      }),
    ).toBe(false);
    mergeTrail(t, {
      ...weaveWire(),
      agents: [
        {
          key: "9c65f49a",
          running: true,
          next: 6000,
          entries: [{ t: "text", text: "more", ts: T + 40_000 }],
        },
      ],
    });
    expect(t.agents[0].entries).toHaveLength(8);
    expect(trailCursor(t)).toBe("9c65f49a:6000");
  });

  it("starts an agent over when the server says its file was reset, and records the end", () => {
    const t = newJobTrail({ id: "j" });
    mergeTrail(t, weaveWire());
    mergeTrail(t, {
      status: "ok",
      endedAt: T + 90_000,
      agents: [
        {
          key: "9c65f49a",
          running: false,
          reset: true,
          next: 10,
          entries: [{ t: "text", text: "x" }],
        },
      ],
    });
    expect(t.agents[0].entries).toEqual([{ t: "text", text: "x" }]);
    expect(t.agents[0].running).toBe(false);
    expect(t.status).toBe("ok");
    expect(t.endedAt).toBe(T + 90_000);
    expect(trailIsLive(t)).toBe(false);
  });
});

describe("renderJobTrail", () => {
  it("draws the work like a turn: task, thought time, narration, tool rows, and what it does now", () => {
    const t = newJobTrail({ id: "ch01-weave" });
    mergeTrail(t, weaveWire());
    const h = renderJobTrail(t, deps());
    expect(h).toContain('data-job-trail="ch01-weave"');
    expect(h).toContain("Chapter 1 &lt;weave&gt;");
    expect(h).not.toContain("<weave>");
    expect(h).toContain("Opus 5.5");
    expect(h).toContain("1 tool call");
    expect(h).toContain("started without keeping its thinking");
    expect(h).toContain("thought for 29 s");
    expect(h).toContain(
      '<div class="msg assistant job-trail-text"><p>Reading the brief.</p></div>',
    );
    const tid = trailTid("ch01-weave", "9c65f49a", "tu1");
    expect(h).toContain(`<div class="tool-row" data-tid="${tid}"><span class="status ok">✓</span>`);
    expect(h).not.toContain("# Brief"); // closed row: no result
    expect(h).toContain('class="job-trail-live"');
    expect(h).toContain(`thinking &middot; since T${T + 33_000}`);
  });

  it("opens a tool row the owner clicked, with its result, and shows thinking text when it was kept", () => {
    const t = newJobTrail({ id: "j" });
    const wire = weaveWire();
    wire.agents![0].entries![2] = { t: "thinking", text: "Weighing the notes.", ts: T + 30_000 };
    mergeTrail(t, wire);
    const h = renderJobTrail(t, deps(new Set([trailTid("j", "9c65f49a", "tu1")])));
    expect(h).toContain('<div class="detail-of">Bash</div>');
    expect(h).toContain("# Brief");
    expect(h).toContain('<span class="thinking-label">Thinking:</span> <p>Weighing the notes.</p>');
    expect(h).not.toContain("started without keeping its thinking");
  });

  it("names the tool it is waiting on, and draws no live line once the agent is done", () => {
    const t = newJobTrail({ id: "j" });
    const wire = weaveWire();
    wire.agents![0].entries!.push({
      t: "tool",
      id: "tu2",
      name: "Bash",
      input: { command: "make pdf" },
      ts: T + 50_000,
    });
    mergeTrail(t, wire);
    expect(renderJobTrail(t, deps())).toContain(
      "running Bash {&quot;command&quot;:&quot;make pdf&quot;}",
    );
    mergeTrail(t, {
      status: "ok",
      endedAt: T + 60_000,
      agents: [{ key: "9c65f49a", running: false }],
    });
    const h = renderJobTrail(t, deps());
    expect(h).not.toContain("job-trail-live");
    expect(h).toContain(`finished T${T + 60_000}`);
  });

  it("gives each agent of a fan-out its own section, open while it ran at first sight", () => {
    const t = newJobTrail({ id: "fan" });
    mergeTrail(t, {
      status: "running",
      agents: [
        {
          key: "a1",
          label: "hunt:one",
          running: false,
          startedAt: 1,
          entries: [{ t: "text", text: "one done" }],
        },
        {
          key: "a2",
          label: "hunt:two",
          running: true,
          startedAt: 2,
          entries: [{ t: "text", text: "two working" }],
        },
      ],
    });
    const h = renderJobTrail(t, deps());
    expect(h).toContain("2 agents");
    expect(h).toContain(`data-tid="${trailTid("fan", "a1")}"`);
    expect(h).not.toContain("one done");
    expect(h).toContain("two working");
    // A click flips each section from its default.
    const flipped = renderJobTrail(
      t,
      deps(new Set([trailTid("fan", "a1"), trailTid("fan", "a2")])),
    );
    expect(flipped).toContain("one done");
    expect(flipped).not.toContain("two working");
  });

  it("shows the job's own output when no agent works in it", () => {
    const t = newJobTrail({ id: "dl" });
    mergeTrail(t, { status: "running", agents: [], log: "50% <done>\n" });
    const h = renderJobTrail(t, deps());
    expect(h).toContain("No agent's work was found for this job");
    expect(h).toContain('<pre class="job-trail-log">50% &lt;done&gt;</pre>');
  });
});

describe("createJobTrailUi", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("opens a trail from the start, polls from its cursor, and closes it", async () => {
    const calls: Array<[string, string]> = [];
    const repaint = vi.fn();
    const ui = createJobTrailUi({
      ...deps(),
      fetchTrail: async (id, cursor) => {
        calls.push([id, cursor]);
        return weaveWire();
      },
      repaint,
      storage: null,
    });
    expect(ui.toggle({ id: "ch01-weave", session: "agent:main:tinker:abc" })).toBe(true);
    expect(ui.isOpen("ch01-weave")).toBe(true);
    await flush();
    expect(calls).toEqual([["ch01-weave", ""]]);
    expect(repaint).toHaveBeenCalledTimes(1);
    ui.poll();
    await flush();
    expect(calls[1]).toEqual(["ch01-weave", "9c65f49a:5000"]);
    expect(ui.trailsFor((s) => s === "agent:main:tinker:abc")).toHaveLength(1);
    expect(ui.trailsFor((s) => s === "other")).toHaveLength(0);
    expect(ui.toggle({ id: "ch01-weave" })).toBe(false);
    expect(ui.isOpen("ch01-weave")).toBe(false);
  });

  it("stops polling a finished job, and drops a trail whose job is gone", async () => {
    let answer: TrailWire | Error = { status: "ok", endedAt: 5, agents: [] };
    let n = 0;
    const ui = createJobTrailUi({
      ...deps(),
      fetchTrail: async () => {
        n++;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      repaint: () => {},
      storage: null,
    });
    ui.toggle({ id: "done-job", session: "s" });
    await flush();
    ui.poll();
    await flush();
    expect(n).toBe(1);
    answer = new Error("HTTP 404 no such job");
    ui.toggle({ id: "gone-job", session: "s" });
    await flush();
    expect(ui.isOpen("gone-job")).toBe(false);
    expect(ui.isOpen("done-job")).toBe(true);
  });

  it("reads a long transcript's backlog at once, and waits when a read makes no progress", async () => {
    const cursors: string[] = [];
    const answers: TrailWire[] = [
      {
        status: "running",
        agents: [{ key: "k", running: true, next: 100, size: 300, entries: [] }],
      },
      {
        status: "running",
        agents: [{ key: "k", running: true, next: 250, size: 300, entries: [] }],
      },
      // A line still being written: no progress, so no immediate re-read.
      {
        status: "running",
        agents: [{ key: "k", running: true, next: 250, size: 300, entries: [] }],
      },
    ];
    const ui = createJobTrailUi({
      ...deps(),
      fetchTrail: async (_id, cursor) => {
        cursors.push(cursor);
        return answers[Math.min(cursors.length - 1, answers.length - 1)];
      },
      repaint: () => {},
      storage: null,
    });
    ui.toggle({ id: "long", session: "s" });
    for (let i = 0; i < 6; i++) {
      await flush();
    }
    expect(cursors).toEqual(["", "k:100", "k:250"]);
  });

  it("keeps the open trails across a reload", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const make = () =>
      createJobTrailUi({
        ...deps(),
        fetchTrail: async () => weaveWire(),
        repaint: () => {},
        storage,
      });
    make().toggle({ id: "j1", label: "Job one", session: "s" });
    const again = make();
    expect(again.isOpen("j1")).toBe(true);
    expect(again.trailsFor(() => true)[0].label).toBe("Job one");
  });
});
