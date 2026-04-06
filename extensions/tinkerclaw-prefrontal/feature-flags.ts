// extensions/prefrontal/feature-flags.ts
// FORK: Feature flags — per-hook enable/disable for ablation studies.

export interface PrefrontalFeatureFlags {
  explorationGate: boolean;
  antiGoldplating: boolean;
  forcingQuestions: boolean;
  permissionHooks: boolean;
  effortRouting: boolean;
  corfTrigger: boolean;
  faarTracking: boolean;
}

export const DEFAULT_FEATURE_FLAGS: PrefrontalFeatureFlags = {
  explorationGate: true,
  antiGoldplating: true,
  forcingQuestions: true,
  permissionHooks: true,
  effortRouting: true,
  corfTrigger: true,
  faarTracking: true,
};

export function resolveFeatureFlags(
  configFlags?: Partial<PrefrontalFeatureFlags>,
): PrefrontalFeatureFlags {
  return { ...DEFAULT_FEATURE_FLAGS, ...configFlags };
}

export function isEnabled(
  flags: PrefrontalFeatureFlags,
  feature: keyof PrefrontalFeatureFlags,
): boolean {
  return flags[feature] === true;
}
