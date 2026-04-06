/**
 * FORK: Tests for knowledge compiler.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyKnowledge, compileKnowledge, wordSetJaccard } from "../knowledge-compiler.js";

describe("classifyKnowledge", () => {
  it("classifies error-related tags as operational-lessons", () => {
    expect(classifyKnowledge("some summary", ["error", "gateway"])).toBe("operational-lessons");
    expect(classifyKnowledge("some summary", ["fix", "auth"])).toBe("operational-lessons");
    expect(classifyKnowledge("some summary", ["crash", "startup"])).toBe("operational-lessons");
    expect(classifyKnowledge("some summary", ["deploy", "prod"])).toBe("operational-lessons");
    expect(classifyKnowledge("some summary", ["incident", "p0"])).toBe("operational-lessons");
    expect(classifyKnowledge("some summary", ["bug", "ui"])).toBe("operational-lessons");
  });

  it("classifies API-related tags as domain-facts", () => {
    expect(classifyKnowledge("some summary", ["api", "endpoint"])).toBe("domain-facts");
    expect(classifyKnowledge("some summary", ["config", "json"])).toBe("domain-facts");
    expect(classifyKnowledge("some summary", ["architecture", "design"])).toBe("domain-facts");
    expect(classifyKnowledge("some summary", ["schema", "validation"])).toBe("domain-facts");
    expect(classifyKnowledge("some summary", ["build", "tooling"])).toBe("domain-facts");
  });

  it("classifies decision-related tags as decisions-log", () => {
    expect(classifyKnowledge("some summary", ["decided", "approach"])).toBe("decisions-log");
    expect(classifyKnowledge("some summary", ["chose", "framework"])).toBe("decisions-log");
    expect(classifyKnowledge("some summary", ["deprecate", "legacy"])).toBe("decisions-log");
    expect(classifyKnowledge("some summary", ["approve", "rfc"])).toBe("decisions-log");
  });

  it("classifies person-related tags as people-context", () => {
    expect(classifyKnowledge("some summary", ["team", "onboarding"])).toBe("people-context");
    expect(classifyKnowledge("some summary", ["role", "lead"])).toBe("people-context");
    expect(classifyKnowledge("some summary", ["contact", "support"])).toBe("people-context");
  });

  it("classifies person names in tags as people-context", () => {
    expect(classifyKnowledge("some summary", ["John Smith"])).toBe("people-context");
    expect(classifyKnowledge("some summary", ["Maria Garcia"])).toBe("people-context");
  });

  it("falls back to summary text when tags have no match", () => {
    expect(classifyKnowledge("Fixed a crash in the gateway", ["unrelated"])).toBe(
      "operational-lessons",
    );
    expect(classifyKnowledge("Updated the API endpoint for v2", ["unrelated"])).toBe(
      "domain-facts",
    );
    expect(classifyKnowledge("Decided to switch from REST to GraphQL", ["unrelated"])).toBe(
      "decisions-log",
    );
  });

  it("defaults to operational-lessons when nothing matches", () => {
    expect(classifyKnowledge("some unrelated summary", ["misc"])).toBe("operational-lessons");
  });

  it("respects priority order (operational > domain > decisions > people)", () => {
    // Tags with both error and api keywords — operational wins
    expect(classifyKnowledge("summary", ["error", "api"])).toBe("operational-lessons");
  });
});

describe("wordSetJaccard", () => {
  it("returns 1.0 for identical strings", () => {
    expect(wordSetJaccard("hello world test", "hello world test")).toBeCloseTo(1.0);
  });

  it("returns 0 for completely different strings", () => {
    expect(wordSetJaccard("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("returns ~0.2 for low overlap", () => {
    // "hello world test" and "hello earth moon" share "hello" (1 word > 2 chars out of 5 unique)
    const result = wordSetJaccard("hello world test", "hello earth moon");
    expect(result).toBeCloseTo(1 / 5, 2); // 1 shared / 5 unique
  });

  it("ignores short words (<=2 chars)", () => {
    expect(wordSetJaccard("a an is", "a an is")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(wordSetJaccard("", "hello")).toBe(0);
    expect(wordSetJaccard("hello", "")).toBe(0);
  });
});

describe("compileKnowledge", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates knowledge files organized by category", async () => {
    const result = await compileKnowledge({
      summaries: [
        {
          text: "Fixed a crash in the gateway startup sequence",
          id: "ep-1",
          timestamp: Date.now(),
          tags: ["error", "gateway"],
        },
        {
          text: "The API endpoint for user profiles accepts JSON and form data",
          id: "ep-2",
          timestamp: Date.now(),
          tags: ["api", "endpoint"],
        },
      ],
      knowledgeDir: tempDir,
    });

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.byCategory["operational-lessons"]).toBe(1);
    expect(result.byCategory["domain-facts"]).toBe(1);

    expect(existsSync(join(tempDir, "operational-lessons.md"))).toBe(true);
    expect(existsSync(join(tempDir, "domain-facts.md"))).toBe(true);

    const opsContent = readFileSync(join(tempDir, "operational-lessons.md"), "utf-8");
    expect(opsContent).toContain("Fixed a crash in the gateway startup sequence");
    expect(opsContent).toContain("[operational-lessons]");
  });

  it("deduplicates identical entries (Jaccard > 0.8)", async () => {
    // First compile
    await compileKnowledge({
      summaries: [
        {
          text: "Fixed a crash in the gateway startup sequence during deploy",
          id: "ep-1",
          timestamp: Date.now(),
          tags: ["error"],
        },
      ],
      knowledgeDir: tempDir,
    });

    // Second compile with nearly identical text
    const result = await compileKnowledge({
      summaries: [
        {
          text: "Fixed a crash in the gateway startup sequence during deploy",
          id: "ep-2",
          timestamp: Date.now(),
          tags: ["error"],
        },
      ],
      knowledgeDir: tempDir,
    });

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
  });

  it("allows sufficiently different entries (Jaccard < 0.8)", async () => {
    // First compile
    await compileKnowledge({
      summaries: [
        {
          text: "Fixed a crash in the gateway startup sequence during deploy",
          id: "ep-1",
          timestamp: Date.now(),
          tags: ["error"],
        },
      ],
      knowledgeDir: tempDir,
    });

    // Second compile with different text
    const result = await compileKnowledge({
      summaries: [
        {
          text: "OAuth token refresh logic has a race condition with concurrent writers",
          id: "ep-2",
          timestamp: Date.now(),
          tags: ["error"],
        },
      ],
      knowledgeDir: tempDir,
    });

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("creates the knowledge directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "deep", "nested", "knowledge");
    const result = await compileKnowledge({
      summaries: [
        {
          text: "Test entry for directory creation",
          id: "ep-1",
          timestamp: Date.now(),
          tags: ["error"],
        },
      ],
      knowledgeDir: nestedDir,
    });

    expect(result.added).toBe(1);
    expect(existsSync(join(nestedDir, "operational-lessons.md"))).toBe(true);
  });

  it("includes date headers in output", async () => {
    const timestamp = new Date("2026-04-06T12:00:00Z").getTime();
    await compileKnowledge({
      summaries: [
        {
          text: "Some operational lesson about deploys",
          id: "ep-1",
          timestamp,
          tags: ["deploy"],
        },
      ],
      knowledgeDir: tempDir,
    });

    const content = readFileSync(join(tempDir, "operational-lessons.md"), "utf-8");
    expect(content).toContain("## 2026-04-06");
  });

  it("handles empty summaries array", async () => {
    const result = await compileKnowledge({
      summaries: [],
      knowledgeDir: tempDir,
    });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
