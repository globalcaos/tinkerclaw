#!/usr/bin/env node
/**
 * export-ai-analysis.mjs — turn the two LIVE Tinker panels into self-contained
 * interactive pages, so a public site can hold the ONLY copy of them.
 *
 * FORK 2026-09-04 (the operator): "I want the graph in the website to be the last
 * version ... only one copy, no duplicates, no maintenance hell." The panels are
 * the RENDERER (they need live config, quota and the thalamus module); the
 * website is the ARTIFACT's only home. This script is the bridge.
 *
 *   node export-ai-analysis.mjs [--out ~/.openclaw/workspace/artifacts/ai-analysis]
 *
 * Writes  <out>/smart-cost.html, <out>/dossier.html, <out>/manifest.json
 * and exits non-zero if either panel failed to render — the caller must FAIL
 * CLOSED rather than publish an empty page over a good one.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const REPO = "$HOME/src/tinkerclaw";
const require = createRequire(REPO + "/package.json");
const { chromium } = require("playwright-core");

// NOT /tmp. The 2026-09-04 run's chart.part.html/dossier.part.html were wiped from
// /tmp/ai-analysis while the standalone previews survived, so the newest thing on
// disk to LOOK at was three hours stale and 3 models short — which is exactly how a
// "I cannot see the new model yet" report gets produced against a correct pipeline.
const DEFAULT_OUT = path.join(os.homedir(), ".openclaw/workspace/artifacts/ai-analysis");
const argOf = (f, d) => {
  const i = process.argv.indexOf(f);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const OUT = argOf("--out", DEFAULT_OUT);
const CHROME =
  process.env.UI_SHOT_CHROME ||
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1134/chrome-linux/chrome");

fs.mkdirSync(OUT, { recursive: true });

let URL = process.env.TINKER_UI_URL || "http://localhost:18790";
const token = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"),
)?.gateway?.auth?.token;
if (token && !URL.includes("token=")) URL += "?token=" + encodeURIComponent(token);

const die = (msg) => {
  console.error("FAIL " + msg);
  process.exit(1);
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1900, height: 1400 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// The models panel is filled by a LATER gateway burst, so every selector here
// waits on real content. A fixed delay shot the "Loading…" placeholder.
await page
  .waitForFunction(() => !!(window.__tzOpenSmartCost || document.querySelector(".sc-open-btn")), {
    timeout: 180000,
  })
  .catch(() => die("models panel never rendered (no export hook, no chart button)"));
await page.waitForTimeout(2000);

// ── CSS: every rule that styles a panel, plus the :root vars they reference ──
const css = await page.evaluate(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const r of rules) {
      if (r.cssRules && r.conditionText !== undefined) {
        const inner = [];
        for (const ir of r.cssRules)
          if (/\.s[cd]-/.test(ir.selectorText || "")) inner.push(ir.cssText);
        if (inner.length) out.push(`@media ${r.conditionText}{${inner.join("")}}`);
      } else if (/\.s[cd]-/.test(r.selectorText || "")) out.push(r.cssText);
    }
  }
  return out.join("\n");
});
const cssVars = await page.evaluate(() => {
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rs;
    try {
      rs = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rs) continue;
    for (const r of rs)
      for (const m of (r.cssText || "").matchAll(/var\((--[a-z0-9-]+)/g)) names.add(m[1]);
  }
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const n of names) {
    const v = cs.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  return out;
});
if (!css.includes(".sc-card")) die("panel CSS not found in document.styleSheets");

// The one asset the panels reference by relative path; inlined or it 404s.
let copilotLogo = "";
try {
  const r = await page.request.get(
    (process.env.TINKER_UI_URL || "http://localhost:18790") +
      "/tinker/copilot-logo.svg" +
      (token ? "?token=" + encodeURIComponent(token) : ""),
  );
  if (r.ok())
    copilotLogo = "data:image/svg+xml;base64," + Buffer.from(await r.body()).toString("base64");
} catch {
  /* leave empty; the ref simply stays broken rather than blocking the run */
}

/** open a panel via the export hook, falling back to its button while both exist */
async function openPanel(hook, btnSel, cardSel) {
  const opened = await page.evaluate((h) => {
    const fn = window[h];
    if (typeof fn === "function") {
      fn();
      return true;
    }
    return false;
  }, hook);
  if (!opened) {
    try {
      await page.waitForSelector(btnSel, { state: "visible", timeout: 120000 });
      await page.click(btnSel, { timeout: 30000 });
    } catch (e) {
      console.error(`  open via ${btnSel} failed: ${e.message.split("\n")[0]}`);
      return null;
    }
  }
  try {
    await page.waitForSelector(cardSel, { timeout: 60000 });
  } catch (e) {
    console.error(`  ${cardSel} never appeared: ${e.message.split("\n")[0]}`);
    return null;
  }
  await page.waitForTimeout(6000); // let the plot settle and labels de-collide
  return await page.evaluate((s) => document.querySelector(s).outerHTML, cardSel);
}

async function closePanel(cardSel) {
  const close = await page.$(`${cardSel} .sc-close`);
  if (close) await close.click();
  await page.waitForTimeout(800);
}

const chartCostCard = await openPanel("__tzOpenSmartCost", ".sc-open-btn", ".sc-card");
if (!chartCostCard) die("smart x cost panel did not open");
const figures = await page.evaluate(() => {
  const c = document.querySelector(".sc-card");
  const t = (c.querySelector(".sc-foot")?.textContent || "").replace(/\s+/g, " ");
  const models = new Set([...c.querySelectorAll("[data-model]")].map((e) => e.dataset.model)).size;
  const grab = (re) => (t.match(re) || [])[0] || "";
  return {
    models,
    vendors: c.querySelectorAll(".sc-chip").length,
    discounted: grab(/\d+ of \d+ models are discounted by a plan we hold/),
    widestGap: grab(/widest gap \d+\s*[x×]/i),
    // The <text> node carries a nested <title> tooltip; clone and strip it or the
    // caption swallows the whole 700-char explainer.
    thalamus: (() => {
      const el = [...c.querySelectorAll("text")].find((e) =>
        (e.textContent || "").includes("THALAMUS"),
      );
      if (!el) return "";
      const clone = el.cloneNode(true);
      clone.querySelectorAll("title").forEach((t) => t.remove());
      return (clone.textContent || "").replace(/\s+/g, " ").trim();
    })(),
  };
});

// ── the €/MTOK <-> €/TASK switch, captured rather than dropped ──────────────
// FORK 2026-09-04 (the operator: "The toggle switch per-token/per-task is missing, put it
// again"). It was removed on 2026-09-04 because the -task DOT COORDINATES are
// computed live and only the -cost drawing was exported, so the control moved a
// switch and nothing else — worse than absent.
//
// The fix is not to recompute anything offline: flip the real switch in the real
// panel and capture the SECOND drawing too. Both are then static, and the exported
// control swaps which one is displayed. That keeps the page's promise that it is the
// panel's own output, and it cannot drift from the panel's arithmetic because it IS
// the panel's arithmetic, run twice.
// WHAT IT ACTUALLY IS (measured 2026-09-04, after shipping it wrong once): the panel's
// change handler does NOT redraw. It toggles ONE class:
//     taskInput.addEventListener("change", e =>
//       body.querySelector(".sc-svg").classList.toggle("sc-taskmode", e.target.checked))
// Both coordinate sets are already in the DOM — every dot carries --sc-dx, the task-mode
// X delta, and 18 `.sc-taskmode` rules move the dots and swap the cost/task lines. So the
// original note ("the dot COORDINATES are computed live") was wrong: nothing is computed
// live, it is pure CSS, and it exports for free.
//
// This replaced a two-render capture that looked right and was not: flipping the switch
// and re-reading .sc-card gave two cards that differed by exactly that one class name,
// so a whole-card comparison PASSED while all 354 dots sat at identical coordinates. The
// switch would have shipped dead a second time. Guard on the mechanism, not on the bytes.
const taskModeReady = await page.evaluate(() => {
  const svg = document.querySelector(".sc-card .sc-svg");
  const rules = [...document.styleSheets]
    .flatMap((sh) => {
      try {
        return [...sh.cssRules];
      } catch {
        return [];
      }
    })
    .filter((r) => (r.selectorText || "").includes("sc-taskmode")).length;
  return {
    dx: svg ? svg.querySelectorAll("[style*='--sc-dx']").length : 0,
    rules,
    hasSwitch: !!document.querySelector(".sc-card .sc-switch-input:not(.sc-scale-input)"),
  };
});
if (!taskModeReady.hasSwitch) die("the euro/task switch is gone from the panel");
if (taskModeReady.dx < 20)
  die(`only ${taskModeReady.dx} dots carry --sc-dx — task mode would move nothing`);
if (taskModeReady.rules < 5)
  die(`only ${taskModeReady.rules} .sc-taskmode rules found — the class would do nothing`);
await closePanel(".sc-card");

const dossierCard = await openPanel("__tzOpenDossier", ".sd-open-btn", ".sd-card");
if (!dossierCard) die("dossier panel did not open");
const dossierMeta = await page.evaluate(() => ({
  rows: document.querySelectorAll(".sd-table tr[data-index]").length,
  capCols: document.querySelectorAll("th[data-sort]").length - 1,
}));
await browser.close();

if (dossierMeta.rows < 5)
  die(`dossier rendered only ${dossierMeta.rows} rows — refusing to publish`);
if (figures.models < 20) die(`chart rendered only ${figures.models} models — refusing to publish`);

// ── the site's own palette ──────────────────────────────────────────────────
// FORK 2026-09-04 (the operator: "It does not need to have this dark aesthetics, it should
// blend more with the website's style"). Read off the public site's served theme
// (yith-wonder): base #FFFFFF, contrast #404040, primary #7A3921, secondary #B97040,
// secondary-background #FDE5D0. The panels are drawn for a #120e0b paper, so this is
// a TRANSLATION, not a theme switch — the chart itself has no light mode.
const LIGHT_VARS = {
  "--bg": "#FFFDFA",
  "--text": "#3B2D22",
  "--border": "#E6D5C1",
  "--surface": "#FDF6EE",
  "--surface2": "#F8EEE1",
  "--accent": "#7A3921",
  "--accent2": "#B97040",
  "--muted": "#8A6A52",
  "--green": "#4F7A1E",
  "--red": "#B03A3A",
  "--yellow": "#96690A",
  "--blue": "#2C5F9E",
  "--purple": "#6B4E96",
  "--orange": "#B4611A",
  "--skill-highlight": "#9A6B14",
  "--skill-highlight-dim": "rgba(154, 107, 20, 0.55)",
};
// Literals the chart writes straight onto SVG attributes, where no variable can reach
// them. Every one is a NEUTRAL — paper, ink or rule. Vendor colours are deliberately
// absent: they are brand identity and are handled by contrast, not by substitution.
const NEUTRALS = {
  "#f0e6d8": "#3B2D22", // the cream the chart uses for ink on dark paper
  "#e8e0d4": "#3B2D22",
  "#b9ab97": "#8A6A52", // muted ink (the neutral routed glyph)
  "#fff": "#3B2D22",
  "#ffffff": "#3B2D22",
  "#120e0b": "#FFFDFA", // the three papers
  "#191410": "#FFFDFA",
  "#1a1510": "#FFFDFA",
  "#221b13": "#F8EEE1",
  "#2a2318": "#FDF6EE",
  "#332b1f": "#F8EEE1",
  "#4a3f30": "#E6D5C1",
  "#c19a6b": "#7A3921",
  "#9a8e7a": "#8A6A52",
  "#a07d50": "#B97040",
};

const hexToRgb = (h) => {
  let s = h.replace("#", "");
  if (s.length === 3)
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  if (s.length !== 6) return null;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const relLum = (rgb) => {
  const f = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const toHex = (rgb) =>
  "#" +
  rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
/**
 * Darken a vendor colour ONLY as far as legibility on a near-white paper requires.
 *
 * This is the same rule provider-logos.ts already states for its own marks — "a tint
 * is a rendering choice and not a brand claim, the mark's SHAPE is what carries
 * identity". Several of those tints were explicitly picked to read on a #120e0b
 * paper; moved onto #FFFDFA unchanged, OpenRouter's #C8FF00 and NVIDIA's green stop
 * being visible at all. Hue and saturation are preserved; only luminance moves, and
 * only when it is above the threshold.
 */
const LUM_CEILING = 0.42;
const darkenForPaper = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const l = relLum(rgb);
  if (l <= LUM_CEILING) return hex;
  let out = rgb;
  for (let i = 0; i < 40 && relLum(out) > LUM_CEILING; i++) {
    out = out.map((v) => v * 0.92);
  }
  return toHex(out);
};

const COLOUR_ATTR = /(fill|stroke|stop-color|--sc-chip)\s*(:|=")\s*(#[0-9a-fA-F]{3,6})/g;
function lightify(markup) {
  return markup.replace(COLOUR_ATTR, (m, prop, sep, hex) => {
    const key = hex.toLowerCase();
    const mapped = NEUTRALS[key];
    const next = mapped ?? darkenForPaper(hex);
    return `${prop}${sep}${next}`;
  });
}

/**
 * Every logo on the chart is inlined once PER DOT — 577 positioned groups, each
 * carrying its vendor's full path data, which is 1.38 MB of the 1.68 MB drawing and
 * the single reason an inlined page would have been unshippable. Twelve distinct
 * marks become twelve <symbol>s and 577 <use>s.
 */
function dedupeLogos(markup, defs) {
  const RE =
    /<svg\s+(x="[^"]*"\s+y="[^"]*"\s+width="[^"]*"\s+height="[^"]*")([^>]*)>([\s\S]*?)<\/svg>/g;
  return markup.replace(RE, (whole, box, rest, inner) => {
    const vb = (rest.match(/viewBox="([^"]*)"/) || [])[1];
    if (!vb) return whole;
    const extra = rest.replace(/\s*viewBox="[^"]*"/, "").trim();
    const key = `${vb}|${extra}|${inner}`;
    let id = defs.get(key);
    if (!id) {
      id = `tzl${defs.size}`;
      defs.set(key, id);
    }
    return `<use href="#${id}" ${box}></use>`;
  });
}
const defsHtml = (defs) =>
  [...defs.entries()]
    .map(([key, id]) => {
      const [vb, extra, inner] = key.split("|");
      return `<symbol id="${id}" viewBox="${vb}"${extra ? " " + extra : ""}>${inner}</symbol>`;
    })
    .join("");

/** Scope every captured rule under .tzai so the WordPress theme cannot reach in. */
function scopeCss(css, scope) {
  return css.replace(/(^|\})\s*([^{}@]+)\{/g, (m, brace, sel) => {
    if (!sel.trim() || sel.trim().startsWith("@")) return m;
    const scoped = sel
      .split(",")
      .map((s) => {
        const t = s.trim();
        if (!t) return t;
        return t.startsWith(":root") ? scope : `${scope} ${t}`;
      })
      .join(", ");
    return `${brace}${scoped}{`;
  });
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function prepare(cardHtml) {
  let c = cardHtml.replace(/<button class="sc-close"[\s\S]*?<\/button>/g, "");
  // The LOG <-> LINEAR switch stays dropped: unlike the cost/task pair it re-solves the
  // x scale continuously, so there is no second drawing to capture. A dead control is
  // worse than a missing one — the whole reason the cost/task switch was pulled.
  c = c.replace(/<label class="sc-switch" data-hint="Bottom axis[\s\S]*?<\/label>/g, "");
  if (copilotLogo) c = c.split("/tinker/copilot-logo.svg").join(copilotLogo);
  // Hoist <title> onto data-tip so our tooltip does not double with the native one.
  c = c.replace(/<g class="sc-(?:dot|api)pos"[\s\S]*?<\/g>\s*<\/g>/g, (g) => {
    const m = g.match(/<title>([\s\S]*?)<\/title>/);
    if (!m) return g;
    return g.replace(/<title>[\s\S]*?<\/title>/, "").replace(">", ` data-tip="${esc(m[1])}">`);
  });
  // wpautop turns a blank line inside post content into a stray <p>; inside an <svg>
  // that is not cosmetic, it is a parse error. Ship one line.
  return c.replace(/\n\s*\n/g, "\n").replace(/\n\s*/g, "");
}

// ── the shared fragment shell ───────────────────────────────────────────────
// FORK 2026-09-04 (the operator: "I want both the graph and the chart completely native,
// completely integrated, with no scrolling bars and using the full width of the
// page"). Until today each panel shipped as a standalone HTML file that the post
// embedded in a fixed-height <iframe> — which is exactly where the scrollbars came
// from, and why the figures sat in a dark box the theme could not reach. There is no
// iframe now: this emits a FRAGMENT that goes straight into the post body.
const LAYOUT_CSS = `
.tzai { --tzai-vw: 100%; width: var(--tzai-vw); margin-left: calc(50% - var(--tzai-vw) / 2);
  position: relative; color: var(--text); font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }
.tzai * { box-sizing: border-box; }
.tzai table { border-collapse: collapse; margin: 0; width: 100%; }
.tzai img { max-width: none; }
.tzai .sc-overlay, .tzai .sd-overlay { position: static !important; inset: auto !important;
  background: none !important; backdrop-filter: none !important; display: block !important; }
.tzai .sc-card, .tzai .sd-card { position: static !important; transform: none !important;
  width: 100% !important; max-width: none !important; margin: 0 !important;
  box-shadow: none !important; border-radius: 10px; border: 1px solid var(--border) !important; }
.tzai-stage { position: relative; }
/* The panels are drawn for a near-black paper; on the site they sit on the theme's
   white. Stating paper and ink here rather than trusting a var keeps it true even if
   a captured rule sets background on the card directly. */
.tzai .sc-card, .tzai .sd-card { background: #FFFDFB !important; color: #3A2F26 !important; }
/* FULL WIDTH: the drawing is 900x600, so a box sized by VIEWPORT HEIGHT letterboxes it
   — at 1506x509 preserveAspectRatio fitted it by height and painted 763px wide with
   fat gutters, the opposite of what was asked. Sizing the plot from the WIDTH (64vw,
   ~2:3 of the page) lets the constellation meet both edges. */
.tzai-chart .sc-card { height: auto !important; max-height: none !important; }
/* flex:none is load-bearing. .sc-card is a column flexbox, so .sc-body is a flex ITEM
   and default flex-shrink let it collapse from the 940px set here to 460 — the card's
   auto height won the circular argument and the plot letterboxed anyway. */
.tzai-chart .sc-body { height: min(64vw, 940px) !important; min-height: 460px !important;
  max-height: none !important; overflow: visible !important; flex: 0 0 auto !important; }
.tzai-chart .sc-svg { width: 100% !important; height: 100% !important; }
.tzai .sc-svg { cursor: grab; }
.tzai .sc-svg.tzai-drag { cursor: grabbing; }
/* no inner scrollbars anywhere: the page is the scroll container now */
.tzai .sd-card, .tzai .sd-body, .tzai .sc-body { overflow: visible !important;
  max-height: none !important; }
.tzai-dossier .sd-card, .tzai-dossier .sd-body { height: auto !important; }
.tzai .sd-table { font-size: clamp(10px, 0.78vw, 13px); }
/* The dossier's header band is a near-black stripe on the panel's own paper. Left as
   it was it is the one piece of "dark aesthetics" still visible on a white page, so it
   takes the theme's own cream + rust (--wp--preset--color--secondary-background and
   --primary, read off the site's stylesheet). */
.tzai .sd-table thead, .tzai .sd-table thead tr, .tzai .sd-table thead th, .tzai .sd-table th {
  background: #FDE5D0 !important; color: #7A3921 !important; }
.tzai .sd-table thead th { border-bottom: 1px solid #E5D3BE !important; }
.tzai th[data-sort] { cursor: pointer; }
.tzai th[data-sort]:hover { color: var(--accent); }
.tzai th.tzai-sorted { color: var(--accent) !important; }
.tzai-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  font-family: "SF Mono", ui-monospace, monospace; font-size: 10px; letter-spacing: .08em;
  color: var(--muted); padding: 4px 2px 8px; }
.tzai-btn { background: #fff; color: var(--accent); border: 1px solid var(--border);
  border-radius: 5px; padding: 4px 10px; font: inherit; cursor: pointer; letter-spacing: .1em; }
.tzai-btn:hover { border-color: var(--accent); }
.tzai-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.tzai-tip { position: fixed; z-index: 9999; max-width: 380px; pointer-events: none; opacity: 0;
  transition: opacity .12s; background: #FFFDFA; color: #3B2D22; border: 1px solid #7A3921;
  border-radius: 6px; padding: 8px 11px; font-size: 11.5px; line-height: 1.45;
  white-space: pre-wrap; font-family: "SF Mono", ui-monospace, monospace;
  box-shadow: 0 8px 26px rgba(60, 40, 25, .22); }
.tzai-tip.on { opacity: 1; }
@media (max-width: 900px) { .tzai-chart .tzai-stage { height: 74vh; } }
/* ── FULL-PAGE POPUP ────────────────────────────────────────────────────────
   the operator 2026-09-04: "The zoom does not work in the graph, because the mouse wheel
   scrolls the page instead. Turn it into a full-page popup then, as we had it in
   the tinkerclaw."  Reproduced first: on a scrollable page a wheel over the plot
   BOTH zooms and scrolls. preventDefault() is present and correct — but this SVG
   is ~1 MB (121 models x 4 efforts + labels + logos), so the main thread misses
   Chrome's wheel deadline and the compositor scrolls anyway. No amount of handler
   tuning wins that race. The popup removes the race instead of fighting it: while
   it is open the document cannot scroll, so the wheel has nowhere else to go.
   The overlay carries the .tzai and .tzai-chart classes itself because the panel
   CSS is scoped to .tzai and the overlay is parented to <body>, outside the figure. */
.tzai-fs { position: fixed !important; inset: 0 !important; width: auto !important;
  margin: 0 !important; z-index: 2147483000; background: #FFFDFB; display: none;
  flex-direction: column; }
.tzai-fs.on { display: flex; }
.tzai-fs-bar { flex: 0 0 auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 8px 14px; background: #FDE5D0; color: #7A3921; border-bottom: 1px solid #E5D3BE;
  font-family: "SF Mono", ui-monospace, monospace; font-size: 10px; letter-spacing: .08em; }
.tzai-fs-bar .tzai-btn { background: #FFFDFB; color: #7A3921; border-color: #E5D3BE; }
.tzai-fs-bar .tzai-btn:hover { border-color: #7A3921; }
.tzai-fs-sp { flex: 1 1 auto; }
.tzai-fs-body { flex: 1 1 auto; min-height: 0; padding: 8px 14px 14px; }
.tzai-fs .tzai-stage, .tzai-fs .sc-overlay, .tzai-fs .sc-card {
  height: 100% !important; max-height: none !important; }
.tzai-fs .sc-card { display: flex !important; flex-direction: column !important; }
.tzai-fs .sc-body { height: auto !important; min-height: 0 !important;
  flex: 1 1 auto !important; }
/* the figure leaves a hole while it is up on the overlay, so the article does not
   jump: the placeholder keeps the same box and says where the drawing went. */
.tzai-hole { display: none; align-items: center; justify-content: center;
  border: 1px dashed var(--border); border-radius: 10px; color: var(--muted);
  height: min(64vw, 940px); min-height: 460px;
  font-family: "SF Mono", ui-monospace, monospace; font-size: 11px; letter-spacing: .08em; }
.tzai-hole.on { display: flex; }
`;

const COMMON_JS = (id) => `
var root = document.getElementById(${JSON.stringify(id)});
if (!root) return;
// Full bleed WITHOUT 100vw: vw counts the vertical scrollbar, and that overflow is
// itself a horizontal scrollbar — the thing this rewrite exists to remove.
function tzWidth(){ root.style.setProperty('--tzai-vw', document.documentElement.clientWidth + 'px'); }
tzWidth();
addEventListener('resize', tzWidth);
// The tooltip is parented to <body> so no ancestor of the figure can clip it.
var tip = document.createElement('div');
tip.className = 'tzai-tip';
document.body.appendChild(tip);
function tipMove(e){
  var host = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!host) { tip.classList.remove('on'); return; }
  tip.textContent = host.getAttribute('data-tip');
  tip.classList.add('on');
  var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  var x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = e.clientY - h - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
var tipHost = root.querySelector('.tzai-stage') || root;
tipHost.addEventListener('mousemove', tipMove);
tipHost.addEventListener('mouseleave', function(){ tip.classList.remove('on'); });
`;

const CHART_JS = (id) => `(function(){
${COMMON_JS(id)}
var locked = null;
var fullOn = false;
// LIVE queries for chart internals go through the STAGE, never through root: the
// stage is what the popup moves out of the article, and a root-rooted query comes
// back empty the moment it does (that killed RESET VIEW and the vendor chips).
var stage = root.querySelector('.tzai-stage');
function svgs(){ return [].slice.call(stage.querySelectorAll('.sc-svg')); }
function visibleSvg(){
  return svgs()[0];
}
function paint(vendor){
  var v = locked || vendor;
  svgs().forEach(function(svg){
    svg.classList.toggle('sc-focus', !!v);
    svg.querySelectorAll('[data-vendor]').forEach(function(el){
      el.classList.toggle('sc-hl', !!v && el.getAttribute('data-vendor') === v);
    });
  });
  stage.querySelectorAll('.sc-chip').forEach(function(c){
    c.style.outline = (locked && c.dataset.vendor === locked) ? '1px solid var(--accent)' : '';
  });
}
stage.querySelectorAll('.sc-chip').forEach(function(chip){
  chip.addEventListener('mouseenter', function(){ paint(chip.dataset.vendor); });
  chip.addEventListener('mouseleave', function(){ paint(null); });
  chip.addEventListener('click', function(e){ e.preventDefault();
    locked = (locked === chip.dataset.vendor) ? null : chip.dataset.vendor; paint(locked); });
});

// Pan/zoom is wired per drawing: the two cost modes are two separate <svg>s.
var views = new Map();
svgs().forEach(function(svg){
  var vb0 = (svg.getAttribute('viewBox') || '0 0 900 600').split(/[\\s,]+/).map(Number);
  var vb = vb0.slice();
  views.set(svg, { vb0: vb0, get: function(){ return vb; }, reset: function(){ vb = vb0.slice(); apply(); } });
  function apply(){ svg.setAttribute('viewBox', vb.join(' ')); }
  function toUser(e){
    var r = svg.getBoundingClientRect();
    return { x: vb[0] + (e.clientX - r.left) / r.width * vb[2],
             y: vb[1] + (e.clientY - r.top) / r.height * vb[3] };
  }
  svg.addEventListener('wheel', function(e){
    // Inline, the page owns the wheel — see the FULL-PAGE POPUP note in the CSS.
    if (!fullOn) return;
    e.preventDefault();
    var p = toUser(e), k = e.deltaY < 0 ? 0.82 : 1 / 0.82;
    var nw = Math.min(vb0[2] * 1.6, Math.max(vb0[2] / 60, vb[2] * k)), s = nw / vb[2];
    vb[0] = p.x - (p.x - vb[0]) * s; vb[1] = p.y - (p.y - vb[1]) * s;
    vb[2] = nw; vb[3] = vb[3] * s; apply();
  }, { passive: false });
  var drag = null;
  svg.addEventListener('pointerdown', function(e){
    drag = { x: e.clientX, y: e.clientY, vb: vb.slice() };
    svg.classList.add('tzai-drag');
    try { svg.setPointerCapture(e.pointerId); } catch(_){}
  });
  svg.addEventListener('pointermove', function(e){
    if (!drag) return;
    var r = svg.getBoundingClientRect();
    vb[0] = drag.vb[0] - (e.clientX - drag.x) / r.width * vb[2];
    vb[1] = drag.vb[1] - (e.clientY - drag.y) / r.height * vb[3];
    apply();
  });
  function end(e){ drag = null; svg.classList.remove('tzai-drag');
    try { svg.releasePointerCapture(e.pointerId); } catch(_){} }
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
});

// The euro/Mtok <-> euro/task switch. Each captured card carries its own switch,
// already in the state it was captured in, so flipping either one just decides which
// drawing is on screen — no coordinate is recomputed here, and none is invented.
function setMode(task){
  // Identical to the panel's own handler: one class, no arithmetic. The dots move
  // because every one carries --sc-dx and the .sc-taskmode rules read it.
  svgs().forEach(function(svg){ svg.classList.toggle('sc-taskmode', !!task); });
}
stage.querySelectorAll('.sc-switch-input:not(.sc-scale-input)').forEach(function(i){
  i.addEventListener('change', function(){ setMode(i.checked); });
});
function resetView(){
  var v = views.get(visibleSvg()); if (v) v.reset();
  locked = null; paint(null);
}
root.querySelectorAll('.tzai-reset').forEach(function(b){ b.addEventListener('click', resetView); });

// ── the full-page popup ─────────────────────────────────────────────────────
// ONE copy of the drawing, moved. Cloning a ~1 MB SVG would double the page and
// orphan every handler bound above; moving the node keeps both. The hole holds the
// figure's place in the article so the prose does not jump while it is open.
var hole = document.createElement('div');
hole.className = 'tzai-hole';
hole.textContent = 'THE CHART IS OPEN FULL SCREEN';
stage.parentNode.insertBefore(hole, stage);
// The overlay wears the .tzai .tzai-chart classes itself: the captured panel CSS
// is scoped to .tzai, and <body> is outside the figure.
function el(tag, cls, txt){
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt) n.textContent = txt;
  return n;
}
var fs = el('div', 'tzai tzai-chart tzai-fs');
var fsBar = el('div', 'tzai-fs-bar');
var fsReset = el('button', 'tzai-btn tzai-reset', 'RESET VIEW');
fsReset.type = 'button';
var fsClose = el('button', 'tzai-btn tzai-fs-close', 'CLOSE \u2715 (ESC)');
fsClose.type = 'button';
fsBar.appendChild(fsReset);
fsBar.appendChild(el('span', '', 'scroll or pinch = zoom \u00b7 drag = pan \u00b7 hover a dot = detail \u00b7 click a vendor chip = isolate it'));
fsBar.appendChild(el('span', 'tzai-fs-sp'));
fsBar.appendChild(fsClose);
var fsBody = el('div', 'tzai-fs-body');
fs.appendChild(fsBar);
fs.appendChild(fsBody);
document.body.appendChild(fs);
fsReset.addEventListener('click', resetView);

var scrollLock = null;
function openFull(){
  if (fullOn) return;
  fsBody.appendChild(stage);
  hole.classList.add('on');
  fs.classList.add('on');
  // No scrollable document = nothing for the compositor to steal the wheel for.
  scrollLock = { h: document.documentElement.style.overflow, b: document.body.style.overflow };
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  fullOn = true;
}
function closeFull(){
  if (!fullOn) return;
  hole.parentNode.insertBefore(stage, hole);
  hole.classList.remove('on');
  fs.classList.remove('on');
  if (scrollLock) { document.documentElement.style.overflow = scrollLock.h;
                    document.body.style.overflow = scrollLock.b; }
  fullOn = false;
  tip.classList.remove('on');
}
root.querySelectorAll('.tzai-full').forEach(function(b){ b.addEventListener('click', openFull); });
fsClose.addEventListener('click', closeFull);
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeFull(); });
})();`;

const DOSSIER_JS = (id) => `(function(){
${COMMON_JS(id)}
var table = root.querySelector('.sd-table'); if (!table) return;
var tbody = table.tBodies[0]; if (!tbody) return;
var rows = [].slice.call(tbody.rows).filter(function(r){ return r.hasAttribute('data-index'); });
var others = [].slice.call(tbody.rows).filter(function(r){ return !r.hasAttribute('data-index'); });
function idx(r){ return parseFloat(r.getAttribute('data-index')) || 0; }
function ranks(r){ try { return JSON.parse(r.getAttribute('data-ranks') || '{}'); } catch(_){ return {}; } }
function sortBy(key, th){
  rows.slice().sort(function(a, b){
    if (key === 'index') return idx(b) - idx(a);
    var d = (ranks(b)[key] || 0) - (ranks(a)[key] || 0);
    return d !== 0 ? d : idx(b) - idx(a);
  }).forEach(function(r){ tbody.appendChild(r); });
  others.forEach(function(r){ tbody.appendChild(r); });
  root.querySelectorAll('th[data-sort]').forEach(function(h){ h.classList.remove('tzai-sorted'); });
  if (th) th.classList.add('tzai-sorted');
}
root.querySelectorAll('th[data-sort]').forEach(function(th){
  th.addEventListener('click', function(){ sortBy(th.getAttribute('data-sort'), th); });
});
})();`;

// ── wpautop-proofing the inline JS ──────────────────────────────────────────
// THE bug behind "the zoom does not work, the mouse wheel scrolls the page":
// WordPress ran wpautop over the post's inline <script> and injected a paragraph
// break at EVERY BLANK LINE inside it, plus a paragraph close before every literal
// div tag in a JS string (div is in wpautop's $allblocks). Both scripts therefore
// died on "Unexpected token" and NOTHING interactive ever ran on the published
// page — no zoom, no tooltips, no column sorting. prepare() already collapses blank
// lines for the SVG for exactly this reason; the JS was never given the same
// treatment. So: comments and blank lines are stripped on emit (they stay in this
// file), and the result is CHECKED. A syntax error on a published page is invisible
// from here, so the assertion is the only thing that can see it.
const WP_BLOCK_TAGS =
  "table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|" +
  "form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|" +
  "aside|hgroup|header|footer|nav|figure|figcaption|details|summary|menu";
const wpSafeJs = (js) => {
  const out = js
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .filter((l) => l.trim() !== "")
    .join("\n");
  if (/\n\s*\n/.test(out)) die("emitted JS still has a blank line — wpautop would split it");
  const bad = out.match(new RegExp("</?(" + WP_BLOCK_TAGS + ")(\\s|>|/)", "i"));
  if (bad) die("emitted JS carries a wpautop block-tag literal: " + bad[0]);
  return out;
};

// ── assemble ────────────────────────────────────────────────────────────────
const defs = new Map();
// WordPress broke the chart on the first inline publish, and the cause is worth
// stating: the panel emits a <style> element INSIDE the <svg> (the cost/task envelope
// transition). wpautop treats <style> as a block boundary and wrapped the SVG content
// on either side of it in <p> tags — and a <p> start tag inside <svg> makes the HTML
// parser BREAK OUT of foreign content, ending the drawing early. Inside an iframe this
// never came up because the fragment was a whole document.
//
// So any <style> inside the markup is hoisted into the fragment's own stylesheet,
// where wpautop explicitly protects it, and removed from the markup.
const innerStyles = [];
const hoistStyles = (html) =>
  html.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_m, body) => {
    innerStyles.push(body);
    return "";
  });
const costCard = lightify(hoistStyles(dedupeLogos(prepare(chartCostCard), defs)));
const dossierHtml = lightify(hoistStyles(dedupeLogos(prepare(dossierCard), defs)));
const varsBlock = Object.entries({ ...cssVars, ...LIGHT_VARS })
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n");
const scopedPanelCss = scopeCss(lightify(css + "\n" + innerStyles.join("\n")), ".tzai");
// ORDER IS LOAD-BEARING: the captured panel CSS goes FIRST and OUR layout goes LAST.
// With LAYOUT_CSS first, every rule in it lost to the panel's own equally-specific
// rules — the card kept its near-black paper and its fixed height, so the figure
// rendered dark AND the plot collapsed to nothing. Same single cause, two symptoms.
const styleBlock = `<style>\n.tzai {\n${varsBlock}\n}\n${scopedPanelCss}\n${LAYOUT_CSS}\n</style>`;
const defsSvg = `<svg class="tzai-defs" aria-hidden="true" focusable="false"><defs>${defsHtml(defs)}</defs></svg>`;

const CHART_ID = "tzai-chart";
const DOSSIER_ID = "tzai-dossier";
const chartFragment =
  `<div class="tzai tzai-chart" id="${CHART_ID}">` +
  styleBlock +
  defsSvg +
  `<div class="tzai-bar"><button class="tzai-btn tzai-full" type="button">&#8599; FULL SCREEN</button>` +
  `<button class="tzai-btn tzai-reset" type="button">RESET VIEW</button>` +
  `<span>open FULL SCREEN to zoom &middot; drag = pan &middot; hover a dot = detail &middot; ` +
  `click a vendor chip = isolate it &middot; the switch reads the same models per token or per task</span></div>` +
  `<div class="tzai-stage">` +
  costCard +
  `</div><script>${wpSafeJs(CHART_JS(CHART_ID))}</` +
  `script></div>`;

const dossierFragment =
  `<div class="tzai tzai-dossier" id="${DOSSIER_ID}">` +
  styleBlock +
  `<div class="tzai-bar"><span>hover any cell for the evidence &middot; ` +
  `click a capability heading to rank the table by it</span></div>` +
  `<div class="tzai-stage">${dossierHtml}</div>` +
  `<script>${wpSafeJs(DOSSIER_JS(DOSSIER_ID))}</` +
  `script></div>`;

fs.writeFileSync(path.join(OUT, "chart.part.html"), chartFragment);
fs.writeFileSync(path.join(OUT, "dossier.part.html"), dossierFragment);

// Standalone previews on the SITE's paper — not published, but the only way to look
// at the thing before it goes near the post. Rule: render it and LOOK.
const preview = (frag, title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>html,body{margin:0;background:#FFFFFF;color:#404040;` +
  `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}` +
  `.wrap{max-width:1510px;margin:0 auto;padding:24px 16px;}</style></head>` +
  `<body><div class="wrap"><h2 style="color:#7A3921;font-weight:600;">${title}</h2>${frag}</div></body></html>`;
fs.writeFileSync(path.join(OUT, "smart-cost.html"), preview(chartFragment, "SMARTNESS x COST"));
fs.writeFileSync(path.join(OUT, "dossier.html"), preview(dossierFragment, "SMART MODELS dossier"));

const manifest = {
  generatedAt: new Date().toISOString(),
  figures,
  dossier: dossierMeta,
  pageErrors,
  logoSymbols: defs.size,
  bytes: { chart: chartFragment.length, dossier: dossierFragment.length },
  files: {
    chart: path.join(OUT, "chart.part.html"),
    dossier: path.join(OUT, "dossier.part.html"),
    chartPreview: path.join(OUT, "smart-cost.html"),
    dossierPreview: path.join(OUT, "dossier.html"),
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
