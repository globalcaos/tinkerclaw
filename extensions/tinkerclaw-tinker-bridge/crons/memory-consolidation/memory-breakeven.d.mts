/** [uncached input, cache written, cache read, output, written 1h, written 5m] */
export type CallTokens = [number, number, number, number, number, number];
export type SourceKind = "claude-code" | "gateway";
export type PriceRatios = {
  r_cache_read: number;
  w_cache_write_5m: number;
  w_cache_write_1h: number;
  g_output: number;
};

export function resolvePaths(
  env?: NodeJS.ProcessEnv,
  home?: string,
): { stateDir: string; workspace: string; claudeHome: string; prices: string; out: string };
export function claudeProjectSlug(dir: string): string;
export function defaultSourceDirs(paths: {
  stateDir: string;
  claudeHome: string;
}): { dir: string; kind: SourceKind }[];
export function callUsage(record: unknown, kind: SourceKind): [...CallTokens, string] | null;
export function scan(
  sources: { dir: string; kind: SourceKind }[],
  days: number,
  maxFiles: number,
  nowMs?: number,
): Promise<{
  files: number;
  calls: CallTokens[];
  perSession: number[];
  models: Map<string, number>;
}>;
export function derive(input: { calls: number[][]; perSession: number[]; prices: PriceRatios }): {
  measured: {
    context_per_call_median: number;
    context_per_call_mean: number;
    cache_mix: { uncached: number; written: number; read: number };
    cache_ttl: "1h" | "5m";
    output_per_call_median: number;
    calls_per_session_mean: number;
    calls_per_session_median: number;
  };
  prices: { r: number; w: number; g: number };
  derived: {
    price_per_context_token_r_mix: number;
    hop_cost_H_in_input_tokens: number;
    need_share_above_which_carry_wins_at_any_size: number;
    max_always_loaded_tokens_by_need_share: Record<string, number | null>;
    index_line_pays_if_target_needed_in_one_of_N_sessions: number | null;
  };
};
