import assert from "node:assert/strict";
import { test } from "node:test";
import { isTestFile } from "./capability-coverage.mjs";
// Tests for the capability-coverage scorer's test-file filter. Dependency-free; run with:
//   node --test scripts/bible/capability-coverage.test.mjs
//
// WHY THIS EXISTS: the judgement `scope:tests-excluded` says test code never counts as a
// capability. On 2026-10-01 `tinker-ui/src/panels/routing-rationale.golden.fixtures.ts`, the
// golden fixtures for a panel test, was scored as a BLIND UI panel because the filter knew
// `.test.ts` and `test-helpers` but not fixture files. One misread is one point on a ratchet that
// fails the build, so the filter is pinned here.

test("fixture files are test code, whatever their prefix", () => {
  for (const name of [
    "routing-rationale.golden.fixtures.ts",
    "auth-profiles.resolve-auth-profile-order.fixtures.ts",
    "run.overflow-compaction.fixture.ts",
    "test-fixtures.ts",
    "monitor.test-fixtures.ts",
  ])
    assert.equal(isTestFile(name), true, name);
});

test("the names already excluded stay excluded", () => {
  for (const name of [
    "thalamus-v4-card.test.ts",
    "x.spec.ts",
    "test-helpers.ts",
    "test-harness.ts",
  ])
    assert.equal(isTestFile(name), true, name);
});

test("real modules are not test code, including ones that merely mention fixtures", () => {
  for (const name of [
    "thalamus-v4-card.ts",
    "routing-rationale.ts",
    "scenario-media-fixtures.ts",
    "dev-capture-fixtures.mjs",
  ])
    assert.equal(isTestFile(name), false, name);
});
