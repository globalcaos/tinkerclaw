import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FALLBACK_PROMPT,
  SettingsError,
  defaults,
  ensurePrompt,
  findDefaultPrompt,
  mergePatch,
  objectiveLabel,
  readSettings,
  settingsPath,
  writeSettings,
} from "./settings.js";

let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "tb-settings-"));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

describe("mergePatch", () => {
  it("takes an objective from the list and trims the text fields", () => {
    const s = mergePatch(
      defaults(state),
      {
        objective: "research",
        strategy: "  read papers\r\nsummarize  ",
        dashboardUrl: " https://example.test/ ",
      },
      state,
    );
    expect(s.objective).toBe("research");
    expect(s.strategy).toBe("read papers\nsummarize");
    expect(s.dashboardUrl).toBe("https://example.test/");
  });

  it("refuses an objective that is not on the list", () => {
    expect(() => mergePatch(defaults(state), { objective: "world-domination" }, state)).toThrow(
      SettingsError,
    );
  });

  it("refuses unknown keys, non-text values and non-http dashboards", () => {
    expect(() => mergePatch(defaults(state), { model: "x" }, state)).toThrow(/unknown setting/);
    expect(() => mergePatch(defaults(state), { strategy: 3 }, state)).toThrow(/must be text/);
    expect(() =>
      mergePatch(defaults(state), { dashboardUrl: "javascript:alert(1)" }, state),
    ).toThrow(/http/);
    expect(() => mergePatch(defaults(state), null, state)).toThrow(/object/);
  });

  it("needs a name for a custom objective", () => {
    expect(() => mergePatch(defaults(state), { objective: "custom" }, state)).toThrow(/name/);
    const s = mergePatch(
      defaults(state),
      { objective: "custom", customName: "Ship the app" },
      state,
    );
    expect(objectiveLabel(s.objective, s.customName)).toBe("Ship the app");
  });

  it("keeps the prompt file under the state dir", () => {
    expect(() => mergePatch(defaults(state), { promptPath: "/etc/passwd.md" }, state)).toThrow(
      /under/,
    );
    expect(() =>
      mergePatch(defaults(state), { promptPath: join(state, "x.txt") }, state),
    ).toThrow();
    const s = mergePatch(
      defaults(state),
      { promptPath: join(state, "token-burner", "mine.md") },
      state,
    );
    expect(s.promptPath).toBe(join(state, "token-burner", "mine.md"));
    expect(mergePatch(s, { promptPath: "" }, state).promptPath).toBe(defaults(state).promptPath);
  });
});

describe("read and write", () => {
  it("round-trips through settings.json with an updatedAt stamp", () => {
    const s = mergePatch(defaults(state), { objective: "revenue", strategy: "sell" }, state);
    const saved = writeSettings(state, s, new Date("2026-11-03T10:00:00Z"));
    expect(saved.updatedAt).toBe("2026-11-03T10:00:00.000Z");
    const back = readSettings(state);
    expect(back.error).toBeUndefined();
    expect(back.settings).toEqual(saved);
    expect(JSON.parse(readFileSync(settingsPath(state), "utf8")).objective).toBe("revenue");
  });

  it("reads a broken file as the defaults and says why", () => {
    mkdirSync(join(state, "token-burner"), { recursive: true });
    writeFileSync(settingsPath(state), '{"objective":"nope"}');
    const back = readSettings(state);
    expect(back.settings.objective).toBe(defaults(state).objective);
    expect(back.error).toMatch(/objective/);
  });
});

describe("governing prompt", () => {
  it("copies the shipped default the first time and leaves an edited file alone", () => {
    const def = join(state, "default.md");
    writeFileSync(def, "# default\n");
    const path = join(state, "token-burner", "prompt.md");
    expect(ensurePrompt(path, def).created).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("# default\n");
    writeFileSync(path, "# mine\n");
    const again = ensurePrompt(path, def);
    expect(again.created).toBe(false);
    expect(again.mtime).toMatch(/^\d{4}-/);
    expect(readFileSync(path, "utf8")).toBe("# mine\n");
  });

  it("falls back to a built-in text when no default file is found", () => {
    const path = join(state, "token-burner", "prompt.md");
    ensurePrompt(path, null);
    expect(readFileSync(path, "utf8")).toBe(FALLBACK_PROMPT);
  });

  it("finds the default shipped in the skill folder of this checkout", () => {
    const found = findDefaultPrompt(__dirname, {});
    expect(found).toMatch(/skills\/token-burner\/prompts\/governing-prompt\.md$/);
    expect(existsSync(found!)).toBe(true);
  });
});
