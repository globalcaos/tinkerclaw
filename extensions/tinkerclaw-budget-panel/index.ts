/**
 * OpenClaw Budget Panel Plugin
 *
 * Multi-provider budget tracking for Claude, Manus, and Gemini.
 * Wired to real usage data.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  resolveApiKeyForProfile,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  resolveCredentialFilePath,
  writeCredentialFile,
} from "openclaw/plugin-sdk/fork-auth-admin";
import { getRateLimitSnapshot } from "openclaw/plugin-sdk/fork-usage-metrics";
import { setUsageSnapshot } from "openclaw/plugin-sdk/fork-usage-metrics";

/** Anthropic OAuth profile IDs to poll for usage. */
const USAGE_PROFILES: Record<string, string> = {
  "cli-sv": "anthropic:cli-sv",
  "cli-gm": "anthropic:cli-gm",
};

/** Per-profile cache: profile → { data, ts }. null data = rate-limited / failed. */
const usageCache: Record<string, { data: Record<string, any> | null; ts: number }> = {};
// Anthropic /api/oauth/usage has a per-ACCESS-TOKEN rate limit of ~5 requests.
// With 30min cache we use ~2 requests/hr, safely under the limit.
const CACHE_TTL_MS = 30 * 60_000;
// Shorter TTL for failed fetches — allows quick recovery after boot-time token races.
const CACHE_TTL_FAILED_MS = 2 * 60_000;

/** Per-profile "already warned" guard for resolveToken failures.
 *  Anthropic OAuth refresh can fail every poll cycle (e.g. a stale refresh token on a
 *  tracking-only profile). Logging the error each cycle floods the gateway log with
 *  harmless noise (this path is usage-tracking only; the brain does not use it).
 *  Log the failure ONCE, then stay quiet until the next SUCCESS resets the guard. */
const resolveTokenWarned: Set<string> = new Set();

/** Resolve a fresh token for a profile using the gateway's own auth system (with auto-refresh). */
async function resolveToken(
  profileId: string,
  log: (...args: any[]) => void = console.log,
): Promise<string | null> {
  try {
    const store = ensureAuthProfileStore();
    const result = await resolveApiKeyForProfile({ store, profileId });
    const apiKey = result?.apiKey ?? null;
    if (apiKey) {
      // Recovered — clear the guard so a future failure logs once again.
      resolveTokenWarned.delete(profileId);
    }
    return apiKey;
  } catch (e) {
    if (!resolveTokenWarned.has(profileId)) {
      resolveTokenWarned.add(profileId);
      log(
        `[budget-panel] resolveToken ${profileId}: ${e} (further failures for this profile suppressed until it recovers)`,
      );
    }
    return null;
  }
}

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

/**
 * Force-rotate an OAuth token by calling the Anthropic token endpoint directly.
 * The /api/oauth/usage endpoint has a per-access-token rate limit of ~5 requests.
 * Refreshing gives us a new access token with a fresh rate limit window.
 */
async function forceRefreshToken(
  profileId: string,
  log: (...args: any[]) => void = console.log,
): Promise<string | null> {
  try {
    const store = ensureAuthProfileStore();
    const cred = store.profiles[profileId] as any;
    if (!cred || cred.type !== "oauth" || !cred.refresh) {
      return null;
    }

    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: cred.refresh,
        client_id: ANTHROPIC_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`[budget-panel] forceRefresh ${profileId}: HTTP ${res.status} ${body.slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as any;
    const newAccess = data.access_token;
    const newRefresh = data.refresh_token;
    if (!newAccess) {
      return null;
    }

    // Persist new tokens to auth-profiles store
    const freshStore = ensureAuthProfileStore();
    const freshCred = freshStore.profiles[profileId] as any;
    if (freshCred) {
      freshCred.access = newAccess;
      if (newRefresh) {
        freshCred.refresh = newRefresh;
      }
      freshCred.expires = Date.now() + (data.expires_in ?? 3600) * 1000;
      saveAuthProfileStore(freshStore);
    }

    // Write back to dedicated credential file so external-cli-sync stays in sync
    const writeback: Record<string, any> = {
      access: newAccess,
      refresh: newRefresh ?? freshCred?.refresh,
      expires: freshCred?.expires ?? Date.now() + 3600_000,
    };
    const credFilePath = resolveCredentialFilePath(profileId);
    if (credFilePath) {
      writeCredentialFile(credFilePath, "anthropic", writeback as any);
    }

    log(`[budget-panel] ${profileId}: token rotated for fresh rate limit window`);
    return newAccess;
  } catch (e) {
    log(`[budget-panel] forceRefreshToken ${profileId}: ${e}`);
    return null;
  }
}

/** Fetch live usage for a single OAuth profile (with cache + token rotation on 429). */
async function fetchProfileUsage(
  label: string,
  log: (...args: any[]) => void = console.log,
): Promise<Record<string, any> | null> {
  const cached = usageCache[label];
  const ttl = cached?.data ? CACHE_TTL_MS : CACHE_TTL_FAILED_MS;
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  const profileId = USAGE_PROFILES[label];
  if (!profileId) {
    return cached?.data ?? null;
  }

  let token = await resolveToken(profileId, log);
  if (!token) {
    usageCache[label] = { data: null, ts: Date.now() };
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) {
        // Usage API rate limit — return cached data, do NOT rotate token.
        // Token rotation invalidates the old refresh token (Anthropic strict
        // rotation) which kills the agent runner's in-memory credentials.
        log(`[budget-panel] ${label}: 429 on usage API, using cached data`);
        usageCache[label] = { data: cached?.data ?? null, ts: Date.now() };
        return cached?.data ?? null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log(`[budget-panel] ${label}: HTTP ${res.status} ${body.slice(0, 120)}`);
        usageCache[label] = { data: cached?.data ?? null, ts: Date.now() };
        return cached?.data ?? null;
      }
      const data = (await res.json()) as Record<string, any>;
      usageCache[label] = { data, ts: Date.now() };
      return data;
    } catch (e) {
      log(`[budget-panel] ${label}: ${e}`);
      usageCache[label] = { data: cached?.data ?? null, ts: Date.now() };
      return cached?.data ?? null;
    }
  }
  return cached?.data ?? null;
}

/** FORK 2026-07-09: read the Claude Code CLI's OWN credential file as a
 *  token source. This is the token fable actually runs on, and the CLI keeps
 *  it fresh itself — we only READ it (never refresh/rotate; the CLI owns the
 *  rotation, and rotating here would invalidate the CLI's refresh token).
 *  Added because the gateway-side `anthropic:cli-gm` refresh token died
 *  2026-07-08 and every poll fell to the zero-stub while the CLI token sat
 *  on disk, valid, the whole time. */
function readCliCredentialToken(): string | null {
  try {
    const raw = readFileSync(`${process.env.HOME}/.claude/.credentials.json`, "utf-8");
    const parsed = JSON.parse(raw);
    const cred = parsed.claudeAiOauth ?? parsed;
    const token = typeof cred.accessToken === "string" ? cred.accessToken : null;
    const expiresAt = typeof cred.expiresAt === "number" ? cred.expiresAt : 0;
    if (!token || (expiresAt && expiresAt <= Date.now())) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** Fetch usage via the CLI credential file (cached like the profile fetches). */
async function fetchCliFileUsage(
  log: (...args: any[]) => void = console.log,
): Promise<Record<string, any> | null> {
  const label = "cli-file";
  const cached = usageCache[label];
  const ttl = cached?.data ? CACHE_TTL_MS : CACHE_TTL_FAILED_MS;
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }
  const token = readCliCredentialToken();
  if (!token) {
    usageCache[label] = { data: null, ts: Date.now() };
    return null;
  }
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log(`[budget-panel] cli-file: HTTP ${res.status} on usage API`);
      usageCache[label] = { data: cached?.data ?? null, ts: Date.now() };
      return cached?.data ?? null;
    }
    const data = (await res.json()) as Record<string, any>;
    usageCache[label] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    log(`[budget-panel] cli-file: ${e}`);
    usageCache[label] = { data: cached?.data ?? null, ts: Date.now() };
    return cached?.data ?? null;
  }
}

/** Fetch live usage from all profiles sequentially. */
async function fetchAllClaudeUsage(
  log: (...args: any[]) => void = console.log,
): Promise<Record<string, Record<string, any> | null>> {
  const result: Record<string, Record<string, any> | null> = {};
  for (const p of Object.keys(USAGE_PROFILES)) {
    result[p] = await fetchProfileUsage(p, log);
  }
  // FORK 2026-07-09: when every configured profile fails (dead refresh tokens),
  // fall back to the Claude Code CLI's own credential file — the token that is
  // demonstrably alive because the brain runs on it.
  if (!Object.values(result).some(Boolean)) {
    const cliData = await fetchCliFileUsage(log);
    if (cliData) {
      result["cli-file"] = cliData;
    }
  }
  return result;
}

/** FORK: the ONE parser for every provider timestamp that reaches the usage snapshot.
 *  Anthropic (`resets_at`), xAI (`currentPeriod.end`) and Codex (`resets_at`) all hand us
 *  ISO-8601 strings. Hoisted out of publishUsageSnapshot on 2026-08-29 so the non-Anthropic
 *  producers below cannot grow a second, subtly-different parser. */
function isoToMs(s: unknown): number | undefined {
  if (typeof s !== "string") return undefined;
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Structural mirror of `UsageWindowEntry` in src/infra/usage-snapshot-store.ts. Declared
 *  locally on purpose: the published SDK surface `openclaw/plugin-sdk/fork-usage-metrics`
 *  exports `setUsageSnapshot` but not the type, and an extension must never reach into
 *  `../../src/**` — that path does not exist on a vanilla OpenClaw install. TypeScript still
 *  checks it structurally at the setUsageSnapshot() call, so core-type drift fails the build. */
export type QuotaWindow = { label: string; usedPercent: number; resetAtMs?: number };

/** The non-Anthropic quota payloads. Fetched by the snapshot poller in register(), NOT by the
 *  `budget.usage` RPC — before 2026-08-29 all four lived inside that handler, so a gateway with
 *  no Tinker UI tab connected had ZERO quota data for every provider except Anthropic. */
export type ExtraUsage = {
  xai: XaiQuota | null;
  copilot: Record<string, unknown> | null;
  gemini: GeminiUsageResult | null;
  chatgpt: Record<string, any> | null;
  openaiCosts: { monthSpend: number; dailyBreakdown: { date: string; amount: number }[] } | null;
};

/** What one poll produced: the Anthropic profiles plus everything else. */
type RefreshResult = {
  liveProfiles: Record<string, Record<string, any> | null>;
  extras: ExtraUsage;
};

const clampPct = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
};

/** Rank a Codex/ChatGPT window label shortest-first. Regex rather than a lookup table so a
 *  window the vendor invents later ("3h", "Monthly") still sorts sanely; anything unrecognised
 *  sorts LAST, never first, so it can never masquerade as the binding constraint. */
function codexWindowRank(label: string): number {
  if (/^\d+\s*h/i.test(label)) return 0;
  if (/day/i.test(label)) return 1;
  if (/week/i.test(label)) return 2;
  if (/month/i.test(label)) return 3;
  return 9;
}

/** FORK 2026-08-29: fold the already-paid-for vendor payloads into the provider-agnostic
 *  `windows` map that UsageSnapshot now carries.
 *
 *  ORDER WITHIN EACH ARRAY IS LOAD-BEARING — shortest window first. A consumer takes the FIRST
 *  exhausted entry as the BINDING window (the deadline it must actually wait for), so appending
 *  in fetch order instead of duration order silently changes routing and nothing fails loudly.
 *
 *  Exported for src/provider-windows.test.ts — the order invariant above has no other guard. */
export function buildProviderWindows(extras: ExtraUsage | null): Record<string, QuotaWindow[]> {
  const out: Record<string, QuotaWindow[]> = {};
  if (!extras) return out;

  // xAI — a single subscription pool; the server names its own period (weekly / monthly).
  if (extras.xai) {
    out.xai = [
      {
        label: extras.xai.period_type || "period",
        usedPercent: clampPct(extras.xai.usage_pct),
        resetAtMs: isoToMs(extras.xai.period_end),
      },
    ];
  }

  // GitHub Copilot — two pools sharing ONE monthly period, so shortest-first is a tie here and
  // the order below exists only for determinism; do not read it as a duration ranking. No reset
  // instant: /copilot_internal/user reports percent_remaining only, and inventing a month
  // boundary would be a guess dressed as data.
  if (extras.copilot) {
    const c = extras.copilot as { premium_used_pct?: number; chat_used_pct?: number };
    out["github-copilot"] = [
      { label: "monthly-chat", usedPercent: clampPct(c.chat_used_pct) },
      { label: "monthly-premium", usedPercent: clampPct(c.premium_used_pct) },
    ];
  }

  // Google / Gemini — the requests-per-day window (tinker-ui calls the same thing "rpd").
  // The RPM window is DELIBERATELY EXCLUDED: it is a rolling 60-second count with no reset
  // instant, so publishing it shortest-first would let a one-minute blip become the "binding"
  // constraint with an unknowable deadline — strictly worse than not knowing.
  if (extras.gemini && extras.gemini.rpd_limit > 0) {
    out.google = [
      {
        label: "daily",
        usedPercent: clampPct((extras.gemini.rpd_used / extras.gemini.rpd_limit) * 100),
      },
    ];
  }

  // OpenAI Codex / ChatGPT — memory/chatgpt-usage.json carries one entry per window
  // (live keys today: "5h", "Weekly"), each with its own resets_at.
  if (extras.chatgpt) {
    const models = (extras.chatgpt.models ?? {}) as Record<string, any>;
    const ranked: Array<QuotaWindow & { rank: number }> = [];
    for (const [label, val] of Object.entries(models)) {
      const limitReq = Number.parseInt(val?.rate_limits?.limit_requests) || 0;
      const remainReq = Number.parseInt(val?.rate_limits?.remaining_requests) || 0;
      // Same computation the RPC handler renders, so panel and snapshot cannot disagree;
      // fall back to the file's own utilization_pct when the request counters are absent.
      const used =
        limitReq > 0 ? ((limitReq - remainReq) / limitReq) * 100 : Number(val?.utilization_pct);
      if (!Number.isFinite(used)) continue;
      ranked.push({
        label,
        usedPercent: clampPct(used),
        resetAtMs: isoToMs(val?.resets_at),
        rank: codexWindowRank(label),
      });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    if (ranked.length > 0) {
      out["openai-codex"] = ranked.map(({ rank: _rank, ...w }) => w);
    }
  }

  // NOT a window: fetchOpenAICosts() yields month-to-date DOLLARS with no cap attached, and a
  // window needs a denominator. The cap lives per-model in openclaw.json (`monthlyCapUsd`),
  // which this layer never sees. See the `providers.openai` note in usage-snapshot-store.ts.
  return out;
}

/** Last Anthropic block we published, and WHEN it was fetched. Retained because the Anthropic
 *  OAuth-usage poll fails independently of the other vendors (dead refresh token, per-token rate
 *  limit) and the published SDK surface exposes only `setUsageSnapshot` — there is no read-back.
 *  Without it, a poll where only xAI answered would wipe the allocator's Anthropic signal. */
let lastAnthropic: {
  block: {
    sevenDayUtilization: number;
    fiveHourUtilization: number;
    sevenDayResetAt?: number;
    fiveHourResetAt?: number;
    accounts: Array<{
      label: string;
      sevenDayUtilization: number;
      fiveHourUtilization: number;
      sevenDayResetAt?: number;
      fiveHourResetAt?: number;
    }>;
  };
  at: number;
} | null = null;

/** FORK 2026-06-18 (bible §5.84a): publish live Anthropic usage into the in-process snapshot bridge
 *  for the burn-down effort allocator (`deriveQuotaPressure` reads it synchronously). v1 simplification:
 *  MAX utilization across profiles + the SOONEST reset (the imminent deadline we must not waste);
 *  per-account aggregation with distinct caps/resets is a documented v2 refinement.
 *
 *  FORK 2026-08-29: also publishes `windows` for xAI / Copilot / Google / Codex, so quota-aware
 *  routing stops being Anthropic-only. `providers.anthropic` is unchanged — both of its readers
 *  (agents/effort-allocator.ts, agents/billing-gate.ts) see exactly what they saw before. */
function publishUsageSnapshot(
  liveProfiles: Record<string, Record<string, any> | null>,
  extras: ExtraUsage | null = null,
): void {
  let maxSeven = 0;
  let maxFive = 0;
  let soonestSeven: number | undefined;
  let soonestFive: number | undefined;
  let any = false;
  // FORK 2026-06-19 (§5.84b): keep the per-account rows alongside the collapsed
  // MAX/SOONEST so the burn-down allocator can pick the BINDING (max-headroom) account.
  const accounts: Array<{
    label: string;
    sevenDayUtilization: number;
    fiveHourUtilization: number;
    sevenDayResetAt?: number;
    fiveHourResetAt?: number;
  }> = [];
  for (const [label, data] of Object.entries(liveProfiles)) {
    if (!data) continue;
    any = true;
    const s7 = Number(data.seven_day?.utilization ?? 0);
    const f5 = Number(data.five_hour?.utilization ?? 0);
    maxSeven = Math.max(maxSeven, s7);
    maxFive = Math.max(maxFive, f5);
    const sr = isoToMs(data.seven_day?.resets_at);
    if (sr !== undefined && (soonestSeven === undefined || sr < soonestSeven)) soonestSeven = sr;
    const fr = isoToMs(data.five_hour?.resets_at);
    if (fr !== undefined && (soonestFive === undefined || fr < soonestFive)) soonestFive = fr;
    accounts.push({
      label,
      sevenDayUtilization: s7,
      fiveHourUtilization: f5,
      sevenDayResetAt: sr,
      fiveHourResetAt: fr,
    });
  }
  const windows = buildProviderWindows(extras);
  if (any) {
    lastAnthropic = {
      block: {
        sevenDayUtilization: maxSeven,
        fiveHourUtilization: maxFive,
        sevenDayResetAt: soonestSeven,
        fiveHourResetAt: soonestFive,
        accounts,
      },
      at: Date.now(),
    };
    // 5-hour before 7-day: shortest first (see UsageSnapshot.windows).
    windows.anthropic = [
      { label: "5-hour", usedPercent: clampPct(maxFive), resetAtMs: soonestFive },
      { label: "7-day", usedPercent: clampPct(maxSeven), resetAtMs: soonestSeven },
    ];
  }
  // Nothing arrived at all — keep the last good snapshot rather than zeroing on a transient
  // failure. This is the pre-2026-08-29 guard, now also satisfied by windows-only data.
  if (!any && Object.keys(windows).length === 0) return;

  setUsageSnapshot({
    // Deliberately the ANTHROPIC fetch time, not now(). billing-gate.ts treats this as "how old
    // is the usage data" and BLOCKS every metered model when it is stale; a poll that refreshed
    // only xAI must never report dead Anthropic auth as fresh. No memo ⇒ 0 ⇒ read as stale ⇒
    // blocks, which is byte-for-byte what happened when the snapshot was null.
    lastSuccessfulFetch: lastAnthropic?.at ?? 0,
    windows,
    windowsUpdatedAt: Date.now(),
    providers: lastAnthropic ? { anthropic: lastAnthropic.block } : {},
  });
}

/** ─── OpenAI Costs via Admin API ─── */
let openaiCostsCache: {
  data: { monthSpend: number; dailyBreakdown: { date: string; amount: number }[] } | null;
  ts: number;
} | null = null;
const OPENAI_COSTS_CACHE_TTL_MS = 30 * 60_000;

async function fetchOpenAICosts(
  log: (...args: any[]) => void = console.log,
): Promise<{ monthSpend: number; dailyBreakdown: { date: string; amount: number }[] } | null> {
  if (
    openaiCostsCache &&
    openaiCostsCache.data &&
    Date.now() - openaiCostsCache.ts < OPENAI_COSTS_CACHE_TTL_MS
  ) {
    return openaiCostsCache.data;
  }
  const adminKey = process.env.OPENAI_ADMIN_API_KEY;
  if (!adminKey) {
    log("[budget-panel] OPENAI_ADMIN_API_KEY not set, skipping costs fetch");
    return null;
  }
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startTime = Math.floor(startOfMonth.getTime() / 1000);
    const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&limit=31&bucket_width=1d&group_by=line_item`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`[budget-panel] OpenAI costs: HTTP ${res.status} ${body.slice(0, 120)}`);
      openaiCostsCache = { data: null, ts: Date.now() };
      return null;
    }
    const data = (await res.json()) as any;
    let monthSpend = 0;
    const dailyBreakdown: { date: string; amount: number }[] = [];
    for (const bucket of data.data || []) {
      const date = (bucket.start_time_iso || "").slice(0, 10);
      let dayTotal = 0;
      for (const r of bucket.results || []) {
        const amt = r.amount?.value ?? (typeof r.amount === "number" ? r.amount : 0);
        dayTotal += typeof amt === "number" ? amt : parseFloat(amt) || 0;
      }
      monthSpend += dayTotal;
      if (dayTotal > 0) {
        dailyBreakdown.push({ date, amount: dayTotal });
      }
    }
    const result = { monthSpend, dailyBreakdown };
    openaiCostsCache = { data: result, ts: Date.now() };
    log(`[budget-panel] OpenAI costs: $${monthSpend.toFixed(2)} this month`);
    return result;
  } catch (e) {
    log(`[budget-panel] OpenAI costs error: ${e}`);
    openaiCostsCache = { data: null, ts: Date.now() };
    return null;
  }
}
/** ─── Gemini Usage via Google Cloud Monitoring ─── */
import { createSign } from "crypto";

const GOOGLE_SA_PATH = `${process.env.HOME}/.config/gcloud/service-account.json`;

interface GeminiUsageResult {
  rpm_used: number; // requests in last minute
  rpm_limit: number; // RPM limit
  rpd_used: number; // requests today
  rpd_limit: number; // RPD limit
}

let geminiUsageCache: { data: GeminiUsageResult | null; ts: number } | null = null;
const GEMINI_CACHE_TTL_MS = 10 * 60_000;

/** Google access token cache (reused across calls, 1h lifetime). */
let googleTokenCache: { token: string; exp: number } | null = null;

function signJwt(payload: Record<string, any>, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privateKey, "base64url");
  return `${header}.${body}.${signature}`;
}

async function getGoogleToken(sa: any, log: (...a: any[]) => void): Promise<string | null> {
  if (googleTokenCache && Date.now() < googleTokenCache.exp) {
    return googleTokenCache.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/monitoring.read",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    log(`[budget-panel] Google token error: ${res.status}`);
    return null;
  }
  const { access_token } = (await res.json()) as any;
  googleTokenCache = { token: access_token, exp: Date.now() + 3500_000 };
  return access_token;
}

async function queryRequestCount(
  token: string,
  projectId: string,
  hoursBack: number,
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - hoursBack * 3600_000);
  const filter = encodeURIComponent(
    'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="generativelanguage.googleapis.com"',
  );
  const url =
    `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries` +
    `?filter=${filter}` +
    `&interval.startTime=${start.toISOString().replace(/\.\d+Z$/, "Z")}` +
    `&interval.endTime=${end.toISOString().replace(/\.\d+Z$/, "Z")}` +
    `&aggregation.alignmentPeriod=${hoursBack * 3600}s` +
    `&aggregation.perSeriesAligner=ALIGN_SUM`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    return 0;
  }
  const data = (await res.json()) as any;
  let total = 0;
  for (const ts of data.timeSeries || []) {
    for (const p of ts.points || []) {
      total += parseInt(p.value?.int64Value ?? "0") || 0;
    }
  }
  return total;
}

async function fetchGeminiUsage(
  log: (...args: any[]) => void = console.log,
): Promise<GeminiUsageResult | null> {
  if (
    geminiUsageCache &&
    geminiUsageCache.data &&
    Date.now() - geminiUsageCache.ts < GEMINI_CACHE_TTL_MS
  ) {
    return geminiUsageCache.data;
  }

  let sa: any;
  try {
    sa = JSON.parse(readFileSync(GOOGLE_SA_PATH, "utf-8"));
  } catch {
    log("[budget-panel] Google service account not found");
    return null;
  }

  try {
    const token = await getGoogleToken(sa, log);
    if (!token) {
      return null;
    }

    // Query RPM window (1 min) and RPD window (24h) in parallel
    const [rpm_used, rpd_used] = await Promise.all([
      queryRequestCount(token, sa.project_id, 1 / 60), // 1 minute
      queryRequestCount(token, sa.project_id, 24), // 24 hours
    ]);

    // Read limits from gemini-usage.json (use highest-traffic model's limits)
    let rpm_limit = 0,
      rpd_limit = 0;
    try {
      const gf = JSON.parse(
        readFileSync(`${process.env.HOME}/.openclaw/workspace/memory/gemini-usage.json`, "utf-8"),
      );
      for (const val of Object.values(gf.models || {}) as any[]) {
        const rl = val?.rate_limits || {};
        if ((rl.rpd ?? 0) > rpd_limit) {
          rpd_limit = rl.rpd;
          rpm_limit = rl.rpm ?? 0;
        }
      }
    } catch {}

    const result: GeminiUsageResult = { rpm_used, rpm_limit, rpd_used, rpd_limit };
    log(`[budget-panel] Gemini: ${rpm_used}/${rpm_limit} RPM, ${rpd_used}/${rpd_limit} RPD`);
    geminiUsageCache = { data: result, ts: Date.now() };
    return result;
  } catch (e) {
    log(`[budget-panel] Gemini usage error: ${e}`);
    return null;
  }
}

import { BudgetTracker } from "./src/tracker.js";

// ─── GitHub Copilot quota (the architect 2026-07-30) ───
// api.github.com/copilot_internal/user returns premium_interactions + chat
// percent_remaining. Paid individual plans bill in AI credits (1 credit=$0.01):
//   Pro $10 → 1,500 credits · Pro+ $39 → 7,000 · Max $100 → 20,000.
// Free limited: Premium often empty; frontier models (gpt-5.5 etc.) policy-disabled.
const COPILOT_CACHE_TTL_MS = 10 * 60_000;
let copilotCache: { data: Record<string, unknown> | null; ts: number } | null = null;

// Plan → included AI credits (GitHub docs 2026-07-30). Free has no credit pool.
const COPILOT_PLAN_CREDITS: Record<string, { price: number; credits: number; label: string }> = {
  free: { price: 0, credits: 0, label: "Free / free_limited" },
  free_limited_copilot: { price: 0, credits: 0, label: "Free limited" },
  individual: { price: 10, credits: 1500, label: "Pro (individual)" },
  pro: { price: 10, credits: 1500, label: "Pro" },
  pro_plus: { price: 39, credits: 7000, label: "Pro+" },
  "pro+": { price: 39, credits: 7000, label: "Pro+" },
  max: { price: 100, credits: 20000, label: "Max" },
  business: { price: 19, credits: 0, label: "Business (pooled)" },
  enterprise: { price: 39, credits: 0, label: "Enterprise (pooled)" },
};

async function fetchCopilotQuota(
  githubToken: string | null,
  log: (...a: any[]) => void,
): Promise<Record<string, unknown> | null> {
  if (!githubToken) {
    return null;
  }
  if (copilotCache && Date.now() - copilotCache.ts < COPILOT_CACHE_TTL_MS) {
    return copilotCache.data;
  }
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${githubToken}`,
        "Editor-Version": "vscode/1.98.0",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      log(`[budget-panel] Copilot usage HTTP ${res.status}`);
      copilotCache = { data: null, ts: Date.now() };
      return null;
    }
    const data = (await res.json()) as {
      copilot_plan?: string;
      access_type_sku?: string;
      quota_snapshots?: {
        premium_interactions?: { percent_remaining?: number | null };
        chat?: { percent_remaining?: number | null };
      };
    };
    const planRaw = (data.copilot_plan || data.access_type_sku || "").toLowerCase();
    const planInfo =
      COPILOT_PLAN_CREDITS[planRaw] ||
      (planRaw.includes("free")
        ? COPILOT_PLAN_CREDITS.free_limited_copilot
        : planRaw.includes("pro+") || planRaw.includes("pro_plus")
          ? COPILOT_PLAN_CREDITS.pro_plus
          : planRaw.includes("max")
            ? COPILOT_PLAN_CREDITS.max
            : planRaw.includes("pro") || planRaw.includes("individual")
              ? COPILOT_PLAN_CREDITS.pro
              : undefined);
    const premRem = data.quota_snapshots?.premium_interactions?.percent_remaining;
    const chatRem = data.quota_snapshots?.chat?.percent_remaining;
    const premium_used_pct =
      typeof premRem === "number" ? Math.max(0, Math.min(100, 100 - premRem)) : 0;
    const chat_used_pct =
      typeof chatRem === "number" ? Math.max(0, Math.min(100, 100 - chatRem)) : 0;
    const out: Record<string, unknown> = {
      premium_used_pct,
      chat_used_pct,
      plan: planInfo?.label || data.copilot_plan || data.access_type_sku || "unknown",
      plan_raw: planRaw,
      plan_price_usd: planInfo?.price ?? null,
      monthly_ai_credits: planInfo?.credits ?? null,
      fetchedAt: new Date().toISOString(),
      note:
        (planInfo?.credits ?? 0) > 0
          ? `Included ≈ ${planInfo!.credits} AI credits/mo (1 credit = $0.01). GPT-5.5 burns credits at $5 in / $30 out per Mtok.`
          : "Free/limited: frontier models (gpt-5.5, Sol, Opus 5…) policy-disabled until Pro+",
    };
    copilotCache = { data: out, ts: Date.now() };
    return out;
  } catch (e) {
    log(`[budget-panel] Copilot usage fetch failed: ${e}`);
    copilotCache = { data: null, ts: Date.now() };
    return null;
  }
}

// ─── xAI quota (the architect 2026-07-27: "figure out a way to find quota info for XAI") ───
// SUPERSEDED 2026-07-30. The original implementation read the quota off
// `x-ratelimit-*` response headers from a 1-token probe. Those headers are a
// STATIC CEILING, not a counter: measured over five consecutive calls they sat at
// 53,000,000/53,000,000 and never moved, so the bar could only ever render 0%.
// It also cost a real chat call every 30 minutes to learn nothing.
//
// The real source is the subscription's own ledger, which the SuperGrok oauth
// token can read for free:
//
//   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//
// `?format=credits` is load-bearing. Without it the server replies in a shape its
// own client marks deprecated — a monthly dollar budget that is vestigial for
// unified-billing accounts and reported 33% where the binding weekly pool was at
// 78%. xAI open-sourced that client (github.com/xai-org/grok-build, crate
// `xai-grok-pager`); `credit_balance_from_config` in `app/effects/helpers.rs` is
// the reference for the precedence used here — server percentage over anything
// derived, `currentPeriod.end` over `billingPeriodEnd`.
//
// Cheap now (no tokens spent), so the cache exists only to avoid hammering; the
// upstream figure itself lags 30-60s behind a call, so finer polling buys nothing.
const XAI_CACHE_TTL_MS = 5 * 60_000;

type XaiQuota = {
  usage_pct: number;
  period_type?: string;
  period_start?: string;
  period_end?: string;
  products?: { product: string; usage_pct: number }[];
  on_demand_cap_cents?: number;
  on_demand_used_cents?: number;
  fetchedAt: string;
};

let xaiCache: { data: XaiQuota | null; ts: number } | null = null;

async function fetchXaiQuota(
  apiKey: string | null,
  log: (...a: any[]) => void,
): Promise<XaiQuota | null> {
  if (!apiKey) {
    return null;
  }
  if (xaiCache && Date.now() - xaiCache.ts < XAI_CACHE_TTL_MS) {
    return xaiCache.data;
  }
  try {
    // The proxy version-gates its clients: without the Grok-CLI identity headers
    // it answers HTTP 426 no matter how valid the token is.
    const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "grok-pager/0.2.116 grok-shell/0.2.116 (linux; x86_64)",
        "x-grok-client-identifier": "grok-pager",
        "x-grok-client-version": "0.2.116",
      },
    });
    if (!res.ok) {
      log(`[budget-panel] xAI billing: HTTP ${res.status}; skipping`);
      xaiCache = { data: null, ts: Date.now() };
      return null;
    }
    const cfg = ((await res.json()) as { config?: Record<string, any> })?.config;
    // Prefer the server's own percentage; fall back to the deprecated dollar
    // fields only when an older server omits it.
    const limitCents = Number(cfg?.monthlyLimit?.val ?? 0);
    const usedCents = Number(cfg?.used?.val ?? 0);
    const pct =
      typeof cfg?.creditUsagePercent === "number"
        ? cfg.creditUsagePercent
        : limitCents > 0
          ? (usedCents / limitCents) * 100
          : null;
    if (pct == null) {
      log("[budget-panel] xAI billing: no usage percentage in response; skipping");
      xaiCache = { data: null, ts: Date.now() };
      return null;
    }
    const data: XaiQuota = {
      usage_pct: Math.min(100, Math.max(0, pct)),
      period_type: String(cfg?.currentPeriod?.type ?? "")
        .replace(/^USAGE_PERIOD_TYPE_/, "")
        .toLowerCase(),
      period_start: cfg?.currentPeriod?.start ?? cfg?.billingPeriodStart,
      period_end: cfg?.currentPeriod?.end ?? cfg?.billingPeriodEnd,
      products: Array.isArray(cfg?.productUsage)
        ? cfg.productUsage.map((p: any) => ({
            product: String(p?.product ?? "?"),
            usage_pct: Number(p?.usagePercent ?? 0),
          }))
        : [],
      on_demand_cap_cents: Number(cfg?.onDemandCap?.val ?? 0),
      on_demand_used_cents: Number(cfg?.onDemandUsed?.val ?? 0),
      fetchedAt: new Date().toISOString(),
    };
    xaiCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    log(`[budget-panel] xAI quota fetch failed: ${e}`);
    xaiCache = { data: null, ts: Date.now() };
    return null;
  }
}

/** FORK 2026-08-29: gather every non-Anthropic quota payload in one place.
 *
 *  These fetches used to live inside the `budget.usage` RPC handler, so they only ran while a
 *  Tinker UI tab was connected: a headless gateway had ZERO quota data for xAI, Copilot, Codex
 *  and Gemini, and "quota-aware" routing quietly changed behaviour depending on whether a
 *  browser was open. The snapshot poller owns them now.
 *
 *  Every fetcher below is cache-backed (5-30 min TTL), so the RPC calling this on top of the
 *  10-minute timer costs no extra upstream requests. Each leg is independently fault-isolated:
 *  one dead credential must not blank the other three. */
async function collectExtraUsage(
  log: (...a: any[]) => void,
  readChatgptUsage: () => Record<string, any> | null,
): Promise<ExtraUsage> {
  const settle = async <T>(work: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await work();
    } catch (e) {
      log(`[budget-panel] extra-usage leg failed: ${e}`);
      return null;
    }
  };
  const [gemini, openaiCosts, xai, copilot] = await Promise.all([
    settle(() => fetchGeminiUsage(log)),
    settle(() => fetchOpenAICosts(log)),
    settle(async () => await fetchXaiQuota(await resolveToken("xai:default", log), log)),
    settle(async () => {
      return await fetchCopilotQuota(await resolveToken("github-copilot:github", log), log);
    }),
  ]);
  let chatgpt: Record<string, any> | null = null;
  try {
    chatgpt = readChatgptUsage();
  } catch (e) {
    log(`[budget-panel] chatgpt-usage.json read failed: ${e}`);
  }
  return { xai, copilot, gemini, chatgpt, openaiCosts };
}

export default function register(api: OpenClawPluginApi) {
  const homeDir = process.env.HOME || "/tmp";
  const workspaceDir =
    (api.config as any)?.agents?.defaults?.workspace || `${homeDir}/.openclaw/workspace`;
  const tracker = new BudgetTracker(workspaceDir);

  // Paths to usage JSON files (hardcoded for reliability)
  const usageFiles = {
    claude: `${homeDir}/.openclaw/workspace/memory/claude-usage.json`,
    gemini: `${homeDir}/.openclaw/workspace/memory/gemini-usage.json`,
    manus: `${homeDir}/.openclaw/workspace/memory/manus-usage.json`,
    chatgpt: `${homeDir}/.openclaw/workspace/memory/chatgpt-usage.json`,
  };

  const log = api.log?.info ?? console.log;
  log(`[budget-panel] Using files: ${JSON.stringify(usageFiles)}`);

  // Helper to safely read JSON files
  function readUsageFile(path: string): Record<string, unknown> | null {
    try {
      if (!existsSync(path)) {
        return null;
      }
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  // FORK 2026-06-18 (bible §5.84a) · WIDENED 2026-08-29: keep the quota signal fresh with NO
  // Tinker UI open. Anthropic was already polled here; the xAI / Copilot / Codex / Gemini reads
  // have MOVED here out of the `budget.usage` RPC handler, where they only ran while a browser
  // tab was connected — so a headless gateway had zero non-Anthropic quota data and any
  // quota-aware routing silently degraded to Anthropic-only. The RPC renders what this wrote.
  //
  // POSITION IS LOAD-BEARING: the prime call below runs synchronously, so this block must sit
  // AFTER `log`, `usageFiles` and `readUsageFile` are initialised. Hoisted back up next to the
  // other setup, the boot prime dies in the temporal dead zone.
  const readChatgptFile = () => readUsageFile(usageFiles.chatgpt) as Record<string, any> | null;
  let lastRefresh: RefreshResult | null = null;
  let refreshInFlight: Promise<RefreshResult | null> | null = null;
  const refreshUsageSnapshot = (): Promise<RefreshResult | null> => {
    // Collapse overlapping refreshes (a timer tick landing on top of an RPC) onto one poll.
    if (refreshInFlight) return refreshInFlight;
    const run = (async (): Promise<RefreshResult | null> => {
      try {
        const [liveProfiles, extras] = await Promise.all([
          fetchAllClaudeUsage(log),
          collectExtraUsage(log, readChatgptFile),
        ]);
        publishUsageSnapshot(liveProfiles, extras);
        lastRefresh = { liveProfiles, extras };
      } catch (e) {
        // best-effort — the allocator falls back to task-weighted when the snapshot is absent
        log(`[budget-panel] usage snapshot refresh failed: ${e}`);
      } finally {
        refreshInFlight = null;
      }
      return lastRefresh;
    })();
    refreshInFlight = run;
    return run;
  };
  void refreshUsageSnapshot(); // prime on boot
  const usageSnapshotTimer = setInterval(() => void refreshUsageSnapshot(), 10 * 60_000);
  if (typeof usageSnapshotTimer.unref === "function") usageSnapshotTimer.unref();

  // Load budgets from config
  const config = api.config as Record<string, unknown>;
  const pluginConfig = (config.plugins as Record<string, unknown>)?.["tinkerclaw-budget-panel"] as
    | Record<string, unknown>
    | undefined;

  if (pluginConfig?.claudeBudget) {
    tracker.setProviderBudget("claude", Number(pluginConfig.claudeBudget));
  }
  if (pluginConfig?.manusBudget) {
    tracker.setProviderBudget("manus", Number(pluginConfig.manusBudget));
  }
  if (pluginConfig?.geminiBudget) {
    tracker.setProviderBudget("gemini", Number(pluginConfig.geminiBudget));
  }

  // Helper to fetch Claude usage from OpenClaw's cost tracking
  async function refreshClaudeUsage(client: any) {
    try {
      // Get current month dates
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      // Call the usage.cost method internally
      const result = await new Promise<any>((resolve, reject) => {
        if (client?.request) {
          client.request("usage.cost", { startDate, endDate }).then(resolve).catch(reject);
        } else {
          reject(new Error("No client"));
        }
      });

      if (result?.totals?.totalCost !== undefined) {
        tracker.updateUsage("claude", result.totals.totalCost);
      }
    } catch (e) {
      // Silently fail - will show cached/default value
    }
  }

  // Register gateway method: budget.usage (live API + JSON fallback)
  api.registerGatewayMethod("budget.usage", async ({ params, respond }) => {
    // Allow callers to bust the usage cache (e.g. after re-auth)
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.forceRefresh) {
      for (const label of Object.keys(USAGE_PROFILES)) {
        delete usageCache[label];
      }
      delete usageCache["cli-file"];
    }
    const claudeFileData = readUsageFile(usageFiles.claude) as any;
    const manusData = readUsageFile(usageFiles.manus) as any;
    // (`geminiData` used to be read here from usageFiles.gemini and was never referenced —
    //  verified zero uses 2026-08-29 — so the disk read is gone with it.)

    // FORK 2026-08-29: the poller owns every fetch now (see refreshUsageSnapshot). This awaits
    // the SAME refresh the 10-minute timer runs — every fetcher underneath is cache-backed, so
    // it costs no extra upstream calls — and then RENDERS what the snapshot was built from,
    // instead of fetching a second, private copy here. That is the fix for "non-Anthropic quota
    // only exists while a browser is open": both paths now read one poll.
    const refreshed = await refreshUsageSnapshot();
    const liveProfiles = refreshed?.liveProfiles ?? {};
    const geminiLive = refreshed?.extras.gemini ?? null;
    // Fall back to a direct read if the very first poll threw: the file is local and free, and
    // rendering nothing here would be a regression against the pre-2026-08-29 handler.
    const chatgptData = refreshed?.extras.chatgpt ?? readChatgptFile();

    function buildClaudeProfile(live: Record<string, any> | null) {
      if (!live) {
        return null;
      }
      return {
        mode: "subscription",
        plan: "max",
        fetchedAt: new Date().toISOString(),
        limits: {
          five_hour: {
            utilization: live.five_hour?.utilization ?? 0,
            resets_at: live.five_hour?.resets_at ?? null,
          },
          seven_day: {
            utilization: live.seven_day?.utilization ?? 0,
            resets_at: live.seven_day?.resets_at ?? null,
          },
          seven_day_sonnet: live.seven_day_sonnet
            ? {
                utilization: live.seven_day_sonnet.utilization ?? 0,
                resets_at: live.seven_day_sonnet.resets_at ?? null,
              }
            : undefined,
        },
      };
    }

    // Per-profile usage (keyed by "cli-sv", "cli-gm")
    const claudeProfiles: Record<string, any> = {};
    for (const [profile, data] of Object.entries(liveProfiles)) {
      const built = buildClaudeProfile(data);
      if (built) {
        claudeProfiles[profile] = built;
      }
    }

    // Backwards-compatible "claude" key: use first available profile or file fallback
    const firstLive = Object.values(liveProfiles).find(Boolean);
    // If file data is older than 7 days, zero out utilization (window has fully rolled over)
    const STALE_FILE_MS = 7 * 24 * 60 * 60 * 1000;
    const fileIsStale =
      claudeFileData?.fetchedAt &&
      Date.now() - new Date(claudeFileData.fetchedAt).getTime() > STALE_FILE_MS;
    // FORK 2026-07-09: when the OAuth-usage poll yields nothing (e.g. the
    // tracking profile's refresh token is dead) fall back to the live rate-limit
    // snapshot harvested from the brain's OWN Anthropic response headers — a
    // token-free source that reflects real fable/claude-code traffic. Ranked
    // above the on-disk file because it is fresher (updated every request).
    const snap = getRateLimitSnapshot();
    const snapResult =
      snap && (snap.h5 > 0 || snap.d7 > 0)
        ? {
            mode: "subscription",
            plan: "max",
            fetchedAt: new Date(snap.ts).toISOString(),
            limits: {
              five_hour: { utilization: snap.h5, resets_at: null },
              seven_day: { utilization: snap.d7, resets_at: null },
              ...(snap.d7Sonnet != null
                ? { seven_day_sonnet: { utilization: snap.d7Sonnet, resets_at: null } }
                : {}),
            },
          }
        : null;
    const fileResult =
      claudeFileData && !fileIsStale
        ? {
            mode: claudeFileData.mode || "subscription",
            plan: claudeFileData.plan || "max",
            rateLimitTier: claudeFileData.rateLimitTier || "unknown",
            fetchedAt: claudeFileData.fetchedAt,
            limits: claudeFileData.limits || {
              five_hour: { utilization: 0, resets_at: null },
              seven_day: { utilization: 0, resets_at: null },
            },
          }
        : null;
    const claudeResult = buildClaudeProfile(firstLive) ??
      snapResult ??
      fileResult ?? {
        mode: "subscription",
        plan: "max",
        limits: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
      };

    const result: Record<string, unknown> = {
      claude: claudeResult,
      claudeProfiles,
      gemini: geminiLive ?? { rpm_used: 0, rpm_limit: 0, rpd_used: 0, rpd_limit: 0 },
      manus: (() => {
        if (!manusData) {
          return {
            daily: { used: 0, limit: 300, pct: 0 },
            monthly: { used: 0, limit: 4000, pct: 0 },
            addon: 0,
          };
        }
        // Handle manus-usage.json structure (from manus-usage-fetch.py)
        const daily = manusData.credits?.daily_refresh || {};
        const monthly = manusData.credits?.breakdown?.monthly || {};
        // Support both formats: new (daily.used) and legacy (daily.current = remaining)
        const dailyUsed =
          daily.used ?? (daily.limit ? daily.limit - (daily.current ?? daily.limit) : 0);
        const dailyLimit = daily.limit || 300;
        const monthlyUsed = monthly.used || manusData.credits_used || 0;
        const monthlyLimit = monthly.limit || manusData.credits_budget || 4000;
        const addon = manusData.credits?.breakdown?.addon || 0;
        return {
          daily: {
            used: dailyUsed,
            limit: dailyLimit,
            pct: dailyLimit ? (dailyUsed / dailyLimit) * 100 : 0,
          },
          monthly: {
            used: monthlyUsed,
            limit: monthlyLimit,
            pct: monthlyLimit ? (monthlyUsed / monthlyLimit) * 100 : 0,
          },
          addon,
        };
      })(),
    };

    // OpenAI API Costs (via Admin key) — fetched by the poller (collectExtraUsage), read here.
    // NOT folded into `windows`: this is month-to-date DOLLARS with no cap attached, and a window
    // needs a denominator. The cap lives per-model in openclaw.json (`monthlyCapUsd`), which this
    // layer never sees. See the `providers.openai` note in usage-snapshot-store.ts.
    const openaiCosts = refreshed?.extras.openaiCosts ?? null;
    if (openaiCosts) {
      result.openaiCosts = openaiCosts;
    }

    // xAI quota — the subscription's own ledger, free to read (see fetchXaiQuota).
    // Fetched by the poller (collectExtraUsage), read here.
    const xaiQuota = refreshed?.extras.xai ?? null;
    if (xaiQuota) {
      result.xai = xaiQuota;
      log(
        `[budget-panel] xAI quota: ${xaiQuota.usage_pct.toFixed(0)}% of the ${xaiQuota.period_type || "current"} allowance, resets ${xaiQuota.period_end ?? "?"}`,
      );
    }

    // GitHub Copilot Premium + Chat windows (same source as openclaw models status).
    // Fetched by the poller (collectExtraUsage), read here.
    const copilotQuota = refreshed?.extras.copilot ?? null;
    if (copilotQuota) {
      result.copilot = copilotQuota;
      log(
        `[budget-panel] Copilot: Premium ${copilotQuota.premium_used_pct}% · Chat ${copilotQuota.chat_used_pct}% · ${copilotQuota.plan}`,
      );
    }

    // ChatGPT / OpenAI
    result.chatgpt = (() => {
      if (!chatgptData) {
        return null;
      }
      const models: Record<string, any> = {};
      for (const [key, val] of Object.entries(chatgptData.models || {}) as [string, any][]) {
        const rl = val?.rate_limits || {};
        const limitReq = parseInt(rl.limit_requests) || 0;
        const remainReq = parseInt(rl.remaining_requests) || 0;
        const limitTok = parseInt(rl.limit_tokens) || 0;
        const remainTok = parseInt(rl.remaining_tokens) || 0;
        models[key] = {
          status: val?.status || "unknown",
          utilization_pct: limitReq ? ((limitReq - remainReq) / limitReq) * 100 : 0,
          requests: { used: limitReq - remainReq, limit: limitReq, remaining: remainReq },
          tokens: { used: limitTok - remainTok, limit: limitTok, remaining: remainTok },
          // FORK 2026-07-31 (the architect: "for sol-terra-luna, I am missing the reset
          // time"). This rebuilds the window rather than spreading it, so every
          // field not named here was silently dropped — including `resets_at`,
          // which the source file has carried all along
          // (memory/chatgpt-usage.json → models.Weekly.resets_at). The panel was
          // not missing the data; this loop was throwing it away.
          resets_at: val?.resets_at ?? null,
        };
      }
      return {
        fetchedAt: chatgptData.fetchedAt,
        api_key_status: chatgptData.api_key_status,
        models,
        plus_limits: chatgptData.plus_subscription_limits || {},
      };
    })();

    respond(true, result, undefined);
  });

  // Register gateway method: budget.status
  api.registerGatewayMethod("budget.status", async ({ respond, client }) => {
    // Get real token usage from OpenClaw's usage.budget
    let claudeData = {
      fiveHourPct: 0,
      dailyPct: 0,
      tier: "max_20x",
      dailyLimit: 6000000,
      fiveHourLimit: 900000,
    };

    try {
      // Call usage.budget internally
      const budgetData = await new Promise<any>((resolve, reject) => {
        const handler = (api as any).gatewayMethods?.get?.("usage.budget");
        if (!handler) {
          reject(new Error("usage.budget not found"));
          return;
        }
        handler({
          respond: (ok: boolean, result: any) => (ok ? resolve(result) : reject(result)),
          params: {},
          client,
        });
      });

      const anthropic = budgetData?.tokenSummaries?.find((s: any) => s.provider === "anthropic");
      if (anthropic?.estimated) {
        claudeData = {
          fiveHourPct: anthropic.estimated.fiveHourPercent || 0,
          dailyPct: anthropic.estimated.dailyPercent || 0,
          tier: anthropic.estimated.tier || "max_20x",
          dailyLimit: anthropic.estimated.dailyLimit || 6000000,
          fiveHourLimit: anthropic.estimated.fiveHourLimit || 900000,
        };
      }
    } catch {
      // Fallback to defaults if usage.budget is unavailable
    }

    // Build status with real Claude token data
    const manus = tracker.getStatus();
    const providers = [
      {
        name: `Claude (${claudeData.tier})`,
        pct: claudeData.dailyPct,
        used: `${claudeData.dailyPct.toFixed(1)}% daily`,
        remaining: `${(100 - claudeData.dailyPct).toFixed(1)}%`,
        unit: "",
        budget: claudeData.dailyLimit,
      },
      manus.providers.find((p) => p.name === "Manus") || manus.providers[1],
      manus.providers.find((p) => p.name === "Gemini") || manus.providers[2],
    ].filter(Boolean);

    respond(true, { providers, totalPct: claudeData.dailyPct }, undefined);
  });

  // Register gateway method: budget.update (manual updates)
  api.registerGatewayMethod("budget.update", async ({ respond, params }) => {
    const provider = typeof params?.provider === "string" ? params.provider : undefined;
    const used = typeof params?.used === "number" ? params.used : undefined;

    if (!provider || used === undefined) {
      respond(false, undefined, { code: -32602, message: "Missing: provider, used" });
      return;
    }

    tracker.updateUsage(provider, used);
    respond(true, { updated: true, status: tracker.getStatus() }, undefined);
  });

  // Register gateway method: budget.refresh (force refresh from sources)
  api.registerGatewayMethod("budget.refresh", async ({ respond, client }) => {
    if (client) {
      await refreshClaudeUsage(client);
    }
    const status = tracker.getStatus();
    respond(true, status, undefined);
  });

  // Register gateway method: config.models (live model configuration from openclaw.json)
  api.registerGatewayMethod("config.models", async ({ respond }) => {
    // FORK 2026-07-30: read openclaw.json from disk each call. The plugin's
    // `api.config` snapshot can lag file edits (and protected-path patches),
    // which left the MODELS panel showing the pre-cull 59-row list after AA≥50.
    let liveConfig: Record<string, unknown> = config;
    try {
      const raw = readFileSync(`${homeDir}/.openclaw/openclaw.json`, "utf-8");
      liveConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* fall back to api.config snapshot */
    }
    const agentDefaults = (liveConfig.agents as any)?.defaults || {};
    const modelCfg = agentDefaults.model || {};
    const primary: string = typeof modelCfg === "string" ? modelCfg : modelCfg.primary || "";
    const fallbacks: string[] = modelCfg.fallbacks || [];
    const models: Record<string, any> = agentDefaults.models || {};
    const authCfg = (liveConfig as any).auth || {};
    const authProfiles: Record<string, any> = authCfg.profiles || {};
    const authOrder: Record<string, string[]> = authCfg.order || {};

    respond(true, { primary, fallbacks, models, authProfiles, authOrder }, undefined);
  });

  // FORK: Anatomy timeline WS methods (registered here because budget-panel reliably loads)
  const getAnatomyDb = () => (globalThis as any).__anatomyDb;

  api.registerGatewayMethod("anatomy.recent", async ({ params, respond }) => {
    const db = getAnatomyDb();
    if (!db) {
      return respond(true, { count: 0, events: [] }, undefined);
    }
    const hours = Math.min(Math.max(params?.hours ?? 8760, 1), 8760);
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 2000);
    const events = db.queryRecentEvents(hours, limit);
    respond(true, { count: events.length, events }, undefined);
  });

  api.registerGatewayMethod("anatomy.before", async ({ params, respond }) => {
    const db = getAnatomyDb();
    if (!db) {
      return respond(true, { count: 0, events: [] }, undefined);
    }
    const beforeMs = params?.beforeMs;
    if (!beforeMs) {
      return respond(true, { count: 0, events: [] }, undefined);
    }
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
    const events = db.queryEventsBefore ? db.queryEventsBefore(beforeMs, limit) : [];
    respond(true, { count: events.length, events }, undefined);
  });

  api.registerGatewayMethod("anatomy.session", async ({ params, respond }) => {
    const db = getAnatomyDb();
    if (!db) {
      return respond(true, { count: 0, events: [] }, undefined);
    }
    const sk = params?.sessionKey;
    if (!sk) {
      return respond(true, { count: 0, events: [] }, undefined);
    }
    const limit = Math.min(Math.max(params?.limit ?? 200, 1), 500);
    const events = db.querySessionEvents(sk, limit);
    respond(true, { sessionKey: sk, count: events.length, events }, undefined);
  });

  // Register HTTP route for dashboard
  api.registerHttpRoute({
    path: "/budget",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const status = tracker.getStatus();
      const html = generateDashboardHtml(status);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  });

  // Register tool for agents (optional)
  if (api.registerTool) {
    api.registerTool(
      () => ({
        name: "budget_check",
        description: "Check multi-provider budget status (Claude, Manus, Gemini)",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          return tracker.getStatus();
        },
      }),
      { optional: true },
    );
  }

  log("[budget-panel] Plugin loaded - dashboard at /budget");
}

function generateDashboardHtml(status: ReturnType<BudgetTracker["getStatus"]>): string {
  const getEmoji = (pct: number) => (pct >= 90 ? "🔴" : pct >= 70 ? "🟠" : pct >= 50 ? "🟡" : "🟢");
  const getColor = (pct: number) =>
    pct >= 90 ? "#ef4444" : pct >= 70 ? "#f97316" : pct >= 50 ? "#eab308" : "#22c55e";

  const providerRows = status.providers
    .map(
      (p) => `
    <div class="provider">
      <div class="provider-header">
        <span class="provider-name">${getEmoji(p.pct)} ${p.name}</span>
        <span class="provider-pct" style="color: ${getColor(p.pct)}">${p.pct.toFixed(1)}%</span>
      </div>
      <div class="bar-container">
        <div class="bar" style="width: ${Math.min(p.pct, 100)}%; background: ${getColor(p.pct)}"></div>
      </div>
      <div class="provider-detail">${p.used} ${p.unit} used · ${p.remaining} ${p.unit} remaining</div>
    </div>
  `,
    )
    .join("");

  const alerts = status.providers
    .filter((p) => p.pct >= 70)
    .map(
      (p) =>
        `<div class="alert" style="border-color: ${getColor(p.pct)}">⚠️ ${p.name} at ${p.pct.toFixed(0)}%</div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🎛️ Budget Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui; background: #0a0a1a; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .container { max-width: 400px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 24px; font-size: 24px; }
    .panel { background: #1a1a2e; border-radius: 16px; padding: 20px; border: 1px solid #2a2a4a; }
    .provider { margin-bottom: 20px; }
    .provider:last-child { margin-bottom: 0; }
    .provider-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .provider-name { font-weight: 600; }
    .provider-pct { font-family: monospace; font-weight: 700; }
    .bar-container { height: 10px; background: #2a2a4a; border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
    .bar { height: 100%; border-radius: 5px; }
    .provider-detail { font-size: 12px; color: #888; }
    .alerts { margin-top: 20px; }
    .alert { background: rgba(255,100,100,0.1); border-left: 3px solid; padding: 10px 12px; margin-bottom: 8px; border-radius: 0 8px 8px 0; font-size: 13px; }
    .refresh { display: block; width: 100%; margin-top: 20px; padding: 12px; background: #2a2a4a; border: none; border-radius: 8px; color: #e0e0e0; cursor: pointer; font-size: 14px; }
    .refresh:hover { background: #3a3a5a; }
    .timestamp { text-align: center; margin-top: 16px; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎛️ Multi-Provider Budget</h1>
    <div class="panel">${providerRows}</div>
    ${alerts ? `<div class="alerts">${alerts}</div>` : ""}
    <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
    <div class="timestamp">Updated: ${new Date().toLocaleString()}</div>
  </div>
  <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
}

export type { BudgetTracker };
