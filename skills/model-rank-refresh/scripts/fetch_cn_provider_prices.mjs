#!/usr/bin/env node
// Regenerate the Chinese-model × provider price matrix rendered at the foot of the
// SMART MODELS dossier.
//
// WHY THIS EXISTS (the operator, 2026-08-15): OpenRouter routes each model to many providers
// at very different prices, and the default route is not always the cheapest. Two of
// five prices moved within 48 hours in August 2026 (glm-5.2 −27%, deepseek-v4-flash
// +56%), so ANY hand-copied figure here is wrong within days. This script is the only
// sanctioned way to update the matrix — never edit the generated file by hand.
//
// Output: tinker-ui/src/panels/cn-provider-prices.generated.ts  (a TS data module the
// dossier imports). Same pattern the AA intelligence index already uses: a baked
// constant, refreshed by cron, never typed by a human.
//
// Run:  node fetch_cn_provider_prices.mjs [--out <path>] [--json]
// Cron: invoked by the model-rank-refresh brief (daily 06:30).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The roster is derived from what we actually reach, plus the direct competitors a
// procurement question would ask about. Add a slug here when a model joins the panel.
const MODELS = [
  "qwen/qwen3.8-max-0902",
  "qwen/qwen3.8-2.4t-a95b",
  "qwen/qwen3.8-27b",
  "qwen/qwen3.7-max",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.2",
  "z-ai/glm-5.1",
  "z-ai/glm-5",
  "deepseek/deepseek-v4-pro-0813",
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-flash-vision-exp",
  "minimax/minimax-m3",
  "tencent/hy3",
  "xiaomi/mimo-v2.5-pro",
];

// Which provider IS the lab, per model namespace — so the UI can say "lab direct".
const LAB_OF = {
  moonshotai: "Moonshot AI",
  "z-ai": "Z.AI",
  deepseek: "DeepSeek",
  qwen: "Alibaba",
  minimax: "Minimax",
  tencent: "Tencent",
  xiaomi: "Xiaomi",
};

// Flat-fee plans, the only thing that competes with a Max-style subscription.
// VERIFIED against vendor pages; entries we could NOT confirm first-party are marked
// unconfirmed so the UI can render them as such rather than as fact.
const SUBSCRIPTIONS = {
  "Z.AI": { plan: "GLM Coding Plan", from: 18, currency: "USD", confirmed: true },
  "Moonshot AI": { plan: "Kimi Code", from: 19, currency: "USD", confirmed: true },
  Minimax: { plan: "MiniMax Coding Plan", from: 49, currency: "USD", confirmed: false },
  Alibaba: { plan: "Qwen Token Plan", from: 6, currency: "USD", confirmed: false },
  DeepSeek: null, // pay-per-use only, consistent across sources
};

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const perM = (v) => (v === undefined || v === null || v === "" ? null : Number(v) * 1e6);

async function endpointsFor(id) {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const body = await res.json();
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

const main = async () => {
  const models = {};
  const errors = [];
  for (const id of MODELS) {
    try {
      const providers = await endpointsFor(id);
      const entries = Object.entries(providers);
      if (!entries.length) {
        errors.push(`${id}: zero priced endpoints`);
        continue;
      }
      const [bestProvider, best] = entries[0];
      models[id] = {
        lab: LAB_OF[id.split("/")[0]] ?? null,
        providers,
        cheapest: { provider: bestProvider, out: best.out, in: best.in, quant: best.quant },
      };
    } catch (err) {
      errors.push(`${id}: ${String(err.message || err)}`);
    }
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: "openrouter.ai/api/v1/models/{id}/endpoints",
    unit: "USD per 1M tokens",
    note: "cheapest endpoint per provider; `out` is the headline figure the dossier ranks on",
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
    "// hand-edited number here is wrong almost immediately.\n" +
    `// Fetched: ${payload.fetchedAt}\n\n`;
  const body =
    "export interface CnProviderRow {\n" +
    "  out: number;\n  in: number;\n  cacheRead: number | null;\n  quant: string;\n  ctx: number;\n}\n" +
    "export interface CnModelPrices {\n" +
    "  lab: string | null;\n" +
    "  providers: Record<string, CnProviderRow>;\n" +
    "  cheapest: { provider: string; out: number; in: number; quant: string };\n" +
    "}\n" +
    "export interface CnSubscription {\n" +
    "  plan: string;\n  from: number;\n  currency: string;\n  confirmed: boolean;\n}\n" +
    "export interface CnProviderPrices {\n" +
    "  fetchedAt: string;\n  source: string;\n  unit: string;\n  note: string;\n" +
    "  subscriptions: Record<string, CnSubscription | null>;\n" +
    "  models: Record<string, CnModelPrices>;\n  errors: string[];\n}\n\n" +
    `export const CN_PROVIDER_PRICES: CnProviderPrices = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync(out, banner + body, "utf8");
  const n = Object.keys(models).length;
  process.stdout.write(
    `wrote ${out}\n  models=${n}/${MODELS.length}  errors=${errors.length}\n` +
      errors.map((e) => `  ! ${e}\n`).join(""),
  );
};

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
