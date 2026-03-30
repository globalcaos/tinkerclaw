/**
 * Tests for observation extraction (facts, preferences, beliefs).
 */
import { describe, it, expect } from "vitest";
import {
  createObservationExtractor,
  extractFromMessage,
  DEFAULT_OBSERVATION_THRESHOLD,
} from "../src/observation-runtime.js";

describe("Observation Extraction", () => {
  it("extracts facts from user messages", () => {
    const obs = extractFromMessage("I work at Acme Corp as a developer. We use TypeScript daily.");
    expect(obs.length).toBeGreaterThan(0);
    const facts = obs.filter((o) => o.type === "fact");
    expect(facts.length).toBeGreaterThan(0);
  });

  it("extracts preferences from user messages", () => {
    const obs = extractFromMessage("I prefer dark mode for all my editors. I always use Vim.");
    const prefs = obs.filter((o) => o.type === "preference");
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs[0].confidence).toBe(0.8);
  });

  it("extracts beliefs from user messages", () => {
    const obs = extractFromMessage("I think TypeScript is better than JavaScript. In my opinion, Rust is the future.");
    const beliefs = obs.filter((o) => o.type === "belief");
    expect(beliefs.length).toBeGreaterThan(0);
    expect(beliefs[0].confidence).toBe(0.75);
  });

  it("returns empty array for non-classifiable messages", () => {
    const obs = extractFromMessage("Hello.");
    expect(obs).toHaveLength(0);
  });

  it("skips very short fragments", () => {
    const obs = extractFromMessage("OK. Yes. No.");
    expect(obs).toHaveLength(0);
  });

  it("preference takes precedence over fact when both match", () => {
    const obs = extractFromMessage("I always use Python for scripting tasks.");
    // "I always" matches preference pattern
    expect(obs.length).toBeGreaterThan(0);
    expect(obs[0].type).toBe("preference");
  });

  it("includes source messages in observations", () => {
    const msg = "I work at a startup building AI tools.";
    const obs = extractFromMessage(msg);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs[0].sourceMessages).toContain(msg);
  });
});

describe("ObservationExtractor (threshold-based batch)", () => {
  it("default threshold is 30K tokens", () => {
    expect(DEFAULT_OBSERVATION_THRESHOLD).toBe(30_000);
  });

  it("does not extract below threshold", () => {
    const extractor = createObservationExtractor();
    const result = extractor.extractObservations(["I work at Acme."]);
    expect(result).toHaveLength(0);
    expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(0);
  });

  it("extracts when threshold is crossed", () => {
    const extractor = createObservationExtractor();
    // Use a low threshold for testing
    const result = extractor.extractObservations(
      ["I work at Acme Corp as a software engineer."],
      10, // very low threshold
    );
    expect(result.length).toBeGreaterThan(0);
    expect(extractor.tokensSinceLastExtraction).toBe(0); // reset after extraction
    expect(extractor.totalExtracted).toBeGreaterThan(0);
  });

  it("accumulates tokens across calls", () => {
    const extractor = createObservationExtractor();
    extractor.extractObservations(["Short msg."]);
    const tokens1 = extractor.tokensSinceLastExtraction;
    extractor.extractObservations(["Another short msg."]);
    expect(extractor.tokensSinceLastExtraction).toBeGreaterThan(tokens1);
  });

  it("persists to event store when provided", () => {
    const events: unknown[] = [];
    const mockStore = {
      sessionKey: "test-session",
      append(event: unknown) {
        events.push(event);
      },
    };

    const extractor = createObservationExtractor(mockStore);
    extractor.extractObservations(
      ["I work at Acme Corp and I prefer TypeScript."],
      1, // low threshold to trigger extraction
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("works without event store (no persistence)", () => {
    const extractor = createObservationExtractor();
    const result = extractor.extractObservations(
      ["I believe in test-driven development."],
      1,
    );
    expect(result.length).toBeGreaterThan(0);
    // No crash, no event store needed
  });
});
