import { homedir } from "node:os";
import { join } from "node:path";
import type { FamilyId } from "./types.js";

export interface AmygdalaConfig {
  mode: "shadow" | "enforce";
  families: Record<FamilyId, boolean>;
  /**
   * Families whose NOTES act while `mode` is shadow (2026-10-03, personality first). A note only adds a line to the
   * agent's context; holds, asks and send-backs of these families stay shadow records unless `mode` is enforce.
   */
  enforceFamilies: FamilyId[];
  jev: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    sendRealSituations: boolean;
    /** Where an owner gets a token. No default: the pointer is the owner's decision. */
    tokenHelpUrl?: string;
  };
  dataDir: string;
  failClosedOnLevel3: boolean;
  cost: { eurPerUsd: number };
  learn: { autoLoosen: boolean; capsPerWeek: number; capsPerDay: number };
  hooks: { enabled: boolean };
  /** The WOULD HAVE explainer (2026-10-05): a second model words each flag for the owner. */
  explain: { enabled: boolean; ladder: string[]; timeoutMs: number; concurrency: number };
  /** Grok's after-the-fact verdict on whether each flag would have helped (2026-10-06). */
  review: { enabled: boolean; dailyCap: number };
}

/** Grok first (the architect's ask, 2026-10-05; the subscription lane), then a different supply so one outage does not end it. */
export const DEFAULT_EXPLAIN_LADDER = ["xai/grok-4.6", "claude-code/claude-haiku-4-5"];

const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export const DEFAULT_DATA_DIR = join(homedir(), ".openclaw", "data", "amygdala-jev");

type Raw = Record<string, unknown> | undefined | null;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

/** The manifest's camelCase family names (as under `families`) to family ids; unknown names are dropped. */
const FAMILY_NAMES: Record<string, FamilyId> = {
  safety: "safety",
  secondOpinion: "second-opinion",
  doubleCheck: "double-check",
  efficiency: "efficiency",
  personality: "personality",
};
function enforceList(v: unknown): FamilyId[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => (typeof x === "string" ? FAMILY_NAMES[x] : undefined)))].filter(
    (x): x is FamilyId => x !== undefined,
  );
}

/** Turn the raw plugin config into a fully-defaulted config. Defaults match openclaw.plugin.json. */
export function parseConfig(raw: Raw): AmygdalaConfig {
  const r = obj(raw);
  const fam = obj(r.families);
  const jev = obj(r.jev);
  const cost = obj(r.cost);
  const learn = obj(r.learn);
  const hooks = obj(r.hooks);
  const explain = obj(r.explain);
  const review = obj(r.review);
  const ladder = Array.isArray(explain.ladder)
    ? explain.ladder.filter((x): x is string => typeof x === "string" && x.includes("/"))
    : [];
  return {
    mode: r.mode === "enforce" ? "enforce" : "shadow",
    families: {
      safety: bool(fam.safety, true),
      "second-opinion": bool(fam.secondOpinion, true),
      "double-check": bool(fam.doubleCheck, true),
      efficiency: bool(fam.efficiency, false),
      personality: bool(fam.personality, false),
    },
    enforceFamilies: enforceList(r.enforceFamilies),
    jev: {
      baseUrl: str(jev.baseUrl, "https://api.typesafe.ai"),
      model: str(jev.model, "jev-latest"),
      timeoutMs: num(jev.timeoutMs, 2600),
      sendRealSituations: bool(jev.sendRealSituations, false),
      ...(optStr(jev.tokenHelpUrl) ? { tokenHelpUrl: optStr(jev.tokenHelpUrl) } : {}),
    },
    dataDir: str(r.dataDir, DEFAULT_DATA_DIR),
    failClosedOnLevel3: bool(r.failClosedOnLevel3, false),
    cost: { eurPerUsd: num(cost.eurPerUsd, 0.92) },
    learn: {
      autoLoosen: bool(learn.autoLoosen, true),
      capsPerWeek: num(learn.capsPerWeek, 2),
      capsPerDay: num(learn.capsPerDay, 6),
    },
    hooks: { enabled: bool(hooks.enabled, true) },
    explain: {
      enabled: bool(explain.enabled, true),
      ladder: ladder.length ? ladder : [...DEFAULT_EXPLAIN_LADDER],
      timeoutMs: num(explain.timeoutMs, 180_000),
      concurrency: num(explain.concurrency, 2),
    },
    review: { enabled: bool(review.enabled, true), dailyCap: num(review.dailyCap, 150) },
  };
}
