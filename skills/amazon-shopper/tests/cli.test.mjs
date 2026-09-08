import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOPPER = join(HERE, "..", "scripts", "shopper.mjs");
const FIXTURE_SEARCH = join(HERE, "fixtures", "search-ph-minus.html");

function runCli(args, env = {}) {
  const r = spawnSync("node", ["--experimental-sqlite", SHOPPER, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("end-to-end: start → answer → rank with mocked fetch + LLM", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ashop-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mock = {
    categorize: {
      axes: [{ id: "form", values: ["powder", "liquid"] }],
      qualifying_questions: [
        {
          id: "form",
          text: "Powder or liquid?",
          options: ["powder", "liquid"],
          why_load_bearing: "different active ingredients → different €/kg math",
        },
      ],
    },
    extract_spec: {
      active_ingredient: "sodium bisulfate",
      concentration_pct: 100,
      package_size_kg: 5,
      confidence: 0.9,
    },
    choose_metric: {
      metric_id: "eur_per_kg_active",
      formula_js: "p.current_price_eur / (p.package_size_kg * (p.concentration_pct/100))",
    },
  };
  const mockFile = join(dir, "mock.json");
  writeFileSync(mockFile, JSON.stringify(mock));

  const searchHtml = readFileSync(FIXTURE_SEARCH, "utf8");
  const homeHtml = "<html><head><title>Amazon.es</title></head>" + "x".repeat(6000) + "</html>";
  const detailHtml =
    "<html><head><title>Amazon.es : x</title></head>" + "y".repeat(6000) + "</html>";
  // Fixture map is DATA (url-substring -> body), parsed by the CLI. The old
  // AMAZON_SHOPPER_FETCH_MODULE hook import()ed a module path from the
  // environment, which was arbitrary code execution in the production CLI.
  const fixtures = {
    "/s?k=": searchHtml,
    "https://www.amazon.es/": homeHtml,
    "/dp/": detailHtml,
  };
  const fixturePath = join(dir, "fixtures.json");
  writeFileSync(fixturePath, JSON.stringify(fixtures));

  const env = {
    MOCK_LLM_RESPONSE_FILE: mockFile,
    AMAZON_SHOPPER_TEST_FIXTURES: fixturePath,
    AMAZON_SHOPPER_TMPDIR: dir,
  };

  const r1 = runCli(["start", "ph minus piscina"], env);
  assert.equal(r1.code, 0, `start failed: ${r1.stderr}`);
  const startOut = JSON.parse(r1.stdout);
  assert.ok(startOut.task_id, "should have task_id");
  assert.equal(startOut.state, "awaiting_questions");
  assert.ok(startOut.pending_questions.length >= 1, "should have ≥1 pending question");
  const taskId = startOut.task_id;
  const qId = startOut.pending_questions[0].id;

  const r2 = runCli(["answer", taskId, qId, "powder"], env);
  assert.equal(r2.code, 0, `answer failed: ${r2.stderr}`);
  const ansOut = JSON.parse(r2.stdout);
  assert.equal(ansOut.state, "ready_to_rank");

  const r3 = runCli(["rank", taskId], env);
  assert.equal(r3.code, 0, `rank failed: ${r3.stderr}`);
  const rankOut = JSON.parse(r3.stdout);
  assert.ok(Array.isArray(rankOut.top_3));
  assert.ok(rankOut.top_3.length >= 1, "should have ≥1 ranked product");

  const r4 = runCli(["close", taskId], env);
  assert.equal(r4.code, 0, `close failed: ${r4.stderr}`);
});
