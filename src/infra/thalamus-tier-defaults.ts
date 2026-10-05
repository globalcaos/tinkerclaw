// src/infra/thalamus-tier-defaults.ts
//
// THALAMUS SUGGESTIONS — one suggested model, and its effort, per stop of the dial.
//
// FORK 2026-09-23 (the architect): "When I use the right click on a model in the model picker, I should
// be able to set it as default for Thalamus." The picker's right-click wrote one pinned model per
// dial band, and the pin beat the router. FORK 2026-10-02 (the architect, full deploy): the picks are
// SUGGESTIONS, "model AND effort per stop"; the router starts from the suggestion and moves off it
// only for a reason (a limit, a cooling supply, a context too small, the allowlist, or another rung
// that still wins for this task after the suggestion's prior). The file keeps its name and its
// writer (the picker's right-click, through `prefrontal.thalamusDefaults`); what changed is the
// vocabulary and the shape:
//
//   { "smart":   { "model": "claude-code/claude-opus-5-5", "effort": "max" },
//     "default": { "model": "claude-code/claude-sonnet-5-5", "effort": "low" },
//     "budget":  { "model": "xai/grok-4.7" } }
//
// THE OLD FORMAT STILL READS. Keys `high` / `medium` / `low` mean smart / default / budget, a bare
// `"provider/model"` string is a model with no effort, and when both spellings of one stop exist the
// new one wins. Nothing migrates the file until the picker writes a stop, and then the whole file is
// written in the new shape.
//
// BANDS follow the dial's own split (tinker-ui/src/panels/routing-rationale.ts BIAS_STOPS):
// 0-2 → budget, 3 → default, 4-6 → smart. An UNSET dial is the middle stop, 3 (2026-10-02).
//
// Same contract as orca-bias-store.ts: a FILE (the writer is the gateway extension, it must survive
// a restart), cached by (mtimeMs, size), never throws, and a miss is `undefined` — an unset stop
// means "no suggestion", so Thalamus decides that stop from its own board.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { THALAMUS_DEFAULT_BIAS_IDX } from "../shared/thalamus-frontier.js";

export type ThalamusTier = "budget" | "default" | "smart";
export type ThalamusSuggestion = { model: string; effort?: string };
export type ThalamusTierDefaults = Partial<Record<ThalamusTier, ThalamusSuggestion>>;

/** Most-capable stop first, the order the picker lists them. */
export const THALAMUS_TIERS: readonly ThalamusTier[] = ["smart", "default", "budget"];

/** The spelling the file and the page used until 2026-10-02. */
const LEGACY_KEY: Readonly<Record<ThalamusTier, string>> = {
  smart: "high",
  default: "medium",
  budget: "low",
};

/** Bias 0-2 → budget, 3 → default, 4-6 → smart. Undefined bias is the dial's default, the middle stop. */
export function thalamusTierForBias(biasIdx: number | undefined): ThalamusTier {
  const b =
    typeof biasIdx === "number" && Number.isFinite(biasIdx)
      ? Math.round(biasIdx)
      : THALAMUS_DEFAULT_BIAS_IDX;
  if (b <= 2) {
    return "budget";
  }
  if (b === 3) {
    return "default";
  }
  return "smart";
}

export function thalamusTierDefaultsFilePath(file?: string): string {
  if (file) {
    return file;
  }
  const fromEnv = process.env.OPENCLAW_THALAMUS_DEFAULTS_FILE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), ".openclaw", "thalamus-tier-defaults.json");
}

type CacheEntry = { mtimeMs: number; size: number; value: ThalamusTierDefaults };
const cache = new Map<string, CacheEntry>();

export function clearThalamusTierDefaultsCache(): void {
  cache.clear();
}

/** A model ref is only accepted as `provider/model`; anything else is ignored, not guessed. */
function asModelRef(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const s = raw.trim();
  const slash = s.indexOf("/");
  return slash > 0 && slash < s.length - 1 ? s : undefined;
}

/** An effort is a short lowercase word (`low`, `xhigh`, `max`); anything else is ignored. */
function asEffort(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const s = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,15}$/.test(s) ? s : undefined;
}

/** One stop's value in either spelling: a bare ref, or `{model, effort?}`. */
export function parseThalamusSuggestion(raw: unknown): ThalamusSuggestion | undefined {
  const bare = asModelRef(raw);
  if (bare) {
    return { model: bare };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const model = asModelRef((raw as { model?: unknown }).model);
    if (!model) {
      return undefined;
    }
    const effort = asEffort((raw as { effort?: unknown }).effort);
    return effort ? { model, effort } : { model };
  }
  return undefined;
}

/** The parsed file content, new keys first, the legacy key as the fallback for the same stop. */
export function normalizeThalamusTierDefaults(parsed: unknown): ThalamusTierDefaults {
  const out: ThalamusTierDefaults = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return out;
  }
  const obj = parsed as Record<string, unknown>;
  for (const tier of THALAMUS_TIERS) {
    const value =
      parseThalamusSuggestion(obj[tier]) ?? parseThalamusSuggestion(obj[LEGACY_KEY[tier]]);
    if (value) {
      out[tier] = value;
    }
  }
  return out;
}

export function readThalamusTierDefaults(opts?: { file?: string }): ThalamusTierDefaults {
  const file = thalamusTierDefaultsFilePath(opts?.file);
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(file);
  } catch {
    cache.delete(file);
    return {};
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.value;
  }
  let value: ThalamusTierDefaults = {};
  try {
    value = normalizeThalamusTierDefaults(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    /* corrupt file = no preference */
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** The suggestion for the dial's current position, or undefined when that stop has none. */
export function thalamusSuggestionForBias(
  biasIdx: number | undefined,
  opts?: { file?: string },
): ThalamusSuggestion | undefined {
  return readThalamusTierDefaults(opts)[thalamusTierForBias(biasIdx)];
}

/** What the page reads: the old high / medium / low → model view, so a page built before 2026-10-02 keeps working. */
export function legacyDefaultsView(defaults: ThalamusTierDefaults): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tier of THALAMUS_TIERS) {
    const s = defaults[tier];
    if (s) {
      out[LEGACY_KEY[tier]] = s.model;
    }
  }
  return out;
}

/**
 * Set or clear one stop and write the WHOLE file in the new shape (so the legacy keys are gone after the first
 * write). `suggestion: null` clears the stop. A model with no effort named gets none here; the picker passes
 * `effort: "low"` for a newly assigned model (the architect, 2026-10-02). Written through a temp file and a rename, so a
 * reader never sees half a file. Returns the file's new content.
 */
export function writeThalamusSuggestion(
  tier: ThalamusTier,
  suggestion: ThalamusSuggestion | null,
  opts?: { file?: string },
): ThalamusTierDefaults {
  const file = thalamusTierDefaultsFilePath(opts?.file);
  let current: ThalamusTierDefaults = {};
  try {
    current = normalizeThalamusTierDefaults(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    current = {};
  }
  if (suggestion === null) {
    delete current[tier];
  } else {
    const parsed = parseThalamusSuggestion(suggestion);
    if (!parsed) {
      throw new Error("model must be provider/model and effort a short lowercase word");
    }
    current[tier] = parsed;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
  renameSync(tmp, file);
  cache.delete(file);
  return current;
}

/** Both spellings of a stop name, as the page or an older caller may send them. */
function tierFromParam(raw: unknown): ThalamusTier | undefined {
  if (raw === "smart" || raw === "default" || raw === "budget") {
    return raw;
  }
  return THALAMUS_TIERS.find((t) => LEGACY_KEY[t] === raw);
}

/** The effort a newly assigned model gets until the architect refines it (2026-10-02). */
export const NEW_ROLE_EFFORT = "low";

export type ThalamusDefaultsReply =
  | { ok: true; defaults: Record<string, string>; suggestions: ThalamusTierDefaults }
  | { ok: false; error: string };

/**
 * `prefrontal.thalamusDefaults`, as a pure function over the file so it can be tested (the extension only calls this).
 *   no `tier`                 read.
 *   `{tier, model: null}`     clear the stop.
 *   `{tier, model}`           assign the model to the stop. A model that is NEW to the stop gets effort `low`; the same
 *                             model again keeps the effort it had (the page re-sends it when only the role changes).
 *                             An `effort` in the request wins over both.
 *   `{tier, effort}`          set the effort of the model the stop already holds ("assign this effort to the role").
 * `defaults` is the old high / medium / low → model view, so a page built before 2026-10-02 keeps working;
 * `suggestions` is the new shape.
 */
export function applyThalamusDefaultsRequest(
  params: { tier?: unknown; model?: unknown; effort?: unknown } | undefined,
  opts?: { file?: string },
): ThalamusDefaultsReply {
  const p = params ?? {};
  const read = (): ThalamusDefaultsReply => {
    const suggestions = readThalamusTierDefaults(opts);
    return { ok: true, defaults: legacyDefaultsView(suggestions), suggestions };
  };
  if (p.tier === undefined) {
    return read();
  }
  const tier = tierFromParam(p.tier);
  if (!tier) {
    return { ok: false, error: "tier must be smart | default | budget (or high | medium | low)" };
  }
  clearThalamusTierDefaultsCache();
  const current = readThalamusTierDefaults(opts)[tier];
  const wantsEffort = p.effort !== undefined;
  const effort = wantsEffort ? (p.effort === null ? undefined : asEffort(p.effort)) : undefined;
  if (wantsEffort && p.effort !== null && !effort) {
    return { ok: false, error: "effort must be a short lowercase word, or null" };
  }
  try {
    if (p.model === undefined && wantsEffort) {
      if (!current) {
        return { ok: false, error: "that stop has no model yet; assign a model first" };
      }
      writeThalamusSuggestion(tier, { model: current.model, ...(effort ? { effort } : {}) }, opts);
    } else if (p.model === null || p.model === "") {
      writeThalamusSuggestion(tier, null, opts);
    } else {
      const model = asModelRef(p.model);
      if (!model) {
        return { ok: false, error: "model must be provider/model or null" };
      }
      const kept = current?.model === model ? current.effort : undefined;
      const chosen = wantsEffort ? effort : (kept ?? NEW_ROLE_EFFORT);
      writeThalamusSuggestion(tier, { model, ...(chosen ? { effort: chosen } : {}) }, opts);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return read();
}
