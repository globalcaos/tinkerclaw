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
    expect(el.querySelector("summary")?.textContent).toBe("🌿 Fractal · flagged");
  });

  it("spells the liveness words: ⚠ error, skipped with reason", () => {
    const err = renderFractalDock(row({ status: "error" }));
    expect(err.classList.contains("fractal-status-error")).toBe(true);
    expect(err.querySelector("summary")?.textContent).toBe("🌿 Fractal · ⚠ error");
    const skipped = renderFractalDock(row({ status: "skipped", reason: "quota" }));
    expect(skipped.classList.contains("fractal-status-skipped")).toBe(true);
    expect(skipped.querySelector("summary")?.textContent).toBe("🌿 Fractal · skipped:quota");
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
    expect(two.querySelector("summary")?.textContent).toBe("🌿 Fractal · flagged · 2 findings");
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
