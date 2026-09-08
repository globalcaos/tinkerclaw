// title-spec.mjs — extract product spec directly from the Amazon title.
//
// Amazon pool-chemical titles are dense with structured data: package size
// ("5 kg", "20 L"), concentration ("15%"), form ("Granulated"/"Liquid"), and
// active ingredient ("Hydrochloride"/"sulfuric"/"bisulfato"). Parsing the
// title is faster, cheaper, and more reliable than an LLM round-trip for the
// common case — the research-ladder LLM step stays as the fallback for titles
// that don't yield enough.
//
// Returns { form, package_size_kg, package_size_l, concentration_pct,
//           active_ingredient, confidence } — confidence in [0,1].

const NUM = "([\\d]+(?:[.,][\\d]+)?)";

function num(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Active-ingredient detection. Order matters: more-specific first.
function detectActiveIngredient(t) {
  if (/bisulfato|bisulfate|nahso4|hidrogenosulfato|sodium hydrogen sul(f|ph)ate/i.test(t)) {
    return { active_ingredient: "sodium bisulfate", default_conc: 100 };
  }
  if (/clorh[ií]drico|hydrochlor|hydrochloride|muri[aá]tic|salfum|hcl\b/i.test(t)) {
    return { active_ingredient: "hydrochloric acid", default_conc: 22 };
  }
  if (/sulf[uú]rico|sulfuric|h2so4/i.test(t)) {
    return { active_ingredient: "sulfuric acid", default_conc: 15 };
  }
  return { active_ingredient: null, default_conc: null };
}

function detectForm(t) {
  // Strong solid signals
  const liquidSignal =
    /l[ií]quid|liquid|litros|liters|litres|\b\d[\d.,]*\s*l\b|garrafa|carafe|botella|bottle|container/i;
  if (
    /granulad|granular|granules|polvo|powder|s[oó]lido|solid|tabletas|comprimido|\bkg\b/i.test(t)
  ) {
    // but if it ALSO signals liquid, prefer liquid (mixed titles like "20 L (25 kg)")
    if (liquidSignal.test(t)) {
      return "liquid";
    }
    return "granular";
  }
  if (liquidSignal.test(t)) {
    return "liquid";
  }
  return null;
}

export function parseSpecFromTitle(title) {
  const t = String(title || "");
  if (!t) {
    return {
      form: null,
      package_size_kg: null,
      package_size_l: null,
      concentration_pct: null,
      active_ingredient: null,
      confidence: 0,
    };
  }

  const { active_ingredient, default_conc } = detectActiveIngredient(t);
  const form = detectForm(t);

  // Package size — capture BOTH kg and L when present ("20 L (25 kg)").
  const kgMatch = t.match(new RegExp(`${NUM}\\s*kg\\b`, "i"));
  const lMatch = t.match(new RegExp(`${NUM}\\s*(?:l|litros|liters|litres)\\b`, "i"));
  const gMatch = !kgMatch && t.match(new RegExp(`${NUM}\\s*g\\b`, "i")); // grams, only if no kg
  const package_size_kg = kgMatch ? num(kgMatch[1]) : gMatch ? num(gMatch[1]) / 1000 : null;
  const package_size_l = lMatch ? num(lMatch[1]) : null;

  // Concentration — explicit "15%" wins; else fall back to the ingredient default.
  const pctMatch = t.match(new RegExp(`${NUM}\\s*%`));
  const concentration_pct = pctMatch ? num(pctMatch[1]) : default_conc;

  // Confidence: we want at least a size AND (a form or an active ingredient).
  let confidence = 0;
  if (package_size_kg || package_size_l) confidence += 0.5;
  if (form) confidence += 0.25;
  if (active_ingredient) confidence += 0.25;
  // Explicit concentration is a strong signal.
  if (pctMatch) confidence = Math.min(1, confidence + 0.15);

  return {
    form,
    package_size_kg,
    package_size_l,
    concentration_pct,
    active_ingredient,
    confidence: Math.min(1, confidence),
  };
}

// Compute a normalized "kg of active compound" for €/kg-active ranking.
// For liquids: litres × (density≈1.1 for these acids) × concentration.
// For solids: kg × concentration.
export function activeKg(spec) {
  const conc = (spec.concentration_pct ?? 0) / 100;
  if (!conc) return null;
  if (spec.package_size_kg) return spec.package_size_kg * conc;
  if (spec.package_size_l) return spec.package_size_l * 1.1 * conc; // acid density approx
  return null;
}
