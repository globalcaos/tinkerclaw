import assert from "node:assert/strict";
import test from "node:test";
import { classifyResponse } from "../scripts/detect.mjs";

test("HTTP 503 → rate-limit", () => {
  const r = classifyResponse({ status: 503, body: "<html>error</html>" });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "rate-limit");
});

test("HTTP 502 → rate-limit (any 5xx)", () => {
  const r = classifyResponse({ status: 502, body: "" });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "rate-limit");
});

test("HTTP 200 with robot-check string → captcha", () => {
  const html = `<html><body>Enter the characters you see below</body></html>`;
  const r = classifyResponse({ status: 200, body: html });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "captcha");
});

test("HTTP 200 with Robot Check title → captcha", () => {
  const html = `<title>Robot Check</title><body>...</body>`;
  const r = classifyResponse({ status: 200, body: html });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "captcha");
});

test("HTTP 200 with amz-error spanish → amz-error", () => {
  const html = `<html>Lo sentimos, ha ocurrido un error</html>`;
  const r = classifyResponse({ status: 200, body: html });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "amz-error");
});

test("HTTP 200 with short body → suspicious-small-body", () => {
  const r = classifyResponse({ status: 200, body: "<html>tiny</html>" });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(r.reason, "suspicious-small-body");
});

test("HTTP 200 with real amazon.es title → OK", () => {
  const body =
    `<html><head><title>Amazon.es : ph minus</title></head><body>` +
    "x".repeat(6000) +
    `</body></html>`;
  const r = classifyResponse({ status: 200, body });
  assert.equal(r.outcome, "OK");
});
