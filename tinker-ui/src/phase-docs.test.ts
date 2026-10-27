import { describe, expect, it } from "vitest";
import { documentedPhaseLabels, phaseDocFor } from "./phase-docs.js";

describe("phaseDocFor", () => {
  it("explains every label the gateway and the client actually emit", () => {
    // The gateway's allowlist (src/plugins/turn-phase-emit.ts) plus the two client windows
    // (app.ts). If a label is added there and not here, the popup silently degrades to the
    // fallback — this test is the thing that notices.
    const emitted = [
      "compacting context",
      "preparing the turn",
      "recalling memories",
      "choosing a model",
      "assembling the prompt",
      "sending",
      "preparing context",
    ];
    for (const label of emitted) {
      const doc = phaseDocFor(label);
      expect(doc.title, label).not.toBe("this stage");
      expect(doc.what.length, label).toBeGreaterThan(40);
      expect(doc.whenSlow.length, label).toBeGreaterThan(40);
      expect(doc.refs.length, label).toBeGreaterThan(0);
    }
  });

  it("marks the two client windows as client-measured and the hooks as gateway-measured", () => {
    // The distinction is load-bearing: a client window is wall time INCLUDING queueing and
    // brackets the gateway stages, so the popup must not present them as the same quantity.
    expect(phaseDocFor("sending").measuredBy).toBe("client");
    expect(phaseDocFor("preparing context").measuredBy).toBe("client");
    expect(phaseDocFor("recalling memories").measuredBy).toBe("gateway");
    expect(phaseDocFor("assembling the prompt").measuredBy).toBe("gateway");
  });

  it("handles the model stage without needing an entry per model", () => {
    const a = phaseDocFor("starting claude-opus-5");
    const b = phaseDocFor("starting gpt-5.6-sol");
    expect(a.title).toContain("claude-opus-5");
    expect(b.title).toContain("gpt-5.6-sol");
    expect(a.refs.length).toBeGreaterThan(0);
  });

  it("falls back rather than throwing for an unknown or empty label", () => {
    expect(phaseDocFor("some future stage").title).toBe("this stage");
    expect(phaseDocFor("").title).toBe("this stage");
    expect(phaseDocFor(undefined).title).toBe("this stage");
    expect(phaseDocFor(null).refs.length).toBeGreaterThan(0);
  });

  it("is case- and whitespace-tolerant about the label", () => {
    expect(phaseDocFor("  Recalling Memories  ").title).toBe("recalling memories");
  });

  it("ships no reference without a note, and no link that is not https", () => {
    for (const label of documentedPhaseLabels()) {
      for (const ref of phaseDocFor(label).refs) {
        expect(ref.note.length, `${label}/${ref.label}`).toBeGreaterThan(10);
        expect(ref.label.length, label).toBeGreaterThan(5);
        if (ref.url) {
          expect(ref.url, `${label}/${ref.label}`).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("cites thetinkerzone.com and nowhere else", () => {
    // the architect, 2026-08-16: "The paper links should go to thetinkerzone.com". Also guards the rule
    // at the top of phase-docs.ts — no URL goes in from memory, so a new host is the signature
    // of a link nobody verified against the live page.
    for (const label of documentedPhaseLabels()) {
      for (const ref of phaseDocFor(label).refs) {
        if (!ref.url) continue;
        expect(new URL(ref.url).hostname, `${label} -> ${ref.url}`).toBe("thetinkerzone.com");
      }
    }
  });

  it("cites J1 from the stages it actually governs", () => {
    // Total Recall is the architecture for retrieval AND for compaction; a popup for either that
    // does not point at it is missing its primary source.
    for (const label of ["recalling memories", "compacting context", "preparing context"]) {
      const urls = phaseDocFor(label).refs.map((r) => r.url ?? "");
      expect(
        urls.some((u) => u.includes("total-recall")),
        label,
      ).toBe(true);
    }
  });
});
