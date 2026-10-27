#!/usr/bin/env node
/**
 * export-ai-analysis.mjs — turn the two LIVE Tinker panels into self-contained
 * interactive pages, so thetinkerzone.com can hold the ONLY copy of them.
 *
 * FORK 2026-09-04 (the architect): "I want the graph in the website to be the last
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

const REPO = path.join(os.homedir(), "src/tinkerclaw");
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

// 2026-09-23: default is production Tinker (:18793, serves the BUILT dist). The old
// :18790 default was the Vite dev server, retired 2026-09-10 — it answered nothing, and
// every cron run had to remember to override it.
let URL = process.env.TINKER_UI_URL || "http://localhost:18793";
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

// This gateway (up since 2026-09-19 17:26) does not serve `config.models`
// ("unknown method" every 5 min since 05:26). The live tab keeps a catalog from
// localStorage; a headless export starts empty and the dossier paints only the
// four reference rows. Seed the same snapshot the picker uses, from today's config.
// addInitScript MUST run before goto or the first paint misses it.
// 2026-09-23: the seed is BUILT from today's openclaw.json, never read from /tmp. The
// /tmp file vanished and crashed the export (ENOENT); without any seed a headless page
// depends on the gateway's config.models answering in time, and on 2026-09-23 10:45 the
// gateway WS was saturated (even `health` timed out) so the dossier painted 4 rows.
// Same projection as budget-panel's projectModelConfig(); same {at,data} envelope as
// app.ts writePanelSnapshot(). The live RPC, when it answers, still reconciles behind it.
function modelConfigSeed() {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".openclaw", "openclaw.json"), "utf8"),
  );
  const d = cfg?.agents?.defaults || {};
  const m = d.model || {};
  const authProfiles = {};
  for (const [id, raw] of Object.entries(cfg?.auth?.profiles || {})) {
    const o = {};
    for (const k of ["provider", "mode", "label"]) if (typeof raw?.[k] === "string") o[k] = raw[k];
    authProfiles[id] = o;
  }
  const data = {
    primary: typeof m === "string" ? m : m.primary || "",
    fallbacks: m.fallbacks || [],
    models: d.models || {},
    authProfiles,
    authOrder: cfg?.auth?.order || {},
  };
  return JSON.stringify({ at: Date.now(), data });
}
await page.addInitScript((payload) => {
  try {
    localStorage.setItem("tinker-modelconfig-snapshot", payload);
  } catch {
    /* ignore */
  }
  // 2026-09-23: OPTIONAL. The seed was a workaround for the 09-20/21 config.models
  // "unknown method" outage; a /tmp file does not survive a reboot, and a hard read
  // crashed the export (ENOENT) once the picker RPC was healthy again. The UI treats
  // this key as a first-paint hint only — the live RPC reconciles behind it.
}, modelConfigSeed());

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
// 2026-09-23: read the ribbon from DISK. This fetched it from a second hardcoded :18790
// (the Vite server retired 2026-09-10), failed silently, and shipped `/tinker/copilot-logo.svg`
// to the website — a 404, so the M365 Copilot row the architect had just asked to re-icon showed a
// broken-image glyph. Missing file = die: an unbranded row is a visible defect, not a nicety.
const COPILOT_SVG = path.join(REPO, "tinker-ui/public/copilot-logo.svg");
if (!fs.existsSync(COPILOT_SVG)) die(`copilot logo missing at ${COPILOT_SVG}`);
const copilotLogo = "data:image/svg+xml;base64," + fs.readFileSync(COPILOT_SVG).toString("base64");

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

let chartCostCard = await openPanel("__tzOpenSmartCost", ".sc-open-btn", ".sc-card");
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
// FORK 2026-09-04 (the architect: "The toggle switch per-token/per-task is missing, put it
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
// ── the LOG <-> LINEAR switch, captured as a SECOND DRAWING ───────────────────
// FORK 2026-09-14 (the architect: "The toggle switch for linear-log horizontal axis is missing,
// put it next to the token/job switch"). Unlike €/TASK this one is NOT a CSS class: the
// panel's handler calls paint(), which re-renders the whole SVG through
// renderSmartCostChart(..., { xScale }), because linear positions are not a transform of
// log ones. So there IS a second drawing — the old note saying there was nothing to
// capture was wrong. Flip the real switch, let the labels de-collide, keep that SVG,
// flip back, and ship both. The page's switch then only chooses which one is shown.
//
// Guard on the MECHANISM, as the €/TASK lesson taught: two captures that differ by a
// class name pass a byte comparison while every dot sits still. So count dots whose
// x actually moved between the two drawings, matched by model + effort.
const linear = await page.evaluate(async () => {
  const card = document.querySelector(".sc-card");
  const input = card && card.querySelector(".sc-scale-input");
  if (!input) return { err: "no .sc-scale-input in the panel" };
  const xs = (svg) => {
    const m = new Map();
    svg.querySelectorAll(".sc-dotpos").forEach((d) => {
      const t = (d.getAttribute("transform") || "").match(/translate\(\s*([\d.-]+)/);
      if (t) m.set(d.dataset.model + "@" + (d.dataset.effort || ""), parseFloat(t[1]));
    });
    return m;
  };
  const logX = xs(card.querySelector(".sc-body .sc-svg"));
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 6000)); // same settle as openPanel: labels de-collide
  const lin = card.querySelector(".sc-body .sc-svg");
  const linX = xs(lin);
  let moved = 0;
  for (const [k, x] of linX) if (logX.has(k) && Math.abs(logX.get(k) - x) > 0.5) moved++;
  const out = {
    html: lin.outerHTML,
    dots: linX.size,
    logDots: logX.size,
    moved,
    caption: /· linear/.test(lin.textContent || ""),
  };
  input.checked = false;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 6000));
  // Seat the linear drawing beside the fresh log one and re-read the card, so both go
  // through exactly the same prepare/dedupe/lightify path as one captured card.
  const body = card.querySelector(".sc-body");
  // Both drawings define the same paint servers (sc-bg, sc-glow, sc-axis). url(#id)
  // resolves to the FIRST match in the document, which is inside the log drawing —
  // and in linear mode that drawing is display:none, where gradients and filters stop
  // resolving. So the linear copy gets its own names, references rewritten to match.
  const ids = [...new Set([...out.html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))];
  let linHtml = out.html;
  for (const id of ids) {
    const q = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    linHtml = linHtml
      .replace(new RegExp('(\\sid=")' + q + '"', "g"), "$1" + id + '-lin"')
      .replace(new RegExp("url\\(#" + q + "\\)", "g"), "url(#" + id + "-lin)")
      .replace(new RegExp('(href=")#' + q + '"', "g"), "$1#" + id + '-lin"');
  }
  out.renamedIds = ids.length;
  const tpl = document.createElement("template");
  tpl.innerHTML = linHtml;
  const linNode = tpl.content.firstElementChild;
  linNode.classList.add("tzai-lin");
  linNode.classList.remove("sc-taskmode");
  body.appendChild(linNode);
  out.card = card.outerHTML;
  linNode.remove();
  delete out.html;
  return out;
});
if (linear.err) die(linear.err);
if (!linear.caption)
  die("the re-rendered drawing does not say '· linear' — the scale never switched");
if (linear.dots !== linear.logDots)
  die(`linear drawing has ${linear.dots} dots, log has ${linear.logDots} — refusing to pair them`);
if (linear.moved < Math.min(20, linear.dots / 2))
  die(
    `only ${linear.moved}/${linear.dots} dots moved between log and linear — the switch would do nothing`,
  );
chartCostCard = linear.card;
// 2026-09-23 (the architect: "useless bottom notes that should instead go in the main website as
// normal text"). The THALAMUS caption at the foot of the drawing is already printed above
// the map by the publisher's FIGURES block, so it leaves the SVG and the canvas is cropped
// to the lowest thing still drawn. MEASURED here, on the live drawing, rather than typed as
// a constant: a future axis caption must never be clipped silently.
const cropH = await page.evaluate(() => {
  const svg = document.querySelector(".sc-card .sc-body .sc-svg");
  const ctm = svg ? svg.getScreenCTM() : null;
  if (!ctm) return 0;
  let bottom = 0;
  for (const el of svg.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === "defs" || tag === "rect" || el.classList.contains("sc-env-foot")) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, (r.bottom - ctm.f) / ctm.d);
  }
  return Math.ceil(bottom + 6);
});
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
// FORK 2026-09-04 (the architect: "It does not need to have this dark aesthetics, it should
// blend more with the website's style"). Read off thetinkerzone.com's served theme
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
  // The LOG <-> LINEAR switch lives in the panel's bottom axis bar; on the page the architect
  // wants it beside the €/MTOK <-> €/TASK switch (2026-09-14). Lift it out and seat it
  // right after that one. Both drawings are captured, so it is a live control.
  const scaleSw = (c.match(/<label class="sc-switch" data-hint="Bottom axis[\s\S]*?<\/label>/) ||
    [])[0];
  if (scaleSw) {
    c = c.replace(scaleSw, "");
    c = c.replace(
      /(<label class="sc-switch" data-hint="Per-token[\s\S]*?<\/label>)/,
      '<span class="tzai-switches">$1' + scaleSw + "</span>",
    );
  }
  if (copilotLogo) c = c.split("/tinker/copilot-logo.svg").join(copilotLogo);
  // Hoist <title> onto data-tip so our tooltip does not double with the native one.
  c = c.replace(/<g class="sc-(?:dot|api)pos"[\s\S]*?<\/g>\s*<\/g>/g, (g) => {
    const m = g.match(/<title>([\s\S]*?)<\/title>/);
    if (!m) return g;
    return g.replace(/<title>[\s\S]*?<\/title>/, "").replace(">", ` data-tip="${esc(m[1])}">`);
  });
  // 2026-09-23: a literal "<" or ">" INSIDE an attribute value is legal HTML but not
  // legal WordPress: wptexturize read `title="… openrouter/<model> …"` as a tag, turned the
  // closing quote into &#8221;, and the attribute swallowed the header — the OpenRouter
  // column vanished and every host name slid one column left of its prices. Escape both
  // inside every quoted attribute, so no future tooltip can do it again.
  c = c.replace(/(\s[\w:-]+=")([^"]*)"/g, (m, head, val) =>
    /[<>]/.test(val) ? head + val.replace(/</g, "&lt;").replace(/>/g, "&gt;") + '"' : m,
  );
  // wpautop turns a blank line inside post content into a stray <p>; inside an <svg>
  // that is not cosmetic, it is a parse error. Ship one line.
  return c.replace(/\n\s*\n/g, "\n").replace(/\n\s*/g, "");
}

// ── the shared fragment shell ───────────────────────────────────────────────
// FORK 2026-09-04 (the architect: "I want both the graph and the chart completely native,
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
/* two drawings, one shown: the stage's tzai-linmode class picks linear */
.tzai .sc-svg.tzai-lin { display: none !important; }
.tzai .tzai-linmode .sc-svg:not(.tzai-lin) { display: none !important; }
.tzai .tzai-linmode .sc-svg.tzai-lin { display: block !important; }
.tzai .tzai-switches { display: inline-flex; gap: 22px; align-items: center; flex-wrap: nowrap;
  flex: 0 0 auto; white-space: nowrap; }  /* side by side, never stacked (the head column squeezed it) */
.tzai .sc-axisbar:empty { display: none; }
/* THE MAP IS A BUTTON (the architect 2026-09-14: "The main graph should be a big button that, upon
   pressing, should open a full screen popup"). Inline it is a preview you cannot fight
   with — no wheel, no drag — and one click anywhere on it opens the popup. */
.tzai-frame { position: relative; }
.tzai-open { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0;
  border: 0; border-radius: 10px; background: rgba(122, 57, 33, 0); cursor: zoom-in;
  display: flex; align-items: center; justify-content: center; transition: background .18s; }
.tzai-open:hover, .tzai-open:focus-visible { background: rgba(122, 57, 33, .06); outline: none; }
.tzai-open-pill { display: inline-flex; align-items: center; gap: 10px; padding: 14px 26px;
  border-radius: 999px; background: #7A3921; color: #FFFDFB; font: 600 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
  letter-spacing: .04em; box-shadow: 0 10px 30px rgba(60, 40, 25, .28); transition: transform .18s; }
.tzai-open:hover .tzai-open-pill, .tzai-open:focus-visible .tzai-open-pill { transform: scale(1.05); }
.tzai-open-pill span { font-weight: 400; opacity: .85; }
.tzai-frame.tzai-isopen .tzai-open { display: none; }
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
/* 2026-09-23 LIGHT PAPER, stated once. The panel's :root inks are dark-theme values
   (--text #e8e0d4, --muted #9a8e7a); on the cream page every rule written against them
   — and every hard-coded pale colour in the CN price table — washed out to near-invisible.
   Re-map the variables on the fragment so future columns inherit readable ink, then pin
   the hard-coded .sd-cn-* colours. */
.tzai { --bg:#FFFDFB; --surface:#FBF3EA; --surface2:#F4E6D6; --border:#D9C3AA; --text:#3A2F26;
  --fg:#3A2F26; --muted:#6E5644; --accent:#7A3921; --accent2:#B97040; --bg-elev:#FFFFFF;
  --green:#3F6212; --red:#A63A32; --orange:#9A4F10; --yellow:#7A5B00; --blue:#2F5F9E;
  --purple:#5E4386; --skill-highlight:#9A6B00; --skill-highlight-dim:rgba(154,107,0,.45); }
.tzai .sd-card, .tzai .sd-body, .tzai .sd-table td, .tzai .sd-shared li, .tzai .sd-shared p,
.tzai .sd-split, .tzai .sd-legend, .tzai .sd-note { color: #3A2F26 !important; }
.tzai .sd-cn-matrix h3 { color: #7A3921 !important; }
.tzai .sd-cn-table td { color: #3A2F26 !important; }
.tzai .sd-cn-table td.sd-cn-na, .tzai .sd-cn-n, .tzai .sd-cn-payg { color: #7C6A5A !important; }
.tzai .sd-cn-best, .tzai .sd-cn-cheapest, .tzai .sd-cn-summary-h, .tzai .sd-cn-sub,
.tzai .sd-cn-win { color: #2F5A12 !important; }
.tzai .sd-cn-best { background: rgba(63,98,18,.14) !important; font-weight: 700; }
.tzai .sd-cn-win b { color: #1F4208 !important; }
.tzai .sd-cn-or { color: #1F4E8C !important; background: rgba(47,95,158,.08) !important; }
.tzai .sd-cn-answer { color: #3A2F26 !important; }
.tzai .sd-cn-answer b { color: #1A140F !important; }
.tzai .sd-cn-caveat, .tzai .sd-cn-sub-unconfirmed { color: #9A3F12 !important; }
.tzai .sd-cn-caveat b { color: #7A2E08 !important; }
.tzai .sd-cn-summary { background: rgba(63,98,18,.06) !important; }
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
   the architect 2026-09-04: "The zoom does not work in the graph, because the mouse wheel
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
  margin: 0 !important; z-index: 2147483000; background: #FFFDFB; display: none; }
.tzai-fs.on { display: block; }
/* 2026-09-23 (the architect: "only 50% in height ... some crap also at the top that does not let
   me use the 100% height. Reset view icon is not necessary ... a close button with the
   'ESC' note ... could just sit on the top-right"). No toolbar row any more: the drawing
   takes the whole viewport and the few controls FLOAT over it, the way a map's do. The
   title and subtitle stay on the page; the footnotes moved to the page text. */
.tzai-fs-body { position: absolute; inset: 0; }
.tzai-fs-close { position: absolute; top: 8px; right: 10px; z-index: 3; padding: 6px 12px;
  font: 10px/1.3 "SF Mono", ui-monospace, monospace; letter-spacing: .1em;
  background: rgba(255, 253, 251, .92) !important; color: #7A3921 !important;
  border-color: #E5D3BE !important; }
.tzai-fs-close:hover { border-color: #7A3921 !important; }
.tzai-fs .tzai-stage, .tzai-fs .sc-overlay { height: 100% !important; max-height: none !important; }
.tzai.tzai-fs .sc-card { position: relative !important; height: 100% !important; max-height: none !important;
  padding: 0 !important; border: 0 !important; border-radius: 0 !important; }
.tzai.tzai-fs .sc-body { position: absolute !important; inset: 0 !important; height: auto !important;
  min-height: 0 !important; flex: none !important; }
.tzai-fs .sc-title, .tzai-fs .sc-sub { display: none !important; }
.tzai.tzai-fs .sc-head { position: absolute; top: 8px; right: 150px; z-index: 2; margin: 0;
  padding: 5px 12px; border-radius: 999px; border: 1px solid #E5D3BE;
  background: rgba(255, 253, 251, .92); }
.tzai.tzai-fs .sc-legend { position: absolute; top: 8px; left: 10px; right: 470px; z-index: 2;
  margin: 0; max-height: none; overflow: visible; pointer-events: none; }
.tzai.tzai-fs .sc-legend .sc-chip { pointer-events: auto; }
.tzai.tzai-fs .sc-legend .sc-chip:not(.active) { background: color-mix(in srgb, var(--sc-chip) 7%, #FFFDFB); }
/* narrow screens: the drawing is width-bound and centred with room above and below it,
   so the switches drop to the bottom edge instead of colliding with the wrapped chips */
@media (max-width: 900px) {
  .tzai.tzai-fs .sc-head { top: auto; bottom: 10px; right: 10px; }
  .tzai.tzai-fs .sc-legend { right: 130px; }
}
/* the figure leaves a hole while it is up on the overlay, so the article does not
   jump: the placeholder keeps the same box and says where the drawing went. */
.tzai-hole { display: none; align-items: center; justify-content: center;
  border: 1px dashed var(--border); border-radius: 10px; color: var(--muted);
  height: min(64vw, 940px); min-height: 460px;
  font-family: "SF Mono", ui-monospace, monospace; font-size: 11px; letter-spacing: .08em; }
.tzai-hole.on { display: flex; }
/* The slide readout ("19% · €5.00") is drawn for the panel's near-black paper: cream fill
   in a black halo, which on the site's white page read as a smudge (the architect 2026-09-17).
   CSS fill beats the fill="" presentation attribute, and this sheet loads last. */
.tzai .sc-util-pct { fill: var(--text); fill-opacity: 1; stroke: #FFFFFF; stroke-width: 3.5px;
  stroke-opacity: .95; font-weight: 600; }
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
// The panel's applyFocus (tinker-ui app.ts HIGHLIGHT), ported 2026-09-24 after the architect found
// the site still lit only on the vendor chips: hovering a model's circle or triangle
// lights that whole model (path, bubbles, triangles, bridges) plus every other seller of
// the same brain (data-twin). The brightness itself is the captured .sc-focus/.sc-hl CSS.
var hoverVendor = '';
var hoverTwin = '';
var hoverModel = '';
function paint(){
  var v = locked || hoverVendor;
  var focused = !!(v || hoverTwin || hoverModel);
  svgs().forEach(function(svg){
    svg.classList.toggle('sc-focus', focused);
    if (!focused) {
      svg.querySelectorAll('.sc-hl').forEach(function(el){ el.classList.remove('sc-hl'); });
      return;
    }
    svg.querySelectorAll('[data-vendor],[data-twin],[data-model]').forEach(function(el){
      var ev = el.getAttribute('data-vendor') || '';
      var et = el.getAttribute('data-twin') || '';
      var em = el.getAttribute('data-model') || '';
      el.classList.toggle('sc-hl', (v ? ev === v : false) || (hoverTwin ? et === hoverTwin : false) ||
        (hoverModel ? em === hoverModel : false));
    });
  });
  stage.querySelectorAll('.sc-chip').forEach(function(c){
    c.style.outline = (locked ? c.dataset.vendor === locked : false) ? '1px solid var(--accent)' : '';
  });
}
stage.querySelectorAll('.sc-chip').forEach(function(chip){
  chip.addEventListener('mouseenter', function(){ hoverVendor = chip.dataset.vendor || ''; paint(); });
  chip.addEventListener('mouseleave', function(){ hoverVendor = ''; paint(); });
  chip.addEventListener('click', function(e){ e.preventDefault();
    locked = (locked === chip.dataset.vendor) ? null : chip.dataset.vendor; paint(); });
});
svgs().forEach(function(svg){
  svg.addEventListener('mouseover', function(e){
    var el = e.target;
    var tw = el.closest ? el.closest('[data-twin]') : null;
    var md = el.closest ? el.closest('[data-model]') : null;
    var t = tw ? (tw.getAttribute('data-twin') || '') : '';
    var m = md ? (md.getAttribute('data-model') || '') : '';
    if (t !== hoverTwin || m !== hoverModel) { hoverTwin = t; hoverModel = m; paint(); }
  });
  svg.addEventListener('mouseleave', function(){
    if (hoverTwin || hoverModel) { hoverTwin = ''; hoverModel = ''; paint(); }
  });
});

// Pan/zoom is wired per drawing: the two cost modes are two separate <svg>s.
svgs().forEach(function(svg){
  var vb0 = (svg.getAttribute('viewBox') || '0 0 900 600').split(/[\\s,]+/).map(Number);
  var vb = vb0.slice();
  function apply(){
    svg.setAttribute('viewBox', vb.join(' '));
    // The panel's applyView: --sc-k = inverse zoom, which the captured CSS uses to
    // counter-scale rings, logos and labels so they keep their on-screen size while their
    // positions spread (the architect 2026-09-17: "the size of the bubbles should remain constant").
    svg.style.setProperty('--sc-k', String(vb[2] / vb0[2]));
    svg.classList.toggle('sc-zoomed', vb0[2] - 0.5 > vb[2]);
  }
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
    // A prepaid circle is a slider, not a grab handle for the map (the architect 2026-09-15:
    // "I am unable to drag the circles right-left because the whole graph moves").
    var onDot = e.target.closest ? e.target.closest('[data-util-drag]') : null;
    if (onDot) return;
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
// Sliding a prepaid circle along plan price -> API list price, the panel's wireUtilDrag
// (tinker-ui app.ts) ported. The panel reads the live scales; a static page has none,
// so each circle's own two anchors (home x/cost, list x/cost) rebuild its axis: both
// axes are affine, in cost (linear drawing) or in log10(cost) (log drawing). The home
// utilisation is read back from the circle's own "75%" label, so SC_PLAN_UTIL is not
// copied here. Snap-back, cursor and readout are the panel CSS already on the page.
// 2026-09-24, the panel's plan WAYPOINTS ported (the architect 2026-09-23: "once I choose to start
// dragging a circle, its row elements will also highlight"): grabbing a circle lights its
// row (plan triangles, API triangle, dashed bridge = .sc-wp-active), each triangle is a
// sticky stop within SNAP_PX screen pixels, and on a stop the readout names the plan and
// its monthly price. Stop x and label ride on the captured marks (data-wp-x/-hud).
var SNAP_PX = 12;
svgs().forEach(function(svg){
  var lin = svg.classList.contains('tzai-lin');
  function f(c){ return lin ? c : Math.log(c) / Math.LN10; }
  function finv(v){ return lin ? v : Math.pow(10, v); }
  var slide = null;
  function setHit(st){
    if (!slide) return;
    if (slide.hit === st) return;
    if (slide.hit) slide.hit.el.classList.remove('sc-wp-hit');
    if (st) st.el.classList.add('sc-wp-hit');
    slide.g.classList.toggle('sc-util-on-wp', !!st);
    slide.hit = st;
  }
  svg.addEventListener('pointerdown', function(e){
    var g = e.target.closest ? e.target.closest('.sc-dotpos[data-util-drag]') : null;
    if (!g) return;
    var homeX = +g.dataset.homeX, listX = +g.dataset.listX;
    var homeCost = +g.dataset.homeCost, listCost = +g.dataset.listCost;
    var label = g.querySelector('.sc-util-pct');
    var util0 = label ? parseFloat(label.textContent) / 100 : 0.75;
    if (!(homeCost > 0) || !(listCost > 0) || f(listCost) === f(homeCost) || !(util0 > 0)) return;
    e.preventDefault();
    e.stopPropagation();
    var k = (listX - homeX) / (f(listCost) - f(homeCost));
    var xAt = function(c){ return homeX + (f(c) - f(homeCost)) * k; };
    var q = '[data-model="' + CSS.escape(g.dataset.model || '') + '"][data-effort="' +
      CSS.escape(g.dataset.effort || '') + '"]';
    var row = [].slice.call(svg.querySelectorAll('.sc-apipos' + q + ', .sc-bridgelayer line' + q));
    var stops = [];
    row.forEach(function(el){
      el.classList.add('sc-wp-active');
      if (!el.classList.contains('sc-apipos')) return;
      var plan = el.classList.contains('sc-wppos');
      var x = plan ? +el.dataset.wpX : listX;
      if (isFinite(x)) stops.push({ el: el, x: x, hud: plan ? (el.dataset.wpHud || '') : 'API · no monthly fee' });
    });
    // The range spans every mark on the row: a bigger plan can land LEFT of our own seat's
    // 100% (OpenAI Pro 20x sits left of Plus), and a stop you cannot reach is not a stop.
    var xs = [xAt(homeCost * util0), listX].concat(stops.map(function(st){ return st.x; }));
    slide = { g: g, label: label, labelText: label ? label.textContent : '', homeX: homeX,
      y: +g.dataset.homeY, homeCost: homeCost, util0: util0, k: k, row: row, stops: stops, hit: null,
      lo: Math.min.apply(null, xs), hi: Math.max.apply(null, xs) };
    g.classList.add('sc-util-sliding');
    g.classList.remove('sc-util-snap');
    svg.classList.add('sc-util-dragging');
    try { g.setPointerCapture(e.pointerId); } catch(_){}
  });
  svg.addEventListener('pointermove', function(e){
    if (!slide) return;
    var ctm = svg.getScreenCTM(); if (!ctm) return;
    var pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    var x = Math.max(slide.lo, Math.min(slide.hi, pt.matrixTransform(ctm.inverse()).x));
    var reach = SNAP_PX / (Math.abs(ctm.a) || 1);
    var best = null;
    slide.stops.forEach(function(st){
      var d = Math.abs(st.x - x);
      if (d > reach) return;
      if (best === null || d < Math.abs(best.x - x)) best = st;
    });
    if (best) x = best.x;
    setHit(best);
    slide.g.setAttribute('transform', 'translate(' + x + ', ' + slide.y + ')');
    if (!slide.label) return;
    if (best) { slide.label.textContent = best.hud; return; }
    // UNCLAMPED on purpose, as in the panel: left of our own 100% the seat cannot deliver
    // that price, and "150%" says so where a clamped "100%" would claim it can.
    var cost = finv(f(slide.homeCost) + (x - slide.homeX) / slide.k);
    var util = slide.homeCost * slide.util0 / cost;
    slide.label.textContent = Math.round(util * 100) + '% · €' +
      (cost >= 10 ? cost.toFixed(0) : cost >= 1 ? cost.toFixed(2) : cost.toFixed(3));
  });
  function endSlide(e){
    if (!slide) return;
    var g = slide.g;
    setHit(null);
    slide.row.forEach(function(el){ el.classList.remove('sc-wp-active'); });
    g.setAttribute('transform', 'translate(' + slide.homeX + ', ' + slide.y + ')');
    g.classList.remove('sc-util-sliding');
    g.classList.add('sc-util-snap');
    svg.classList.remove('sc-util-dragging');
    if (slide.label) slide.label.textContent = slide.labelText;
    try { g.releasePointerCapture(e.pointerId); } catch(_){}
    slide = null;
  }
  svg.addEventListener('pointerup', endSlide);
  svg.addEventListener('pointercancel', endSlide);
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
// LOG <-> LINEAR: both drawings were captured from the panel, so this only chooses
// which one is on screen. Each keeps its own zoom, as the panel resets view on repaint.
stage.querySelectorAll('.sc-scale-input').forEach(function(i){
  i.addEventListener('change', function(){ stage.classList.toggle('tzai-linmode', i.checked); });
});

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
// No toolbar row (the architect 2026-09-23): the close button floats top-right over the drawing,
// and RESET VIEW is gone — reloading the page resets the view.
var fs = el('div', 'tzai tzai-chart tzai-fs');
var fsBody = el('div', 'tzai-fs-body');
var fsClose = el('button', 'tzai-btn tzai-fs-close', 'CLOSE \u2715 (ESC)');
fsClose.type = 'button';
fs.appendChild(fsBody);
fs.appendChild(fsClose);
document.body.appendChild(fs);

var scrollLock = null;
function openFull(){
  if (fullOn) return;
  fsBody.appendChild(stage);
  if (frame) frame.classList.add('tzai-isopen');
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
  if (frame) frame.classList.remove('tzai-isopen');
  hole.classList.remove('on');
  fs.classList.remove('on');
  if (scrollLock) { document.documentElement.style.overflow = scrollLock.h;
                    document.body.style.overflow = scrollLock.b; }
  fullOn = false;
  tip.classList.remove('on');
}
var frame = root.querySelector('.tzai-frame');
root.querySelectorAll('.tzai-full, .tzai-open').forEach(function(b){ b.addEventListener('click', openFull); });
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
  // 2026-09-15: WordPress served one new "a && b" as "a &#038;&#038; b" and killed the whole
  // chart script, while an older "&&" in the same script came through intact. Rather than
  // model which "&" it rewrites, none ships: use a ternary instead of &&.
  if (out.includes("&"))
    die(
      'emitted JS carries an "&" — WordPress encodes it to &#038;: ' +
        out.slice(Math.max(0, out.indexOf("&") - 40), out.indexOf("&") + 20),
    );
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
// ── the card's footnotes become page text; the drawing loses its caption ─────
// 2026-09-23 (the architect: "the available real-estate ... once it is maximized, is only 50% in
// height. There are some useless bottom notes that should instead go in the main website
// as normal text"). The .sc-foot strip under the plot is lifted out whole and published as
// "The fine print" below the page's own "How to read it" (NOTES marker, see
// publish_ai_analysis.py); the THALAMUS caption inside the SVG is dropped because FIGURES
// already prints it; the canvas is cropped to the measured bottom of what is left.
const footM = chartCostCard.match(/<div class="sc-foot">([\s\S]*?)<\/div>/);
if (!footM) die("the chart card has no .sc-foot — nothing to move to the page");
const notesItems = [...footM[1].matchAll(/<span>([\s\S]*?)<\/span>/g)]
  .map((m) => m[1].trim())
  .filter(Boolean);
if (notesItems.length < 3) die(`only ${notesItems.length} footnotes found in .sc-foot`);
chartCostCard = chartCostCard.replace(footM[0], "");
chartCostCard = chartCostCard.replace(/<text class="sc-env-foot"[\s\S]*?<\/text>/g, "");
if (cropH > 400 && cropH < 600) {
  chartCostCard = chartCostCard
    .split('viewBox="0 0 900 600"')
    .join(`viewBox="0 0 900 ${cropH}"`)
    .replace(/(<rect x="0" y="0" width="900" )height="600"/g, `$1height="${cropH}"`)
    .replace(/(<rect x="0\.5" y="0\.5" width="899" )height="599"/g, `$1height="${cropH - 1}"`);
  if (chartCostCard.includes('viewBox="0 0 900 600"')) die("crop left a 900x600 drawing behind");
} else {
  console.error(`  crop skipped: measured bottom ${cropH} is outside (400, 600)`);
}
const notesHtml =
  `<h3 style="color:#7A3921;">The fine print</h3>` +
  `<ul style="color:#404040;line-height:1.65;font-size:0.92em;">` +
  notesItems.map((t) => `<li>${t}</li>`).join("") +
  `</ul>`;

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
  `<div class="tzai-bar"><span>click the map to open it full screen &middot; zoom, pan, hover every model &middot; ` +
  `switch per token / per task and log / linear</span></div>` +
  `<div class="tzai-frame"><div class="tzai-stage">` +
  costCard +
  `</div><button class="tzai-open" type="button" aria-label="Open the smartness by cost map full screen">` +
  `<span class="tzai-open-pill">&#10530; Explore the map full screen <span>&middot; zoom &amp; pan</span></span></button>` +
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
fs.writeFileSync(path.join(OUT, "notes.part.html"), notesHtml);

// Standalone previews on the SITE's paper — not published, but the only way to look
// at the thing before it goes near the post. Rule: render it and LOOK.
const preview = (frag, title) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>html,body{margin:0;background:#FFFFFF;color:#404040;` +
  `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}` +
  `.wrap{max-width:1510px;margin:0 auto;padding:24px 16px;}</style></head>` +
  `<body><div class="wrap"><h2 style="color:#7A3921;font-weight:600;">${title}</h2>${frag}</div></body></html>`;
fs.writeFileSync(
  path.join(OUT, "smart-cost.html"),
  preview(chartFragment + notesHtml, "SMARTNESS x COST"),
);
fs.writeFileSync(path.join(OUT, "dossier.html"), preview(dossierFragment, "SMART MODELS dossier"));

const manifest = {
  generatedAt: new Date().toISOString(),
  figures,
  dossier: dossierMeta,
  pageErrors,
  logoSymbols: defs.size,
  cropH,
  notes: notesItems.length,
  bytes: { chart: chartFragment.length, dossier: dossierFragment.length },
  files: {
    chart: path.join(OUT, "chart.part.html"),
    dossier: path.join(OUT, "dossier.part.html"),
    notes: path.join(OUT, "notes.part.html"),
    chartPreview: path.join(OUT, "smart-cost.html"),
    dossierPreview: path.join(OUT, "dossier.html"),
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
