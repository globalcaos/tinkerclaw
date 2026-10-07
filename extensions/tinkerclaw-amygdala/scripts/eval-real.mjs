#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
/**
 * How well ONE Jev prompt judges REAL steps you labelled (2026-10-01: the live refusal check was right on 0 of 5).
 *
 *   npx tsx scripts/eval-real.mjs <labels.json> [--question <candidate.md>] [--raw-reply]
 *
 * labels.json lives in the local data folder, never in git: {"questionId": "refusal",
 * "cases": [{"situationId": "…", "expect": true, "note": "why"}]}. Each case is read from the live store (read-only),
 * the reply is re-cleaned with today's `judgedReply`, the prompt (the shipped version, or a candidate file in the same
 * format as questions/<family>/<id>.md) is asked through the real redaction and the real Jev client, and the answer is
 * compared with the label at the prompt's own cut-off. Needs a Jev token (TYPESAFE_API_KEY in the environment, or the key file); never prints it.
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => import(join(root, "src", p));
const { JevClient, jevToken } = await src("jev.ts");
const { QuestionBook, readSeedFile, validateQuestion } = await src("question-book.ts");
const { parseConfig } = await src("config.ts");
const { redactForSend } = await src("redact.ts");
const { judgedReply } = await src("situation.ts");

const [labelsPath] = process.argv.slice(2);
const qi = process.argv.indexOf("--question");
if (!labelsPath) throw new Error("usage: eval-real.mjs <labels.json> [--question <candidate.md>]");
if (!jevToken()) {
  throw new Error("no Jev token (TYPESAFE_API_KEY in the environment, or the key file)");
}
const labels = JSON.parse(readFileSync(labelsPath, "utf8"));
const book = new QuestionBook({ seedDir: join(root, "questions") });
const q = qi > 0 ? readSeedFile(process.argv[qi + 1]) : book.get(labels.questionId);
const problems = validateQuestion(q);
if (problems.length) throw new Error(`invalid question: ${problems.join("; ")}`);
const config = parseConfig({ jev: { sendRealSituations: true } });
const jev = new JevClient({
  apiKey: jevToken,
  baseUrl: config.jev.baseUrl,
  model: config.jev.model,
  buildState: (s, qs) => redactForSend(s, qs, { allowReal: true, homeDir: homedir() }),
});
const db = new DatabaseSync(join(homedir(), ".openclaw/data/amygdala-jev/amygdala.sqlite"), {
  readOnly: true,
});
const crosses = (v) => {
  if (v.skipped) return null;
  if (q.cutoff.kind === "prob") return v.prob >= q.cutoff.at;
  if (q.cutoff.kind === "level") return Number(v.answer) >= q.cutoff.atOrAbove;
  return null;
};
let tp = 0,
  fp = 0,
  tn = 0,
  fn = 0,
  usd = 0;
console.log(`${q.id} v${q.version}  cut-off ${JSON.stringify(q.cutoff)}`);
for (const c of labels.cases) {
  const row = db.prepare("SELECT record_json FROM situations WHERE id = ?").get(c.situationId);
  if (!row?.record_json) {
    console.log(`  ?  ${c.situationId.slice(0, 8)} not in the store`);
    continue;
  }
  const s = JSON.parse(row.record_json);
  // --raw-reply: judge the reply as it was stored (the baseline before judgedReply existed).
  if (s.reply && !process.argv.includes("--raw-reply"))
    s.reply = { ...s.reply, value: judgedReply(s.reply.value ?? undefined) ?? null };
  const needsReply = q.fields.includes("reply");
  let said = false,
    shown = "not asked (no reply left to judge)";
  if (!needsReply || s.reply?.value) {
    const [v] = await jev.ask(s, [q], { budgetMs: 10_000 });
    usd += v.costUsd ?? 0;
    said = crosses(v) === true;
    shown = v.skipped
      ? `skipped:${v.skipped}`
      : `p=${v.prob.toFixed(2)}${q.type === "choice" ? ` ${v.answer}` : ""}`;
  }
  if (said && c.expect) tp++;
  else if (said) fp++;
  else if (c.expect) fn++;
  else tn++;
  console.log(
    `  ${said === c.expect ? "✓" : "✗"}  expect ${c.expect ? "yes" : "no "} ${shown.padEnd(32)} ${c.note ?? ""}`,
  );
}
const n = tp + fp + tn + fn;
console.log(
  `right ${tp + tn}/${n} · precision ${tp + fp ? (tp / (tp + fp)).toFixed(2) : "–"} · recall ${tp + fn ? (tp / (tp + fn)).toFixed(2) : "–"} · $${usd.toFixed(5)}`,
);
