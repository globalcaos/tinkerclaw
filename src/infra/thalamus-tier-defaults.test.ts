import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThalamusDefaultsRequest,
  clearThalamusTierDefaultsCache,
  legacyDefaultsView,
  readThalamusTierDefaults,
  thalamusSuggestionForBias,
  thalamusTierForBias,
  writeThalamusSuggestion,
} from "./thalamus-tier-defaults.js";

describe("thalamusTierForBias", () => {
  it("maps the seven dial stops onto budget / default / smart", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(thalamusTierForBias)).toEqual([
      "budget",
      "budget",
      "budget",
      "default",
      "smart",
      "smart",
      "smart",
    ]);
  });
  it("reads an unset dial as the middle stop, default (the architect, 2026-10-02)", () => {
    expect(thalamusTierForBias(undefined)).toBe("default");
  });
});

describe("readThalamusTierDefaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "thal-tiers-"));
  const file = join(dir, "t.json");
  beforeEach(() => clearThalamusTierDefaultsCache());

  it("returns {} for a missing file", () => {
    expect(readThalamusTierDefaults({ file: join(dir, "absent.json") })).toEqual({});
  });
  it("reads the new shape: a model and an effort per stop", () => {
    writeFileSync(
      file,
      JSON.stringify({
        smart: { model: "claude-code/claude-opus-5-5", effort: "max" },
        default: { model: "claude-code/claude-sonnet-5-5", effort: "low" },
        budget: { model: "xai/grok-4.7" },
      }),
    );
    expect(readThalamusTierDefaults({ file })).toEqual({
      smart: { model: "claude-code/claude-opus-5-5", effort: "max" },
      default: { model: "claude-code/claude-sonnet-5-5", effort: "low" },
      budget: { model: "xai/grok-4.7" },
    });
  });
  it("still reads the old file: high / medium / low strings map to smart / default / budget with no effort", () => {
    writeFileSync(
      file,
      JSON.stringify({
        medium: "claude-code/claude-sonnet-5-5",
        low: "xai/grok-4.7",
        high: "claude-code/claude-opus-5-5",
      }),
    );
    expect(readThalamusTierDefaults({ file })).toEqual({
      smart: { model: "claude-code/claude-opus-5-5" },
      default: { model: "claude-code/claude-sonnet-5-5" },
      budget: { model: "xai/grok-4.7" },
    });
  });
  it("when a stop has both spellings the new one wins", () => {
    writeFileSync(
      file,
      JSON.stringify({ high: "a/old", smart: { model: "a/new", effort: "high" } }),
    );
    expect(readThalamusTierDefaults({ file }).smart).toEqual({ model: "a/new", effort: "high" });
  });
  it("keeps provider/model refs and drops anything else, and drops a malformed effort but keeps the model", () => {
    writeFileSync(
      file,
      JSON.stringify({
        smart: { model: "claude-code/claude-fable-5-1", effort: "MAX!!" },
        default: "opus",
        budget: 3,
      }),
    );
    expect(readThalamusTierDefaults({ file })).toEqual({
      smart: { model: "claude-code/claude-fable-5-1" },
    });
  });
  it("treats a corrupt file as no preference", () => {
    writeFileSync(file, "{not json");
    expect(readThalamusTierDefaults({ file })).toEqual({});
  });
  it("answers for the dial's stop, and for an unset dial the middle one", () => {
    writeFileSync(
      file,
      JSON.stringify({
        smart: { model: "a/s" },
        default: { model: "a/d" },
        budget: { model: "a/b" },
      }),
    );
    expect(thalamusSuggestionForBias(6, { file })?.model).toBe("a/s");
    expect(thalamusSuggestionForBias(1, { file })?.model).toBe("a/b");
    expect(thalamusSuggestionForBias(undefined, { file })?.model).toBe("a/d");
  });
});

describe("writeThalamusSuggestion", () => {
  const dir = mkdtempSync(join(tmpdir(), "thal-tiers-w-"));
  beforeEach(() => clearThalamusTierDefaultsCache());

  it("migrates the old file into the new shape on the first write and keeps the other stops", () => {
    const file = join(dir, "migrate.json");
    writeFileSync(file, JSON.stringify({ high: "a/old-smart", low: "x/cheap" }));
    const out = writeThalamusSuggestion(
      "default",
      { model: "claude-code/claude-sonnet-5-5", effort: "low" },
      { file },
    );
    expect(out).toEqual({
      smart: { model: "a/old-smart" },
      default: { model: "claude-code/claude-sonnet-5-5", effort: "low" },
      budget: { model: "x/cheap" },
    });
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(Object.keys(onDisk).sort()).toEqual(["budget", "default", "smart"]);
    expect(readThalamusTierDefaults({ file })).toEqual(out);
  });
  it("clears a stop with null and rejects a bad ref", () => {
    const file = join(dir, "clear.json");
    writeThalamusSuggestion("smart", { model: "a/b", effort: "max" }, { file });
    expect(writeThalamusSuggestion("smart", null, { file })).toEqual({});
    expect(() => writeThalamusSuggestion("smart", { model: "nope" }, { file })).toThrow();
  });
  it("shows a page built before 2026-10-02 the old high / medium / low model view", () => {
    expect(
      legacyDefaultsView({ smart: { model: "a/s", effort: "max" }, budget: { model: "a/b" } }),
    ).toEqual({ high: "a/s", low: "a/b" });
  });
});

describe("applyThalamusDefaultsRequest — what the picker's right-click sends", () => {
  const dir = mkdtempSync(join(tmpdir(), "thal-tiers-rpc-"));
  const fresh = (name: string) => {
    clearThalamusTierDefaultsCache();
    return { file: join(dir, `${name}.json`) };
  };

  it("reads with no tier: the new shape and the old model-per-tier view", () => {
    const o = fresh("read");
    writeFileSync(o.file, JSON.stringify({ high: "a/s", low: "b/c" }));
    const out = applyThalamusDefaultsRequest({}, o);
    expect(out).toEqual({
      ok: true,
      defaults: { high: "a/s", low: "b/c" },
      suggestions: { smart: { model: "a/s" }, budget: { model: "b/c" } },
    });
  });

  it("gives a model newly assigned to a stop the effort low (the architect, 2026-10-02)", () => {
    const o = fresh("new");
    const out = applyThalamusDefaultsRequest(
      { tier: "default", model: "claude-code/claude-sonnet-5-5" },
      o,
    );
    expect(out).toMatchObject({
      ok: true,
      suggestions: { default: { model: "claude-code/claude-sonnet-5-5", effort: "low" } },
    });
  });

  it("accepts the old stop names, and writes the file in the new shape", () => {
    const o = fresh("legacy");
    applyThalamusDefaultsRequest({ tier: "high", model: "a/s" }, o);
    expect(Object.keys(JSON.parse(readFileSync(o.file, "utf-8")))).toEqual(["smart"]);
  });

  it("re-assigning the same model keeps the effort the stop had; a different model starts at low again", () => {
    const o = fresh("same");
    applyThalamusDefaultsRequest({ tier: "smart", model: "a/s" }, o);
    applyThalamusDefaultsRequest({ tier: "smart", effort: "max" }, o);
    const again = applyThalamusDefaultsRequest({ tier: "smart", model: "a/s" }, o);
    expect(again).toMatchObject({
      ok: true,
      suggestions: { smart: { model: "a/s", effort: "max" } },
    });
    const other = applyThalamusDefaultsRequest({ tier: "smart", model: "b/t" }, o);
    expect(other).toMatchObject({
      ok: true,
      suggestions: { smart: { model: "b/t", effort: "low" } },
    });
  });

  it("assigns an effort to the model a stop already holds, and clears it with null", () => {
    const o = fresh("effort");
    applyThalamusDefaultsRequest({ tier: "budget", model: "x/g" }, o);
    expect(applyThalamusDefaultsRequest({ tier: "budget", effort: "high" }, o)).toMatchObject({
      suggestions: { budget: { model: "x/g", effort: "high" } },
    });
    expect(applyThalamusDefaultsRequest({ tier: "budget", effort: null }, o)).toMatchObject({
      suggestions: { budget: { model: "x/g" } },
    });
  });

  it("clears a stop with model null", () => {
    const o = fresh("clear");
    applyThalamusDefaultsRequest({ tier: "smart", model: "a/s" }, o);
    expect(applyThalamusDefaultsRequest({ tier: "smart", model: null }, o)).toMatchObject({
      ok: true,
      suggestions: {},
    });
  });

  it("refuses a bad stop, model, or effort, and an effort for a stop with no model", () => {
    const o = fresh("bad");
    expect(applyThalamusDefaultsRequest({ tier: "medium-ish", model: "a/b" }, o)).toMatchObject({
      ok: false,
    });
    expect(applyThalamusDefaultsRequest({ tier: "smart", model: "nope" }, o)).toMatchObject({
      ok: false,
    });
    expect(
      applyThalamusDefaultsRequest({ tier: "smart", model: "a/b", effort: "MAX!" }, o),
    ).toMatchObject({
      ok: false,
    });
    expect(applyThalamusDefaultsRequest({ tier: "default", effort: "high" }, o)).toMatchObject({
      ok: false,
    });
  });
});
