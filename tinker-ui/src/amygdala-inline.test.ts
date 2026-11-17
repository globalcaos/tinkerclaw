// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  HOOK_BUBBLE_DECISIONS,
  hookActionFrom,
  hookAsk,
  renderHookBubble,
  renderJevBubble,
} from "./amygdala-inline.js";
import type { RuleRow } from "./amygdala-types.js";

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

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const RULE: RuleRow = {
  id: "DELETE_UNREQUESTED",
  explanation: "Deletes files or caches the owner did not explicitly ask to delete",
  says: "Nobody asked you to delete that.",
  ask: "Allow deleting {target}?",
  noun: "these files",
  file: "/repo/extensions/tinkerclaw-amygdala/src/rules.ts",
};

describe("renderHookBubble", () => {
  it("one line in the amygdala's voice and a caret; the command stays on its tool row (2026-11-03)", () => {
    const html = renderHookBubble(hookActionFrom({ ...live, target: "echo <b>&'\"" })!, {
      focused: false,
      rule: RULE,
    });
    expect(html).toContain('class="amy-inline"');
    expect(html).toContain('data-amy-bubble="hook-abc123def456"');
    expect(html).toContain('data-tool-use="toolu_01"');
    expect(html).toContain('<span class="amy-inline-icon">🧠</span>');
    const el = dom(html);
    expect(el.querySelector(".amy-jline")!.textContent).toBe("Nobody asked you to delete that.");
    expect(el.textContent).not.toContain("AMYGDALA");
    expect(el.textContent).not.toContain("echo");
    expect(el.querySelector(".amy-jx-rule")).toBeNull();
    const toggle = el.querySelector('[data-amy-act="amy-detail"]')!;
    expect(toggle.getAttribute("data-action")).toBe("hook-abc123def456");
  });

  it("opened, it names the rule and links the file that holds it, outside the toggle", () => {
    const el = dom(
      renderHookBubble(hookActionFrom(live)!, { focused: false, open: true, rule: RULE }),
    );
    const link = el.querySelector(".amy-jx-rule code.fs-link")!;
    expect(link.textContent).toBe(RULE.explanation);
    expect(link.getAttribute("data-path")).toBe(RULE.file);
    // A click on the link opens the file; it must not also fold the bubble.
    expect(link.closest("[data-amy-act]")).toBeNull();
  });

  it("without the feed's words it still says something plain, and names the rule id opened", () => {
    const el = dom(renderHookBubble(hookActionFrom(live)!, { focused: false, open: true }));
    expect(el.querySelector(".amy-jline")!.textContent).toBe("A fixed rule stopped that.");
    expect(el.querySelector(".amy-jx-rule")!.textContent).toBe("RuleDELETE_UNREQUESTED");
    expect(el.querySelector(".amy-jx-rule code")).toBeNull();
  });

  it("a step let through says so in the amygdala's voice; focus marks the bubble", () => {
    const line = (d: string): string =>
      dom(
        renderHookBubble(hookActionFrom({ ...live, decision: d })!, { focused: true }),
      ).querySelector(".amy-jline")!.textContent!;
    expect(line("owner-intent")).toBe("That was asked for. Go ahead.");
    expect(line("owner-pasted-secret")).toBe("That secret was pasted in on purpose. Keep it safe.");
    expect(line("owner-allow")).toBe("Allowed once. Go ahead.");
    expect(
      renderHookBubble(hookActionFrom({ ...live, decision: "owner-allow" })!, { focused: true }),
    ).toContain('class="amy-inline amy-focus"');
  });

  it("an unenforced deny says so, and a missing tool-use id is tolerated", () => {
    const html = renderHookBubble(hookActionFrom({ ...live, toolUseId: null, enforced: false })!, {
      focused: false,
      rule: RULE,
    });
    expect(html).toContain('data-tool-use=""');
    expect(dom(html).querySelector(".amy-jverdict")!.textContent).toBe("not enforced");
  });
});

describe("hookAsk", () => {
  it("puts the deleted path or the secret's name in the question, else the rule's noun", () => {
    expect(hookAsk(RULE, "rm -rf ~/src/x")).toBe("Allow deleting ~/src/x?");
    expect(hookAsk(RULE, "docker system prune -f")).toBe("Allow deleting these files?");
    const secret: RuleRow = {
      id: "SECRET_UNREQUESTED",
      explanation: "e",
      says: "s",
      ask: "Allow using {target}?",
      noun: "a stored password",
    };
    expect(hookAsk(secret, "set -a; source ./app/.env; set +a")).toBe("Allow using .env?");
    expect(hookAsk(secret, "true")).toBe("Allow using a stored password?");
    expect(hookAsk(undefined, "anything")).toBe("Allow this step?");
  });
});

describe("renderJevBubble", () => {
  const row =
    '<div class="amy-jact" data-turn="t1" data-action="k"><button data-amy-act="label">👍</button></div>';
  it("wraps the action row unchanged, under the brain and nothing else", () => {
    const html = renderJevBubble(row, { id: "jev-k", toolUseId: "toolu_01", focused: false });
    expect(html).toContain(row);
    expect(html).not.toContain("AMYGDALA");
    expect(html).toContain('data-amy-bubble="jev-k"');
    expect(html).toContain('data-tool-use="toolu_01"');
    const focused = renderJevBubble(row, { id: "jev-k", toolUseId: null, focused: true });
    expect(focused).toContain('class="amy-inline amy-focus"');
    expect(focused).toContain('data-tool-use=""');
  });

  it("escapes the id attribute", () => {
    expect(renderJevBubble(row, { id: 'a"b', toolUseId: null, focused: false })).toContain(
      'data-amy-bubble="a&quot;b"',
    );
  });
});
