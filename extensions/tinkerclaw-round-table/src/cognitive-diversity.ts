/**
 * SYNAPSE Phase 7A: Cognitive Diversity Index (CDI) measurement.
 * Measures error correlation across model providers to quantify ensemble diversity.
 *
 * Self-contained copy for the tinkerclaw-round-table extension.
 * Original: src/memory/synapse/cognitive-diversity.ts
 */

export interface CDIMeasurement {
  modelSet: string[];
  benchmark: string;
  errorProfiles: Record<string, boolean[]>; // model -> binary error vector
  pairwiseCorrelations: Record<string, number>; // "modelA-modelB" -> Pearson r
  cdi: number;
  confidenceInterval: [number, number]; // 95% CI
  timestamp: string;
}

export interface ProviderProfile {
  modelId: string;
  role: string;
  strengths: string[];
  weaknesses: string[];
  avgLatencyMs: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  errorProfile?: boolean[];
}

/**
 * Pearson correlation coefficient between two binary vectors.
 */
export function pearsonCorrelation(a: boolean[], b: boolean[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  const n = a.length;
  const meanA = a.filter(Boolean).length / n;
  const meanB = b.filter(Boolean).length / n;

  let num = 0;
  let denomA = 0;
  let denomB = 0;

  for (let i = 0; i < n; i++) {
    const deviationA = (a[i] ? 1 : 0) - meanA;
    const deviationB = (b[i] ? 1 : 0) - meanB;
    num += deviationA * deviationB;
    denomA += deviationA * deviationA;
    denomB += deviationB * deviationB;
  }

  const denom = Math.sqrt(denomA * denomB);
  if (denom === 0) {
    return 0;
  }
  return num / denom;
}

/**
 * Fisher z-transform for correlation confidence intervals.
 */
function fisherZ(r: number): number {
  const clamped = Math.max(-0.9999, Math.min(0.9999, r));
  return 0.5 * Math.log((1 + clamped) / (1 - clamped));
}

function inverseFisherZ(z: number): number {
  return (Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1);
}

// Critical value for 95% confidence interval (two-tailed z-score)
const Z_95_CI = 1.96;

/**
 * Compute 95% confidence interval for a correlation using Fisher z-transform.
 */
export function correlationCI(r: number, n: number): [number, number] {
  if (n < 4) {
    return [-1, 1];
  }
  const z = fisherZ(r);
  const se = 1 / Math.sqrt(n - 3);
  return [inverseFisherZ(z - Z_95_CI * se), inverseFisherZ(z + Z_95_CI * se)];
}

/**
 * Measure CDI from error profiles across models.
 * CDI = 1 - mean(pairwise correlations)
 * CDI = 0: identical errors (no diversity)
 * CDI = 1: uncorrelated errors (maximum useful diversity)
 * CDI > 1: anti-correlated errors (complementary strengths)
 */
export function measureCDI(
  errorProfiles: Record<string, boolean[]>,
  benchmark = "default",
): CDIMeasurement {
  const models = Object.keys(errorProfiles);
  const n = models.length;
  const pairwiseCorrelations: Record<string, number> = {};
  let sumCorrelation = 0;
  let pairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = pearsonCorrelation(errorProfiles[models[i]], errorProfiles[models[j]]);
      const key = `${models[i]}-${models[j]}`;
      pairwiseCorrelations[key] = r;
      sumCorrelation += r;
      pairs++;
    }
  }

  const meanCorrelation = pairs > 0 ? sumCorrelation / pairs : 0;
  const cdi = 1 - meanCorrelation;

  // Compute CI from the mean correlation's CI; invert bounds since CDI = 1 - correlation
  const sampleSize = errorProfiles[models[0]]?.length ?? 0;
  const [ciLower, ciUpper] = correlationCI(meanCorrelation, sampleSize);

  return {
    modelSet: models,
    benchmark,
    errorProfiles,
    pairwiseCorrelations,
    cdi,
    confidenceInterval: [1 - ciUpper, 1 - ciLower],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Default provider profiles with role affinities and cost data.
 */
export const DEFAULT_PROVIDER_PROFILES: ProviderProfile[] = [
  {
    modelId: "claude-opus",
    role: "architect",
    strengths: ["reasoning", "nuance", "safety"],
    weaknesses: ["speed", "cost"],
    avgLatencyMs: 8000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
  },
  {
    modelId: "gpt-o3",
    role: "critic",
    strengths: ["analysis", "edge-cases", "formal-logic"],
    weaknesses: ["verbosity"],
    avgLatencyMs: 5000,
    costPer1kInput: 0.01,
    costPer1kOutput: 0.04,
  },
  {
    modelId: "gemini-pro",
    role: "pragmatist",
    strengths: ["speed", "multimodal", "cost-efficiency"],
    weaknesses: ["safety-nuance"],
    avgLatencyMs: 3000,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
  },
  {
    modelId: "deepseek-r1",
    role: "researcher",
    strengths: ["math", "code", "chain-of-thought"],
    weaknesses: ["instruction-following"],
    avgLatencyMs: 6000,
    costPer1kInput: 0.0014,
    costPer1kOutput: 0.0028,
  },
  {
    modelId: "claude-sonnet",
    role: "synthesizer",
    strengths: ["balance", "synthesis", "instruction-following"],
    weaknesses: ["depth-on-niche"],
    avgLatencyMs: 3000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
];

/**
 * Select optimal model subset for a debate based on CDI and budget.
 */
export function selectModelsForDebate(
  profiles: ProviderProfile[],
  cdiMeasurement?: CDIMeasurement,
  _budgetUsd?: number,
): ProviderProfile[] {
  if (profiles.length <= 2) {
    return profiles;
  }

  // Without CDI data, return top 3 by role diversity
  if (!cdiMeasurement) {
    const roles = new Set<string>();
    const selected: ProviderProfile[] = [];
    for (const p of profiles) {
      if (!roles.has(p.role)) {
        roles.add(p.role);
        selected.push(p);
        if (selected.length >= 3) {
          break;
        }
      }
    }
    return selected;
  }

  // With CDI data, prefer models with lowest pairwise correlation
  const sorted = [...profiles].toSorted((a, b) => {
    const keyA = Object.keys(cdiMeasurement.pairwiseCorrelations).filter((k) =>
      k.includes(a.modelId),
    );
    const keyB = Object.keys(cdiMeasurement.pairwiseCorrelations).filter((k) =>
      k.includes(b.modelId),
    );
    const avgA =
      keyA.length > 0
        ? keyA.reduce((s, k) => s + cdiMeasurement.pairwiseCorrelations[k], 0) / keyA.length
        : 0;
    const avgB =
      keyB.length > 0
        ? keyB.reduce((s, k) => s + cdiMeasurement.pairwiseCorrelations[k], 0) / keyB.length
        : 0;
    return avgA - avgB; // lower correlation = more diverse = preferred
  });

  return sorted.slice(0, Math.min(3, sorted.length));
}

// -- 7C: Provider-diversity LOCK ------------------------------------------------
// CDI is only a meaningful number if the participants are actually from different
// providers. These helpers turn "we hope they're diverse" into "we guarantee
// <=1 participant per provider for the selected set" — the empirical backbone of
// the paper's central claim.

/**
 * 7C: derive the vendor/provider from a *resolved model ref* ("provider/model"),
 * NOT from the cosmetic ProviderProfile.modelId label. The label `gpt-o3` and the
 * resolved ref `claude-code/...` must NOT disagree — only the ref is load-bearing.
 * A ref without a "/" is treated as its own provider (best-effort).
 */
export function providerOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

/**
 * 7C: count participants per provider from their resolved refs. Returns the mix
 * (provider -> count); any count > 1 is a diversity violation. Logged at debate
 * start so a collapse is visible in the trace.
 */
export function assertProviderDiversity(refs: string[]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const ref of refs) {
    const provider = providerOf(ref);
    mix[provider] = (mix[provider] ?? 0) + 1;
  }
  return mix;
}

/** Mean role-affinity of a profile across all roles — used as the drop tiebreak. */
function affinityScore(
  profile: ProviderProfile,
  affinity: Record<string, Record<string, number>>,
): number {
  const row = affinity[profile.modelId];
  if (!row) return 0.5;
  const vals = Object.values(row);
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0.5;
}

/**
 * 7C: select a debate set, then ENFORCE the provider lock (<=1 participant per
 * provider for the selected set). Provider is derived from each profile's resolved
 * ref via `resolveRef` (wire `modelForRole` here so 7C agrees with 7B). On a
 * duplicate provider, greedily drop the lowest-affinity duplicate and refill from a
 * remaining profile whose provider is not yet represented; if none exists, return
 * best-effort and call `onWarn` ("diversity not achievable with N catalog").
 *
 * Note: with the default catalog (Anthropic x2, OpenAI x2, Google x1) a strict
 * 5-participant lock is impossible — only 3 distinct providers exist — so under the
 * strict lock the selected set legitimately shrinks to the provider count.
 */
export function selectModelsForDebateWithProviderDiversity(
  profiles: ProviderProfile[],
  opts: {
    resolveRef: (profile: ProviderProfile) => string;
    cdiMeasurement?: CDIMeasurement;
    budgetUsd?: number;
    affinity?: Record<string, Record<string, number>>;
    onWarn?: (msg: string) => void;
  },
): ProviderProfile[] {
  const { resolveRef, cdiMeasurement, budgetUsd, affinity = {}, onWarn } = opts;

  // Start from the existing role/CDI-aware selection so 7C composes with the
  // original selector instead of replacing it. Then lock providers.
  // Use the FULL profile list as the refill pool (not just the pre-selected subset).
  let chosen = selectModelsForDebate(profiles, cdiMeasurement, budgetUsd);

  const providerOfProfile = (p: ProviderProfile): string => providerOf(resolveRef(p));

  const hasDuplicate = (set: ProviderProfile[]): string | null => {
    const seen = new Set<string>();
    for (const p of set) {
      const prov = providerOfProfile(p);
      if (seen.has(prov)) return prov;
      seen.add(prov);
    }
    return null;
  };

  // Guard against an unbounded loop if refill never resolves the violation.
  let guard = profiles.length + chosen.length + 1;
  let dup: string | null;
  while ((dup = hasDuplicate(chosen)) !== null && guard-- > 0) {
    // Drop the lowest-affinity profile among the duplicated provider.
    const duplicates = chosen.filter((p) => providerOfProfile(p) === dup);
    duplicates.sort((a, b) => affinityScore(a, affinity) - affinityScore(b, affinity));
    const toDrop = duplicates[0];
    chosen = chosen.filter((p) => p !== toDrop);

    // Refill from a remaining profile whose provider is not yet represented.
    const represented = new Set(chosen.map(providerOfProfile));
    const chosenIds = new Set(chosen.map((p) => p.modelId));
    const refill = profiles.find(
      (p) => !chosenIds.has(p.modelId) && !represented.has(providerOfProfile(p)),
    );
    if (refill) {
      chosen.push(refill);
    } else {
      onWarn?.(
        `[round-table] provider diversity not achievable with ${profiles.length}-model catalog; ` +
          `proceeding with ${chosen.length} unique-provider participant(s)`,
      );
      break;
    }
  }

  return chosen;
}

/**
 * 7E: pick a backup participant when an active one drops out — next-highest-affinity
 * profile NOT already active and (post-7C) NOT re-introducing a duplicate provider.
 * `activeRefs` are the resolved refs of currently-active participants;
 * `resolveRef` derives a candidate's provider so the backup respects the lock.
 * Returns null when no safe backup exists.
 */
export function selectBackupParticipant(
  allProfiles: ProviderProfile[],
  activeIds: Set<string>,
  role: string,
  opts?: {
    resolveRef?: (profile: ProviderProfile) => string;
    activeRefs?: string[];
    affinity?: Record<string, Record<string, number>>;
  },
): ProviderProfile | null {
  const resolveRef = opts?.resolveRef;
  const affinity = opts?.affinity ?? {};
  const representedProviders = new Set(resolveRef ? (opts?.activeRefs ?? []).map(providerOf) : []);

  const candidates = allProfiles.filter((p) => {
    if (activeIds.has(p.modelId)) return false;
    if (resolveRef && representedProviders.has(providerOf(resolveRef(p)))) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  // Prefer the candidate with the highest affinity for the dropped role.
  candidates.sort((a, b) => {
    const ra = affinity[a.modelId]?.[role] ?? affinityScore(a, affinity);
    const rb = affinity[b.modelId]?.[role] ?? affinityScore(b, affinity);
    return rb - ra;
  });
  return candidates[0];
}
