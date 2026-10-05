import { describe, expect, it } from "vitest";
import {
  type SettingsPaths,
  type StatFn,
  amygdalaSettingsArgs,
  resolveAmygdalaSettings,
} from "./amygdala-settings.js";

const P: SettingsPaths = { v31: "/d/v31.json", next: "/d/next.json", effective: "/d/eff.json" };

function fakeStat(files: Record<string, number>): StatFn {
  return (p) => (p in files ? { mtimeMs: files[p] } : null);
}

describe("resolveAmygdalaSettings truth table", () => {
  // Existence of v31 / next / effective, all mtimes equal (100).
  const cases: Array<[boolean, boolean, boolean, string | null]> = [
    [false, false, false, null],
    [true, false, false, P.v31],
    [false, false, true, null], // effective alone is ignored while next is missing
    [true, false, true, P.v31],
    [false, true, false, P.next],
    [true, true, false, P.v31],
    [false, true, true, P.effective],
    [true, true, true, P.effective],
  ];
  for (const [hasV31, hasNext, hasEff, want] of cases) {
    it(`v31=${hasV31} next=${hasNext} effective=${hasEff} -> ${want}`, () => {
      const files: Record<string, number> = {};
      if (hasV31) files[P.v31] = 100;
      if (hasNext) files[P.next] = 100;
      if (hasEff) files[P.effective] = 100;
      expect(resolveAmygdalaSettings(P, fakeStat(files))).toBe(want);
    });
  }

  it("effective newer than both sources -> effective", () => {
    expect(
      resolveAmygdalaSettings(P, fakeStat({ [P.v31]: 100, [P.next]: 110, [P.effective]: 200 })),
    ).toBe(P.effective);
  });

  it("effective older than next -> v31", () => {
    expect(
      resolveAmygdalaSettings(P, fakeStat({ [P.v31]: 100, [P.next]: 200, [P.effective]: 150 })),
    ).toBe(P.v31);
  });

  it("effective older than v31 -> v31", () => {
    expect(
      resolveAmygdalaSettings(P, fakeStat({ [P.v31]: 200, [P.next]: 100, [P.effective]: 150 })),
    ).toBe(P.v31);
  });

  it("effective equal to the newest source -> effective", () => {
    expect(
      resolveAmygdalaSettings(P, fakeStat({ [P.v31]: 150, [P.next]: 200, [P.effective]: 200 })),
    ).toBe(P.effective);
  });

  it("stale effective and no v31 -> next", () => {
    expect(resolveAmygdalaSettings(P, fakeStat({ [P.next]: 200, [P.effective]: 100 }))).toBe(
      P.next,
    );
  });

  it("a throwing stat is safe and means 'does not exist'", () => {
    const boom: StatFn = () => {
      throw new Error("EACCES");
    };
    expect(resolveAmygdalaSettings(P, boom)).toBeNull();
    const onlyV31Throws: StatFn = (p) => {
      if (p === P.v31) throw new Error("EACCES");
      return null;
    };
    expect(resolveAmygdalaSettings(P, onlyV31Throws)).toBeNull();
  });
});

describe("plugin off: identical to the pre-change behaviour", () => {
  // The argv prefix the OLD worker code produced, built by hand from its logic:
  // fixed flags, then `--settings <v31>` only when the v3.1 file exists.
  const base = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "-p",
    "--permission-mode",
    "bypassPermissions",
  ];
  const oldArgs = (v31Exists: boolean): string[] => {
    const args = [...base];
    if (v31Exists) {
      args.push("--settings", P.v31);
    }
    return args;
  };

  it("v3.1 present, no next/effective -> --settings <v31>", () => {
    const stat = fakeStat({ [P.v31]: 100 });
    expect(resolveAmygdalaSettings(P, stat)).toBe(P.v31);
    expect([...base, ...amygdalaSettingsArgs(P, stat)]).toEqual(oldArgs(true));
  });

  it("v3.1 absent, no next/effective -> null and no flag", () => {
    const stat = fakeStat({});
    expect(resolveAmygdalaSettings(P, stat)).toBeNull();
    expect([...base, ...amygdalaSettingsArgs(P, stat)]).toEqual(oldArgs(false));
  });

  it("a stray effective file without next changes nothing", () => {
    const stat = fakeStat({ [P.v31]: 100, [P.effective]: 500 });
    expect([...base, ...amygdalaSettingsArgs(P, stat)]).toEqual(oldArgs(true));
  });
});
