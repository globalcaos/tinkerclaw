// scripts/thalamus-replay.ts
//
// THALAMUS REPLAY — which recorded decisions would change under the full-deploy router, and why.
//
// WHAT THIS IS FOR. the architect's full deploy (2026-10-02) turns picks into suggestions, makes an unset dial the middle
// stop, and remembers limits. The router change is live the moment the build is, so before the merge this replays the
// decisions THALAMUS v4 has recorded (shadow, `thalamus.sqlite`) through the OLD rule (a pin from the picker beats the
// plan) and the NEW rule (the suggestion is a prior inside the plan), and lists every pick that would differ.
//
// HOW IT WORKS. Each recorded row gives a dial position and a task domain. For every distinct pair the script builds
// the board from the config's own model catalog (read only), plans the turn both ways with the suggestions file
// (read only), and compares the two primaries. Rows are counted under their pair, so the report says how many
// recorded decisions each change would have touched.
//
// WHAT IT CANNOT KNOW, and says so in its output: the usage snapshot and the cooling store at the time of each row were
// not recorded, so supplies are treated as open (never as headroom) and nothing is cooling; the prompt is not stored, so
// the domain is the one the row recorded. A change that depends on a limit cannot show here.
//
// SAFE BY CONSTRUCTION. It never opens the live database or any live file for writing: pass a COPY of the database
// (`cp` it to a `mktemp -d` folder); the config and the suggestions file are only read.
//
//   node --import tsx scripts/thalamus-replay.ts --db <copy>/thalamus.sqlite \
//     [--config ~/.openclaw/openclaw.json] [--defaults ~/.openclaw/thalamus-tier-defaults.json]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { modelKey, normalizeModelRef } from "../src/agents/model-selection.js";
import {
  buildThalamusBoardParts,
  buildThalamusCatalog,
} from "../src/infra/thalamus-board-build.js";
import {
  normalizeThalamusTierDefaults,
  thalamusTierForBias,
  type ThalamusTier,
} from "../src/infra/thalamus-tier-defaults.js";
import { thalamusCandidates } from "../src/shared/thalamus-candidates.js";
import type { FrontierRung, TaskDomain } from "../src/shared/thalamus-frontier.js";
import { thalamusPlan } from "../src/shared/thalamus-plan.js";
import type { SupplyId } from "../src/shared/thalamus-supply.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg("db");
if (!dbPath) {
  console.error(
    "usage: thalamus-replay.ts --db <copy of thalamus.sqlite> [--config f] [--defaults f]",
  );
  process.exit(2);
}
const configPath = arg("config", join(homedir(), ".openclaw", "openclaw.json"))!;
const defaultsPath = arg("defaults", join(homedir(), ".openclaw", "thalamus-tier-defaults.json"))!;

const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
  agents?: { defaults?: { models?: Record<string, { intelligenceIndex?: number }> } };
  models?: { providers?: Record<string, { models?: { id: string; contextWindow?: number }[] }> };
};
const NOW = Date.now();
const catalog = buildThalamusCatalog(cfg.agents?.defaults?.models);
const parts = buildThalamusBoardParts({
  catalog,
  thalamusCandidates,
  snapshot: undefined,
  nowMs: NOW,
  allowedModelKeys: undefined,
  windowRows: Object.entries(cfg.models?.providers ?? {}).flatMap(([provider, p]) =>
    (p?.models ?? []).map((m) => ({ provider, id: m.id, contextWindow: m.contextWindow })),
  ),
});
const suggestions = normalizeThalamusTierDefaults(JSON.parse(readFileSync(defaultsPath, "utf-8")));
const unfunded = new Set<SupplyId>(["openrouter"]);

/** The key the way the board spells it. */
function boardKey(model: string): string {
  const slash = model.indexOf("/");
  const ref = normalizeModelRef(model.slice(0, slash), model.slice(slash + 1));
  return modelKey(ref.provider, ref.model);
}

const fmt = (r: { key: string; effort: string } | undefined): string =>
  r ? (r.effort ? `${r.key}@${r.effort}` : r.key) : "(none)";

type Row = {
  id: string;
  dial_idx: number;
  domain: string | null;
  chosen: string;
  switch_reason: string;
};
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db
  .prepare("select id, dial_idx, domain, chosen, switch_reason from decisions order by ts")
  .all() as Row[];
db.close();

function plan(dial: number, domain: TaskDomain, suggestion?: { key: string; effort?: string }) {
  return thalamusPlan({
    rungs: parts.rungs,
    supplies: parts.supplies,
    biasIdx: dial,
    domain,
    contextWindowFor: parts.contextWindowFor,
    unfunded,
    suggestion,
    nowMs: NOW,
  });
}

/** The rule before 2026-10-02: a pin for the dial's band beat the plan, at the rung nearest the plan's own pick. */
function oldPick(
  dial: number,
  domain: TaskDomain,
): { key: string; effort: string; via: string } | undefined {
  const p = plan(dial, domain);
  const tier: ThalamusTier = thalamusTierForBias(dial);
  const pin = suggestions[tier]?.model;
  if (pin) {
    const own = parts.rungs.filter((r: FrontierRung) => r.key === pin);
    if (own.length > 0) {
      const target = p?.route.rung.smart;
      const rung =
        typeof target === "number"
          ? own.reduce((a, b) => (Math.abs(b.smart - target) < Math.abs(a.smart - target) ? b : a))
          : own[0];
      return { key: rung.key, effort: rung.effort, via: `pin for ${tier}` };
    }
  }
  return p ? { key: p.primary.key, effort: p.primary.effort, via: "plan" } : undefined;
}

function newPick(dial: number, domain: TaskDomain) {
  const tier = thalamusTierForBias(dial);
  const s = suggestions[tier];
  const suggestion = s
    ? { key: boardKey(s.model), ...(s.effort ? { effort: s.effort } : {}) }
    : undefined;
  const p = plan(dial, domain, suggestion);
  return p
    ? {
        key: p.primary.key,
        effort: p.primary.effort,
        why: p.suggestion
          ? p.suggestion.state === "kept"
            ? `kept your ${tier} suggestion`
            : p.suggestion.state === "moved"
              ? `moved off your ${tier} suggestion: ${p.suggestion.cause}${p.suggestion.gainPct !== undefined ? ` +${p.suggestion.gainPct}%` : ""}`
              : `suggestion ignored (${p.suggestion.reason})`
          : `no suggestion on ${tier}: dial pick`,
      }
    : undefined;
}

type Pair = { dial: number; domain: TaskDomain; n: number; ids: string[] };
const pairs = new Map<string, Pair>();
for (const r of rows) {
  const dial = Number.isFinite(r.dial_idx) ? r.dial_idx : 6;
  const domain = (r.domain || "general") as TaskDomain;
  const k = `${dial}|${domain}`;
  const p = pairs.get(k) ?? { dial, domain, n: 0, ids: [] };
  p.n += 1;
  p.ids.push(r.id);
  pairs.set(k, p);
}

console.log("# THALAMUS replay\n");
console.log(
  `Recorded decisions: **${rows.length}** (${pairs.size} distinct dial × domain pairs). Board: ${parts.rungs.length} rungs from ${Object.keys(catalog).length} catalog models.`,
);
console.log(
  `Suggestions read: ${
    Object.entries(suggestions)
      .map(([t, s]) => `${t} → ${s.model}${s.effort ? `@${s.effort}` : ""}`)
      .join("; ") || "(none)"
  }`,
);
console.log(
  "Not recorded, so not replayed: the usage snapshot and the cooling store at the time of each row (supplies are treated as open, nothing is cooling), and the prompt text (the domain is the recorded one). A change that depends on a limit cannot show here.\n",
);

let changedRows = 0;
const lines: string[] = [];
for (const p of [...pairs.values()].sort((a, b) => b.n - a.n)) {
  const o = oldPick(p.dial, p.domain);
  const n = newPick(p.dial, p.domain);
  const changed = !o || !n ? o !== n : o.key !== n.key || o.effort !== n.effort;
  if (changed) changedRows += p.n;
  lines.push(
    `| ${p.dial} (${thalamusTierForBias(p.dial)}) | ${p.domain} | ${p.n} | ${fmt(o)} (${o?.via ?? "-"}) | ${fmt(n)} | ${changed ? "**changes**" : "same"} | ${n?.why ?? "-"} |`,
  );
}
console.log("| dial | domain | rows | old pick | new pick | | why |");
console.log("|---|---|---|---|---|---|---|");
for (const l of lines) console.log(l);
console.log(
  `\n**${changedRows} of ${rows.length} recorded decisions would pick a different model or effort.**`,
);

// A second view: what the shadow router recorded as running, against the suggestion of the stop it was on.
const handPicked = rows.filter((r) => r.switch_reason === "hand-picked").length;
let offSuggestion = 0;
let withSuggestion = 0;
for (const r of rows) {
  if (r.switch_reason === "hand-picked") continue;
  const s = suggestions[thalamusTierForBias(r.dial_idx)];
  if (!s) continue;
  withSuggestion += 1;
  if (boardKey(s.model) !== r.chosen) offSuggestion += 1;
}
console.log(
  `\nOf the ${rows.length - handPicked} recorded decisions on Auto (${handPicked} were hand-picked tabs, which a suggestion never touches), ${withSuggestion} sat on a stop with a suggestion; ${offSuggestion} of those ran a model other than that suggestion.`,
);

// A second table: the same two rules at EVERY stop of the dial, for every domain the rows had plus "general". The
// recorded rows may all sit on one stop (on 2026-10-02 all 91 were on smart), so this is where a change that only shows
// when the dial moves, or when an unset dial becomes the middle stop, can be seen.
const domainsSeen = [
  ...new Set([...pairs.values()].map((x) => x.domain).concat("general" as TaskDomain)),
];
const stops: [number, string][] = [
  [0, "budget"],
  [3, "default"],
  [6, "smart"],
];
console.log("\n## What if the dial were on each stop\n");
console.log("| stop | domain | old pick | new pick | | why |");
console.log("|---|---|---|---|---|---|");
let whatIfChanges = 0;
let whatIfTotal = 0;
for (const [dial, name] of stops) {
  for (const domain of domainsSeen) {
    const o = oldPick(dial, domain);
    const n = newPick(dial, domain);
    const changed = !o || !n ? o !== n : o.key !== n.key || o.effort !== n.effort;
    whatIfTotal += 1;
    if (changed) whatIfChanges += 1;
    console.log(
      `| ${dial} (${name}) | ${domain} | ${fmt(o)} (${o?.via ?? "-"}) | ${fmt(n)} | ${changed ? "**changes**" : "same"} | ${n?.why ?? "-"} |`,
    );
  }
}
console.log(
  `\n**${whatIfChanges} of ${whatIfTotal} (stop, domain) pairs would pick differently.**`,
);
console.log(
  "\nThe unset dial is now the middle stop: with no `orca-bias.json` a turn reads the **default** suggestion, where until today it read smart. The live file exists and says 6, so nothing moves on this machine until it is removed or set from the page.",
);
