// tables.mjs — a small vocabulary for comparison tables an eye can read.
//
// The premise: a comparison table is not a list, it is an ARGUMENT about which
// option is better. Colour and bar length carry that argument; text confirms it.
// Everything here exists so the same five colours mean the same five things in
// every table you ever render, because that transfer is what makes the second
// table fast to read.

/** Five tiers, one meaning, everywhere. Warm-dark by default; override freely. */
export const PALETTE = {
  best: { bg: "#4a3410", fg: "#f0c674", bd: "#8a6520", bar: "#c9a86a" },
  good: { bg: "#1e3347", fg: "#8ec0e4", bd: "#2f5a7a", bar: "#8ec0e4" },
  ok: { bg: "#2f3b33", fg: "#a8c8a0", bd: "#46604a", bar: "#a8c8a0" },
  weak: { bg: "#3a3630", fg: "#a09580", bd: "#554e44", bar: "#a09580" },
  bad: { bg: "#4a2020", fg: "#e39a9a", bd: "#7a3434", bar: "#c96a6a" },
};

export const THEME = {
  bg: "#241c14",
  panel: "#31261a",
  stripe: "#292219",
  line: "#3a3025",
  text: "#e8ddc9",
  dim: "#a89880",
  faint: "#8b7f6d",
  ghost: "#6f6555",
  border: "#5a4632",
  accent: "#f0c674",
};

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * A labelled pill. Use for the ONE attribute that most determines rank —
 * more than one chip per row and the eye has nothing to anchor on.
 */
export function chip(text, tier = "weak", bold = true) {
  const c = PALETTE[tier] || PALETTE.weak;
  return `<span style="display:inline-block;padding:2px 7px;border-radius:5px;background:${c.bg};color:${c.fg};border:1px solid ${c.bd};font-size:11.5px;font-weight:${bold ? 700 : 600};white-space:nowrap">${esc(text)}</span>`;
}

/**
 * A magnitude bar. ALWAYS scaled to the best value in the same table, never to
 * an absolute maximum — the reader's question is "compared with my other
 * options", not "compared with everything that exists".
 */
export function bar(value, max, tier = "best", width = 54) {
  const pct = Math.max(2, Math.min(100, Math.round((value / (max || 1)) * 100)));
  const col = (PALETTE[tier] || PALETTE.best).bar;
  return `<span style="display:inline-block;width:${width}px;height:6px;background:#3a332a;border-radius:3px;overflow:hidden;vertical-align:middle"><span style="display:block;width:${pct}%;height:100%;background:${col}"></span></span>`;
}

/** A number that should line up with the numbers above and below it. */
export function num(v, unit = "", colour = THEME.text) {
  return `<span style="color:${colour};font-size:11.5px;font-variant-numeric:tabular-nums">${esc(v)}</span>${unit ? `<span style="color:${THEME.faint};font-size:10px"> ${esc(unit)}</span>` : ""}`;
}

/** Missing DATA is not an empty VALUE. Say which one it is. */
export function absent(reason = "not stated") {
  return `<span style="color:${THEME.ghost};font-style:italic;font-size:12px">${esc(reason)}</span>`;
}

/**
 * @param {object} o
 * @param {string} o.title            headline, usually the query
 * @param {string} [o.subtitle]       what the ranking optimises for
 * @param {string} [o.meta]           counts and sources, right-aligned
 * @param {{label:string,body:string}} [o.callout]  the recommended row, restated
 * @param {{label:string,note?:string,align?:string}[]} o.columns
 * @param {string[][]} o.rows         pre-rendered cells
 * @param {('best'|'bad'|null)[]} [o.marks]  per-row left edge
 * @param {string[]} [o.legend]       small html snippets
 * @param {string} [o.footnote]       what was excluded and why
 */
export function renderTable(o) {
  const T = THEME;
  const th = o.columns
    .map(
      (c) =>
        `<th style="text-align:${c.align === "right" ? "right" : "left"};padding:0 6px 7px;color:${T.faint};font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;white-space:nowrap">${esc(c.label)}${c.note ? `<div style="text-transform:none;letter-spacing:0;color:${T.ghost};font-size:9.5px;font-weight:400;margin-top:1px">${esc(c.note)}</div>` : ""}</th>`,
    )
    .join("");

  const tr = o.rows
    .map((cells, i) => {
      const mark = (o.marks || [])[i];
      const edge =
        mark === "best"
          ? `border-left:3px solid ${T.accent};`
          : mark === "bad"
            ? "border-left:3px solid #c96a6a;"
            : "border-left:3px solid transparent;";
      const bg =
        mark === "best"
          ? `background:${T.panel};`
          : mark === "bad"
            ? "background:#2a1e1e;"
            : i % 2
              ? `background:${T.stripe};`
              : "";
      const dim = mark === "bad" ? "opacity:.72;" : "";
      return `<tr style="${bg}${dim}">${cells.map((c, j) => `<td style="${j === 0 ? edge : ""}padding:9px 6px${j === 0 ? " 9px 9px" : ""};text-align:${o.columns[j]?.align === "right" ? "right" : "left"};vertical-align:top">${c}</td>`).join("")}</tr>`;
    })
    .join("\n");

  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;background:${T.bg};color:${T.text};border:1px solid ${T.border};border-radius:12px;padding:18px 20px;max-width:1000px">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px">
    <div style="font-size:16px;font-weight:700">${o.title}</div>
    ${o.meta ? `<div style="color:${T.faint};font-size:11px">${esc(o.meta)}</div>` : ""}
  </div>
  ${o.subtitle ? `<div style="color:${T.dim};font-size:11.5px;margin-bottom:14px">${esc(o.subtitle)}</div>` : ""}
  ${
    o.callout
      ? `<div style="background:${T.panel};border:1px solid #6b5330;border-radius:9px;padding:11px 13px;margin-bottom:14px">
    <div style="color:${T.accent};font-size:10px;font-weight:700;letter-spacing:1px;margin-bottom:4px">▸ ${esc(o.callout.label)}</div>
    ${o.callout.body}
  </div>`
      : ""
  }
  <table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="border-bottom:1px solid #4a3c2c">${th}</tr></thead>
    <tbody>${tr}</tbody>
  </table>
  ${o.legend?.length ? `<div style="margin-top:13px;padding-top:11px;border-top:1px solid ${T.line};display:flex;gap:16px;flex-wrap:wrap;align-items:center;color:${T.faint};font-size:10.5px">${o.legend.join("")}</div>` : ""}
  ${o.footnote ? `<div style="margin-top:9px;color:${T.faint};font-size:11px">${o.footnote}</div>` : ""}
</div>`;
}
