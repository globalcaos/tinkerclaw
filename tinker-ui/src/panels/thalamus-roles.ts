/**
 * THALAMUS roles on the picker (full deploy, 2026-10-02).
 *
 * the architect's picks are SUGGESTIONS, one per dial stop: smart · default · budget. A stop holds a model and, since this
 * build, an effort. The page draws the role as a letter, S, D or B, next to the model and next to the effort level the
 * role was assigned, and says on the dial what the stop's suggestion is. Everything here is PURE (no DOM, no network):
 * app.ts hands in what `prefrontal.thalamusDefaults` answered and a model-name formatter.
 *
 * A gateway from before this build answers only the old view, `defaults: {high|medium|low: "provider/model"}`. It maps
 * to smart / default / budget with no effort, so the page keeps working against it.
 */

export type RoleTier = "smart" | "default" | "budget";

export interface RoleSuggestion {
  model: string;
  effort?: string;
}
export type RoleSuggestions = Partial<Record<RoleTier, RoleSuggestion>>;

/** In the order the picker offers them: strongest stop first. */
export const ROLES: { tier: RoleTier; letter: string; label: string; hint: string }[] = [
  { tier: "smart", letter: "S", label: "Smart", hint: "deep · wide · best answer" },
  { tier: "default", letter: "D", label: "Default", hint: "the middle stop" },
  { tier: "budget", letter: "B", label: "Budget", hint: "fast · quick · lean" },
];

const LEGACY_TIER: Record<string, RoleTier> = { high: "smart", medium: "default", low: "budget" };

function asSuggestion(v: unknown): RoleSuggestion | undefined {
  if (typeof v === "string" && v.includes("/")) return { model: v };
  if (v && typeof v === "object") {
    const o = v as { model?: unknown; effort?: unknown };
    if (typeof o.model === "string" && o.model.includes("/")) {
      return typeof o.effort === "string" && o.effort
        ? { model: o.model, effort: o.effort }
        : { model: o.model };
    }
  }
  return undefined;
}

/** What the RPC answered, in the new shape. `suggestions` wins; the old `defaults` view is the fallback. */
export function suggestionsFromReply(reply: unknown): RoleSuggestions {
  const r = (reply ?? {}) as { suggestions?: unknown; defaults?: unknown };
  const out: RoleSuggestions = {};
  const take = (src: unknown, rename: (k: string) => RoleTier | undefined) => {
    if (!src || typeof src !== "object") return false;
    let any = false;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const tier = rename(k);
      const s = asSuggestion(v);
      if (tier && s) {
        out[tier] = s;
        any = true;
      }
    }
    return any;
  };
  const isTier = (k: string): RoleTier | undefined =>
    k === "smart" || k === "default" || k === "budget" ? k : undefined;
  if (!take(r.suggestions, isTier)) take(r.defaults, (k) => LEGACY_TIER[k] ?? isTier(k));
  return out;
}

export function rolesOfModel(s: RoleSuggestions, modelId: string): RoleTier[] {
  return ROLES.filter((r) => s[r.tier]?.model === modelId).map((r) => r.tier);
}

const letterOf = (tier: RoleTier): string => ROLES.find((r) => r.tier === tier)?.letter ?? "";

/** "SD" for a model that holds both the smart and the default stop; "" for none. */
export function roleLetters(tiers: readonly RoleTier[]): string {
  return tiers.map(letterOf).join("");
}

/** The roles whose suggestion is exactly this model AT this effort level: the letter drawn next to the level. */
export function rolesAtEffort(s: RoleSuggestions, modelId: string, lvl: string): RoleTier[] {
  return ROLES.filter((r) => s[r.tier]?.model === modelId && (s[r.tier]?.effort ?? "") === lvl).map(
    (r) => r.tier,
  );
}

export function roleWord(tier: RoleTier): string {
  return ROLES.find((r) => r.tier === tier)?.label ?? tier;
}

/** The line under the dial: what the current stop suggests. */
export function suggestionLine(
  s: RoleSuggestions,
  tier: RoleTier,
  o: { modelName: (id: string) => string; effortWord: (lvl: string) => string },
): string {
  const sg = s[tier];
  if (!sg) return `${roleWord(tier)}: no suggestion yet, Thalamus picks`;
  const eff = sg.effort ? ` · ${o.effortWord(sg.effort)}` : "";
  return `${roleWord(tier)}: ${o.modelName(sg.model)}${eff}`;
}
