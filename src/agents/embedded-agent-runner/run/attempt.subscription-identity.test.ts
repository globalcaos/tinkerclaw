import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// This boundary is assembled inside the full attempt; a handler-only fixture
// supplying identity cannot detect a production caller that omits it.
describe("embedded attempt subscription identity", () => {
  it("passes the actual attempt model to lifecycle observers", () => {
    const source = readFileSync(new URL("./attempt.ts", import.meta.url), "utf8");
    const subscription = source.slice(
      source.indexOf("buildEmbeddedSubscriptionParams({"),
      source.indexOf("const {\n        assistantTexts"),
    );
    expect(subscription).toContain("modelId: params.model.id");
    expect(subscription).toContain("modelProvider: params.model.provider");
  });
});
