import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callLLM } from "../scripts/llm.mjs";

function withMockFile(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), "ashop-llm-"));
  const p = join(dir, "mock.json");
  writeFileSync(p, JSON.stringify(payload));
  process.env.MOCK_LLM_RESPONSE_FILE = p;
  t.after(() => {
    delete process.env.MOCK_LLM_RESPONSE_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
  return p;
}

test("returns mocked response for matching call_site", async (t) => {
  withMockFile(t, {
    categorize: { axes: [{ id: "form", values: ["powder", "liquid"] }], qualifying_questions: [] },
  });
  const r = await callLLM({ call_site: "categorize", system: "...", user: "..." });
  assert.deepEqual(r.axes[0].id, "form");
});

test("throws if mock has no entry for call_site", async (t) => {
  withMockFile(t, { other_site: {} });
  await assert.rejects(
    () => callLLM({ call_site: "categorize", system: "...", user: "..." }),
    /mock has no entry/,
  );
});
