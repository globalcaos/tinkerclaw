/**
 * The question book (design doc §3 M2, §4): the versioned questions the judge is asked.
 * Seed prompts live one per file, `questions/<family>/<id>.md`, written for a person first: title, idea, examples,
 * then the question, its answers and the settings (see `readSeedFile`). The principal opens and edits them from the
 * panel (2026-09-30); the book never writes them.
 * Learned versions live as overlay files, one per (id, version). A version is immutable: a reworded question is a new
 * version, never an edit.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  FAMILY_IDS,
  SITUATION_FIELD_NAMES,
  type FamilyId,
  type Question,
  type Seam,
} from "./types.js";

export interface QuestionBookOptions {
  seedDir: string;
  overlayDir?: string;
}

const SEAMS: readonly Seam[] = ["prompt", "pre-tool", "post-tool", "stop"];
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const OVERLAY_FILE = /^(.+)\.v(\d+)\.json$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;

/** Problems with a candidate question; `[]` when it is valid. */
export function validateQuestion(q: unknown): string[] {
  if (!isObj(q)) return ["not an object"];
  const p: string[] = [];
  if (typeof q.id !== "string" || !KEBAB.test(q.id)) p.push("id must be kebab-case");
  if (!isPosInt(q.version)) p.push("version must be a positive integer");
  if (!FAMILY_IDS.includes(q.family as FamilyId)) p.push("family is not a FamilyId");
  if (
    !Array.isArray(q.seams) ||
    q.seams.length === 0 ||
    !q.seams.every((s) => SEAMS.includes(s as Seam))
  ) {
    p.push("seams must be a non-empty subset of the four seams");
  }

  const type = q.type;
  const c = q.criteria;
  if (type === "choice") {
    if (!isObj(c) || Object.keys(c).length < 2) {
      p.push("choice criteria must be an object with at least 2 options");
    } else if (!Object.values(c).every((v) => v === null || typeof v === "string")) {
      p.push("choice option descriptions must be string or null");
    }
  } else if (type === "score") {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every((v) => nonEmpty(v))) {
      p.push("score criteria must be an array of 2-10 non-empty strings");
    }
  } else if (type === "noul") {
    if (c !== undefined) {
      const keys = isObj(c) ? Object.keys(c).toSorted() : [];
      if (keys.join(",") !== "false,true") p.push("noul criteria must be absent or {true,false}");
    }
  } else {
    p.push("type must be noul, choice or score");
  }

  if (!nonEmpty(q.instructions)) p.push("instructions must be non-empty");
  if (
    !Array.isArray(q.fields) ||
    !q.fields.every((f) => SITUATION_FIELD_NAMES.includes(f as never))
  ) {
    p.push("fields must be an array of situation field names");
  }

  const cut = q.cutoff;
  if (!isObj(cut)) {
    p.push("cutoff missing");
  } else {
    const want = type === "noul" ? "prob" : type === "score" ? "level" : "choice";
    if (type && cut.kind !== "none" && cut.kind !== want) {
      p.push(`cutoff.kind must be ${want} (or none) for type ${String(type)}`);
    }
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

  for (const k of ["purpose", "origin", "retirement", "name"] as const) {
    if (!nonEmpty(q[k])) p.push(`${k} must be non-empty`);
  }
  if (!Array.isArray(q.mustCatch) || !q.mustCatch.every((m) => typeof m === "string")) {
    p.push("mustCatch must be a string array");
  }
  if (q.status !== "active" && q.status !== "off") p.push("status must be active or off");
  if (q.parent !== undefined && !isPosInt(q.parent)) p.push("parent must be a positive integer");
  return p;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export const QUESTION_HEADING = "The question Jev is asked";
export const ANSWERS_HEADING = "The answers Jev can pick";
export const SETTINGS_HEADING = "Settings";

/** `## ` sections outside code fences, keyed by heading; the text before the first one is under "". */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string[]>([["", []]]);
  let current = "";
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    const h = fenced ? null : /^## (.+?)\s*$/.exec(line);
    if (h) {
      current = h[1]!;
      out.set(current, []);
    } else out.get(current)!.push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}

/** A score's levels (`0. text`, numbered from 0) or a choice's options (`- \`key\`: text`), one per line. */
function parseAnswers(
  path: string,
  body: string,
  type: unknown,
): string[] | Record<string, string | null> {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  if (type === "score") {
    return lines.map((l, i) => {
      const m = /^(\d+)[.)]\s+(.+)$/.exec(l.trim());
      if (!m || Number(m[1]) !== i) {
        throw new Error(
          `${path}: score answers are one per line, numbered 0, 1, 2…: "${l.trim()}"`,
        );
      }
      return m[2]!.trim();
    });
  }
  const options: Record<string, string | null> = {};
  for (const l of lines) {
    const m = /^[-*+]\s+`?([a-z0-9][a-z0-9-]*)`?\s*(?::\s*(.*))?$/.exec(l.trim());
    if (!m) throw new Error(`${path}: answers are one per line as - \`key\`: text: "${l.trim()}"`);
    options[m[1]!] = m[2]?.trim() || null;
  }
  return options;
}

/**
 * One seed prompt file, laid out for a person first (the architect 2026-10-01): the `# title` (the prompt's name), the idea
 * and examples, then `## The question Jev is asked`, `## The answers Jev can pick` and a YAML block under
 * `## Settings`. Only those four parts are read; everything else is for the reader. Throws on a malformed file.
 */
export function readSeedFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  if (text.startsWith("---")) {
    throw new Error(
      `${path}: old layout (YAML on top); the settings go in a yaml block under ## Settings`,
    );
  }
  const title = /^# (.+?)\s*$/.exec(text.trimStart().split("\n")[0]!);
  if (!title) throw new Error(`${path}: the file must open with a # title, the prompt's name`);
  const parts = sections(text);
  const question = parts.get(QUESTION_HEADING)?.trim();
  if (!question) throw new Error(`${path}: missing the ## ${QUESTION_HEADING} section`);
  const yaml = /```ya?ml\s*\n([\s\S]*?)\n```/.exec(parts.get(SETTINGS_HEADING) ?? "");
  if (!yaml) throw new Error(`${path}: missing the yaml block under ## ${SETTINGS_HEADING}`);
  const meta = parseYaml(yaml[1]!) as unknown;
  if (!isObj(meta)) throw new Error(`${path}: the settings must be a mapping`);
  if ("instructions" in meta)
    throw new Error(`${path}: the question goes in its own section, not in the settings`);
  if ("name" in meta) throw new Error(`${path}: the name is the # title, not a setting`);
  if ("criteria" in meta)
    throw new Error(
      `${path}: the answers go in the ## ${ANSWERS_HEADING} section, not in the settings`,
    );
  const answers = parts.get(ANSWERS_HEADING);
  return {
    ...meta,
    name: title[1]!,
    instructions: question,
    ...(answers !== undefined ? { criteria: parseAnswers(path, answers, meta.type) } : {}),
  };
}

/** Every seed prompt under `seedDir/<family>/<id>.md`, sorted by path; folder and file name must match the prompt. */
export function readSeeds(seedDir: string): { question: Record<string, unknown>; file: string }[] {
  const out: { question: Record<string, unknown>; file: string }[] = [];
  const families = readdirSync(seedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();
  for (const family of families) {
    for (const name of readdirSync(join(seedDir, family))
      .filter((n) => n.endsWith(".md"))
      .toSorted()) {
      const file = join(seedDir, family, name);
      const question = readSeedFile(file);
      if (question.family !== family) {
        throw new Error(
          `${family}/${name}: family is ${String(question.family)}, folder is ${family}`,
        );
      }
      if (question.id !== name.slice(0, -3)) {
        throw new Error(`${family}/${name}: id is ${String(question.id)}, file name must match`);
      }
      out.push({ question, file });
    }
  }
  return out;
}

export class QuestionBook {
  private readonly byId = new Map<string, Map<number, Question>>();
  private readonly activeVer = new Map<string, number>();
  private readonly overlayDir?: string;
  /** `id@version` -> the file that holds it; versions registered from the store have none. */
  private readonly files = new Map<string, string>();

  constructor(o: QuestionBookOptions) {
    this.overlayDir = o.overlayDir;
    for (const { question, file } of readSeeds(o.seedDir)) {
      const q = this.insert(question, `seed ${file}`);
      this.files.set(`${q.id}@${q.version}`, file);
    }
    if (o.overlayDir && existsSync(o.overlayDir)) {
      for (const f of readdirSync(o.overlayDir).toSorted()) {
        const m = OVERLAY_FILE.exec(f);
        if (!m) continue;
        const q = this.insert(readJson(join(o.overlayDir, f)), `overlay ${f}`);
        if (q.id !== m[1] || q.version !== Number(m[2])) {
          throw new Error(`overlay ${f}: file name does not match id/version`);
        }
        this.files.set(`${q.id}@${q.version}`, join(o.overlayDir, f));
      }
    }
    for (const [id, versions] of this.byId) this.activeVer.set(id, Math.max(...versions.keys()));
  }

  private insert(raw: unknown, where: string): Question {
    const problems = validateQuestion(raw);
    if (problems.length > 0) throw new Error(`${where}: invalid question: ${problems.join("; ")}`);
    const q = raw as Question;
    let versions = this.byId.get(q.id);
    if (!versions) {
      versions = new Map();
      this.byId.set(q.id, versions);
    }
    if (versions.has(q.version)) throw new Error(`${where}: ${q.id} v${q.version} already exists`);
    versions.set(q.version, q);
    return q;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  versions(id: string): Question[] {
    const v = this.byId.get(id);
    return v ? [...v.values()].toSorted((a, b) => a.version - b.version) : [];
  }

  get(id: string, version?: number): Question | undefined {
    const v = version ?? this.activeVer.get(id);
    return v === undefined ? undefined : this.byId.get(id)?.get(v);
  }

  /** The file holding a version (default: the active one), or undefined when it only lives in the store. */
  file(id: string, version?: number): string | undefined {
    const v = version ?? this.activeVer.get(id);
    return v === undefined ? undefined : this.files.get(`${id}@${v}`);
  }

  activeVersion(id: string): number | undefined {
    return this.activeVer.get(id);
  }

  /** In-memory pointer; the store persists the choice elsewhere. */
  setActive(id: string, version: number): void {
    if (!this.byId.get(id)?.has(version)) throw new Error(`unknown question ${id} v${version}`);
    this.activeVer.set(id, version);
  }

  forSeam(seam: Seam, families: Partial<Record<FamilyId, boolean>>): Question[] {
    const out: Question[] = [];
    for (const id of this.byId.keys()) {
      const q = this.get(id);
      if (q && q.status === "active" && families[q.family] === true && q.seams.includes(seam)) {
        out.push(q);
      }
    }
    return out;
  }

  /**
   * Makes a version known in memory only (no file): used when the learning loop has already saved it in the store,
   * and when the store's versions are loaded at start. Immutable like `addOverlay`; it does not become active.
   */
  register(q: Question): void {
    const problems = validateQuestion(q);
    if (problems.length > 0) throw new Error(`invalid question: ${problems.join("; ")}`);
    if (this.byId.get(q.id)?.has(q.version)) {
      throw new Error(`${q.id} v${q.version} already exists; versions are immutable`);
    }
    this.insert(q, "overlay");
  }

  /** Adds a new immutable version. It does not become active: activation is the store's decision. */
  addOverlay(q: Question): void {
    if (!this.overlayDir) throw new Error("no overlayDir configured");
    const problems = validateQuestion(q);
    if (problems.length > 0) throw new Error(`invalid question: ${problems.join("; ")}`);
    if (this.byId.get(q.id)?.has(q.version)) {
      throw new Error(`${q.id} v${q.version} already exists; versions are immutable`);
    }
    mkdirSync(this.overlayDir, { recursive: true });
    const file = join(this.overlayDir, `${q.id}.v${q.version}.json`);
    writeFileSync(file, `${JSON.stringify(q, null, 2)}\n`, {
      flag: "wx",
    });
    this.insert(q, "overlay");
    this.files.set(`${q.id}@${q.version}`, file);
    if (!this.activeVer.has(q.id)) this.activeVer.set(q.id, q.version);
  }
}
