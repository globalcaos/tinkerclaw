/**
 * SS2a (2026-06-06): the pure `when:` guard evaluator (BROCA combinators).
 *
 * A tiny, sandboxed, side-effect-free boolean grammar over prior steps' typed
 * outputs — NOT JS eval (spec §4.2: "no arbitrary code in markdown"). Kept fs-free
 * so it is unit-testable in isolation, like recipe-types.ts / redispatch-budget.ts.
 *
 * Grammar (SS2a): OR of AND of factors; each factor optionally `not`-prefixed;
 * a factor is `<operand> <op> <operand>` or a bare `<operand>` (truthiness).
 * Operand = a `steps.<n>.out[.path]` reference (numeric) or a JSON literal.
 * Ops: == != < <= > >=. Boolean keywords and/or/not split on surrounding spaces
 * (a string literal containing " and "/" or " is an accepted SS2a limitation).
 */
import { dotGet, parseStepRef } from "./recipe-types.js";

export class WhenEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhenEvalError";
  }
}

const REF_RE = /^steps\.\d+\.out(?:\..+)?$/;
const TWO_CHAR_OPS = ["==", "!=", "<=", ">="] as const;
const ONE_CHAR_OPS = ["<", ">"] as const;

/** Every `steps.<n>.out…` token in an expression (for the seed-time compile check). */
export function collectWhenRefs(expr: string): string[] {
  return expr.split(/\s+/).filter((tok) => REF_RE.test(tok));
}

function resolveOperand(token: string, outputs: Map<number, unknown>): unknown {
  const t = token.trim();
  if (t === "") throw new WhenEvalError("empty operand in when: expression");
  if (REF_RE.test(t)) {
    const ref = parseStepRef(t);
    if (!ref) throw new WhenEvalError(`bad step reference: ${t}`);
    if (!outputs.has(ref.stepNumber)) {
      throw new WhenEvalError(
        `when: references step ${ref.stepNumber} which has no typed output yet`,
      );
    }
    return dotGet(outputs.get(ref.stepNumber), ref.path);
  }
  try {
    return JSON.parse(t);
  } catch {
    throw new WhenEvalError(
      `when: operand is neither a steps.<n>.out ref nor a JSON literal: ${t}`,
    );
  }
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function ordered(a: unknown, b: unknown, op: string): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  }
  throw new WhenEvalError(`when: ${op} requires two numbers or two strings`);
}

function findOp(factor: string): { op: string; idx: number } | null {
  for (const op of TWO_CHAR_OPS) {
    const idx = factor.indexOf(op);
    if (idx > 0) return { op, idx };
  }
  for (const op of ONE_CHAR_OPS) {
    const idx = factor.indexOf(op);
    if (idx > 0) return { op, idx };
  }
  return null;
}

function evalFactor(factor: string, outputs: Map<number, unknown>): boolean {
  let body = factor.trim();
  let negate = false;
  while (body.startsWith("not ")) {
    negate = !negate;
    body = body.slice(4).trim();
  }
  const found = findOp(body);
  let result: boolean;
  if (!found) {
    result = Boolean(resolveOperand(body, outputs));
  } else {
    const left = resolveOperand(body.slice(0, found.idx), outputs);
    const right = resolveOperand(body.slice(found.idx + found.op.length), outputs);
    result =
      found.op === "=="
        ? deepEq(left, right)
        : found.op === "!="
          ? !deepEq(left, right)
          : ordered(left, right, found.op);
  }
  return negate ? !result : result;
}

/** Evaluate a `when:` expression against a 1-based step-number → typed-output map. */
export function evaluateWhen(expr: string, outputs: Map<number, unknown>): boolean {
  const trimmed = expr.trim();
  if (trimmed === "") throw new WhenEvalError("empty when: expression");
  // OR of AND of factors; `and` binds tighter than `or`.
  return trimmed
    .split(" or ")
    .some((orTerm) => orTerm.split(" and ").every((factor) => evalFactor(factor, outputs)));
}
