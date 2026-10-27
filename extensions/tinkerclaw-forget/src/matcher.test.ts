import { describe, expect, it } from "vitest";
import { buildMatcher, FactError, forgottenToken, normalizeFact } from "./matcher.js";

const hits = (re: RegExp, s: string) => {
  re.lastIndex = 0;
  const out = re.test(s);
  re.lastIndex = 0;
  return out;
};

describe("buildMatcher", () => {
  it("matches a phone number with any spacing, but never inside a longer run of digits", () => {
    const m = buildMatcher("+34 600 11 12 22");
    expect(m.kind).toBe("number");
    for (const s of [
      "call +34600111222 now",
      "34-600-111-222",
      "(+34) 600.111.222",
      "34 600 11 12 22",
    ]) {
      expect(hits(m.replace, s)).toBe(true);
      expect(hits(m.scan, s)).toBe(true);
    }
    expect(hits(m.replace, "id 9934600111222")).toBe(false);
    expect(hits(m.replace, "34600111222789")).toBe(false);
    // Without its country code it is another spelling: the caller passes it as a variant.
    expect(hits(m.replace, "600 111 222")).toBe(false);
    expect(hits(buildMatcher("+34 600 11 12 22", ["600111222"]).replace, "600 111 222")).toBe(true);
    expect(m.literals).toEqual(["+34 600 11 12 22", "34600111222"]);
  });

  it("matches text case-insensitively, any whitespace for a space, and only as whole words", () => {
    const m = buildMatcher("Calle Mayor 5");
    expect(m.kind).toBe("text");
    expect(hits(m.replace, "lives at calle   MAYOR 5, 2nd floor")).toBe(true);
    expect(hits(m.replace, "Calle Mayor 55")).toBe(false);
    expect(hits(m.replace, "XCalle Mayor 5")).toBe(false);
  });

  it("also finds a fact with quotes in its JSON-escaped form", () => {
    const m = buildMatcher('the code is "tango"');
    const jsonLine = JSON.stringify({ text: 'he said the code is "tango" twice' });
    expect(hits(m.scan, jsonLine)).toBe(true);
    expect(hits(m.replace, jsonLine)).toBe(true);
  });

  it("scans raw bytes: a non-ASCII fact is found in latin1-decoded UTF-8", () => {
    const m = buildMatcher("Carrer Martí 12");
    const raw = Buffer.from("viu al Carrer Martí 12", "utf8").toString("latin1");
    expect(hits(m.scan, raw)).toBe(true);
  });
});

describe("normalizeFact", () => {
  it("refuses a fact too short to forget safely, or not a string", () => {
    expect(() => normalizeFact("ab c")).toThrow(FactError);
    expect(() => normalizeFact(42)).toThrow(FactError);
    expect(normalizeFact("  my   old  number ")).toBe("my old number");
  });
});

it("forgottenToken is plain ASCII with the date", () => {
  expect(forgottenToken(new Date("2026-10-25T18:00:00Z"))).toBe("[forgotten 2026-10-25]");
});
