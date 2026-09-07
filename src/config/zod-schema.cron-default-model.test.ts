import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("cron.defaultModel config", () => {
  it("accepts and trims a non-empty model reference", () => {
    const parsed = OpenClawSchema.parse({
      cron: { defaultModel: "  openai/gpt-5.4  " },
    });

    expect(parsed.cron?.defaultModel).toBe("openai/gpt-5.4");
  });

  it("rejects an empty model reference", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: { defaultModel: "   " },
      }),
    ).toThrow(/defaultModel|too small/i);
  });
});
