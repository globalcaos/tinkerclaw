/**
 * Loaders for the must-catch cases and the replay corpus (design doc §3 M2, §7.3 item 8).
 * The replay corpus is ONLY cases/must-catch: cases/eval never enters replay, so the loader
 * never opens that directory and refuses any case of kind "eval". Controls are the mirror image: cases that must proceed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITUATION_FIELD_NAMES, type CaseFile } from "./types.js";

const KINDS = ["must-catch", "control", "replay", "eval"];
// A must-catch case can only demand a response that acts; a control's ceiling can be anything, "proceed" most often.
const ACTING_KINDS = ["hold", "proof", "ask", "send-back", "note"];
const RESPONSE_KINDS = [...ACTING_KINDS, "refusal", "proceed"];
const ORIGINS = ["observed", "derived", "inferred", "missing"];
const RECORD_KEYS = ["originKind", "id", "ts", "sessionKey", "turnId", "seam"];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with a candidate case; `[]` when valid. */
export function validateCaseFile(c: unknown): string[] {
  if (!isObj(c)) return ["not an object"];
  const p: string[] = [];
  if (typeof c.id !== "string" || c.id.length === 0) p.push("id must be a non-empty string");
  if (!KINDS.includes(c.kind as string)) p.push("kind must be must-catch, control, replay or eval");
  if (typeof c.description !== "string" || c.description.trim().length === 0) {
    p.push("description must be non-empty");
  }
  if (c.kind === "must-catch" && !ACTING_KINDS.includes(c.mustBeAtLeast as string)) {
    p.push("a must-catch case needs mustBeAtLeast (hold, proof, ask, send-back or note)");
  }
  if (c.kind === "control" && !RESPONSE_KINDS.includes(c.mustBeAtMost as string)) {
    p.push("a control case needs mustBeAtMost (a response kind)");
  }
  if (c.kind === "must-catch" && c.mustBeAtMost !== undefined)
    p.push("a must-catch case has no mustBeAtMost");
  if (c.kind === "control" && c.mustBeAtLeast !== undefined)
    p.push("a control case has no mustBeAtLeast");
  const s = c.situation;
  if (!isObj(s)) {
    p.push("situation missing");
  } else {
    if (s.originKind !== "synthetic") p.push('situation.originKind must be "synthetic"');
    for (const [k, v] of Object.entries(s)) {
      if (RECORD_KEYS.includes(k)) continue;
      if (!SITUATION_FIELD_NAMES.includes(k as never)) {
        p.push(`situation.${k} is not a situation field`);
      } else if (!isObj(v) || !("value" in v) || !ORIGINS.includes(v.origin as string)) {
        p.push(`situation.${k} must be a Field {value, origin}`);
      }
    }
  }
  return p;
}

/** Loads <dir>/*.json ({cases:[]}); every case must be valid and of kind "must-catch"; duplicate ids throw. */
export function loadMustCatch(dir: string): CaseFile[] {
  const out: CaseFile[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .toSorted()) {
    const file = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    if (!isObj(file) || !Array.isArray(file.cases)) throw new Error(`${f}: expected {cases:[]}`);
    for (const c of file.cases) {
      const problems = validateCaseFile(c);
      if (problems.length > 0) throw new Error(`${f}: invalid case: ${problems.join("; ")}`);
      const cf = c as CaseFile;
      if (cf.kind !== "must-catch")
        throw new Error(`${f}: case ${cf.id} has kind ${cf.kind}, not must-catch`);
      if (seen.has(cf.id)) throw new Error(`${f}: duplicate case id ${cf.id}`);
      seen.add(cf.id);
      out.push(cf);
    }
  }
  return out;
}

/** Loads <dir>/*.json ({cases:[]}) of kind "control" (cases that must proceed); a missing folder is an empty set. */
export function loadControls(dir: string): CaseFile[] {
  if (!existsSync(dir)) return [];
  const out: CaseFile[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .toSorted()) {
    const file = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    if (!isObj(file) || !Array.isArray(file.cases)) throw new Error(`${f}: expected {cases:[]}`);
    for (const c of file.cases) {
      const problems = validateCaseFile(c);
      if (problems.length > 0) throw new Error(`${f}: invalid case: ${problems.join("; ")}`);
      const cf = c as CaseFile;
      if (cf.kind !== "control")
        throw new Error(`${f}: case ${cf.id} has kind ${cf.kind}, not control`);
      if (seen.has(cf.id)) throw new Error(`${f}: duplicate case id ${cf.id}`);
      seen.add(cf.id);
      out.push(cf);
    }
  }
  return out;
}

/** The replay corpus: must-catch cases plus controls (a guard that holds everything must fail). Never opens <casesRoot>/eval. */
export function loadReplayCorpus(casesRoot: string): CaseFile[] {
  const cases = [
    ...loadMustCatch(join(casesRoot, "must-catch")),
    ...loadControls(join(casesRoot, "controls")),
  ];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id} across must-catch and controls`);
    ids.add(c.id);
  }
  if (cases.some((c) => c.kind === ("eval" as string))) {
    throw new Error("an eval case reached the replay corpus");
  }
  return cases;
}
