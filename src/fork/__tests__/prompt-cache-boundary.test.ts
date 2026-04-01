import { describe, it, expect } from "vitest";
import {
  splitPromptAtBoundary,
  buildCacheAwareBlocks,
  buildCacheAwarePrompt,
  CACHE_BOUNDARY_MARKER,
} from "../prompt-cache-boundary.js";

describe("splitPromptAtBoundary", () => {
  it("splits at boundary marker", () => {
    const prompt = `static content\n${CACHE_BOUNDARY_MARKER}\ndynamic content`;
    const { staticSection, dynamicSection } = splitPromptAtBoundary(prompt);
    expect(staticSection).toBe("static content");
    expect(dynamicSection).toBe("dynamic content");
  });

  it("treats entire prompt as static when no boundary", () => {
    const { staticSection, dynamicSection } = splitPromptAtBoundary("all static");
    expect(staticSection).toBe("all static");
    expect(dynamicSection).toBe("");
  });

  it("handles boundary at start", () => {
    const prompt = `${CACHE_BOUNDARY_MARKER}\ndynamic only`;
    const { staticSection, dynamicSection } = splitPromptAtBoundary(prompt);
    expect(staticSection).toBe("");
    expect(dynamicSection).toBe("dynamic only");
  });

  it("handles boundary at end", () => {
    const prompt = `static only\n${CACHE_BOUNDARY_MARKER}`;
    const { staticSection, dynamicSection } = splitPromptAtBoundary(prompt);
    expect(staticSection).toBe("static only");
    expect(dynamicSection).toBe("");
  });

  it("trims whitespace around boundary", () => {
    const prompt = `static  \n  ${CACHE_BOUNDARY_MARKER}  \n  dynamic`;
    const { staticSection, dynamicSection } = splitPromptAtBoundary(prompt);
    expect(staticSection).toBe("static");
    expect(dynamicSection).toBe("dynamic");
  });

  it("handles empty prompt", () => {
    const { staticSection, dynamicSection } = splitPromptAtBoundary("");
    expect(staticSection).toBe("");
    expect(dynamicSection).toBe("");
  });
});

describe("buildCacheAwareBlocks", () => {
  it("adds cache_control to static block", () => {
    const blocks = buildCacheAwareBlocks("static part", "dynamic part");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].text).toBe("static part");
  });

  it("dynamic blocks have no cache_control", () => {
    const blocks = buildCacheAwareBlocks("static", "dynamic");
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toBe("dynamic");
  });

  it("handles empty dynamic section", () => {
    const blocks = buildCacheAwareBlocks("static only", "");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toBeDefined();
    expect(blocks[0].text).toBe("static only");
  });

  it("handles empty static section", () => {
    const blocks = buildCacheAwareBlocks("", "dynamic only");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[0].text).toBe("dynamic only");
  });

  it("handles both empty", () => {
    const blocks = buildCacheAwareBlocks("", "");
    expect(blocks).toHaveLength(0);
  });

  it("all blocks have type text", () => {
    const blocks = buildCacheAwareBlocks("a", "b");
    for (const block of blocks) {
      expect(block.type).toBe("text");
    }
  });
});

describe("buildCacheAwarePrompt", () => {
  it("splits and builds in one call", () => {
    const prompt = `static\n${CACHE_BOUNDARY_MARKER}\ndynamic`;
    const blocks = buildCacheAwarePrompt(prompt);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe("static");
    expect(blocks[0].cache_control).toBeDefined();
    expect(blocks[1].text).toBe("dynamic");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("treats no-boundary prompt as all static", () => {
    const blocks = buildCacheAwarePrompt("all static content");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toBeDefined();
  });
});
