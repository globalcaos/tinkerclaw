import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import {
  formatMemoryIndexShapeLines,
  inspectMemoryIndex,
  noteMemoryIndexShape,
} from "./doctor-memory-index.js";

const INDEX_PATH = "/tmp/workspace/MEMORY.md";
const existing = new Set(["/tmp/workspace/memory/people.md", "/tmp/workspace/memory/house.md"]);
const pointerExists = (absolutePath: string) => existing.has(absolutePath);

describe("inspectMemoryIndex", () => {
  it("passes a small index whose pointers all resolve", () => {
    const shape = inspectMemoryIndex({
      content: [
        "# Memory index",
        "",
        "- [People](memory/people.md) — who is who, allergies, birthdays",
        "- [House](./memory/house.md#plumbing) — repairs, invoices",
        "- [Docs](https://docs.openclaw.ai/concepts/memory) — how memory works",
      ].join("\n"),
      filePath: INDEX_PATH,
      maxChars: 8_000,
      pointerExists,
    });
    expect(shape).toMatchObject({ entries: 3, overBudget: false });
    expect(shape.longLines).toEqual([]);
    expect(shape.missingPointers).toEqual([]);
    expect(formatMemoryIndexShapeLines(shape)).toEqual([]);
  });

  it("flags size, prose lines and dead pointers, ignoring fenced code", () => {
    const shape = inspectMemoryIndex({
      content: [
        "- [People](memory/people.md) — who is who",
        `- [Taxes](memory/taxes.md) — ${"detail ".repeat(40)}`,
        "```",
        `[not a pointer](memory/inside-a-fence.md) ${"x".repeat(300)}`,
        "```",
        "x".repeat(9_000),
      ].join("\n"),
      filePath: INDEX_PATH,
      maxChars: 8_000,
      pointerExists,
    });
    expect(shape.overBudget).toBe(true);
    expect(shape.longLines.map((entry) => entry.line)).toEqual([2, 6]);
    expect(shape.missingPointers).toEqual([{ line: 2, target: "memory/taxes.md" }]);
    const text = formatMemoryIndexShapeLines(shape).join("\n");
    expect(text).toContain("Over budget by");
    expect(text).toContain("2 line(s) over 200 chars (line 2, 6)");
    expect(text).toContain("line 2 → memory/taxes.md");
  });
});

describe("noteMemoryIndexShape", () => {
  beforeEach(() => {
    note.mockClear();
  });

  const bootstrapFiles = [
    {
      name: "MEMORY.md" as const,
      path: INDEX_PATH,
      content: "- [Gone](memory/gone.md) — a topic file that was deleted",
      missing: false,
    },
  ];

  it("notes a dead pointer under the Memory index title", () => {
    noteMemoryIndexShape({ cfg: {} as OpenClawConfig, bootstrapFiles, pointerExists });
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(title).toBe("Memory index");
    expect(String(message)).toContain("memory/gone.md");
  });

  it("stays silent when the check is off or there is no MEMORY.md", () => {
    noteMemoryIndexShape({
      cfg: { agents: { defaults: { memoryIndexWarning: "off" } } } as OpenClawConfig,
      bootstrapFiles,
      pointerExists,
    });
    noteMemoryIndexShape({ cfg: {} as OpenClawConfig, bootstrapFiles: [], pointerExists });
    expect(note).not.toHaveBeenCalled();
  });
});
