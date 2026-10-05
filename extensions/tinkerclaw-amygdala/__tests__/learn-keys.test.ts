import { describe, expect, it } from "vitest";
import { commandTokens, contextKey, dirBucket, featureKey, jaccard } from "../src/learn/keys.js";
import { buildSituation } from "../src/situation.js";
import type { Situation } from "../src/types.js";

const sit = (command: string, extra: Partial<Situation> = {}): Situation => ({
  ...buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: "/work/demo", homeDir: "/h" },
  ),
  ...extra,
});

describe("learn keys", () => {
  it("context key names the question, effect, target kind, scratch and directory bucket", () => {
    const s = sit("rm -rf /work/demo/tmp/x", { scratch: { value: true, origin: "derived" } });
    expect(contextKey(s, "danger-level")).toMatch(
      /^danger-level\|delete\|.+\|scratch\|\/work\/demo$/,
    );
    expect(contextKey(sit("rm -rf /work/demo/HR"), "danger-level")).toContain("|user|");
  });
  it("dirBucket: two components, rel for relative paths, none without a target", () => {
    expect(dirBucket(sit("rm -rf /a/b/c/d"))).toBe("/a/b");
    expect(
      dirBucket(
        sit("ls", {
          targets: {
            value: [{ path: "x/y", kind: "file", resolvedFrom: "x/y" }],
            origin: "derived",
          },
        }),
      ),
    ).toBe("rel");
    expect(dirBucket(sit("ls", { targets: { value: [], origin: "derived" } }))).toBe("none");
  });
  it("feature key and tokens ignore flags and path prefixes, so a rewording keeps them", () => {
    expect(featureKey(sit("rm -rf /a/b"))).toBe(featureKey(sit("rm -r -f /a/b")));
    expect(commandTokens(sit("rm -rf /a/b/HR"))).toEqual(commandTokens(sit("rm -r -f /x/y/HR")));
    expect(commandTokens(sit("cp /a/cv.pdf /shared/cv.pdf"))).toContain("cv.pdf");
  });
  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
  });
});
