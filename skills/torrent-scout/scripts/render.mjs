#!/usr/bin/env node
// render.mjs — turn the last search into a scannable HTML comparison table.
//
// Design brief: the reader is visual-first. Colour and bar length carry the
// comparison; the text only confirms what the eye already decided. Anything
// that cannot be read in one sweep belongs in a footnote, not a column.
//
// Usage: node scripts/render.mjs [--limit N] [--all]

import { loadSearch } from "../lib/config.mjs";
import {
  presenterFor,
  resolutionChip,
  healthTier,
  bitrateMbps,
  pictureSummary,
  soundSummary,
  fmtSize,
  PALETTE,
} from "../lib/presenters.mjs";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function bar(pct, colour, w = 54) {
  const p = Math.max(2, Math.min(100, Math.round(pct)));
  return `<span style="display:inline-block;width:${w}px;height:6px;background:#3a332a;border-radius:3px;overflow:hidden;vertical-align:middle">
    <span style="display:block;width:${p}%;height:100%;background:${colour}"></span></span>`;
}

function chip(text, tier, bold = false) {
  const c = PALETTE[tier] || PALETTE.weak;
  return `<span style="display:inline-block;padding:2px 7px;border-radius:5px;background:${c.bg};color:${c.fg};border:1px solid ${c.bd};font-size:11.5px;font-weight:${bold ? 700 : 600};letter-spacing:.2px;white-space:nowrap">${esc(text)}</span>`;
}

function main() {
  const args = process.argv.slice(2);
  const limit =
    Number((args.find((a) => a.startsWith("--limit")) || "").split("=")[1]) ||
    (args.includes("--all") ? 999 : 8);
  const state = loadSearch();
  if (!state) {
    console.error("No search state. Run search.mjs first.");
    process.exit(2);
  }

  const P = presenterFor(state.kind);
  const kept = state.kept.slice(0, limit);
  if (!kept.length) {
    console.error("No candidates to render.");
    process.exit(3);
  }

  const runtime = state.runtimeMin || 105;
  const rows = kept.map((c, i) => {
    const p = c.parsed;
    const br = bitrateMbps(c.sizeBytes, runtime);
    return {
      c,
      p,
      i,
      br,
      res: resolutionChip(p.resolution),
      health: healthTier(c.seeders, c.webseed),
    };
  });
  // Same content re-listed by several indexers is the most common source of
  // false choice in these tables: four rows that look like four options are
  // one option with four front doors. Match on (resolution, size-to-the-MB) and
  // say so, so the reader picks on swarm health instead of re-reading names.
  // Only "identical" when the infohash matches — different byte counts mean
  // different encodes, and calling those the same file is a lie the reader
  // would act on. Same resolution within 1% size is "same spec", which is a
  // weaker and true claim.
  for (const r of rows) {
    for (const prev of rows) {
      if (prev.i >= r.i) break;
      const sameHash =
        r.c.infoHash &&
        prev.c.infoHash &&
        r.c.infoHash.toLowerCase() === prev.c.infoHash.toLowerCase();
      const sameSpec =
        r.p.resolution &&
        r.p.resolution === prev.p.resolution &&
        r.c.sizeBytes &&
        prev.c.sizeBytes &&
        Math.abs(r.c.sizeBytes - prev.c.sizeBytes) / prev.c.sizeBytes < 0.01;
      if (sameHash) {
        r.dupe = { n: prev.i + 1, kind: "identical torrent" };
        break;
      }
      if (sameSpec) {
        r.dupe = { n: prev.i + 1, kind: "same spec" };
        break;
      }
    }
  }
  const maxBr = Math.max(...rows.map((r) => r.br || 0), 1);
  const maxSeed = Math.max(...rows.map((r) => r.c.seeders || 0), 1);
  const best = rows[0];

  const HEALTH_COLOUR = {
    best: "#7dc98a",
    good: "#8ec0e4",
    ok: "#c9b46a",
    weak: "#c98a5a",
    bad: "#c96a6a",
  };

  const tr = rows
    .map((r) => {
      const { c, p, i, br, res, health } = r;
      const suspect = c.verdict === "suspect";
      const rowBg =
        i === 0
          ? "background:#31261a;"
          : suspect
            ? "background:#2a1e1e;"
            : i % 2
              ? "background:#292219;"
              : "";
      const edge =
        i === 0
          ? "border-left:3px solid #f0c674;"
          : suspect
            ? "border-left:3px solid #c96a6a;"
            : "border-left:3px solid transparent;";
      const dim = suspect ? "opacity:.72;" : "";
      const seeders = c.webseed ? "HTTP" : (c.seeders ?? 0);
      const seedPct = c.webseed ? 100 : ((c.seeders || 0) / maxSeed) * 100;
      return `<tr style="${rowBg}${dim}">
      <td style="${edge}padding:9px 6px 9px 9px;text-align:right;color:#8b7f6d;font-variant-numeric:tabular-nums">${i + 1}</td>
      <td style="padding:9px 6px">${chip(res.label, res.tier, true)}${p.source ? `<div style="margin-top:3px;color:#a89880;font-size:10.5px">${esc(p.source)}</div>` : ""}</td>
      <td style="padding:9px 6px;color:#ddd0b8;font-size:12px">${esc(pictureSummary(p))}${p.videoCodec ? `<div style="color:#8b7f6d;font-size:10.5px;margin-top:2px">${esc(p.videoCodec)}${p.bitDepth ? ` · ${p.bitDepth}-bit` : ""}</div>` : ""}</td>
      <td style="padding:9px 6px;font-size:12px;color:${soundSummary(p) === "not tagged" ? "#6f6555" : "#ddd0b8"};${soundSummary(p) === "not tagged" ? "font-style:italic;" : ""}">${esc(soundSummary(p))}</td>
      <td style="padding:9px 6px">${br ? `${bar((br / maxBr) * 100, "#c9a86a")}<span style="margin-left:6px;color:#ddd0b8;font-size:11.5px;font-variant-numeric:tabular-nums">${br.toFixed(1)}</span><span style="color:#8b7f6d;font-size:10px"> Mb/s</span>` : '<span style="color:#6f6555">—</span>'}</td>
      <td style="padding:9px 6px;text-align:right;color:#ddd0b8;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap">${esc(fmtSize(c.sizeBytes))}</td>
      <td style="padding:9px 6px">${bar(seedPct, HEALTH_COLOUR[health], 40)}<span style="margin-left:6px;color:${HEALTH_COLOUR[health]};font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums">${esc(seeders)}</span>${!c.webseed && c.leechers != null ? `<span style="color:#6f6555;font-size:10px"> /${c.leechers}</span>` : ""}</td>
      <td style="padding:9px 9px 9px 6px;color:#9d9080;font-size:11px">${p.group ? `<span style="color:#c9a86a">${esc(p.group)}</span>` : '<span style="color:#6f6555">no group</span>'}<div style="color:#6f6555;font-size:10px;margin-top:2px">${esc(c.source)}</div>${suspect ? `<div style="color:#c96a6a;font-size:10px;margin-top:2px">⚠ ${esc(c.flags.join(", "))}</div>` : ""}${r.dupe ? `<div style="color:#7a9bb5;font-size:10px;margin-top:2px">≡ ${esc(r.dupe.kind)} as #${r.dupe.n}</div>` : ""}</td>
    </tr>`;
    })
    .join("\n");

  const th = P.columns
    .map(
      (c) =>
        `<th style="text-align:${c.align === "right" ? "right" : "left"};padding:0 6px 7px;color:#8b7f6d;font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;white-space:nowrap">${esc(c.label)}${c.note ? `<div style="text-transform:none;letter-spacing:0;color:#6f6555;font-size:9.5px;font-weight:400;margin-top:1px">${esc(c.note)}</div>` : ""}</th>`,
    )
    .join("");

  const rejected = state.rejected || [];
  const cams = rejected.filter((r) => r.parsed?.isCamcorder).length;

  console.log("```html-render");
  console.log(`<div style="font-family:ui-sans-serif,system-ui,sans-serif;background:#241c14;color:#e8ddc9;border:1px solid #5a4632;border-radius:12px;padding:18px 20px;max-width:1000px">

  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px">
    <div style="font-size:16px;font-weight:700">🎬 ${esc(state.query)}</div>
    <div style="color:#8b7f6d;font-size:11px">${P.label} · ${state.totalFound} found → ${state.kept.length} acceptable · ${esc((state.sourcesTried || []).join(", "))}</div>
  </div>
  <div style="color:#a89880;font-size:11.5px;margin-bottom:14px">${esc(P.subtitle)} · assuming ${runtime} min runtime</div>

  <div style="background:#31261a;border:1px solid #6b5330;border-radius:9px;padding:11px 13px;margin-bottom:14px">
    <div style="color:#f0c674;font-size:10px;font-weight:700;letter-spacing:1px;margin-bottom:4px">▸ BEST PICK</div>
    <div style="font-size:13.5px;color:#f3e8d2">${esc(best.c.title.slice(0, 88))}</div>
    <div style="color:#a89880;font-size:11.5px;margin-top:4px">
      ${[
        `${best.res.label}${best.p.source ? ` ${best.p.source}` : ""}`,
        soundSummary(best.p) === "—" ? "audio not stated in the name" : soundSummary(best.p),
        `${fmtSize(best.c.sizeBytes)}${best.br ? ` at ${best.br.toFixed(1)} Mb/s` : ""}`,
        best.c.webseed ? "HTTP webseed" : `${best.c.seeders} seeders`,
      ]
        .map(esc)
        .join(" · ")}
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="border-bottom:1px solid #4a3c2c">${th}</tr></thead>
    <tbody>${tr}</tbody>
  </table>

  <div style="margin-top:13px;padding-top:11px;border-top:1px solid #3a3025;display:flex;gap:16px;flex-wrap:wrap;color:#8b7f6d;font-size:10.5px">
    <span>${chip("2160p", "best")} 4K</span>
    <span>${chip("1080p", "good")} full HD</span>
    <span>${chip("720p", "ok")} HD</span>
    <span style="color:#c96a6a">▎suspect — flags shown</span>
    <span style="color:#f0c674">▎best pick</span>
    <span>bar length = relative to the best in this table</span>
  </div>

  ${
    rejected.length
      ? `<div style="margin-top:9px;color:#8b7f6d;font-size:11px">
    <b style="color:#c98a5a">${rejected.length} rejected before ranking</b> — ${cams} cinema-recorded (CAM/TS/TC/workprint), ${rejected.length - cams} other (dead swarm, wrong title). Never shown: a camcorder rip is not a low-quality option, it is not an option.
  </div>`
      : ""
  }

</div>`);
  console.log("```");
}

main();
