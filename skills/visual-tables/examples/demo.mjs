#!/usr/bin/env node
// demo.mjs — a complete, runnable table. Deliberately a NON-media domain, to
// show the vocabulary is about comparison, not about any one subject.
// Every value here is plain data; the builders produce all markup.
import { renderTable, chip, bar, num, text, block, group } from "../lib/tables.mjs";

const HOSTS = [
  { name: "api-eu-1", tier: "best", region: "Frankfurt", p95: 42, rps: 1840, err: 0.01, cpu: 38 },
  { name: "api-eu-2", tier: "good", region: "Frankfurt", p95: 61, rps: 1610, err: 0.04, cpu: 52 },
  { name: "api-us-1", tier: "good", region: "Virginia", p95: 88, rps: 1200, err: 0.03, cpu: 47 },
  { name: "api-ap-1", tier: "ok", region: "Singapore", p95: 143, rps: 640, err: 0.09, cpu: 71 },
  { name: "api-ap-2", tier: "bad", region: "Singapore", p95: 410, rps: 95, err: 2.7, cpu: 96 },
];
const maxRps = Math.max(...HOSTS.map((h) => h.rps));
const maxP95 = Math.max(...HOSTS.map((h) => h.p95));
const alarm = (v) => text(v, { color: "bad", weight: 600 });

console.log("```html-render");
console.log(
  renderTable({
    title: "🖥️ API fleet — last 15 minutes",
    subtitle: "ranked by latency, then throughput; error rate gates everything",
    meta: "5 hosts · 3 regions",
    callout: {
      label: "HEALTHIEST",
      body: [
        block("api-eu-1 · Frankfurt", { size: 13.5, color: "#f3e8d2" }),
        block("42 ms p95 · 1,840 rps · 0.01% errors · 38% CPU", {
          color: "dim",
          size: 11.5,
          marginTop: 4,
        }),
      ],
    },
    columns: [
      { label: "#", align: "right" },
      { label: "Host", note: "colour = health tier" },
      { label: "Region" },
      { label: "p95 latency", note: "lower is better" },
      { label: "Throughput" },
      { label: "Errors", align: "right" },
      { label: "CPU", align: "right" },
    ],
    rows: HOSTS.map((h, i) => [
      text(i + 1, { color: "faint" }),
      chip(h.name, h.tier),
      text(h.region, { color: "dim", size: 12 }),
      group(bar(maxP95 - h.p95 + 20, maxP95, h.tier), " ", num(h.p95, "ms")),
      group(bar(h.rps, maxRps, h.tier), " ", num(h.rps.toLocaleString(), "rps")),
      h.err > 1 ? alarm(`${h.err}%`) : num(`${h.err}%`),
      h.cpu > 90 ? alarm(`${h.cpu}%`) : num(`${h.cpu}%`),
    ]),
    marks: HOSTS.map((h) => (h.tier === "best" ? "best" : h.tier === "bad" ? "bad" : null)),
    legend: [
      chip("healthy", "best"),
      chip("degraded", "ok"),
      chip("failing", "bad"),
      "bar length = relative to the best host here",
    ],
    footnote: [
      text("2 hosts excluded", { color: "#c98a5a", weight: 700 }),
      " — draining (api-eu-3) and not yet in rotation (api-us-2). Excluded rows are never shown as rows; a silent filter looks like a broken query.",
    ],
  }),
);
console.log("```");
