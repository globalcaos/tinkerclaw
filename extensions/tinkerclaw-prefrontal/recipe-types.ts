/**
 * SS1 (2026-06-04): typed-value vocabulary + pure helpers for recipe ports.
 *
 * Kept fs-free and side-effect-free so the value-flow logic is unit-testable in
 * isolation from the runner. The runner (recipe-runner.ts) and author
 * (recipe-author.ts) both depend on these so the wire format has a single owner.
 */

import type { ValidateFunction } from "ajv";

/** A JSON-Schema object (Ajv-compileable). Kept loose on purpose — gradual typing. */
export type JsonSchema = Record<string, unknown>;

/** A named input port: bind `name` from a producer-step reference `from`. */
export interface Port {
  name: string;
  /** A `steps.<n>.out[.<path>]` reference into a prior step's typed output. */
  from: string;
  /** Optional schema the bound value must satisfy (reserved for SS2+). */
  schema?: JsonSchema;
}

/** Per-step typed IO declared as leading directives in the step body. */
export interface StepIo {
  out?: JsonSchema;
  in?: Port[];
}

const DIRECTIVE_RE = /^(out|in):\s*(.+)$/;
// Other leading step-body directives (the runner parses these itself). We skip
// past them when scanning for io so directive ORDER (io vs uses/loop) never
// matters, and never treat them as prose that ends the io block.
const OTHER_DIRECTIVE_RE = /^(uses|loop):/i;
// A typed-port value must be a JSON object/array. This guards against a prose
// line that merely begins with "out:"/"in:" (e.g. "out: of scope, skip") — such
// a line is left as prose, NOT parsed (and never throws the whole run).
const looksLikeJson = (s: string): boolean => /^[[{]/.test(s.trim());

/**
 * Parse leading `out:`/`in:` directive lines (single-line JSON values) from a
 * step body. Scans the leading directive block: skips blank lines and the
 * sibling `uses:`/`loop:` directives, stops at the first prose line. An
 * `out:`/`in:` line whose value is not JSON-shaped is treated as prose (the
 * block ends) rather than throwing — so a previously-valid untyped recipe whose
 * body happens to start "out:/in:" keeps working (overlay-not-delete).
 */
export function parseStepIoDirectives(body: string): StepIo {
  const io: StepIo = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (OTHER_DIRECTIVE_RE.test(trimmed)) continue; // sibling directive — skip, keep scanning
    const m = DIRECTIVE_RE.exec(trimmed);
    if (!m) break; // first real prose line — stop scanning
    const raw = m[2].trim();
    if (!looksLikeJson(raw)) break; // "out:/in:" prose, not a typed-port directive
    const key = m[1] as "out" | "in";
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${key}: directive is not valid JSON — ${String(err)}`);
    }
    if (key === "out") io.out = value as JsonSchema;
    else io.in = value as Port[];
  }
  return io;
}

/**
 * Remove the leading `out:`/`in:` JSON directives, returning the prose task
 * body. Mirrors parseStepIoDirectives: blank lines and `uses:`/`loop:` siblings
 * are PRESERVED (the runner parses uses/loop off the cleaned body), only the io
 * directives are stripped, and scanning stops at the first prose line.
 */
export function stripStepIoDirectives(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      kept.push(lines[i]);
      continue;
    }
    if (OTHER_DIRECTIVE_RE.test(trimmed)) {
      kept.push(lines[i]); // keep uses:/loop: for the runner to parse
      continue;
    }
    const m = DIRECTIVE_RE.exec(trimmed);
    if (m && looksLikeJson(m[2])) continue; // drop the io directive line
    break; // first prose line
  }
  return [...kept, ...lines.slice(i)].join("\n").trim();
}

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/gi;

/**
 * Extract a typed object from a subagent's prose note: prefer the LAST fenced
 * ```json block; else try the whole note as bare JSON; else undefined.
 */
export function extractTypedOutput(note: string | null | undefined): unknown | undefined {
  if (!note) return undefined;
  let lastFence: string | undefined;
  for (const m of note.matchAll(JSON_FENCE_RE)) lastFence = m[1];
  const candidate = lastFence ?? note.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Navigate `obj` by a dotted `path`; empty path returns `obj` itself. */
export function dotGet(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const STEP_REF_RE = /^steps\.(\d+)\.out(?:\.(.+))?$/;

/** Parse a `steps.<n>.out[.<path>]` reference into its parts, or null. */
export function parseStepRef(ref: string): { stepNumber: number; path: string } | null {
  const m = STEP_REF_RE.exec(ref.trim());
  if (!m) return null;
  return { stepNumber: parseInt(m[1], 10), path: m[2] ?? "" };
}

const TEMPLATE_RE = /\{\{\s*(steps\.\d+\.out(?:\.[^}\s]+)?)\s*\}\}/g;

/**
 * Replace `{{steps.<n>.out.<path>}}` refs with values from `outputsByStep`
 * (1-based step number → that step's validated typed output). String values
 * pass through raw; objects/arrays are JSON-stringified. Unresolvable refs are
 * left verbatim — the seed-time compile check (Task 8) is the real guard.
 */
export function resolveStepRefs(text: string, outputsByStep: Map<number, unknown>): string {
  return text.replace(TEMPLATE_RE, (whole, ref: string) => {
    const parsed = parseStepRef(ref);
    if (!parsed) return whole;
    if (!outputsByStep.has(parsed.stepNumber)) return whole;
    const value = dotGet(outputsByStep.get(parsed.stepNumber), parsed.path);
    if (value === undefined) return whole;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export interface TypedValidationResult {
  ok: boolean;
  value?: unknown;
  /** Ajv error text, ready to append to a corrective re-dispatch prompt. */
  errorText?: string;
}

/**
 * Extract a typed object from a note and validate it against a compiled schema.
 * Returns ok + the value, or a human-readable errorText for the re-dispatch.
 */
export function validateTypedNote(
  note: string | null | undefined,
  validate: ValidateFunction,
): TypedValidationResult {
  const value = extractTypedOutput(note);
  if (value === undefined) {
    return { ok: false, errorText: "no fenced ```json output block was found in the reply" };
  }
  if (validate(value)) return { ok: true, value };
  const errorText = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
    .join("; ");
  return { ok: false, value, errorText };
}
