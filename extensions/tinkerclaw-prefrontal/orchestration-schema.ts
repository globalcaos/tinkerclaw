/**
 * SS0 / capability-parity A2 (2026-06-04): typed self-correcting agent output.
 *
 * agent(prompt,{schema}) must return a VALIDATED object, re-asking the subagent a
 * bounded number of times on mismatch. Rather than re-implement extraction /
 * validation / a retry cap, this REUSES the SS1 value-flow primitives:
 *   - extractTypedOutput + validateTypedNote (recipe-types.ts)
 *   - deriveRedispatchBudget (redispatch-budget.ts) — the J16 derived bound,
 *     NOT a frozen MAX_SCHEMA_RETRIES (the capability-parity plan's Task 4
 *     predates SS1; SS1's J16 derivation supersedes its "default 2").
 */

import AjvPkg from "ajv";
import { validateTypedNote, type JsonSchema } from "./recipe-types.js";
import { deriveRedispatchBudget } from "./redispatch-budget.js";

const AjvCtor = AjvPkg as unknown as typeof import("ajv").default;
const ajv = new AjvCtor({ allErrors: true });

/** Append a structured-output instruction so the subagent emits a json block. */
function withSchemaInstruction(prompt: string, schema: JsonSchema): string {
  return (
    `${prompt}\n\n---\n**Structured output required.** End your reply with one ` +
    "```json fenced block that validates against this JSON-Schema (and nothing " +
    "after it):\n```json\n" +
    JSON.stringify(schema, null, 2) +
    "\n```"
  );
}

/**
 * Spawn an agent whose output must satisfy `schema`; extract + Ajv-validate it,
 * re-dispatching a J16-derived number of times on mismatch (deriveRedispatchBudget),
 * feeding the validation error back into each retry prompt. Returns the validated
 * object; throws a classified error if it never validates within the budget.
 */
export async function agentWithSchema(
  spawn: (prompt: string) => Promise<{ finalText: string }>,
  prompt: string,
  schema: JsonSchema,
): Promise<unknown> {
  const validate = ajv.compile(schema);
  const requiredFieldCount = Array.isArray((schema as { required?: unknown }).required)
    ? (schema as { required: unknown[] }).required.length
    : 0;
  const maxRedispatch = deriveRedispatchBudget({ requiredFieldCount });

  const basePrompt = withSchemaInstruction(prompt, schema);
  let r = await spawn(basePrompt);
  let v = validateTypedNote(r.finalText, validate);
  let attempt = 0;
  while (!v.ok && attempt < maxRedispatch) {
    attempt++;
    r = await spawn(
      `${basePrompt}\n\nYour previous output did not satisfy the required schema: ` +
        `${v.errorText}. Re-emit ONLY a corrected ` +
        "```json block.",
    );
    v = validateTypedNote(r.finalText, validate);
  }
  if (!v.ok) {
    throw new Error(
      `agent output never satisfied its schema after ${maxRedispatch} re-dispatch(es): ${v.errorText}`,
    );
  }
  return v.value;
}
