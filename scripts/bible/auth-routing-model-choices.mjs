#!/usr/bin/env node
/**
 * auth-routing.md "Model choices follow the rank table" — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/auth-routing.md and is the authority.
 *
 * Every place that CHOOSES a Claude model for work — the spawn guidance prompts, the bridge's
 * `opus`/`sonnet` aliases, prefrontal's defaults and kits, the round-table roles, the bundled cron
 * fallbacks, and the live config's primary / prefrontal routes — must name the best-ranked
 * `claude-code/*` model of its line (opus, sonnet, fable, haiku). The ranks come from
 * `agents.defaults.models[*].rank` in ~/.openclaw/openclaw.json, refreshed daily by the
 * model-rank-refresh cron, so nothing here freezes a model name.
 *
 * Why it exists (2026-10-03): Opus 5.5 took rank 1 and was 20% cheaper than Opus 5, yet the
 * primary, the "maximum" route, the spawn guidance and the `opus` alias all still said Opus 5,
 * so most subagents ran on the older, pricier model. Sonnet 4.6 (rank 41) was still the "standard"
 * route and leaf default with Sonnet 5.5 at rank 2 and a lower price. Nothing pointed at the sites.
 *
 * SCOPE: choice sites only. Catalogs (provider model lists, DEFAULT_MODELS), price and benchmark
 * tables, and history in the bible legitimately name older models and are not scanned.
 *
 * Usage: node scripts/bible/auth-routing-model-choices.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath =
  process.env.OPENCLAW_CONFIG_PATH ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
const ID = /\bclaude-(opus|sonnet|fable|haiku)-(\d+(?:-\d+)?)\b/g;

if (!existsSync(configPath)) {
  console.error(`FAIL: ${configPath} not found — the rank table lives there`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(configPath, "utf8"));

// Best-ranked claude-code model per line.
const best = {};
for (const [key, v] of Object.entries(cfg.agents?.defaults?.models ?? {})) {
  const m = /^claude-code\/(claude-(opus|sonnet|fable|haiku)-[\d-]+)$/.exec(key);
  if (!m || typeof v?.rank !== "number") continue;
  if (!best[m[2]] || v.rank < best[m[2]].rank) best[m[2]] = { id: m[1], rank: v.rank };
}

const problems = [];
function scan(label, text) {
  for (const m of text.matchAll(ID)) {
    const want = best[m[1]];
    if (want && m[0] !== want.id) {
      problems.push(
        `${label}: names ${m[0]}, best-ranked ${m[1]} is ${want.id} (rank ${want.rank})`,
      );
    } else if (!want) {
      problems.push(`${label}: names ${m[0]}, but no claude-code/${m[1]} model has a rank`);
    }
  }
}
function scanFile(rel, pick = (t) => t) {
  const text = readFileSync(path.join(repoRoot, rel), "utf8");
  pick(text)
    .split("\n")
    .forEach((line, i) => scan(`${rel}:${i + 1}`, line));
}
const dirs = (rel) =>
  readdirSync(path.join(repoRoot, rel), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${rel}/${d.name}`);

const bridge = "extensions/tinkerclaw-tinker-bridge";
const prefrontal = "extensions/tinkerclaw-prefrontal";
scanFile(`${bridge}/prompts/subagent-helper.md`);
scanFile(`${bridge}/prompts/orchestration-disposition.md`);
scanFile(`${bridge}/src/defaults.ts`, (t) => t.slice(t.indexOf("export const MODEL_ALIASES")));
for (const d of dirs(`${bridge}/crons`)) {
  if (existsSync(path.join(repoRoot, d, "job.json"))) scanFile(`${d}/job.json`);
}
scanFile(`${prefrontal}/prefrontal-types.ts`);
scanFile(`${prefrontal}/orchestration-deps.ts`);
// Kits and recipes: only the `model: name:` line is a choice; the prose around it is history.
const modelNameLines = (t) =>
  t
    .split("\n")
    .map((l) => (/^\s+name:\s*"claude-/.test(l) ? l : ""))
    .join("\n");
for (const d of dirs(`${prefrontal}/kits`)) {
  if (existsSync(path.join(repoRoot, d, "kit.md"))) scanFile(`${d}/kit.md`, modelNameLines);
}
for (const d of dirs(`${prefrontal}/recipes`)) {
  if (existsSync(path.join(repoRoot, d, "recipe.md"))) scanFile(`${d}/recipe.md`, modelNameLines);
}
scanFile("extensions/tinkerclaw-round-table/src/real-participant.ts");

// Live config: the primary, the heartbeat, and prefrontal's planner + routes.
const live = [
  ["agents.defaults.model.primary", cfg.agents?.defaults?.model?.primary],
  ["agents.defaults.heartbeat.model", cfg.agents?.defaults?.heartbeat?.model],
];
const pf = cfg.plugins?.entries?.["tinkerclaw-prefrontal"]?.config ?? {};
live.push(["prefrontal.model", pf.model], ["prefrontal.summaryModel", pf.summaryModel]);
for (const [tier, list] of Object.entries(pf.effortRouting ?? {})) {
  live.push([`prefrontal.effortRouting.${tier}`, (list ?? []).join(" ")]);
}
for (const [label, value] of live) {
  if (typeof value === "string") scan(`${configPath} ${label}`, value);
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} model choice(s) behind the rank table`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const summary = Object.entries(best)
  .map(([line, b]) => `${line}=${b.id}`)
  .join(" ");
console.log(`OK: every model choice names the best-ranked model of its line (${summary})`);
