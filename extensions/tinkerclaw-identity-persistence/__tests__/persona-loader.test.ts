import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Tests for persona loading from SOUL.md, IDENTITY.md, and persona.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadPersonaFromFiles, createCortexRuntime } from "../src/cortex-runtime.js";
import {
  createDefaultPersonaState,
  validatePersonaState,
  PersonaStateValidationError,
} from "../src/persona-state.js";

describe("Persona Loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("loads persona from SOUL.md", () => {
    const soulContent = `# Jarvis

## Identity
A witty AI assistant who serves as an extension of the user.

## Voice (core)
- Avg sentence length: 20 words
- Vocabulary: technical
- Hedging: rare
- Emoji: never`;

    writeFileSync(join(dir, ".openclaw", "SOUL.md"), soulContent);

    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("Jarvis");
    expect(persona.identityStatement).toContain("witty AI assistant");
    expect(persona.voiceMarkers.avgSentenceLength).toBe(20);
    expect(persona.voiceMarkers.vocabularyTier).toBe("technical");
    expect(persona.voiceMarkers.hedgingLevel).toBe("rare");
    expect(persona.voiceMarkers.emojiUsage).toBe("never");
  });

  it("generates default persona when SOUL.md missing", () => {
    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("JarvisOne");
    expect(persona.identityStatement).toBe("AI assistant and extension of the user");
    expect(persona.version).toBe(1);
    expect(persona.voiceMarkers.vocabularyTier).toBe("standard");
  });

  it("prefers persona.json over SOUL.md when both exist", () => {
    writeFileSync(join(dir, ".openclaw", "SOUL.md"), "# From SOUL\n\nSome identity from SOUL.");
    const personaJson = createDefaultPersonaState("FromJSON", "Identity from JSON file");
    writeFileSync(join(dir, ".openclaw", "persona.json"), JSON.stringify(personaJson));

    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("FromJSON");
    expect(persona.identityStatement).toBe("Identity from JSON file");
  });

  it("falls through to SOUL.md when persona.json is invalid", () => {
    writeFileSync(
      join(dir, ".openclaw", "SOUL.md"),
      "# FallbackName\n\n## Identity\nFallback identity.",
    );
    writeFileSync(join(dir, ".openclaw", "persona.json"), "not-valid-json{{{");

    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("FallbackName");
    expect(persona.identityStatement).toContain("Fallback identity");
  });

  it("IDENTITY.md overrides inline identity from SOUL.md", () => {
    writeFileSync(join(dir, ".openclaw", "SOUL.md"), "# TestBot\n\n## Identity\nFrom SOUL.");
    writeFileSync(join(dir, ".openclaw", "IDENTITY.md"), "Override identity from IDENTITY.md");

    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("TestBot");
    expect(persona.identityStatement).toBe("Override identity from IDENTITY.md");
  });

  it("respects custom soulPath option", () => {
    const customPath = join(dir, "custom-soul.md");
    writeFileSync(customPath, "# CustomBot\n\n## Identity\nCustom persona.");

    const persona = loadPersonaFromFiles({ soulPath: customPath });
    expect(persona.name).toBe("CustomBot");
  });

  it("respects name override option", () => {
    writeFileSync(join(dir, ".openclaw", "SOUL.md"), "# OriginalName\n\nSome identity.");
    const persona = loadPersonaFromFiles({ name: "OverrideName" });
    expect(persona.name).toBe("OverrideName");
  });

  it("loads from engram/persona-state.json as secondary fallback", () => {
    mkdirSync(join(dir, ".openclaw", "engram"), { recursive: true });
    const ps = createDefaultPersonaState("EngramBot", "From engram persona state");
    writeFileSync(join(dir, ".openclaw", "engram", "persona-state.json"), JSON.stringify(ps));

    const persona = loadPersonaFromFiles({});
    expect(persona.name).toBe("EngramBot");
  });

  it("parses humor settings from SOUL.md", () => {
    const soulContent = `# Bot

## Humor
- Frequency: 0.7
- Sensitivity: 0.3`;

    writeFileSync(join(dir, ".openclaw", "SOUL.md"), soulContent);

    const persona = loadPersonaFromFiles({});
    expect(persona.humor.humorFrequency).toBe(0.7);
    expect(persona.humor.sensitivityThreshold).toBe(0.3);
  });
});

describe("PersonaState Validation", () => {
  it("validates a correct PersonaState", () => {
    const ps = createDefaultPersonaState("Test", "Test identity");
    expect(() => validatePersonaState(ps)).not.toThrow();
    const result = validatePersonaState(ps);
    expect(result.name).toBe("Test");
  });

  it("rejects null input", () => {
    expect(() => validatePersonaState(null)).toThrow(PersonaStateValidationError);
  });

  it("rejects missing required fields", () => {
    expect(() => validatePersonaState({ version: 1 })).toThrow("Missing or empty required field");
  });

  it("rejects invalid version", () => {
    const ps = createDefaultPersonaState("Test", "Test") as Record<string, unknown>;
    ps.version = 0;
    expect(() => validatePersonaState(ps)).toThrow("version must be a positive integer");
  });

  it("rejects non-array hardRules", () => {
    const ps = createDefaultPersonaState("Test", "Test") as Record<string, unknown>;
    ps.hardRules = "not-an-array";
    expect(() => validatePersonaState(ps)).toThrow("hardRules must be an array");
  });
});

describe("CortexRuntime factory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-rt-"));
    vi.stubEnv("HOME", dir);
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("creates runtime with default persona", () => {
    const rt = createCortexRuntime();
    expect(rt.persona.name).toBe("JarvisOne");
    expect(rt.ewmaSyncScore).toBe(1.0);
  });

  it("caches persona block on repeated calls", () => {
    const rt = createCortexRuntime();
    const block1 = rt.getPersonaBlock();
    const block2 = rt.getPersonaBlock();
    expect(block1).toBe(block2); // same reference (cached)
    expect(block1).toContain("JarvisOne");
  });
});
