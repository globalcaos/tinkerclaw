/**
 * Family registry (design doc §3 M8). Each family file exports a factory; `enabledFamilies` builds the ones the config
 * switches on, in the order the decisions need: second opinion first, because it sets the misreading risk that the
 * safety table reads from the turn state (paper §6.1).
 */
import type { AmygdalaConfig } from "../config.js";
import type { FamilyId } from "../types.js";
import { createDoubleCheckFamily } from "./double-check.js";
import { createEfficiencyFamily } from "./efficiency.js";
import { createPersonalityFamily } from "./personality.js";
import { createSafetyFamily } from "./safety.js";
import { createSecondOpinionFamily } from "./second-opinion.js";
import type { Family } from "./types.js";
import type { FamilyDeps, FamilyFactory } from "./util.js";

export type { Family, FamilyResult } from "./types.js";
export type { FamilyDeps, FamilyFactory } from "./util.js";

export const FAMILY_FACTORIES: Record<FamilyId, FamilyFactory> = {
  "second-opinion": createSecondOpinionFamily,
  safety: createSafetyFamily,
  "double-check": createDoubleCheckFamily,
  efficiency: createEfficiencyFamily,
  personality: createPersonalityFamily,
};

export const FAMILY_ORDER: FamilyId[] = [
  "second-opinion",
  "safety",
  "double-check",
  "efficiency",
  "personality",
];

/** The families the config switches on, built with the shared deps, in decision order. */
export function enabledFamilies(
  config: Pick<AmygdalaConfig, "families">,
  deps: FamilyDeps,
  factories: Record<FamilyId, FamilyFactory> = FAMILY_FACTORIES,
): Family[] {
  return FAMILY_ORDER.filter((id) => config.families[id]).map((id) => factories[id](deps));
}
