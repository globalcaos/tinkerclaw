import type { RecipeParamSpec } from "./recipe-author.js";
import { SECRET_MASK, type VarStore } from "./recipe-var-store.js";

// ─── BROCA P1.1 durable ASK resolver (Seam 5 #3 / Wiring-B of the ask-for-missing micro-design) ──
//
// When the P0 precedence merge + the CONTEXT/MEMORY tiers all leave a declared
// param unresolved, BROCA ASKS the operator durably: it emits the ask (the
// caller's job) and then this resolver POLLS the conversation until the answer
// arrives or the deadline passes. It mirrors spawnRecipeRewrite's spawn→wait→
// history seam (recipe-rpcs.ts) — same `chat.history` poll, same newest→oldest
// assistant/operator scan — but as a deadline-bounded poll LOOP rather than a
// single wait, because the human reply is asynchronous.
//
// SECRETS (PII boundary, the load-bearing invariant): a `secret:true` param is
// NEVER persisted on the first answer. The operator must send an explicit CONFIRM
// turn ('yes' / 'save' / 'confirm' / 'ok') AFTER giving the value before it is
// written to the VarStore. Until confirmed the raw secret is held only in memory,
// never persisted, and is ALWAYS returned MASKED (SECRET_MASK) in the answer map
// — so a secret value can never leak through this resolver's return value or any
// log line. A non-secret value is persisted immediately (secret=false) and
// returned verbatim.
//
// BEST-EFFORT: the whole resolver is wrapped in try/catch and returns `null` on
// ANY error (and on a deadline with no parseable reply). It never throws into the
// run; `null` tells the caller "the ask did not resolve" so it can clear-fail.

/** A minimal loopback shape so this module does not couple to the full callGateway type (and tests can fake it trivially). */
export type AskGatewayCall = <T = Record<string, unknown>>(args: {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}) => Promise<T>;

/** One conversation message, as returned by chat.history. */
export interface AskMessage {
  role?: string;
  content?: unknown;
}

/** The ASK event the resolver consumes: which vars are still missing + how long to wait. */
export interface AskEvent {
  sessionKey: string;
  kitRef: string;
  missingVars: { name: string; prompt: string }[];
  timeoutMs: number;
}

export interface MakeAskResolverDeps {
  /** The gateway loopback (injected — keeps the runner gateway-decoupled). */
  callGateway: AskGatewayCall;
  /** The private value store; answered vars are persisted here (secrets only after confirm). */
  varStore: VarStore;
  /** Declared param specs (name → spec); `secret:true` drives the confirm gate + masking. */
  declaredParams?: Record<string, RecipeParamSpec>;
  /** Poll cadence in ms (default ~3000, mirroring spawnRecipeRewrite's history cadence). Injectable for tests. */
  pollIntervalMs?: number;
  /** Clock seam (default Date.now). Injectable so tests drive the deadline without real waits. */
  now?: () => number;
  /** Sleep seam (default real setTimeout). Injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

/** The resolver: returns the answered `{name: value}` map (secrets MASKED), or `null` on timeout/error. */
export type AskResolver = (ev: AskEvent) => Promise<Record<string, string> | null>;

/** Words that count as an explicit confirm turn for persisting a secret. */
const CONFIRM_WORDS = new Set(["yes", "y", "save", "confirm", "ok", "okay", "sure"]);

const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Extract plain text from a chat.history message's `content` (string or content-block array). */
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

/** Is this an operator/user-authored message (the side that answers the ask)? */
function isOperatorRole(role: unknown): boolean {
  return role === "user" || role === "operator" || role === "human";
}

/** Is this reply text an explicit confirm turn (for the secret-save gate)? */
function isConfirmTurn(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (CONFIRM_WORDS.has(t)) return true;
  // also accept a leading confirm word ("yes, save it")
  const first = t.split(/[\s,]+/)[0] ?? "";
  return CONFIRM_WORDS.has(first);
}

/**
 * PURE. Parse one operator reply into a `{name: value}` map for the still-missing vars.
 *  - Exactly one missing var → the WHOLE reply (trimmed) is the value.
 *  - Multiple missing vars → one `name: value` line per var (case-sensitive name match).
 * Returns only the vars it could parse; unmatched vars are simply absent (keep polling).
 */
export function parseAskReply(text: string, missingNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = text.trim();
  if (trimmed === "") return out;

  if (missingNames.length === 1) {
    out[missingNames[0]] = trimmed;
    return out;
  }

  const wanted = new Set(missingNames);
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if (wanted.has(name) && out[name] === undefined && value.trim() !== "") {
      out[name] = value.trim();
    }
  }
  return out;
}

/**
 * Build the durable-ASK resolver. The returned async fn polls `chat.history` every
 * `pollIntervalMs` until the deadline (`now() + ev.timeoutMs`), scans newest→oldest
 * for the operator reply answering the ask, persists each answered var to the
 * VarStore (secrets only after an explicit confirm turn), and returns the answer
 * map with secrets MASKED. Returns `null` on deadline-with-no-reply or any error.
 */
export function makeAskResolver(deps: MakeAskResolverDeps): AskResolver {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async function resolveAsk(ev: AskEvent): Promise<Record<string, string> | null> {
    try {
      const missingNames = (ev.missingVars ?? []).map((v) => v.name);
      if (missingNames.length === 0) return null;

      const deadline = now() + ev.timeoutMs;
      // answered-but-unconfirmed secrets are held here (raw), NEVER persisted/returned raw.
      const pendingSecrets: Record<string, string> = {};
      const answered: Record<string, string> = {}; // returned map (secrets masked)
      const isSecret = (name: string): boolean => deps.declaredParams?.[name]?.secret === true;

      let first = true;
      // Poll until every missing var is resolved or the deadline passes.
      while (now() < deadline) {
        if (!first) await sleep(pollIntervalMs);
        first = false;

        let messages: AskMessage[] = [];
        try {
          const hist = await deps.callGateway<{ messages?: AskMessage[] }>({
            method: "chat.history",
            params: { sessionKey: ev.sessionKey, limit: 30 },
            timeoutMs: 10_000,
          });
          messages = Array.isArray(hist?.messages) ? hist.messages : [];
        } catch {
          continue; // a transient history error → keep polling within the deadline
        }

        // Newest→oldest: find the freshest operator reply that parses a value, and
        // (for secrets) the freshest confirm turn AFTER that value.
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!isOperatorRole(m?.role)) continue;
          const text = messageText(m?.content).trim();
          if (text === "") continue;

          // A confirm turn promotes any pending secret to persisted.
          if (isConfirmTurn(text)) {
            for (const name of Object.keys(pendingSecrets)) {
              deps.varStore.set(ev.kitRef, name, pendingSecrets[name], true);
              answered[name] = SECRET_MASK; // never return the raw secret
              delete pendingSecrets[name];
            }
            continue;
          }

          const stillMissing = missingNames.filter(
            (n) => answered[n] === undefined && pendingSecrets[n] === undefined,
          );
          if (stillMissing.length === 0) continue;

          const parsed = parseAskReply(text, stillMissing);
          for (const [name, value] of Object.entries(parsed)) {
            if (isSecret(name)) {
              // Hold the secret; do NOT persist and do NOT return it raw until confirmed.
              pendingSecrets[name] = value;
              answered[name] = SECRET_MASK; // masked in the returned/logged map
            } else {
              deps.varStore.set(ev.kitRef, name, value, false);
              answered[name] = value;
            }
          }
        }

        // Done when every missing var is either persisted (non-secret) or masked
        // (secret answered — persistence happens on confirm, but the ask is satisfied).
        const allResolved = missingNames.every((n) => answered[n] !== undefined);
        if (allResolved && Object.keys(pendingSecrets).length === 0) {
          return answered;
        }
        if (allResolved) {
          // every var answered, but a secret is still awaiting confirm — keep polling
          // until the confirm turn arrives or the deadline passes.
          continue;
        }
      }

      // Deadline reached. If we parsed at least one var (incl. a masked secret),
      // return what we have; a fully-empty result means "no reply" → null.
      return Object.keys(answered).length > 0 ? answered : null;
    } catch {
      return null; // best-effort — never throws into the run
    }
  };
}
