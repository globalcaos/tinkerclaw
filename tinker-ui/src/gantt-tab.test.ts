import { describe, expect, it } from "vitest";
import {
  ganttBoardsByMaster,
  ganttTabHtml,
  ganttViewUrl,
  parseGanttBoards,
  type GanttBoard,
} from "./gantt-tab.js";
import type { TabChain } from "./tab-chains.js";

const match = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
const board: GanttBoard = { session: "agent:main:tinker:m1", plan: "/x/gantt.json", title: "SV2" };

describe("gantt tab — which master shows one", () => {
  const chains: TabChain[] = [{ master: "tab-m", slave: "tab-s", color: 1 }];

  it("shows the board on the master tab, matched by session key in either form", () => {
    const open: Record<string, string> = { "tab-m": "tinker:m1", "tab-s": "tinker:s1" };
    const map = ganttBoardsByMaster(chains, [board], (id) => open[id], match);
    expect([...map.keys()]).toEqual(["tab-m"]);
    expect(map.get("tab-m")?.title).toBe("SV2");
  });

  it("never shows it on the slave, even when the slave's session has a board", () => {
    const open: Record<string, string> = { "tab-m": "tinker:other", "tab-s": "tinker:m1" };
    expect(ganttBoardsByMaster(chains, [board], (id) => open[id], match).size).toBe(0);
  });

  it("disappears with the master: closed tab, released chain, or a dropped board", () => {
    const open: Record<string, string> = { "tab-s": "tinker:s1" };
    expect(ganttBoardsByMaster(chains, [board], (id) => open[id], match).size).toBe(0);
    expect(ganttBoardsByMaster([], [board], () => "tinker:m1", match).size).toBe(0);
    expect(ganttBoardsByMaster(chains, [], () => "tinker:m1", match).size).toBe(0);
  });
});

describe("gantt tab — board list from the server", () => {
  it("keeps well-formed boards and drops the rest without throwing", () => {
    expect(
      parseGanttBoards({
        boards: [
          board,
          { session: "", plan: "/y" },
          { session: "k" },
          null,
          "x",
          { session: "k2", plan: "/z" },
        ],
      }),
    ).toEqual([board, { session: "k2", plan: "/z", title: "" }]);
    expect(parseGanttBoards(null)).toEqual([]);
    expect(parseGanttBoards({ boards: "nope" })).toEqual([]);
  });
});

describe("gantt tab — markup", () => {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  it("is an icon-only tab with no data-tab-id, so drag, close and chain anchors ignore it", () => {
    const html = ganttTabHtml("tab-m", board, { active: false, color: "#d4a94a", escape });
    expect(html).toContain('data-gantt-for="tab-m"');
    expect(html).not.toContain("data-tab-id");
    expect(html).not.toContain("tab-close");
    expect(html).toContain("<svg");
    expect(html).not.toContain("tab-active");
    expect(html).toContain('data-hint="Gantt chart · SV2"');
  });

  it("marks itself active when its chart is on screen and escapes the title", () => {
    const html = ganttTabHtml(
      "tab-m",
      { ...board, title: 'a "b" <c>' },
      { active: true, color: "#fff", escape },
    );
    expect(html).toContain("tab-gantt tab-active");
    expect(html).toContain("a &quot;b&quot; &lt;c>");
  });

  it("loads the chart for the master's own session", () => {
    expect(ganttViewUrl("agent:main:tinker:m1")).toBe(
      "/api/gantt/view?session=agent%3Amain%3Atinker%3Am1",
    );
  });
});
