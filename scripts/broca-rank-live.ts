// scripts/broca-rank-live.ts
//
// BROCA RANK, LIVE SAMPLE: ask the real Jev to rank recall's candidates for a handful of SYNTHETIC prompts.
//
// WHAT THIS IS FOR. Phase C's tests mock Jev. This is the one place the new question shape meets the real service, so
// the build has a measured latency, a measured answer rate and real verdicts instead of a belief. It goes through the
// same code a live task would: recall -> rankItems -> RoutingReader.rankCandidates -> JevClient (redaction, breaker).
//
// WHAT IT SENDS. Only the synthetic prompts written below (invented tasks, no chat text, no files of any person) and the
// catalogue text of the recalled cards, which the short-list question already sends in production. `synthetic: true`
// is what lets the gate open for these; a real conversation never takes this path.
//
// THE KEY. Read at run time from the gateway's systemd drop-in, held in memory for the Jev client, never printed or
// written. Pass `--key-from <file>` to use another drop-in.
//
//   node --import tsx scripts/broca-rank-live.ts --fixture <ledger fixture.json> --out <result.json> [--budget 2600]

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadQuestions } from "../extensions/tinkerclaw-thalamus/src/reads/questions.js";
import { buildRoutingState } from "../extensions/tinkerclaw-thalamus/src/reads/redact.js";
import {
  DEFAULT_READER_CONFIG,
  RoutingReader,
  type RoutingSituation,
} from "../extensions/tinkerclaw-thalamus/src/reads/routing-reader.js";
import { JevClient } from "../src/infra/jev/jev.js";
import type { JevQuestion, JevVerdict } from "../src/infra/jev/types.js";
import { rankedList, rankItems, type RankResult } from "../src/shared/enhancement-rank.js";
import { createRecall, docFromCard, type RecallDoc } from "../src/shared/enhancement-recall.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

type Synthetic = {
  id: string;
  text: string;
  /** What I expect to see in the USE group, as title fragments (any one counts). Empty: expect nothing in either group. */
  expectUse: string[];
  /** A title fragment I expect in the INSPIRE group, when the prompt is an analogy. */
  expectInspire?: string[];
  why: string;
};

// Invented tasks. Each says what it is testing; none is taken from a real conversation.
const PROMPTS: Synthetic[] = [
  {
    id: "trip",
    text: "Plan a two-week family holiday in Portugal in July: flights from Springfield, a motorhome or a car, and a day-by-day plan with a budget.",
    expectUse: ["plan a family trip"],
    why: "a task a recipe was made for",
  },
  {
    id: "review-page",
    text: "Build a page where my sister can go through three options for the garden, one at a time, and tell me which one she prefers.",
    expectUse: ["review or decision site"],
    why: "a task a recipe was made for, worded without its jargon",
  },
  {
    id: "torrent",
    text: "Find a good-quality copy of an old public-domain film and check the file list is real before downloading anything.",
    expectUse: ["torrent"],
    why: "a skill was made for exactly this",
  },
  {
    id: "loop",
    text: "Keep changing the translation of this paragraph and comparing it with the source until the two match, then stop.",
    expectUse: ["comparison-reward loop"],
    why: "a recipe whose structure is the whole task",
  },
  {
    id: "debug",
    text: "The checkout module's test started failing after yesterday's merge. Find the real cause and fix it once.",
    expectUse: ["debug"],
    why: "a generic engineering recipe",
  },
  {
    id: "gantt",
    text: "Show me a progress chart for the build that two tabs are running, so I can see which phases are done.",
    expectUse: ["gantt"],
    why: "a skill named by what it draws",
  },
  {
    id: "analogy",
    text: "A shop owner wants a screen where a customer compares three quotes, opens each in turn and confirms one, and the owner is told when they press confirm.",
    expectUse: [],
    expectInspire: ["review or decision site", "decision page"],
    why: "a different subject with the structure of a review-or-decision page: the analogy case",
  },
  {
    id: "offtopic",
    text: "What is the capital of Australia, and roughly how many people live there?",
    expectUse: [],
    why: "nothing in the catalogue fits: every answer should be NO",
  },
  {
    id: "compound",
    text: "Write a short paper section explaining our result, make a figure for it, and compile the PDF.",
    expectUse: ["write paper", "paper figures", "compile paper"],
    why: "several cards each cover part of the task",
  },
  {
    id: "terse",
    text: "Okay, go ahead with that.",
    expectUse: [],
    why: "a follow-up with no subject: recall has nothing to go on; any USE here is a guess",
  },
];

type CardRow = {
  card_id: string;
  kind: string;
  name: string;
  path: string | null;
  purpose: string;
  status: string;
};

function keyFromDropIn(path: string): string {
  const text = readFileSync(path, "utf-8");
  const m = /TYPESAFE_API_KEY=("?)([^"\s]+)\1/.exec(text);
  if (!m) throw new Error(`no TYPESAFE_API_KEY line in ${path}`);
  return m[2];
}

const lower = (s: string) => s.toLowerCase();

async function main(): Promise<void> {
  const fixturePath = arg("fixture");
  const outPath = arg("out");
  if (!fixturePath || !outPath) {
    console.error(
      "usage: broca-rank-live.ts --fixture <ledger.json> --out <result.json> [--budget 2600]",
    );
    process.exit(2);
  }
  const budget = Number(arg("budget", "2600"));
  const key = keyFromDropIn(
    arg(
      "key-from",
      join(homedir(), ".config/systemd/user/openclaw-gateway.service.d/typesafe.conf"),
    )!,
  );

  const fx = JSON.parse(readFileSync(fixturePath, "utf-8")) as { cards: CardRow[] };
  const docs: RecallDoc[] = fx.cards
    .filter((c) => c.status === "active")
    .map((c) => {
      let markdown: string | undefined;
      if (c.path) {
        try {
          markdown = readFileSync(c.path, "utf-8");
        } catch {
          /* a plugin card points at a folder */
        }
      }
      return docFromCard(
        {
          id: c.card_id,
          kind: c.kind as RecallDoc["kind"],
          name: c.name,
          purpose: c.purpose,
          path: c.path ?? undefined,
        },
        markdown,
      );
    });
  const byId = new Map(docs.map((d) => [d.id, d] as const));
  const recall = createRecall(docs);

  // Every real call is logged: how many questions, how long, what came back. The key never appears.
  const log: Array<{ questions: number; wallMs: number; verdicts: JevVerdict[] }> = [];
  const client = new JevClient<RoutingSituation>({
    apiKey: () => key,
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    buildState: (s, qs) => buildRoutingState(s, qs),
  });
  const reader = new RoutingReader({
    ask: async (s, qs: JevQuestion[], o) => {
      const t0 = performance.now();
      const verdicts = await client.ask(s, qs as never, o);
      log.push({ questions: qs.length, wallMs: Math.round(performance.now() - t0), verdicts });
      return verdicts;
    },
    questions: loadQuestions(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "extensions",
        "tinkerclaw-thalamus",
        "questions",
      ),
    ),
    cards: () => [],
    config: { ...DEFAULT_READER_CONFIG, jevEnabled: true, budgetMs: budget },
  });

  const out: unknown[] = [];
  const rows: string[][] = [];
  for (const p of PROMPTS) {
    const candidates = recall.recall({ text: p.text });
    const items = rankItems(candidates, byId);
    const before = log.length;
    const res: RankResult = await reader.rankCandidates(
      {
        id: `live-${p.id}`,
        ts: Date.now(),
        sessionKey: "live-check",
        text: p.text,
        source: "tinker",
        synthetic: true,
      },
      items,
      { budgetMs: budget },
    );
    const call = log.length > before ? log[log.length - 1] : undefined;
    const titles = (id: string) => byId.get(id)?.title ?? id;
    const useTitles = res.use.map((e) => titles(e.cardId));
    const inspireTitles = res.inspire.map((e) => titles(e.cardId));
    const hit = (group: string[], frags: string[]) =>
      frags.length === 0 ? undefined : group.some((t) => frags.some((f) => lower(t).includes(f)));
    const useHit = hit(useTitles, p.expectUse);
    const inspireHit = hit(inspireTitles, p.expectInspire ?? []);
    const nothingExpected = p.expectUse.length === 0 && !p.expectInspire;
    out.push({
      id: p.id,
      why: p.why,
      prompt: p.text,
      candidates: items.length,
      questions: call?.questions ?? 0,
      wallMs: call?.wallMs,
      jevMs: res.jevMs,
      tokensIn: call ? Math.round(call.verdicts.reduce((a, v) => a + v.tokensIn, 0)) : 0,
      source: res.source,
      skip: res.skip,
      answered: res.answered,
      dropped: res.dropped,
      use: res.use.map((e) => ({
        title: titles(e.cardId),
        score: Number(e.score.toFixed(3)),
        source: e.source,
      })),
      inspire: res.inspire.map((e) => ({
        title: titles(e.cardId),
        section: e.section,
        sectionSource: e.sectionSource,
        score: Number(e.score.toFixed(3)),
        source: e.source,
      })),
      expectUse: p.expectUse,
      expectInspire: p.expectInspire,
      useHit,
      inspireHit,
      nothingExpected,
      emptyAsExpected: nothingExpected
        ? rankedList(res).filter((e) => e.source === "jev").length === 0
        : undefined,
      useScoreBasis: res.useScoreBasis,
      rawVerdicts: call?.verdicts.map((v) => ({
        q: v.questionId,
        answer: v.answer,
        confidence: v.confidence,
        probs: v.probs,
        skipped: v.skipped,
        cacheHit: v.cacheHit,
      })),
    });
    rows.push([
      p.id,
      String(items.length),
      String(call?.questions ?? 0),
      String(res.jevMs ?? "-"),
      res.source +
        (res.skip ? `/${res.skip}` : "") +
        (res.useScoreBasis ? ` (${res.useScoreBasis})` : ""),
      `${res.use.length}/${res.inspire.length}/${res.dropped}`,
      useHit === undefined ? "-" : useHit ? "yes" : "NO",
      inspireHit === undefined ? "-" : inspireHit ? "yes" : "NO",
    ]);
  }
  writeFileSync(
    outPath,
    JSON.stringify({ takenAt: new Date().toISOString(), budget, results: out }, null, 1),
    {
      mode: 0o600,
    },
  );
  const head = [
    "prompt",
    "cands",
    "questions",
    "ms",
    "list source",
    "USE/INSPIRE/dropped",
    "USE as expected",
    "INSPIRE as expected",
  ];
  console.log(head.join(" | "));
  for (const r of rows) console.log(r.join(" | "));
}

await main();
