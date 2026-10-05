#!/usr/bin/env node
/**
 * By-hand nightly runner for the amygdala's question learning (design doc §7.3 item 7). Run it yourself:
 *
 *   node extensions/tinkerclaw-amygdala/scripts/nightly.mjs [--dry-run] [--max N] [--model M]
 *
 * It talks to the running gateway through the `openclaw` CLI and asks a model for reworded questions through
 * `claude -p`. Gateway contract (the methods are built elsewhere; this only defines what the script relies on):
 *   amygdala2.nightly       params {"phase":"worklist"}  -> {online, worklist:[{questionId, failing:[FailingCase]}]}
 *   amygdala2.questionRecord params {"questionId"}        -> the current question record, including its instructions
 *   amygdala2.propose       params {questionId, candidate, source:"nightly-script"} -> the change engine's outcome
 * The model never grades itself: the gateway replays every candidate and accepts or rejects it.
 * Bounded waits (worklist 60 s, claude 180 s, propose 300 s), no background process, no cron. Exit 1 on the first hard
 * failure (a call that fails or times out); a model answer that is not a usable JSON object only skips that item.
 * Test hooks: AMYGDALA_NIGHTLY_WORKLIST_MS / _CLAUDE_MS / _PROPOSE_MS shorten the waits.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const max = Number.parseInt(opt("--max", "5"), 10);
const model = opt("--model", "opus");
const ms = (env, dflt) => Number.parseInt(process.env[env] ?? "", 10) || dflt;
const T = {
  worklist: ms("AMYGDALA_NIGHTLY_WORKLIST_MS", 60_000),
  claude: ms("AMYGDALA_NIGHTLY_CLAUDE_MS", 180_000),
  propose: ms("AMYGDALA_NIGHTLY_PROPOSE_MS", 300_000),
};

if (!Number.isInteger(max) || max < 0) {
  console.error("[nightly] --max needs a non-negative integer");
  process.exit(2);
}

class HardFailure extends Error {}

/** Runs a command with a wall-clock limit; the whole process group is killed on timeout so no child outlives it. */
function run(cmd, args, timeoutMs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new HardFailure(`${cmd} could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new HardFailure(`${cmd} timed out after ${timeoutMs} ms`));
      if (code !== 0)
        return reject(new HardFailure(`${cmd} exited ${code}: ${err.trim().slice(0, 500)}`));
      resolve(out);
    });
    child.stdin.end(input ?? "");
  });
}

const gateway = async (method, params, timeoutMs) => {
  const out = await run(
    "openclaw",
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    timeoutMs,
  );
  try {
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === "object" && "result" in parsed && !("worklist" in parsed)
      ? parsed.result
      : parsed;
  } catch {
    throw new HardFailure(`${method} did not return JSON`);
  }
};

function buildPrompt(item, record) {
  return [
    "You improve one question of a guard that judges an AI agent's steps. Below are the question as it stands and the",
    "replay cases it currently fails (ids, what was expected, what the guard did, how the judge was scripted to answer).",
    "Propose a reworded question that would make those cases come out right without breaking the others.",
    "",
    "Wording habits: one property per question; something the record can show; evidence, not plausibility; closed options",
    "including cannot-tell; the user's own words; no negations.",
    "",
    "Reply with ONE JSON object and nothing else:",
    '{ "instructions": string, "criteria"?: object or array, "fields"?: string[], "cutoff"?: object }',
    "",
    `Question id: ${item.questionId}`,
    `Current question record:\n${record === null ? "(fetched at run time)" : JSON.stringify(record, null, 2)}`,
    "",
    `Failing cases:\n${JSON.stringify(item.failing, null, 2)}`,
  ].join("\n");
}

/** The one JSON object in the model's reply, or null; a code fence around it is tolerated. */
function extractObject(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(body.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function validCandidate(c) {
  if (!c) return "not a JSON object";
  const keys = ["instructions", "criteria", "fields", "cutoff"].filter((k) => c[k] !== undefined);
  if (keys.length === 0) return "no instructions, criteria, fields or cutoff";
  if (
    c.instructions !== undefined &&
    (typeof c.instructions !== "string" || !c.instructions.trim())
  ) {
    return "instructions must be a non-empty string";
  }
  if (c.criteria !== undefined && (c.criteria === null || typeof c.criteria !== "object")) {
    return "criteria must be an object or an array";
  }
  if (
    c.fields !== undefined &&
    !(Array.isArray(c.fields) && c.fields.every((f) => typeof f === "string"))
  ) {
    return "fields must be an array of strings";
  }
  if (
    c.cutoff !== undefined &&
    !(c.cutoff && ["prob", "level", "choice", "none"].includes(c.cutoff.kind))
  ) {
    return "cutoff needs a kind of prob, level, choice or none";
  }
  const extra = Object.keys(c).filter(
    (k) => !["instructions", "criteria", "fields", "cutoff"].includes(k),
  );
  return extra.length ? `unexpected keys: ${extra.join(", ")}` : null;
}

async function main() {
  const res = await gateway("amygdala2.nightly", { phase: "worklist" }, T.worklist);
  const worklist = Array.isArray(res?.worklist) ? res.worklist : [];
  console.log(`[nightly] online retune: ${JSON.stringify(res?.online ?? {})}`);
  console.log(`[nightly] ${worklist.length} question(s) with failing cases`);
  const items = worklist.slice(0, max);
  for (const item of items) {
    const id = item.questionId;
    if (dryRun) {
      console.log(`[dry-run] would call amygdala2.questionRecord for ${id}`);
      console.log(`[dry-run] prompt for ${id}:\n${buildPrompt(item, null)}`);
      console.log(`[dry-run] would run: claude -p --model ${model} --output-format text`);
      console.log(`[dry-run] would call amygdala2.propose for ${id} with source nightly-script`);
      continue;
    }
    const record = await gateway("amygdala2.questionRecord", { questionId: id }, T.worklist);
    const reply = await run(
      "claude",
      ["-p", "--model", model, "--output-format", "text"],
      T.claude,
      buildPrompt(item, record),
    );
    const candidate = extractObject(reply);
    const problem = validCandidate(candidate);
    if (problem) {
      console.error(`[nightly] ${id}: skipped, the model's answer is not usable (${problem})`);
      continue;
    }
    const outcome = await gateway(
      "amygdala2.propose",
      { questionId: id, candidate, source: "nightly-script" },
      T.propose,
    );
    console.log(`[nightly] ${id}: ${JSON.stringify(outcome)}`);
  }
}

main().catch((err) => {
  console.error(`[nightly] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
