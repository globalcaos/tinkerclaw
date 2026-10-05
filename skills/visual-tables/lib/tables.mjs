// tables.mjs — a small vocabulary for comparison tables an eye can read.
//
// The premise: a comparison table is not a list, it is an ARGUMENT about which
// option is better. Colour and bar length carry that argument; text confirms it.
// Everything here exists so the same five colours mean the same five things in
// every table you ever render, because that transfer is what makes the second
// table fast to read.
//
// Safety model: every value you pass is TEXT and is HTML-escaped. There is no
// raw-HTML input anywhere. Markup only comes from this module's own builders
// (chip, bar, num, absent, text, block, group); their results are tracked in a
// private WeakSet, so a plain string that merely looks like HTML is escaped
// like any other text. Colours are accepted only as #hex or a palette/theme
// key and sizes only as numbers, so no caller value can reach a style attribute
// as free-form CSS. The output contains no links, images, scripts or other
// external resources.

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
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// Fragments minted by this module. Not exported: callers cannot mark a string
// as markup, they can only compose the builders below.
const MINTED = new WeakSet();
function mint(markup) {
  const frag = Object.freeze({ markup, toString: () => markup });
  MINTED.add(frag);
  return frag;
}

/** Render any value: builder fragments pass through, arrays concatenate, everything else is escaped text. */
function render(v) {
  if (Array.isArray(v)) return v.map(render).join("");
  if (v && typeof v === "object" && MINTED.has(v)) return v.markup;
  return esc(v);
}

const HEX = /^#[0-9a-f]{3,8}$/i;
/** A colour is a palette tier (its fg), a THEME key, or a #hex literal. Anything else falls back. */
function colour(c, fallback = THEME.text) {
  if (typeof c !== "string") return fallback;
  if (HEX.test(c)) return c;
  if (Object.hasOwn(PALETTE, c)) return PALETTE[c].fg;
  if (Object.hasOwn(THEME, c)) return THEME[c];
  return fallback;
}
const n = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const tierOf = (tier, fallback) => (Object.hasOwn(PALETTE, tier) ? PALETTE[tier] : fallback);

/** Join CSS declarations built from constants and validated values. */
const css = (...decls) => decls.filter(Boolean).join(";");

/** One element. `inner` must already be escaped or minted markup. */
const el = (name, style, inner) => `<${name} style="${style}">${inner}</${name}>`;

/**
 * A labelled pill. Use for the ONE attribute that most determines rank —
 * more than one chip per row and the eye has nothing to anchor on.
 */
export function chip(label, tier = "weak", bold = true) {
  const c = tierOf(tier, PALETTE.weak);
  const style = css(
    "display:inline-block",
    "padding:2px 7px",
    "border-radius:5px",
    `background:${c.bg}`,
    `color:${c.fg}`,
    `border:1px solid ${c.bd}`,
    "font-size:11.5px",
    `font-weight:${bold ? 700 : 600}`,
    "white-space:nowrap",
  );
  return mint(el("span", style, esc(label)));
}

/**
 * A magnitude bar. ALWAYS scaled to the best value in the same table, never to
 * an absolute maximum — the reader's question is "compared with my other
 * options", not "compared with everything that exists".
 */
export function bar(value, max, tier = "best", width = 54) {
  const ratio = n(value, 0) / (n(max, 0) || 1);
  const pct = Math.max(2, Math.min(100, Math.round(ratio * 100)));
  const col = tierOf(tier, PALETTE.best).bar;
  const track = css(
    "display:inline-block",
    `width:${n(width, 54)}px`,
    "height:6px",
    "background:#3a332a",
    "border-radius:3px",
    "overflow:hidden",
    "vertical-align:middle",
  );
  const fill = css("display:block", `width:${pct}%`, "height:100%", `background:${col}`);
  return mint(el("span", track, el("span", fill, "")));
}

/** A number that should line up with the numbers above and below it. */
export function num(v, unit = "", tint = THEME.text) {
  const value = el(
    "span",
    css(`color:${colour(tint)}`, "font-size:11.5px", "font-variant-numeric:tabular-nums"),
    esc(v),
  );
  if (!unit) return mint(value);
  const suffix = el("span", css(`color:${THEME.faint}`, "font-size:10px"), ` ${esc(unit)}`);
  return mint(value + suffix);
}

/** Missing DATA is not an empty VALUE. Say which one it is. */
export function absent(reason = "not stated") {
  const style = css(`color:${THEME.ghost}`, "font-style:italic", "font-size:12px");
  return mint(el("span", style, esc(reason)));
}

function styleOf(s = {}) {
  let out = "";
  if (s.color !== undefined) out += `color:${colour(s.color)};`;
  if (s.size !== undefined) out += `font-size:${n(s.size, 12)}px;`;
  if (s.weight !== undefined) out += `font-weight:${n(s.weight, 400)};`;
  if (s.italic) out += "font-style:italic;";
  if (s.marginTop !== undefined) out += `margin-top:${n(s.marginTop, 0)}px;`;
  return out;
}

/**
 * Styled inline text. `content` is text (escaped) or builder output.
 * @param {{color?:string,size?:number,weight?:number,italic?:boolean}} [style]
 */
export function text(content, style = {}) {
  return mint(el("span", styleOf(style), render(content)));
}

/**
 * A block-level line, for the callout body.
 * @param {{color?:string,size?:number,weight?:number,italic?:boolean,marginTop?:number}} [style]
 */
export function block(content, style = {}) {
  return mint(el("div", styleOf(style), render(content)));
}

/** Place several pieces side by side, e.g. `group(bar(...), " ", num(...))`. */
export function group(...parts) {
  return mint(render(parts));
}

// ---- renderTable pieces. Each returns an HTML string or "" when absent. ----

const alignOf = (col) => (col?.align === "right" ? "right" : "left");

function headerCell(col) {
  const style = css(
    `text-align:${alignOf(col)}`,
    "padding:0 6px 7px",
    `color:${THEME.faint}`,
    "font-size:10px",
    "font-weight:600",
    "letter-spacing:.8px",
    "text-transform:uppercase",
    "white-space:nowrap",
  );
  return el("th", style, esc(col.label) + columnNote(col.note));
}

function columnNote(note) {
  if (!note) return "";
  const style = css(
    "text-transform:none",
    "letter-spacing:0",
    `color:${THEME.ghost}`,
    "font-size:9.5px",
    "font-weight:400",
    "margin-top:1px",
  );
  return el("div", style, esc(note));
}

function rowEdge(mark) {
  if (mark === "best") return `border-left:3px solid ${THEME.accent};`;
  if (mark === "bad") return "border-left:3px solid #c96a6a;";
  return "border-left:3px solid transparent;";
}

function rowBackground(mark, i) {
  if (mark === "best") return `background:${THEME.panel};`;
  if (mark === "bad") return "background:#2a1e1e;";
  return i % 2 ? `background:${THEME.stripe};` : "";
}

function bodyCell(content, j, mark, columns) {
  const edge = j === 0 ? rowEdge(mark) : "";
  const pad = j === 0 ? "padding:9px 6px 9px 9px" : "padding:9px 6px";
  const style = edge + css(pad, `text-align:${alignOf(columns[j])}`, "vertical-align:top");
  return el("td", style, render(content));
}

function bodyRow(cells, i, o) {
  const mark = (o.marks || [])[i];
  const dim = mark === "bad" ? "opacity:.72;" : "";
  const tds = cells.map((c, j) => bodyCell(c, j, mark, o.columns)).join("");
  return `<tr style="${rowBackground(mark, i)}${dim}">${tds}</tr>`;
}

function titleBar(o) {
  const title = el("div", css("font-size:16px", "font-weight:700"), render(o.title));
  const meta = o.meta ? el("div", css(`color:${THEME.faint}`, "font-size:11px"), esc(o.meta)) : "";
  const style = css(
    "display:flex",
    "align-items:baseline",
    "justify-content:space-between",
    "gap:12px",
    "flex-wrap:wrap",
    "margin-bottom:4px",
  );
  return el("div", style, `\n    ${title}\n    ${meta}\n  `);
}

function subtitleLine(subtitle) {
  if (!subtitle) return "";
  const style = css(`color:${THEME.dim}`, "font-size:11.5px", "margin-bottom:14px");
  return el("div", style, esc(subtitle));
}

function calloutBox(callout) {
  if (!callout) return "";
  const labelStyle = css(
    `color:${THEME.accent}`,
    "font-size:10px",
    "font-weight:700",
    "letter-spacing:1px",
    "margin-bottom:4px",
  );
  const label = el("div", labelStyle, `▸ ${esc(callout.label)}`);
  const boxStyle = css(
    `background:${THEME.panel}`,
    "border:1px solid #6b5330",
    "border-radius:9px",
    "padding:11px 13px",
    "margin-bottom:14px",
  );
  return el("div", boxStyle, `\n    ${label}\n    ${render(callout.body)}\n  `);
}

function legendRow(legend) {
  const items = (legend || []).map((item) => `<span>${render(item)}</span>`).join("");
  if (!items) return "";
  const style = css(
    "margin-top:13px",
    "padding-top:11px",
    `border-top:1px solid ${THEME.line}`,
    "display:flex",
    "gap:16px",
    "flex-wrap:wrap",
    "align-items:center",
    `color:${THEME.faint}`,
    "font-size:10.5px",
  );
  return el("div", style, items);
}

function footnoteLine(footnote) {
  if (!footnote) return "";
  const style = css("margin-top:9px", `color:${THEME.faint}`, "font-size:11px");
  return el("div", style, render(footnote));
}

function tableBody(o) {
  const th = o.columns.map(headerCell).join("");
  const tr = o.rows.map((cells, i) => bodyRow(cells, i, o)).join("\n");
  const head = `<thead><tr style="border-bottom:1px solid #4a3c2c">${th}</tr></thead>`;
  const style = css("width:100%", "border-collapse:collapse", "font-size:12.5px");
  return el("table", style, `\n    ${head}\n    <tbody>${tr}</tbody>\n  `);
}

/**
 * Every text-typed field below is escaped. A field typed `Content` also accepts
 * builder output (chip/bar/num/absent/text/block/group) or an array of both.
 *
 * @typedef {string|number|object|Array<string|number|object>} Content
 * @param {object} o
 * @param {Content} o.title            headline, usually the query
 * @param {string} [o.subtitle]        what the ranking optimises for
 * @param {string} [o.meta]            counts and sources, right-aligned
 * @param {{label:string,body:Content}} [o.callout]  the recommended row, restated
 * @param {{label:string,note?:string,align?:string}[]} o.columns
 * @param {Content[][]} o.rows         one Content per cell
 * @param {('best'|'bad'|null)[]} [o.marks]  per-row left edge
 * @param {Content[]} [o.legend]       small legend items
 * @param {Content} [o.footnote]       what was excluded and why
 * @returns {string} an HTML fragment
 */
export function renderTable(o) {
  const parts = [
    titleBar(o),
    subtitleLine(o.subtitle),
    calloutBox(o.callout),
    tableBody(o),
    legendRow(o.legend),
    footnoteLine(o.footnote),
  ];
  const style = css(
    "font-family:ui-sans-serif,system-ui,sans-serif",
    `background:${THEME.bg}`,
    `color:${THEME.text}`,
    `border:1px solid ${THEME.border}`,
    "border-radius:12px",
    "padding:18px 20px",
    "max-width:1000px",
  );
  return el("div", style, `\n  ${parts.join("\n  ")}\n`);
}
