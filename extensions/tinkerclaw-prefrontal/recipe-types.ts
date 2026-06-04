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

/**
 * Parse leading `out:`/`in:` directive lines (single-line JSON values) from a
 * step body. Scanning stops at the first line that is not blank and not a
 * directive — directives must lead, exactly like `uses:`.
 */
export function parseStepIoDirectives(body: string): StepIo {
  const io: StepIo = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = DIRECTIVE_RE.exec(trimmed);
    if (!m) break; // first real prose line — stop scanning
    const key = m[1] as "out" | "in";
    let value: unknown;
    try {
      value = JSON.parse(m[2]);
    } catch (err) {
      throw new Error(`${key}: directive is not valid JSON — ${String(err)}`);
    }
    if (key === "out") io.out = value as JsonSchema;
    else io.in = value as Port[];
  }
  return io;
}

/** Remove the leading io directive lines, returning the prose task body. */
export function stripStepIoDirectives(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (DIRECTIVE_RE.test(trimmed)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
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
