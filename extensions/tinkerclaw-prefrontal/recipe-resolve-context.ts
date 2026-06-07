import type { RecipeParamSpec } from "./recipe-author.js";

// ─── BROCA CONTEXT resolution tier (Seam 1 of the context-memory micro-design) ──
//
// The CONTEXT tier runs at the recipe.run ingress AFTER the shipped P0
// precedence merge (recipe-var-store.ts mergePrecedence) and BEFORE the P1.1
// durable ASK. Its job: for any declared param P0 left "unresolved", try to
// EXTRACT the value from the run intent + the recent conversation, so Jarvis
// never asks a human for a value it was probably just told.
//
// Everything here is BEST-EFFORT. The gateway-coupled `resolveFromContext`
// catches every throw/timeout and returns `{}` — it can never throw into the
// run or block the gateway. The two halves it leans on (`buildExtractionPrompt`,
// `parseExtraction`) are PURE and unit-tested with no fakes.
//
// SECRETS: this module never sees a secret. The rpcs ingress strips
// `secret:true` decls out of `missingDecls` before calling in (an inferred
// credential is a hint, not ground truth — it must go through the confirmed
// ASK). The validators here are an additional backstop, not the gate.
//
// VALIDATION: every extracted value is re-checked against its declared
// type/enum/pattern (mirroring recipe-runner.ts validateParams). A hallucinated
// or mis-typed extraction is DROPPED, never injected — so the LLM cannot poison
// a run by returning the wrong shape.

/** A minimal loopback shape so this module does not couple to the full callGateway type (and tests can fake it trivially). */
export type GatewayCall = <T = Record<string, unknown>>(args: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

/** One recent conversation message, as returned by chat.history. */
export interface RecentMessage {
  role?: string;
  content?: unknown;
}

export interface DeriveContextTimeoutSignals {
  /** How many vars the extraction prompt must cover (wider prompt → more time). */
  missingCount: number;
  /** Recipe fitness success rate in [0,1]; omit when unmeasured (defaults to 0.5). */
  fitnessSuccessRate?: number;
  /** Recipe step count, threaded by the caller; a longer recipe earns no extra base today but is part of the J16 signal surface. */
  stepCount?: number;
}

/** Clamp a value into the [0,1] interval. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * J16 (FOUNDATION §1, "fractal not fixed"): the CONTEXT-extraction timeout is
 * NOT a constant. It is DERIVED from the live situation:
 *   - missingCount       : each extra var widens the extraction prompt → more time
 *   - fitnessSuccessRate : a shaky recipe (low success) earns more slack to resolve
 *
 * The coefficients below are a derivation, not the answer; the *output* responds
 * to the inputs (proven by recipe-resolve-context.test.ts). Floored at `base`
 * (one round-trip is always allowed). Do not collapse this to a literal — that
 * would re-introduce a frozen `const CONTEXT_TIMEOUT_MS = …` (the exact J16
 * anti-pattern; see spawn-budget.ts for the same guard).
 */
export function deriveContextTimeoutMs(signals: DeriveContextTimeoutSignals): number {
  const base = 8_000; // one structured-extraction round-trip
  const missingCount = Math.max(0, signals.missingCount ?? 0);
  const perVar = 2_000 * missingCount; // each var widens the extraction prompt
  const uncertainty = 1 - clamp01(signals.fitnessSuccessRate ?? 0.5); // [0,1]
  const derived = Math.round((base + perVar) * (1 + 0.5 * uncertainty)); // never frozen
  return Math.max(base, derived); // floor at one round-trip
}

/** Render the type-aware constraint suffix for one decl: e.g. `enum: a|b`, `pattern: ^x`. */
function declConstraints(spec: RecipeParamSpec): string {
  const parts: string[] = [];
  if (spec.type === "enum" && Array.isArray(spec.enum) && spec.enum.length > 0) {
    parts.push(`enum: ${spec.enum.join("|")}`);
  }
  if (spec.type === "string" && typeof spec.pattern === "string" && spec.pattern.length > 0) {
    parts.push(`pattern: ${spec.pattern}`);
  }
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/** Extract a plain text string from a chat.history message's `content` (string or content-block array). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join(" ");
  }
  return "";
}

/**
 * PURE. Build the structured-extraction prompt for the still-missing vars.
 *
 * One type-aware line per var so the LLM coerces correctly:
 *   `name (type[, enum: a|b][, pattern: …]): description`
 * then the run intent, then the last 3-5 conversation messages, then a STRICT
 * JSON instruction `{name: value | "unknown"}` with an explicit "respect the
 * declared type/enum, do not invent" directive.
 *
 * Type-awareness is load-bearing: it is what makes the extraction respect the
 * param's type/enum (a hard requirement — parseExtraction is the backstop, this
 * is the steer).
 */
export function buildExtractionPrompt(
  missingDecls: Record<string, RecipeParamSpec>,
  intent: string | undefined,
  recentMessages: RecentMessage[],
): string {
  const varLines = Object.entries(missingDecls).map(([name, spec]) => {
    const desc = spec.description ? spec.description : "(no description)";
    return `- ${name} (${spec.type}${declConstraints(spec)}): ${desc}`;
  });

  // Last 3-5 messages (freshest context); render as `role: text`.
  const tail = recentMessages.slice(-5);
  const convoLines = tail
    .map((m) => {
      const role = typeof m.role === "string" && m.role ? m.role : "message";
      const text = messageText(m.content).trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter((l) => l.length > 0);

  return [
    "Extract recipe parameter values from the conversation below.",
    "",
    "Parameters to find (one per line — `name (type[, constraints]): description`):",
    ...varLines,
    "",
    `Run intent: ${intent && intent.trim() ? intent.trim() : "(none given)"}`,
    "",
    "Recent conversation (oldest first):",
    ...(convoLines.length > 0 ? convoLines : ["(no recent messages)"]),
    "",
    'Return STRICT JSON only: an object {name: value | "unknown"}.',
    'Use "unknown" for any parameter not clearly stated in the conversation or intent.',
    "Respect each parameter's declared type/enum/pattern. Do NOT invent values.",
  ].join("\n");
}

/**
 * PURE. Validate one extracted value against its decl, mirroring the coercion in
 * recipe-runner.ts validateParams. Returns the canonical string form on success,
 * or `undefined` if the value fails its type/enum/pattern (→ DROP it).
 */
function validateExtracted(raw: string, spec: RecipeParamSpec): string | undefined {
  const BOOL_TRUE = new Set(["true", "1", "yes"]);
  const BOOL_FALSE = new Set(["false", "0", "no"]);
  switch (spec.type) {
    case "string": {
      if (typeof spec.pattern === "string" && spec.pattern.length > 0) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(spec.pattern);
        } catch {
          re = null;
        }
        if (re && !re.test(raw)) return undefined;
      }
      return raw;
    }
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : undefined;
    }
    case "boolean": {
      const lc = raw.trim().toLowerCase();
      if (BOOL_TRUE.has(lc)) return "true";
      if (BOOL_FALSE.has(lc)) return "false";
      return undefined;
    }
    case "enum": {
      const members = spec.enum ?? [];
      return members.includes(raw) ? raw : undefined;
    }
    case "list<string>": {
      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return items.join(",");
    }
    default:
      return raw;
  }
}

/**
 * PURE. Parse a structured-extraction response into a validated `{name: value}`.
 *
 *  1. JSON.parse the raw payload (best-effort; a non-JSON / non-object raw → {}).
 *  2. DROP any key not in `missingDecls` (a foreign / hallucinated key).
 *  3. DROP any value that is "unknown" (case-insensitive) or empty.
 *  4. VALIDATE each survivor against its decl (type/number/boolean coercion,
 *     enum membership, pattern) — DROP on fail.
 *
 * The result therefore only ever contains values that BOTH were asked for AND
 * satisfy their declared shape: a mis-typed extraction can never reach the run.
 */
export function parseExtraction(
  raw: unknown,
  missingDecls: Record<string, RecipeParamSpec>,
): Record<string, string> {
  let obj: unknown;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(obj as Record<string, unknown>)) {
    const spec = missingDecls[name];
    if (!spec) continue; // foreign key → drop
    if (value === null || value === undefined) continue;
    const str = typeof value === "string" ? value : String(value);
    const trimmed = str.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "unknown") continue; // unknown/empty → drop
    const validated = validateExtracted(str, spec);
    if (validated === undefined) continue; // off-type/off-enum/off-pattern → drop
    out[name] = validated;
  }
  return out;
}

/** Loosely pull the extraction payload out of whatever shape the loopback RPC returns. */
function extractionPayload(resp: unknown): unknown {
  if (resp == null) return undefined;
  if (typeof resp === "string") return resp;
  if (typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    // common envelope shapes from a structured-extraction / do-task loopback
    if (r.values !== undefined) return r.values;
    if (r.extracted !== undefined) return r.extracted;
    if (r.json !== undefined) return r.json;
    if (typeof r.result === "string" || (r.result && typeof r.result === "object")) return r.result;
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
    return r; // assume the response object IS the {name: value} map
  }
  return undefined;
}

export interface ResolveFromContextArgs {
  missingDecls: Record<string, RecipeParamSpec>;
  intent?: string;
  sessionKey?: string;
  fitnessSuccessRate?: number;
  stepCount?: number;
  callGateway: GatewayCall;
}

/**
 * CONTEXT tier entrypoint (gateway-coupled, BEST-EFFORT). Resolves still-missing
 * NON-SECRET vars from the run intent + recent conversation.
 *
 *  1. Poll `chat.history` ONCE (NOT a loop) — the same poll seam spawnRecipeRewrite
 *     uses (recipe-rpcs.ts chat.history call).
 *  2. Build the type-aware extraction prompt.
 *  3. Call ONE lightweight `fork.agent.structured-extract` loopback under the
 *     J16-derived timeout. If that RPC is ABSENT (throws / returns nothing),
 *     fall back to a single `fork.agent.do-task` with the JSON-schema expectation
 *     baked into the prompt. NEVER `fork.subagents.spawn` (that blocks on a child
 *     session — over-weight for "pull a few values from the last N messages").
 *  4. parseExtraction the result and return the validated `{name: value}` map.
 *
 * Any throw / timeout anywhere → returns `{}`. Never throws into the run.
 */
export async function resolveFromContext(
  args: ResolveFromContextArgs,
): Promise<Record<string, string>> {
  const { missingDecls, intent, sessionKey, fitnessSuccessRate, stepCount, callGateway } = args;
  try {
    if (!missingDecls || Object.keys(missingDecls).length === 0) return {};

    const timeoutMs = deriveContextTimeoutMs({
      missingCount: Object.keys(missingDecls).length,
      fitnessSuccessRate,
      stepCount,
    });

    // 1. Poll chat.history ONCE (best-effort).
    let recentMessages: RecentMessage[] = [];
    try {
      const hist = await callGateway<{ messages?: RecentMessage[] }>({
        method: "chat.history",
        params: { sessionKey, limit: 30 },
        timeoutMs: 10_000,
      });
      recentMessages = Array.isArray(hist?.messages) ? hist.messages : [];
    } catch {
      recentMessages = [];
    }

    // 2. Build the type-aware extraction prompt.
    const prompt = buildExtractionPrompt(missingDecls, intent, recentMessages);

    // 3. ONE lightweight structured-extraction loopback under the J16 timeout;
    //    fall back to a one-off do-task if structured-extract is absent.
    let payload: unknown;
    try {
      const resp = await callGateway<unknown>({
        method: "fork.agent.structured-extract",
        params: { prompt, sessionKey, schema: "json-object" },
        timeoutMs,
      });
      payload = extractionPayload(resp);
    } catch {
      payload = undefined; // structured-extract absent / errored → try the fallback
    }

    if (payload === undefined) {
      try {
        const resp = await callGateway<unknown>({
          method: "fork.agent.do-task",
          params: {
            task: `${prompt}\n\nReturn ONLY the JSON object described above.`,
            sessionKey,
            expectsCompletionMessage: false,
          },
          timeoutMs,
        });
        payload = extractionPayload(resp);
      } catch {
        return {};
      }
    }

    // 4. Validate + return.
    return parseExtraction(payload, missingDecls);
  } catch {
    return {}; // whole tier is best-effort — never throws into the run
  }
}
