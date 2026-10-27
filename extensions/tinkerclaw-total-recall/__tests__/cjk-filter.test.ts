import { describe, expect, it } from "vitest";
import { dropCjkEntries } from "../index.js";

describe("dropCjkEntries (2026-10-10: no Chinese in the owner's chat)", () => {
  it("drops the entry carrying Chinese and keeps the others", () => {
    const pack =
      "## Retrieved Context\n[2026-10-10T05:39:31] [system_event] # Groups\nEnglish doc\n" +
      "[2026-10-10T05:39:31] [system_event] # 钩子\ntinkerclaw repo document: docs/zh-CN/hooks.md\n" +
      "[2026-10-09T20:09:35] [agent_message] wave 1 reported";
    const out = dropCjkEntries(pack);
    expect(out).not.toMatch(/钩子|zh-CN/);
    expect(out).toContain("# Groups");
    expect(out).toContain("wave 1 reported");
  });

  it("returns the pack untouched when it has no CJK", () => {
    const pack = "## Retrieved Context\n[2026-10-10T05:39:31] [system_event] plain ⟦AGENT⟧";
    expect(dropCjkEntries(pack)).toBe(pack);
  });

  it("returns empty when every entry was CJK", () => {
    expect(dropCjkEntries("## Retrieved Context\n[2026-10-10T05:39:31] [system_event] 插件")).toBe(
      "",
    );
  });
});
