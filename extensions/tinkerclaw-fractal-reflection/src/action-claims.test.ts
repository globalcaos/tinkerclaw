import { describe, expect, it } from "vitest";
import {
  ACTION_MARKER,
  actionClaimRegions,
  checkActionClaims,
  claimWarnings,
  type ClaimProbe,
} from "./action-claims.js";

const HOME = "/home/o";

/** A probe over a fake filesystem, so the tests never touch disk. */
function probeOver(files: Record<string, string>): ClaimProbe {
  return {
    home: HOME,
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => files[p] ?? "",
  };
}

describe("actionClaimRegions", () => {
  it("captures only the FRACTAL ACTION region, not the summary above it", () => {
    const r = actionClaimRegions(
      [
        "🌿 FRACTAL: instance → something happened",
        "Pattern → a pattern with a `/path/that/should/be/ignored.md` in it",
        `${ACTION_MARKER} wrote \`/real/file.md\``,
      ].join("\n"),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("/real/file.md");
    expect(r[0]).not.toContain("should/be/ignored");
  });

  it("a claim spanning several lines is one region, closed by the next 🌿 line", () => {
    const r = actionClaimRegions(
      [
        `${ACTION_MARKER} wrote \`/a.md\``,
        "and also `/b.md` as part of the same action",
        "🌿 FRACTAL: a later section with `/c.md`",
      ].join("\n"),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("/a.md");
    expect(r[0]).toContain("/b.md");
    expect(r[0]).not.toContain("/c.md");
  });

  it("returns nothing when the turn made no action claim", () => {
    expect(actionClaimRegions("🌿 FRACTAL: clean — nothing to report")).toHaveLength(0);
    expect(actionClaimRegions("")).toHaveLength(0);
  });
});

describe("checkActionClaims — tonight's real failures", () => {
  it("catches a claimed memory file that was never written", () => {
    // The 2026-07-26 claim: "wrote ~/.claude/.../feedback_peer_session_edits_are_evidence.md"
    const reflection = `${ACTION_MARKER} wrote \`~/.claude/memory/feedback_peer_session_edits_are_evidence.md\` — the rule.`;
    const checks = checkActionClaims(reflection, probeOver({}));
    expect(checks).toHaveLength(1);
    expect(checks[0].exists).toBe(false);
    expect(claimWarnings(checks)[0]).toContain("does not exist");
  });

  it("catches a bug-log ENTRY that was never added, even though bug-log.md exists", () => {
    // The failure a path-only check would miss — and it happened twice.
    const bugLog = "/home/o/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md";
    const reflection =
      `${ACTION_MARKER} filed \`[fractal-action-unbacked-claims]\` in ` +
      `\`~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md\` — repro: a turn claims a path.`;
    const checks = checkActionClaims(
      reflection,
      probeOver({ [bugLog]: "# bug log\n- [some-other-entry] unrelated\n" }),
    );
    expect(checks[0].exists).toBe(true);
    expect(checks[0].keys).toContain("fractal-action-unbacked-claims");
    expect(checks[0].missingKeys).toContain("fractal-action-unbacked-claims");
    expect(claimWarnings(checks)[0]).toContain("does not contain that key");
  });

  it("stays silent once the entry is really there", () => {
    const bugLog = "/home/o/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md";
    const reflection =
      `${ACTION_MARKER} filed \`[fractal-action-unbacked-claims]\` in ` +
      `\`~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/bug-log.md\`.`;
    const checks = checkActionClaims(
      reflection,
      probeOver({ [bugLog]: "- [fractal-action-unbacked-claims] repro ...\n" }),
    );
    expect(checks[0].missingKeys).toEqual([]);
    expect(claimWarnings(checks)).toEqual([]);
  });

  it("flags every missing path when one action claims several", () => {
    const reflection = `${ACTION_MARKER} wrote \`/a/one.ts\`, \`/a/two.test.ts\` and wired it into \`/a/index.ts\`.`;
    const checks = checkActionClaims(reflection, probeOver({ "/a/index.ts": "x" }));
    expect(checks).toHaveLength(3);
    expect(checks.filter((c) => !c.exists).map((c) => c.path)).toEqual([
      "/a/one.ts",
      "/a/two.test.ts",
    ]);
    expect(claimWarnings(checks)).toHaveLength(2);
  });
});

describe("checkActionClaims — must not cry wolf", () => {
  it("ignores backticked things that are not paths", () => {
    const reflection = `${ACTION_MARKER} set \`EXPLORE_BONUS\` to \`0.03\` and renamed \`policyToggle\` — see \`orca-policy.md\`.`;
    expect(checkActionClaims(reflection, probeOver({}))).toEqual([]);
  });

  it("ignores paths mentioned OUTSIDE an action claim", () => {
    const reflection = [
      "🌿 FRACTAL: instance → I read `/etc/never-written.conf` while debugging.",
      "Producing system → `/also/not/claimed.ts` is where it lives.",
    ].join("\n");
    expect(checkActionClaims(reflection, probeOver({}))).toEqual([]);
  });

  it("a clean one-line reflection produces no checks at all", () => {
    expect(checkActionClaims("🌿 FRACTAL: clean — nothing surprising.", probeOver({}))).toEqual([]);
  });

  it("strips sentence punctuation so a trailing period is not part of the path", () => {
    const checks = checkActionClaims(
      `${ACTION_MARKER} wrote \`/a/file.md\`.`,
      probeOver({ "/a/file.md": "x" }),
    );
    expect(checks[0].resolved).toBe("/a/file.md");
    expect(checks[0].exists).toBe(true);
  });

  it("expands ~ against the supplied home", () => {
    const checks = checkActionClaims(
      `${ACTION_MARKER} wrote \`~/notes/x.md\`.`,
      probeOver({ [`${HOME}/notes/x.md`]: "x" }),
    );
    expect(checks[0].resolved).toBe(`${HOME}/notes/x.md`);
    expect(checks[0].exists).toBe(true);
  });

  it("does not duplicate a path repeated inside one claim", () => {
    const checks = checkActionClaims(
      `${ACTION_MARKER} wrote \`/a/x.md\` then updated \`/a/x.md\` again.`,
      probeOver({}),
    );
    expect(checks).toHaveLength(1);
  });
});
