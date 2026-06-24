/**
 * OpenClaw Budget Panel Plugin
 *
 * Multi-provider budget tracking for Claude, Manus, and Gemini.
 * Wired to real usage data.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  resolveApiKeyForProfile,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "../../src/agents/auth-profiles.js";
import {
  resolveCredentialFilePath,
  writeCredentialFile,
} from "../../src/agents/auth-profiles/credential-file.js";
import { setUsageSnapshot } from "../../src/infra/usage-snapshot-store.js";

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

/** Fetch live usage from all profiles sequentially. */
async function fetchAllClaudeUsage(
  log: (...args: any[]) => void = console.log,
): Promise<Record<string, Record<string, any> | null>> {
  const result: Record<string, Record<string, any> | null> = {};
  for (const p of Object.keys(USAGE_PROFILES)) {
    result[p] = await fetchProfileUsage(p, log);
  }
  return result;
}

/** FORK 2026-06-18 (bible §5.84a): publish live Anthropic usage into the in-process snapshot bridge
 *  for the burn-down effort allocator (`deriveQuotaPressure` reads it synchronously). v1 simplification:
 *  MAX utilization across profiles + the SOONEST reset (the imminent deadline we must not waste);
 *  per-account aggregation with distinct caps/resets is a documented v2 refinement. */
function publishUsageSnapshot(liveProfiles: Record<string, Record<string, any> | null>): void {
  const iso = (s: unknown): number | undefined => {
    if (typeof s !== "string") return undefined;
    const ms = new Date(s).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  };
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
    const sr = iso(data.seven_day?.resets_at);
    if (sr !== undefined && (soonestSeven === undefined || sr < soonestSeven)) soonestSeven = sr;
    const fr = iso(data.five_hour?.resets_at);
    if (fr !== undefined && (soonestFive === undefined || fr < soonestFive)) soonestFive = fr;
    accounts.push({
      label,
      sevenDayUtilization: s7,
      fiveHourUtilization: f5,
      sevenDayResetAt: sr,
      fiveHourResetAt: fr,
    });
  }
  if (!any) return; // keep the last good snapshot rather than zeroing on a transient failure
  setUsageSnapshot({
    lastSuccessfulFetch: Date.now(),
    providers: {
      anthropic: {
        sevenDayUtilization: maxSeven,
        fiveHourUtilization: maxFive,
        sevenDayResetAt: soonestSeven,
        fiveHourResetAt: soonestFive,
        accounts,
      },
    },
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

export default function register(api: OpenClawPluginApi) {
  const homeDir = process.env.HOME || "/tmp";
  const workspaceDir =
    (api.config as any)?.agents?.defaults?.workspace || `${homeDir}/.openclaw/workspace`;
  const tracker = new BudgetTracker(workspaceDir);

  // FORK 2026-06-18 (bible §5.84a): keep the burn-down allocator's quota signal fresh even with no
  // Tinker UI open — poll Anthropic usage on an interval and publish it to the in-process
  // usage-snapshot bridge (deriveQuotaPressure reads it synchronously). Best-effort; the 30-min
  // per-profile cache keeps real API hits well under the OAuth-usage rate limit.
  const refreshUsageSnapshot = () => {
    fetchAllClaudeUsage()
      .then(publishUsageSnapshot)
      .catch(() => {
        /* best-effort — allocator falls back to task-weighted when the snapshot is stale/absent */
      });
  };
  refreshUsageSnapshot(); // prime on boot
  const usageSnapshotTimer = setInterval(refreshUsageSnapshot, 10 * 60_000);
  if (typeof usageSnapshotTimer.unref === "function") usageSnapshotTimer.unref();

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
    }
    const claudeFileData = readUsageFile(usageFiles.claude) as any;
    const geminiData = readUsageFile(usageFiles.gemini) as any;
    const manusData = readUsageFile(usageFiles.manus) as any;
    const chatgptData = readUsageFile(usageFiles.chatgpt) as any;

    // Fetch live usage from both OAuth profiles + Gemini in parallel
    const [liveProfiles, geminiLive] = await Promise.all([
      fetchAllClaudeUsage(log),
      fetchGeminiUsage(log),
    ]);
    publishUsageSnapshot(liveProfiles); // FORK §5.84a: feed the burn-down effort allocator

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
    const claudeResult =
      buildClaudeProfile(firstLive) ??
      (claudeFileData && !fileIsStale
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
        : {
            mode: "subscription",
            plan: "max",
            limits: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
          });

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

    // OpenAI API Costs (via Admin key)
    log("[budget-panel] Fetching OpenAI costs...");
    const openaiCosts = await fetchOpenAICosts(log);
    log(
      `[budget-panel] OpenAI costs result: ${openaiCosts ? `$${openaiCosts.monthSpend}` : "null"}`,
    );
    if (openaiCosts) {
      result.openaiCosts = openaiCosts;
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
    const agentDefaults = (config.agents as any)?.defaults || {};
    const modelCfg = agentDefaults.model || {};
    const primary: string = typeof modelCfg === "string" ? modelCfg : modelCfg.primary || "";
    const fallbacks: string[] = modelCfg.fallbacks || [];
    const models: Record<string, any> = agentDefaults.models || {};
    const authCfg = (config as any).auth || {};
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
