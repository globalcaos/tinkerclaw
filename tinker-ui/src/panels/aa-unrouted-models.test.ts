import { describe, expect, it } from "vitest";
import { AA_DOSSIER_ONLY_IDS, AA_UNROUTED_MODELS } from "./aa-unrouted-models.js";

describe("AA unrouted models", () => {
  it("lists each model once, with a score and a reason", () => {
    const ids = AA_UNROUTED_MODELS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const u of AA_UNROUTED_MODELS) {
      expect(u.index).toBeGreaterThan(0);
      expect(u.why.length).toBeGreaterThan(10);
    }
  });

  it("keeps unrouted ids out of the picker's reachable providers", () => {
    for (const id of [...AA_DOSSIER_ONLY_IDS, ...AA_UNROUTED_MODELS.map((u) => u.id)]) {
      expect(id.split("/").length).toBeGreaterThanOrEqual(2);
    }
  });
});
