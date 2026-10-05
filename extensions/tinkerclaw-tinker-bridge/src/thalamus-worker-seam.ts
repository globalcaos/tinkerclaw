// FORK 2026-09-30 (THALAMUS v4, unit D5): what a registered worker provider adds to a `claude` spawn, and where a
// sub-agent's calls are counted. Design doc section 6.2; the registry is `src/infra/thalamus-call-router.ts`.
//
// INERT WHEN EMPTY. With no provider registered `thalamusSpawnExtras` returns no arguments, no environment and no
// model, so `worker.ts` builds today's argument list and environment unchanged. The slot is read by its `Symbol.for`
// key and nothing is imported from core, so this file cannot break a spawn by a missing export.
//
// FAIL OPEN. A provider that throws, or returns the wrong shape, is ignored for that spawn.

/** Must equal `WORKER_PROVIDER_SLOT` in `src/infra/thalamus-call-router.ts`; a core test compares them. */
export const THALAMUS_WORKER_SLOT = "openclaw.thalamus.workerProvider";

type SpawnExtras = { model?: unknown; agentsJson?: unknown; env?: unknown };
type Provider = {
  spawnExtras?: (info: { sessionKey: string; model?: string }) => SpawnExtras | undefined;
  noteSubagentCall?: (event: Record<string, unknown>) => void;
};

function provider(): Provider | undefined {
  const p = (globalThis as Record<symbol, unknown>)[Symbol.for(THALAMUS_WORKER_SLOT)];
  return p && typeof p === "object" ? (p as Provider) : undefined;
}

/** Must equal `LEAF_RESOLVER_SLOT` in `src/infra/thalamus-call-router.ts`; a test compares them. */
export const THALAMUS_LEAF_RESOLVER_SLOT = "openclaw.thalamus.leafModelResolver";

/**
 * FORK 2026-10-03: whether Thalamus owns a model choice right now (enforce, with that site's flag on). Read by key from
 * the leaf resolver's `owns`; no resolver, an older one without `owns`, or a throw all mean no. the architect: "Make sure
 * Thalamus is owner of all those model choices when it is working."
 */
export function thalamusOwnsModelChoice(site: "subagent" | "orchestrate-default"): boolean {
  const slot = (globalThis as Record<symbol, unknown>)[Symbol.for(THALAMUS_LEAF_RESOLVER_SLOT)] as
    | { owns?: (s: string) => unknown }
    | undefined;
  try {
    return typeof slot?.owns === "function" && slot.owns(site) === true;
  } catch {
    return false;
  }
}

/** The worker's spawn guidance opens with who picks a sub-agent's model, so the agent does not override Thalamus. */
export function subagentModelOwnerText(owned = thalamusOwnsModelChoice("subagent")): string {
  return owned
    ? "Thalamus picks it right now: leave `--model` out and it prices each spawn from its board, with the configured default for any spawn it cannot price. Name a model only when the task needs that exact one; a named model is never replaced. For reference, the weights it works from:"
    : "Thalamus is not picking models right now, so pick by task weight:";
}

/** The same for an orchestrate leaf (`agent(task, {model})`). */
export function leafModelOwnerText(owned = thalamusOwnsModelChoice("orchestrate-default")): string {
  return owned
    ? 'Thalamus picks each leaf\'s model right now: leave `{model}` out (or say `"auto"`) and it prices the unit from its board, with the default leaf (sonnet) for any unit it cannot price. Name a model only when a unit needs that exact one; a named model is never replaced. The table below is what it works from.'
    : "Pick the leaf model PER UNIT by weight (`agent(task, {model})`) — this is the main cost lever, and it is cheap to fan out wide. Omitting `{model}` uses the runtime default (sonnet).";
}

/**
 * The only environment variables a provider may add to a spawn. EMPTY on purpose: Thalamus needs none yet, and a name
 * is added here by a commit that says why. An open pattern would let a provider overwrite the session key, a
 * credential or the API base URL of a worker.
 */
export const THALAMUS_ENV_ALLOWLIST: readonly string[] = [];

export type ThalamusSpawnExtras = {
  args: string[];
  env: Record<string, string>;
  model?: string;
};

const NONE: ThalamusSpawnExtras = { args: [], env: {} };

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function thalamusSpawnExtras(info: {
  sessionKey: string;
  model?: string;
}): ThalamusSpawnExtras {
  const p = provider();
  if (!p || typeof p.spawnExtras !== "function") return NONE;
  try {
    const x = p.spawnExtras(info);
    if (!x || typeof x !== "object") return NONE;
    const args: string[] = [];
    if (typeof x.agentsJson === "string" && x.agentsJson && isJsonObject(x.agentsJson)) {
      args.push("--agents", x.agentsJson);
    }
    const env: Record<string, string> = {};
    if (x.env && typeof x.env === "object") {
      for (const [k, v] of Object.entries(x.env as Record<string, unknown>)) {
        if (typeof v === "string" && THALAMUS_ENV_ALLOWLIST.includes(k)) env[k] = v;
      }
    }
    const model = typeof x.model === "string" && x.model.trim() ? x.model.trim() : undefined;
    if (args.length === 0 && Object.keys(env).length === 0 && !model) return NONE;
    return { args, env, ...(model ? { model } : {}) };
  } catch {
    return NONE;
  }
}

/** Counting only; never throws. */
export function noteThalamusSubagentCall(event: Record<string, unknown>): void {
  try {
    provider()?.noteSubagentCall?.(event);
  } catch {
    /* counting must never disturb a stream */
  }
}
