import { lookupConcentration } from "./brand-concentrations.mjs";
import { createFetcher } from "./fetch.mjs";
import { analyzeProductImage } from "./image-spec.mjs";
// research.mjs — research ladder:
//   title-parse → product image → amazon-detail → [producer-site → web-search] → bail.
//
// The two bracketed rungs leave Amazon. They guess a producer domain from the
// brand name and run a DuckDuckGo query built from the product title, which
// means the user's shopping interest is disclosed to third parties the skill
// never named. That is broader than "shop on amazon.es", so since 1.2.0 those
// rungs are OFF unless the caller opts in (AMAZON_SHOPPER_ALLOW_WEB_RESEARCH=1,
// or allowWebResearch:true). With them off the ladder simply reports
// spec_unknown, which is the honest answer.
//
// When they ARE enabled they run on a SEPARATE fetcher from the Amazon one, so
// off-Amazon requests start from an empty cookie jar.
import { callLLM } from "./llm.mjs";
import { parseSpecFromTitle, activeKg } from "./title-spec.mjs";

const CONFIDENCE_THRESHOLD = 0.6;
// Title parse qualifies at 0.5 — form + active ingredient (no size) is still
// useful for filtering even when €/kg-active can't be computed.
const TITLE_CONFIDENCE_THRESHOLD = 0.5;

const EXTRACT_SYSTEM = `\
You extract a structured product spec from raw product-page text.

Return ONLY this JSON:
{
  "active_ingredient": "<canonical English name or null>",
  "concentration_pct": <number 0-100 or null>,
  "package_size_kg": <number or null>,
  "confidence": <0..1, how confident you are in the extraction>
}

If the page doesn't clearly state the spec, set confidence low (<0.5).`;

async function extractSpec(text, call_site) {
  const r = await callLLM({
    call_site,
    system: EXTRACT_SYSTEM,
    user: `Product text:\n\n${text.slice(0, 4000)}`,
  });
  return {
    active_ingredient: r.active_ingredient ?? null,
    concentration_pct: r.concentration_pct ?? null,
    package_size_kg: r.package_size_kg ?? null,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
  };
}

function guessProducerUrl(brand) {
  if (!brand) return null;
  const slug = brand
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9-]/g, "");
  if (!slug) return null;
  return `https://www.${slug}.es/`;
}

async function fetchProducer(brand, fetcher) {
  const url = guessProducerUrl(brand);
  if (!url) return null;
  try {
    const r = await fetcher.get(url);
    if (r.outcome !== "OK") return null;
    return { url, body: r.body };
  } catch {
    return null;
  }
}

async function ddgSearch(query, fetcher) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const r = await fetcher.get(url);
    if (r.outcome !== "OK") return [];
    const links = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.body)) !== null && links.length < 3) {
      const u = m[1].startsWith("//duckduckgo.com/l/?")
        ? decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || "")
        : m[1];
      if (u && /^https?:/.test(u)) links.push(u);
    }
    return links;
  } catch {
    return [];
  }
}

export async function researchProduct({
  product,
  detailSpec,
  fetcher,
  logger = null,
  allowWebResearch = process.env.AMAZON_SHOPPER_ALLOW_WEB_RESEARCH === "1",
  webFetcher = null,
}) {
  const log = (step, outcome, url, notes) => logger && logger(product, step, outcome, url, notes);

  // Step 0: parse the product title directly — fast, free, no LLM round-trip.
  // Pool-chemical titles carry size/concentration/form/ingredient inline.
  const titleSpec = parseSpecFromTitle(product.title || detailSpec.title || "");
  if (titleSpec.confidence >= TITLE_CONFIDENCE_THRESHOLD) {
    // Title gave us a form but no concentration (e.g. "CONTROL GARDEN Granulado
    // 10 KG" — no ingredient, no %). Resolve it from the brand-concentration
    // table, falling back to a generic per-form default. This is what makes
    // €/kg-active computable across powder vs liquid. A form-default value is an
    // ASSUMPTION: we tag spec_source `title:form-default` and needs_concentration
    // so the agent can confirm it with a parallel brand-research subagent.
    let { active_ingredient, concentration_pct } = titleSpec;
    let spec_source = "title";
    let needs_concentration = false;
    if (concentration_pct == null && titleSpec.form) {
      const looked = lookupConcentration({
        brand: product.brand_hint || detailSpec.brand,
        form: titleSpec.form,
        title: product.title || detailSpec.title,
      });
      if (looked) {
        concentration_pct = looked.concentration_pct;
        active_ingredient = active_ingredient || looked.active_ingredient;
        spec_source = `title:${looked.concentration_source}`;
        needs_concentration = looked.needs_concentration;
      }
    }
    const enriched = { ...titleSpec, active_ingredient, concentration_pct };
    log(
      "title",
      "ok",
      null,
      `conf=${titleSpec.confidence} conc=${concentration_pct ?? "?"} src=${spec_source}`,
    );
    return {
      active_ingredient,
      concentration_pct,
      package_size_kg: titleSpec.package_size_kg,
      package_size_l: titleSpec.package_size_l,
      active_kg: activeKg(enriched),
      form: titleSpec.form,
      confidence: titleSpec.confidence,
      spec_status: "ok",
      spec_source,
      needs_concentration,
    };
  }
  log("title", "insufficient", null, `conf=${titleSpec.confidence}`);

  // Step 0.5: read the product IMAGE. Pool-chemical packshots print volume /
  // weight / concentration / dimensions on the label even when the title and
  // text description omit them (field observation, 2026-05-29). Gated to
  // low-confidence products only, so it's at most one vision call per ranked
  // item. Merge title hints (form/ingredient) with image-read numbers.
  if (product.image_url) {
    const img = await analyzeProductImage(product.image_url);
    if (img) {
      const merged = {
        active_ingredient: img.active_ingredient ?? titleSpec.active_ingredient,
        concentration_pct: img.concentration_pct ?? titleSpec.concentration_pct,
        package_size_kg: img.package_size_kg ?? titleSpec.package_size_kg,
        package_size_l: img.package_size_l ?? titleSpec.package_size_l,
        form: img.form ?? titleSpec.form,
        dimensions_cm: img.dimensions_cm ?? null,
      };
      log("image", "ok", product.image_url, `conf=${img.confidence}`);
      return {
        ...merged,
        active_kg: activeKg(merged),
        confidence: img.confidence,
        spec_status: "ok",
        spec_source: "image",
      };
    }
    log("image", "insufficient", product.image_url, null);
  }

  let r = await extractSpec(detailSpec.combined_text || "", "extract_spec");
  log(
    "amazon",
    r.confidence >= CONFIDENCE_THRESHOLD ? "ok" : "insufficient",
    null,
    `conf=${r.confidence}`,
  );
  if (r.confidence >= CONFIDENCE_THRESHOLD) {
    return { ...r, spec_status: "ok", spec_source: "amazon" };
  }

  if (!allowWebResearch) {
    // Everything below this point leaves amazon.es. Opt-in only.
    log(
      "offamazon",
      "disabled",
      null,
      "set AMAZON_SHOPPER_ALLOW_WEB_RESEARCH=1 to search outside Amazon",
    );
    return { ...r, spec_status: "spec_unknown", spec_source: null };
  }

  // A fetcher of its own: off-Amazon requests never inherit the Amazon jar.
  const web = webFetcher || createFetcher();

  const brand = product.brand_hint || detailSpec.brand || null;
  if (brand) {
    const p = await fetchProducer(brand, web);
    if (p) {
      r = await extractSpec(p.body.slice(0, 8000), "extract_spec_producer");
      log(
        "producer",
        r.confidence >= CONFIDENCE_THRESHOLD ? "ok" : "insufficient",
        p.url,
        `conf=${r.confidence}`,
      );
      if (r.confidence >= CONFIDENCE_THRESHOLD) {
        return { ...r, spec_status: "ok", spec_source: "producer" };
      }
    } else {
      log("producer", "404", guessProducerUrl(brand), null);
    }
  }

  const query = `${brand || ""} ${product.title} ficha técnica`.trim();
  const links = await ddgSearch(query, web);
  for (const link of links.slice(0, 2)) {
    try {
      const w = await web.get(link);
      if (w.outcome !== "OK") {
        log("web", "blocked", link, w.reason);
        continue;
      }
      r = await extractSpec(w.body.slice(0, 8000), "extract_spec_web");
      log(
        "web",
        r.confidence >= CONFIDENCE_THRESHOLD ? "ok" : "insufficient",
        link,
        `conf=${r.confidence}`,
      );
      if (r.confidence >= CONFIDENCE_THRESHOLD) {
        return { ...r, spec_status: "ok", spec_source: "web" };
      }
    } catch (e) {
      log("web", "error", link, e.message);
    }
  }

  log("bail", "spec_unknown", null, `final_conf=${r.confidence}`);
  return { ...r, spec_status: "spec_unknown", spec_source: null };
}
