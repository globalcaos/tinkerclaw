#!/usr/bin/env node
// demo.mjs — a complete, runnable table. Deliberately a NON-media domain, to
// show the vocabulary is about comparison, not about any one subject.
import { renderTable, chip, bar, num, absent, THEME } from "../lib/tables.mjs";

const HOSTS = [
  { name: "api-eu-1", tier: "best", region: "Frankfurt", p95: 42, rps: 1840, err: 0.01, cpu: 38 },
  { name: "api-eu-2", tier: "good", region: "Frankfurt", p95: 61, rps: 1610, err: 0.04, cpu: 52 },
  { name: "api-us-1", tier: "good", region: "Virginia", p95: 88, rps: 1200, err: 0.03, cpu: 47 },
  { name: "api-ap-1", tier: "ok", region: "Singapore", p95: 143, rps: 640, err: 0.09, cpu: 71 },
  { name: "api-ap-2", tier: "bad", region: "Singapore", p95: 410, rps: 95, err: 2.7, cpu: 96 },
];
const maxRps = Math.max(...HOSTS.map((h) => h.rps));
const maxP95 = Math.max(...HOSTS.map((h) => h.p95));

console.log("```html-render");
console.log(
  renderTable({
    title: "🖥️ API fleet — last 15 minutes",
    subtitle: "ranked by latency, then throughput; error rate gates everything",
    meta: "5 hosts · 3 regions",
    callout: {
      label: "HEALTHIEST",
      body: `<div style="font-size:13.5px;color:#f3e8d2">api-eu-1 · Frankfurt</div>
           <div style="color:${THEME.dim};font-size:11.5px;margin-top:4px">42 ms p95 · 1,840 rps · 0.01% errors · 38% CPU</div>`,
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
      `<span style="color:${THEME.faint}">${i + 1}</span>`,
      chip(h.name, h.tier),
      `<span style="color:${THEME.dim};font-size:12px">${h.region}</span>`,
      `${bar(maxP95 - h.p95 + 20, maxP95, h.tier)} ${num(h.p95, "ms")}`,
      `${bar(h.rps, maxRps, h.tier)} ${num(h.rps.toLocaleString(), "rps")}`,
      h.err > 1 ? `<span style="color:#e39a9a;font-weight:600">${h.err}%</span>` : num(`${h.err}%`),
      h.cpu > 90
        ? `<span style="color:#e39a9a;font-weight:600">${h.cpu}%</span>`
        : num(`${h.cpu}%`),
    ]),
    marks: HOSTS.map((h) => (h.tier === "best" ? "best" : h.tier === "bad" ? "bad" : null)),
    legend: [
      `<span>${chip("healthy", "best")}</span>`,
      `<span>${chip("degraded", "ok")}</span>`,
      `<span>${chip("failing", "bad")}</span>`,
      "<span>bar length = relative to the best host here</span>",
    ],
    footnote: `<b style="color:#c98a5a">2 hosts excluded</b> — draining (api-eu-3) and not yet in rotation (api-us-2). Excluded rows are never shown as rows; a silent filter looks like a broken query.`,
  }),
);
console.log("```");
