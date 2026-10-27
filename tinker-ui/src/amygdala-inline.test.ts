// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  HOOK_BUBBLE_DECISIONS,
  hookActionFrom,
  renderHookBubble,
  renderJevBubble,
} from "./amygdala-inline.js";

const T0 = new Date(2026, 9, 15, 12, 27, 0).getTime();

const live = {
  id: "hook-abc123def456",
  ts: T0,
  tool: "Bash",
  target: "rm -rf ~/src/x",
  decision: "deny",
  rule: "DELETE_UNREQUESTED",
  toolUseId: "toolu_01",
  sessionId: "s1",
  enforced: true,
};

describe("hookActionFrom", () => {
  it("accepts a live amygdala.hook payload", () => {
    expect(hookActionFrom(live)).toEqual({
      id: "hook-abc123def456",
      ts: T0,
      tool: "Bash",
      target: "rm -rf ~/src/x",
      decision: "deny",
      rule: "DELETE_UNREQUESTED",
      toolUseId: "toolu_01",
      enforced: true,
    });
  });

  it("accepts a feed row with an ISO timestamp and the feed's mapped decision", () => {
    const iso = new Date(T0).toISOString();
    const a = hookActionFrom({
      ts: iso,
      tool: "Bash",
      target: "cat token",
      decision: "hard_block",
      mode: "hook",
      signal: "aegis",
      reason: "AEGIS [SECRET_UNREQUESTED]",
      toolUseId: "toolu_02",
    });
    expect(a).not.toBeNull();
    expect(a!.ts).toBe(T0);
    expect(a!.decision).toBe("deny");
    expect(a!.rule).toBe("SECRET_UNREQUESTED");
    expect(a!.id).toMatch(/^hook-[0-9a-f]{8}$/);
    // The same row read twice gets the same fallback id, so the store dedupes it.
    expect(
      hookActionFrom({
        ts: iso,
        tool: "Bash",
        decision: "hard_block",
        mode: "hook",
        reason: "AEGIS [SECRET_UNREQUESTED]",
        toolUseId: "toolu_02",
      })!.id,
    ).toBe(a!.id);
  });

  it("skips the decisions he skips, and junk", () => {
    expect(hookActionFrom({ ...live, decision: "allow" })).toBeNull();
    expect(hookActionFrom({ ...live, decision: "observe" })).toBeNull();
    expect(hookActionFrom({ ...live, decision: "soft_block", mode: "hook" })).toBeNull();
    expect(hookActionFrom({ ...live, ts: "not a date" })).toBeNull();
    expect(hookActionFrom({ ...live, tool: "" })).toBeNull();
    expect(hookActionFrom(null)).toBeNull();
    expect(hookActionFrom("deny")).toBeNull();
    // a hard_block that did not come from the hook is amygdala2's own word, not a hook row
    expect(hookActionFrom({ ...live, decision: "hard_block" })).toBeNull();
  });

  it("names the four bubble decisions", () => {
    expect([...HOOK_BUBBLE_DECISIONS].sort()).toEqual([
      "deny",
      "owner-allow",
      "owner-intent",
      "owner-pasted-secret",
    ]);
    for (const d of HOOK_BUBBLE_DECISIONS)
      expect(hookActionFrom({ ...live, decision: d })?.decision).toBe(d);
  });
});

describe("renderHookBubble", () => {
  it("draws the pink shell with the verb, the rule and the escaped target", () => {
    const html = renderHookBubble(hookActionFrom({ ...live, target: "echo <b>&'\"" })!, {
      focused: false,
    });
    expect(html).toContain('class="amy-inline"');
    expect(html).toContain('data-amy-bubble="hook-abc123def456"');
    expect(html).toContain('data-tool-use="toolu_01"');
    expect(html).toContain('<span class="amy-inline-icon">🧠</span>');
    expect(html).toContain("<strong>AMYGDALA</strong> <em>blocked · DELETE_UNREQUESTED</em>");
    expect(html).toContain("Bash echo &lt;b&gt;&amp;&#39;&quot;");
    expect(html).not.toContain("<b>&");
    expect(html).toContain("12:27");
  });

  it("uses the owner verbs and marks focus", () => {
    const words = (d: string) =>
      renderHookBubble(hookActionFrom({ ...live, decision: d })!, { focused: true });
    expect(words("owner-intent")).toContain("<em>let through on your words</em>");
    expect(words("owner-pasted-secret")).toContain("<em>stored the secret you pasted</em>");
    expect(words("owner-allow")).toContain("<em>let through on your allow code</em>");
    expect(words("owner-allow")).toContain('class="amy-inline amy-focus"');
  });

  it("clips the tool+target line to 160 chars and tolerates a missing tool-use id", () => {
    const a = hookActionFrom({ ...live, toolUseId: null, target: "x".repeat(400) })!;
    const html = renderHookBubble(a, { focused: false });
    expect(html).toContain('data-tool-use=""');
    const line = /<div class="amy-inline-line">([^<]*)</.exec(html)![1];
    expect(line.length).toBe(160);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("renderJevBubble", () => {
  const row =
    '<div class="amy-jact" data-turn="t1" data-action="k"><button data-amy-act="label">👍</button></div>';
  it("wraps the action row unchanged, worded would / acted", () => {
    const would = renderJevBubble(row, {
      id: "jev-k",
      toolUseId: "toolu_01",
      focused: false,
      would: true,
    });
    expect(would).toContain(row);
    expect(would).toContain("<strong>AMYGDALA</strong> <em>would have</em>");
    expect(would).toContain('data-amy-bubble="jev-k"');
    expect(would).toContain('data-tool-use="toolu_01"');
    const acted = renderJevBubble(row, {
      id: "jev-k",
      toolUseId: null,
      focused: true,
      would: false,
    });
    expect(acted).toContain("<em>acted</em>");
    expect(acted).toContain('class="amy-inline amy-focus"');
    expect(acted).toContain('data-tool-use=""');
  });

  it("escapes the id attribute", () => {
    expect(
      renderJevBubble(row, { id: 'a"b', toolUseId: null, focused: false, would: true }),
    ).toContain('data-amy-bubble="a&quot;b"');
  });
});
