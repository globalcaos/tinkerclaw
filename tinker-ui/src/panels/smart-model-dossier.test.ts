import { describe, it, expect } from "vitest";
import {
  domainStrengthFor,
  frontierRungsFor,
  thalamusRoutesByDomain,
} from "../../../src/shared/thalamus-frontier";
import type { ThalamusRoute } from "../../../src/shared/thalamus-frontier";
import { scThalamusRelCost } from "./smart-cost-chart";
import {
  renderThalamusRoutes,
  scBestBySkill,
  sdRouteSwitched,
  renderCnProviderMatrix,
  cnMatrixColumns,
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
  SC_SKILLS,
  SC_SKILL_RANK,
  SC_REFERENCE_ROWS,
  scTopicFactLine,
  scRefusalLine,
} from "./smart-model-dossier";

describe("smart-model dossier — coverage", () => {
  it("every rule has a grade+tip for every capability column", () => {
    for (const rule of SC_DOSSIER_RULES) {
      for (const s of SC_SKILLS) {
        const cell = rule.entry.skills[s.key];
        expect(cell, `${rule.match} missing skill ${s.key}`).toBeDefined();
        expect(["weak", "ok", "strong", "top"]).toContain(cell.v);
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
    // group + header + 2 configured rows + the low-refusal reference rows
    expect(html.split("<tr").length - 1).toBe(4 + SC_REFERENCE_ROWS.length);
    expect(html.indexOf("Claude Opus 5")).toBeLessThan(html.indexOf("Kimi K3"));
  });

  it("renders a column per capability and per topic, tooltips on every cell", () => {
    const html = renderDossierTable(rows);
    for (const t of SC_TOPICS) expect(html).toContain(`>${t.label}<`);
    for (const s of SC_SKILLS) expect(html).toContain(`>${s.label}<`);
    // (rows + 1 header) × (skills + topics), plus one name tip per row and the
    // MODEL header's own tip.
    const n = 2 + SC_REFERENCE_ROWS.length;
    const tips = html.split("data-tip=").length - 1;
    expect(tips).toBe((SC_SKILLS.length + SC_TOPICS.length) * (n + 1) + n + 1);
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
    // Only the reference rows lack a logo, so they are the only dots left.
    expect(withLogo.split("sd-dot").length - 1).toBe(SC_REFERENCE_ROWS.length);
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

// FORK 2026-08-15 (the architect): the CN provider × model price matrix at the foot of the
// dossier. Assert PROPERTIES against the generated data, never literal prices — the
// figures are regenerated daily and any hardcoded number here would go red within days,
// which is exactly how assertions in this UI have rotted five times already.
describe("CN provider × model matrix", () => {
  it("bolds exactly the cheapest provider in every row", () => {
    const html = renderCnProviderMatrix(CN_PROVIDER_PRICES);
    for (const [id, m] of Object.entries(CN_PROVIDER_PRICES.models)) {
      const cheapest = Math.min(...Object.values(m.providers).map((p) => p.out));
      expect(m.cheapest.out).toBeCloseTo(cheapest, 6);
      expect(m.providers[m.cheapest.provider]?.out).toBeCloseTo(cheapest, 6);
      expect(html).toContain(id);
    }
    // One bold per model row, in the cheapest cell, plus one in the cheapest column.
    const bolds = (html.match(/<b>/g) ?? []).length;
    expect(bolds).toBeGreaterThanOrEqual(Object.keys(CN_PROVIDER_PRICES.models).length);
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

  it("chooses columns by measured coverage, never a pinned list", () => {
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
    expect(domains.length).toBe(9);
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
