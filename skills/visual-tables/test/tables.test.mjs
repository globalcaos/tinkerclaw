// Run: node --test test/tables.test.mjs
// Every input field receives hostile markup; none of it may survive as a tag,
// attribute, event handler or CSS escape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTable, chip, bar, num, absent, text, block, group } from "../lib/tables.mjs";

const P = `<img src=x onerror="alert(1)"><script>fetch('//evil')</script>`;

function assertInert(html) {
  assert.ok(!/<img|<script|<a\b|<iframe|<form|<link|<style|<object|<embed/i.test(html), html);
  assert.ok(!/\son[a-z]+=["']|url\(/i.test(html), html);
}

test("every renderTable field is escaped", () => {
  const html = renderTable({
    title: P,
    subtitle: P,
    meta: P,
    callout: { label: P, body: P },
    columns: [{ label: P, note: P, align: P }],
    rows: [[P, [P, P]]],
    marks: [P],
    legend: [P],
    footnote: P,
  });
  assertInert(html);
  assert.ok(html.includes("&lt;img"));
});

test("builders escape their text and reject free-form CSS", () => {
  const css = "red;background:url(//evil/x.png)";
  const html = [
    chip(P, P),
    bar(P, P, P, P),
    num(P, P, css),
    absent(P),
    text(P, { color: css, size: css, weight: css, marginTop: css }),
    block(P, { color: css }),
    group(P, text(P)),
  ].join("");
  assertInert(html);
});

test("a string that looks like a fragment is still text", () => {
  const fake = { markup: P, toString: () => P };
  assertInert(renderTable({ title: fake, columns: [{ label: "a" }], rows: [[fake]] }));
});

test("builder output composes as markup", () => {
  const html = renderTable({
    title: "t",
    columns: [{ label: "a" }],
    rows: [[chip("x", "best")]],
    legend: [chip("y", "bad")],
  });
  assert.ok(html.includes('<span style="display:inline-block;padding:2px 7px'));
  assert.ok(text("hi", { color: "bad" }).toString().includes("color:#e39a9a"));
});
