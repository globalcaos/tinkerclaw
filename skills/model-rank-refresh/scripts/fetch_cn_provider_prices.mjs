#!/usr/bin/env node
// Regenerate the Chinese-model × supplier price matrix rendered at the foot of the
// SMART MODELS dossier.
//
// WHAT QUESTION THIS ANSWERS (the architect, 2026-08-15, widened 2026-09-23): "which supplier
// of Chinese models charges less" — including OpenRouter itself, and covering every
// frontier Chinese lab, not just the handful we happen to have configured.
//
// WHY IT IS GENERATED AND NEVER TYPED: OpenRouter routes each model to many hosts at
// very different prices, and the default route is not always the cheapest. Two of five
// prices moved within 48 hours in August 2026 (glm-5.2 -27%, deepseek-v4-flash +56%),
// so ANY hand-copied figure here is wrong within days. This script is the only
// sanctioned way to update the matrix — never edit the generated file by hand.
//
// THREE PRICES PER MODEL, because they answer three different purchase decisions:
//   providers[*]  — every host OpenRouter can route to, cheapest tier per host.
//   providers[lab]— the lab's own first-party endpoint ("lab direct").
//   openrouter    — what you pay calling `openrouter/<slug>` and letting OpenRouter
//                   pick: its DEFAULT route, from the catalog's own `pricing` block.
//                   NOT always the cheapest host — that gap is the point of the table.
//
// ROSTER IS DERIVED, NOT LISTED (2026-09-23): the labs are pinned by namespace, the
// MODELS are read out of the live catalog by recency + price rank, so a new Chinese
// flagship lands in the table on the next cron run with no human edit. PINS and DROPS
// are the two escape hatches, each with its reason written next to it.
//
// Output: tinker-ui/src/panels/cn-provider-prices.generated.ts  (a TS data module the
// dossier imports). Same pattern the AA intelligence index already uses: a baked
// constant, refreshed by cron, never typed by a human.
//
// Run:  node fetch_cn_provider_prices.mjs [--out <path>] [--json]
// Cron: invoked by the model-rank-refresh brief (daily 06:30).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Chinese labs, in the order their rows appear ──────────────────────────────
// [namespace, display name, host name on OpenRouter].
// The third entry exists because a lab's own endpoint is NOT always listed under the
// lab's name — ByteDance sells as "Seed" — and without it the "lab direct" column goes
// silently empty for that lab, which reads as "the lab does not sell it" rather than
// "we looked under the wrong name". Omit it when the two match.
// Adding a namespace here is the ONLY edit needed when a new Chinese lab shows up on
// OpenRouter; its flagship is then discovered by price rank on the next run.
const CN_LABS = [
  ["qwen", "Alibaba"],
  ["z-ai", "Z.AI"],
  ["deepseek", "DeepSeek"],
  ["moonshotai", "Moonshot AI"],
  ["minimax", "MiniMax"],
  ["xiaomi", "Xiaomi"],
  ["tencent", "Tencent"],
  ["bytedance-seed", "ByteDance", "Seed"],
  ["stepfun", "StepFun"],
  ["meituan", "Meituan"],
  ["inclusionai", "Ant (inclusionAI)"],
];
const HOST_OF_LAB = new Map(CN_LABS.map(([, name, host]) => [name, host ?? name]));

// PINS — always in the table, whatever the auto-derivation picks. Each needs a reason.
const PINS = {
  "qwen/qwen3.8-2.4t-a95b":
    "open-weights giant: the widest multi-host spread in the table, which is the question",
  "deepseek/deepseek-v4.1-flash": "a configured model on our own picker",
  // 2026-10-03: the flagship rule follows the lab's newest generation, and DeepSeek's
  // newest is V4.1 Flash. V4 Pro (AA 36.0) is the lab's strongest and was the flagship
  // under the old rule, so it stays — the table's job is the best models, and a rule
  // change must not quietly drop one.
  "deepseek/deepseek-v4-pro-0813":
    "DeepSeek's strongest model; the newest-generation rule would keep only V4.1 Flash",
  "moonshotai/kimi-k2.7-code": "Kimi's only cheap route; K3 has no sibling in its own family",
  "tencent/hy3": "a configured model, and the price reference HY4 is measured against",
};

// DROPS — eligible by the rules but wrong for THIS table. Each needs a reason.
const DROPS = {
  "xiaomi/mimo-v2.6-pro-ultraspeed":
    "a latency tier of MiMo V2.6 Pro, not a different model — it would take Pro's row",
  "bytedance-seed/seed-2.0-code":
    "code specialist; the table ranks general flagships, and it would displace Seed 2.1 Turbo",
};

// Never eligible: free/batch aliases, translation and GUI-agent specialists, vision-only
// and vertical-domain variants, tiny ctx. This table ranks GENERAL flagships, and a
// vertical variant is usually priced ABOVE the general model — so without this it wins
// the flagship slot on the price rule and misrepresents the lab (inclusionAI's
// finance-tuned Ling was doing exactly that on 2026-09-23). PINS bypass this list.
const DENY = [
  /:free$/,
  /:batch$/,
  /(^|[/-])mt\d*-/,
  /ui-tars/,
  /(^|-)vl($|-)/,
  /-(fin|sante|health|legal|med)$/,
  // 2026-10-02: a `-prime` slug is a premium SERVING tier of the same weights (Alibaba's
  // fast lane, $2.8/$8.8 for GLM-5.3 — the same price as the `alibaba/fast` endpoint of
  // plain glm-5.3). Being the dearest, it won the flagship slot and pushed the real model
  // out: GLM-5.3, with 38 sellers, and Qwen3.8-Max both vanished from the table. Same
  // reason MiMo's `-ultraspeed` sits in DROPS.
  /-prime$/,
];
const MIN_CTX = 32_000;

// A model counts as "current" for its lab if it shipped within this many days of that
// lab's newest surviving model. Wide enough that a lab with a slow cadence still gets
// a flagship; narrow enough that last year's generation cannot win the row.
//
// 180, not 75 (2026-10-03). OpenRouter's `created` is NOT a release date: on that day
// MiniMax-M3, the current flagship of its lab (AA 29.22), carried a `created` six months
// in the future, and Kimi K3 (AA 43.59, 5th-best Chinese model) sat at 79 days — four
// days past the old window, so the next nightly run would have dropped it. A window that
// trusts a field that lies drops the best models, which is the complaint that prompted
// this. 180 days still excludes last year's generation.
//
// Widening it has a cost the flagship rule has to absorb: a lab's previous generation can
// now sit inside the window and, being priced higher per token, win the "dearest" slot.
// On 2026-10-03 that made Qwen3.6 Max Preview the Alibaba flagship and pushed out
// Qwen3.8 Max, Alibaba's actual best (AA 45.42, 2nd-best Chinese model). So the flagship
// is the dearest model of the lab's NEWEST generation, not the dearest in the window.
const RECENCY_DAYS = 180;
// The table has to stay readable at a glance. LAB_ONLY rows are appended after the
// derived ones, so they count against the same budget — otherwise every lab added by
// hand quietly widens the table past the point it can be read.
// 20, not 18 (2026-10-03). The table gained two rows it was wrong to omit — MiniMax M3
// and Step 5 Preview — and 18 made that a trade: GLM 5.3 Flash, the cheapest GLM, fell
// off the bottom. The table scrolls sideways already, so two more rows cost nothing.
const MAX_ROWS = 20;

// Labs whose current flagship is NOT sold on OpenRouter. Price comes from the lab's own
// page, FETCHED here — never typed into the TS. If the fetch fails the row still ships,
// marked as unpriced with the URL and date, because a silent omission would misrepresent
// the field and an invented number would be worse.
const LAB_ONLY = [
  {
    id: "baidu/ernie-5.0",
    lab: "Baidu",
    label: "ERNIE 5.0",
    url: "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7",
    note: "Baidu sells ERNIE 5.0 only through Qianfan; OpenRouter carries just the 2025 ERNIE 4.5 VL.",
    // Qianfan renders its price table client-side, so this regex is a best effort over
    // the served HTML. No match ⇒ the row says so rather than carrying a guess.
    match: /ERNIE[-\s]?5\.0[^<]{0,80}?([\d.]+)\s*元\s*\/\s*千\s*tokens/i,
  },
  {
    // 2026-10-03 (the architect: "the best chinese models are not in the chinese models cost
    // table"). Step 5 Preview is AA 43.73 — 4th of all Chinese models that day, above
    // Kimi K3 and DeepSeek V4.1 — and OpenRouter sells none of it, only Step 3.7 Flash
    // (AA 24.9, the lab's cheap tier). StepFun's own page prices it in USD, so the row
    // carries a real figure rather than the CNY best-effort the ERNIE row uses.
    id: "stepfun/step-5-preview",
    lab: "StepFun",
    label: "Step 5 Preview",
    url: "https://platform.stepfun.ai/docs/en/guides/pricing/details",
    note: "StepFun's best model (AA 43.73, 4th-best Chinese); OpenRouter only carries Step 3.7 Flash.",
    unit: "usd",
    // The row reads: model, unit, cache-miss input, cache-hit input, output, each in
    // its own table cell (~115 chars apart). The cache-hit figure ($0.05) sits between
    // the two that matter, so skip one dollar amount and take the first and the third:
    // input $1.00, output $2.70.
    match:
      /step-5-preview[\s\S]{0,400}?\$([\d.]+)(?:[\s\S]{0,160}?\$[\d.]+)[\s\S]{0,160}?\$([\d.]+)/i,
  },
];

// Flat-fee plans, the only thing that competes with a Max-style subscription.
// VERIFIED against vendor pages; entries we could NOT confirm first-party are marked
// unconfirmed so the UI can render them as such rather than as fact.
const SUBSCRIPTIONS = {
  "Z.AI": { plan: "GLM Coding Plan", from: 18, currency: "USD", confirmed: true },
  "Moonshot AI": { plan: "Kimi Code", from: 19, currency: "USD", confirmed: true },
  MiniMax: { plan: "MiniMax Coding Plan", from: 49, currency: "USD", confirmed: false },
  Alibaba: { plan: "Qwen Token Plan", from: 6, currency: "USD", confirmed: false },
  DeepSeek: null, // pay-per-use only, consistent across sources
};

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const FEE_URL = "https://openrouter.ai/docs/faq.md";

// ── SELLERS YOU CAN PAY WITHOUT OPENROUTER (the architect, 2026-10-02) ───────────────────
// "Our BBVA has blocked openrouter as supplier ... do a deep dive on other online
// suppliers of chinese models, and find the cheapest." The host prices OpenRouter shows
// are NOT always what the same host charges you directly: on 2026-10-02 Novita sold
// GLM-5.3 at $2.156 out THROUGH OpenRouter and $4.40 on its own API, SiliconFlow
// likewise. So a direct price has to come from the seller's own list, never be inferred
// from the OpenRouter row.
//
// Only sellers with a PUBLIC, machine-readable price list are here, so the column is
// regenerated every night like the rest of the table. A seller whose list fails to load
// is reported in `errors` and simply missing from that night's column; the OpenRouter
// half of the table is never held hostage to it.
//
// Matching is by the model's own name (the part after the last "/"), case-folded:
// "xiaomi/mimo-v2.6-pro" = "XiaomiMiMo/MiMo-V2.6-Pro". Exact name only, so `-uncensored`,
// `-p` or `-fast` variants never stand in for the model, and neither does an undated
// sibling: dropping the date matched `deepseek-v4-pro-0813` to the older `deepseek-v4-pro`,
// which OpenRouter lists as a separate model (first dry run, 2026-10-02).
const DIRECT_SOURCES = [
  {
    name: "DeepInfra",
    url: "https://api.deepinfra.com/models/list",
    rows: (body) =>
      (Array.isArray(body) ? body : [])
        .filter((m) => m?.pricing?.type === "tokens" && m.pricing.cents_per_output_token)
        .map((m) => {
          // cents per token, before DeepInfra's own standing discount (a fraction off)
          const k = 1e4 * (1 - (m.pricing.discount ?? 0));
          const input = m.pricing.cents_per_input_token * k;
          const cached = m.pricing.rate_per_input_token_cached;
          return {
            id: m.model_name,
            in: input,
            out: m.pricing.cents_per_output_token * k,
            cacheRead: cached ? input * cached : null,
            quant: m.quantization || "unknown",
          };
        }),
  },
  {
    name: "Novita",
    url: "https://api.novita.ai/v3/openai/models",
    // prices are in 1/10,000 USD per million tokens (14000 = $1.40)
    rows: (body) =>
      (body?.data ?? [])
        .filter((m) => m.output_token_price_per_m)
        .map((m) => ({
          id: m.id,
          in: m.input_token_price_per_m / 1e4,
          out: m.output_token_price_per_m / 1e4,
          cacheRead: null,
          quant: "unknown",
        })),
  },
  {
    name: "Vercel AI Gateway",
    url: "https://ai-gateway.vercel.sh/v1/models",
    // USD per token, as strings; Vercel resells at the lab's list price
    rows: (body) =>
      (body?.data ?? [])
        .filter((m) => m?.pricing?.output)
        .map((m) => ({
          id: m.id,
          in: Number(m.pricing.input) * 1e6,
          out: Number(m.pricing.output) * 1e6,
          cacheRead: m.pricing.input_cache_read ? Number(m.pricing.input_cache_read) * 1e6 : null,
          quant: "unknown",
        })),
  },
  {
    name: "NanoGPT",
    url: "https://nano-gpt.com/api/v1/models?detailed=true",
    rows: (body) =>
      (body?.data ?? [])
        .filter((m) => m?.pricing?.unit === "per_million_tokens" && m.pricing.completion)
        .map((m) => ({
          id: m.id,
          in: Number(m.pricing.prompt),
          out: Number(m.pricing.completion),
          cacheRead:
            m.pricing.cacheReadInputPer1kTokens != null
              ? m.pricing.cacheReadInputPer1kTokens * 1e3
              : null,
          quant: "unknown",
        })),
  },
];
// A list shorter than this is a partial or changed response, not a catalogue.
const MIN_DIRECT_LIST = 50;

export function directKey(id) {
  return String(id).toLowerCase().split("/").pop().split(":")[0];
}

// Per model: every direct seller that lists it, each at its cheapest matching row, and
// the cheapest of them. Pure, so the matching rule is unit-tested without the network.
export function directPricesFor(orId, lists) {
  const key = directKey(orId);
  const sellers = {};
  for (const [seller, rows] of Object.entries(lists)) {
    for (const r of rows) {
      if (!(r.out > 0) || directKey(r.id) !== key) continue;
      const cur = sellers[seller];
      if (!cur || r.out < cur.out) {
        sellers[seller] = {
          in: r.in,
          out: r.out,
          cacheRead: r.cacheRead,
          quant: r.quant,
          id: r.id,
        };
      }
    }
  }
  const sorted = Object.entries(sellers).sort((a, b) => a[1].out - b[1].out);
  return {
    sellers: Object.fromEntries(sorted),
    cheapest: sorted.length
      ? { seller: sorted[0][0], out: sorted[0][1].out, in: sorted[0][1].in }
      : null,
  };
}

async function loadDirectLists(errors) {
  const lists = {};
  const sources = [];
  for (const src of DIRECT_SOURCES) {
    const checkedAt = new Date().toISOString();
    try {
      const rows = src.rows(await getJson(src.url));
      if (rows.length < MIN_DIRECT_LIST) {
        throw new Error(`only ${rows.length} priced models (< ${MIN_DIRECT_LIST})`);
      }
      lists[src.name] = rows;
      sources.push({ name: src.name, url: src.url, models: rows.length, checkedAt, error: null });
    } catch (err) {
      const msg = String(err.message || err);
      errors.push(`direct seller ${src.name}: ${msg}`);
      sources.push({ name: src.name, url: src.url, models: 0, checkedAt, error: msg });
    }
  }
  return { lists, sources };
}

// Fail-closed floors. A half-empty fetch must never overwrite a good table with a
// plausible-looking smaller one — that is the silent-corruption mode this guards.
const MIN_CATALOG = 200;
const MIN_ROSTER = 12;
const MIN_PRICED = 10;

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const perM = (v) => (v === undefined || v === null || v === "" ? null : Number(v) * 1e6);

const getJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

// ── roster derivation ─────────────────────────────────────────────────────────

// The family of a slug is its name up to and including the version token:
//   qwen3.8-max-0902 → qwen3.8   ·   glm-5.3-flash → glm-5.3   ·   kimi-k3 → kimi-k3
// Used to find a flagship's CHEAP SIBLING without wandering into last year's
// generation, which a bare "cheapest recent model" rule does.
export function familyOf(slug) {
  const base = slug.replace(/-\d{4}$/, "").replace(/-\d{2}-\d{2}$/, "");
  const parts = base.split("-");
  let cut = parts.findIndex((p) => /\d+\.\d+/.test(p));
  if (cut < 0) cut = parts.findIndex((p) => /\d/.test(p));
  if (cut < 0) cut = 0;
  return parts.slice(0, cut + 1).join("-");
}

const eligible = (m) => {
  const slug = m.id.split("/").slice(1).join("/");
  if (DROPS[m.id]) return false;
  if (DENY.some((re) => re.test(m.id) || re.test(slug))) return false;
  if ((m.context_length ?? 0) < MIN_CTX) return false;
  const out = perM(m?.pricing?.completion);
  // $0 is a promo or a preview, not a price. It can never be the dearest, but it was
  // winning the cheap-sibling row (inclusionAI's Ling 3.1 Flash on 2026-10-03).
  return out !== null && out > 0;
};

// Per lab: the flagship is the DEAREST current model (labs charge most for their best),
// and the cheap sibling is the cheapest model in the flagship's own family.
export function deriveRoster(catalog, cap = MAX_ROWS - LAB_ONLY.length) {
  const byNs = new Map();
  for (const m of catalog) {
    if (!eligible(m)) continue;
    const ns = m.id.split("/")[0];
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(m);
  }
  const flagships = [];
  const siblings = [];
  for (const [ns, labName] of CN_LABS) {
    const rows = byNs.get(ns);
    if (!rows?.length) continue;
    const newest = Math.max(...rows.map((m) => m.created ?? 0));
    const window = rows.filter((m) => (m.created ?? 0) >= newest - RECENCY_DAYS * 86400);
    if (!window.length) continue;
    // The flagship comes from the newest generation only. `familyOf` yields the
    // generation ("qwen3.8", "glm-5.3"), and the most recently shipped family in the
    // window is the current one. An older family priced higher per token must not
    // take the row — see RECENCY_DAYS above.
    const newestFamily = familyOf(
      [...window]
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]
        .id.split("/")
        .slice(1)
        .join("/"),
    );
    const generation = window.filter(
      (m) => familyOf(m.id.split("/").slice(1).join("/")) === newestFamily,
    );
    const byPrice = [...generation].sort(
      (a, b) =>
        perM(b.pricing.completion) - perM(a.pricing.completion) ||
        (b.created ?? 0) - (a.created ?? 0),
    );
    const flag = byPrice[0];
    flagships.push({ id: flag.id, lab: labName, ns, why: "flagship: dearest current model" });
    const fam = familyOf(flag.id.split("/").slice(1).join("/"));
    const kin = window
      .filter((m) => m.id !== flag.id)
      .filter((m) => familyOf(m.id.split("/").slice(1).join("/")) === fam)
      // cheapest wins; ties go to the plainest name, so `…-flash` beats `…-omni-flash`
      .sort(
        (a, b) =>
          perM(a.pricing.completion) - perM(b.pricing.completion) || a.id.length - b.id.length,
      );
    if (kin[0]) {
      siblings.push({ id: kin[0].id, lab: labName, ns, why: "cheap sibling of the flagship" });
    }
  }
  // Pins may name a model any rule would have skipped, so resolve them against the
  // catalog and carry their reason into the generated file.
  const pinned = [];
  for (const [id, why] of Object.entries(PINS)) {
    const m = catalog.find((c) => c.id === id);
    if (!m) continue;
    const ns = id.split("/")[0];
    const lab = CN_LABS.find(([n]) => n === ns)?.[1] ?? null;
    pinned.push({ id, lab, ns, why: `pinned — ${why}` });
  }
  // Priority: every lab's flagship first (so no lab is missing), then the pins, then
  // cheap siblings until the table is full.
  const out = [];
  const seen = new Set();
  for (const group of [flagships, pinned, siblings]) {
    for (const r of group) {
      if (seen.has(r.id) || out.length >= cap) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  const order = new Map(CN_LABS.map(([ns], i) => [ns, i]));
  out.sort((a, b) => (order.get(a.ns) ?? 99) - (order.get(b.ns) ?? 99));
  return out;
}

// ── per-model endpoint prices (unchanged contract) ────────────────────────────
async function endpointsFor(id) {
  const body = await getJson(`https://openrouter.ai/api/v1/models/${id}/endpoints`);
  const d = body?.data;
  if (!d) throw new Error(`${id}: no data`);
  const byProvider = new Map();
  for (const e of d.endpoints ?? []) {
    const out = perM(e?.pricing?.completion);
    if (out === null) continue;
    const name = e.provider_name || "?";
    const row = {
      out,
      in: perM(e?.pricing?.prompt) ?? 0,
      cacheRead: perM(e?.pricing?.input_cache_read),
      quant: e.quantization || "unknown",
      ctx: e.context_length || 0,
    };
    // A provider may list several tiers; keep its CHEAPEST so the matrix compares
    // best-available against best-available.
    const cur = byProvider.get(name);
    if (!cur || row.out < cur.out) byProvider.set(name, row);
  }
  return Object.fromEntries([...byProvider].sort((a, b) => a[1].out - b[1].out));
}

// OpenRouter's own credit-purchase fee, read off its FAQ source rather than typed —
// the number has moved before and a stale "5%" in a tooltip is a lie with a date on it.
async function openrouterFee() {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(FEE_URL, { headers: { Accept: "text/plain" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    const card = txt.match(/'stripe'\)\s*return\s*'([^']+)'/)?.[1] ?? null;
    const crypto = txt.match(/'coinbase'\)\s*return\s*'([^']+)'/)?.[1] ?? null;
    if (!card) throw new Error("fee literal not found in FAQ source");
    return { card, crypto, source: FEE_URL, checkedAt, error: null };
  } catch (err) {
    return {
      card: null,
      crypto: null,
      source: FEE_URL,
      checkedAt,
      error: String(err.message || err),
    };
  }
}

async function labOnlyRow(spec) {
  const checkedAt = new Date().toISOString();
  const blank = { cny1k: null, usdIn: null, usdOut: null };
  try {
    const res = await fetch(spec.url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const hit = html.match(spec.match);
    if (!hit) throw new Error("price not present in served HTML (table is client-rendered)");
    // CNY per 1k tokens → USD per 1M tokens is a currency conversion we are not
    // sourcing here, so a CNY page publishes the vendor's own figure, unconverted.
    // A page that prices in USD (`spec.unit === "usd"`) gives input and output per
    // 1M tokens directly, so the row can be ranked alongside the OpenRouter rows.
    if (spec.unit === "usd") {
      return {
        ...blank,
        usdIn: Number(hit[1]),
        usdOut: Number(hit[2]),
        source: spec.url,
        checkedAt,
        error: null,
      };
    }
    return { ...blank, cny1k: Number(hit[1]), source: spec.url, checkedAt, error: null };
  } catch (err) {
    return { ...blank, source: spec.url, checkedAt, error: String(err.message || err) };
  }
}

const main = async () => {
  const errors = [];

  const catalogBody = await getJson(CATALOG_URL);
  const catalog = catalogBody?.data ?? [];
  if (catalog.length < MIN_CATALOG) {
    throw new Error(
      `catalog returned ${catalog.length} models (< ${MIN_CATALOG}) — refusing to overwrite the table from a partial fetch`,
    );
  }

  const roster = deriveRoster(catalog);
  if (roster.length < MIN_ROSTER) {
    throw new Error(
      `derived only ${roster.length} models (< ${MIN_ROSTER}) — refusing to overwrite the table`,
    );
  }

  const fee = await openrouterFee();
  if (fee.error) errors.push(`openrouter fee: ${fee.error}`);

  const { lists: directLists, sources: directSources } = await loadDirectLists(errors);

  const models = {};
  for (const r of roster) {
    try {
      const providers = await endpointsFor(r.id);
      const entries = Object.entries(providers);
      if (!entries.length) {
        errors.push(`${r.id}: zero priced endpoints`);
        continue;
      }
      const cat = catalog.find((c) => c.id === r.id);
      const orOut = perM(cat?.pricing?.completion);
      const [bestProvider, best] = entries[0];
      // The lab's OWN endpoint among the hosts, resolved by its OpenRouter host name
      // rather than its display name — see HOST_OF_LAB.
      const labHost = r.lab ? (HOST_OF_LAB.get(r.lab) ?? r.lab) : null;
      models[r.id] = {
        lab: r.lab,
        labHost: labHost && providers[labHost] ? labHost : null,
        why: r.why,
        providers,
        // What `openrouter/<slug>` itself costs: OpenRouter's DEFAULT route.
        openrouter:
          orOut === null
            ? null
            : { out: orOut, in: perM(cat?.pricing?.prompt) ?? 0, ctx: cat?.context_length ?? 0 },
        cheapest: { provider: bestProvider, out: best.out, in: best.in, quant: best.quant },
        labDirect: null,
        direct: directPricesFor(r.id, directLists),
      };
    } catch (err) {
      errors.push(`${r.id}: ${String(err.message || err)}`);
    }
  }

  for (const spec of LAB_ONLY) {
    const direct = await labOnlyRow(spec);
    if (direct.error) errors.push(`${spec.id} (lab-direct): ${direct.error}`);
    // A lab that publishes a USD price gets a real row: its own price is both the
    // "lab direct" cell and the cheapest, so the table can rank it with the others.
    // A price we could not read stays an unpriced row — a dash beats a guess.
    const priced = direct.usdOut !== null && !direct.error;
    const self = priced
      ? { out: direct.usdOut, in: direct.usdIn ?? 0, cacheRead: null, quant: "unknown", ctx: 0 }
      : null;
    models[spec.id] = {
      lab: spec.lab,
      labHost: priced ? spec.lab : null,
      why: `not on OpenRouter — ${spec.note}`,
      providers: self ? { [spec.lab]: self } : {},
      openrouter: null,
      cheapest: self ? { provider: spec.lab, out: self.out, in: self.in, quant: "unknown" } : null,
      labDirect: direct,
      direct: directPricesFor(spec.id, directLists),
    };
  }

  const priced = Object.values(models).filter((m) => m.cheapest).length;
  if (priced < MIN_PRICED) {
    throw new Error(
      `only ${priced} models priced (< ${MIN_PRICED}) — refusing to overwrite the table`,
    );
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: "openrouter.ai/api/v1/models/{id}/endpoints",
    catalogSource: CATALOG_URL,
    unit: "USD per 1M tokens",
    note:
      "cheapest endpoint per host; `out` is the headline figure the dossier ranks on. " +
      "`openrouter` is OpenRouter's DEFAULT route for the slug, which is not always the cheapest host.",
    rosterRule:
      `derived from the live catalog: per Chinese lab namespace, the dearest model shipped within ${RECENCY_DAYS} days ` +
      `of that lab's newest, plus the cheapest model in the same family, capped at ${MAX_ROWS} rows including lab-direct-only labs; PINS and DROPS override.`,
    openrouterFee: fee,
    directSources,
    subscriptions: SUBSCRIPTIONS,
    models,
    errors,
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const out = resolve(
    arg(
      "--out",
      `${process.env.HOME}/src/tinkerclaw/tinker-ui/src/panels/cn-provider-prices.generated.ts`,
    ),
  );
  const banner =
    "// GENERATED FILE — DO NOT EDIT BY HAND.\n" +
    "// Regenerate: node ~/.openclaw/workspace/skills/model-rank-refresh/scripts/fetch_cn_provider_prices.mjs\n" +
    "// Refreshed daily by the model-rank-refresh cron (06:30). Prices move within DAYS:\n" +
    "// glm-5.2 fell 27% and deepseek-v4-flash rose 56% inside 48h in August 2026, so a\n" +
    "// hand-edited number here is wrong almost immediately. The ROSTER is derived from the\n" +
    "// live catalog too, so a new Chinese flagship appears here without a human edit.\n" +
    `// Fetched: ${payload.fetchedAt}\n\n`;
  const body =
    "export interface CnProviderRow {\n" +
    "  out: number;\n  in: number;\n  cacheRead: number | null;\n  quant: string;\n  ctx: number;\n}\n" +
    "export interface CnOpenRouterRoute {\n  out: number;\n  in: number;\n  ctx: number;\n}\n" +
    "export interface CnLabDirect {\n" +
    "  cny1k: number | null;\n" +
    "  /** USD per 1M tokens, when the lab's own page prices in dollars. */\n" +
    "  usdIn: number | null;\n  usdOut: number | null;\n" +
    "  source: string;\n  checkedAt: string;\n  error: string | null;\n}\n" +
    "export interface CnModelPrices {\n" +
    "  lab: string | null;\n" +
    "  labHost: string | null;\n" +
    "  why: string;\n" +
    "  providers: Record<string, CnProviderRow>;\n" +
    "  openrouter: CnOpenRouterRoute | null;\n" +
    "  cheapest: { provider: string; out: number; in: number; quant: string } | null;\n" +
    "  labDirect: CnLabDirect | null;\n" +
    "  /** Sellers you can pay WITHOUT OpenRouter, from their own public price lists. */\n" +
    "  direct?: CnDirect;\n" +
    "}\n" +
    "export interface CnDirectRow {\n" +
    "  in: number;\n  out: number;\n  cacheRead: number | null;\n  quant: string;\n  id: string;\n}\n" +
    "export interface CnDirect {\n" +
    "  sellers: Record<string, CnDirectRow>;\n" +
    "  cheapest: { seller: string; out: number; in: number } | null;\n}\n" +
    "export interface CnDirectSource {\n" +
    "  name: string;\n  url: string;\n  models: number;\n  checkedAt: string;\n  error: string | null;\n}\n" +
    "export interface CnSubscription {\n" +
    "  plan: string;\n  from: number;\n  currency: string;\n  confirmed: boolean;\n}\n" +
    "export interface CnOpenRouterFee {\n" +
    "  card: string | null;\n  crypto: string | null;\n  source: string;\n  checkedAt: string;\n  error: string | null;\n}\n" +
    "export interface CnProviderPrices {\n" +
    "  fetchedAt: string;\n  source: string;\n  catalogSource: string;\n  unit: string;\n" +
    "  note: string;\n  rosterRule: string;\n" +
    "  openrouterFee: CnOpenRouterFee;\n" +
    "  directSources?: CnDirectSource[];\n" +
    "  subscriptions: Record<string, CnSubscription | null>;\n" +
    "  models: Record<string, CnModelPrices>;\n  errors: string[];\n}\n\n" +
    `export const CN_PROVIDER_PRICES: CnProviderPrices = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync(out, banner + body, "utf8");
  const n = Object.keys(models).length;
  process.stdout.write(
    `wrote ${out}\n  models=${n}  priced=${priced}  errors=${errors.length}\n` +
      errors.map((e) => `  ! ${e}\n`).join(""),
  );
};

// `familyOf`/`deriveRoster` are exported for the unit tests; running as a script still
// regenerates, so the cron's invocation is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(String(err?.stack || err));
    process.exit(1);
  });
}
