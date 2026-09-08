#!/usr/bin/env node
// sdcard-chart.mjs — render the microSD dataset as a linked, colour-coded chart.
//
// Design notes (2026-08-06, after a first attempt that was rightly rejected):
//   - EVERY point is an <a> to the product. A shopping chart whose points are
//     not clickable makes the reader do the lookup by hand, which defeats it.
//   - Colour encodes SPEED CLASS, not price. Two cards at the same €/GB can
//     differ 10x in sustained write speed, so a mono-colour price chart quietly
//     recommends the wrong card.
//   - The marking legend is part of the deliverable, not an appendix: A2/U3/V30
//     are the whole reason two identical-looking cards cost different money.
//
// Usage: node sdcard-chart.mjs <dataset.json> <out.html> [--title "..."]

import fs from "node:fs";

const [, , inPath, outPath] = process.argv;
const titleFlag = process.argv.indexOf("--title");
const HEADING = titleFlag > -1 ? process.argv[titleFlag + 1] : "microSD — next-day delivery";
if (!inPath || !outPath) {
  console.error("usage: sdcard-chart.mjs <dataset.json> <out.html> [--title T]");
  process.exit(3);
}

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));

// Accept RAW extractor rows as well as a pre-enriched dataset. Keeping a
// separate "enriched" file format meant two places could disagree about what
// €/GB means; enriching here makes fast-search's output directly chartable.
const { parseSdCard } = await import("./sdcard-spec.mjs");
const MIN_GB = Number(process.env.SDCARD_MIN_GB || 128);
const rows =
  raw[0] && "eur_gb" in raw[0]
    ? raw
    : raw
        .map((r) => {
          const s = parseSdCard(r.title);
          if (!s.capacity_gb || s.capacity_gb < MIN_GB) return null;
          if (!r.current_price_eur || !r.delivery_tomorrow) return null;
          const unit = r.current_price_eur / s.pack_count;
          return {
            asin: r.asin,
            title: String(r.title).replace(/^[–-]\s*/, ""),
            url: r.url,
            price: r.current_price_eur,
            unit_price: +unit.toFixed(2),
            gb: s.capacity_gb,
            pack: s.pack_count,
            eur_gb: +(unit / s.capacity_gb).toFixed(4),
            marks: s.marks_label,
            tier: s.tier,
            tierName: s.name,
            rating: r.rating,
            reviews: r.review_count,
            delivery: r.delivery_free || r.delivery_fastest,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.eur_gb - b.eur_gb);

const TIERS = {
  Pro: { color: "#e879f9", label: "Pro — UHS-II / V60+" },
  Fast: { color: "#fbbf24", label: "Fast — A2 + U3/V30" },
  Good: { color: "#4ade80", label: "Good — U3 or V30" },
  Basic: { color: "#60a5fa", label: "Basic — C10 / U1 / A1" },
  Unrated: { color: "#78716c", label: "Unrated — no class stated" },
};
const CAPS = [128, 256, 512, 1024];
const capLabel = (g) => (g >= 1024 ? `${g / 1024} TB` : `${g} GB`);

// ---- plot geometry -----------------------------------------------------
const W = 980,
  H = 470,
  PAD_L = 74,
  PAD_R = 24,
  PAD_T = 26,
  PAD_B = 58;
const plotW = W - PAD_L - PAD_R,
  plotH = H - PAD_T - PAD_B;
// Scale to the BULK, not to the worst outlier: two overpriced cards at ~1.2
// €/GB were squashing every real candidate into the bottom third. Off-scale
// points are still drawn — pinned at the top edge with a ring and counted in
// the subtitle — because dropping them would be lying about the data.
const sorted = rows.map((r) => r.eur_gb).sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
const maxY = p95 * 1.1;
const overflow = rows.filter((r) => r.eur_gb > maxY);
const yFor = (v) => PAD_T + plotH - (Math.min(v, maxY) / maxY) * plotH;
const colW = plotW / CAPS.length;
const xFor = (gb, i) => {
  const col = CAPS.indexOf(gb);
  // Deterministic spread inside the column: index-derived, so re-runs are stable
  // (Math.random would make the chart move every render for no reason).
  const spread = (((i * 2654435761) % 1000) / 1000 - 0.5) * (colW * 0.62);
  return PAD_L + col * colW + colW / 2 + spread;
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ---- marks -------------------------------------------------------------
let pts = "";
rows.forEach((r, i) => {
  if (!CAPS.includes(r.gb)) return;
  const x = xFor(r.gb, i),
    y = yFor(r.eur_gb);
  const c = (TIERS[r.tierName] || TIERS.Unrated).color;
  const tip = `${r.title}\n${capLabel(r.gb)} · ${r.marks || "no class marks"} · ${r.tierName}\n€${r.unit_price} (${r.eur_gb.toFixed(3)} €/GB)${r.pack > 1 ? ` · pack of ${r.pack}` : ""}\n${r.rating ? `${r.rating}★ (${r.reviews ?? "?"})` : "no rating"} · ${r.delivery}`;
  const off = r.eur_gb > maxY;
  pts += `<a href="${esc(r.url)}" target="_blank" rel="noopener"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${c}" fill-opacity="${off ? 0.5 : 0.82}" stroke="${off ? "#f87171" : "#1c1410"}" stroke-width="${off ? 2 : 1}"${off ? ' stroke-dasharray="2,2"' : ""}><title>${esc(tip)}${off ? "\n(above the axis — poor value)" : ""}</title></circle></a>`;
});

// ---- axes --------------------------------------------------------------
let axes = "";
const ticks = 5;
for (let t = 0; t <= ticks; t++) {
  const v = (maxY / ticks) * t,
    y = yFor(v);
  axes += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="#4a3a28" stroke-width="1" stroke-dasharray="2,4"/>`;
  axes += `<text x="${PAD_L - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#a89880">${v.toFixed(2)}</text>`;
}
CAPS.forEach((cap, i) => {
  const cx = PAD_L + i * colW + colW / 2;
  const n = rows.filter((r) => r.gb === cap).length;
  axes += `<text x="${cx}" y="${H - PAD_B + 24}" text-anchor="middle" font-size="14" font-weight="600" fill="#e8dcc8">${capLabel(cap)}</text>`;
  axes += `<text x="${cx}" y="${H - PAD_B + 41}" text-anchor="middle" font-size="11" fill="#a89880">${n} options</text>`;
  if (i > 0)
    axes += `<line x1="${PAD_L + i * colW}" y1="${PAD_T}" x2="${PAD_L + i * colW}" y2="${PAD_T + plotH}" stroke="#3a2e20" stroke-width="1"/>`;
});
axes += `<text transform="translate(20,${PAD_T + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#a89880">€ per GB (lower = better value)</text>`;

// ---- best pick per capacity × tier -------------------------------------
function bestTable() {
  let out = "";
  for (const cap of CAPS) {
    const inCap = rows.filter((r) => r.gb === cap);
    if (!inCap.length) continue;
    const cheapest = inCap.reduce((a, b) => (a.eur_gb <= b.eur_gb ? a : b));
    const fastPool = inCap.filter((r) => r.tierName === "Fast" || r.tierName === "Pro");
    const bestFast = fastPool.length
      ? fastPool.reduce((a, b) => (a.eur_gb <= b.eur_gb ? a : b))
      : null;
    const mk = (r, tag) =>
      r
        ? `<tr><td>${capLabel(cap)}</td><td><span class="tag">${tag}</span></td>
           <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title.slice(0, 62))}</a></td>
           <td><span class="chip" style="background:${(TIERS[r.tierName] || TIERS.Unrated).color}22;color:${(TIERS[r.tierName] || TIERS.Unrated).color}">${esc(r.marks || "—")}</span></td>
           <td class="num">€${r.unit_price}</td><td class="num">${r.eur_gb.toFixed(3)}</td>
           <td class="num">${r.rating ? r.rating + "★" : "—"}</td></tr>`
        : "";
    out += mk(cheapest, "cheapest");
    if (bestFast && bestFast.asin !== cheapest.asin) out += mk(bestFast, "best A2/fast");
  }
  return out;
}

const legend = Object.entries(TIERS)
  .map(
    ([k, v]) =>
      `<span class="lg"><i style="background:${v.color}"></i>${esc(v.label)} <b>(${rows.filter((r) => r.tierName === k).length})</b></span>`,
  )
  .join("");

const html = `<!doctype html><meta charset="utf-8"><title>${esc(HEADING)}</title>
<style>
 body{margin:0;padding:22px;background:#1c1510;color:#e8dcc8;font:14px/1.55 ui-sans-serif,system-ui,sans-serif}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#a89880;font-size:13px;margin-bottom:16px}
 .card{background:#241c14;border:1px solid #4a3a28;border-radius:12px;padding:16px 18px;margin-bottom:18px}
 .lg{display:inline-flex;align-items:center;gap:7px;margin:0 16px 8px 0;font-size:12.5px}
 .lg i{width:11px;height:11px;border-radius:50%;display:inline-block}
 table{border-collapse:collapse;width:100%;font-size:12.5px} th,td{padding:7px 9px;text-align:left;border-bottom:1px solid #3a2e20}
 th{color:#a89880;font-weight:600} td.num{text-align:right;font-variant-numeric:tabular-nums}
 a{color:#7dd3fc;text-decoration:none} a:hover{text-decoration:underline}
 .tag{font-size:11px;background:#3a2e20;padding:2px 7px;border-radius:99px;color:#d6c6ac;white-space:nowrap}
 .chip{font-size:11px;padding:2px 7px;border-radius:5px;font-weight:600;white-space:nowrap}
 circle{cursor:pointer} circle:hover{r:9;fill-opacity:1}
 .mk{display:grid;grid-template-columns:88px 1fr;gap:6px 14px;font-size:13px}
 .mk b{color:#fbbf24;font-variant-numeric:tabular-nums}
</style>
<h1>${esc(HEADING)}</h1>
<div class="sub">${rows.length} distinct cards, 128 GB and up, every one <b>showing next-day delivery in the captured dataset</b> — that is what the listing advertised when it was read, not a verified promise for your address. Each dot links to the product — hover for the full spec.${overflow.length ? ` ${overflow.length} card${overflow.length > 1 ? "s" : ""} priced above ${maxY.toFixed(2)} €/GB ${overflow.length > 1 ? "are" : "is"} pinned at the top edge with a red ring.` : ""}</div>

<div class="card">
  <div style="margin-bottom:10px">${legend}</div>
  <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">
    <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" fill="#1a130e" stroke="#3a2e20"/>
    ${axes}${pts}
  </svg>
</div>

<div class="card">
  <h2 style="font-size:15px;margin:0 0 10px">What the markings mean</h2>
  <div class="mk">
    <b>A1 / A2</b><div><b>The one that matters for a Raspberry Pi.</b> App Performance Class — minimum <i>random</i> IOPS (A1 = 1500/500, A2 = 4000/2000). An OS does thousands of tiny reads, so an A2 card feels fast booting a Pi and an A1 card feels sluggish, whatever the big number on the front says.</div>
    <b>U1 / U3</b><div>UHS Speed Class — minimum <i>sustained write</i>: 10 vs 30 MB/s. U3 is the floor for 4K video.</div>
    <b>V10 … V90</b><div>Video Speed Class — the same idea, finer grained (V30 = 30 MB/s sustained). If a card shows both U3 and V30 they are saying the same thing twice.</div>
    <b>C10</b><div>Class 10, the 2010-era 10 MB/s minimum. Almost every card claims it; it tells you nearly nothing today.</div>
    <b>“190 MB/s”</b><div>Sequential <i>read</i>, best case, marketing's favourite. It is printed largest and is the least useful number for an OS disk.</div>
  </div>
</div>

<div class="card">
  <h2 style="font-size:15px;margin:0 0 10px">Best pick per capacity</h2>
  <table><thead><tr><th>Size</th><th></th><th>Product</th><th>Marks</th><th>Price</th><th>€/GB</th><th>Rating</th></tr></thead>
  <tbody>${bestTable()}</tbody></table>
</div>
`;

fs.writeFileSync(outPath, html);
console.log(JSON.stringify({ ok: true, out: outPath, points: rows.length, bytes: html.length }));
