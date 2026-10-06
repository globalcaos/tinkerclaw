// scripts/broca-retrieval-replay.ts
//
// BROCA RETRIEVAL REPLAY: how well do today's retrievers, and the new recall stage, find the card the agent opened?
//
// WHAT THIS IS FOR. the architect's retrieval-v2 build (charter 2026-10-05) must answer to a measurement, not to a belief. This
// script reads the ledger THALAMUS keeps (which list each task was shown, which cards the agent then used, the
// redacted prompt), splits it by time, and scores retrievers on the later part. It prints the baseline of the two
// retrievers in use today and, with `--recall`, the new recall stage.
//
// HOW IT STAYS SAFE. It never writes to the live database. Pass `--db <path>`: the file is COPIED to a temp folder
// (with its -wal and -shm) and opened read-only there. `--save-fixture <file>` stores the rows it read; `--fixture
// <file>` replays from that file alone, so a run can be repeated after the live ledger has moved on.
//
//   node --import tsx scripts/broca-retrieval-replay.ts --db ~/.openclaw/data/thalamus-v4/thalamus.sqlite \
//     [--journal <journalctl -o cat export>] [--amygdala-db <path>] [--days 7] [--test-fraction 0.3] \
//     [--recall] [--rank] [--triggers] [--local-floor] [--out <file.md>] [--save-fixture <file.json>]
//
// `--rank` (phase C) runs the new ranking stage over recall's candidates for each held-out task, with Jev replayed from
// the list the ledger recorded for that task (src/shared/enhancement-replay-rank.ts says what that is and is not).
//
// `--triggers` (phase F) runs the nightly loop's trigger-phrase step on the EARLIER part of the window (phrases from its first 60%,
// edits kept or dropped on the rest) and scores the held-out tasks, untouched until then, with the cards before and after.
//
// WHAT IT CANNOT KNOW, and the report says so: why a list was local (the ledger does not keep it), and whether a used
// card was the right one (a use is a proxy for coverage).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import {
  loadRecipeIndex,
  matchRecipesDetailed,
} from "../extensions/tinkerclaw-prefrontal/recipe-matcher.js";
import {
  classifyList,
  latencyStats,
  madridDay,
  nearestAsk,
  parseHookSpans,
  spanFor,
  summarizeAmygdala,
  type AmygdalaAsk,
  type ListClass,
} from "../src/shared/enhancement-budget.js";
import {
  buildRankQuestions,
  interpretRanking,
  rankedList,
  rankItems,
  type RankedEntry,
} from "../src/shared/enhancement-rank.js";
import {
  createRecall,
  docFromCard,
  NAMED_SURFACES,
  toHistoryItem,
  type HistoryItem,
  type RecallDoc,
  type RecallSource,
} from "../src/shared/enhancement-recall.js";
import { stems } from "../src/shared/enhancement-recall.js";
import {
  firstHit,
  recordedVerdicts,
  type Recording,
} from "../src/shared/enhancement-replay-rank.js";
import {
  casesFromRows,
  classifyCase,
  evaluate,
  groupCases,
  houseRuleUse,
  LEDGER_SQL,
  lastDays,
  misses,
  rate,
  repeatsOfTrain,
  splitByTime,
  taskUses,
  type CaseKind,
  type LedgerRow,
  type ReplayCase,
  type Scored,
} from "../src/shared/enhancement-replay.js";
import { isHouseRule, isRuntimeNotice, taskText } from "../src/shared/enhancement-text.js";
import { learnTriggers, splitCases, type TriggerCase } from "../src/shared/enhancement-triggers.js";
import {
  localRank,
  localShortlist,
  type EnhancementCard,
} from "../src/shared/thalamus-enhancements.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type CardRow = {
  card_id: string;
  version: number;
  kind: string;
  name: string;
  path: string | null;
  family: string;
  purpose: string;
  structure: string;
  also_json: string;
  status: string;
  origin: string;
  created_at: number;
};
export type Fixture = { takenAt: number; rows: LedgerRow[]; cards: CardRow[] };

/** Copy the live database next to nothing live, open the copy read-only, take the rows, close it. */
function readFromDb(dbPath: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "broca-replay-"));
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(dir, basename(dbPath) + ext));
  }
  const db = new Database(join(dir, basename(dbPath)), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(LEDGER_SQL).all() as LedgerRow[];
    const cards = db
      .prepare(
        `SELECT card_id, version, kind, name, path, family, purpose, structure, also_json, status, origin, created_at
         FROM enh_cards c WHERE version = (SELECT MAX(version) FROM enh_cards WHERE card_id = c.card_id)`,
      )
      .all() as CardRow[];
    return { takenAt: Date.now(), rows, cards };
  } finally {
    db.close();
  }
}

const cardOf = (r: CardRow): EnhancementCard => ({
  id: r.card_id,
  kind: r.kind as EnhancementCard["kind"],
  name: r.name,
  ...(r.path ? { path: r.path } : {}),
  family: r.family,
  purpose: r.purpose,
  structure: r.structure,
  alsoServed: JSON.parse(r.also_json || "[]") as string[],
  version: r.version,
  status: r.status === "retired" ? "retired" : "active",
  origin: r.origin as EnhancementCard["origin"],
});

// ─── report helpers ─────────────────────────────────────────────────────────────────────────────

const out: string[] = [];
const say = (s = "") => out.push(s);

function table(head: string[], rows: string[][]): void {
  say(`| ${head.join(" | ")} |`);
  say(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) say(`| ${r.join(" | ")} |`);
  say();
}

function scoredRow(label: string, s: Scored): string[] {
  return [
    label,
    String(s.scored),
    rate(s.hit1, s.scored),
    rate(s.hit3, s.scored),
    rate(s.hit5, s.scored),
    rate(s.hit15, s.scored),
    rate(s.pairs15, s.pairs),
  ];
}
const SCORE_HEAD = [
  "retriever / slice",
  "scored cases",
  "hit@1",
  "hit@3",
  "hit@5",
  "hit@15 (cases)",
  "recall@15 (pairs)",
];

/** The same cases with only the uses that are recipes, so a recipe-only retriever is scored on its own ground. */
const recipeOnly = (cs: readonly ReplayCase[]): ReplayCase[] =>
  cs.map((c) => ({ ...c, used: c.used.filter((u) => u.cardId.startsWith("recipe:")) }));

// ─── main ───────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixturePath = arg("fixture");
  const dbPath = arg("db");
  if (!fixturePath && !dbPath) {
    console.error(
      "usage: broca-retrieval-replay.ts (--db <thalamus.sqlite> | --fixture <file.json>) [...]",
    );
    process.exit(2);
  }
  const fx: Fixture = fixturePath
    ? (JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture)
    : readFromDb(dbPath!);
  const saveFixture = arg("save-fixture");
  if (saveFixture) writeFileSync(saveFixture, JSON.stringify(fx), { mode: 0o600 });

  const days = Number(arg("days", "7"));
  const testFraction = Number(arg("test-fraction", "0.3"));
  const all = casesFromRows(fx.rows);
  const window = lastDays(all, days);
  const split = splitByTime(window, testFraction);
  const kindOf = new Map(window.map((c) => [c.taskId, classifyCase(c)] as const));
  const cards = fx.cards.map(cardOf);
  const repeats = repeatsOfTrain(split);
  const iso = (ts: number) => new Date(ts).toISOString().replace(".000Z", "Z");

  say("# BASELINE: today's retrievers on the held-out tasks");
  say();
  say(
    "**What this is for.** The number the retrieval-v2 build answers to: how often the card the agent actually opened was inside the first 1, 3, 5 or 15 suggestions, before any change. " +
      "**Derived from** the THALAMUS ledger (`enh_uses` joined to `enh_replay_set`, redacted prompts), split by time. " +
      "**What would change it:** a retriever scored on a different slice, a ledger that records why a list was local, or a held-out set big enough to separate the retrievers.",
  );
  say();
  say("## 1. The data and the split");
  say();
  table(
    ["item", "value"],
    [
      ["ledger rows with a replay text", String(all.length)],
      [
        "ledger span",
        `${iso(Math.min(...all.map((c) => c.ts)))} to ${iso(Math.max(...all.map((c) => c.ts)))}`,
      ],
      [
        "window used",
        `last ${days} days counted from the newest row: ${window.length} rows (the ledger holds less than 7 days, so this is all of it when span < ${days} days)`,
      ],
      ["train", `${split.train.length} rows before ${iso(split.cutoffTs)}`],
      ["test (held out)", `${split.test.length} rows from ${iso(split.cutoffTs)}`],
      [
        "leakage check",
        `newest train row ${iso(Math.max(...split.train.map((c) => c.ts)))} < oldest test row ${iso(Math.min(...split.test.map((c) => c.ts)))}`,
      ],
      [
        "test rows whose request repeats one in train",
        `${[...repeats].length} of ${split.test.length} (recurring briefs; scored, and shown apart below)`,
      ],
    ],
  );
  const kinds = groupCases(split.test, (c) => kindOf.get(c.taskId) as CaseKind);
  table(
    ["test rows by kind", "rows", "with a task use", "house-rule only", "no use at all"],
    (["interactive", "automated", "runtime"] as const).map((k) => {
      const s = evaluate(kinds.get(k) ?? [], () => []);
      return [k, String(s.cases), String(s.scored), String(s.houseOnly), String(s.zeroUse)];
    }),
  );
  say(
    "interactive = a person typed it; automated = a cron brief; runtime = a notice the gateway or an agent injected (no recommendation is owed to these). " +
      "The headline slice is **interactive**.",
  );
  say();

  const interactive = kinds.get("interactive") ?? [];
  const fullSlices: Array<[string, ReplayCase[]]> = [
    ["interactive", interactive],
    ["automated (cron)", kinds.get("automated") ?? []],
    ["runtime notices", kinds.get("runtime") ?? []],
    ["all test rows", split.test],
  ];

  say("## 2. Retriever 1: the Thalamus list as the agent was shown it");
  say();
  say(
    "The recorded `shown_json`, in rank order: Jev's list when Jev answered inside the budget, `localShortlist` otherwise. " +
      "It holds at most 6 entries, so recall@15 is what is on the list. House rules are kept in the ranking here (the list shows them); the second block drops them.",
  );
  say();
  const served = (c: ReplayCase) => c.shown;
  table(SCORE_HEAD, [
    ...fullSlices.map(([l, cs]) => scoredRow(`as served, ${l}`, evaluate(cs, served))),
    ...fullSlices
      .slice(0, 1)
      .map(([l, cs]) =>
        scoredRow(
          `as served, house rules dropped, ${l}`,
          evaluate(cs, served, { dropHouse: true }),
        ),
      ),
  ]);
  const bySource = groupCases(interactive, (c) => c.listSource);
  table(
    SCORE_HEAD,
    (["jev", "local"] as const).map((k) =>
      scoredRow(`as served, interactive, list from ${k}`, evaluate(bySource.get(k) ?? [], served)),
    ),
  );
  const noRepeat = interactive.filter((c) => !repeats.has(c.taskId));
  table(SCORE_HEAD, [
    scoredRow(
      "as served, interactive, repeats of a train request removed",
      evaluate(noRepeat, served),
    ),
  ]);

  say("## 3. Retriever 1b: the local matcher, re-run on every held-out task");
  say();
  say(
    "`localShortlist` (what a task gets when Jev is late or silent) applied to the cleaned request, for EVERY held-out task, so the local retriever is measured without depending on when Jev happened to answer. " +
      "`localRank` is the same ranking without its thresholds (minimum score 2, two shared words, at most 6).",
  );
  say();
  const localDeployed = (c: ReplayCase) =>
    localShortlist(taskText(c.text), cards).entries.map((e) => e.cardId);
  const localRanked = (c: ReplayCase) => localRank(taskText(c.text), cards).map((r) => r.cardId);
  table(SCORE_HEAD, [
    ...fullSlices
      .slice(0, 1)
      .flatMap(([l, cs]) => [
        scoredRow(
          `localShortlist as deployed, ${l}`,
          evaluate(cs, localDeployed, { dropHouse: true }),
        ),
        scoredRow(`localRank unthresholded, ${l}`, evaluate(cs, localRanked, { dropHouse: true })),
      ]),
  ]);

  say("## 4. Retriever 2: the Broca recipe matcher (`recipe-matcher.ts`)");
  say();
  const recipesDir = arg(
    "recipes",
    join(import.meta.dirname, "..", "extensions", "tinkerclaw-prefrontal", "recipes"),
  )!;
  const overlayDir = arg("overlay", join(homedir(), ".openclaw", "recipes"))!;
  const ownIndex = await loadRecipeIndex(recipesDir, []);
  const withOverlay = await loadRecipeIndex(recipesDir, [overlayDir]);
  const recipeCards = cards.filter((c) => c.kind === "recipe" && c.status === "active");
  const reachable = (idx: typeof ownIndex) => {
    const titles = new Set(idx.map((e) => `recipe:${e.title}`));
    return recipeCards.filter((c) => titles.has(c.id)).length;
  };
  table(
    [
      "catalog the matcher scans",
      "recipes in index",
      "recipe cards it can reach (of " + recipeCards.length + ")",
    ],
    [
      [
        `shipped roots only: \`${recipesDir.replace(homedir(), "~")}\` (+ bridged-skills, absent)`,
        String(ownIndex.length),
        String(reachable(ownIndex)),
      ],
      [
        `plus the overlay \`${overlayDir.replace(homedir(), "~")}\` (NOT scanned today)`,
        String(withOverlay.length),
        String(reachable(withOverlay)),
      ],
    ],
  );
  const matcher =
    (idx: typeof ownIndex, cleaned: boolean, deployed: boolean) => (c: ReplayCase) => {
      const prompt = cleaned ? taskText(c.text) : c.text;
      const r = matchRecipesDetailed(prompt, idx, deployed ? {} : { threshold: 1, max: 1000 });
      return r.matches.map((m) => `recipe:${m.entry.title}`);
    };
  const recipeSlices = fullSlices.slice(0, 1).map(([l, cs]) => [l, recipeOnly(cs)] as const);
  const matcherRows: string[][] = [];
  for (const [l, cs] of recipeSlices) {
    matcherRows.push(
      scoredRow(
        `matcher as deployed (score >= 3, top 3), cleaned text, ${l}`,
        evaluate(cs, matcher(ownIndex, true, true)),
      ),
    );
    matcherRows.push(
      scoredRow(
        `matcher as deployed, raw text with the harness envelope, ${l}`,
        evaluate(cs, matcher(ownIndex, false, true)),
      ),
    );
    matcherRows.push(
      scoredRow(
        `matcher ranking (any score > 0), cleaned text, ${l}`,
        evaluate(cs, matcher(ownIndex, true, false)),
      ),
    );
    matcherRows.push(
      scoredRow(
        `matcher ranking, cleaned text, overlay also scanned, ${l}`,
        evaluate(cs, matcher(withOverlay, true, false)),
      ),
    );
    matcherRows.push(
      scoredRow(
        `for comparison: Thalamus list as served, recipe uses only, ${l}`,
        evaluate(cs, served),
      ),
    );
  }
  table(SCORE_HEAD, matcherRows);
  say(
    "The matcher only knows recipes, so every row in this block is scored on the held-out tasks where the agent used at least one RECIPE. " +
      "It does not run in Tinker chats at all today (the hook returns for any session key that does not end in `:main`); these rows are what it WOULD have done.",
  );
  say();

  say("## 5. House rules, listed apart");
  say();
  table(
    ["house rule", "uses (whole window)", "already on the list"],
    houseRuleUse(window).map((r) => [r.name, String(r.uses), String(r.onList)]),
  );

  say("## 6. The 800 ms budget: how often it was missed, and why");
  say();
  const journalPath = arg("journal");
  if (!journalPath) {
    say(
      "_No `--journal` given: this section needs an export of `journalctl --user -u openclaw-gateway -o cat`._",
    );
    say();
  } else {
    const spans = parseHookSpans(readFileSync(journalPath, "utf-8"), {
      hook: "before_prompt_build",
      plugin: "tinkerclaw-thalamus",
    });
    const classOf = new Map<string, { cls: ListClass; ms: number | null }>();
    for (const c of window) {
      const sp = spanFor(spans, c.ts);
      classOf.set(c.taskId, { cls: classifyList(c, sp), ms: sp?.ms ?? null });
    }
    say(
      `Thalamus's own asks. Source: the gateway journal's \`[hook-span]\` line for \`tinkerclaw-thalamus before_prompt_build\` (${spans.length} spans in the export), joined to the ledger row it belongs to (the span ends 1 to 9 ms after the row is written; ${[...classOf.values()].filter((v) => v.cls !== "no-span").length} of ${window.length} rows joined or were classed before the join). ` +
        "The seam waits at most 800 ms for Jev. A **late** local list took the whole budget (Jev did not answer in time); a **fast** local list returned in under 300 ms (Jev was not waited for).",
    );
    say();
    const classes: ListClass[] = [
      "jev-answered",
      "late-local",
      "fast-local",
      "mid-local",
      "private-source",
      "not-asked",
      "no-span",
    ];
    const tableFor = (cs: readonly ReplayCase[]) =>
      classes.map((k) => {
        const n = cs.filter((c) => classOf.get(c.taskId)?.cls === k).length;
        return [k, rate(n, cs.length)];
      });
    const tinker = window.filter((c) => c.source === "tinker");
    table(["list class, source = tinker (interactive chats)", "share of lists"], tableFor(tinker));
    table(["list class, every source", "share of lists"], tableFor(window));
    const jevMs = window
      .filter((c) => classOf.get(c.taskId)?.cls === "jev-answered")
      .flatMap((c) => classOf.get(c.taskId)?.ms ?? []);
    const st = latencyStats(jevMs);
    say(
      `When Jev DID answer (n=${st.n}): hook time p50 ${st.p50} ms, p90 ${st.p90} ms, p99 ${st.p99} ms, max ${st.max} ms; ` +
        `${st.over800} of ${st.n} at or over 800 ms (the seam cuts at 800, so none past ~900 are answers).`,
    );
    const lateMs = window
      .filter((c) => classOf.get(c.taskId)?.cls === "late-local")
      .flatMap((c) => classOf.get(c.taskId)?.ms ?? []);
    const lt = latencyStats(lateMs);
    say(
      `When the list was LATE (n=${lt.n}): hook time p50 ${lt.p50} ms, p90 ${lt.p90} ms, max ${lt.max} ms; ${lt.over1500} of ${lt.n} at or over 1500 ms. ` +
        "The prompt waited longer than the 800 ms budget in those: the budget bounds the Jev wait, not the hook.",
    );
    say();

    const amyPath = arg("amygdala-db");
    const amyFixture = arg("amygdala-fixture");
    if (amyPath || amyFixture) {
      type AmyFixture = { asks: AmygdalaAsk[]; questions: Array<{ q: string; n: number }> };
      let amy: AmyFixture;
      if (amyFixture) {
        amy = JSON.parse(readFileSync(amyFixture, "utf-8")) as AmyFixture;
      } else {
        const dir = mkdtempSync(join(tmpdir(), "broca-amy-"));
        for (const ext of ["", "-wal", "-shm"]) {
          if (existsSync(amyPath + ext))
            copyFileSync(amyPath + ext, join(dir, basename(amyPath!) + ext));
        }
        const adb = new Database(join(dir, basename(amyPath!)), {
          readonly: true,
          fileMustExist: true,
        });
        const since = Math.min(...window.map((c) => c.ts)) - 60_000;
        const rows = adb
          .prepare(
            `SELECT s.ts AS ts, v.skipped AS skipped, COALESCE(v.latency_ms, 0) AS latencyMs
             FROM situations s JOIN verdicts v ON v.situation_id = s.id
             WHERE s.seam = 'prompt' AND s.ts >= ? ORDER BY s.ts`,
          )
          .all(since) as AmygdalaAsk[];
        for (const a of rows) a.skipped = a.skipped ?? null;
        const questions = adb
          .prepare(
            `SELECT v.question_id AS q, COUNT(*) AS n FROM situations s JOIN verdicts v ON v.situation_id = s.id
             WHERE s.seam = 'prompt' AND s.ts >= ? GROUP BY 1`,
          )
          .all(since) as Array<{ q: string; n: number }>;
        adb.close();
        amy = { asks: rows, questions };
        const saveAmy = arg("save-amygdala-fixture");
        if (saveAmy) writeFileSync(saveAmy, JSON.stringify(amy), { mode: 0o600 });
      }
      const asks = amy.asks;
      const questions = amy.questions;
      const sum = summarizeAmygdala(asks);
      say(
        "**The amygdala's own asks** (its verdict table, prompt seam, same period). It asks one question per prompt " +
          `(${questions.map((q) => `\`${q.q}\` ×${q.n}`).join(", ")}); no enhancement-ranking question rides on it, and its verdicts do not feed the list.`,
      );
      say();
      table(
        ["amygdala prompt-seam asks", "count", "share"],
        [
          ["asks", String(sum.asks), ""],
          ["answered", String(sum.answered), rate(sum.answered, sum.asks)],
          ...Object.entries(sum.bySkip).map(([k, n]) => [
            `skipped: ${k}`,
            String(n),
            rate(n, sum.asks),
          ]),
        ],
      );
      const al = sum.answeredLatency;
      say(
        `Answered asks: latency p50 ${al.p50} ms, p90 ${al.p90} ms, p99 ${al.p99} ms; ${al.over800} of ${al.n} at or over 800 ms, ${al.over1500} at or over 1500 ms.`,
      );
      say();
      const sorted = asks.toSorted((a, b) => a.ts - b.ts);
      const cross = new Map<string, number>();
      for (const c of tinker) {
        const cls = classOf.get(c.taskId)?.cls;
        if (cls !== "fast-local" && cls !== "late-local" && cls !== "jev-answered") continue;
        const a = nearestAsk(sorted, c.ts, 20_000);
        const key = `${cls} | amygdala nearest ask: ${a ? (a.skipped ?? "answered") : "none within 20 s"}`;
        cross.set(key, (cross.get(key) ?? 0) + 1);
      }
      say(
        "**Association, by time and not by turn** (nearest amygdala ask within 20 s of each Thalamus list, source = tinker). " +
          "The two plugins build separate Jev clients, each with its own breaker, so a match points at a common cause (Jev failing at that moment), not at a shared switch.",
      );
      say();
      table(
        ["Thalamus list | amygdala state at that time", "lists"],
        [...cross.entries()].toSorted((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n)]),
      );
    }

    const days2 = [...new Set(window.map((c) => madridDay(c.ts)))].toSorted();
    table(
      ["day (Madrid)", "tinker lists", "jev-answered", "late-local", "fast-local"],
      days2.map((d) => {
        const cs = tinker.filter((c) => madridDay(c.ts) === d);
        const n = (k: ListClass) => cs.filter((c) => classOf.get(c.taskId)?.cls === k).length;
        return [
          d,
          String(cs.length),
          String(n("jev-answered")),
          String(n("late-local")),
          String(n("fast-local")),
        ];
      }),
    );
  }

  if (
    flag("recall") ||
    flag("recall-test") ||
    flag("rank") ||
    flag("triggers") ||
    flag("local-floor")
  ) {
    // The catalogue as the recall stage sees it: each active card plus its file. A file's modification time is kept, so a
    // card whose text may have been written AFTER the cutoff (possibly because of a held-out task) is reported apart.
    const mtimes = new Map<string, number | null>();
    const docs: RecallDoc[] = cards
      .filter((c) => c.status === "active")
      .map((c) => {
        let markdown: string | undefined;
        let mtime: number | null = null;
        if (c.path) {
          try {
            markdown = readFileSync(c.path, "utf-8");
            mtime = statSync(c.path).mtimeMs;
          } catch {
            /* a plugin card points at a folder; it is matched on its purpose */
          }
        }
        mtimes.set(c.id, mtime);
        return docFromCard(
          { id: c.id, kind: c.kind, name: c.name, purpose: c.purpose, path: c.path },
          markdown,
        );
      });
    const recallStage = createRecall(docs);
    // Entries of the surface map whose wording first reached AGENTS.md AFTER the cutoff (git log -S on workspace/AGENTS.md,
    // 2026-10-06): build-gantt and master-worker 2026-10-05 03:21, give-goku-access 2026-10-05 11:18. Cutoff: 2026-10-03 23:28 Madrid.
    const postCutoff = new Set(["gantt", "master-worker", "goku-login"]);
    const recallAsOfCutoff = createRecall(docs, {
      surfaces: NAMED_SURFACES.filter((s) => !postCutoff.has(s.id)),
    });
    const inCatalog = new Set(docs.map((d) => d.id));

    // Eligible history: a request with at least one task use, typed by a person or sent by cron (never a runtime notice).
    const histAll = window
      .filter((c) => kindOf.get(c.taskId) !== "runtime" && taskUses(c).length > 0)
      .map((c) => ({ c, item: toHistoryItem(c.text, taskUses(c)) }));
    const bySession = new Map<string, ReplayCase[]>();
    for (const c of window) bySession.set(c.session, [...(bySession.get(c.session) ?? []), c]);

    const queryFor = (
      c: ReplayCase,
      sources?: readonly RecallSource[],
      weights?: Partial<Record<RecallSource, number>>,
    ) => {
      // History may only come from earlier rows of the TRAIN half, so a held-out answer never reaches its candidates.
      const history: HistoryItem[] = histAll
        .filter((h) => h.c.ts < c.ts && h.c.ts < split.cutoffTs)
        .map((h) => h.item);
      // The chat's own earlier turns, strictly before this one: what a live chat would already have recorded.
      const recent: string[] = [];
      for (const prev of (bySession.get(c.session) ?? [])
        .filter((p) => p.ts < c.ts)
        .toSorted((a, b) => b.ts - a.ts)) {
        for (const id of taskUses(prev))
          if (inCatalog.has(id) && !recent.includes(id)) recent.push(id);
        if (recent.length >= 6) break;
      }
      return {
        text: c.text,
        history,
        recent: recent.slice(0, 6),
        ...(sources ? { sources } : {}),
        ...(weights ? { weights } : {}),
      };
    };
    const rankWith =
      (sources?: readonly RecallSource[], weights?: Partial<Record<RecallSource, number>>) =>
      (c: ReplayCase) =>
        recallStage.recall(queryFor(c, sources, weights)).map((x) => x.cardId);
    // A use of a card that is not in the catalogue (the `jarvis` MCP server, say) cannot be returned by any retriever.
    const reachable = (cs: readonly ReplayCase[]): ReplayCase[] =>
      cs.map((c) => ({ ...c, used: c.used.filter((u) => inCatalog.has(u.cardId)) }));
    const unreachableNote = (cs: readonly ReplayCase[]) => {
      const gone = new Map<string, number>();
      for (const c of cs)
        for (const id of taskUses(c)) if (!inCatalog.has(id)) gone.set(id, (gone.get(id) ?? 0) + 1);
      return (
        [...gone.entries()]
          .toSorted((a, b) => b[1] - a[1])
          .map(([id, n]) => `${id} x${n}`)
          .join(", ") || "none"
      );
    };

    const kindsOf = (cs: readonly ReplayCase[], k: CaseKind) =>
      cs.filter((c) => kindOf.get(c.taskId) === k);
    const devAll = split.train;
    const devInteractive = kindsOf(devAll, "interactive");
    const sliceTable = (
      title: string,
      interactiveCases: ReplayCase[],
      more: Array<[string, ReplayCase[]]>,
    ) => {
      const sources: Array<[string, RecallSource[] | undefined]> = [
        ["all four sources", undefined],
        ["text only", ["text"]],
        ["history only", ["history"]],
        ["session only", ["session"]],
        ["surface only", ["surface"]],
        ["without surface", ["session", "text", "history"]],
        ["without session", ["surface", "text", "history"]],
        ["without history", ["surface", "session", "text"]],
      ];
      say(`### ${title}`);
      say();
      say(
        `Uses of cards that are not in the catalogue, so no retriever could return them: ${unreachableNote(interactiveCases)}.`,
      );
      say();
      table(SCORE_HEAD, [
        scoredRow(
          "recall, all four sources, interactive, ALL uses",
          evaluate(interactiveCases, rankWith()),
        ),
        ...sources.map(([l, src]) =>
          scoredRow(
            `recall, ${l}, interactive, reachable uses`,
            evaluate(reachable(interactiveCases), rankWith(src)),
          ),
        ),
        ...more.map(([l, cs]) =>
          scoredRow(
            `recall, all four sources, ${l}, reachable uses`,
            evaluate(reachable(cs), rankWith()),
          ),
        ),
      ]);
    };

    say("## 7. Recall stage (phase B)");
    say();
    say(
      `Catalogue: ${docs.length} active cards (${docs.filter((d) => d.kind === "recipe").length} recipes, ${docs.filter((d) => d.kind === "skill").length} skills, ${docs.filter((d) => d.kind === "plugin").length} plugins), ` +
        `${docs.reduce((n, d) => n + d.sections.length, 0)} section titles indexed. Up to 15 candidates per request; house rules and runtime notices excluded. ` +
        "**Development split** = the training half scored walk-forward (history only from EARLIER training rows); weights were chosen here. **Test** = the held-out half, run once with the settings frozen.",
    );
    say();
    sliceTable(
      "7a. Development split (training half, walk-forward)",
      kindsOf(devAll, "interactive"),
      [["automated (cron)", kindsOf(devAll, "automated")]],
    );
    const devMiss = misses(devInteractive, rankWith(), 15);
    say(
      `Development misses (interactive): ${devMiss.length} pairs missed of ${evaluate(devInteractive, rankWith()).pairs}.`,
    );
    say();
    if (flag("tune")) {
      // A small grid on the DEVELOPMENT split only, to choose the merge weights. The test half is never touched here.
      const grid: Array<[string, Partial<Record<RecallSource, number>>]> = [];
      for (const session of [1, 1.5, 2.5]) {
        for (const history of [0.5, 1, 1.5])
          grid.push([`session ${session}, history ${history}`, { session, history }]);
      }
      const rows = grid.map(([label, w]) => {
        const s2 = evaluate(reachable(devInteractive), rankWith(undefined, w));
        return [
          label,
          rate(s2.hit1, s2.scored),
          rate(s2.hit3, s2.scored),
          rate(s2.hit5, s2.scored),
          rate(s2.hit15, s2.scored),
          rate(s2.pairs15, s2.pairs),
        ];
      });
      table(
        ["weights (text 1, surface 3)", "hit@1", "hit@3", "hit@5", "hit@15", "recall@15 pairs"],
        rows,
      );
    }
    if (flag("dev-misses")) {
      const byDev = new Map(devInteractive.map((c) => [c.taskId, c]));
      const devRows = devMiss.map((m) => {
        const c = byDev.get(m.taskId)!;
        const found = (["surface", "session", "text", "history"] as const).filter((src) =>
          recallStage
            .recall({ ...queryFor(c, [src]), max: 400 })
            .some((x) => x.cardId === m.cardId),
        );
        return [
          `\`${m.cardId.slice(0, 44)}\``,
          m.position === null ? "-" : String(m.position + 1),
          found.join(","),
          `\`${taskText(c.text).replace(/\s+/g, " ").slice(0, 80).replace(/\|/g, "/")}\``,
        ];
      });
      table(
        ["card used", "rank in the 15-list", "sources that find it at ANY depth", "request"],
        devRows,
      );
    }

    if (flag("recall-test")) {
      sliceTable(
        "7b. Held-out test split (run once, settings frozen)",
        kindsOf(split.test, "interactive"),
        [
          ["automated (cron)", kindsOf(split.test, "automated")],
          ["runtime notices (none owed)", kindsOf(split.test, "runtime")],
          [
            "interactive, repeats of a train request removed",
            kindsOf(split.test, "interactive").filter((c) => !repeats.has(c.taskId)),
          ],
        ],
      );
      const testInteractive = kindsOf(split.test, "interactive");
      const rank = rankWith();
      const asOfCutoff = evaluate(reachable(testInteractive), (c) =>
        recallAsOfCutoff.recall(queryFor(c)).map((x) => x.cardId),
      );
      table(SCORE_HEAD, [
        scoredRow(
          "recall, all four sources, surface map as it stood at the cutoff (3 later entries removed), interactive, reachable uses",
          asOfCutoff,
        ),
      ]);
      const times: number[] = [];
      for (const c of testInteractive) {
        const q = queryFor(c);
        const t0 = performance.now();
        recallStage.recall(q);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      say(
        `Recall time per request over ${times.length} held-out requests: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms (budget: under 50 ms).`,
      );
      say();

      // Pairs split by whether the card's file may predate the cutoff.
      const frozen = { found: 0, pairs: 0 };
      const later = { found: 0, pairs: 0 };
      const unknown = { found: 0, pairs: 0 };
      const missed = misses(testInteractive, rank, 15);
      const missedKey = new Set(missed.map((m) => `${m.taskId}|${m.cardId}`));
      for (const c of testInteractive) {
        for (const id of taskUses(c)) {
          const mt = mtimes.get(id);
          const bucket = mt == null ? unknown : mt <= split.cutoffTs ? frozen : later;
          bucket.pairs += 1;
          if (!missedKey.has(`${c.taskId}|${id}`)) bucket.found += 1;
        }
      }
      table(
        ["interactive test pairs, by the age of the card's file", "pairs", "found in the first 15"],
        [
          [
            "file last changed BEFORE the cutoff (no way to have been written for a held-out task)",
            String(frozen.pairs),
            rate(frozen.found, frozen.pairs),
          ],
          [
            "file changed AFTER the cutoff (its text may have been written because of a held-out task)",
            String(later.pairs),
            rate(later.found, later.pairs),
          ],
          [
            "no file (plugin: matched on its purpose)",
            String(unknown.pairs),
            rate(unknown.found, unknown.pairs),
          ],
        ],
      );

      // Which source finds the pairs of each file-age bucket, to tell leaked card text from plain use concentration.
      const srcAll = ["text", "history", "session", "surface"] as const;
      const found = new Map<string, Set<string>>();
      for (const src of srcAll) {
        const rk = rankWith([src]);
        const hit = new Set<string>();
        for (const c of reachable(testInteractive)) {
          const top = rk(c).slice(0, 15);
          for (const id of taskUses(c)) if (top.includes(id)) hit.add(`${c.taskId}|${id}`);
        }
        found.set(src, hit);
      }
      const bucketRows = (["before", "after"] as const).map((b) => {
        const keys = reachable(testInteractive).flatMap((c) =>
          taskUses(c)
            .filter((id) => {
              const mt = mtimes.get(id);
              return mt != null && (b === "before" ? mt <= split.cutoffTs : mt > split.cutoffTs);
            })
            .map((id) => `${c.taskId}|${id}`),
        );
        return [
          b === "before" ? "file last changed BEFORE the cutoff" : "file changed AFTER the cutoff",
          String(keys.length),
          ...srcAll.map((src) =>
            rate(keys.filter((k) => found.get(src)!.has(k)).length, keys.length),
          ),
        ];
      });
      table(
        ["pairs by file age, found by one source alone (first 15)", "pairs", ...srcAll],
        bucketRows,
      );
      const noticeCases = kindsOf(split.test, "runtime");
      const marked = noticeCases.filter((c) => isRuntimeNotice(c.text));
      const markedServed = marked.filter((c) => rankWith()(c).length > 0).length;
      say(
        `Runtime rows in the held-out half: ${noticeCases.length}. Of those, ${marked.length} carry a notice marker in their text and ${markedServed} of them received a candidate (none are owed). ` +
          `The other ${noticeCases.length - marked.length} are subagent or orchestrator prompts with ordinary text; the recall stage cannot see the source, so it answers them like any request (whether to serve subagents is the hook's decision, phase E).`,
      );
      say();

      // What the misses have in common.
      const feat = new Map<string, number>();
      const bump = (k: string) => feat.set(k, (feat.get(k) ?? 0) + 1);
      const rows: string[][] = [];
      const byId = new Map(testInteractive.map((c) => [c.taskId, c]));
      for (const m of missed) {
        const c = byId.get(m.taskId)!;
        const t = taskText(c.text);
        bump(
          m.cardId.split(":")[0] === "plugin"
            ? "the card is a plugin"
            : m.cardId.startsWith("recipe:")
              ? "the card is a recipe"
              : "the card is a skill",
        );
        if (!inCatalog.has(m.cardId)) bump("the card is not in the catalogue");
        if (t.length < 60) bump("request shorter than 60 characters");
        if (stems(t).length < 4) bump("fewer than 4 informative words");
        if (m.position !== null) bump("found, but past position 15");
        const recent = queryFor(c).recent;
        if (recent.length === 0) bump("no earlier turn in this chat used a card");
        rows.push([
          `\`${m.cardId.slice(0, 48)}\``,
          String(t.length),
          `\`${t.replace(/\s+/g, " ").slice(0, 70).replace(/\|/g, "/")}\``,
        ]);
      }
      table(
        ["what the missed pairs share", "missed pairs (of " + missed.length + ")"],
        [...feat.entries()].toSorted((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n)]),
      );
      say("Every missed pair on the held-out interactive requests:");
      say();
      table(
        ["card the agent used", "request length", "request (first 70 characters, redacted)"],
        rows,
      );
    }

    if (flag("rank")) {
      say(
        "## 9. Phase C: the ranking stage over recall's candidates, Jev replayed from the ledger",
      );
      say();
      say(
        "**What this is for.** To score the new ranking stage (USE group, then INSPIRE group, each entry labelled jev or local) on the held-out tasks before any live sample. " +
          "**Derived from** the recall stage's fifteen candidates per task, run through `enhancement-rank.ts`, with a mocked Jev that says what the ledger recorded for that task (`enhancement-replay-rank.ts`). " +
          "**What it is not:** Jev ranking these fifteen. The recorded list was made from the whole catalogue in another question shape and holds at most six cards; a candidate it did not name has no answer and stays local. So this shows how the pipeline orders recorded Jev picks and recall's rest. The live sample is the measurement of Jev. " +
          "**What would change it:** a ledger that keeps Jev's per-question verdicts.",
      );
      say();
      const docById = new Map(docs.map((d) => [d.id, d] as const));
      const testInteractive = kindsOf(split.test, "interactive");
      const rankCase = (c: ReplayCase, asRecorded: boolean) => {
        const items = rankItems(recallStage.recall(queryFor(c)), docById);
        const built = buildRankQuestions(items);
        const rec: Recording = {
          listSource: asRecorded ? c.listSource : "local",
          shown: c.shown.map((id) => ({ cardId: id, prob: c.shownProbs?.[id] ?? 0 })),
        };
        const res = interpretRanking(items, built, recordedVerdicts(items, built, rec));
        return { res, list: rankedList(res) };
      };
      const cache = new Map<string, ReturnType<typeof rankCase>>();
      const cached = (c: ReplayCase, asRecorded: boolean) => {
        const key = `${c.taskId}|${asRecorded}`;
        let v = cache.get(key);
        if (!v) {
          v = rankCase(c, asRecorded);
          cache.set(key, v);
        }
        return v;
      };
      const recorded = (c: ReplayCase) => cached(c, true).list.map((e) => e.cardId);
      const allLocal = (c: ReplayCase) => cached(c, false).list.map((e) => e.cardId);
      const useOnly = (c: ReplayCase) => cached(c, true).res.use.map((e) => e.cardId);
      const rows: string[][] = [];
      for (const [label, cs] of [
        ["interactive, ALL uses (as in section 7b)", testInteractive],
        ["interactive, reachable uses", reachable(testInteractive)],
      ] as const) {
        rows.push(
          scoredRow(`recall order (section 7b), ${label}`, evaluate(cs, rankWith())),
          scoredRow(
            `ranker, every entry local (no Jev), USE then INSPIRE, ${label}`,
            evaluate(cs, allLocal),
          ),
          scoredRow(
            `ranker, Jev replayed from the ledger, USE then INSPIRE, ${label}`,
            evaluate(cs, recorded),
          ),
          scoredRow(`ranker, Jev replayed, USE group only, ${label}`, evaluate(cs, useOnly)),
        );
      }
      table(SCORE_HEAD, rows);

      const bySource = groupCases(testInteractive, (c) => c.listSource);
      table(
        SCORE_HEAD,
        [...bySource.entries()].map(([src, cs]) =>
          scoredRow(
            `ranker, Jev replayed, tasks whose recorded list came from ${src}, all uses`,
            evaluate(cs, recorded),
          ),
        ),
      );

      // Who made the first hit, when there is one in the first three.
      const tally = { jev: 0, local: 0, none: 0, noJevEntry: 0, scored: 0 };
      const jevOnList: string[][] = [];
      for (const c of testInteractive) {
        const used = new Set(taskUses(c));
        if (used.size === 0) continue;
        tally.scored += 1;
        const { res, list } = cached(c, true);
        if (!list.some((e) => e.source === "jev")) tally.noJevEntry += 1;
        const hit = firstHit(list.slice(0, 3), used);
        if (!hit) tally.none += 1;
        else tally[hit.source] += 1;
        if (c.listSource === "jev") {
          const at = firstHit(list, used);
          jevOnList.push([
            `\`${taskText(c.text).replace(/\s+/g, " ").slice(0, 60).replace(/\|/g, "/")}\``,
            at ? `${at.position + 1} (${at.source})` : "not in the 15",
            String(
              res.use.filter((e) => e.source === "jev").length +
                res.inspire.filter((e) => e.source === "jev").length,
            ),
          ]);
        }
      }
      say(
        `First used card inside the first 3 of the ranked list (recorded Jev), ${tally.scored} scored tasks: from a Jev entry ${tally.jev}, from a local entry ${tally.local}, not in the first 3: ${tally.none}. ` +
          `Tasks whose ranked list held no Jev entry at all (the recorded list named none of the fifteen, or was local): ${tally.noJevEntry} of ${tally.scored}.`,
      );
      say();
      // Every task where the first used card crossed the first-3 line between recall order and the ranked list.
      const moved: string[][] = [];
      const posIn = (ids: readonly string[], used: ReadonlySet<string>) => {
        const at = ids.findIndex((id) => used.has(id));
        return at < 0 ? "-" : String(at + 1);
      };
      for (const c of testInteractive) {
        const used = new Set(taskUses(c));
        if (used.size === 0) continue;
        const before = rankWith()(c);
        const after = cached(c, true).list;
        const b = before.findIndex((id) => used.has(id));
        const a = after.findIndex((e) => used.has(e.cardId));
        if ((b >= 0 && b < 3) === (a >= 0 && a < 3)) continue;
        const hit = a >= 0 ? after[a] : undefined;
        moved.push([
          `\`${taskText(c.text).replace(/\s+/g, " ").slice(0, 50).replace(/\|/g, "/")}\``,
          posIn(before, used),
          posIn(
            after.map((e) => e.cardId),
            used,
          ),
          hit
            ? `${hit.mode}${hit.section ? ` (section: ${hit.section.slice(0, 30)})` : ""}, ${hit.source}`
            : "-",
        ]);
      }
      say(
        `Tasks whose first used card crossed the first-3 line between recall order and the ranked list (${moved.length}). Mode is what the ranker gave the used card; a local entry's mode is recall's own guess:`,
      );
      say();
      table(
        [
          "request (first 50 characters, redacted)",
          "position, recall order",
          "position, ranked list",
          "the used card's entry",
        ],
        moved,
      );

      say(
        "The tasks whose recorded list came from Jev, one by one (position of the first used card on the ranked list and whose entry it is):",
      );
      say();
      table(
        [
          "request (first 60 characters, redacted)",
          "first used card at",
          "Jev entries on the list",
        ],
        jevOnList,
      );
    }

    if (flag("triggers")) {
      say("## 10. Phase F: trigger phrases learned from off-list uses, scored on held-out tasks");
      say();
      say(
        "**What this is for.** The charter asks that an off-list use teaches its card the key phrases of the task, as a versioned, bounded, reversible edit, kept only when it helps tasks it was not derived from, and that the held-out hit@3 be reported before and after on the replay set. " +
          "**Derived from** the nightly loop's own step (`enhancement-triggers.ts`): phrases come from the earlier 60% of the earlier 70% of the window (the development half), an edit is kept or dropped on the other 40% of that half (validation), and the held-out half (the same 30% as sections 7 to 9) is scored once, with the cards before and after, with nothing learned from it. " +
          "**What would change it:** a longer ledger (the validation part is a handful of tasks), or a held-out set big enough to see a few points.",
      );
      say();
      const markdownOf = new Map<string, string | undefined>();
      for (const c of cards) {
        let md: string | undefined;
        if (c.path) {
          try {
            md = readFileSync(c.path, "utf-8");
          } catch {
            /* a plugin card points at a folder */
          }
        }
        markdownOf.set(c.id, md);
      }
      const built = new WeakMap<readonly EnhancementCard[], ReturnType<typeof createRecall>>();
      const recallOf = (cs: readonly EnhancementCard[]) => {
        let r = built.get(cs);
        if (!r) {
          r = createRecall(
            cs
              .filter((c) => c.status === "active")
              .map((c) =>
                docFromCard(
                  {
                    id: c.id,
                    kind: c.kind,
                    name: c.name,
                    purpose: c.purpose,
                    path: c.path,
                    alsoServed: c.alsoServed,
                  },
                  markdownOf.get(c.id),
                ),
              ),
          );
          built.set(cs, r);
        }
        return r;
      };
      // Decisions use the stateless retriever the nightly loop has (text and surface map), as production does.
      const decide = (text: string, cs: readonly EnhancementCard[]) =>
        recallOf(cs)
          .recall({ text, sources: ["text", "surface"] })
          .map((x) => x.cardId);

      const dev: TriggerCase[] = split.train
        .filter((c) => kindOf.get(c.taskId) !== "runtime")
        .map((c) => ({
          taskId: c.taskId,
          ts: c.ts,
          text: c.text,
          used: c.used
            .filter((u) => !isHouseRule(u.cardId) && inCatalog.has(u.cardId))
            .map((u) => ({ cardId: u.cardId, onList: u.onList })),
        }))
        .filter((c) => c.used.length > 0);
      const parts = splitCases(dev);
      const result = learnTriggers({ cases: dev, cards, rank: decide });
      const after = result.cards;
      const edited = result.attempts.filter((a) => a.kept);
      table(
        ["item", "value"],
        [
          [
            "development half (earlier tasks with a task use, runtime notices out)",
            String(dev.length),
          ],
          [
            "phrases taken from (earlier 60%)",
            `${parts.train.length} tasks, up to ${iso(Math.max(...parts.train.map((c) => c.ts)))}`,
          ],
          [
            "edits kept or dropped on (later 40%)",
            `${parts.validation.length} tasks, from ${iso(Math.min(...parts.validation.map((c) => c.ts)))}`,
          ],
          [
            "held-out half, scored once below",
            `${split.test.length} rows from ${iso(split.cutoffTs)}`,
          ],
          [
            "cards with at least 2 off-list uses in the phrase part",
            String(result.attempts.length),
          ],
          ["edits kept", String(edited.length)],
        ],
      );
      if (result.attempts.length > 0) {
        table(
          [
            "card",
            "off-list tasks (phrase part)",
            "phrases",
            "validation tasks scored",
            "hit@3 before to after",
            "weighted MRR before to after",
            "decision",
          ],
          result.attempts.map((a) => [
            `\`${a.cardId.slice(0, 40)}\``,
            String(a.examples),
            a.phrases.length ? a.phrases.map((p) => `\`${p}\``).join(", ") : "none",
            String(a.n),
            `${a.hit3Before} to ${a.hit3After}`,
            `${a.before.toFixed(3)} to ${a.after.toFixed(3)}`,
            a.kept ? "kept" : a.why,
          ]),
        );
      }
      say(
        `Validation hit@3 over the whole pass, cards as they were against cards as they end: **${result.hit3.before} to ${result.hit3.after} of ${result.hit3.n}** scored (card, task) pairs.`,
      );
      say();

      // The held-out half, once, with the cards before and after. Two retrievers: the stateless one the loop decides with, and
      // the whole recall stage with each chat's own history (as sections 7 to 9 score it).
      const heldOut = reachable(kindsOf(split.test, "interactive"));
      const statelessWith = (cs: readonly EnhancementCard[]) => (c: ReplayCase) =>
        recallOf(cs)
          .recall({ text: c.text, sources: ["text", "surface"] })
          .map((x) => x.cardId);
      const fullWith = (cs: readonly EnhancementCard[]) => (c: ReplayCase) =>
        recallOf(cs)
          .recall(queryFor(c))
          .map((x) => x.cardId);
      say(
        "### Held-out tasks (interactive, with a task use), cards before and after the learned phrases",
      );
      say();
      table(SCORE_HEAD, [
        scoredRow(
          "text and surface only, cards before",
          evaluate(heldOut, statelessWith(cards), { dropHouse: true }),
        ),
        scoredRow(
          "text and surface only, cards after",
          evaluate(heldOut, statelessWith(after), { dropHouse: true }),
        ),
        scoredRow(
          "whole recall stage, cards before",
          evaluate(heldOut, fullWith(cards), { dropHouse: true }),
        ),
        scoredRow(
          "whole recall stage, cards after",
          evaluate(heldOut, fullWith(after), { dropHouse: true }),
        ),
      ]);
      // What moved, task by task, on the whole retriever.
      const pos = (cs: readonly EnhancementCard[], c: ReplayCase): number | undefined => {
        const order = fullWith(cs)(c).filter((id) => !isHouseRule(id));
        const wanted = new Set(taskUses(c));
        const i = order.findIndex((id) => wanted.has(id));
        return i < 0 ? undefined : i + 1;
      };
      let better = 0;
      let worse = 0;
      let same = 0;
      const moved: string[][] = [];
      for (const c of heldOut.filter((x) => taskUses(x).length > 0)) {
        const b = pos(cards, c);
        const a = pos(after, c);
        const key = (v: number | undefined) => v ?? 99;
        if (key(a) < key(b)) better += 1;
        else if (key(a) > key(b)) worse += 1;
        else same += 1;
        if (key(a) !== key(b))
          moved.push([
            `\`${taskText(c.text).replace(/\s+/g, " ").slice(0, 60).replace(/\|/g, "/")}\``,
            b === undefined ? "not in 15" : String(b),
            a === undefined ? "not in 15" : String(a),
          ]);
      }
      say(
        `Held-out tasks whose first used card moved on the whole retriever: ${better} better, ${worse} worse, ${same} unchanged.`,
      );
      say();
      if (moved.length > 0)
        table(
          ["request (first 60 characters, redacted)", "first used card before", "after"],
          moved,
        );

      // Leakage: every learned phrase, and where its words are found.
      if (edited.length > 0) {
        const norm = (t: string) => taskText(t).toLowerCase();
        table(
          [
            "learned phrase",
            "tasks of the phrase part that contain it",
            "validation tasks",
            "held-out tasks",
          ],
          edited.flatMap((a) =>
            a.phrases.map((p) => [
              `\`${p}\``,
              String(parts.train.filter((c) => norm(c.text).includes(p)).length),
              String(parts.validation.filter((c) => norm(c.text).includes(p)).length),
              String(split.test.filter((c) => norm(c.text).includes(p)).length),
            ]),
          ),
        );
      }
      say(
        "Leakage: phrases are taken from the phrase part only (the code never reads the later parts when it chooses them, and a test pins that). " +
          "The held-out count of a phrase is shown so a phrase that only exists in held-out tasks would be visible; a nonzero count there is a phrase that recurs, which is what the step is for.",
      );
      say();
    }

    if (flag("local-floor")) {
      say("## 11. Phase E: which local-only entries deserve to be shown?");
      say();
      say(
        "**What this is for.** With Jev off or late, the list is recall's own order. In the held-out half 89 of 129 interactive requests used no card at all, so a list that always shows its top candidates is noise for most prompts. The old local list had thresholds; the ranked list needs a rule too. " +
          "**Derived from** the development half only (the earlier 70%): for every interactive request, with and without a task use, the top three entries of the whole recall stage, each classed by the evidence that found it (sources, and for a text match its raw strength), and how often an entry of that class was a card the agent then used. A class whose precision is at least the bar is shown; the rest are not. The classes and the bar are chosen on the development half; the held-out half is scored once with them. " +
          "**What would change it:** a ledger with more tasks, or Jev answering most lists (the rule then governs only the fallback).",
      );
      say();
      const strengthBin = (t: number | undefined): string =>
        t === undefined
          ? ""
          : t < 20
            ? "text<20"
            : t < 30
              ? "text20-30"
              : t < 45
                ? "text30-45"
                : "text45+";
      const classOf = (e: { via: string[]; text: number | undefined }): string => {
        const nonText = e.via.filter((v) => v !== "text").toSorted();
        return (
          [...nonText, ...(e.via.includes("text") ? [strengthBin(e.text)] : [])].join("+") || "none"
        );
      };
      type Ent = { id: string; cls: string; used: boolean; rank: number };
      type Row = { c: ReplayCase; used: boolean; top: Ent[] };
      const rowsFor = (cs: readonly ReplayCase[]): Row[] =>
        cs
          .filter((c) => kindOf.get(c.taskId) === "interactive")
          .map((c) => {
            const wanted = new Set(taskUses(c).filter((id) => inCatalog.has(id)));
            return {
              c,
              used: wanted.size > 0,
              top: recallStage
                .recall(queryFor(c))
                .slice(0, 3)
                .map((x, i) => ({
                  id: x.cardId,
                  cls: classOf({ via: x.via, text: x.textStrength }),
                  used: wanted.has(x.cardId),
                  rank: i + 1,
                })),
            };
          });
      const dev = rowsFor(split.train);
      const held = rowsFor(split.test);
      const byClass = new Map<string, { n: number; used: number }>();
      for (const r of dev)
        for (const e of r.top) {
          const g = byClass.get(e.cls) ?? { n: 0, used: 0 };
          g.n += 1;
          if (e.used) g.used += 1;
          byClass.set(e.cls, g);
        }
      const pct = (a: number, b: number) =>
        b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}% (${a}/${b})`;
      table(
        [
          "evidence class (development half)",
          "entries in the first three",
          "were a card the agent used",
          "precision",
        ],
        [...byClass.entries()]
          .toSorted((x, y) => y[1].used / y[1].n - x[1].used / x[1].n || y[1].n - x[1].n)
          .map(([k, g]) => [`\`${k}\``, String(g.n), String(g.used), pct(g.used, g.n)]),
      );
      const BAR = 0.25;
      const passing = new Set(
        [...byClass.entries()].filter(([, g]) => g.n >= 4 && g.used / g.n >= BAR).map(([k]) => k),
      );
      say(
        `Bar fixed before the held-out half was looked at: precision of at least ${(BAR * 100).toFixed(0)}% over at least 4 entries. Classes that pass: ${[...passing].map((k) => `\`${k}\``).join(", ") || "none"}.`,
      );
      say();
      const shown = (r: Row) => r.top.filter((e) => passing.has(e.cls));
      const scoreRows = (rows: Row[], gate: (r: Row) => Ent[]) => {
        const noUse = rows.filter((r) => !r.used);
        const used = rows.filter((r) => r.used);
        return {
          noUse: noUse.length,
          shownNoUse: noUse.filter((r) => gate(r).length > 0).length,
          used: used.length,
          hit: used.filter((r) => gate(r).some((e) => e.used)).length,
          entries: rows.reduce((n, r) => n + gate(r).length, 0),
          n: rows.length,
        };
      };
      const all = (r: Row) => r.top;
      // The rule that needs no calibration of its own: the old local matcher's thresholds (score 2, two shared words), which
      // were deployed. A recall entry is kept only when the old matcher would also list that card for this request.
      const legacyOk = new Map<string, Set<string>>();
      const legacy = (r: Row): Ent[] => {
        let ok = legacyOk.get(r.c.taskId);
        if (!ok) {
          ok = new Set(
            localRank(r.c.text, cards)
              .filter((x) => x.score >= 2 && x.overlap >= 2)
              .map((x) => x.cardId),
          );
          legacyOk.set(r.c.taskId, ok);
        }
        return r.top.filter((e) => ok.has(e.id));
      };
      // And the old list as deployed: thresholds plus the softmax against "none of these", which drops a weak list altogether.
      const deployedOk = new Map<string, Set<string>>();
      const deployed = (r: Row): Ent[] => {
        let ok = deployedOk.get(r.c.taskId);
        if (!ok) {
          const l = localShortlist(r.c.text, cards);
          ok = new Set(l.shown ? l.entries.map((e) => e.cardId) : []);
          deployedOk.set(r.c.taskId, ok);
        }
        return r.top.filter((e) => ok.has(e.id));
      };
      const rowOf = (label: string, rows: Row[], gate: (r: Row) => Ent[]) => {
        const r = scoreRows(rows, gate);
        return [
          label,
          pct(r.shownNoUse, r.noUse),
          pct(r.hit, r.used),
          (r.entries / Math.max(1, r.n)).toFixed(2),
        ];
      };
      const head = [
        "",
        "no-use requests shown a list",
        "requests with a use: a used card shown",
        "entries shown per request",
      ];
      say("Development half (where the rule was chosen):");
      say();
      table(head, [
        rowOf("every top-3 entry (as built before)", dev, all),
        rowOf("only passing evidence classes", dev, shown),
        rowOf(
          "only entries the old local matcher also lists (score 2, two shared words)",
          dev,
          legacy,
        ),
        rowOf(
          "only entries the old local list as deployed shows (thresholds plus none-of-these)",
          dev,
          deployed,
        ),
      ]);
      say("Held-out half, scored once:");
      say();
      table(head, [
        rowOf("every top-3 entry (as built before)", held, all),
        rowOf("only passing evidence classes", held, shown),
        rowOf(
          "only entries the old local matcher also lists (score 2, two shared words)",
          held,
          legacy,
        ),
        rowOf(
          "only entries the old local list as deployed shows (thresholds plus none-of-these)",
          held,
          deployed,
        ),
      ]);
      say(
        "**What the numbers say.** Recall's top three catch a used card for most requests that used one (77% held out) but are shown for every request, including the 99 of 129 that used no task card; no evidence class separates them (every class with a real sample is under 30% precise, and the three that pass the bar hold 4 to 8 entries each). " +
          "The old local list is quiet (2% of no-use requests) and catches almost nothing (7%). There is no point on this data that is both quiet and useful, so the build does not pretend there is one: " +
          "**a ranking that is wholly local (Jev judged none of it) is shown only where the old local list would also show something; otherwise the ranker answers `local-quiet` and each reader does what it did before** (no note, no owner line, the matcher's own lexical seeding as it was). " +
          "Where Jev judged any of the candidates, nothing is gated: Jev's NO and its comparative answer are the quiet.",
      );
      say();
    }
  }

  const text = out.join("\n");
  const outPath = arg("out");
  if (outPath) writeFileSync(outPath, text + "\n");
  else console.log(text);
}

await main();
