/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import {
  renderFractalDock,
  upsertFractalDock,
  findDockAnchor,
  type FractalDockRow,
} from "./fractal-dock";

const row = (over: Partial<FractalDockRow> = {}): FractalDockRow => ({
  parentRunId: "run-main-1",
  status: "clean",
  ...over,
});

describe("renderFractalDock — collapsed verdict dock", () => {
  it("renders a collapsed <details> reusing the Commentary chrome + the dock join attribute", () => {
    const el = renderFractalDock(row());
    expect(el.tagName).toBe("DETAILS");
    expect((el as HTMLDetailsElement).open).toBe(false); // collapsed by default
    expect(el.hasAttribute("open")).toBe(false);
    // Commentary chrome classes (base.css .reasoning-group/.narration-details) + dock class.
    expect(el.classList.contains("reasoning-group")).toBe(true);
    expect(el.classList.contains("narration-details")).toBe(true);
    expect(el.classList.contains("fractal-dock")).toBe(true);
    expect(el.getAttribute("data-fractal-parent")).toBe("run-main-1");
  });

  it("carries a status-specific class and the status word in the summary", () => {
    const el = renderFractalDock(row({ status: "flagged" }));
    expect(el.classList.contains("fractal-status-flagged")).toBe(true);
    expect(el.querySelector("summary")?.textContent).toBe("🔍 Fractal Reasoning · flagged ⓘ");
  });

  it("spells the liveness words: ⚠ error, skipped with reason", () => {
    const err = renderFractalDock(row({ status: "error" }));
    expect(err.classList.contains("fractal-status-error")).toBe(true);
    expect(err.querySelector("summary")?.textContent).toBe("🔍 Fractal Reasoning · ⚠ error ⓘ");
    const skipped = renderFractalDock(row({ status: "skipped", reason: "quota" }));
    expect(skipped.classList.contains("fractal-status-skipped")).toBe(true);
    expect(skipped.querySelector("summary")?.textContent).toBe(
      "🔍 Fractal Reasoning · skipped:quota ⓘ",
    );
  });

  it("summary appends a findings count only when findings exist", () => {
    const none = renderFractalDock(row());
    expect(none.querySelector("summary")?.textContent).not.toContain("finding");
    const two = renderFractalDock(
      row({
        status: "flagged",
        findings: [
          { kind: "bug", claim: "off-by-one", path: "src/a.ts" },
          { kind: "gap", claim: "unsourced claim" },
        ],
      }),
    );
    expect(two.querySelector("summary")?.textContent).toBe(
      "🔍 Fractal Reasoning · flagged · 2 findings ⓘ",
    );
  });

  it("expanded body renders headline, findings (kind chip + claim + path), reasoning as text", () => {
    const el = renderFractalDock(
      row({
        status: "flagged",
        verdict: "One stale doc claim",
        findings: [{ kind: "stale-doc", claim: "bible says X, code does Y", path: "docs/x.md" }],
        reasoning: "line one\nline two",
      }),
    );
    expect(el.querySelector(".fractal-dock-headline")?.textContent).toBe("One stale doc claim");
    const finding = el.querySelector(".fractal-dock-finding");
    expect(finding?.querySelector(".fractal-finding-kind")?.textContent).toBe("stale-doc");
    expect(finding?.querySelector(".fractal-finding-claim")?.textContent).toBe(
      "bible says X, code does Y",
    );
    expect(finding?.querySelector(".fractal-finding-path")?.textContent).toBe("docs/x.md");
    // Reasoning: plain text-with-line-breaks — <br> separators, no markdown rendering.
    const reasoning = el.querySelector(".fractal-dock-reasoning");
    expect(reasoning?.querySelectorAll("br").length).toBe(1);
    expect(reasoning?.textContent).toBe("line oneline two");
  });

  it("never interprets row content as HTML (textContent only)", () => {
    const el = renderFractalDock(
      row({
        verdict: "<img src=x onerror=boom>",
        findings: [{ kind: "<b>", claim: "<script>alert(1)</script>" }],
        reasoning: "**not markdown** <i>not html</i>",
      }),
    );
    expect(el.querySelector("img, script, b, i")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("attribution placeholders render ONLY when artifactsTouched is non-empty", () => {
    // Drop 1: fractalChanges/mainChanges present-but-empty → no placeholders.
    const drop1 = renderFractalDock(
      row({ status: "flagged", artifactsTouched: [], fractalChanges: [], mainChanges: [] }),
    );
    expect(drop1.textContent).not.toContain("Reflection changed");
    expect(drop1.textContent).not.toContain("Main turn changed");
    const fixed = renderFractalDock(
      row({
        status: "acted",
        artifactsTouched: ["src/a.ts"],
        fractalChanges: ["src/a.ts"],
        mainChanges: [],
      }),
    );
    const labels = Array.from(fixed.querySelectorAll(".fractal-attribution-label")).map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["Reflection changed", "Main turn changed"]);
    expect(fixed.querySelector(".fractal-attribution-files code")?.textContent).toBe("src/a.ts");
  });
});

describe("upsertFractalDock — pending→final fill replaces in place, never duplicates", () => {
  it("appends on first sight, morphs the same dock on the final event", () => {
    const container = document.createElement("div");
    const pending = upsertFractalDock(container, row({ status: "pending" }));
    expect(container.querySelectorAll(".fractal-dock").length).toBe(1);
    expect(pending.classList.contains("fractal-status-pending")).toBe(true);

    const final = upsertFractalDock(container, row({ status: "clean" }));
    expect(container.querySelectorAll(".fractal-dock").length).toBe(1); // replaced, not duplicated
    expect(final.classList.contains("fractal-status-clean")).toBe(true);
    expect(final.classList.contains("fractal-status-pending")).toBe(false);
    expect(container.contains(pending)).toBe(false);
    expect(container.contains(final)).toBe(true);
  });

  it("keeps docks for different parent runs separate", () => {
    const container = document.createElement("div");
    upsertFractalDock(container, row({ parentRunId: "run-1" }));
    upsertFractalDock(container, row({ parentRunId: "run-2" }));
    expect(container.querySelectorAll(".fractal-dock").length).toBe(2);
  });

  it("preserves dock position + the user's open state across the morph", () => {
    const container = document.createElement("div");
    const answer = document.createElement("div");
    container.appendChild(answer);
    const tail = document.createElement("div");
    container.appendChild(tail);

    const pending = upsertFractalDock(container, row({ status: "pending" }), () => answer);
    expect(answer.nextElementSibling).toBe(pending);
    (pending as HTMLDetailsElement).open = true; // user expanded the stub

    const final = upsertFractalDock(container, row({ status: "acted" }), () => answer);
    expect(answer.nextElementSibling).toBe(final); // same slot, before `tail`
    expect(final.nextElementSibling).toBe(tail);
    expect((final as HTMLDetailsElement).open).toBe(true); // open state survives
  });
});

describe("findDockAnchor — docks after the resolved answer, orphan fallback otherwise", () => {
  it("inserts the dock immediately after the anchor app.ts resolves", () => {
    const container = document.createElement("div");
    const answer = document.createElement("div");
    container.appendChild(answer);
    const dock = renderFractalDock(row());
    findDockAnchor(container, dock, "run-main-1", () => answer);
    expect(answer.nextElementSibling).toBe(dock);
    expect(dock.classList.contains("fractal-orphan")).toBe(false);
  });

  it("falls back to appending with fractal-orphan when the lookup misses", () => {
    const container = document.createElement("div");
    const dock = renderFractalDock(row());
    findDockAnchor(container, dock, "run-main-1", () => null);
    expect(dock.parentElement).toBe(container);
    expect(container.lastElementChild).toBe(dock);
    expect(dock.classList.contains("fractal-orphan")).toBe(true);
  });

  it("treats a detached anchor as a miss (orphan fallback)", () => {
    const container = document.createElement("div");
    const detached = document.createElement("div"); // not attached to any tree
    const dock = renderFractalDock(row());
    findDockAnchor(container, dock, "run-main-1", () => detached);
    expect(dock.parentElement).toBe(container);
    expect(dock.classList.contains("fractal-orphan")).toBe(true);
  });
});

// FORK 2026-08-11 (the architect) — LEVEL 3: the reflection's own transcript, nested in the
// dock so its run no longer needs a separate tab.
describe("renderFractalDock — nested full-reasoning transcript", () => {
  it("renders no transcript section when no loader is supplied (back-compat)", () => {
    const el = renderFractalDock(row({ status: "clean" }));
    expect(el.querySelector(".fractal-dock-transcript")).toBeNull();
  });

  it("omits the transcript section on a pending stub — there is nothing to show yet", () => {
    const el = renderFractalDock(row({ status: "pending" }), async () => "anything");
    expect(el.querySelector(".fractal-dock-transcript")).toBeNull();
  });

  it("renders the section but does NOT fetch until first open (lazy by construction)", () => {
    let calls = 0;
    const el = renderFractalDock(row({ status: "clean" }), async () => {
      calls++;
      return "the transcript";
    });
    expect(el.querySelector(".fractal-dock-transcript")).not.toBeNull();
    expect(calls).toBe(0); // the whole point: a dock per turn must not pull a transcript per turn
  });

  it("fetches once on open, renders the text, and does not refetch on reopen", async () => {
    let calls = 0;
    const el = renderFractalDock(row({ status: "clean", parentRunId: "run-xyz" }), async (id) => {
      calls++;
      return `transcript for ${id}`;
    });
    const section = el.querySelector<HTMLDetailsElement>(".fractal-dock-transcript")!;
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(section.querySelector(".fractal-transcript-body")?.textContent).toContain(
      "transcript for run-xyz",
    );
    // close + reopen must not refetch
    section.open = false;
    section.dispatchEvent(new Event("toggle"));
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("reports an empty transcript as a real state, not a blank box", async () => {
    const el = renderFractalDock(row({ status: "clean" }), async () => "   ");
    const section = el.querySelector<HTMLDetailsElement>(".fractal-dock-transcript")!;
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    await Promise.resolve();
    expect(section.querySelector(".fractal-transcript-body")?.textContent).toBe(
      "no transcript found for this reflection run",
    );
  });

  it("surfaces a load failure and un-latches so the next open retries", async () => {
    let calls = 0;
    const el = renderFractalDock(row({ status: "clean" }), async () => {
      calls++;
      throw new Error("gateway down");
    });
    const section = el.querySelector<HTMLDetailsElement>(".fractal-dock-transcript")!;
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    await Promise.resolve();
    expect(section.querySelector(".fractal-transcript-body")?.textContent).toContain(
      "gateway down",
    );
    section.dispatchEvent(new Event("toggle")); // retry is allowed after a failure
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it("threads the loader through upsertFractalDock", () => {
    const container = document.createElement("div");
    upsertFractalDock(container, row({ status: "clean" }), undefined, async () => "t");
    expect(container.querySelector(".fractal-dock-transcript")).not.toBeNull();
  });
});
