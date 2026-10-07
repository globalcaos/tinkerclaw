import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTokenText } from "./availability.js";
import { jevDormantNote, normalizeJevToken, writeJevTokenFile } from "./token-file.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jev-token-file-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("jev key file", () => {
  it("writes the token owner-only, in a directory the owner alone can enter", () => {
    const path = join(tmp(), "state", "jev", "token");
    expect(writeJevTokenFile("  tok-abc123 \n", path)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("tok-abc123\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    // what it wrote is what the gateway's reader takes back
    expect(parseTokenText(readFileSync(path, "utf8"))).toBe("tok-abc123");
  });

  it("accepts a pasted `TYPESAFE_API_KEY=...` line and refuses what is not one token", () => {
    expect(normalizeJevToken('export TYPESAFE_API_KEY="tok-1"')).toBe("tok-1");
    expect(normalizeJevToken("")).toBeUndefined();
    expect(normalizeJevToken("two words")).toBeUndefined();
    expect(() => writeJevTokenFile("two words", join(tmp(), "t"))).toThrow(/not a Jev token/);
  });

  it("the skip note names what is off, where the key goes, and has no URL unless one is configured", () => {
    const line = jevDormantNote("/x/jev/token");
    expect(line).toContain("no token");
    expect(line).toContain("safety checks");
    expect(line).toContain("/x/jev/token");
    expect(line).not.toMatch(/https?:/);
    expect(jevDormantNote("/x/jev/token", "https://example.test/t")).toContain(
      "https://example.test/t",
    );
  });
});
