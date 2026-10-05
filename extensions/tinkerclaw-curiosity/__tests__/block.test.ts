import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCuriosityBlock,
  curiosityContextFor,
  DEEPER_MARKER,
  readProfile,
} from "../src/block.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), "curiosity-"));
  dirs.push(d);
  const p = join(d, "passions.md");
  writeFileSync(p, text);
  return p;
};

describe("readProfile", () => {
  it("takes only the '## For the prompt' section when there is one", () => {
    const p = file(
      "# Map\nintro\n\n## For the prompt\n- fractals\n- plants\n\n## Evidence\nsecret notes\n",
    );
    expect(readProfile(p, 3500)).toBe("- fractals\n- plants");
  });
  it("a missing file is an empty map; a long one is cut at a line with a pointer to the file", () => {
    expect(readProfile("/no/such/passions.md", 3500)).toBe("");
    const p = file(
      `## For the prompt\n${Array.from({ length: 50 }, (_, i) => `- passion ${i}`).join("\n")}\n`,
    );
    const out = readProfile(p, 120);
    expect(out.length).toBeLessThan(160);
    expect(out).toMatch(/the rest is in the file/);
  });
});

describe("the turn block", () => {
  it("carries the contract, the ✨ DEEPER marker, the map and the file to update", () => {
    const b = buildCuriosityBlock("- fractals", "/w/passions.md");
    expect(b).toContain(DEEPER_MARKER);
    expect(b).toContain("Do what he asked first");
    expect(b).toContain("- fractals");
    expect(b).toContain("/w/passions.md");
    expect(b).toMatch(/One question, not a list/);
  });
  it("an empty map asks the agent to find out, one question at a time", () => {
    expect(buildCuriosityBlock("", "/w/p.md")).toMatch(/one question at a time/);
  });
  it("only the main agent's Tinker chats get it", () => {
    const o = { sessionPrefix: "agent:main:tinker:", profile: "- x", profilePath: "/w/p.md" };
    expect(curiosityContextFor("agent:main:tinker:abc", o)).toContain("Curiosity sense");
    expect(curiosityContextFor("agent:main:whatsapp:direct:123", o)).toBeUndefined();
    expect(curiosityContextFor("agent:main:cron:job", o)).toBeUndefined();
    expect(curiosityContextFor(undefined, o)).toBeUndefined();
  });
});
