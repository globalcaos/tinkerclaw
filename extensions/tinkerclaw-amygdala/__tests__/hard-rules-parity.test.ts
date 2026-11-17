import { describe, expect, it } from "vitest";
import { serializeAegisRules } from "../../tinkerclaw-learned-intuition/src/rule-based-gate.js";
import { serializeRules } from "../src/rules.js";

// One amygdala (2026-10-15): the hook that blocks Claude workers reads src/rules.ts. The older in-process veto in
// tinkerclaw-learned-intuition still reads its own list; this test fails the moment the two drift apart.
// CREDENTIAL_FILE_PRINTED is a v2-only tightening (authorized 2026-09-29). One id can carry several patterns, so the
// lists are compared pattern by pattern, never by id alone.
// GUARD_SELF_ANSWER is a v2-only tightening too (2026-11-13: the agent must not answer the guard's question itself).
// GUARD_OWN_LIST_WRITE is a v2-only tightening (2026-11-16: the agent must not write the list of its own files).
const V2_ONLY = new Set(["CREDENTIAL_FILE_PRINTED", "GUARD_SELF_ANSWER", "GUARD_OWN_LIST_WRITE"]);

type R = {
  id: string;
  source: string;
  flags?: string;
  scope?: string;
  enforce?: boolean;
  ownerIntent?: string;
};
const key = (r: R): string =>
  JSON.stringify([
    r.id,
    r.source,
    r.flags ?? "",
    r.scope ?? "",
    r.enforce ?? false,
    r.ownerIntent ?? null,
  ]);

describe("hard rules: one list in practice", () => {
  it("rules.ts holds exactly the v3.1 patterns, plus the v2-only tightenings", () => {
    const v31 = (serializeAegisRules() as R[]).map(key).sort();
    const ours = (serializeRules() as R[])
      .filter((r) => !V2_ONLY.has(r.id))
      .map(key)
      .sort();
    expect(ours).toEqual(v31);
  });
});
