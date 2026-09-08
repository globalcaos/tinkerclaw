// brand-concentrations.mjs — known active-ingredient concentrations for pool
// pH-minus products, by brand and form.
//
// WHY THIS EXISTS: €/kg-active ranking needs each product's concentration. Many
// Amazon titles name neither the active ingredient nor the % (e.g. "CONTROL
// GARDEN Bajador PH Granulado 10 KG"), so the title parse yields form but no
// concentration → active_kg can't be computed → the ranker silently falls back
// to €/L vs €/kg, which is NOT comparable across forms. This table is the
// deterministic fast-path that resolves concentration BEFORE any network call.
//
// SOURCES: manufacturer datasheets + Amazon.es product labels confirmed
// 2026-06-24 — CTX-15 / AQUAMINUS / Bayrol liquid pH-minus all read "ácido
// sulfúrico al 15% uso doméstico"; granulado pH-minus is sodium bisulfate
// ~93-100%. When a brand is absent here AND the title omits ingredient/%, the
// research ladder applies a generic per-form default flagged `needs_concentration`,
// and the AGENT escalates to a parallel brand-research subagent (see SKILL.md →
// "Brand-concentration research"), writing the confirmed value back via
// `amazon-shopper set-spec`.

// Generic per-form defaults for the Spanish domestic pH-minus market.
export const FORM_DEFAULTS = {
  granular: { active_ingredient: "sodium bisulfate", concentration_pct: 95 },
  liquid: { active_ingredient: "sulfuric acid", concentration_pct: 15 },
};

// Brand overrides keyed by a lowercase token found in brand or title →
// per-form concentration %. Add a row whenever a subagent confirms a brand.
const BRAND_TABLE = {
  ctx: { liquid: 15, granular: 100 }, // CTX-15 liquid = 15% H2SO4; CTX dry acid = 100% bisulfate
  bayrol: { liquid: 15, granular: 100 },
  astralpool: { liquid: 15, granular: 100 },
  aquaminus: { liquid: 15 },
  nortembio: { liquid: 15, granular: 95 },
  onepool: { liquid: 15 },
  gre: { granular: 100 },
};

// Resolve a concentration for a product whose title gave us a form but no %.
// Returns { concentration_pct, active_ingredient, concentration_source,
//           needs_concentration } or null when even the form is unknown.
export function lookupConcentration({ brand, form, title } = {}) {
  if (!form) return null;
  const hay = `${brand || ""} ${title || ""}`.toLowerCase();
  for (const key of Object.keys(BRAND_TABLE)) {
    if (!hay.includes(key)) continue;
    const pct = BRAND_TABLE[key][form];
    if (pct != null) {
      return {
        concentration_pct: pct,
        active_ingredient: FORM_DEFAULTS[form]?.active_ingredient ?? null,
        concentration_source: `brand-table:${key}`,
        needs_concentration: false, // confirmed brand value, no research needed
      };
    }
  }
  const def = FORM_DEFAULTS[form];
  if (!def) return null;
  return {
    concentration_pct: def.concentration_pct,
    active_ingredient: def.active_ingredient,
    concentration_source: "form-default",
    needs_concentration: true, // an assumption — agent may confirm via subagent
  };
}
