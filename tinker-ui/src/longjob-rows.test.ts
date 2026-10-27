// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  INDICATOR_MAX_DEPTH,
  type IndicatorLayer,
  type LongjobJob,
  longjobDuration,
  longjobLayers,
  longjobWakeHeadline,
  processProgressText,
  renderLongjobRows,
  stackIndicatorLayers,
} from "./longjob-rows.js";

const NOW = 1_800_000_000_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const deps = {
  esc: (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    ),
  modelIcon: (model: string, provider: string) =>
    `<span class="model-provider-icon" data-icon="${provider}:${model}"></span>`,
  modelLabel: (model: string) => (model === "claude-opus-5-5" ? "Opus 5.5" : model),
  dotColor: (model: string) => (model.includes("opus") ? "#D97757" : "#10a37f"),
  phaseMs: -700,
};

function rows(jobs: LongjobJob[]): HTMLElement[] {
  const host = document.createElement("div");
  host.innerHTML = renderLongjobRows(jobs, NOW, deps);
  return [...host.querySelectorAll<HTMLElement>(".thinking-run")];
}

const running = {
  status: "running",
  startedAt: NOW - 125_000,
  updatedAt: NOW - 2_000,
  intervalMs: 5000,
};

describe("long-job rows: the thinking row's markup", () => {
  it("draws three dots, the name and the elapsed clock, and no Stop", () => {
    const [row] = rows([{ id: "dl", kind: "process", label: "Pi image", ...running }]);
    expect(row.classList.contains("job-run")).toBe(true);
    expect(row.querySelectorAll(".thinking-dots span")).toHaveLength(3);
    expect(row.querySelector(".thinking-dots")?.getAttribute("style")).toContain(
      "--thinking-phase:-700ms",
    );
    expect(row.querySelector(".thinking-model")?.textContent).toContain("⚙ Pi image");
    expect(row.querySelector(".thinking-elapsed")?.textContent).toBe("2m05s");
    expect(row.getAttribute("data-started-at")).toBe(String(NOW - 125_000));
    expect(row.querySelector(".thinking-stop")).toBeNull();
  });

  it("carries only the dot colour: no glow variables, so it paints no background", () => {
    const [row] = rows([{ id: "dl", kind: "process", label: "x", ...running }]);
    const style = row.getAttribute("style") ?? "";
    expect(style).toContain("--thinking-dot-color:");
    expect(style).not.toContain("--thinking-glow");
  });

  it("draws nothing for a finished, failed or stopped job", () => {
    expect(
      renderLongjobRows(
        [
          { id: "a", ...running, status: "done" },
          { id: "b", ...running, status: "failed" },
          { id: "c", ...running, status: "stopped" },
        ],
        NOW,
        deps,
      ),
    ).toBe("");
  });

  it("escapes the label", () => {
    const [row] = rows([{ id: "x", kind: "process", label: "<b>evil</b>", ...running }]);
    expect(row.querySelector("b")).toBeNull();
    expect(row.textContent).toContain("<b>evil</b>");
  });
});

describe("long-job rows: process jobs", () => {
  it("reads bytes as GB with rate and ETA, and draws the percentage line", () => {
    const job: LongjobJob = {
      id: "dl",
      kind: "process",
      label: "Pi image",
      unit: "bytes",
      current: 2.6 * GB,
      total: 4.2 * GB,
      rate: 18 * MB,
      etaSeconds: 90,
      ...running,
    };
    expect(processProgressText(job)).toBe("2.6 / 4.2 GB · 18 MB/s · ETA 1m30s");
    const [row] = rows([job]);
    expect(row.querySelector(".thinking-model")?.textContent).toContain(
      "⚙ Pi image · 2.6 / 4.2 GB · 18 MB/s · ETA 1m30s",
    );
    const fill = row.querySelector<HTMLElement>(".job-run-line .job-run-fill");
    expect(fill?.style.width).toBe("61.9%");
  });

  it("counts other units as they are", () => {
    expect(
      processProgressText({
        id: "s",
        current: 120,
        total: 400,
        unit: "files",
        rate: 3,
        etaSeconds: 720,
      }),
    ).toBe("120 / 400 files · 3 files/s · ETA 12m");
  });

  it("with no total: dots only, no line and no invented percentage", () => {
    const [row] = rows([
      { id: "rs", kind: "process", label: "rsync", unit: "bytes", current: 3 * GB, ...running },
    ]);
    expect(row.querySelector(".job-run-line")).toBeNull();
    expect(row.textContent).not.toContain("%");
    expect(row.querySelector(".thinking-model")?.textContent).toContain("3.0 GB");
  });

  it("a job with no kind is a process job (state written before kinds existed)", () => {
    const [row] = rows([{ id: "old", label: "old", ...running }]);
    expect(row.getAttribute("data-job-kind")).toBe("process");
  });
});

describe("long-job rows: background tasks (the architect 2026-10-25 02:43)", () => {
  // As ccBridge.backgroundTasks lists them: no progress, no updatedAt, never a percentage.
  const bg = (over: Partial<LongjobJob> = {}): LongjobJob => ({
    id: "b1x",
    label: "pnpm test extensions",
    kind: "background",
    session: "agent:main:tinker:abc",
    status: "running",
    startedAt: NOW - 95_000,
    ...over,
  });

  it("draws a process-style row: gear, the task's description, the elapsed time, nothing else", () => {
    const [row] = rows([bg()]);
    expect(row.getAttribute("data-job-kind")).toBe("background");
    expect(row.querySelector(".thinking-model")?.textContent).toBe("⚙ pnpm test extensions");
    expect(row.querySelector(".thinking-elapsed")?.textContent).toBe("1m35s");
    expect(row.querySelector(".job-run-line")).toBeNull();
    expect(row.classList.contains("job-run-stalled")).toBe(false);
    expect(row.getAttribute("style")).toContain("--thinking-dot-color:#c9a86a");
  });

  it("never claims progress, even if a reading slipped into the record", () => {
    const [row] = rows([bg({ current: 5, total: 10, pct: 50, updatedAt: NOW - 3_600_000 })]);
    expect(row.querySelector(".thinking-model")?.textContent).toBe("⚙ pnpm test extensions");
    expect(row.querySelector(".job-run-line")).toBeNull();
    expect(row.classList.contains("job-run-stalled")).toBe(false);
  });

  it("stacks by age with the long jobs, the older one at the bottom", () => {
    const layers = longjobLayers(
      [bg({ startedAt: NOW - 10_000 }), { id: "dl", kind: "process", label: "dl", ...running }],
      NOW,
      deps,
    );
    const host = document.createElement("div");
    host.innerHTML = stackIndicatorLayers(layers);
    const wrapper = host.querySelector(".thinking-layer");
    expect(wrapper?.querySelector('[data-job-kind="background"]')).not.toBeNull();
    // The older long job sits bare, outside (below) the wrapper.
    expect(host.querySelector(':scope > [data-job-id="dl"]')).not.toBeNull();
  });
});

describe("long-job rows: agent jobs", () => {
  const agentsJob: LongjobJob = {
    id: "wf",
    kind: "agents",
    label: "Papers review",
    total: 6,
    ...running,
    agents: [
      { label: "J1", model: "claude-opus-5-5", effort: "max", status: "done" },
      { label: "J2", model: "claude-opus-5-5", effort: "max", status: "running" },
      { label: "J3", model: "claude-opus-5-5", effort: "max", status: "running" },
      { label: "critic", model: "openai-codex/gpt-6-sol", status: "running" },
      { label: "old", model: "claude-sonnet-5-5", status: "done" },
    ],
  };

  it("draws one row per model that still has a running agent, in that model's colour", () => {
    const list = rows([agentsJob]);
    expect(list.map((r) => r.getAttribute("data-job-model"))).toEqual([
      "claude-opus-5-5",
      "openai-codex/gpt-6-sol",
    ]);
    const [opus, gpt] = list;
    expect(opus.getAttribute("style")).toContain("--thinking-dot-color:#D97757");
    expect(gpt.getAttribute("style")).toContain("--thinking-dot-color:#10a37f");
    expect(opus.querySelector(".thinking-model")?.textContent).toContain(
      "Opus 5.5 max · Papers review · 1/3 done",
    );
    expect(opus.querySelector(".model-provider-icon")?.getAttribute("data-icon")).toBe(
      "anthropic:claude-opus-5-5",
    );
    expect(gpt.querySelector(".model-provider-icon")?.getAttribute("data-icon")).toBe(
      "openai-codex:openai-codex/gpt-6-sol",
    );
    expect(gpt.querySelector(".thinking-model")?.textContent).toContain("Papers review · 0/1 done");
    expect(opus.querySelector(".job-run-line")).toBeNull();
  });

  it("names no effort when that model's agents disagree on it", () => {
    const [row] = rows([
      {
        ...agentsJob,
        agents: [
          { model: "claude-opus-5-5", effort: "max", status: "running" },
          { model: "claude-opus-5-5", effort: "high", status: "running" },
        ],
      },
    ]);
    expect(row.querySelector(".thinking-model")?.textContent).toContain("Opus 5.5 · Papers review");
  });

  it("between stages it keeps one neutral row with the overall count", () => {
    const list = rows([{ ...agentsJob, agents: [{ model: "claude-opus-5-5", status: "done" }] }]);
    expect(list).toHaveLength(1);
    expect(list[0].querySelector(".thinking-model")?.textContent).toContain(
      "⏳ Papers review · 1/6 done",
    );
  });
});

describe("long-job rows: stalled", () => {
  it("a frozen reading turns the row amber with how long", () => {
    const [row] = rows([
      { id: "s", kind: "process", label: "scan", ...running, stalledSince: NOW - 12 * 60_000 },
    ]);
    expect(row.classList.contains("job-run-stalled")).toBe(true);
    expect(row.querySelector(".thinking-model")?.textContent).toContain("no progress for 12m");
  });

  it("a worker that stopped writing is flagged too", () => {
    const [row] = rows([
      { id: "s", kind: "process", label: "scan", ...running, updatedAt: NOW - 4 * 60_000 },
    ]);
    expect(row.classList.contains("job-run-stalled")).toBe(true);
    expect(row.textContent).toContain("no update for 4m00s");
  });

  it("a fresh reading is not stalled", () => {
    const [row] = rows([{ id: "s", kind: "process", label: "scan", ...running }]);
    expect(row.classList.contains("job-run-stalled")).toBe(false);
  });
});

describe("long-job rows: helpers", () => {
  it("formats durations the way the rows print them", () => {
    expect(longjobDuration(45)).toBe("45s");
    expect(longjobDuration(90)).toBe("1m30s");
    expect(longjobDuration(720)).toBe("12m");
    expect(longjobDuration(4380)).toBe("1h13m");
  });

  it("cuts the wake to its status sentence", () => {
    expect(
      longjobWakeHeadline(
        "✅ Build — finished in 4m12s · last output: done — read /home/u/.openclaw/canvas/documents/lj-b/done.json",
      ),
    ).toBe("✅ Build — finished in 4m12s");
    expect(
      longjobWakeHeadline("Resume the review. · ❌ Build — exit 1 after 2m · last output: boom"),
    ).toBe("❌ Build — exit 1 after 2m");
    expect(
      longjobWakeHeadline(
        '⚠ scan — no progress for 31 min (reading "4 9"). The job is still running.',
      ),
    ).toBe("⚠ scan — no progress for 31 min");
    expect(longjobWakeHeadline("Fallback: if the end of x has not been handled yet, read y")).toBe(
      "",
    );
  });
});

describe("long-job rows: the stack, by age (the architect 2026-10-25 00:48)", () => {
  const row = (id: string) => `<div class="thinking-run" data-id="${id}"></div>`;
  const layer = (id: string, startedAt: number): IndicatorLayer => ({ startedAt, html: row(id) });

  /** Each row's id and depth (how many `.thinking-layer` wrappers hold it), top to bottom. */
  function stack(layers: IndicatorLayer[]): Array<[string, number]> {
    const host = document.createElement("div");
    host.innerHTML = `<div class="thinking-indicator">${stackIndicatorLayers(layers)}</div>`;
    return [...host.querySelectorAll<HTMLElement>(".thinking-run")].map((el) => {
      let depth = 0;
      for (let p = el.parentElement; p && !p.classList.contains("thinking-indicator"); ) {
        if (p.classList.contains("thinking-layer")) {
          depth++;
        }
        p = p.parentElement;
      }
      return [el.getAttribute("data-id") ?? el.getAttribute("data-job-id") ?? "", depth];
    });
  }

  it("one layer alone is bare: no wrapper, the row exactly as before", () => {
    expect(stackIndicatorLayers([layer("thinking", NOW)])).toBe(row("thinking"));
  });

  it("a thinking row that started after a job sits above it, one step in", () => {
    expect(stack([layer("thinking", NOW - 10_000), layer("job", NOW - 60_000)])).toEqual([
      ["thinking", 1],
      ["job", 0],
    ]);
  });

  it("a turn still thinking when its job started sits below that job", () => {
    expect(stack([layer("thinking", NOW - 90_000), layer("job", NOW - 60_000)])).toEqual([
      ["job", 1],
      ["thinking", 0],
    ]);
  });

  it("job, then a prompt that starts its own job, then a later prompt: three steps", () => {
    expect(
      stack([
        layer("thinking", NOW - 5_000),
        layer("job1", NOW - 600_000),
        layer("job2", NOW - 120_000),
      ]),
    ).toEqual([
      ["thinking", 2],
      ["job2", 1],
      ["job1", 0],
    ]);
  });

  it("each step is a wrapper with the deeper layers first, then its own rows", () => {
    expect(stackIndicatorLayers([layer("a", 1), layer("b", 2), layer("c", 3)])).toBe(
      `<div class="thinking-layer" data-depth="1"><div class="thinking-layer" data-depth="2">${row("c")}</div>${row("b")}</div>${row("a")}`,
    );
  });

  it(`past ${INDICATOR_MAX_DEPTH} steps the depth stops growing, newest still on top`, () => {
    const layers = Array.from({ length: 7 }, (_, i) => layer(`L${i}`, NOW - (7 - i) * 1000));
    expect(stack(layers)).toEqual([
      ["L6", 4],
      ["L5", 4],
      ["L4", 4],
      ["L3", 3],
      ["L2", 2],
      ["L1", 1],
      ["L0", 0],
    ]);
  });

  it("equal start times keep the order they were given (oldest first)", () => {
    expect(stack([layer("first", 5), layer("second", 5)])).toEqual([
      ["second", 1],
      ["first", 0],
    ]);
  });

  it("an agents job's rows stay together as ONE layer, at its job's start", () => {
    const layers = longjobLayers(
      [
        {
          id: "wf",
          kind: "agents",
          label: "Review",
          ...running,
          agents: [
            { model: "claude-opus-5-5", status: "running" },
            { model: "openai-codex/gpt-6-sol", status: "running" },
          ],
        },
        { id: "dl", kind: "process", label: "dl", ...running, startedAt: NOW - 30_000 },
      ],
      NOW,
      deps,
    );
    expect(layers.map((l) => l.startedAt)).toEqual([NOW - 125_000, NOW - 30_000]);
    const host = document.createElement("div");
    host.innerHTML = stackIndicatorLayers(layers);
    // The download is newer: one step in, on top. Both model rows of the review sit at the bottom.
    const top = host.querySelector(".thinking-layer > .thinking-run");
    expect(top?.getAttribute("data-job-id")).toBe("dl");
    const bare = [...host.children].filter((el) => el.classList.contains("thinking-run"));
    expect(bare.map((el) => el.getAttribute("data-job-model"))).toEqual([
      "claude-opus-5-5",
      "openai-codex/gpt-6-sol",
    ]);
  });

  it("no background or glow on the wrappers: a class and a depth, nothing inline", () => {
    const html = stackIndicatorLayers([layer("a", 1), layer("b", 2)]);
    expect(html).toContain('<div class="thinking-layer" data-depth="1">');
    expect(html).not.toMatch(/thinking-layer[^>]*style=/);
  });
});
