// mdmap.js: the map between a paragraph as it shows on the page and the Markdown it is written in (2026-11-15).
//
// The writer (writer.js) lets him type straight into a paragraph of the PDF. What he types is plain text, the
// words as they show. This file turns that change into a change of the Markdown source that touches only the
// characters he changed: the ** around a bold word, a link's address, a list item's "- " stay where they were.
// A change that cannot be placed exactly is refused (applyEdit throws); the source is never guessed at.
// Pure functions, no DOM: test/mdmap.test.mjs runs them in node.
//
//   blocksOf(text)         the units the server's /api/paragraph counts (paragraphs, list items), same split
//   parse(block)           {ok, why, text, spans, style, styles, conts, start, kind, marker}
//                            text: the visible words, whitespace collapsed; spans[i]: the source range of text[i]
//   applyEdit(block, p, t) the block's new Markdown once its visible text is t ("\n" = a new paragraph);
//                            "" when t is empty (the block goes)
//   runs(p, a, b)          visible characters a..b as stretches with their bold/italic/link look, for the editor
//   norm(t)                the comparison form: NFC, every run of whitespace one space, trimmed
//   lettersOf, blockLetters, candidates, findBlock, portion   find a tapped paragraph in the source

export const SPLIT = /(\n\n|\n(?=[-*] |\d+\. ))/; // server.py _md_split and offline.js split: change all three or none
export const blocksOf = (text) => text.split(SPLIT).filter((_, i) => i % 2 === 0);

export const norm = (t) => String(t).normalize("NFC").replace(/\s+/gu, " ").trim();

const ESCAPABLE = "\\`*_{}[]()#+-.!>"; // Python-Markdown's ESCAPED_CHARS, the ones a backslash makes literal
const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/u;
const INLINE_TAGS = new Set(["span", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sup", "sub",
  "code", "kbd", "a", "br", "img", "abbr", "cite", "q", "font", "wbr"]);
const VOID_TAGS = new Set(["br", "img", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®",
  trade: "™", middot: "·", bull: "•", times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", cent: "¢",
  iexcl: "¡", iquest: "¿", sect: "§", para: "¶", plusmn: "±", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", hArr: "⇔", minus: "−", le: "≤", ge: "≥",
  ne: "≠", asymp: "≈", infin: "∞", shy: "\u00ad", zwj: "\u200d", zwnj: "\u200c", thinsp: "\u2009", ensp: "\u2002",
  emsp: "\u2003", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è",
  ograve: "ò", ntilde: "ñ", ccedil: "ç", uuml: "ü", iuml: "ï", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó",
  Uacute: "Ú", Agrave: "À", Egrave: "È", Ograve: "Ò", Ntilde: "Ñ", Ccedil: "Ç", Uuml: "Ü", ordf: "ª", ordm: "º" };

// ---- block markers: what each line starts with, which is never part of the words -------------------------
// The block's inline content C is its lines without their markers, joined by "\n". cmap[i] is the source range
// of C[i]; the "\n" between two lines stands for the newline and the next line's markers ("\n> ", "\n   - "),
// so deleting that space removes the markers with it and the lines join cleanly.
function lines(md) {
  const fail = (why) => ({ ok: false, why });
  if (/^[ \t]*(```|~~~)/m.test(md)) return fail("a code block");
  if (/^[ \t]*\|.*\|[ \t]*$/m.test(md) || /^[ \t]*:?-{3,}:?[ \t]*\|/m.test(md)) return fail("a table");
  if (/\[\^[^\]]*\]/.test(md)) return fail("a footnote");
  if (/\{:[^}]*\}/.test(md)) return fail("an attribute list");
  if (/^ {0,3}\[[^\]]+\]:[ \t]/m.test(md)) return fail("a link definition");
  if (/^ {0,3}\*\[[^\]]+\]:/m.test(md)) return fail("an abbreviation");
  if (/^[ \t]*<\/?(div|p|table|thead|tbody|tr|td|th|figure|figcaption|section|article|aside|header|footer|nav|pre|ul|ol|li|dl|dt|dd|blockquote|h[1-6]|hr|details|summary|style|script|iframe|center|form|svg|math|video|audio)\b/im.test(md)) return fail("an HTML block");
  if (/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/m.test(md)) return fail("a rule");
  const L = md.split("\n");
  if (L.slice(1).some((l) => /^ {0,3}(=+|-+)[ \t]*$/.test(l))) return fail("an underlined heading");
  let C = "", kind = "p", marker = "", start = 0, off = 0;
  const cmap = [];
  for (let li = 0; li < L.length; li++) {
    const line = L[li];
    let pre = 0, rest = line, m;
    if ((m = /^ {0,3}>[ \t]?/.exec(rest))) { pre += m[0].length; rest = rest.slice(m[0].length); if (li === 0) kind = "quote"; }
    if (li === 0) {
      if ((m = /^(#{1,6})[ \t]+/.exec(rest))) {
        kind = "h" + m[1].length; pre += m[0].length; rest = rest.slice(m[0].length);
        if (/[ \t]#+[ \t]*$/.test(rest)) return fail("a heading closed with #");
      } else if ((m = /^([-*+]|\d+[.)])[ \t]+/.exec(rest))) {
        kind = kind === "quote" ? "quote" : /\d/.test(m[1]) ? "ol" : "ul"; marker = m[1];
        pre += m[0].length; rest = rest.slice(m[0].length);
      } else if (/^( {4}|\t)/.test(rest) && kind === "p") return fail("an indented code block");
    } else if ((m = /^[ \t]*([-*+]|\d+[.)])[ \t]+/.exec(rest)) || (m = /^[ \t]+/.exec(rest))) {
      pre += m[0].length; rest = rest.slice(m[0].length);
    }
    if (li > 0) { C += "\n"; cmap.push([off - 1, off + pre]); }
    else start = pre;
    for (let k = 0; k < rest.length; k++) { C += rest[k]; cmap.push([off + pre + k, off + pre + k + 1]); }
    off += line.length + 1;
  }
  return { ok: true, C, cmap, kind, marker, start };
}

// ---- inline tokens ---------------------------------------------------------------------------------------
// ch: one visible character; ws: whitespace; delim: a run of * or _; code: a code span; link: [text](url) with
// its own tokens; img: a picture (no words); tag: an inline HTML tag; auto: <https://...> (its address shows).
function linkAt(C, i, to) {
  // C[i] === "[": the matching "]" (nested brackets, escapes and code spans skipped), then "(" dest [title] ")".
  let depth = 0, j = i;
  for (; j < to; j++) {
    const c = C[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { let k = j; while (C[k] === "`") k++; const run = k - j; const close = C.indexOf("`".repeat(run), k); if (close > 0 && close < to) j = close + run - 1; else j = k - 1; continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (j >= to || C[j + 1] !== "(") return null;
  let k = j + 2, par = 0;
  while (k < to && /[ \t\n]/.test(C[k])) k++;
  const hs = k;
  if (C[k] === "<") { const e = C.indexOf(">", k); if (e < 0 || e >= to) return null; k = e + 1; }
  else {
    for (; k < to; k++) {
      const c = C[k];
      if (c === "\\") { k++; continue; }
      if (c === "(") par++;
      else if (c === ")") { if (par === 0) break; par--; }
      else if (/\s/.test(c)) break;
    }
  }
  const href = C.slice(hs, k).replace(/^<|>$/g, "");
  while (k < to && /[ \t\n]/.test(C[k])) k++;
  if (C[k] === '"' || C[k] === "'" || C[k] === "(") {
    const q = C[k] === "(" ? ")" : C[k];
    const e = C.indexOf(q, k + 1);
    if (e < 0 || e >= to) return null;
    k = e + 1;
    while (k < to && /[ \t\n]/.test(C[k])) k++;
  }
  if (C[k] !== ")") return null;
  return { textEnd: j, href, end: k + 1 };
}

function lex(C, from, to, bad) {
  const T = [];
  let i = from;
  while (i < to) {
    const c = C[i];
    if (c === "\\" && i + 1 < to && ESCAPABLE.includes(C[i + 1])) { T.push({ t: "ch", c: C[i + 1], s: i, e: i + 2 }); i += 2; continue; }
    if (c === "`") {
      let k = i;
      while (k < to && C[k] === "`") k++;
      const run = k - i;
      let j = k, close = -1;
      while (j < to) {
        if (C[j] === "`") { let m = j; while (m < to && C[m] === "`") m++; if (m - j === run) { close = j; break; } j = m; } else j++;
      }
      if (close >= 0) { T.push({ t: "code", s: i, e: close + run, cs: k, ce: close }); i = close + run; continue; }
      for (let q = i; q < k; q++) T.push({ t: "ch", c: "`", s: q, e: q + 1 });
      i = k; continue;
    }
    if (c === "!" && C[i + 1] === "[") {
      const L = linkAt(C, i + 1, to);
      if (L) { T.push({ t: "img", s: i, e: L.end }); i = L.end; continue; }
    }
    if (c === "[") {
      const L = linkAt(C, i, to);
      if (L) { T.push({ t: "link", s: i, e: L.end, ts: i + 1, te: L.textEnd, href: L.href, kids: lex(C, i + 1, L.textEnd, bad) }); i = L.end; continue; }
    }
    if (c === "<") {
      const rest = C.slice(i, to);
      let m;
      if ((m = /^<!--[\s\S]*?-->/.exec(rest))) { T.push({ t: "tag", name: "!--", s: i, e: i + m[0].length, close: false, void: true }); i += m[0].length; continue; }
      if ((m = /^<((?:https?|ftp):\/\/[^<>\s]*|mailto:[^<>\s]+|[^<>\s@!]+@[^<>\s@]+)>/i.exec(rest))) {
        T.push({ t: "auto", s: i, e: i + m[0].length, ts: i + 1, te: i + m[0].length - 1 }); i += m[0].length; continue;
      }
      if ((m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/.exec(rest))) {
        const name = m[2].toLowerCase();
        if (!INLINE_TAGS.has(name) && !/^[a-z][a-z0-9-]*$/.test(name)) bad.push(`the tag <${name}>`);
        if (["div", "p", "table", "pre", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "section", "script", "style"].includes(name)) bad.push(`the tag <${name}>`);
        T.push({ t: "tag", name, attrs: m[3] || "", s: i, e: i + m[0].length, close: m[1] === "/", void: m[4] === "/" || VOID_TAGS.has(name) });
        i += m[0].length; continue;
      }
    }
    if (c === "&") {
      const m = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(C.slice(i, Math.min(to, i + 40)));
      if (m) {
        const n = m[1];
        let ch = null;
        if (n[0] === "#") { const cp = /x/i.test(n[1]) ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10); try { ch = String.fromCodePoint(cp); } catch { ch = null; } }
        else ch = ENTITIES[n] ?? null;
        if (ch === null) bad.push(`the entity &${n};`);
        else { T.push({ t: WS.test(ch) ? "ws" : "ch", c: ch, s: i, e: i + m[0].length }); i += m[0].length; continue; }
      }
    }
    if (c === "*" || c === "_") {
      let k = i;
      while (k < to && C[k] === c) k++;
      T.push({ t: "delim", c, n: k - i, s: i, e: k });
      i = k; continue;
    }
    if (WS.test(c)) { T.push({ t: "ws", s: i, e: i + 1 }); i++; continue; }
    // A character outside the Basic Multilingual Plane is two UTF-16 units: keep them as one.
    const cp = C.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;
    T.push({ t: "ch", c: C.slice(i, i + w), s: i, e: i + w });
    i += w;
  }
  return T;
}

// ---- emphasis: the CommonMark delimiter algorithm, which Python-Markdown follows for the cases that matter ----
// A mismatch on an odd case is caught by the server, which compares with Python-Markdown's own text.
function emphasis(C, T, from, to, conts) {
  const before = (s) => (s > from ? C[s - 1] : " ");
  const after = (e) => (e < to ? C[e] : " ");
  const D = [];
  for (const tok of T) {
    if (tok.t !== "delim") continue;
    const b = before(tok.s), a = after(tok.e);
    const lf = !WS.test(a) && (!PUNCT.test(a) || WS.test(b) || PUNCT.test(b));
    const rf = !WS.test(b) && (!PUNCT.test(b) || WS.test(a) || PUNCT.test(a));
    tok.open = tok.c === "*" ? lf : lf && (!rf || PUNCT.test(b));
    tok.closeOk = tok.c === "*" ? rf : rf && (!lf || PUNCT.test(a));
    tok.left = tok.n; tok.used0 = 0; tok.used1 = 0; tok.dead = false;
    D.push(tok);
  }
  for (let ci = 0; ci < D.length; ci++) {
    const d = D[ci];
    if (!d.closeOk) continue;
    while (d.left > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = D[k];
        if (o.dead || o.c !== d.c || !o.open || o.left <= 0) continue;
        if ((o.closeOk || d.open) && (o.n + d.n) % 3 === 0 && !(o.n % 3 === 0 && d.n % 3 === 0)) continue;
        oi = k; break;
      }
      if (oi < 0) break;
      const o = D[oi];
      const use = o.left >= 2 && d.left >= 2 ? 2 : 1;
      const os = o.e - o.used1 - use;
      conts.push({ kind: use === 2 ? "strong" : "em", open: [os, os + use], close: [d.s + d.used0, d.s + d.used0 + use] });
      o.left -= use; o.used1 += use; d.left -= use; d.used0 += use;
      for (let k = oi + 1; k < ci; k++) D[k].dead = true; // delimiters between them stay literal
    }
  }
}

// ---- the visible characters ------------------------------------------------------------------------------
function emit(C, T, from, to, conts, out, bad) {
  emphasis(C, T, from, to, conts);
  const tags = [];
  const push = (c, s, e) => {
    if (WS.test(c)) {
      if (!out.length) return; // leading whitespace never shows
      const last = out[out.length - 1];
      if (last.c === " ") { if (last.e === s) last.e = e; return; } // one space for a run
      out.push({ c: " ", s, e });
      return;
    }
    out.push({ c, s, e });
  };
  for (const tok of T) {
    switch (tok.t) {
      case "ch": push(tok.c, tok.s, tok.e); break;
      case "ws": push(" ", tok.s, tok.e); break;
      case "delim": {
        // the part of the run no emphasis took shows as it is
        for (let p = tok.s + (tok.used0 || 0); p < tok.e - (tok.used1 || 0); p++) push(tok.c, p, p + 1);
        break;
      }
      case "code": {
        // Python-Markdown strips the whole of the code span's leading and trailing whitespace
        let a = tok.cs, b = tok.ce;
        while (a < b && WS.test(C[a])) a++;
        while (b > a && WS.test(C[b - 1])) b--;
        conts.push({ kind: "code", open: [tok.s, a], close: [b, tok.e] });
        for (let p = a; p < b; p++) push(C[p], p, p + 1);
        break;
      }
      case "link":
        conts.push({ kind: "link", href: tok.href, open: [tok.s, tok.ts], close: [tok.te, tok.e] });
        emit(C, tok.kids, tok.ts, tok.te, conts, out, bad);
        break;
      case "auto":
        conts.push({ kind: "link", href: C.slice(tok.ts, tok.te), open: [tok.s, tok.ts], close: [tok.te, tok.e] });
        for (let p = tok.ts; p < tok.te; p++) push(C[p], p, p + 1);
        break;
      case "img": break; // a picture has no words
      case "tag":
        if (tok.name === "br") { push(" ", tok.s, tok.e); break; }
        if (tok.void) break;
        if (!tok.close) { tags.push(tok); break; }
        for (let k = tags.length - 1; k >= 0; k--) {
          if (tags[k].name !== tok.name) continue;
          const o = tags.splice(k, 1)[0];
          conts.push({ kind: "tag", name: o.name, attrs: o.attrs, open: [o.s, o.e], close: [tok.s, tok.e] });
          break;
        }
        break;
    }
  }
}

function styleKey(c) {
  const st = {};
  if (c.kind === "strong") st.b = 1;
  else if (c.kind === "em") st.i = 1;
  else if (c.kind === "code") st.code = 1;
  else if (c.kind === "link") st.link = 1;
  else if (c.kind === "tag") {
    const n = c.name;
    if (n === "b" || n === "strong") st.b = 1;
    else if (n === "i" || n === "em" || n === "cite") st.i = 1;
    else if (n === "u" || n === "ins") st.u = 1;
    else if (n === "s" || n === "del") st.strike = 1;
    else if (n === "code" || n === "kbd") st.code = 1;
    else if (n === "sup" || n === "sub") st[n] = 1;
    else if (n === "small") st.small = 1;
    else if (n === "mark") st.mark = 1;
    else if (n === "a") st.link = 1;
    const cls = /class\s*=\s*["']([^"']*)["']/i.exec(c.attrs || "");
    if (cls && /\bnw\b/.test(cls[1])) st.color = "#1e90ff";
    const col = /style\s*=\s*["'][^"']*?(?:^|;|\s)color\s*:\s*([^;"']+)/i.exec(c.attrs || "");
    if (col) st.color = col[1].trim();
    if (/style\s*=\s*["'][^"']*font-weight\s*:\s*(bold|[6-9]00)/i.test(c.attrs || "")) st.b = 1;
    if (/style\s*=\s*["'][^"']*font-style\s*:\s*italic/i.test(c.attrs || "")) st.i = 1;
  }
  return st;
}

/** A block of Markdown as it shows: its words, where each comes from, and how each looks. */
export function parse(md) {
  const B = lines(String(md));
  if (!B.ok) return B;
  const bad = [];
  const T = lex(B.C, 0, B.C.length, bad);
  const conts = [], out = [];
  emit(B.C, T, 0, B.C.length, conts, out, bad);
  if (bad.length) return { ok: false, why: bad[0] };
  while (out.length && out[out.length - 1].c === " ") out.pop();
  const toSrc = (s, e) => (e > s ? [B.cmap[s][0], B.cmap[e - 1][1]] : [B.cmap[Math.min(s, B.cmap.length - 1)]?.[0] ?? B.start, B.cmap[Math.min(s, B.cmap.length - 1)]?.[0] ?? B.start]);
  const spans = out.map((o) => toSrc(o.s, o.e));
  // containers in source coordinates, with the visible characters each holds
  const C2 = conts.map((c) => ({ ...c, open: toSrc(c.open[0], c.open[1]), close: toSrc(c.close[0], c.close[1]), cs: c.open[1], ce: c.close[0] }));
  const keys = new Map(), styles = [], style = [];
  const cover = C2.map(() => [Infinity, -1]);
  out.forEach((o, i) => {
    const st = {};
    C2.forEach((c, k) => {
      if (o.s >= c.cs && o.e <= c.ce) {
        Object.assign(st, styleKey(c));
        if (i < cover[k][0]) cover[k][0] = i;
        cover[k][1] = i + 1;
      }
    });
    const key = JSON.stringify(st);
    if (!keys.has(key)) { keys.set(key, styles.length); styles.push(st); }
    style.push(keys.get(key));
  });
  C2.forEach((c, k) => { c.from = cover[k][1] < 0 ? -1 : cover[k][0]; c.to = cover[k][1]; });
  return { ok: true, text: out.map((o) => o.c).join(""), spans, style, styles, conts: C2, start: B.start, kind: B.kind, marker: B.marker };
}

// ---- the change he typed, placed in the source ----------------------------------------------------------
const TOKEN = /[\p{L}\p{N}\p{M}]+|\n| |[^\s\p{L}\p{N}\p{M}]/gu;
const toks = (s) => s.match(TOKEN) || [];

// The changed stretches between old and new, on whole words, so a changed word takes the place (and the look)
// of the word it replaces. Each: [old start, old end, new text] in characters.
function hunks(a, b) {
  const A = toks(a), Bt = toks(b);
  let p = 0;
  while (p < A.length && p < Bt.length && A[p] === Bt[p]) p++;
  let s = 0;
  while (s < A.length - p && s < Bt.length - p && A[A.length - 1 - s] === Bt[Bt.length - 1 - s]) s++;
  const a1 = A.slice(p, A.length - s), b1 = Bt.slice(p, Bt.length - s);
  const n = a1.length, m = b1.length;
  if (n * m > 4_000_000) throw new Error("this change is too large to place word by word");
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a1[i] === b1[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const posA = [0];
  for (const t of A) posA.push(posA[posA.length - 1] + t.length);
  let i = 0, j = 0, hi = -1, hj = -1;
  const flush = () => {
    if (hi < 0) return;
    out.push([posA[p + hi], posA[p + i], b1.slice(hj, j).join("")]);
    hi = hj = -1;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a1[i] === b1[j]) { flush(); i++; j++; continue; }
    if (hi < 0) { hi = i; hj = j; }
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) j++;
    else i++;
  }
  flush();
  return out;
}

const escapeText = (t, lineStart) => {
  let s = t.replace(/\\/g, "\\\\").replace(/[`*_[\]]/g, "\\$&").replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;").replace(/</g, "&lt;");
  if (lineStart) s = s.replace(/^([#>+-])/, "\\$1").replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
  return s;
};

// A deleted word takes one of the spaces beside it, and which one is a choice: "whole **village.** In" with
// "village." gone is right only when the space BEFORE the word goes ("whole** In" keeps the bold closed), and
// "a **first words**" with "first" gone only when the space AFTER it goes. Each deletion that can slide by one
// space is tried both ways; the first version whose Markdown shows exactly the typed words wins.
function variants(H, text) {
  const left = H.map(([a0, a1, x]) => (!x && a0 > 0 && text[a0 - 1] === " " && text[a1 - 1] === " " ? [a0 - 1, a1 - 1, x] : [a0, a1, x]));
  const right = H.map(([a0, a1, x]) => (!x && text[a0] === " " && text[a1] === " " ? [a0 + 1, a1 + 1, x] : [a0, a1, x]));
  const out = [H];
  for (const v of [left, right]) if (JSON.stringify(v) !== JSON.stringify(H)) out.push(v);
  if (H.length > 1) H.forEach((h, i) => { for (const alt of [left[i], right[i]]) if (alt !== h && (alt[0] !== h[0])) out.push(H.map((x, j) => (j === i ? alt : x))); });
  return out;
}

/** The block's Markdown once its visible text reads `want` ("\n" where he started a new paragraph). */
export function applyEdit(md, P, want) {
  if (!P?.ok) throw new Error(P?.why ? `this paragraph has ${P.why}` : "this paragraph cannot be mapped");
  want = String(want).normalize("NFC").replace(/\r/g, "").replace(/[^\S\n]+/gu, " ").replace(/ *\n[\s]*/g, "\n").trim();
  if (!want) return "";
  if (want === P.text) return md;
  let first = null;
  for (const H of variants(hunks(P.text, want), P.text)) {
    try { return place(md, P, want, H); } catch (err) { first ??= err; }
  }
  throw first;
}

function place(md, P, want, H) {
  const kind = P.kind, n = P.text.length;
  const BREAK = kind === "quote" ? "\n>\n> " : kind === "ul" || kind === "ol" ? `\n${P.marker} ` : "\n\n";
  const del = new Uint8Array(n);
  const ins = []; // {at, text}
  const inside = (c, at) => at >= c.open[1] && at <= c.close[0];
  const contsOf = (k) => P.conts.filter((c) => c.from >= 0 && k >= c.from && k < c.to);
  const put = (pos, text, first) => {
    if (text.includes("\n") && P.conts.some((c) => c.from >= 0 && inside(c, pos)))
      throw new Error("a new paragraph inside bold, italic or a link cannot be placed yet");
    const parts = text.split("\n").map((t, i) => escapeText(t, i > 0 || (first && pos === P.start)));
    ins.push({ at: pos, text: parts.join(BREAK) });
  };
  for (const [a0, a1, x] of H) {
    for (let k = a0; k < a1; k++) del[k] = 1;
    if (!x) continue;
    if (a1 > a0) { put(P.spans[a0][0], x, a0 === 0); continue; } // a replaced word: in its place and look
    // an insertion between characters A and B
    const A = a0 > 0 ? a0 - 1 : -1, Bk = a0 < n ? a0 : -1;
    const ca = A >= 0 ? contsOf(A) : [], cb = Bk >= 0 ? contsOf(Bk) : [];
    const onlyA = ca.filter((c) => !cb.includes(c));
    const word = (k) => k >= 0 && !WS.test(P.text[k]);
    let pos;
    if (A < 0) pos = !WS.test(x[x.length - 1]) && word(Bk) ? P.spans[Bk][0] : Math.min(P.spans[0][0], ...cb.map((c) => c.open[0]));
    else if (Bk < 0) pos = !WS.test(x[0]) && word(A) ? P.spans[A][1] : Math.max(P.spans[A][1], ...ca.map((c) => c.close[1]));
    else if (!WS.test(x[0]) && word(A)) pos = P.spans[A][1]; // continues A's word: A's look
    else if (!WS.test(x[x.length - 1]) && word(Bk)) pos = P.spans[Bk][0]; // starts B's word: B's look
    else pos = onlyA.length ? Math.max(P.spans[A][1], ...onlyA.map((c) => c.close[1])) : P.spans[A][1];
    put(pos, x, A < 0);
  }
  // A bold word, a link or a code span whose words are all gone goes with its markers, unless new text went in.
  const cut = [];
  for (let k = 0; k < n; k++) if (del[k]) cut.push(P.spans[k]);
  for (const c of P.conts) {
    if (c.from < 0 || c.to <= c.from) continue;
    let all = true;
    for (let k = c.from; k < c.to; k++) if (!del[k]) { all = false; break; }
    if (all && !ins.some((x) => inside(c, x.at))) cut.push(c.open, c.close);
  }
  cut.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s, e] of cut) {
    if (e <= s) continue;
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  for (const x of ins) if (merged.some(([s, e]) => x.at > s && x.at < e)) throw new Error("this change falls inside the Markdown markers");
  const edits = [...merged.map(([s, e]) => ({ at: s, len: e - s, text: "" })), ...ins.map((x) => ({ at: x.at, len: 0, text: x.text }))];
  edits.sort((x, y) => y.at - x.at || y.len - x.len); // same place: the deletion first, then the new text
  let out = md;
  for (const ed of edits) out = out.slice(0, ed.at) + ed.text + out.slice(ed.at + ed.len);
  out = out.replace(/^\n+|\n+$/g, "") + (md.match(/\n+$/)?.[0] ?? ""); // the file's last block keeps its final newline
  // The proof: the new Markdown must show exactly the words he typed, or nothing is written.
  const shown = blocksOf(out).map((b) => { const q = parse(b); if (!q.ok) throw new Error(`the change made ${q.why}`); return q.text; }).join(" ");
  if (norm(shown) !== norm(want)) throw Object.assign(new Error("the change could not be placed exactly"), { out, shown });
  return out;
}

// ---- the editor's look ----------------------------------------------------------------------------------
// As style properties, not HTML: the viewer's Content-Security-Policy (style-src 'self') drops style attributes
// written in HTML, so writer.js sets these through the DOM.
const look = (st) => {
  const css = {};
  if (st.b) css.fontWeight = "700";
  if (st.i) css.fontStyle = "italic";
  if (st.code) { css.fontFamily = "'wr-LiberationMono', monospace"; css.fontSize = ".92em"; }
  if (st.link) { css.color = "#7A3921"; css.textDecoration = "underline"; }
  if (st.color) css.color = st.color;
  if (st.u) css.textDecoration = "underline";
  if (st.strike) css.textDecoration = "line-through";
  if (st.sup || st.sub) { css.verticalAlign = st.sup ? "super" : "sub"; css.fontSize = ".75em"; }
  if (st.small) css.fontSize = ".85em";
  if (st.mark) css.background = "#ff0";
  return css;
};

/** Visible characters a..b of a parsed block as stretches of one look each: [{text, css}]. */
export function runs(P, a = 0, b = P.text.length) {
  const out = [];
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b && P.style[j] === P.style[i]) j++;
    out.push({ text: P.text.slice(i, j), css: look(P.styles[P.style[i]]) });
    i = j;
  }
  return out;
}

// ---- finding the tapped paragraph in the source -----------------------------------------------------------
/** Letters only (accents and case dropped), and where each came from in t. */
export function lettersOf(t) {
  let s = "";
  const map = [];
  for (let i = 0; i < t.length; i++) {
    const d = t[i].normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    for (const ch of d) { s += ch; map.push(i); }
  }
  return [s, map];
}

const rough = (b) => b.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, " ");
const LEAD = /^\s*(\d+[.)]|[•◦▪‣·*–-])\s+/; // a list item's bullet or number, printed but not in its text

/** The letters each block shows (its parsed words; a block the parser declines, roughly). Once per source text. */
export const blockLetters = (blocks) => blocks.map((b) => { const p = parse(b); return lettersOf(p.ok ? p.text : rough(b))[0]; });

/** The blocks that hold paragraph q: the ones that are exactly q if any, else the ones q is part of. No guessing:
 *  on the book's ch02 (2026-11-15) a fuzzy match sent character-card paragraphs to unrelated story blocks. */
export function candidates(L, q) {
  const [ql] = lettersOf(q.replace(LEAD, ""));
  if (ql.length < 3) return [];
  const eq = [], inc = [];
  L.forEach((l, i) => { if (l === ql) eq.push(i); else if (l.includes(ql)) inc.push(i); });
  return eq.length ? eq : inc;
}

/** The index of the block that holds q (a paragraph as the PDF prints it), or -1 when none does, or several do
 *  and no neighbour tells them apart. near: the paragraphs printed around q, nearest first, as [text, -1 above |
 *  +1 below]; the first one found in one block only decides (the source keeps the page's order). */
export function findBlock(blocks, q, near = [], L = blockLetters(blocks)) {
  const c = candidates(L, q);
  if (c.length <= 1) return c.length ? c[0] : -1;
  for (const [t, dir] of near) {
    const a = candidates(L, t);
    if (a.length !== 1) continue;
    const pick = dir < 0 ? c.filter((i) => i > a[0]).sort((x, y) => x - y)[0] : c.filter((i) => i < a[0]).sort((x, y) => y - x)[0];
    return pick ?? -1;
  }
  return -1;
}

/** Which characters of a block's visible text are the lines tapped on this page: [a, b), or null when those
 *  words are not in this block, or not in one place only (a wrong guess must never open an editor over other
 *  words). A paragraph cut by a page break is a prefix of its block at the bottom of a page and a suffix at the
 *  top of the next: `where` ("top" | "bottom") says which, for text that repeats itself. */
export function portion(text, q, where) {
  const [vl, vm] = lettersOf(text);
  const [ql] = lettersOf(q.replace(LEAD, ""));
  if (!ql || !vl.length) return null;
  const once = (s, i) => i >= 0 && vl.indexOf(s, i + 1) < 0;
  let at = -1;
  const pre = vl.startsWith(ql), suf = vl.endsWith(ql);
  if (pre && suf) at = where === "top" ? vl.length - ql.length : 0;
  else if (pre) at = 0;
  else if (suf) at = vl.length - ql.length;
  else if (once(ql, vl.indexOf(ql))) at = vl.indexOf(ql);
  let a, b;
  if (at >= 0) { a = vm[at]; b = vm[at + ql.length - 1] + 1; }
  else {
    // The page's text and the source differ a little (a ligature, a sign): its first and last letters, each in one place.
    const k = Math.min(16, ql.length);
    const head = ql.slice(0, k), tail = ql.slice(-k);
    const ia = vl.indexOf(head), ib = vl.indexOf(tail);
    if (!once(head, ia) || !once(tail, ib) || ib < ia) return null;
    a = vm[ia]; b = vm[ib + k - 1] + 1;
  }
  while (a > 0 && text[a - 1] !== " ") a--;
  while (b < text.length && text[b] !== " ") b++;
  return [a, b];
}
