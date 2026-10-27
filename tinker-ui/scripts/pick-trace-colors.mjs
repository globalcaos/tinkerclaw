#!/usr/bin/env node
// tinker-ui/scripts/pick-trace-colors.mjs
// FORK 2026-08-04 (the architect): "use a montecarlo random sampling of the 3D space
// populated by the already taken colors and sequentially choose one whose
// distance to all the previous points is maximal."
//
// Greedy farthest-point sampling for EEG trace colours. The problem it solves:
// Kimi (#1783FF), GLM (#3859FF), DeepSeek (#4D6BFE) and Qwen (#6336E7) are ALL
// blue-indigo brands. Painted as-is they are four indistinguishable traces on the
// same seismograph. Brand fidelity has to yield to legibility — but only as far
// as it must, so each slot carries a soft hue preference pulled from the real logo.
//
// Distance is measured in OKLab, not RGB: RGB euclidean distance is not perceptual,
// so a "maximal distance" pick in RGB routinely lands on two colours the eye reads
// as the same. Run: node tinker-ui/scripts/pick-trace-colors.mjs

// ─── colour space ───
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const f =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
}

function rgbToOklab([r, g, b]) {
  const lr = srgbToLinear(r),
    lg = srgbToLinear(g),
    lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const oklab = (hex) => rgbToOklab(hexToRgb(hex));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const toHex = ([r, g, b]) =>
  "#" +
  [r, g, b]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();

/** Hue angle in OKLab's a/b plane, degrees 0..360. */
const hueOf = (lab) => ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
const chromaOf = (lab) => Math.hypot(lab[1], lab[2]);

// ─── the space already populated ───
// The EEG paper itself is a point in the space: a trace that lands near it is
// invisible, which is the same failure as two traces landing near each other.
const BACKGROUND = "#2a2318";

// Retained brand colours (eeg-trace.ts EEG_PROVIDER_COLORS). Copilot is absent —
// it is being re-picked this run, so its old Windows blue must NOT repel anything.
const TAKEN = {
  background: BACKGROUND,
  anthropic: "#E8702A",
  openai: "#10A37F",
  deepseek: "#4D6BFE", // authentic DeepSeek brand, already shipped — kept fixed
  mistral: "#FA520F",
  meta: "#0668E1",
  xai: "#B7BBC2",
  unknown: "#8A8F98",
};

// Slots to fill, in the order they are chosen. Each later pick must also avoid
// every earlier pick — that is the "sequentially" part of the brief.
const SLOTS = [
  {
    key: "github-copilot",
    // the architect asked for pink, then "rethink the pink also" — so pink is a hue
    // WINDOW and the sampler finds the most separable point inside it. 320-352
    // is empty space: the nearest occupied hue is mistral at 38.
    hue: [320, 352],
    note: "the architect's pick: pink (not a brand colour)",
  },
  {
    key: "qwen",
    // Qwen brand is #6336E7 (h=285) / #6F69F7 (h=280) — indigo-violet, which is
    // what the architect means by "blue". Window pushed to the violet side of the brand
    // so it clears DeepSeek (h=270) instead of sitting on top of it.
    hue: [286, 308],
    note: "Qwen brand indigo-violet (#6336E7 h=285)",
  },
  {
    key: "kimi",
    // Kimi brand is #1783FF (h=256) — but 256 is the single most crowded hue on
    // the paper (meta 258, xai 262, glm 268, deepseek 270). Pushed cyan-ward into
    // 205-245, still recognisably Kimi's blue, now with room to breathe.
    hue: [205, 245],
    note: "Kimi brand azure (#1783FF h=256), pushed cyan-ward to clear the pile-up",
  },
  {
    key: "glm",
    // GLM/Zhipu brand is #3859FF (h=268) — one degree off DeepSeek. A faithful
    // pick is genuinely impossible: staying blue means colliding, and the lighter
    // blue that would clear DeepSeek lands on xai's near-neutral gray instead.
    // Hue left FREE so legibility wins, and the report says so out loud rather
    // than pretending the result is on-brand.
    hue: null,
    note: "GLM brand #3859FF collides with DeepSeek (h=268 vs 270) — hue left free",
  },
];

// ─── legibility + aesthetic gate ───
// On #2a2318 paper a trace needs lightness and some chroma or it reads as mud.
// The chroma CEILING is the aesthetic half: unconstrained max-distance sampling
// walks straight to the saturated corners of the RGB cube (#05FE01, #07F4FF) —
// mathematically optimal, and ruinous on a woody panel whose existing brand
// colours all sit between chroma 0.124 (openai) and 0.247 (glm brand). Staying
// inside that measured band keeps a new trace in the same visual register as the
// ones already there. Distance is maximised WITHIN the register, not across it.
const MIN_L = 0.55,
  MAX_L = 0.85;
const MIN_CHROMA = 0.1,
  MAX_CHROMA = 0.24;
const MIN_BG_DIST = 0.35;

const SAMPLES = 200000;
const bgLab = oklab(BACKGROUND);

// Deterministic PRNG — a colour palette that changes on every run is not a
// palette, it is a lottery. Same seed ⇒ same answer ⇒ reviewable in a diff.
let seed = 20260804;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const taken = Object.entries(TAKEN).map(([k, v]) => ({ k, lab: oklab(v), hex: v }));
const results = [];

for (const slot of SLOTS) {
  let best = null;
  for (let i = 0; i < SAMPLES; i++) {
    const rgb = [rnd(), rnd(), rnd()];
    const lab = rgbToOklab(rgb);
    if (lab[0] < MIN_L || lab[0] > MAX_L) continue;
    const chroma = chromaOf(lab);
    if (chroma < MIN_CHROMA || chroma > MAX_CHROMA) continue;
    if (dist(lab, bgLab) < MIN_BG_DIST) continue;
    if (slot.hue) {
      const h = hueOf(lab);
      const [lo, hi] = slot.hue;
      const inWindow = lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi; // wraps at 360
      if (!inWindow) continue;
    }
    // the objective: distance to the NEAREST already-taken point, maximised
    let minD = Infinity;
    for (const t of taken) {
      const d = dist(lab, t.lab);
      if (d < minD) minD = d;
    }
    if (!best || minD > best.minD) best = { rgb, lab, minD };
  }
  if (!best) {
    console.error(`no candidate satisfied the constraints for ${slot.key}`);
    process.exit(1);
  }
  const hex = toHex(best.rgb);
  results.push({ key: slot.key, hex, sep: best.minD, note: slot.note });
  taken.push({ k: slot.key, lab: best.lab, hex }); // sequential: repels the next pick
}

// ─── report ───
console.log(`OKLab farthest-point sampling · ${SAMPLES} samples/slot · seed ${20260804}\n`);
for (const r of results) {
  console.log(`${r.key.padEnd(16)} ${r.hex}   separation=${r.sep.toFixed(3)}   ${r.note}`);
}

console.log("\nfull palette separation matrix (min distance to any other point):");
for (const a of taken) {
  let minD = Infinity,
    who = "";
  for (const b of taken) {
    if (a === b) continue;
    const d = dist(a.lab, b.lab);
    if (d < minD) {
      minD = d;
      who = b.k;
    }
  }
  const flag = minD < 0.15 ? "  <-- TOO CLOSE" : "";
  console.log(
    `  ${a.k.padEnd(16)} ${a.hex.padEnd(9)} nearest=${who.padEnd(16)} d=${minD.toFixed(3)}${flag}`,
  );
}
