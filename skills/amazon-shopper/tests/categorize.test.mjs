import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { categorize } from "../scripts/categorize.mjs";

function withMock(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const p = join(dir, "m.json");
  writeFileSync(p, JSON.stringify(payload));
  process.env.MOCK_LLM_RESPONSE_FILE = p;
  t.after(() => {
    delete process.env.MOCK_LLM_RESPONSE_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("returns axes and ≤2 qualifying questions from mock", async (t) => {
  withMock(t, {
    categorize: {
      axes: [
        { id: "form", values: ["powder", "liquid"] },
        { id: "package_size", values: ["small", "bulk"] },
      ],
      qualifying_questions: [
        {
          id: "form",
          text: "Powder or liquid?",
          options: ["powder", "liquid"],
          why_load_bearing: "different active ingredients",
        },
        {
          id: "volume",
          text: "Annual usage?",
          options: ["<2kg", "2-10kg", ">10kg"],
          why_load_bearing: "affects package-size filter",
        },
      ],
    },
  });
  const r = await categorize([
    { asin: "B0000001", title: "Bisulfato sódico 5kg" },
    { asin: "B0000002", title: "Reductor pH líquido 5L" },
  ]);
  assert.equal(r.axes.length, 2);
  assert.equal(r.qualifying_questions.length, 2);
  assert.ok(r.qualifying_questions.every((q) => q.why_load_bearing.length > 5));
});

test("trims to ≤2 questions even if LLM returns more", async (t) => {
  withMock(t, {
    categorize: {
      axes: [],
      qualifying_questions: [
        { id: "a", text: "x", options: [], why_load_bearing: "x reason" },
        { id: "b", text: "x", options: [], why_load_bearing: "y reason" },
        { id: "c", text: "x", options: [], why_load_bearing: "z reason" },
      ],
    },
  });
  const r = await categorize([{ asin: "B0000001", title: "x" }]);
  assert.equal(r.qualifying_questions.length, 2);
});
