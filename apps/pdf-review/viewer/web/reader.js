import { BASE } from "./base.js";

// pdf-review read-aloud. Speaks the document sentence by sentence with an offline voice (server.py
// /api/tts), highlights the sentence being read, turns the pages, and saves the exact sentence after
// each one (server.py /api/bookmark) so the next session resumes there. Reading order runs down the
// main column; a margin note is read after the paragraph beside it, and a sentence or paragraph cut
// by a page break is read whole (2026-10-18).
const app = window.PDFViewerApplication;
await app.initializedPromise;
const bus = app.eventBus;

// Running headers, footers and page numbers can only sit outside this band (fraction of page height,
// PDF y points up). A line out there is still read unless it holds a page number or repeats, digits
// aside, at the edge of a nearby page: the Ink & Switch essay prints body text right to the edge.
const BODY_TOP = 0.93;
const BODY_BOTTOM = 0.07;
const edgeKey = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const isPageNo = (t) =>
  /^\s*(page\s*)?(\d{1,4}|(?=[ivxlc])c{0,3}(xc|xl|l?x{0,3})(ix|iv|v?i{0,3}))(\s*(of|\/)\s*\d{1,4})?\s*$/i.test(t);
const MAX_CHUNK = 700; // longer "sentences" (tables, reference lists) are cut at a comma or space; Kokoro splits
// long text itself, so a real sentence stays whole (380 split them, 2026-10-18)
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
// Kokoro leaves ~0.33 s of silence before a sentence and ~0.5 s after it: that is the gap between
// sentences, and it is right (the architect, 2026-10-18). A paragraph ends with 1.5x that, a title with 2 s.
// All three shrink with the speed setting, like the voice's own silence does.
const GAP = 0.85;
const EXTRA = { para: 0.5 * GAP, head: 2 - GAP };

const st = {
  doc: null, // PDF fingerprint
  raw: new Map(), // page -> Promise<analysis of that page alone>
  rawReady: new Map(), // page -> resolved analysis, for drawing synchronously
  pages: new Map(), // page -> Promise<{list}>: the reading list that starts on this page
  ready: new Map(), // page -> resolved {list}
  audio: new Audio(),
  clips: new Map(), // "voice|page|idx" -> Promise<blob URL>
  cur: null, // {page, idx} being read
  playing: false,
  gen: 0, // bumped on every jump; a stale reading loop sees the change and exits
  wake: null,
  mark: null, // saved place, from the server
  ownFlip: false,
  follow: true, // the view turns pages with the voice; false while you look at another page
};


const speed = () => Number(localStorage.getItem("reader.speed") || "1");
const modeOf = (vals) => {
  const n = new Map();
  for (const [v, w] of vals) n.set(v, (n.get(v) || 0) + w);
  return [...n].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
};
const openSentence = (x) => !/[.!?…:;]["”’)\]]*$/.test(x.text);
const joinText = (a, b) => (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : `${a} ${b}`);
const voiceName = () => localStorage.getItem("reader.voice") || "";

// 2026-10-21 (the architect: "make it read with a good voice"): inside the Jarvis phone app the reader can
// speak with the phone's own engine (Google's neural voices) through the app's bridge, which lives
// on the Tinker page around this frame. Each sentence goes out with an id and its "done" comes back
// as a "jarvis-native" event there. The Pi's Piper stays the voice everywhere else.
const NATIVE = (() => {
  try {
    const host = window.parent !== window ? window.parent : window;
    return typeof host.JarvisNative?.speak === "function" ? host : null;
  } catch {
    return null; // a parent on another origin
  }
})();
const PHONE_VOICE = "phone";
const usePhone = () => Boolean(NATIVE) && (voiceName() === PHONE_VOICE || voiceName().startsWith("phone:"));
// 2026-10-22 (the architect: find a phone voice that intonates): "phone:<name>" is one named voice of the phone.
const phoneLang = () => (voiceName().startsWith("phone:") ? "voice:" + voiceName().slice(6) : docLang);
// The paper's language for the phone voice: English unless its words are clearly Catalan or Spanish.
function guessLang(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  const n = (set) => words.filter((w) => set.has(w)).length;
  const en = n(new Set(["the", "and", "of", "to", "is", "that", "with", "for"]));
  const ca = n(new Set(["els", "amb", "per", "és", "una", "dels", "als", "i"]));
  const es = n(new Set(["los", "con", "por", "es", "una", "del", "y", "las"]));
  if (en >= ca && en >= es) return "en-GB"; // Jarvis is British (the architect 2026-10-22)
  return ca >= es ? "ca-ES" : "es-ES";
}

// 2026-11-12 (need: listen with the screen locked, and control it from the headset and the cover
// screen). A newer app reads by itself: readNative() hands it the reading list from the current
// sentence to the end of the document, and the app speaks it from its own service, whether this page
// is awake or not. The app reports each sentence as a {ev:"reader"} event; this page then only
// highlights, turns the page and saves the place. `nat` is what the page knows of the app's reading.
const QUEUE = Boolean(NATIVE && typeof NATIVE.JarvisNative.readQueue === "function");
const useQueue = () => QUEUE && usePhone();
const nat = { active: false };
let queueSeq = 0;
const docTitle = () => (document.title || fileName()).replace(/\.pdf$/i, "");
// A long book: the lists of pages far from the place being read are dropped; they are rebuilt on demand.
function forget(page) {
  if (st.cur && Math.abs(st.cur.page - page) <= 3) return;
  for (const m of [st.raw, st.rawReady, st.pages, st.ready, edgeCache]) m.delete(page);
}
async function readNative(pos) {
  const gen = ++st.gen;
  st.audio.pause();
  st.wake?.();
  st.cur = pos;
  st.follow = true;
  st.playing = true;
  nat.active = true;
  ui();
  const first = (await sentences(pos.page)).list;
  if (st.gen !== gen) return;
  if (!docLang) docLang = guessLang(first.map((x) => x.text).join(" "));
  draw();
  save();
  const q = `${Date.now()}-${++queueSeq}`;
  let rows = [];
  let para = 0;
  let sent = false;
  const flush = (more) => {
    const msg = JSON.stringify({ q, doc: st.doc, title: docTitle(), rate: speed(), lang: phoneLang(), items: rows, more });
    if (sent) NATIVE.JarvisNative.readAppend(msg);
    else NATIVE.JarvisNative.readQueue(msg);
    sent = true;
    rows = [];
  };
  let lastPage = pos.page;
  for (let p = pos; p && st.gen === gen; p = await after(p)) {
    const e = (await sentences(p.page)).list[p.idx];
    if (!e) break;
    // [words, printed page, pause after it, paragraph number, then this sentence's place in the page's list]
    rows.push([piece(e, p.from).text, e.page, e.pause || "", para, p.page, p.idx, p.from ?? -1]);
    if (e.pause) para++;
    if (p.page !== lastPage) {
      forget(lastPage - 3);
      lastPage = p.page;
    }
    // The first sentences go at once so the voice starts; the rest follows in larger parts.
    if (rows.length >= (sent ? 120 : 6)) {
      flush(true);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (st.gen === gen) flush(false);
}
// After a long time behind the lock screen the events of every sentence read arrive together: only
// the newest one is acted on, so the page saves the place once, not once per missed sentence.
let newest = null;
let following = false;
NATIVE?.addEventListener("jarvis-native", async (ev) => {
  if (ev.detail?.ev !== "reader") return;
  newest = ev.detail;
  if (following) return;
  following = true;
  try {
    while (newest) {
      const d = newest;
      newest = null;
      await onNative(d);
    }
  } catch (err) {
    console.error("[reader] following the app's reading failed", err);
  } finally {
    following = false;
  }
});
async function onNative(d) {
  // Speed changed on the notification or the cover screen: the menu here shows it.
  if (d.rate && d.rate !== String(speed())) {
    localStorage.setItem("reader.speed", d.rate);
    $("readerSpeed").value = d.rate;
  }
  if (!st.doc || d.doc !== st.doc) {
    if (d.active === false) nat.active = false;
    return; // nothing kept, or the app is reading another document
  }
  if (!d.active) {
    // Only a kept place (the app was closed since): take it when it is newer than the saved one.
    nat.active = false;
    if (st.playing && !useQueue()) return;
    if (st.mark && !(d.ts > Date.parse(st.mark.at))) {
      if (useQueue()) { st.playing = false; ui(); }
      return;
    }
  } else nat.active = true;
  const gen = st.gen;
  if (Number.isInteger(d.page)) {
    const pos = { page: d.page, idx: d.idx, ...(d.from >= 0 ? { from: d.from } : {}) };
    await sentences(pos.page);
    if (st.gen !== gen) return;
    const e = entry(pos);
    if (e) {
      const moved = !st.cur || st.cur.page !== pos.page || st.cur.idx !== pos.idx;
      st.cur = pos;
      if (d.playing && st.follow && app.page !== e.page) {
        st.ownFlip = true;
        app.page = e.page;
        st.ownFlip = false;
      }
      draw();
      if (moved) save();
    }
  }
  st.playing = Boolean(d.playing);
  ui();
  if (d.state === "error") showError(new Error(d.message || "the phone voice failed"));
}
// The page slept behind the lock screen while the app read on: ask where it is now.
if (QUEUE) document.addEventListener("visibilitychange", () => !document.hidden && NATIVE.JarvisNative.readCtl("state", ""));

// The phone voice's sentence in flight: its id and how to finish it.
let saying = null;
let sayId = 0;
NATIVE?.addEventListener("jarvis-native", (ev) => {
  const d = ev.detail;
  if (d?.ev !== "tts" || !saying || d.id !== saying.id) return;
  const s0 = saying;
  saying = null;
  if (d.state === "done") s0.resolve();
  else s0.reject(new Error(d.message || "the phone voice failed"));
});
let docLang = "";
// Readable names for Google's phone voices (2026-10-22, the architect: "prettier names than 3 letters").
// Google publishes no gender for these codes; this table is the community-reported one, so the menu
// marks it with "?" until he has heard them.
const ACCENT = { "en-GB": "British", "en-US": "American", "en-AU": "Australian", "en-IN": "Indian", "es-ES": "Spanish", "es-US": "Latin American", "ca-ES": "Catalan" };
const MALE = new Set(["gbb", "gbd", "rjs", "iol", "iom", "tpd", "eed", "eef", "esd", "esf", "bmj", "rjm"]);
const FEMALE = new Set(["gba", "gbc", "gbg", "fis", "iob", "iog", "sfg", "tpc", "tpf", "eea", "eec", "eee", "esc", "ese", "caf", "bmh"]);
function prettyVoice(v) {
  const code = (v.name.match(/-x-([a-z]{3})/) || [])[1] || "";
  const who = MALE.has(code) ? "Male" : FEMALE.has(code) ? "Female" : "Voice";
  const accent = ACCENT[v.locale] || v.locale;
  return `📱 ${accent} ${who}${code ? " · " + code.toUpperCase() : ""}${v.network ? " (online)" : ""}`;
}
// 2026-10-22 (the architect 05:59): GBD is the reader's default inside the app, online when it exists.
const DEFAULT_PHONE = /-x-gbd-/;
// The phone's voices, English, Spanish and Catalan only, appended to the voice menu.
NATIVE?.addEventListener("jarvis-native", (ev) => {
  const d = ev.detail;
  if (d?.ev !== "voices" || !Array.isArray(d.list)) return;
  const sel = $("readerVoice");
  sel.querySelectorAll("option[data-phone]").forEach((o) => o.remove());
  // Men first, then by accent: the voice he is looking for is near the top.
  const rank = (v) => (MALE.has((v.name.match(/-x-([a-z]{3})/) || [])[1]) ? 0 : 1);
  for (const v of [...d.list].sort((a, b) => rank(a) - rank(b) || a.locale.localeCompare(b.locale))) {
    if (!/^(en|es|ca)\b/.test(v.locale) || !v.installed && !v.network) continue;
    const o = document.createElement("option");
    o.value = "phone:" + v.name;
    o.dataset.phone = "1";
    o.textContent = prettyVoice(v);
    sel.append(o);
  }
  // 2026-11-08 (need: no clipped first words, short gaps): the offline copy of the voice first. The
  // network copy fetches every sentence before speaking it. The flag was renamed so phones pick again once.
  if (voiceName() === PHONE_VOICE || !localStorage.getItem("reader.gbdLocal")) {
    const gbd = d.list.filter((v) => DEFAULT_PHONE.test(v.name)).sort((a, b) => b.installed - a.installed || a.network - b.network)[0];
    if (gbd) {
      localStorage.setItem("reader.voice", "phone:" + gbd.name);
      localStorage.setItem("reader.gbdLocal", "1");
    }
  }
  sel.value = voiceName();
});


// Split a page into lines, then into blocks: titles (bigger, or a whole line in bold) and
// paragraphs (a blank gap, a first-line indent, or a short last line ending a sentence). Sentences
// are cut inside a block only, so a title is read and highlighted on its own. The last sentence of a
// block carries `pause`: "para" or "head", the extra silence read() leaves after it.
function layout(lines, text, { ragged = false } = {}) {
  const mode = (vals) => {
    const n = new Map();
    for (const [v, w] of vals) n.set(v, (n.get(v) || 0) + w);
    return [...n].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
  };
  const body = mode(lines.map((l) => [l.size, l.end - l.start]));
  const plain = lines.filter((l) => Math.abs(l.size - body) < 0.6);
  const left = mode(plain.map((l) => [Math.round(l.x0), l.end - l.start]));
  const rights = plain.map((l) => l.x1).sort((x, y) => x - y);
  const right = rights[Math.floor(rights.length * 0.9)] ?? 0;
  const dys = [];
  for (let i = 1; i < plain.length; i++) {
    const dy = plain[i - 1].y - plain[i].y;
    if (dy > 0 && dy < 3 * body) dys.push(dy);
  }
  dys.sort((x, y) => x - y);
  const pitch = dys[Math.floor(dys.length / 2)] || 1.2 * body;
  const tail = (l) => text.slice(l.start, l.end).trimEnd();
  const ends = (l) => /[.!?:;)"”’]$/.test(tail(l));
  const isHead = (l) => (l.end - l.start < 160 && l.size >= 1.08 * body) ||
    (l.bold > 0.9 * (l.end - l.start) && l.end - l.start < 100 && !/[.,;]$/.test(tail(l)));
  const blocks = [];
  let cur = null;
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const head = isHead(l);
    let split = !cur || head !== cur.head;
    if (!split && head) split = Math.abs(l.size - prev.size) > 0.6 || prev.y - l.y > 2.2 * pitch;
    if (!split && !head) {
      const dy = prev.y - l.y;
      const indent = l.x0 - left;
      split = dy > 1.4 * pitch ||
        (indent > 0.7 * body && indent < 4 * body && ends(prev)) ||
        (!ragged && prev.x1 < right - 0.12 * (right - left) && ends(prev) && dy > 0);
    }
    if (split) blocks.push((cur = { start: l.start, end: l.end, head, first: l, last: l }));
    else Object.assign(cur, { end: l.end, last: l });
  });
  // The page's last block runs on overleaf unless it is a title or visibly ends its paragraph.
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock && !lastBlock.head) {
    const l = lastBlock.last;
    lastBlock.open = !(ends(l) && l.x1 < right - 0.12 * (right - left));
  }
  return blocks;
}

// The lines of a page outside the body band: {key, y, pageNo} per line, keyed by the line's baseline.
const edgeCache = new Map();
function edgeLines(page) {
  if (!edgeCache.has(page)) {
    edgeCache.set(page, (async () => {
      const pdfPage = await app.pdfDocument.getPage(page);
      const [, y0, , y1] = pdfPage.view;
      const byY = new Map();
      for (const it of (await pdfPage.getTextContent()).items) {
        if (typeof it.str !== "string" || !it.str.trim()) continue;
        const rel = (it.transform[5] - y0) / (y1 - y0);
        if (rel <= BODY_TOP && rel >= BODY_BOTTOM) continue;
        const y = Math.round(it.transform[5]);
        const l = byY.get(y) || { text: "", pageNo: false };
        l.text += ` ${it.str}`;
        l.pageNo ||= isPageNo(it.str);
        byY.set(y, l);
      }
      return byY;
    })());
  }
  return edgeCache.get(page);
}

// Is the edge line at baseline y on this page a running header/footer?
async function running(page, y) {
  const mine = (await edgeLines(page)).get(y);
  if (!mine || mine.pageNo) return true;
  const key = edgeKey(mine.text);
  for (const k of [-1, 1, -2, 2]) {
    const q = page + k;
    if (q < 1 || q > app.pagesCount) continue;
    for (const l of (await edgeLines(q)).values()) if (edgeKey(l.text) === key) return true;
  }
  return false;
}

function analyse(page) {
  if (!st.raw.has(page)) {
    st.raw.set(page, (async () => {
      const pdfPage = await app.pdfDocument.getPage(page);
      const [, y0, , y1] = pdfPage.view;
      const tc = await pdfPage.getTextContent();
      // Font names (for bold) arrive with the operator list; a rendered page already has them.
      await pdfPage.getOperatorList().catch((err) => console.error("[reader] font list failed", err));
      const boldFont = new Map();
      const isBold = (fn) => {
        if (!boldFont.has(fn)) {
          let f = null;
          try { f = pdfPage.commonObjs.has(fn) ? pdfPage.commonObjs.get(fn) : null; } catch { f = null; }
          boldFont.set(fn, Boolean(f && (f.bold || /bold|black|heavy|semibold|demi/i.test(f.name || ""))));
        }
        return boldFont.get(fn);
      };
      let text = "";
      const runs = [];
      const lines = [];
      let line = null;
      const softHyphens = new Set();
      for (const it of tc.items) {
        if (typeof it.str !== "string") continue;
        const rel = (it.transform[5] - y0) / (y1 - y0);
        if ((rel > BODY_TOP || rel < BODY_BOTTOM) && await running(page, Math.round(it.transform[5]))) continue;
        if (it.str) {
          const [, , c, d, e, f] = it.transform;
          const h = Math.hypot(c, d) || it.height;
          if (!line || line.closed || Math.abs(f - line.y) > 0.6 * Math.max(h, line.h)) {
            // A new line that pdf.js did not flag with an end-of-line still needs a word break.
            if (line && !line.closed && text && !/[\s-]$/.test(text)) text += " ";
            line = { start: text.length, end: text.length, y: f, x0: e, x1: e, h, sizes: [], bold: 0 };
            lines.push(line);
          }
          const bold = it.str.trim() !== "" && isBold(it.fontName);
          runs.push({ start: text.length, end: text.length + it.str.length, it, bold });
          text += it.str;
          line.end = text.length;
          line.x0 = Math.min(line.x0, e);
          line.x1 = Math.max(line.x1, e + it.width);
          line.h = Math.max(line.h, h);
          line.sizes.push([Math.round(h * 2) / 2, it.str.length]);
          if (bold) line.bold += it.str.length;
        }
        if (it.hasEOL) {
          if (text.endsWith("-")) softHyphens.add(text.length - 1);
          else if (!text.endsWith(" ")) text += " ";
          if (line) line.closed = true;
        }
      }
      for (const l of lines) {
        const n = new Map();
        for (const [v, w] of l.sizes) n.set(v, (n.get(v) || 0) + w);
        l.size = [...n].sort((x, y) => y[1] - x[1])[0][0];
      }
      const chars = (l) => l.end - l.start;
      const speakable = (start, end) => {
        let speak = "";
        for (let i = start; i < end; i++) {
          if (!(softHyphens.has(i) && /\p{Ll}/u.test(text[i + 1] || ""))) speak += text[i];
        }
        return speak.replace(/\s+/g, " ").trim();
      };
      const boldShare = (start, end) => {
        let all = 0, bold = 0;
        for (const r of runs) {
          const n = Math.min(end, r.end) - Math.max(start, r.start);
          if (n > 0) { all += n; if (r.bold) bold += n; }
        }
        return all ? bold / all : 0;
      };
      // Margin notes: lines wholly right of the main column's right edge (or left of its left edge).
      // When they hold a big share of the page they are a second column of text, not notes.
      const body = modeOf(lines.map((l) => [l.size, chars(l)]));
      const left = modeOf(lines.filter((l) => Math.abs(l.size - body) < 0.6).map((l) => [Math.round(l.x0), chars(l)]));
      const atLeft = lines.filter((l) => Math.abs(l.x0 - left) < 2).map((l) => l.x1).sort((x, y) => x - y);
      const right = atLeft[Math.floor(atLeft.length * 0.9)] ?? Infinity;
      let side = lines.filter((l) => l.x0 >= right - 0.5 * body || l.x1 <= left + 0.5 * body);
      if (side.reduce((n, l) => n + chars(l), 0) > 0.35 * lines.reduce((n, l) => n + chars(l), 0)) side = [];
      const mainLines = lines.filter((l) => !side.includes(l));

      const toSentences = (blocks) => blocks.map((b) => {
        const list = [];
        const push = (start, end) => {
          const speak = speakable(start, end);
          if (/[\p{L}\p{N}]/u.test(speak)) list.push({ page, start, end, text: speak });
        };
        const pushChunked = (start, end) => {
          while (end - start > MAX_CHUNK) {
            const window = text.slice(start, start + MAX_CHUNK);
            const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
            const stop = start + (cut > 40 ? cut + 1 : MAX_CHUNK);
            push(start, stop);
            start = stop;
          }
          if (end - start >= 2) push(start, end);
        };
        // A title block is split into sentences too (2026-11-16: always one sentence at a time): on a page
        // with a character card the card's small type is the body size, and the story paragraph after it read as one
        // "title" of 220 characters. A real title is one sentence, so splitting it changes nothing.
        {
          for (const seg of segmenter.segment(text.slice(b.start, b.end))) {
            const start = b.start + seg.index + (seg.segment.length - seg.segment.trimStart().length);
            pushChunked(start, b.start + seg.index + seg.segment.trimEnd().length);
          }
          // A run-in title ("Persistent Agents and Memory. AutoGen …") is a bold first sentence.
          const lead = list[0];
          if (lead && !b.head && list.length > 1 && lead.text.length < 120 && boldShare(lead.start, lead.end) > 0.9) lead.pause = "head";
        }
        if (list.length && !b.open) list[list.length - 1].pause = b.head ? "head" : "para";
        return { ...b, sentences: list };
      }).filter((b) => b.sentences.length);

      const main = toSentences(layout(mainLines, text));
      // Notes are ragged right: a short line there says nothing about where a paragraph ends.
      const notes = toSentences(layout(side, text, { ragged: true }).map((b) => ({ ...b, open: false })));
      // A note is read after the main block that starts at or above the note's first line.
      for (const nb of notes) {
        nb.anchor = 0;
        main.forEach((mb, k) => { if (mb.first.y >= nb.first.y - 0.5 * body) nb.anchor = k; });
      }
      const lastMain = main.at(-1)?.sentences.at(-1);
      const lastNote = notes.at(-1)?.sentences.at(-1);
      if (lastNote && openSentence(lastNote)) delete lastNote.pause;
      const mainParaOpen = Boolean(main.at(-1)?.open);
      const data = {
        text, runs, speakable, main, notes, lastMain, lastNote, mainParaOpen,
        mainSentOpen: mainParaOpen && openSentence(lastMain),
        noteSentOpen: Boolean(lastNote && openSentence(lastNote)),
      };
      st.rawReady.set(page, data);
      return data;
    })());
  }
  return st.raw.get(page);
}

// The reading list that starts on a page. Its entries are sentences, each with the page it is
// printed on: a margin note whose paragraph ran on overleaf is read on the next page's list, after
// that paragraph ends. A sentence cut by the page break carries `cont`, its end on the next page; the
// matching fragment heads the next page's list as a `tail`, which after() skips when the joined
// sentence was just read, and which is read alone when you start on that page.
function sentences(page) {
  if (!st.pages.has(page)) {
    st.pages.set(page, (async () => {
      const cur = await analyse(page);
      const prev = page > 1 ? await analyse(page - 1) : null;
      const next = page < app.pagesCount ? await analyse(page + 1) : null;
      const prev2 = page > 2 ? await analyse(page - 2) : null;
      // A page that opens on a title starts fresh, whatever the page before looked like.
      const contMain = Boolean(prev?.mainParaOpen && cur.main.length && !cur.main[0].head);
      const contNote = Boolean(prev?.noteSentOpen && cur.notes.length);
      const prevContNote = Boolean(prev2?.noteSentOpen && prev?.notes.length);
      const deferLast = Boolean(cur.mainParaOpen && next?.main.length && !next.main[0].head);
      const list = [];
      const add = (sents, tailFirst = false) => sents.forEach((x, i) => list.push({ ...x, tail: tailFirst && i === 0 }));
      if (contMain) {
        add(cur.main[0].sentences, prev.mainSentOpen);
        prev.notes.forEach((nb, j) => nb.anchor === prev.main.length - 1 && !(prevContNote && j === 0) && add(nb.sentences));
      }
      if (contNote) add(cur.notes[0].sentences, true);
      const notesAt = (k) => cur.notes.filter((nb, j) => nb.anchor === k && !(contNote && j === 0));
      cur.main.forEach((mb, k) => {
        if (!(k === 0 && contMain)) add(mb.sentences);
        if (!(k === cur.main.length - 1 && deferLast)) for (const nb of notesAt(k)) add(nb.sentences);
      });
      if (!cur.main.length) cur.notes.forEach((nb, j) => !(contNote && j === 0) && add(nb.sentences));
      // Join a sentence cut by the page break with its end overleaf.
      for (const e of list) {
        const [raw, nxt] = e.page === page ? [cur, next] : [prev, cur];
        if (!nxt) continue;
        let t = null;
        if (raw.mainSentOpen && raw.lastMain && e.start === raw.lastMain.start && nxt.main.length && !nxt.main[0].head) {
          t = nxt.main[0].sentences[0];
        }
        else if (raw.noteSentOpen && raw.lastNote && e.start === raw.lastNote.start && nxt.notes.length) t = nxt.notes[0].sentences[0];
        // Join only a real cut: the words overleaf go on with the sentence (a lowercase start, or the cut ends on
        // , ; : or -). A card label at a page's foot ("CH A R A C T E R C A R D") was glued to page 25's first
        // sentence (2026-11-16).
        if (t && !(/^[\s"“‘(]*\p{Ll}/u.test(t.text) || /[,;:\-–—]\s*$/.test(e.text))) t = null;
        if (t) Object.assign(e, { cont: { page: t.page, start: t.start, end: t.end }, own: e.text, text: joinText(e.text, t.text), pause: t.pause });
      }
      const data = { list };
      st.ready.set(page, data);
      return data;
    })());
  }
  return st.pages.get(page);
}

async function firstFrom(page) {
  for (let p = page; p <= app.pagesCount; p++) {
    if ((await sentences(p)).list.length) return { page: p, idx: 0 };
  }
  return null;
}

async function after(pos) {
  const d = await sentences(pos.page);
  const cur = d.list[pos.idx];
  let n = pos.idx + 1 < d.list.length ? { page: pos.page, idx: pos.idx + 1 }
    : pos.page < app.pagesCount ? await firstFrom(pos.page + 1) : null;
  if (n && cur?.cont) {
    const e = (await sentences(n.page)).list[n.idx];
    if (e && e.page === cur.cont.page && e.start === cur.cont.start) n = await after(n); // its end, already read
  }
  return n;
}

// The stretch of text a position covers: its sentence, or from `pos.from` to the sentence end.
const entry = (pos) => st.ready.get(pos.page)?.list[pos.idx];
function piece(e, from) {
  if (!(from > e.start)) return e;
  const own = st.rawReady.get(e.page).speakable(from, e.end);
  const rest = e.cont ? st.rawReady.get(e.cont.page)?.speakable(e.cont.start, e.cont.end) : "";
  return { ...e, start: from, own, text: rest ? joinText(own, rest) : own };
}

function clip(pos) {
  const key = `${voiceName()}|${pos.page}|${pos.idx}|${pos.from ?? ""}`;
  if (!st.clips.has(key)) {
    st.clips.set(key, sentences(pos.page).then((d) =>
      fetch(BASE + "/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: piece(d.list[pos.idx], pos.from).text, voice: voiceName() }),
      })
    ).then((r) => {
      if (!r.ok) throw new Error(`tts HTTP ${r.status}`);
      return r.blob();
    }).then((b) => URL.createObjectURL(b)));
  }
  return st.clips.get(key);
}

function dropClip(pos) {
  const key = `${voiceName()}|${pos.page}|${pos.idx}|${pos.from ?? ""}`;
  st.clips.get(key)?.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  st.clips.delete(key);
}

function draw() {
  for (const n of document.querySelectorAll(".readerMark")) n.remove();
  const e = st.cur && entry(st.cur);
  if (!e) return;
  const segs = [{ page: e.page, start: Math.max(e.start, st.cur.from ?? 0), end: e.end }];
  if (e.cont) segs.push(e.cont);
  for (const s of segs) {
    const data = st.rawReady.get(s.page);
    const view = app.pdfViewer.getPageView(s.page - 1);
    if (!data || !view?.viewport) continue;
    const layer = document.createElement("div");
    layer.className = "readerMark";
    for (const r of data.runs) {
      if (r.end <= s.start || r.start >= s.end) continue;
      const len = r.end - r.start;
      const a = (Math.max(s.start, r.start) - r.start) / len;
      const b = (Math.min(s.end, r.end) - r.start) / len;
      const [, , c, d, x, y] = r.it.transform;
      const h = Math.hypot(c, d) || r.it.height;
      const [x1, y1] = view.viewport.convertToViewportPoint(x + r.it.width * a, y - 0.25 * h);
      const [x2, y2] = view.viewport.convertToViewportPoint(x + r.it.width * b, y + 0.9 * h);
      const box = document.createElement("div");
      box.style.left = `${Math.min(x1, x2)}px`;
      box.style.top = `${Math.min(y1, y2)}px`;
      box.style.width = `${Math.abs(x2 - x1)}px`;
      box.style.height = `${Math.abs(y2 - y1)}px`;
      layer.append(box);
    }
    view.div.append(layer);
  }
}

const fileName = () => decodeURIComponent((app.url || "").split("/").pop() || "");
const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
const getMark = async (key) => (await fetch(BASE + `/api/bookmark?doc=${encodeURIComponent(key)}`)).json();

// A rebuilt PDF (every LaTeX run) gets a new fingerprint. Its place is found again by file name,
// then by searching for the saved sentence near the saved page, since edits move text around.
async function relocate(m) {
  const probe = norm(m.text).slice(0, 50);
  const near = [0, 1, -1, 2, -2, 3, -3, 4, 5, 6].map((k) => m.page + k);
  for (const p of near.filter((p) => p >= 1 && p <= app.pagesCount)) {
    const d = await sentences(p);
    const idx = d.list.findIndex((s) => norm(s.text).startsWith(probe));
    if (idx >= 0) return { ...m, page: p, idx, start: d.list[idx].start, entryPage: d.list[idx].page };
  }
  return { ...m, page: Math.min(m.page, app.pagesCount), start: -1 };
}

function save() {
  const s = entry(st.cur);
  st.mark = {
    page: st.cur.page, idx: st.cur.idx, start: s.start, entryPage: s.page, text: s.text.slice(0, 120),
    file: fileName(), doc: st.doc, at: new Date().toISOString(),
  };
  for (const key of [st.doc, `file:${st.mark.file}`]) {
    fetch(BASE + `/api/bookmark?doc=${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(st.mark) })
      .catch((err) => console.error("[reader] saving the reading position failed", err));
  }
}

async function read(pos) {
  if (pos && useQueue()) return readNative(pos);
  if (QUEUE && nat.active) { // another voice was picked: the app's own reading ends
    nat.active = false;
    NATIVE.JarvisNative.readCtl("stop", "");
  }
  const gen = ++st.gen;
  st.audio.pause();
  st.wake?.();
  st.cur = pos;
  st.follow = true;
  st.playing = Boolean(pos);
  ui();
  while (st.cur && st.gen === gen) {
    const pos = st.cur;
    const e = (await sentences(pos.page)).list[pos.idx];
    if (!e) break;
    if (st.follow && app.page !== e.page) {
      st.ownFlip = true;
      app.page = e.page;
      st.ownFlip = false;
    }
    draw();
    save();
    ui();
    if (usePhone()) {
      if (!docLang) docLang = guessLang((await sentences(pos.page)).list.map((x) => x.text).join(" "));
      try {
        await new Promise((resolve, reject) => {
          const id = String(++sayId);
          saying = { id, resolve, reject };
          st.wake = () => { if (saying?.id === id) saying = null; resolve(); };
          NATIVE.JarvisNative.speak(id, piece(e, pos.from).text, String(speed()), phoneLang());
        });
      } catch (err) {
        console.error("[reader] the phone voice failed", err);
        showError(err);
        break;
      }
      if (st.gen !== gen) return;
      const extra = EXTRA[e.pause] || 0;
      if (extra) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, (1000 * extra) / speed());
          st.wake = () => { clearTimeout(t); resolve(); };
        });
        if (st.gen !== gen) return;
      }
      st.cur = await after(pos);
      continue;
    }
    let url;
    try {
      url = await clip(pos);
    } catch (err) {
      console.error("[reader] speech for this sentence failed", err);
      showError(err);
      break;
    }
    after(pos).then((n) => n && (clip(n), after(n).then((m) => m && clip(m))));
    if (st.gen !== gen) return;
    st.audio.src = url;
    st.audio.playbackRate = speed();
    const done = new Promise((resolve) => {
      st.wake = resolve;
      st.audio.onended = resolve;
    });
    if (st.playing) await st.audio.play().catch((err) => console.error("[reader] audio play failed", err));
    if (e.cont) {
      // Turn the page about when the voice reaches the page break.
      const share = (piece(e, pos.from).own || "").length / Math.max(1, piece(e, pos.from).text.length);
      const flip = () => {
        if (st.gen !== gen || st.cur !== pos || st.audio.paused || !st.follow || app.page === e.cont.page) return;
        st.ownFlip = true;
        app.page = e.cont.page;
        st.ownFlip = false;
      };
      const later = () => setTimeout(flip, (1000 * share * st.audio.duration) / speed());
      if (st.audio.duration) later(); else st.audio.addEventListener("loadedmetadata", later, { once: true });
    }
    await done;
    dropClip(pos);
    if (st.gen !== gen) return;
    const extra = EXTRA[e.pause] || 0;
    if (extra) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, (1000 * extra) / speed());
        st.wake = () => { clearTimeout(t); resolve(); };
      });
      if (st.gen !== gen) return;
    }
    st.cur = await after(pos);
  }
  if (st.gen === gen) {
    st.playing = false;
    ui();
  }
}

function pause() {
  st.playing = false;
  st.audio.pause();
  if (QUEUE && nat.active) {
    NATIVE.JarvisNative.readCtl("pause", ""); // the app keeps the sentence; Read goes on with it
    return ui();
  }
  if (NATIVE) {
    // The phone voice cannot be paused mid-sentence: stop it and end this reading; ▶ Read starts
    // again from the saved sentence.
    NATIVE.JarvisNative.stopSpeaking();
    st.gen++;
    st.wake?.();
  }
  ui();
}

// 2026-11-09 (need: start from the selected word, even a word that appears twice on the page, and
// even when tapping ▶ clears the selection first). The selection is read as: its page, its text, and
// how many times that text already appears on the page before it.
const flat = (t) => t.replace(/\s+/g, " ");
function selectionInfo(sel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const pageDiv = sel.anchorNode?.parentElement?.closest(".page");
  const layer = pageDiv?.querySelector(".textLayer");
  const probe = flat(sel.toString()).trim();
  if (!layer || !probe) return null;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.setStart(layer, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const key = probe.slice(0, 40);
  const before = flat(pre.toString() + probe);
  let nth = -1;
  for (let i = before.indexOf(key); i >= 0; i = before.indexOf(key, i + 1)) nth++;
  return { page: Number(pageDiv.dataset.pageNumber), key, nth: Math.max(0, nth), at: Date.now() };
}
let lastSel = null;
document.addEventListener("selectionchange", () => {
  const info = selectionInfo(getSelection());
  if (info) lastSel = info;
});

async function fromSelection() {
  const sel = getSelection();
  const info = selectionInfo(sel) || (lastSel && Date.now() - lastSel.at < 60000 ? lastSel : null);
  lastSel = null;
  if (!info) return null;
  const { page, key, nth } = info;
  await sentences(page);
  const hay = st.rawReady.get(page).text.replace(/\s/g, " ");
  const find = (k) => {
    let at = -1;
    for (let n = 0, i = hay.indexOf(k); i >= 0; i = hay.indexOf(k, i + 1), n++) {
      at = i;
      if (n === nth) break;
    }
    return at;
  };
  let at = find(key);
  if (at < 0) at = find(key.slice(0, 12));
  sel?.removeAllRanges();
  if (at < 0) return firstFrom(page);
  // The sentence may sit on this page's list, or (a deferred note, a joined end) on a neighbour's.
  const at1 = (list, test) => list.findIndex(test);
  for (const p of [page, page + 1, page - 1].filter((q) => q >= 1 && q <= app.pagesCount)) {
    const list = (await sentences(p)).list;
    const idx = at1(list, (x) => x.page === page && x.start <= at && at < x.end);
    if (idx >= 0) return at > list[idx].start ? { page: p, idx, from: at } : { page: p, idx };
  }
  const list = (await sentences(page)).list;
  const idx = at1(list, (x) => x.page === page && x.end > at);
  return idx >= 0 ? { page, idx } : firstFrom(page);
}

async function markPos() {
  const d = await sentences(st.mark.page);
  const exact = d.list.findIndex((s) => s.start === st.mark.start && s.page === (st.mark.entryPage ?? st.mark.page));
  const idx = exact >= 0 ? exact : Math.min(st.mark.idx, d.list.length - 1);
  return idx >= 0 ? { page: st.mark.page, idx } : firstFrom(st.mark.page);
}

async function toggle() {
  // Selected words win even while it reads: Read jumps there instead of pausing.
  const sel = await fromSelection();
  if (sel) return read(sel);
  if (st.playing) return pause();
  if (QUEUE && nat.active && st.cur && useQueue()) { // the app paused on this sentence: it goes on
    st.playing = true;
    st.follow = true;
    ui();
    return NATIVE.JarvisNative.readCtl("resume", "");
  }
  // 2026-11-09 (need: after a pause, go on from the remembered sentence wherever the view is).
  if (st.cur && !NATIVE && st.audio.src && !st.audio.ended) {
    st.playing = true;
    st.follow = true;
    const e = entry(st.cur);
    if (e && app.page !== e.page) {
      st.ownFlip = true;
      app.page = e.page;
      st.ownFlip = false;
    }
    ui();
    return st.audio.play().catch((err) => console.error("[reader] audio play failed", err));
  }
  if (st.cur) return read(st.cur);
  if (st.mark) return read(await markPos());
  return read(await firstFrom(app.page));
}

// ---- ⏮ ¶ and ¶ ⏭: move the reading by whole paragraphs (2026-11-14) -----------------------------
// A paragraph (or a title) ends at the entry that carries `pause`; its first sentence is the entry
// after that. A paragraph that runs over a page break has no `pause` at the end of the first page's
// list, so the walk goes on into the page before, at most this many pages.
const PARA_PAGES = 3;
const entryAt = async (p) => (await sentences(p.page)).list[p.idx];
// A tail fragment (the end of a sentence cut by a page break) stands for the entry that holds the
// whole sentence, on the page before.
async function whole(p) {
  const e = await entryAt(p);
  if (!e?.tail || p.page < 2) return p;
  const idx = (await sentences(p.page - 1)).list.findIndex((h) => h.cont && h.cont.page === e.page && h.cont.start === e.start);
  return idx >= 0 ? { page: p.page - 1, idx } : p;
}
async function before(p) {
  let q = p.idx > 0 ? { page: p.page, idx: p.idx - 1 } : null;
  for (let page = p.page - 1; !q && page >= 1; page--) {
    const n = (await sentences(page)).list.length;
    if (n) q = { page, idx: n - 1 };
  }
  return q && whole(q);
}
// The first sentence of the paragraph that holds p.
async function paraStart(p) {
  const floor = p.page - PARA_PAGES;
  for (let q = await before(p); q && q.page >= floor && !(await entryAt(q)).pause; q = await before(q)) p = q;
  return p;
}
// The first sentence of the paragraph after the one that holds p; null at the end of the document.
async function nextStart(p) {
  const from = p.page;
  for (;;) {
    const e = await entryAt(p);
    const n = await after(p);
    if (!n || e.pause || n.page > from + PARA_PAGES) return n;
    p = n;
  }
}
// Move the place without speaking (paused or not started): ▶ Read then starts at `to`, not on the old sentence's clip.
function moveTo(to) {
  st.gen++;
  st.wake?.();
  st.audio.pause();
  st.audio.removeAttribute("src");
  st.audio.load();
  st.cur = to;
  st.follow = true;
  const e = entry(to);
  if (e && app.page !== e.page) {
    st.ownFlip = true;
    app.page = e.page;
    st.ownFlip = false;
  }
  draw();
  save();
  ui();
}
// ¶⏭ goes to the next paragraph. ⏮¶ goes to the start of this one; from its first sentence it goes to
// the one before, like a player's back key (the phone app's own keys do the same). While it reads, the
// voice goes on from there; paused or not started, only the place moves and ▶ Read starts at it.
async function skip(dir) {
  // The app is doing the reading: its queue holds the paragraphs and its lock-screen keys use the same call.
  if (QUEUE && nat.active && useQueue()) return NATIVE.JarvisNative.readCtl(dir > 0 ? "next" : "prev", "");
  const cur = st.cur || (st.mark ? await markPos() : await firstFrom(app.page));
  if (!cur) return;
  const p = await whole(cur);
  let to;
  if (dir > 0) to = await nextStart(p);
  else {
    const start = await paraStart(p);
    const inside = start.page !== p.page || start.idx !== p.idx || cur.from > 0;
    const prior = inside ? null : await before(start);
    to = prior ? await paraStart(prior) : start;
  }
  if (!to) return;
  if (st.playing) read(to);
  else moveTo(to);
}
let skipping = Promise.resolve(); // two quick presses go one after the other, the second from where the first landed
const skipTo = (dir) => (skipping = skipping.then(() => skip(dir)).catch((err) => console.error("[reader] moving by paragraph failed", err)));

// ---- toolbar -------------------------------------------------------------------------------
const bar = document.createElement("div");
bar.id = "readerControls";
bar.innerHTML = `
  <button id="readerResume" class="toolbarButton readerBtn" hidden></button>
  <button id="readerPrev" class="toolbarButton readerBtn" title="Back to the start of this paragraph; from its first sentence, to the one before" aria-label="Previous paragraph">⏮ ¶</button>
  <button id="readerPlay" class="toolbarButton readerBtn" title="Read aloud from the selected text, your saved place, or the top of this page">▶ Read</button>
  <button id="readerNext" class="toolbarButton readerBtn" title="On to the start of the next paragraph" aria-label="Next paragraph">¶ ⏭</button>
  <button id="readerSettings" class="toolbarButton readerBtn" title="Reading settings: speed and voice" aria-label="Reading settings">Settings</button>
  <span id="readerError" hidden></span>`;
document.getElementById("toolbarViewerRight").prepend(bar);
const $ = (id) => document.getElementById(id);
// Speed and voice change rarely, so they live in a pop-up (2026-11-10). A pick applies at once and is
// remembered: the pop-up has no save button, it closes on ✕, Esc or a click outside.
const settings = document.createElement("dialog");
settings.id = "readerSettingsDialog";
settings.innerHTML = `
  <div class="recentHead"><b>Reading settings</b><button type="button" class="recentClose" aria-label="Close">✕</button></div>
  <label class="setRow">Speed
    <select id="readerSpeed">${[0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2].map((v) => `<option value="${v}">${v}×</option>`).join("")}</select>
  </label>
  <label class="setRow">Voice <select id="readerVoice"></select></label>
  <label class="setRow">Look
    <select id="readerLook"><option value="auto">Automatic (as the device)</option><option value="light">Light</option><option value="dark">Dark</option></select>
  </label>`;
document.body.append(settings);
$("readerSettings").addEventListener("click", () => settings.showModal());
settings.querySelector(".recentClose").addEventListener("click", () => settings.close());
settings.addEventListener("click", (e) => { if (e.target === settings) settings.close(); });
$("readerSpeed").value = String(speed());

function ui() {
  $("readerPlay").textContent = st.playing ? "⏸ Pause" : "▶ Read";
  $("readerPlay").classList.toggle("on", st.playing);
  const m = st.mark;
  const showResume = m && !st.playing && !(st.cur && st.cur.page === m.page && st.cur.idx === m.idx && st.audio.src);
  $("readerResume").hidden = !m;
  if (m) {
    $("readerResume").textContent = `↻ p.${m.page}`;
    $("readerResume").title = `Resume reading on page ${m.page}: “${m.text}…”`;
    $("readerResume").classList.toggle("dim", !showResume);
  }
  $("readerError").hidden = true;
}

function showError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  $("readerError").textContent = `Reading stopped: ${msg} (devtools console has full error)`;
  $("readerError").hidden = false;
}

$("readerPlay").addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive
$("readerPlay").addEventListener("click", toggle);
$("readerPrev").addEventListener("click", () => skipTo(-1));
$("readerNext").addEventListener("click", () => skipTo(1));
// Space plays and pauses anywhere in the document, like ▶ Read: from the selection, the marked
// sentence on this page, or the top of the page. Typing in a field or a comment is left alone.
window.addEventListener("keydown", (e) => {
  if (e.key !== " " || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, button, [contenteditable=''], [contenteditable='true'], .annotationEditorLayer .freeTextEditor")) return;
  e.preventDefault();
  e.stopPropagation();
  toggle();
}, true);
$("readerResume").addEventListener("click", async () => st.mark && read(await markPos()));
// Light or dark (2026-11-12): pdf.js follows the device unless told; the pick applies at once and is kept
// (defaults.js hands it to pdf.js at the next start).
$("readerLook").value = localStorage.getItem("reader.look") || "auto";
$("readerLook").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "auto") { localStorage.removeItem("reader.look"); document.documentElement.style.removeProperty("color-scheme"); }
  else { localStorage.setItem("reader.look", v); document.documentElement.style.setProperty("color-scheme", v); }
  window.readerLookApply?.(); // the page itself, dark or light (defaults.js)
});
$("readerSpeed").addEventListener("change", (e) => {
  localStorage.setItem("reader.speed", e.target.value);
  st.audio.playbackRate = speed();
  if (QUEUE && nat.active) NATIVE.JarvisNative.readCtl("rate", e.target.value);
});
$("readerVoice").addEventListener("change", (e) => {
  localStorage.setItem("reader.voice", e.target.value);
  if (st.playing && st.cur) read(st.cur); // restart the sentence in the new voice
});

fetch(BASE + "/api/voices").then((r) => r.json()).then(({ default: def, voices }) => {
  // one-time move to Kokoro (2026-10-18); after that, his own pick sticks
  // A voice this server does not have (Kokoro saved on the laptop, opened on the Pi) falls back too.
  if (NATIVE) voices = [PHONE_VOICE, ...voices];
  if (NATIVE && !localStorage.getItem("reader.phoneVoice")) {
    localStorage.setItem("reader.voice", PHONE_VOICE); // once: the app's own voice by default
    localStorage.setItem("reader.phoneVoice", "1");
    localStorage.setItem("reader.kokoro", "1");
  }
  const phoneNamed = NATIVE && voiceName().startsWith("phone:");
  if (!voiceName() || !localStorage.getItem("reader.kokoro") || (!phoneNamed && !voices.includes(voiceName()))) {
    localStorage.setItem("reader.voice", def);
    localStorage.setItem("reader.kokoro", "1");
  }
  $("readerVoice").innerHTML = voices.map((v) => `<option value="${v}">${v === PHONE_VOICE ? "📱 Phone (automatic)" : v.replace(/-(medium|high|low|x_low)$/, "")}</option>`).join("");
  $("readerVoice").value = voiceName();
  NATIVE?.JarvisNative.voices?.(); // older apps have no voice list; the answer arrives as an event
}).catch((err) => console.error("[reader] voice list failed", err));

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => !st.playing && toggle());
  navigator.mediaSession.setActionHandler("pause", () => st.playing && pause());
}

// ---- ▶ in the toolbar that pops up under selected text, next to Comment and Highlight -------
function addPlayHere(buttons) {
  const b = document.createElement("button");
  b.className = "basic readerHere";
  b.title = "Read aloud from here";
  b.setAttribute("aria-label", "Read aloud from here");
  b.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive
  b.addEventListener("click", async () => {
    const pos = await fromSelection();
    if (pos) read(pos);
  });
  buttons.append(b);
}
new MutationObserver(() => {
  for (const buttons of document.querySelectorAll(".editToolbar .buttons")) {
    if (buttons.querySelector(".highlightButton") && !buttons.querySelector(".readerHere")) addPlayHere(buttons);
  }
}).observe(document.getElementById("viewerContainer"), { childList: true, subtree: true });

// For test/reader.mjs: the sentence list of a page, with its pauses.
window.pdfReader = {
  sentences: async (page) => (await sentences(page)).list,
  blocks: async (page) => { const a = await analyse(page); const raw = st.rawReady.get(page); return a.main.map((b) => ({ head: b.head, open: b.open, n: b.sentences.length, raw: raw?.text?.slice(b.start, b.end) })); }, // tests
  read: (page, idx) => { read({ page, idx }); }, // fire and forget: read() resolves only when reading stops (a 10-min test hang, 2026-10-18)
  // ▶ on the reader's own selection bar (tools.js, 2026-11-12), the same as the ▶ in pdf.js's.
  readSelection: async () => { const pos = await fromSelection(); if (pos) read(pos); },
  audio: st.audio,
  cur: () => st.cur && { page: st.cur.page, idx: st.cur.idx },
};

// ---- viewer events -------------------------------------------------------------------------
async function onDocument() {
  // 2026-11-09 (need: a rebuilt PDF that reloads under the voice does not stop the reading).
  const wasPlaying = st.playing;
  docLang = "";
  st.gen++;
  st.audio.pause();
  st.wake?.();
  st.raw.clear();
  st.rawReady.clear();
  st.pages.clear();
  st.ready.clear();
  edgeCache.clear();
  st.clips.clear();
  st.cur = null;
  st.playing = false;
  st.doc = app.pdfDocument.fingerprints[0];
  try {
    let m = await getMark(st.doc);
    if (!m.page && fileName()) {
      m = await getMark(`file:${fileName()}`);
      if (m.page) m = await relocate(m);
    }
    st.mark = m.page ? m : null;
  } catch (err) {
    console.error("[reader] loading the saved reading position failed", err);
  }
  ui();
  if (wasPlaying && st.mark) return read(await markPos());
  if (QUEUE) NATIVE.JarvisNative.readCtl("state", ""); // the app may hold a newer place, or be reading this very document
  // Reopened: show the saved page with the next sentence to read marked, ready for ▶ Read.
  if (st.mark) {
    const gen = st.gen;
    const pos = await markPos();
    await app.pdfViewer.pagesPromise;
    await new Promise((r) => setTimeout(r, 0)); // after pdf.js applies its own remembered page
    if (!pos || st.gen !== gen || st.cur) return;
    st.cur = pos;
    st.ownFlip = true;
    app.page = entry(pos)?.page ?? pos.page;
    st.ownFlip = false;
    draw();
    ui();
  }
}
bus.on("documentloaded", onDocument);
bus.on("pagerendered", ({ pageNumber }) => {
  if (st.cur && (entry(st.cur)?.page === pageNumber || entry(st.cur)?.cont?.page === pageNumber)) draw();
});
// Dark look: a picture keeps its own colours (2026-11-12, need: a dark page never shows a picture as a
// negative). reader.css darkens a page with a veil that inverts what is under it. Inverting a picture gives
// its negative, and inverting it back again cannot restore strong colours, so the veil gets a hole over
// each picture instead: this finds where a page's pictures are drawn and hands the holes to the veil
// (--pic-holes on the page). The holes stay on the page when pdf.js redraws it, so only the first drawing waits.
const pic = { doc: null, boxes: new Map(), logged: false }; // boxes: page -> Promise<[[left, top, width, height] as fractions of the page]>
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
function pictureBoxes(pageNumber) {
  const doc = app.pdfDocument;
  if (pic.doc !== doc) { pic.doc = doc; pic.boxes.clear(); pic.logged = false; }
  if (!pic.boxes.has(pageNumber)) {
    pic.boxes.set(pageNumber, (async () => {
      const OPS = globalThis.pdfjsLib?.OPS;
      if (!OPS) return [];
      const page = await doc.getPage(pageNumber);
      const vp = page.getViewport({ scale: 1 });
      const { fnArray, argsArray } = await page.getOperatorList();
      const paints = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter((x) => x != null));
      // Follow the drawing position through the page: a picture fills the unit square of the position it is drawn at.
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const found = [];
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i], a = argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = mul(ctm, a);
        else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a?.[0]) ctm = mul(ctm, a[0]); }
        else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
        else if (paints.has(fn)) {
          const m = mul(vp.transform, ctm);
          const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
          const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
          const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(vp.width, Math.max(...xs));
          const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(vp.height, Math.max(...ys));
          if (x1 - x0 > 12 && y1 - y0 > 12) found.push([x0 / vp.width, y0 / vp.height, (x1 - x0) / vp.width, (y1 - y0) / vp.height].map((v) => +v.toFixed(4)));
        }
      }
      // A picture drawn twice, or one lying inside another, is one hole: two holes on the same spot would cancel out.
      const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3];
      return found.filter((a, i) => !found.some((b, j) => j !== i && inside(a, b) && (!inside(b, a) || j < i)));
    })().catch((err) => { console.error("[reader] picture boxes failed", err); return []; }));
  }
  return pic.boxes.get(pageNumber);
}
async function keepPictures({ pageNumber, source }) {
  const div = source?.div;
  if (!div) return;
  if (pageNumber < app.pagesCount) pictureBoxes(pageNumber + 1); // the next page's holes are ready before it shows
  const boxes = await pictureBoxes(pageNumber);
  const E = 0.001; // the hole stops a hair inside the picture, so no bright paper shows round it
  const pt = (x, y) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
  const holes = boxes.map(([l, t, w, h]) => [l + E, t + E, l + w - E, t + h - E])
    .map(([a, b, c, d]) => `, ${pt(a, b)}, ${pt(c, b)}, ${pt(c, d)}, ${pt(a, d)}, ${pt(a, b)}, 0% 0%`).join("");
  div.style.setProperty("--pic-holes", boxes.length ? `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%${holes})` : "none");
  div.dataset.pictures = JSON.stringify(boxes);
  if (boxes.length && !pic.logged) {
    pic.logged = true;
    window.__clientLog?.("pictures-kept", { page: pageNumber, boxes: boxes.length, dark: document.documentElement.classList.contains("pdfDark") });
  }
}
bus.on("pagerender", keepPictures);
bus.on("pagerendered", keepPictures);
bus.on("pagechanging", ({ pageNumber }) => {
  // 2026-11-09 (need: scrolling never changes what is read): your own scrolling only decides whether
  // the view keeps following the voice. Away from the sentence being read, the page stays where you
  // put it; back on that page, the view follows the voice again.
  if (!st.ownFlip && st.cur) {
    const e = entry(st.cur);
    st.follow = pageNumber === e?.page || pageNumber === e?.cont?.page;
  }
});
if (app.pdfDocument) onDocument();
