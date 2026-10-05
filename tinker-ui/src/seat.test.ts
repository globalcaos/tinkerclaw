import { describe, expect, it } from "vitest";
import { formatAgentBanner } from "../../src/shared/hivemind-seats.ts";

describe("formatAgentBanner (tinker re-export contract)", () => {
  it("matches GOKU (Alice)", () => {
    expect(formatAgentBanner("GOKU", "Alice")).toBe("GOKU (Alice)");
  });
});

// FORK 2026-10-05 — the 2026-09-21 port copied the seat id into the tab but never asked the house
// who sits in it, so CONDUCTOR_STORAGE_KEY was read and never written and Goku's banner stayed
// "GOKU" for everyone (the architect: "Goku still does not show my name next to GOKU"). Source check.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("app.ts asks the house for the conductor's name (source check)", () => {
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  if (!srcRoot) throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
  const app = readFileSync(join(srcRoot, "app.ts"), "utf8").replace(/\/\/.*$/gm, "");

  it("fetches api/seat with the seat header and stores the display name", () => {
    expect(app).toMatch(/fetch\(`\$\{BASE\}api\/seat`/);
    expect(app).toMatch(/"X-Tinker-Seat":\s*seat/);
    expect(app).toMatch(/sessionStorage\.setItem\(CONDUCTOR_STORAGE_KEY,/);
  });

  it("the banner repaints with the fetched name", () => {
    expect(app).toMatch(/loadConductorName\(\)\.then\(/);
  });
});
