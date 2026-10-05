#!/usr/bin/env node
/**
 * Validates questions/<family>/<id>.md and cases/must-catch/*.json without TypeScript (exit 1 on any problem).
 * The checks mirror validateQuestion (src/question-book.ts) and validateCaseFile (src/cases.ts);
 * the small duplication is deliberate so this runs with plain node.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILIES = ["safety", "second-opinion", "double-check", "efficiency", "personality"];
const SEAMS = ["prompt", "pre-tool", "post-tool", "stop"];
const FIELDS = [
  "tool",
  "args",
  "command",
  "effectClass",
  "targets",
  "targetHistory",
  "scratch",
  "toolRecord",
  "request",
  "restatement",
  "expectation",
  "draftCommitments",
  "repeatedErrors",
  "stepsSinceNewFact",
  "recentHolds",
  "standingFacts",
  "similarIncidents",
  "reply",
  "claims",
  "provenance",
  "holdNeeds",
  "candidates",
  "scheduledJobs",
  "contextCounts",
];
const ACTING_KINDS = ["hold", "proof", "ask", "send-back", "note"];
const RESPONSE_KINDS = [...ACTING_KINDS, "refusal", "proceed"];
const ORIGINS = ["observed", "derived", "inferred", "missing"];
const RECORD_KEYS = ["originKind", "id", "ts", "sessionKey", "turnId", "seam"];
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const posInt = (v) => Number.isInteger(v) && v >= 1;

function validateQuestion(q) {
  if (!isObj(q)) return ["not an object"];
  const p = [];
  if (typeof q.id !== "string" || !KEBAB.test(q.id)) p.push("id must be kebab-case");
  if (!posInt(q.version)) p.push("version must be a positive integer");
  if (!FAMILIES.includes(q.family)) p.push("family is not a FamilyId");
  if (!Array.isArray(q.seams) || q.seams.length === 0 || !q.seams.every((s) => SEAMS.includes(s))) {
    p.push("seams must be a non-empty subset of the four seams");
  }
  const c = q.criteria;
  if (q.type === "choice") {
    if (!isObj(c) || Object.keys(c).length < 2) p.push("choice criteria need at least 2 options");
    else if (!Object.values(c).every((v) => v === null || typeof v === "string")) {
      p.push("choice option descriptions must be string or null");
    }
  } else if (q.type === "score") {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every(nonEmpty)) {
      p.push("score criteria must be an array of 2-10 non-empty strings");
    }
  } else if (q.type === "noul") {
    if (c !== undefined && (!isObj(c) || Object.keys(c).sort().join(",") !== "false,true")) {
      p.push("noul criteria must be absent or {true,false}");
    }
  } else {
    p.push("type must be noul, choice or score");
  }
  if (!nonEmpty(q.instructions)) p.push("instructions must be non-empty");
  if (!Array.isArray(q.fields) || !q.fields.every((f) => FIELDS.includes(f))) {
    p.push("fields must be situation field names");
  }
  const cut = q.cutoff;
  if (!isObj(cut)) {
    p.push("cutoff missing");
  } else {
    const want = q.type === "noul" ? "prob" : q.type === "score" ? "level" : "choice";
    if (cut.kind !== "none" && cut.kind !== want)
      p.push(`cutoff.kind must be ${want} (or none) for type ${q.type}`);
    if (cut.kind === "prob" && !Number.isFinite(cut.at)) p.push("cutoff.at must be a number");
    if (cut.kind === "level") {
      const above = Number.isFinite(cut.atOrAbove);
      const below = Number.isFinite(cut.atOrBelow);
      if (above === below) p.push("cutoff needs exactly one of atOrAbove, atOrBelow");
    }
    if (cut.kind === "choice") {
      if (cut.negate !== undefined && typeof cut.negate !== "boolean")
        p.push("cutoff.negate must be a boolean");
      if (!Number.isFinite(cut.at)) p.push("cutoff.at must be a number");
      if (typeof cut.option !== "string" || (isObj(c) && !(cut.option in c))) {
        p.push("cutoff.option must be one of the criteria keys");
      }
    }
  }
  for (const k of ["purpose", "origin", "retirement", "name"]) {
    if (!nonEmpty(q[k])) p.push(`${k} must be non-empty`);
  }
  if (!Array.isArray(q.mustCatch) || !q.mustCatch.every((m) => typeof m === "string")) {
    p.push("mustCatch must be a string array");
  }
  if (q.status !== "active" && q.status !== "off") p.push("status must be active or off");
  if (q.parent !== undefined && !posInt(q.parent)) p.push("parent must be a positive integer");
  return p;
}

function validateCaseFile(c) {
  if (!isObj(c)) return ["not an object"];
  const p = [];
  if (typeof c.id !== "string" || c.id.length === 0) p.push("id must be a non-empty string");
  if (!["must-catch", "control", "replay", "eval"].includes(c.kind))
    p.push("kind must be must-catch, control, replay or eval");
  if (!nonEmpty(c.description)) p.push("description must be non-empty");
  if (c.kind === "must-catch" && !ACTING_KINDS.includes(c.mustBeAtLeast)) {
    p.push("a must-catch case needs mustBeAtLeast (hold, proof, ask, send-back or note)");
  }
  if (c.kind === "control" && !RESPONSE_KINDS.includes(c.mustBeAtMost)) {
    p.push("a control case needs mustBeAtMost (a response kind)");
  }
  if (c.kind === "must-catch" && c.mustBeAtMost !== undefined)
    p.push("a must-catch case has no mustBeAtMost");
  if (c.kind === "control" && c.mustBeAtLeast !== undefined)
    p.push("a control case has no mustBeAtLeast");
  if (!isObj(c.situation)) {
    p.push("situation missing");
  } else {
    if (c.situation.originKind !== "synthetic") p.push('situation.originKind must be "synthetic"');
    for (const [k, v] of Object.entries(c.situation)) {
      if (RECORD_KEYS.includes(k)) continue;
      if (!FIELDS.includes(k)) p.push(`situation.${k} is not a situation field`);
      else if (!isObj(v) || !("value" in v) || !ORIGINS.includes(v.origin)) {
        p.push(`situation.${k} must be a Field {value, origin}`);
      }
    }
  }
  return p;
}

// The page layout of src/question-book.ts readSeedFile (the architect 2026-10-01): # title, idea, examples, then the question,
// its answers and a yaml block under ## Settings.
function sections(text) {
  const out = new Map([["", []]]);
  let current = "";
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    const h = fenced ? null : /^## (.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      out.set(current, []);
    } else out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}

function readPage(text) {
  if (text.startsWith("---")) throw new Error("old layout (YAML on top)");
  const title = /^# (.+?)\s*$/.exec(text.trimStart().split("\n")[0]);
  if (!title) throw new Error("the file must open with a # title");
  const parts = sections(text);
  const question = parts.get("The question Jev is asked")?.trim();
  if (!question) throw new Error("missing ## The question Jev is asked");
  const yaml = /```ya?ml\s*\n([\s\S]*?)\n```/.exec(parts.get("Settings") ?? "");
  if (!yaml) throw new Error("missing the yaml block under ## Settings");
  const meta = parseYaml(yaml[1]);
  if (!isObj(meta) || "instructions" in meta || "name" in meta || "criteria" in meta) {
    throw new Error("the settings must be a mapping without instructions, name or criteria");
  }
  const q = { ...meta, name: title[1], instructions: question };
  const answers = parts.get("The answers Jev can pick");
  if (answers === undefined) return q;
  const lines = answers.split("\n").filter((l) => l.trim() !== "");
  if (meta.type === "score") {
    q.criteria = lines.map((l, i) => {
      const m = /^(\d+)[.)]\s+(.+)$/.exec(l.trim());
      if (!m || Number(m[1]) !== i) throw new Error(`score answers are numbered 0, 1, 2…: "${l}"`);
      return m[2].trim();
    });
  } else {
    q.criteria = {};
    for (const l of lines) {
      const m = /^[-*+]\s+`?([a-z0-9][a-z0-9-]*)`?\s*(?::\s*(.*))?$/.exec(l.trim());
      if (!m) throw new Error(`answers are - \`key\`: text: "${l}"`);
      q.criteria[m[1]] = m[2]?.trim() || null;
    }
  }
  return q;
}

// What a person needs before the question: the family line (`_italic_`, as the repo formatter writes it), the idea,
// and at least two examples.
const FAMILY_LINE = {
  safety: "_Safety: no action you would regret_ · J11 paper §6.1",
  "second-opinion":
    "_Second opinion: did it understand you, and does it stay on course?_ · J11 paper §6.2",
  "double-check":
    '_Double-check: is every "done" real, and is the answer complete?_ · J11 paper §6.3',
  personality: "_Personality: curiosity, surprise and a steady voice_ · J11 paper §6.4",
  efficiency:
    "_Efficiency: the right procedure, the right model, no wasted loops_ · J11 paper §6.5",
};
function pageProblems(text, family) {
  const p = [];
  const [title, familyLine, idea] = text.split(/\n\s*\n/);
  if (!/^# [A-Z][^:]{2,30}: [a-z"].*\?$/.test(title ?? "")) {
    p.push(
      "the title is the paper's name for the function, a colon, then the question: # Curiosity: did it …?",
    );
  }
  if (familyLine !== FAMILY_LINE[family])
    p.push(`the line under the title must be: ${FAMILY_LINE[family]}`);
  if (!idea || idea.startsWith("#")) p.push("the idea (a paragraph) must follow the family line");
  const examples = sections(text).get("Examples") ?? "";
  if (examples.split("\n").filter((l) => l.startsWith("|")).length < 4) {
    p.push("## Examples needs a table with at least two examples");
  }
  return p;
}

const problems = [];
const load = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ f, json: JSON.parse(readFileSync(join(dir, f), "utf8")) }));

const questions = [];
const qdir = join(root, "questions");
for (const family of readdirSync(qdir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  for (const f of readdirSync(join(qdir, family))
    .filter((n) => n.endsWith(".md"))
    .sort()) {
    const where = `questions/${family}/${f}`;
    let q;
    try {
      q = readPage(readFileSync(join(qdir, family, f), "utf8"));
    } catch (e) {
      problems.push(`${where}: ${e.message}`);
      continue;
    }
    for (const p of pageProblems(readFileSync(join(qdir, family, f), "utf8"), family))
      problems.push(`${where}: ${p}`);
    for (const p of validateQuestion(q)) problems.push(`${where}: ${p}`);
    if (q.family !== family) problems.push(`${where}: not in folder family ${family}`);
    if (q.id !== f.slice(0, -3)) problems.push(`${where}: id ${q.id} does not match the file name`);
    questions.push(q);
  }
}
const seen = new Set();
for (const q of questions) {
  const key = `${q.id}@${q.version}`;
  if (seen.has(key)) problems.push(`duplicate question ${key}`);
  seen.add(key);
}

const cases = [];
for (const { f, json } of load(join(root, "cases", "must-catch"))) {
  if (!Array.isArray(json.cases)) {
    problems.push(`cases/must-catch/${f}: expected {cases:[]}`);
    continue;
  }
  for (const c of json.cases) {
    for (const m of validateCaseFile(c)) problems.push(`cases/must-catch/${f} ${c?.id}: ${m}`);
    if (c?.kind !== "must-catch")
      problems.push(`cases/must-catch/${f} ${c?.id}: kind is not must-catch`);
    cases.push(c);
  }
}
const controls = [];
const controlsDir = join(root, "cases", "controls");
if (existsSync(controlsDir)) {
  for (const { f, json } of load(controlsDir)) {
    if (!Array.isArray(json.cases)) {
      problems.push(`cases/controls/${f}: expected {cases:[]}`);
      continue;
    }
    for (const c of json.cases) {
      for (const m of validateCaseFile(c)) problems.push(`cases/controls/${f} ${c?.id}: ${m}`);
      if (c?.kind !== "control") problems.push(`cases/controls/${f} ${c?.id}: kind is not control`);
      controls.push(c);
    }
  }
}
const caseIds = new Set();
for (const c of [...cases, ...controls]) {
  if (caseIds.has(c.id)) problems.push(`duplicate case id ${c.id}`);
  caseIds.add(c.id);
}
const referenced = new Set();
for (const q of questions) {
  for (const id of q.mustCatch ?? []) {
    referenced.add(id);
    if (!caseIds.has(id)) problems.push(`question ${q.id} references missing case ${id}`);
  }
}
for (const c of cases) {
  if (!referenced.has(c.id)) problems.push(`case ${c.id} is referenced by no question`);
}

for (const m of problems) console.error(m);
console.log(
  `${questions.length} questions, ${cases.length} must-catch cases, ${controls.length} controls, ${problems.length} problems`,
);
process.exit(problems.length > 0 ? 1 : 0);
