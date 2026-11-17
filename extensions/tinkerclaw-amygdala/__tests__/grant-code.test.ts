import { describe, expect, it } from "vitest";
import { proofGrantCode, requestAllows } from "../src/grant-code.js";

describe("grant-code (the owner's one-click release of a held step)", () => {
  it("is JEV- and six base-36 characters, stable for one goal, different for another", () => {
    const a = proofGrantCode("0123456789abcdef");
    expect(a).toMatch(/^JEV-[0-9A-Z]{6}$/);
    expect(proofGrantCode("0123456789abcdef")).toBe(a);
    expect(proofGrantCode("fedcba9876543210")).not.toBe(a);
  });

  it("the request releases only when it says 'allow <code>' for that code", () => {
    expect(requestAllows("allow JEV-0A1B2C", "JEV-0A1B2C")).toBe(true);
    expect(requestAllows("Allow  jev-0a1b2c please", "JEV-0A1B2C")).toBe(true);
    expect(requestAllows("allow JEV-0A1B2CX", "JEV-0A1B2C")).toBe(false);
    expect(requestAllows("JEV-0A1B2C", "JEV-0A1B2C")).toBe(false);
    expect(requestAllows("don't allow this", "JEV-0A1B2C")).toBe(false);
    expect(requestAllows(null, "JEV-0A1B2C")).toBe(false);
  });
});
