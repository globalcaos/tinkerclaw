import { describe, expect, it } from "vitest";
import {
  adjustDanger,
  cellToResponse,
  limitNotes,
  mergeResponses,
  proofCell,
  severity,
  type Danger,
  type Risk,
} from "../src/respond.js";
import type { Response } from "../src/types.js";

describe("proofCell: the paper §6.1 table, all nine cells", () => {
  const table: Array<[Danger, Risk, string, boolean]> = [
    [0, "low", "proceed", false],
    [1, "low", "proceed", false],
    [0, "medium", "note", false],
    [1, "medium", "note", false],
    [0, "high", "ask", false],
    [1, "high", "ask", false],
    [2, "low", "note", false],
    [2, "medium", "proof", false],
    [2, "high", "hold", false],
    [3, "low", "proof", true],
    [3, "medium", "proof", true],
    [3, "high", "hold", true],
  ];
  it.each(table)("danger %s × risk %s → %s (authorise %s)", (d, r, kind, auth) => {
    const c = proofCell(d, r);
    expect(c.kind).toBe(kind);
    expect(c.authorise).toBe(auth);
  });

  it("danger 3, low risk: no authorisation needed when the request named this exact action and target", () => {
    expect(proofCell(3, "low", true)).toMatchObject({ kind: "proof", authorise: false });
    expect(proofCell(3, "medium", true).authorise).toBe(true);
  });

  it("note cells carry the right template hint", () => {
    expect(proofCell(1, "medium").templateId).toBe("assumed-reading");
    expect(proofCell(2, "low").templateId).toBe("relevant-fact");
  });
});

describe("adjustDanger", () => {
  it("recent investment and a precedent each add one, capped at 3", () => {
    expect(adjustDanger(1, { recentInvestment: true })).toBe(2);
    expect(adjustDanger(1, { recentInvestment: true, precedentShouldHold: true })).toBe(3);
    expect(adjustDanger(2, { recentInvestment: true, precedentShouldHold: true })).toBe(3);
  });
  it("stopping its own system, tier-3 egress and an unresolved repeat are danger 3", () => {
    for (const k of ["stopsOwnSystem", "egressTier3", "repeatUnresolved"] as const) {
      expect(adjustDanger(0, { [k]: true })).toBe(3);
    }
  });
  it("no adjustment leaves it alone", () => {
    expect(adjustDanger(2, {})).toBe(2);
  });
});

describe("mergeResponses", () => {
  const r = (kind: Response["kind"]): Response =>
    kind === "note"
      ? { kind, templateId: "relevant-fact", slots: { fact: "x" }, channel: "additionalContext" }
      : kind === "hold"
        ? { kind, ruleOrQuestion: "q", releasable: "user-only" }
        : kind === "proof"
          ? {
              kind,
              templateId: "proof-required",
              slots: { what: "a", needs: "b" },
              needs: ["listing"],
            }
          : kind === "ask"
            ? { kind, askId: "a", options: [] }
            : kind === "send-back"
              ? { kind, templateId: "send-back-claim", slots: {}, attempt: 1 }
              : { kind: "proceed" };

  it("orders hold > send-back > ask > proof > note > proceed", () => {
    const kinds: Response["kind"][] = ["proceed", "note", "proof", "ask", "send-back", "hold"];
    expect(kinds.map((k) => severity(r(k)))).toEqual([0, 1, 2, 3, 4, 5]);
    // a refusal sits between proceed and note: it never outranks anything that acts on the agent
    expect(severity({ kind: "refusal" })).toBeGreaterThan(severity({ kind: "proceed" }));
    expect(severity({ kind: "refusal" })).toBeLessThan(severity(r("note")));
    const best = mergeResponses(kinds.map((k) => ({ response: r(k), family: k, reasonCode: k })));
    expect(best.family).toBe("hold");
  });
  it("ties keep the earlier candidate", () => {
    const a = { response: r("proof"), family: "safety", reasonCode: "a" };
    const b = { response: r("proof"), family: "double-check", reasonCode: "b" };
    expect(mergeResponses([a, b])).toBe(a);
  });
  it("no candidates → proceed", () => {
    expect(mergeResponses([]).response.kind).toBe("proceed");
  });
});

describe("limitNotes", () => {
  const note: Response = {
    kind: "note",
    templateId: "relevant-fact",
    slots: { fact: "f" },
    channel: "additionalContext",
  };
  it("allows one note per call and never repeats the same note in a task", () => {
    const st = { seenNotes: new Set<string>(), notesThisCall: 0 };
    expect(limitNotes(note, st).kind).toBe("note");
    expect(limitNotes({ ...note, slots: { fact: "g" } }, st).kind).toBe("proceed"); // second in the same call
    st.notesThisCall = 0; // next tool call
    expect(limitNotes(note, st).kind).toBe("proceed"); // same note again
    expect(limitNotes({ ...note, slots: { fact: "g" } }, st).kind).toBe("note"); // a different one
  });
  it("leaves other responses alone", () => {
    const st = { seenNotes: new Set<string>(), notesThisCall: 5 };
    expect(limitNotes({ kind: "proceed" }, st).kind).toBe("proceed");
  });
});

describe("cellToResponse", () => {
  const b = {
    slots: { what: "w", needs: "n" },
    needs: ["listing" as const],
    askId: "a1",
    options: [{ id: "x", label: "X" }],
    preselect: "x",
    reason: "danger-level",
  };
  it("builds each kind", () => {
    expect(cellToResponse(proofCell(0, "low"), b).kind).toBe("proceed");
    expect(cellToResponse(proofCell(1, "medium"), b)).toMatchObject({
      kind: "note",
      templateId: "assumed-reading",
    });
    expect(cellToResponse(proofCell(2, "medium"), b)).toMatchObject({
      kind: "proof",
      needs: ["listing"],
    });
    expect(cellToResponse(proofCell(0, "high"), b)).toMatchObject({
      kind: "ask",
      askId: "a1",
      preselect: "x",
    });
    expect(cellToResponse(proofCell(3, "high"), b)).toMatchObject({
      kind: "hold",
      ruleOrQuestion: "danger-level",
      releasable: "user-only",
    });
  });
});
