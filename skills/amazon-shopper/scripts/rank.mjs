// rank.mjs — pick a normalization metric (via LLM) and rank products.
import { callLLM } from "./llm.mjs";

// Amazon refund-protection tier — every Amazon purchase is A-to-z covered for
// "not as described" (which warranties the concentration spec ranking trusts),
// but friction differs by seller:
//   2 = sold by Amazon + in stock  (instant refund, free return)
//   1 = third-party + in stock      (A-to-z covered, may need 48h + escalation)
//   0 = out of stock / unknown seller (can't buy / higher risk)
// Exported so AmazonAdapter can reuse the exact same tiering as rankMode.
export function refundTier(p) {
  if (p.in_stock === 0) return 0;
  if (p.seller_is_amazon === 1) return 2;
  if (p.seller_name) return 1;
  return 0;
}

const CHOOSE_METRIC_SYSTEM = `\
You pick the right per-unit normalization metric for a product category.

Examples:
- Pool chemicals → "eur_per_kg_active" (price normalized by kg of active ingredient)
- Cleaning products → "eur_per_kg" or "eur_per_litre"
- Food → "eur_per_kg" or "eur_per_100g"
- Batteries → "eur_per_mah"
- Durables → "feature_weighted" (no volume math, just feature ranking)

Return ONLY this JSON:
{
  "metric_id": "<short snake_case id>",
  "formula_human": "<one-sentence description>",
  "formula_js": "<a JS expression that computes the metric from variable p (a product row); lower is better>"
}

The formula_js will be sandboxed: it has access to ONLY 'p' (the product row).
Use Math.* if needed. Return null-safe expression.`;

function buildMetricUserPrompt(category_filter, sample) {
  const cat = JSON.stringify(category_filter ?? {});
  const sampleStr = sample
    .slice(0, 5)
    .map(
      (p) =>
        `- ${p.title} (asin=${p.asin}, price=€${p.current_price_eur}, size=${p.package_size_kg}kg, conc=${p.concentration_pct}%)`,
    )
    .join("\n");
  return `Category filter: ${cat}\n\nSample products:\n${sampleStr}\n\nPick the right normalization metric.`;
}

function matchesCategory(product, category_filter) {
  for (const [axis, value] of Object.entries(category_filter || {})) {
    if (!value) continue;
    const v = String(value).toLowerCase();
    const t = (product.title || "").toLowerCase();
    // Bilingual matchers — Apify often returns translated English titles
    // alongside Spanish-language Spanish-marketplace listings.
    if (/form/i.test(axis)) {
      // Any axis with "form" in the name (e.g. form, form_preference,
      // form_and_size) treats the answer as a soft form-filter. Skip
      // direction-implying answers (lower/raise) — those aren't catalog filters.
      if (/raise|increaser|increase/.test(v)) return false; // explicit increaser is NOT pH-minus
      // Prefer the title-parsed `form` field (precise) over title regex (fuzzy).
      // Stem-match "granul*" so the categorizer's "Granulated" option (and the
      // Spanish "granulado") both register — `"granulated".includes("granular")`
      // is false, which silently disabled the solid filter.
      const wantSolid = v.includes("powder") || /granul/.test(v) || v.includes("solid");
      const wantLiquid = v.includes("liquid") || v.includes("liquido") || v.includes("líquid");
      if (product.form === "liquid" || product.form === "granular") {
        if (wantSolid && product.form !== "granular") return false;
        if (wantLiquid && product.form !== "liquid") return false;
      } else {
        // No parsed form — fall back to title keywords (excluding the
        // over-broad "reducer", which appears in both liquid and granular).
        if (
          wantSolid &&
          !/polvo|sólido|granulado|granular|bisulfato|tabletas|comprimido|powder|solid/.test(t)
        )
          return false;
        if (
          wantLiquid &&
          !/líquid|liquido|liquid|hcl|clorhídrico|hydrochloric|sulfúrico|sulfuric|garrafa|botella|bottle|litro|liter/.test(
            t,
          )
        )
          return false;
      }
      // "no preference" / "any" — no filtering.
    } else if (/direction/i.test(axis)) {
      // Direction axis: if the user picked "raise"/"plus", drop reducers.
      // If "lower"/"minus", drop increasers.
      if (/lower|minus|reduce/.test(v)) {
        if (/increase|increaser|plus|raise/.test(t) && !/reducer|reductor|minus/.test(t))
          return false;
      }
      if (/raise|plus|increase/.test(v)) {
        if (/reduce|reducer|reductor|minus/.test(t)) return false;
      }
    } else {
      const a = (product.active_ingredient || "").toLowerCase();
      if (!t.includes(v) && !a.includes(v)) return false;
    }
  }
  return true;
}

function safeApplyFormula(formulaJs, p) {
  try {
    const fn = new Function(
      "p",
      "Math",
      `"use strict"; try { return (${formulaJs}); } catch { return Number.POSITIVE_INFINITY; }`,
    );
    const v = fn(p, Math);
    return typeof v === "number" && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function rankProducts({ products, category_filter, volume_bracket }) {
  // Two eligibility tiers:
  // 1) ideal: spec_status === "ok" (LLM-extracted active ingredient + concentration)
  // 2) fallback: matchesCategory + has a price — so Apify search alone (no research
  //    ladder) is still rankable by price-per-package.
  const idealEligible = products.filter(
    (p) => p.spec_status === "ok" && matchesCategory(p, category_filter),
  );
  const fallbackEligible = products.filter(
    (p) => p.current_price_eur && matchesCategory(p, category_filter),
  );
  const eligible = idealEligible.length > 0 ? idealEligible : fallbackEligible;
  // Skipped = products we couldn't extract specs for (preserves original
  // semantics — products that just didn't match the category aren't "skipped",
  // they're just not relevant).
  const skipped = products
    .filter((p) => p.spec_status !== "ok")
    .map((p) => ({
      asin: p.asin,
      title: p.title,
      reason: p.spec_status || "filtered",
    }));

  if (eligible.length === 0) {
    return { metric: null, top_3: [], skipped, reason: "no eligible products" };
  }

  // Deterministic metric ladder — no LLM round-trip for the common case.
  // Prefer the most meaningful normalization the data supports:
  //   €/kg-active  (best — true cost of pH-lowering power)
  //   €/L or €/kg  (package-normalized)
  //   €            (raw price fallback)
  const withActive = eligible.filter((p) => p.active_kg && p.current_price_eur).length;
  const withSize = eligible.filter(
    (p) => (p.package_size_l || p.package_size_kg) && p.current_price_eur,
  ).length;
  const half = Math.ceil(eligible.length / 2);

  let metric;
  if (withActive >= half) {
    metric = {
      metric_id: "eur_per_kg_active",
      formula_human: "price ÷ kg of active compound (concentration-adjusted)",
      formula_js: "p.active_kg ? p.current_price_eur / p.active_kg : Number.POSITIVE_INFINITY",
    };
  } else if (withSize >= half) {
    metric = {
      metric_id: "eur_per_unit",
      formula_human: "price ÷ package size (L for liquids, kg for solids)",
      formula_js:
        "(p.package_size_l || p.package_size_kg) ? p.current_price_eur / (p.package_size_l || p.package_size_kg) : Number.POSITIVE_INFINITY",
    };
  } else {
    metric = {
      metric_id: "price_eur",
      formula_human: "raw price (insufficient spec data)",
      formula_js: "p.current_price_eur",
    };
  }

  // Refund-protection tier (module-level `refundTier`, exported above so
  // AmazonAdapter reuses the identical tiering).

  // Primary sort: normalized metric (cheapest pH-lowering power).
  // Tie-break: when two products are within 10% on the metric, prefer the
  // higher refund tier — protected value beats a marginally-cheaper risk.
  const scored = eligible
    .map((p) => ({
      ...p,
      normalized_metric: safeApplyFormula(metric.formula_js, p),
      refund_tier: refundTier(p),
    }))
    .sort((a, b) => {
      const am = a.normalized_metric,
        bm = b.normalized_metric;
      const within10 = Math.abs(am - bm) <= 0.1 * Math.min(am, bm);
      if (within10 && a.refund_tier !== b.refund_tier) return b.refund_tier - a.refund_tier;
      return am - bm;
    });

  const tierLabel = {
    2: "sold by Amazon (instant refund)",
    1: "3rd-party (A-to-z covered)",
    0: "out of stock / unverified seller",
  };
  const top_3 = scored.slice(0, 3).map((p, i) => {
    const size = p.package_size_l
      ? `${p.package_size_l}L`
      : p.package_size_kg
        ? `${p.package_size_kg}kg`
        : "?";
    const conc = p.concentration_pct ? ` @ ${p.concentration_pct}%` : "";
    const unit =
      metric.metric_id === "eur_per_kg_active"
        ? "€/kg-active"
        : metric.metric_id === "eur_per_unit"
          ? "€/unit"
          : "€";
    return {
      asin: p.asin,
      title: p.title,
      url: p.url,
      current_price_eur: p.current_price_eur,
      package_size_kg: p.package_size_kg,
      package_size_l: p.package_size_l,
      active_ingredient: p.active_ingredient,
      concentration_pct: p.concentration_pct,
      form: p.form,
      seller_name: p.seller_name,
      refund_tier: p.refund_tier,
      refund_protection: tierLabel[p.refund_tier],
      normalized_metric_value: Number.isFinite(p.normalized_metric)
        ? Number(p.normalized_metric.toFixed(3))
        : null,
      rank_position: i + 1,
      reasoning_sentence: `${p.title?.slice(0, 60)}: €${p.current_price_eur} for ${size}${conc} → ${Number.isFinite(p.normalized_metric) ? p.normalized_metric.toFixed(2) : "?"} ${unit} · ${tierLabel[p.refund_tier]}`,
    };
  });

  // Products whose concentration is a form-default ASSUMPTION (no brand-table
  // hit, no explicit % in title/detail). These are the candidates for a
  // parallel brand-research subagent — the agent should confirm the real
  // concentration from the brand's online presence and write it back via
  // `amazon-shopper set-spec`, then re-rank. Scoped to the ranked set so we
  // don't fan out subagents for products nobody is considering.
  const rankedAsins = new Set(scored.slice(0, 3).map((p) => p.asin));
  const needs_concentration_research = scored
    .filter(
      (p) =>
        rankedAsins.has(p.asin) &&
        typeof p.spec_source === "string" &&
        p.spec_source.includes("form-default"),
    )
    .map((p) => ({
      asin: p.asin,
      title: p.title,
      form: p.form,
      assumed_concentration_pct: p.concentration_pct,
      assumed_active_ingredient: p.active_ingredient,
      reason: "concentration is a per-form default, not a confirmed brand value",
    }));

  return { metric, top_3, skipped, needs_concentration_research };
}
