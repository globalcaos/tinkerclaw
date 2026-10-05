import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHookSettings,
  compilePolicy,
  computeFloorActive,
  mergeHookSettings,
  policyPaths,
  stageHooks,
  writeHookSettings,
  writePolicy,
} from "../src/policy.js";
import { ALL_RULES } from "../src/rules.js";
import { probeV31, v31Enforcing } from "../src/v31-probe.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "amyg-policy-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("computeFloorActive", () => {
  it("truth table", () => {
    expect(computeFloorActive("shadow", true)).toBe(false);
    expect(computeFloorActive("shadow", false)).toBe(true);
    expect(computeFloorActive("enforce", true)).toBe(true);
    expect(computeFloorActive("enforce", false)).toBe(true);
  });
});

describe("compilePolicy", () => {
  it("carries flags and all rules", () => {
    const p = compilePolicy({ mode: "shadow", v31Enforcing: true, now: 42 });
    expect(p.version).toBe(1);
    expect(p.generatedAt).toBe(42);
    expect(p.mode).toBe("shadow");
    expect(p.floorActive).toBe(false);
    expect(p.failClosed).toBe(true);
    expect(p.rules.length).toBe(ALL_RULES.length);
  });
});

describe("writePolicy", () => {
  it("writes 0600 file in a 0700 folder, atomically", () => {
    const dir = join(tmp(), "data");
    const p = compilePolicy({ mode: "enforce", v31Enforcing: false });
    writePolicy(dir, p);
    const { policyPath } = policyPaths(dir);
    expect(statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(policyPath, "utf-8")).mode).toBe("enforce");
  });
});

describe("stageHooks", () => {
  it("copies only *.mjs", () => {
    const root = tmp();
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(src, "a.mjs"), "//a");
    writeFileSync(join(src, "b.txt"), "b");
    const dir = join(root, "data");
    expect(stageHooks(dir, src)).toEqual(["a.mjs"]);
    expect(existsSync(join(dir, "hooks", "a.mjs"))).toBe(true);
    expect(existsSync(join(dir, "hooks", "b.txt"))).toBe(false);
  });
});

describe("buildHookSettings", () => {
  type S = {
    hooks: Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>
    >;
  };
  it("has the four events and the shadow env unless enforce", () => {
    const s = buildHookSettings("/d", { mode: "shadow" }) as S;
    expect(Object.keys(s.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(s.hooks.PreToolUse[0].matcher).toBe("*");
    expect(s.hooks.PostToolUse[0].matcher).toBe("*");
    const cmd = s.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("AMYGDALA2_DATA_DIR");
    expect(cmd).toContain("AMYGDALA2_SHADOW=1");
    expect(cmd).toContain("pre-tool.mjs");
    expect(s.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(5);
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(330);
    expect(s.hooks.PostToolUse[0].hooks[0].timeout).toBe(5);
    expect(s.hooks.Stop[0].hooks[0].timeout).toBe(8);
  });
  it("enforce omits the shadow env; timeouts overridable", () => {
    const s = buildHookSettings("/d", { mode: "enforce", timeouts: { pre: 9 } }) as S;
    expect(s.hooks.Stop[0].hooks[0].command).not.toContain("AMYGDALA2_SHADOW");
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(9);
  });
  it("writeHookSettings returns the path of an atomic write", () => {
    const dir = tmp();
    const path = writeHookSettings(dir, { hooks: {} });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ hooks: {} });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("mergeHookSettings", () => {
  const v31 = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ command: "v31" }] }] }, other: 1 };
  const next = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ command: "v2" }] }],
      Stop: [{ hooks: [{ command: "stop" }] }],
    },
    other: 2,
    extra: 3,
  };
  it("v31 first and unchanged, new appended, inputs unmutated", () => {
    const a = structuredClone(v31);
    const b = structuredClone(next);
    const m = mergeHookSettings(a, b) as typeof next;
    expect(m.hooks.PreToolUse).toEqual([...v31.hooks.PreToolUse, ...next.hooks.PreToolUse]);
    expect(m.hooks.Stop).toEqual(next.hooks.Stop);
    expect(m.other).toBe(1);
    expect(m.extra).toBe(3);
    expect(a).toEqual(v31);
    expect(b).toEqual(next);
  });
  it("null handling", () => {
    expect(mergeHookSettings(null, null)).toBeNull();
    expect(mergeHookSettings(v31, null)).toEqual(v31);
    expect(mergeHookSettings(null, next)).toEqual(next);
  });
});

describe("v31Enforcing", () => {
  it("is true only when all four conditions hold", () => {
    for (const enabled of [undefined, true, false]) {
      for (const observeOnly of [undefined, true, false]) {
        for (const hookEnforcement of [undefined, true, false]) {
          for (const settingsFileExists of [true, false]) {
            const expected =
              enabled !== false &&
              observeOnly === false &&
              hookEnforcement === true &&
              settingsFileExists;
            expect(
              v31Enforcing({
                pluginConfig: { enabled, observeOnly, hookEnforcement },
                settingsFileExists,
              }),
            ).toBe(expected);
          }
        }
      }
    }
    expect(v31Enforcing({ pluginConfig: undefined, settingsFileExists: true })).toBe(false);
  });
  it("probeV31 uses the injected accessor and file check", () => {
    const cfg = { enabled: true, observeOnly: false, hookEnforcement: true };
    expect(probeV31({ readPluginConfig: () => cfg, exists: () => true })).toBe(true);
    expect(probeV31({ readPluginConfig: () => cfg, exists: () => false })).toBe(false);
    expect(
      probeV31({
        readPluginConfig: () => {
          throw new Error("x");
        },
        exists: () => true,
      }),
    ).toBe(false);
  });
});
