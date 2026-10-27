import { describe, expect, it } from "vitest";
import {
  fractalChangedLabel,
  fractalCardFoldKey,
  fractalCardHtml,
  fractalCheckChanges,
  fractalCheckFromRow,
  reflectionTextFromHistory,
  type FractalCard,
} from "./fractal-card.js";

const deps = {
  md: (t: string) => `<p>${t}</p>`,
  esc: (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  foldAttrs: (key: string) => ` data-fold-key="${key}"`,
  fmtDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
};

const card = (over: Partial<FractalCard>): FractalCard => ({
  parentRunId: "run-1",
  sideKey: "agent:main:fractal:run-1",
  status: "saved",
  ...over,
});

describe("fractalCardHtml", () => {
  it("is a folded 🌿 card keyed to its prompt run, never open on its own", () => {
    const html = fractalCardHtml(card({ status: "running" }), deps);
    expect(html).toContain('class="fractal-details fractal-card fractal-card-running"');
    expect(html).toContain('data-fractal-card="run-1"');
    expect(html).toContain(`data-fold-key="${fractalCardFoldKey("run-1")}"`);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("🌿 Fractal · reflecting in the background…");
  });

  it("names how long a finished reflection took and renders its text", () => {
    const html = fractalCardHtml(
      card({ status: "done", text: "**fixed** the skill", startedAt: 1_000, endedAt: 43_000 }),
      deps,
    );
    expect(html).toContain("🌿 Fractal · done · 42s");
    expect(html).toContain("<p>**fixed** the skill</p>");
  });

  it("says why it failed, and escapes what the server sent", () => {
    const html = fractalCardHtml(card({ status: "failed", error: "<quota>" }), deps);
    expect(html).toContain("🌿 Fractal · failed: &lt;quota>");
  });

  it("offers to load a reflection the page did not watch", () => {
    expect(fractalCardHtml(card({}), deps)).toContain("Open to load the reflection.");
    expect(fractalCardHtml(card({ loading: true }), deps)).toContain("loading…");
    expect(fractalCardHtml(card({ checked: true }), deps)).toContain("It may still be running.");
  });

  it("shows the measured trail it was given under the text", () => {
    const html = fractalCardHtml(
      card({ status: "done", text: "ok", digest: ["- 3 model calls", "- No tool call failed."] }),
      deps,
    );
    expect(html).toContain("What the page measured for the turn");
    expect(html).toContain("<div>3 model calls</div>");
  });
});

// FORK 2026-10-09 (Fractal v2, charter C2/M4) — the bridge's ledger row on the card.
describe("the fractal check", () => {
  const row = {
    v: 1,
    parentRunId: "run-1",
    runId: "fractal-run-1",
    sessionKey: "agent:main:fractal:run-1",
    writes: ["/home/o/a.md", "/home/o/b.ts", "/home/o/a.md"],
    commits: [{ sha: "abc1234", repo: "/home/o/src/tinkerclaw" }],
    claims: [
      { ref: "~/a.md", kind: "path", ok: true, byThisRun: true },
      { ref: "~/ghost <x>.md", kind: "path", ok: false, why: "no such file" },
      { ref: "deadbee", kind: "commit", ok: false },
      { ref: "deadbee", kind: "commit", ok: false },
    ],
    verdict: "unverified",
  };

  it("reads a ledger row and counts each change once", () => {
    const check = fractalCheckFromRow(row);
    expect(check?.verdict).toBe("unverified");
    expect(check && fractalCheckChanges(check)).toBe(3);
    expect(fractalCheckFromRow(null)).toBeNull();
    expect(fractalCheckFromRow({ v: 1 })).toBeNull();
    expect(fractalCheckFromRow({ writes: ["/x"] })?.verdict).toBe("acted");
  });

  it("draws ✓ N changes checked and one ✗ per claim not found, escaped", () => {
    const html = fractalCardHtml(
      card({ status: "done", text: "fixed it", check: fractalCheckFromRow(row) ?? undefined }),
      deps,
    );
    expect(html).toContain("✓ 3 changes checked");
    expect(html).toContain("✗ claimed but not found: <code>~/ghost &lt;x>.md</code>");
    expect(html.match(/claimed but not found: <code>deadbee<\/code>/g)).toHaveLength(1);
    expect(html).not.toContain("not found: <code>~/a.md");
    // the check sits under the reflection's text
    expect(html.indexOf("fixed it")).toBeLessThan(html.indexOf("✓ 3 changes checked"));
    // and a phantom claim shows on the folded card too
    expect(html).toContain("🌿 Fractal · changed a.md, b.ts · commit abc1234 · ✗ 2 not found");
  });

  it("says one change in the singular and draws no ✗ for a clean run", () => {
    const html = fractalCardHtml(
      card({
        status: "done",
        text: "ok",
        check: fractalCheckFromRow({ verdict: "acted", writes: ["/x"] }) ?? undefined,
      }),
      deps,
    );
    expect(html).toContain("✓ 1 change checked");
    expect(html).not.toContain("✗");
  });

  it("draws no check line before the row arrives", () => {
    expect(fractalCardHtml(card({ status: "done", text: "ok" }), deps)).not.toContain("checked");
  });
});

describe("reflectionTextFromHistory", () => {
  const prompt = { role: "user", content: [{ type: "text", text: "⟦AGENT:🌿 Fractal⟧ …" }] };
  const narration = { role: "assistant", content: [{ type: "text", text: "Reading the skill." }] };
  const call = {
    role: "assistant",
    content: [{ type: "toolcall", name: "Read" }, { type: "tool_result" }],
  };
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] };
  const answer = { role: "assistant", content: [{ type: "text", text: "🌿 FRACTAL: clean." }] };

  it("is the last text block, after every tool call", () => {
    expect(reflectionTextFromHistory([prompt, narration, call, thinking, answer])).toBe(
      "🌿 FRACTAL: clean.",
    );
  });

  it("looks past a thinking row the bridge stored after the text", () => {
    expect(reflectionTextFromHistory([prompt, call, answer, thinking])).toBe("🌿 FRACTAL: clean.");
  });

  it("never passes a narration line off as the answer while a tool call is the last row", () => {
    expect(reflectionTextFromHistory([prompt, narration, call])).toBe("");
  });

  it("is empty for a session with no answer", () => {
    expect(reflectionTextFromHistory([prompt])).toBe("");
    expect(reflectionTextFromHistory([])).toBe("");
  });
});

describe("the folded line names what changed (2026-10-10)", () => {
  const base = { verdict: "acted", claims: [] } as never;
  it("names files and commits from the bridge's check, or says nothing to report", () => {
    expect(fractalChangedLabel(undefined)).toBeNull();
    expect(fractalChangedLabel({ ...(base as object), writes: [], commits: [] } as never)).toBe(
      "nothing to report",
    );
    expect(
      fractalChangedLabel({
        ...(base as object),
        writes: ["/a/fractal-prompt.md", "/b/SKILL.md", "/c/x.ts", "/d/y.ts"],
        commits: [{ sha: "a3c66596854" }],
      } as never),
    ).toBe("changed fractal-prompt.md, SKILL.md, x.ts +1 · commit a3c6659");
  });
});
