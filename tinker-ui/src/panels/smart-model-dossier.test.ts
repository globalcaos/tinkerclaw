import { describe, it, expect } from "vitest";
import {
  domainStrengthFor,
  frontierRungsFor,
  TASK_DOMAINS,
  thalamusRoutesByDomain,
} from "../../../src/shared/thalamus-frontier";
import type { ThalamusRoute } from "../../../src/shared/thalamus-frontier";
import { scThalamusRelCost } from "./smart-cost-chart";
import {
  renderThalamusRoutes,
  scBestBySkill,
  scColumnOrder,
  SD_RANKED_PLACES,
  sdRouteSwitched,
  renderCnProviderMatrix,
  cnPrettyName,
  cnMatrixColumns,
  cnCheapestSummary,
  CN_PROVIDER_PRICES,
  scDossierFor,
  scRankBySkill,
  scFactsFor,
  scFactLine,
  SC_FACTS,
  renderDossierTable,
  SC_SHARED_REFUSALS,
  SC_SPLITS,
  SC_DOSSIER_RULES,
  SC_TOPICS,
  SC_TOPIC_GROUP,
  SC_TOPIC_PLAIN,
  scTopicGroups,
  SC_SKILLS,
  SC_SKILL_RANK,
  SC_REFERENCE_ROWS,
  scTopicFactLine,
  scRefusalLine,
  META_TOPICS,
  MIMO_TOPICS,
  MINIMAX_TOPICS,
  HUNYUAN_TOPICS,
  STEP_TOPICS,
  COPILOT_TOPICS,
} from "./smart-model-dossier";

describe("smart-model dossier — coverage", () => {
  it("every rule has a grade+tip for every capability column", () => {
    for (const rule of SC_DOSSIER_RULES) {
      for (const s of SC_SKILLS) {
        const cell = rule.entry.skills[s.key];
        expect(cell, `${rule.match} missing skill ${s.key}`).toBeDefined();
        // "none" = no defensible grade, first used by the 2026-10-02 verticals.
        expect(["none", "weak", "ok", "strong", "top"]).toContain(cell.v);
        expect(cell.tip.length).toBeGreaterThan(20);
      }
    }
  });

  it("no model is best at everything — the grid has to discriminate", () => {
    for (const rule of SC_DOSSIER_RULES) {
      const tops = SC_SKILLS.filter((s) => rule.entry.skills[s.key].v === "top").length;
      expect(tops).toBeLessThan(SC_SKILLS.length);
    }
    // ...and every subject has at least one clear first choice to route to.
    for (const s of SC_SKILLS) {
      const anyTop = SC_DOSSIER_RULES.some((r) => r.entry.skills[s.key].v === "top");
      expect(anyTop, `no top-tier model for subject ${s.key}`).toBe(true);
    }
  });

  it("the cost/intelligence trade-off is real: cheap tiers are not also top at reasoning", () => {
    for (const rule of SC_DOSSIER_RULES) {
      const { cost, reason } = rule.entry.skills;
      expect(cost.v === "top" && reason.v === "top").toBe(false);
    }
  });

  it("scRankBySkill ranks by grade, breaking ties on the AA index", () => {
    const rows = [
      { id: "claude-code/claude-haiku-4-5", name: "Haiku", color: "#fff", index: 40 },
      { id: "claude-code/claude-fable-5", name: "Fable 5", color: "#fff", index: 63 },
      { id: "claude-code/claude-opus-5", name: "Opus 5", color: "#fff", index: 60.7 },
    ];
    expect(scRankBySkill(rows, "code")[0].name).toBe("Fable 5");
    expect(scRankBySkill(rows, "cost")[0].name).toBe("Haiku");
    expect(scRankBySkill(rows, "speed")[0].name).toBe("Haiku");
    // Fable and Opus are both top at agentic → the AA index breaks the tie.
    expect(
      scRankBySkill(rows, "agentic")
        .slice(0, 2)
        .map((r) => r.name),
    ).toEqual(["Fable 5", "Opus 5"]);
  });

  it("measured facts land on the subject they measure, and nowhere else", () => {
    const f = scFactsFor("claude-code/claude-opus-5")!;
    expect(f.tps).toBe(29);
    expect(scFactLine("code", f)).toMatch(/88\.6%/);
    expect(scFactLine("speed", f)).toMatch(/29 tokens\/sec/);
    expect(scFactLine("cost", f)).toMatch(/\$5 in \/ \$25 out/);
    expect(scFactLine("context", f)).toMatch(/1M token window/);
    // No public per-model metric for these — they must stay qualitative.
    for (const k of ["agentic", "write", "vision", "world"] as const) {
      expect(scFactLine(k, f)).toBe("");
    }
  });

  it("every measured line carries a dated source", () => {
    for (const row of SC_FACTS) {
      for (const k of ["code", "speed", "cost", "context"] as const) {
        const line = scFactLine(k, row.facts);
        if (line) expect(line, `${row.match} ${k}`).toMatch(/2026-08-07/);
      }
    }
  });

  it("a figure measured on another variant says so", () => {
    // Opus 5's SWE-bench number is Opus 4.8's — the tooltip must not imply otherwise.
    expect(scFactLine("code", scFactsFor("claude-code/claude-opus-5"))).toMatch(/Opus 4\.8/);
    expect(scFactLine("code", scFactsFor("openrouter/moonshotai/kimi-k3"))).toMatch(/K2\.6/);
  });

  // Regraded 2026-08-07 from measured throughput: the old grades came from tier
  // reputation and had Opus 5 mid-pack (it is 29 tok/s, the slowest here) and
  // Sol slow (134 tok/s, comfortably mid). Locked so reputation cannot creep back.
  it("SPEED grades follow measured throughput, not tier reputation", () => {
    const grade = (id: string) => scDossierFor(id)!.skills.speed.v;
    expect(grade("claude-code/claude-opus-5")).toBe("weak");
    expect(grade("openrouter/z-ai/glm-5.2")).toBe("top");
    expect(grade("codex/gpt-5.6-sol")).toBe("strong");
    expect(SC_SKILL_RANK[grade("openrouter/z-ai/glm-5.2")]).toBeGreaterThan(
      SC_SKILL_RANK[grade("claude-code/claude-opus-5")],
    );
  });

  it("SC_SKILL_RANK is strictly ordered so a router can compare grades", () => {
    expect(SC_SKILL_RANK.top).toBeGreaterThan(SC_SKILL_RANK.strong);
    expect(SC_SKILL_RANK.strong).toBeGreaterThan(SC_SKILL_RANK.ok);
    expect(SC_SKILL_RANK.ok).toBeGreaterThan(SC_SKILL_RANK.weak);
  });

  it("every rule has a best-at and a verdict+tip for every topic column", () => {
    for (const rule of SC_DOSSIER_RULES) {
      expect(rule.entry.best.length).toBeGreaterThan(5);
      expect(["US", "CN", "OSS"]).toContain(rule.entry.bloc);
      for (const t of SC_TOPICS) {
        const cell = rule.entry.topics[t.key];
        expect(cell, `${rule.match} missing topic ${t.key}`).toBeDefined();
        expect(["open", "soft", "gated", "hard"]).toContain(cell.v);
        expect(cell.tip.length).toBeGreaterThan(20);
      }
    }
  });

  it("US and Chinese camps both present", () => {
    const blocs = new Set(SC_DOSSIER_RULES.map((r) => r.entry.bloc));
    expect(blocs.has("US")).toBe(true);
    expect(blocs.has("CN")).toBe(true);
  });

  it("CSAM and CBRN are refused by every model in both camps", () => {
    for (const rule of SC_DOSSIER_RULES) {
      expect(rule.entry.topics.csam.v).toBe("hard");
      expect(rule.entry.topics.cbrn.v).toBe("hard");
    }
  });

  // The correction the architect caught 2026-08-06: the first version claimed both camps
  // refused cyber work. The Hugging Face breach showed the opposite — US models
  // refuse DEFENDERS, Chinese models do not. Locked in so it cannot drift back.
  it("US models gate defensive security work; Chinese models do not", () => {
    for (const id of ["claude-code/claude-opus-5", "codex/gpt-5.6-sol"]) {
      expect(scDossierFor(id)?.topics.secwork.v).toBe("gated");
    }
    for (const id of [
      "openrouter/z-ai/glm-5.2",
      "openrouter/deepseek/deepseek-v4-flash-0731",
      "openrouter/moonshotai/kimi-k3",
      "openrouter/qwen/qwen3.8-max",
    ]) {
      expect(scDossierFor(id)?.topics.secwork.v).toBe("open");
    }
  });

  it("offensive malware and defensive research are separate columns", () => {
    const keys = SC_TOPICS.map((t) => t.key);
    expect(keys).toContain("malware");
    expect(keys).toContain("secwork");
    const anthropic = scDossierFor("claude-code/claude-opus-5")!;
    expect(anthropic.topics.malware.v).toBe("hard");
    expect(anthropic.topics.malware.v).not.toBe(anthropic.topics.secwork.v);
  });

  it("the GLM entry credits the Hugging Face incident response", () => {
    const e = scDossierFor("openrouter/z-ai/glm-5.2")!;
    expect(e.bloc).toBe("CN");
    expect(`${e.best} ${e.topics.secwork.tip}`).toMatch(/Hugging Face/i);
  });

  it("China politics varies BETWEEN Chinese models, not by bloc", () => {
    expect(scDossierFor("openrouter/deepseek/deepseek-v4-flash-0731")?.topics.cnpolitics.v).toBe(
      "hard",
    );
    expect(scDossierFor("openrouter/moonshotai/kimi-k3")?.topics.cnpolitics.v).toBe("open");
    expect(scDossierFor("openrouter/z-ai/glm-5.2")?.topics.cnpolitics.v).toBe("soft");
    // ...and the US camp is open on it, which is the mirror of the elections column.
    const us = scDossierFor("claude-code/claude-opus-5")!;
    expect(us.topics.cnpolitics.v).toBe("open");
    expect(us.topics.elections.v).toBe("hard");
    expect(scDossierFor("openrouter/moonshotai/kimi-k3")?.topics.elections.v).toBe("open");
  });

  it("shared refusals no longer claim cyber tooling as common ground", () => {
    expect(SC_SHARED_REFUSALS.length).toBeGreaterThanOrEqual(4);
    const joined = SC_SHARED_REFUSALS.join(" ").toLowerCase();
    expect(joined).toContain("minors");
    expect(joined).toMatch(/weapons|biological/);
    expect(joined).not.toMatch(/malware|ransomware|cyberattack/);
  });

  it("the splits block names the security-research divergence", () => {
    const joined = SC_SPLITS.map((s) => `${s.title} ${s.body}`).join(" ");
    expect(joined).toMatch(/Hugging Face/);
    expect(joined).toMatch(/98\.8%/);
  });

  // FORK 2026-08-07 — the low-refusal reference rows.
  it("abliterated ids resolve to the OSS rule, NOT to their base vendor", () => {
    // "Huihui-Qwen3.5-27B-abliterated" contains "qwen"; if rule order regresses
    // it inherits Alibaba's censorship profile, which is the opposite of true.
    const e = scDossierFor("huihui-ai/Huihui-Qwen3.5-27B-abliterated")!;
    expect(e.bloc).toBe("OSS");
    expect(scDossierFor("nousresearch/hermes-4-405b")?.bloc).toBe("OSS");
    expect(scDossierFor("cognitivecomputations/dolphin-mistral-24b-venice-edition")?.bloc).toBe(
      "OSS",
    );
    // ...and the stock Qwen rule still works for a stock Qwen id.
    expect(scDossierFor("openrouter/qwen/qwen3.8-max")?.bloc).toBe("CN");
  });

  it("abliteration lifts security work but NOT Chinese politics", () => {
    const abl = scDossierFor("huihui-ai/Huihui-Qwen3.5-27B-abliterated")!;
    expect(abl.topics.secwork.v).toBe("open");
    expect(abl.topics.adult.v).toBe("open");
    // The finding that surprised us: politics is a different circuit.
    expect(abl.topics.cnpolitics.v).toBe("soft");
    expect(abl.topics.cnpolitics.tip).toMatch(/different circuit/i);
    // Hermes has a Llama base — nothing Chinese to survive.
    expect(scDossierFor("nousresearch/hermes-4-405b")?.topics.cnpolitics.v).toBe("open");
  });

  it("no low-refusal model lifts CSAM or buys real CBRN capability", () => {
    for (const id of [
      "nousresearch/hermes-4-405b",
      "cognitivecomputations/dolphin-mistral-24b-venice-edition",
      "huihui-ai/Huihui-Qwen3.5-27B-abliterated",
    ]) {
      const e = scDossierFor(id)!;
      expect(e.topics.csam.v).toBe("hard");
      expect(e.topics.cbrn.v).toBe("hard");
    }
  });

  it("only the ABLITERATED row carries the disposition-drift warning", () => {
    const abl = scDossierFor("huihui-ai/Huihui-Qwen3.5-27B-abliterated")!;
    const hermes = scDossierFor("nousresearch/hermes-4-405b")!;
    expect(abl.skills.agentic.v).toBe("weak");
    expect(abl.skills.agentic.tip).toMatch(/2607\.17427/);
    // Hermes is neutrally aligned, not ablated — the finding does not transfer.
    expect(hermes.skills.agentic.tip).not.toMatch(/2607\.17427/);
  });

  it("every reference row says how smart it is and how to reach it cheaply", () => {
    expect(SC_REFERENCE_ROWS.length).toBeGreaterThanOrEqual(3);
    for (const r of SC_REFERENCE_ROWS) {
      expect(r.reference).toBe(true);
      expect(r.indexNote!.length).toBeGreaterThan(40);
      expect(r.howto!.length).toBeGreaterThan(80);
      // "no subscription needed" was the ask — each howto names a concrete route.
      expect(r.howto).toMatch(/openrouter\.ai|huggingface\.co/);
      expect(scDossierFor(r.id), `no dossier entry for ${r.id}`).toBeDefined();
    }
  });

  it("censorship-side numbers land on their own columns", () => {
    const glm = scFactsFor("openrouter/z-ai/glm-5.2")!;
    expect(scTopicFactLine("malware", glm)).toMatch(/CASI jailbreak resilience 46\.58/);
    expect(scTopicFactLine("cnpolitics", glm)).toMatch(/95\.2%/);
    expect(scTopicFactLine("csam", glm)).toBe("");
    expect(scRefusalLine(scFactsFor("nousresearch/hermes-4-405b"))).toMatch(/57\.1%/);
    expect(scRefusalLine(scFactsFor("openrouter/z-ai/glm-5.2"))).toBe("");
  });

  it("unknown model returns undefined (caller shows a placeholder)", () => {
    expect(scDossierFor("mystery/unknown-model-x")).toBeUndefined();
  });
});

describe("smart-model dossier — rendering", () => {
  const rows = [
    { id: "claude-code/claude-opus-5", name: "Claude Opus 5", color: "#E8702A", index: 60.7 },
    { id: "openrouter/moonshotai/kimi-k3", name: "Kimi K3", color: "#07B2FE", index: 57.1 },
  ];

  it("renders one row per model, sorted by index desc", () => {
    const html = renderDossierTable(rows);
    // TWO tables since 2026-10-02 (capability, censorship), each with group + header +
    // 2 configured rows + the low-refusal reference rows.
    expect(html.split("<tr").length - 1).toBe(2 * (4 + SC_REFERENCE_ROWS.length));
    expect(html.split("<table").length - 1).toBe(2);
    expect(html.indexOf("Claude Opus 5")).toBeLessThan(html.indexOf("Kimi K3"));
  });

  it("renders a column per capability and per topic, tooltips on every cell", () => {
    const html = renderDossierTable(rows);
    for (const t of SC_TOPICS) expect(html).toContain(`>${t.label}<`);
    for (const s of SC_SKILLS) expect(html).toContain(`>${s.label}<`);
    // (rows + 1 header) × (skills + topics), plus one name tip per row IN EACH of the
    // two tables, and the capability table's MODEL header tip.
    const n = 2 + SC_REFERENCE_ROWS.length;
    const tips = html.split("data-tip=").length - 1;
    expect(tips).toBe((SC_SKILLS.length + SC_TOPICS.length) * (n + 1) + 2 * n + 1);
  });

  it("the refusal bands tile every topic column exactly once, in render order", () => {
    const bands = scTopicGroups();
    expect(bands.reduce((n, b) => n + b.span, 0)).toBe(SC_TOPICS.length);
    // contiguity: rebuilding the key order from the bands must reproduce SC_TOPICS
    const rebuilt = bands.flatMap((b) => Array.from({ length: b.span }, () => b.group));
    expect(rebuilt).toEqual(SC_TOPICS.map((t) => SC_TOPIC_GROUP[t.key]));
    const html = renderDossierTable(rows);
    // the band label is HTML-escaped on the way out ("LAW & RIGHTS" -> "LAW &amp; RIGHTS")
    for (const b of bands) expect(html).toContain(`>${b.group.replace(/&/g, "&amp;")} <i>`);
  });

  it("every refusal cell carries a verdict wash, and every refusal column its plain line", () => {
    const html = renderDossierTable(rows);
    // one wash class per rendered refusal cell — colour is additive, the glyph stays
    const washes = (html.match(/sd-lock-(hard|gated|soft|open|none)/g) ?? []).length;
    expect(washes).toBe(SC_TOPICS.length * (2 + SC_REFERENCE_ROWS.length));
    for (const t of SC_TOPICS) expect(html).toContain(SC_TOPIC_PLAIN[t.key]);
  });

  it("the prose best-at moves to the model-name tooltip, not a column", () => {
    const html = renderDossierTable(rows);
    expect(html).not.toContain("BEST AT");
    expect(html).toMatch(/Claude Opus 5 — Long-horizon agentic work/);
  });

  it("capability headers are clickable sort keys and rows carry their ranks", () => {
    const html = renderDossierTable(rows);
    for (const s of SC_SKILLS) expect(html).toContain(`data-sort="${s.key}"`);
    expect(html).toContain('data-sort="index"');
    expect(html).toMatch(/data-ranks="[^"]*code/);
  });

  it("renders the legend and both footer blocks", () => {
    const html = renderDossierTable(rows);
    expect(html).toContain("REFUSED BY BOTH CAMPS");
    expect(html).toContain("WHERE THEY SPLIT");
    expect(html).toMatch(/influencing[\s\S]*criticizing|criticizing[\s\S]*influencing/i);
    expect(html).toContain("hover any cell");
  });

  it("renders the vendor mark when given one, the colour dot when not", () => {
    const withLogo = renderDossierTable([{ ...rows[0], logo: "<svg id='kmark'></svg>" }]);
    expect(withLogo).toContain("<span class=\"sd-logo\"><svg id='kmark'></svg></span>");
    // Only the reference rows lack a logo, so they are the only dots left — once per table.
    expect(withLogo.split("sd-dot").length - 1).toBe(2 * SC_REFERENCE_ROWS.length);
    expect(renderDossierTable(rows)).toContain("sd-dot");
  });

  it("capability tooltips carry the measured number", () => {
    const html = renderDossierTable(rows);
    expect(html).toMatch(/MEASURED — 88\.6%/);
    expect(html).toMatch(/MEASURED — 29 tokens\/sec/);
  });

  it("escapes model names and tooltips (no raw HTML injection)", () => {
    const html = renderDossierTable([
      { id: "x/<script>", name: "<script>alert(1)</script>", color: "#fff", index: 50 },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// FORK 2026-08-15 (the architect), widened 2026-09-23: the CN supplier × model price matrix at
// the foot of the dossier. Assert PROPERTIES against the generated data, never literal
// prices — the figures AND the roster are regenerated daily, and any hardcoded number
// or model id here would go red within days, which is exactly how assertions in this UI
// have rotted five times already.
describe("CN supplier × model matrix", () => {
  const priced = Object.entries(CN_PROVIDER_PRICES.models).filter(([, m]) => m.cheapest);

  it("bolds exactly the cheapest supplier in every priced row", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    for (const [id, m] of priced) {
      const cheapest = Math.min(...Object.values(m.providers).map((p) => p.out));
      expect(m.cheapest!.out).toBeCloseTo(cheapest, 6);
      expect(m.providers[m.cheapest!.provider]?.out).toBeCloseTo(cheapest, 6);
      expect(html).toContain(id);
    }
    // One bold per priced row, in the cheapest cell, plus one in the cheapest column.
    const bolds = (html.match(/<b>/g) ?? []).length;
    expect(bolds).toBeGreaterThanOrEqual(priced.length);
  });

  // 2026-10-02 (the architect's bank blocked OpenRouter): the "without OpenRouter" column.
  it("gives every row a without-OpenRouter cell naming the cheapest direct seller", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const rows = body.split("<tr>").slice(1);
    expect(rows.length).toBe(Object.keys(CN_PROVIDER_PRICES.models).length);
    expect(html).toContain("without OpenRouter</th>");
    for (const [id, m] of Object.entries(CN_PROVIDER_PRICES.models)) {
      const row = rows.find((r) => r.includes(`title="${id} — `))!;
      const d = m.direct;
      if (!d?.cheapest) continue;
      const min = Math.min(...Object.values(d.sellers).map((s) => s.out));
      expect(d.cheapest.out).toBeCloseTo(min, 6);
      expect(row).toContain(`sd-cn-direct" title=`);
      expect(row).toContain(`${d.cheapest.seller} <b>`);
    }
    // The case this guards is live: at least one model is sold outside OpenRouter.
    expect(Object.values(CN_PROVIDER_PRICES.models).some((m) => m.direct?.cheapest)).toBe(true);
  });

  // 2026-10-02 (the architect: "lacks nice logos for every model, make it all prettier").
  it("names each row the way a person says it, and draws the lab's mark when given one", () => {
    expect(cnPrettyName("z-ai/glm-5.3")).toBe("GLM 5.3");
    expect(cnPrettyName("xiaomi/mimo-v2.6-pro")).toBe("MiMo V2.6 Pro");
    expect(cnPrettyName("moonshotai/kimi-k3")).toBe("Kimi K3");
    expect(cnPrettyName("deepseek/deepseek-v4-pro-0813")).toBe("DeepSeek V4 Pro 0813");
    expect(cnPrettyName("bytedance-seed/seed-2-1-turbo")).toBe("Seed 2.1 Turbo");
    expect(cnPrettyName("tencent/hy4-preview")).toBe("HY4 Preview");
    const ids = Object.keys(CN_PROVIDER_PRICES.models);
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES, {
      logoFor: () => "<svg id='lab'></svg>",
    });
    expect(html.split("<svg id='lab'></svg>").length - 1).toBe(ids.length);
    expect(renderCnProviderMatrix(CN_PROVIDER_PRICES)).not.toContain("sd-cn-logo");
  });

  it("renders data generated before the direct column existed, with a dash", () => {
    const old = structuredClone(CN_PROVIDER_PRICES);
    delete old.directSources;
    for (const m of Object.values(old.models)) delete m.direct;
    const html = renderCnProviderMatrix(old);
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body).not.toContain("sd-cn-direct");
    expect((body.match(/<tr>/g) ?? []).length).toBe(Object.keys(old.models).length);
  });

  it("marks subscription vs pay-per-use, and flags unconfirmed plans", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(html).toContain("pay/use"); // DeepSeek: pay-per-use only
    expect(html).toContain(">sub<"); // Z.AI / Moonshot: confirmed plans
    // An unconfirmed plan must never render as a plain confirmed one.
    const unconfirmed = Object.values(CN_PROVIDER_PRICES.subscriptions).filter(
      (s) => s && !s.confirmed,
    );
    if (unconfirmed.length) expect(html).toContain("sub?");
  });

  it("chooses supplier columns by measured coverage, never a pinned list", () => {
    const cols = cnMatrixColumns(CN_PROVIDER_PRICES);
    expect(cols.length).toBeGreaterThan(2);
    const labs = new Set(
      Object.values(CN_PROVIDER_PRICES.models)
        .map((m) => m.lab)
        .filter(Boolean),
    );
    // Labs get the dedicated "lab direct" column; they must not also take a slot.
    for (const c of cols) expect(labs.has(c)).toBe(false);
  });

  it("carries a fetch timestamp so a stale matrix is visible, not silent", () => {
    expect(CN_PROVIDER_PRICES.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(renderCnProviderMatrix(CN_PROVIDER_PRICES)).toContain(
      CN_PROVIDER_PRICES.fetchedAt.slice(0, 10),
    );
  });

  // ── 2026-10-03: "the best chinese models are not in the table" (the architect) ────────
  // The roster used to follow price and a 75-day window on OpenRouter's `created`,
  // which is not a release date. That dropped MiniMax entirely and kept StepFun's
  // cheap tier while its best model, sold only by StepFun, never appeared. These ids
  // are the labs' best, so the rule may add rows but must not lose these.
  it("keeps each lab's best model, including one OpenRouter does not sell", () => {
    const ids = Object.keys(CN_PROVIDER_PRICES.models);
    for (const id of [
      "qwen/qwen3.8-max-0902",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "xiaomi/mimo-v2.6-pro",
      "minimax/minimax-m3",
      "deepseek/deepseek-v4-pro-0813",
      "stepfun/step-5-preview",
    ]) {
      expect(ids, id).toContain(id);
    }
    // Step 5 Preview is priced from StepFun's own page, in dollars, so it ranks
    // with the others instead of showing a dash.
    const step = CN_PROVIDER_PRICES.models["stepfun/step-5-preview"];
    expect(step.cheapest?.out).toBeGreaterThan(0);
    expect(step.labDirect?.usdOut).toBe(step.cheapest?.out);
    // A $0 promo must never take a row.
    for (const m of Object.values(CN_PROVIDER_PRICES.models)) {
      if (m.cheapest) expect(m.cheapest.out).toBeGreaterThan(0);
    }
  });

  // ── 2026-09-23: "openrouter needs to be there" (the architect) ──────────────────────
  // The table listed the hosts BEHIND OpenRouter but never OpenRouter's own default
  // route — the price most people actually pay. These guard that it cannot go missing
  // again, and that its fee caveat travels with it.
  it("gives OpenRouter its own column, priced from its DEFAULT route", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(html).toContain(">OpenRouter</th>");
    const withRoute = priced.filter(([, m]) => m.openrouter);
    expect(withRoute.length).toBeGreaterThan(5);
    for (const [, m] of withRoute) {
      // The default route is a real price, and never cheaper than the cheapest host —
      // if it were, the cheapest-host column would be wrong.
      expect(m.openrouter!.out).toBeGreaterThan(0);
      expect(m.openrouter!.out).toBeGreaterThanOrEqual(m.cheapest!.out - 1e-9);
    }
  });

  it("quotes OpenRouter's credit fee from a FETCHED source, or says it could not", () => {
    const fee = CN_PROVIDER_PRICES.openrouterFee;
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(fee.source).toContain("openrouter.ai");
    expect(fee.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    if (fee.card) {
      // A fee is only ever a fetched string; the renderer must not invent a number.
      expect(fee.card).toMatch(/%/);
      expect(html).toContain(fee.card);
    } else {
      expect(html).toContain("could not be read");
    }
  });

  // ── the table has to ANSWER the question, not just hold the numbers ─────────
  it("summarises who is cheapest most often, from the same rows it renders", () => {
    const sum = cnCheapestSummary(CN_PROVIDER_PRICES);
    expect(sum.priced).toBe(priced.length);
    // Wins are counted ONLY where more than one supplier sells the model. Being the
    // sole seller is not being the cheapest, and counting it would hand the headline
    // to whoever happens to host the monopoly rows.
    const contested = priced.filter(([, m]) => Object.keys(m.providers).length > 1);
    expect(sum.contested).toBe(contested.length);
    expect(sum.soleSupplier).toBe(priced.length - contested.length);
    const totalWins = sum.hosts.reduce((a, h) => a + h.wins, 0);
    expect(totalWins).toBe(contested.length);
    for (const h of sum.hosts) {
      const n = contested.filter(([, m]) => m.cheapest!.provider === h.host).length;
      expect(h.wins).toBe(n);
    }
    // Sorted most-wins-first, so the headline names the real leader.
    for (let i = 1; i < sum.hosts.length; i += 1) {
      expect(sum.hosts[i - 1]!.wins).toBeGreaterThanOrEqual(sum.hosts[i]!.wins);
    }
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(html).toContain("CHEAPEST SUPPLIER OVERALL");
    if (sum.hosts[0]) expect(html).toContain(sum.hosts[0].host);
  });

  // The median that made this rewrite necessary: folding the already-cheapest rows in
  // printed "saves a median 0%" over a table whose real spread reaches 65%. True, and
  // completely misleading. Every saving stat now carries its own n AND the count it
  // deliberately excludes, so the claim cannot be read wider than the evidence.
  it("medians savings only where a cheaper host exists, and says how many it excluded", () => {
    const sum = cnCheapestSummary(CN_PROVIDER_PRICES);
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    for (const st of [sum.vsLab, sum.vsOr]) {
      // Shopping around can never COST more than the reference it is measured against.
      if (st.median !== null) {
        expect(st.median).toBeGreaterThan(0);
        expect(st.n).toBeGreaterThan(0);
      }
      expect(st.alreadyBest).toBeGreaterThanOrEqual(0);
      expect(st.n + st.alreadyBest).toBeLessThanOrEqual(sum.priced);
    }
    // Both sample sizes are printed next to their median, never a bare percentage.
    if (sum.vsLab.median !== null) expect(html).toContain(`the ${sum.vsLab.n} model`);
    if (sum.vsOr.median !== null) expect(html).toContain(`the ${sum.vsOr.n} model`);
    // Recompute vsOr independently: the summary must not drift from the raw rows.
    const expected = priced
      .filter(([, m]) => m.openrouter && m.openrouter.out > 0)
      .map(([, m]) => ((m.openrouter!.out - m.cheapest!.out) / m.openrouter!.out) * 100)
      .filter((v) => v >= 0.5);
    expect(sum.vsOr.n).toBe(expected.length);
  });

  // "pay/use" is a CLAIM about a lab, not a default. It may only be printed for a lab
  // we actually checked — an explicit entry in SUBSCRIPTIONS.
  it("never claims pay-per-use for a lab whose plans were not checked", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    const checked = new Set(Object.keys(CN_PROVIDER_PRICES.subscriptions));
    const unchecked = Object.values(CN_PROVIDER_PRICES.models)
      .map((m) => m.lab)
      .filter((l): l is string => !!l && !checked.has(l));
    expect(unchecked.length).toBeGreaterThan(0); // the case this guards is live
    // Count inside the table body only — the legend mentions the tag by name.
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const tags = (body.match(/pay\/use/g) ?? []).length;
    const payg = Object.entries(CN_PROVIDER_PRICES.subscriptions).filter(([, v]) => !v);
    const paygRows = Object.values(CN_PROVIDER_PRICES.models).filter(
      (m) => m.lab && payg.some(([lab]) => lab === m.lab),
    ).length;
    expect(tags).toBe(paygRows);
  });

  it("keeps the quantisation caveat visible in the summary, not only on hover", () => {
    const sum = cnCheapestSummary(CN_PROVIDER_PRICES);
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(html).toContain("fp4/fp8");
    expect(html).toContain(String(sum.lowPrecisionWins));
    // The count is real: it must match the routes whose quantisation says so.
    const n = priced.filter(([, m]) => /fp4|fp8|int4|int8/i.test(m.cheapest!.quant)).length;
    expect(sum.lowPrecisionWins).toBe(n);
  });

  // ── "all the major frontier chinese models need to be represented" ──────────
  it("covers the frontier Chinese labs broadly, and stays readable", () => {
    const labs = new Set(
      Object.values(CN_PROVIDER_PRICES.models)
        .map((m) => m.lab)
        .filter(Boolean) as string[],
    );
    expect(labs.size).toBeGreaterThanOrEqual(10);
    // Readability is the other half of the brief: a table nobody scans answers nothing.
    expect(Object.keys(CN_PROVIDER_PRICES.models).length).toBeLessThanOrEqual(20);
    // Every row must say WHY it is in the table, so a retired model is a visible edit.
    for (const m of Object.values(CN_PROVIDER_PRICES.models)) {
      expect(m.why.length).toBeGreaterThan(0);
    }
  });

  it("renders a lab-direct-only model honestly instead of omitting or inventing it", () => {
    const labOnly = Object.entries(CN_PROVIDER_PRICES.models).filter(([, m]) => !m.cheapest);
    if (!labOnly.length) return; // every roster model was on OpenRouter this run
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    for (const [id, m] of labOnly) {
      expect(html).toContain(id);
      expect(m.labDirect).not.toBeNull();
      expect(m.labDirect!.source).toMatch(/^https?:\/\//);
      // No price reached ⇒ the cell says so. It must never show a number we made up.
      if (m.labDirect!.cny1k === null) expect(html).toContain("no first-party price reached");
    }
  });

  it("publishes the roster rule, so nobody assumes the model list is hand-typed", () => {
    expect(CN_PROVIDER_PRICES.rosterRule).toMatch(/derived from the live catalog/);
    expect(renderCnProviderMatrix(CN_PROVIDER_PRICES)).toContain(
      "Which models appear is decided by the data",
    );
  });
});

// FORK 2026-09-02 (the architect): "mark in the dossier table the best at each category, and
// make sure Thalamus routes intelligently depending on the task at hand". Every
// expectation is COMPUTED from domainStrengthFor / thalamusRoutesByDomain, never a
// literal winner — the Epoch table is regenerated daily and a pinned name would rot.
describe("smart-model dossier — best per column + THALAMUS routes", () => {
  const rows = [
    { id: "claude-code/claude-opus-5", name: "Claude Opus 5", color: "#E8702A", index: 60.7 },
    { id: "xai/grok-4.6", name: "Grok 4.6", color: "#000000", index: 59.5 },
    { id: "openrouter/moonshotai/kimi-k3", name: "Kimi K3", color: "#07B2FE", index: 57.1 },
  ];
  const bestCells = (html: string, key: string) =>
    html.match(
      new RegExp(`data-col="${key}"[^>]*><span class="sd-tag sd-s-[a-z]+ sd-best"`, "g"),
    ) ?? [];
  const eff = (r: ThalamusRoute) => (r.rung.effort ? ` @${r.rung.effort}` : "");
  const nameOf = (r: ThalamusRoute) => rows.find((x) => x.id === r.rung.key)!.name;

  it("marks exactly one best cell per capability column, never on a reference row", () => {
    const html = renderDossierTable(rows);
    for (const s of SC_SKILLS) expect(bestCells(html, s.key).length, s.key).toBe(1);
    expect(html.split("sd-best-mark").length - 1).toBe(SC_SKILLS.length);
    const refWithBest = html
      .split("<tr")
      .filter((tr) => tr.startsWith(' class="sd-ref"') && tr.includes("sd-best"));
    expect(refWithBest).toEqual([]);
  });

  it("the best CODE cell is the configured row with the highest measured percentile", () => {
    const measured = rows.map((r) => ({ r, s: domainStrengthFor(r.id, "code") }));
    for (const m of measured) {
      expect(m.s, `${m.r.id} lost its DOMAIN_STRENGTH code row`).toBeDefined();
    }
    const expected = measured.reduce((a, b) => (b.s!.p > a.s!.p ? b : a)).r;
    const best = scBestBySkill(rows, "code")!;
    expect(best.basis).toBe("measured");
    expect(best.row.id).toBe(expected.id);
    const html = renderDossierTable(rows);
    const tr = html
      .split("<tr")
      .find((chunk) => chunk.includes(expected.name) && chunk.includes('data-col="code"'))!;
    expect(tr).toMatch(/data-col="code"[^>]*><span class="sd-tag sd-s-[a-z]+ sd-best"/);
    expect(html).toContain(`BEST — ${expected.name} (measured p`);
  });

  it("a column with no measurement falls back to the judged grade and says so", () => {
    const anyMeasured = rows.some((r) => domainStrengthFor(r.id, "write") !== undefined);
    const best = scBestBySkill(rows, "write")!;
    expect(best.basis).toBe(anyMeasured ? "measured" : "judged");
    if (!anyMeasured) {
      expect(best.row.id).toBe(scRankBySkill(rows, "write")[0].id);
      expect(renderDossierTable(rows)).toContain(`BEST — ${best.row.name} (judged:`);
    }
    // SPEED and COST are not routing domains: always today's rank.
    expect(scBestBySkill(rows, "speed")!.basis).toBe("judged");
    expect(scBestBySkill(rows, "cost")!.row.id).toBe(scRankBySkill(rows, "cost")[0].id);
  });

  it("every measured cell carries the Epoch line and data-p; one argument = no strip", () => {
    const html = renderDossierTable(rows);
    expect(html).toContain("MEASURED — Epoch AI percentile");
    const s = domainStrengthFor("claude-code/claude-opus-5", "code")!;
    expect(html).toContain(`data-col="code" data-p="${s.p}"`);
    expect(html).toContain(`p${Math.round(s.p * 100)} over ${s.n} benchmark`);
    expect(html).not.toContain("sd-routes");
  });

  const rungs = rows.flatMap((r) => frontierRungsFor(r.id, r.index, scThalamusRelCost(r.id)!));

  it("the strip lists every domain, general first, and marks the switches the router reports", () => {
    for (const r of rows) expect(scThalamusRelCost(r.id), `${r.id} has no price`).toBeDefined();
    const routes = thalamusRoutesByDomain(rungs, 0);
    const domains = Object.keys(routes);
    expect(domains[0]).toBe("general");
    // "general" + every TASK_DOMAIN. Derived, not a literal: the count went 9 -> 16 on
    // 2026-09-23 and a hardcoded number is how the strip silently stops listing a domain
    // somebody added to the type.
    expect(domains.length).toBe(TASK_DOMAINS.length + 1);
    expect(domains.slice(1)).toEqual([...TASK_DOMAINS]);
    const html = renderThalamusRoutes(rows, 0);
    expect(html).toContain("THALAMUS ROUTES · bias 0 (fast)");
    expect((html.match(/class="sd-route( sd-route-switch)?"/g) ?? []).length).toBe(domains.length);
    const list = Object.values(routes) as ThalamusRoute[];
    for (const route of list) {
      expect(html).toContain(
        `</b> → ${nameOf(route)}${eff(route)} · idx ${route.rung.smart.toFixed(1)}`,
      );
    }
    const switches = list.filter(sdRouteSwitched).length;
    expect((html.match(/sd-route-switch/g) ?? []).length).toBe(switches);
    // hover = the router's own reason, not a paraphrase
    expect(html).toContain(routes.general!.reason.slice(0, 30));
  });

  it("biasIdx 6 and 0 route GENERAL differently, and the table passes the dial through", () => {
    const fast = thalamusRoutesByDomain(rungs, 0).general!;
    const smart = thalamusRoutesByDomain(rungs, 6).general!;
    expect(`${fast.rung.key}@${fast.rung.effort}`).not.toBe(
      `${smart.rung.key}@${smart.rung.effort}`,
    );
    expect(smart.rung.smart).toBeGreaterThan(fast.rung.smart);
    const h0 = renderDossierTable(rows, undefined, { biasIdx: 0 });
    const h6 = renderDossierTable(rows, undefined, { biasIdx: 6 });
    expect(h0).toContain("THALAMUS ROUTES · bias 0 (fast)");
    expect(h6).toContain("THALAMUS ROUTES · bias 6 (smart)");
    expect(h0.indexOf("sd-routes")).toBeLessThan(h0.indexOf("<table"));
    expect(h0).toContain(`GENERAL</b> → ${nameOf(fast)}${eff(fast)}`);
    expect(h6).toContain(`GENERAL</b> → ${nameOf(smart)}${eff(smart)}`);
  });
});

// ── The six topic maps that no rule points at yet (2026-09-23) ──────────────
// They are exported and unreferenced on purpose: SC_DOSSIER_RULES is another
// unit's file and wires them at merge. That means the coverage loop at the top
// of this file — which walks SC_DOSSIER_RULES — cannot see them, so a missing or
// empty cell in any of the six would ship silently. This block is the net until
// the rules land, and it should KEEP passing afterwards.
describe("smart-model dossier — topic maps awaiting a rule", () => {
  const ORPHANS: [string, Record<string, { v: string; tip: string }>][] = [
    ["META_TOPICS", META_TOPICS],
    ["MIMO_TOPICS", MIMO_TOPICS],
    ["MINIMAX_TOPICS", MINIMAX_TOPICS],
    ["HUNYUAN_TOPICS", HUNYUAN_TOPICS],
    ["STEP_TOPICS", STEP_TOPICS],
    ["COPILOT_TOPICS", COPILOT_TOPICS],
  ];

  it("each one carries a verdict and a real tip for every topic column", () => {
    for (const [name, map] of ORPHANS) {
      for (const t of SC_TOPICS) {
        const cell = map[t.key];
        expect(cell, `${name} missing topic ${t.key}`).toBeDefined();
        expect(["open", "soft", "gated", "hard"]).toContain(cell.v);
        expect(cell.tip.length, `${name}.${t.key} tip too short`).toBeGreaterThan(20);
      }
    }
  });

  it("the two absolutes hold on every one of them", () => {
    for (const [name, map] of ORPHANS) {
      expect(map.csam.v, `${name} csam`).toBe("hard");
      expect(map.cbrn.v, `${name} cbrn`).toBe("hard");
    }
  });

  it("an unmeasured cell says so rather than implying a benchmark", () => {
    // The four newest Chinese families have no published refusal eval. The value
    // of the row is that it admits that; a cell that quietly looked measured
    // would be worse than no row at all.
    for (const map of [MIMO_TOPICS, MINIMAX_TOPICS, HUNYUAN_TOPICS, STEP_TOPICS]) {
      expect(map.cnpolitics.tip).toMatch(/JUDGED/);
    }
    // ...and MiMo is the one that does have a number, so it must cite it.
    expect(MIMO_TOPICS.explosives.tip).toMatch(/73\.80/);
  });

  it("Copilot is STRICTER than the OpenAI model underneath it", () => {
    // The whole point of the row: refusal is a service property, not only a model
    // property. If this ever stops being true the row has lost its reason to exist.
    const openai = scDossierFor("openai-codex/gpt-6-sol")!;
    expect(openai.topics.secwork.v).toBe("gated");
    expect(COPILOT_TOPICS.secwork.v).toBe("hard");
    // Azure's protected-material filter is the named example for the COPYRIGHT column.
    expect(COPILOT_TOPICS.copyright.tip).toMatch(/[Pp]rotected [Mm]aterial/);
  });

  it("Meta names conventional firearms, which is why WEAPONS is its own column", () => {
    expect(META_TOPICS.weapons.v).toBe("hard");
    expect(META_TOPICS.weapons.tip).toMatch(/guns and illegal weapons/);
  });
});

// FORK 2026-10-02 (the architect): "the capability table is hard to read at a glance. Make the
// rankings more visible ... which one is first, second, third ... maybe stop at 5th?" and
// "for the chinese models table add the intelligence index for each of them next to the
// title, like the other two tables". Expectations are COMPUTED from scColumnOrder and the
// generated tables, never a pinned winner: the Epoch data is regenerated daily.
describe("smart-model dossier — places 1–5 per column, AA index on the CN table", () => {
  const rows = [
    { id: "claude-code/claude-opus-5", name: "Claude Opus 5", color: "#E8702A", index: 60.7 },
    { id: "xai/grok-4.6", name: "Grok 4.6", color: "#000000", index: 59.5 },
    { id: "openrouter/moonshotai/kimi-k3", name: "Kimi K3", color: "#07B2FE", index: 57.1 },
    { id: "claude-code/claude-sonnet-4-6", name: "Sonnet 4.6", color: "#E8702A", index: 52 },
    { id: "openrouter/z-ai/glm-5.3", name: "GLM 5.3", color: "#3859FF", index: 44.8 },
    { id: "openrouter/qwen/qwen3.8-max-0902", name: "Qwen 3.8 Max", color: "#615CED", index: 45.4 },
    { id: "claude-code/claude-haiku-4-5", name: "Haiku 4.5", color: "#E8702A", index: 29.9 },
  ];
  /** The place badge drawn in one row's cell for one column, or undefined. */
  const badgeIn = (html: string, name: string, key: string): number | undefined => {
    const tr = html.split("<tr").find((c) => c.includes(`>${name} `) && c.includes("data-ranks"));
    const td = tr?.split("<td").find((c) => c.includes(`data-col="${key}"`));
    const m = td?.match(/class="sd-rk sd-rk-(\d)/);
    return m ? Number(m[1]) : undefined;
  };

  it("badges exactly the places 1–5 of every column, in header-click order", () => {
    const html = renderDossierTable(rows);
    for (const s of SC_SKILLS) {
      for (const o of scColumnOrder(rows, s.key)) {
        const want = o.place <= SD_RANKED_PLACES ? o.place : undefined;
        expect(badgeIn(html, o.row.name, s.key), `${s.key} · ${o.row.name}`).toBe(want);
      }
    }
  });

  it("orders by measured percentile, then grade, then AA index — the sort handler's keys", () => {
    for (const s of SC_SKILLS) {
      const order = scColumnOrder(rows, s.key);
      const keyOf = (id: string, index: number) => {
        const d = TASK_DOMAINS.includes(s.key as never)
          ? domainStrengthFor(id, s.key as never)
          : undefined;
        return [d?.p ?? -1, SC_SKILL_RANK[scDossierFor(id)?.skills[s.key].v ?? "weak"], index];
      };
      for (let n = 1; n < order.length; n++) {
        const a = keyOf(order[n - 1].row.id, order[n - 1].row.index!);
        const b = keyOf(order[n].row.id, order[n].row.index!);
        const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
        expect(
          cmp,
          `${s.key} ${order[n - 1].row.name} before ${order[n].row.name}`,
        ).toBeGreaterThanOrEqual(0);
        expect(order[n].place).toBe(cmp === 0 ? order[n - 1].place : n + 1);
      }
    }
  });

  it("place 1 IS the gold best cell, and still exactly one best mark per column", () => {
    const html = renderDossierTable(rows);
    for (const s of SC_SKILLS) {
      expect(scColumnOrder(rows, s.key)[0].row.id, s.key).toBe(scBestBySkill(rows, s.key)!.row.id);
    }
    expect(html.split("sd-best-mark").length - 1).toBe(SC_SKILLS.length);
    // The grade chip stays the cell's first child, so the best-cell selector still matches.
    expect(html).not.toMatch(/data-col="[a-z]+"[^>]*><sup/);
  });

  it("ties share a place: two routes to one model never pretend one beats the other", () => {
    const twin = [
      { id: "claude-code/claude-opus-5", name: "A", color: "#000", index: 60 },
      { id: "claude-code/claude-opus-5", name: "B", color: "#000", index: 60 },
      { id: "claude-code/claude-opus-5", name: "C", color: "#000", index: 50 },
    ];
    expect(scColumnOrder(twin, "code").map((o) => o.place)).toEqual([1, 1, 3]);
  });

  it("never places a reference row, and the legend shows the five steps", () => {
    const html = renderDossierTable(rows);
    const refPlaced = html
      .split("<tr")
      .filter((tr) => tr.startsWith(' class="sd-ref"') && /sd-rk|sd-rank-/.test(tr));
    expect(refPlaced).toEqual([]);
    for (let n = 1; n <= SD_RANKED_PLACES; n++) {
      expect(html).toContain(`<span class="sd-leg-place sd-rank-${n}">`);
    }
    expect(html).not.toContain("sd-heat-");
  });

  it("the CN table prints the AA index beside each name, a dash when AA has none", () => {
    const ids = Object.keys(CN_PROVIDER_PRICES.models);
    const scored = ids[0]!;
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES, {
      indexFor: (id) => (id === scored ? 45.4152 : undefined),
    });
    expect(html).toContain("model · AA idx");
    const heads = html.split('<th class="sd-model sd-cn-model"').slice(1);
    expect(heads.length).toBe(ids.length);
    expect(heads[0]).toContain('<span class="sd-idx">45.4</span>');
    for (const h of heads.slice(1))
      expect(h).toMatch(/<span class="sd-idx" title="[^"]+">—<\/span>/);
    // Without the option the column is not drawn at all.
    const bare = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    expect(bare).not.toContain("sd-idx");
    expect(bare).not.toContain("AA idx");
  });

  it("joins only standalone version numbers in CN names", () => {
    expect(cnPrettyName("qwen/qwen3.8-2.4t-a95b")).toBe("Qwen3.8 2.4t A95B");
    expect(cnPrettyName("bytedance-seed/seed-2-1-turbo")).toBe("Seed 2.1 Turbo");
  });
});
