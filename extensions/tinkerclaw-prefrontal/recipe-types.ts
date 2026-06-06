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
  /**
   * Optional schema the bound value must satisfy. SS2b: when the port carries a
   * combinator's kit argument, this schema is `{"type":"string"}` and the bound
   * value is a `kitRef` string — validated by `parseKitRefValue` at dispatch time
   * (the runner-as-kit-factory edge), not by Ajv shape alone.
   */
  schema?: JsonSchema;
}

/** Per-step typed IO declared as leading directives in the step body. */
export interface StepIo {
  out?: JsonSchema;
  in?: Port[];
}

const DIRECTIVE_RE = /^(out|in):\s*(.+)$/;
// Other leading step-body directives (the runner parses these itself). We skip
// past them when scanning for io so directive ORDER (io vs uses/loop/invoke)
// never matters, and never treat them as prose that ends the io block.
// `invoke skill:` (SS3) is a sibling directive (keyword + " skill:"), so the
// pattern matches that two-word form, not a bare `invoke:`.
const OTHER_DIRECTIVE_RE = /^(?:uses|loop|when|return|done|map|filter|onError):|^invoke\s+skill:/i;
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

// SS2b: a `kitRef` value — `owner/slug` or a bare `slug` (each segment
// [a-z0-9][a-z0-9-]*). The runner dispatches such a value as a sub-kit (the
// kit-factory edge). This mirrors parseUsesDirective's static-slug normalization,
// factored out so the dynamic-uses resolution path validates identically.
const KITREF_RE = /^([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?$/;

/**
 * Normalize a `kitRef` VALUE (e.g. a step's typed output bound onto a combinator's
 * kit port) to a canonical `owner/slug`, or null when malformed. A bare slug
 * adopts the `globalcaos/` owner (same default as a static `uses:` slug). Rejects
 * uppercase, whitespace, `..`, empty, more than two segments, and anything that is
 * a `{{…}}` template or a `steps.…` ref (those are resolved BEFORE this is called).
 */
export function parseKitRefValue(ref: string): string | null {
  if (typeof ref !== "string") return null;
  const t = ref.trim();
  const m = KITREF_RE.exec(t);
  if (!m) return null;
  return m[2] ? t : `globalcaos/${m[1]}`;
}

// SS5a (2026-06-06): the unified error envelope. Every step failure is CLASSIFIED
// into one of these kinds; `recoverable` is computed FROM the kind (a hard limit
// has zero expected value from a retry), so the onError policy router stays
// situation-derived, not hand-set per call-site. No silent failure (FOUNDATION §5):
// every error is classified + persisted on PlanStep.error + emitTrail'd.
export type ErrorKind =
  | "schema-mismatch"
  | "spawn-failure"
  | "timeout"
  | "budget-exceeded"
  | "guard-eval-error"
  | "sub-kit-failure"
  | "map-filter-resolution"
  | "depth-limit"
  | "skill-not-found"
  | "recovery-exhausted"
  | "fallback-failed"
  | "execution-error";

/** A classified step failure. `recoverable` drives the onError policy: a recoverable
 * error may be retried; a non-recoverable one can only be caught by fallback /
 * continue-partial (retry is forbidden — it has zero expected value). */
export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

/**
 * The recoverable kinds — the SINGLE SOURCE OF TRUTH the runner's recovery driver
 * consults. A retry MAY help ONLY for a transient timeout, a recoverable output-shape
 * mismatch, or a spawn failure. Everything else is a hard limit — retry is futile.
 *
 * OVERRIDE (SS5a, 2026-06-06): `execution-error` is DELIBERATELY excluded. An
 * unclassified failure that surfaced as a bare execution-error has no diagnosable
 * transient cause, so the runner must NEVER auto-retry it — it can only be caught by
 * fallback / continue-partial or recorded via markError. This corrects the
 * micro-design/plan default (which listed execution-error as recoverable).
 */
const RECOVERABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "schema-mismatch",
  "timeout",
  "spawn-failure",
]);

/**
 * Is a retry worth attempting for this error kind? (Kind-derived, never author-set.)
 * This is the ONE function the runner calls to gate auto-retry — keep it the single
 * source of truth. Returns true ONLY for {schema-mismatch, timeout, spawn-failure};
 * false for everything else, INCLUDING execution-error (never auto-retry an
 * unclassified failure).
 */
export function isRecoverableKind(kind: ErrorKind): boolean {
  return RECOVERABLE_KINDS.has(kind);
}

/**
 * Construct a ClassifiedError, stamping `recoverable` FROM the kind via
 * isRecoverableKind (the single source of truth) unless an explicit override is
 * passed (used on the recovery-EXHAUSTED auto-path, where a once-recoverable error
 * is now terminal).
 */
export function classifyError(
  kind: ErrorKind,
  message: string,
  details?: Record<string, unknown>,
  recoverable?: boolean,
): ClassifiedError {
  return {
    kind,
    message,
    recoverable: recoverable ?? isRecoverableKind(kind),
    ...(details !== undefined ? { details } : {}),
  };
}

/** SS5a: a step's `onError:` recovery policy (parsed by parseOnErrorDirective in
 * recipe-runner.ts). `retry` carries the author's retryCount (a DOWNWARD cap; the
 * runner floors the real bound via deriveRecoveryRetryBudget) as either a literal
 * number or a `{{template}}` string resolved at dispatch. `fallback` carries a kitRef
 * (bare or owner-prefixed; validated by checkOnErrorRefs at seed). */
export type OnErrorPolicy =
  | { mode: "retry"; retryCount: string | number }
  | { mode: "fallback"; kitRef: string }
  | { mode: "continue-partial" };

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
