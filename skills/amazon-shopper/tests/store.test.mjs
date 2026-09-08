import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Run with: node --experimental-sqlite --test tests/store.test.mjs
import test from "node:test";
import { openTaskStore, generateTaskId, STATES } from "../scripts/store.mjs";

function tmpDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "ashop-test-"));
  const dbPath = join(dir, "test.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dbPath;
}

test("openTaskStore creates schema and inserts task", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "ph minus" });
  const task = store.getTask(id);
  assert.equal(task.id, id);
  assert.equal(task.keywords, "ph minus");
  assert.equal(task.state, STATES.SEARCHING);
  assert.ok(task.created_at > 0);
  store.close();
});

test("insertProducts is atomic — 50 products, no lost rows", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "test" });
  const products = Array.from({ length: 50 }, (_, i) => ({
    asin: `B${String(i).padStart(9, "0")}`,
    position: i + 1,
    title: `Product ${i}`,
    url: `https://amazon.es/dp/B${String(i).padStart(9, "0")}`,
    current_price_eur: 10 + i,
  }));
  store.insertProducts(id, products);
  assert.equal(store.countProducts(id), 50);
  store.close();
});

test("setTaskState advances state with idempotent re-apply", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "test" });
  store.setTaskState(id, STATES.AWAITING_QUESTIONS);
  store.setTaskState(id, STATES.AWAITING_QUESTIONS);
  assert.equal(store.getTask(id).state, STATES.AWAITING_QUESTIONS);
  store.close();
});

test("setTaskBlocked records reason", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "test" });
  store.setTaskBlocked(id, "captcha");
  const task = store.getTask(id);
  assert.equal(task.state, STATES.BLOCKED);
  assert.equal(task.blocked_reason, "captcha");
  store.close();
});

test("insertPendingQuestion + recordAnswer + pendingQuestions", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "test" });
  store.insertPendingQuestion(id, {
    id: "form",
    text: "Powder or liquid?",
    options: ["powder", "liquid", "either"],
    why_load_bearing: "Different active ingredients → different €/kg math",
  });
  let pending = store.pendingQuestions(id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "form");
  store.recordAnswer(id, "form", "powder");
  pending = store.pendingQuestions(id);
  assert.equal(pending.length, 0);
  assert.equal(store.getAnswer(id, "form"), "powder");
  store.close();
});

test("updateProductDetail sets spec_status + concentration", (t) => {
  const dbPath = tmpDb(t);
  const store = openTaskStore(dbPath);
  const id = generateTaskId();
  store.createTask({ id, keywords: "test" });
  store.insertProducts(id, [
    {
      asin: "B000000001",
      position: 1,
      title: "Bisulfato 5kg",
      url: "x",
      current_price_eur: 25,
    },
  ]);
  store.updateProductDetail("B000000001", {
    active_ingredient: "sodium bisulfate",
    concentration_pct: 100,
    package_size_kg: 5,
    spec_status: "ok",
    spec_source: "amazon",
  });
  const p = store.getProductByAsin("B000000001");
  assert.equal(p.active_ingredient, "sodium bisulfate");
  assert.equal(p.spec_status, "ok");
  store.close();
});
