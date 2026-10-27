import { providerExhausted, toResetMs, type QuotaWindow } from "../../src/shared/quota-window.js";

export interface ModelUsageInfo {
  topPct: number;
  bottomPct: number;
  tooltip: string;
  disconnected?: boolean;
  /**
   * This row's quota is spent RIGHT NOW: one of its windows is at 100% and has
   * not yet rolled over.
   *
   * This EXTENDS the unavailability vocabulary `disconnected` already speaks —
   * both mean "this row cannot serve", so a picker crosses a model out when
   * either is set, and neither needs the other to change meaning. Absent rather
   * than `false` when there is capacity, matching `disconnected`.
   */
  exhausted?: boolean;
  /**
   * When the BINDING exhausted window rolls over, in epoch ms.
   *
   * NOT a restatement of `resetIso`: that one is the instant the tooltip's
   * `reset:` row counts down to and is present whether or not the row is full,
   * while this is set only alongside `exhausted` and only when the provider
   * publishes a rollover instant at all — Copilot, Gemini and OpenAI spend can
   * be exhausted with no reset to offer.
   */
  resetAtMs?: number;
  /**
   * The instant the tooltip's `reset:` row counts down to, so a caller can
   * re-stamp that row without re-deriving the whole row from provider state.
   * Absent for providers that publish no reset (Gemini, Copilot, OpenAI spend).
   */
  resetIso?: string | null;
}

export interface ModelTokenTotals {
  all: Record<string, number>;
  bySession: Record<string, Record<string, number>>;
}

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clampPct = (value: number): number => Math.min(Math.max(value, 0), 100);

const sessionKeyOf = (session: JsonRecord): string | null =>
  asString(session.key) ?? asString(session.sessionKey);

/**
 * One usage window as it appears in a hover: a short label and a percentage.
 *
 * The label is per-provider because the windows genuinely differ — Anthropic and
 * ChatGPT meter a 5h and a 7d pool, Grok only a weekly one, Gemini counts
 * requests per minute and per day. Only the SHAPE is unified.
 */
export interface UsageWindowLine {
  label: string;
  pct: number;
  /** Raw counts or amounts, appended after the percentage, e.g. `rpm: 0% (0/15)`. */
  suffix?: string | null;
}

/**
 * "3d 12h 34m" — time remaining until a window rolls over.
 *
 * A countdown rather than a wall-clock date (FORK 2026-07-31, the architect: "reset:
 * 3d 12h 34m"): the question a reset line answers is "how long until I get
 * capacity back", and a date makes the reader do the subtraction. Units below
 * the largest are kept so the number stays actionable near the boundary.
 */
export function formatResetCountdown(iso: unknown, nowMs = Date.now()): string | null {
  const value = asString(iso);
  if (!value) {
    return null;
  }
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) {
    return null;
  }
  const diffMs = target - nowMs;
  if (diffMs <= 0) {
    return "now";
  }
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return mins > 0 ? `${mins}m` : "<1m";
}

/** "Wed 16:00" — the schedulable half of the reset row. */
export function formatResetClock(iso: unknown, nowMs = Date.now()): string | null {
  const value = asString(iso);
  if (!value) {
    return null;
  }
  const target = new Date(value);
  if (!Number.isFinite(target.getTime()) || target.getTime() <= nowMs) {
    return null;
  }
  const day = target.toLocaleDateString(undefined, { weekday: "short" });
  const time = target.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * The one place a usage hover is formatted, for every provider.
 *
 * FORK 2026-07-31 (the architect: "unify, as much as possible, the mouseover message").
 * Before this, each provider branch invented its own wording — "shared: 5h 1%",
 * "RPM: 0/15 (0%)", "Weekly: 100% of quota", "Premium: 100% used" — so two
 * adjacent rows in the same panel could not be compared at a glance. The shape
 * is now fixed:
 *
 *     5h: 20%
 *     7d: 34%
 *     reset: 3d 12h 34m
 *
 * with `reset` present only when the provider actually tells us, and at most one
 * trailing context line (an account or plan name) when it disambiguates
 * something the bars cannot.
 */
export function formatUsageTooltip(
  lines: readonly UsageWindowLine[],
  resetIso?: unknown,
  nowMs = Date.now(),
  extra?: readonly (string | null | undefined)[],
): string {
  const out = lines.map(
    (line) =>
      `${line.label}: ${Math.round(clampPct(line.pct))}%${line.suffix ? ` (${line.suffix})` : ""}`,
  );
  const reset = formatResetCountdown(resetIso, nowMs);
  if (reset) {
    // The wall-clock time rides along with the countdown: the span answers "how
    // long do I wait", the clock answers "can I schedule the rest of my morning".
    const clock = formatResetClock(resetIso, nowMs);
    out.push(clock ? `reset: ${reset} (${clock})` : `reset: ${reset}`);
  }
  for (const line of extra ?? []) {
    if (line) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Matches the one `reset:` row `formatUsageTooltip` emits, so it can be swapped in place. */
const RESET_ROW = /^reset: .*$/m;

/**
 * Re-stamp an already-rendered hover's `reset:` row against a newer clock.
 *
 * The countdown is minted at PAINT time, and the MODELS panel only repaints when
 * `budget.usage` lands — a five-minute poll. So the row a user reads while waiting
 * out an exhausted window could be five minutes stale, which is exactly the moment
 * the number matters most (FORK 2026-08-28, the architect: "refreshed every minute").
 * Rewriting the one row in place keeps the minute tick off the panel's innerHTML
 * swap, which would otherwise drop hover state and scroll position every minute.
 *
 * A tooltip that never carried a reset row is returned untouched: this refreshes a
 * row, it does not invent one the provider never sent.
 */
export function refreshTooltipReset(
  tooltip: string,
  resetIso: unknown,
  nowMs = Date.now(),
): string {
  const reset = formatResetCountdown(resetIso, nowMs);
  if (!reset || !RESET_ROW.test(tooltip)) {
    return tooltip;
  }
  const clock = formatResetClock(resetIso, nowMs);
  return tooltip.replace(RESET_ROW, clock ? `reset: ${reset} (${clock})` : `reset: ${reset}`);
}

/**
 * Which window's reset the hover quotes, given the windows SHORTEST-first.
 *
 * Normally the longest: that is the one a user plans around, and a 5h pool rolls
 * over on its own soon enough to not be news.
 *
 * But a FULL window changes the question from "when do I plan around this" to
 * "when can I send the next message", and the answer is the shortest exhausted
 * window's reset (FORK 2026-08-28, the architect, with codex/sol pinned at `5h: 100%`:
 * the row quoted the weekly reset a week out while capacity was in fact ~1h40m
 * away — the one number he needed was the one window whose reset we hid).
 */
export function pickResetIso(
  windows: readonly { pct: number; iso: string | null }[],
): string | null {
  const capped = windows.find((w) => w.pct >= 100 && w.iso);
  if (capped) {
    return capped.iso;
  }
  // Longest-first fallback, so a longer window missing its timestamp still yields
  // the shorter one rather than dropping the row entirely.
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].iso) {
      return windows[i].iso;
    }
  }
  return null;
}

/**
 * Aggregate multiple sessions. Later sources replace an earlier session with the same key,
 * which lets an explicit sessions.usage lookup safely supplement the bounded general list.
 */
export function aggregateModelTokenUsage(...sessionLists: readonly unknown[][]): ModelTokenTotals {
  const sessions = new Map<string, JsonRecord>();
  let anonymousIndex = 0;

  for (const list of sessionLists) {
    for (const value of list) {
      const session = asRecord(value);
      if (!session) {
        continue;
      }
      sessions.set(sessionKeyOf(session) ?? `\0anonymous:${anonymousIndex++}`, session);
    }
  }

  const all: Record<string, number> = {};
  const bySession: Record<string, Record<string, number>> = {};
  for (const session of sessions.values()) {
    const sessionKey = sessionKeyOf(session) ?? "";
    const usage = asRecord(session.usage);
    const modelUsage = usage?.modelUsage;
    if (!Array.isArray(modelUsage)) {
      continue;
    }
    for (const value of modelUsage) {
      const item = asRecord(value);
      const model = asString(item?.model);
      const totals = asRecord(item?.totals);
      const tokens = asNumber(totals?.totalTokens) ?? 0;
      if (!model || tokens <= 0) {
        continue;
      }
      const provider = asString(item?.provider) ?? "unknown";
      const modelId = `${provider}/${model}`;
      all[modelId] = (all[modelId] ?? 0) + tokens;
      (bySession[sessionKey] ??= {})[modelId] = (bySession[sessionKey][modelId] ?? 0) + tokens;
    }
  }

  return { all, bySession };
}

/**
 * Map a provider's own window name onto the shared vocabulary.
 *
 * ChatGPT calls its pools things like "Weekly" and "5h"; Anthropic uses
 * `five_hour`/`seven_day`. Rendering each vendor's spelling made the panel read
 * like four different tools, so names that mean the same window collapse to the
 * same label and anything unrecognised falls through lowercased.
 */
export function canonicalWindowLabel(name: string): string {
  if (/(^|[^0-9])5\s*h|hour/i.test(name)) {
    return "5h";
  }
  if (/week|7\s*d/i.test(name)) {
    return "7d";
  }
  if (/month|30\s*d/i.test(name)) {
    return "30d";
  }
  if (/day|daily/i.test(name)) {
    return "1d";
  }
  return name.toLowerCase();
}

const firstString = (record: JsonRecord, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
};

/**
 * The `exhausted` / `resetAtMs` half of a row, or nothing when there is capacity.
 *
 * Windows are passed SHORTEST FIRST (5h before 7d), because `providerExhausted`
 * returns the first match: the binding window is the soonest constraint the caller
 * has to wait out, not the longest one it plans around. Spread into the row so a
 * row with headroom is byte-identical to what it was before this existed.
 */
const exhaustionOf = (
  windows: readonly QuotaWindow[],
  nowMs: number,
): { exhausted?: boolean; resetAtMs?: number } => {
  const binding = providerExhausted(windows, nowMs);
  return binding ? { exhausted: true, resetAtMs: binding.resetAtMs } : {};
};

function getChatGptUsage(chatgptValue: unknown, nowMs: number): ModelUsageInfo | null {
  const chatgpt = asRecord(chatgptValue);
  const models = asRecord(chatgpt?.models);
  if (!chatgpt || !models) {
    return null;
  }

  // Order by window LENGTH, not by the order the vendor happened to serialise
  // them: the block reads 5h above 7d, and the reset must come from the longest
  // window rather than from whichever entry landed last. Taking the last entry
  // positionally put the reset on the 5-hour pool whenever the payload listed
  // Weekly first, which is exactly how it arrives today.
  // Unrecognised window names sort LAST so a vendor addition can never displace a
  // real window from the two the block shows.
  const windowRank = (label: string): number =>
    ({ "5h": 1, "1d": 2, "7d": 3, "30d": 4 })[label] ?? 99;
  const windows = Object.entries(models)
    .flatMap(([name, value]) => {
      const window = asRecord(value);
      const utilization = asNumber(window?.utilization_pct);
      const label = canonicalWindowLabel(name);
      return window && utilization != null
        ? [{ name, window, utilization, label, rank: windowRank(label) }]
        : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2);
  if (windows.length === 0) {
    return null;
  }

  const lines = windows.map(({ label, utilization }) => ({ label, pct: utilization }));
  // `windows` is already sorted shortest-first, which is the order pickResetIso
  // needs: it prefers an EXHAUSTED short window over the long one a user plans by.
  const resetIso = pickResetIso(
    windows.map(({ window, utilization }) => ({
      pct: utilization,
      iso: firstString(window, ["resets_at", "reset_at", "resetAt"]),
    })),
  );
  // No trailing plan line (the architect 2026-07-31: "do not care about plan"). The block
  // is the windows and the reset; account identity is panel chrome, not quota.
  const tooltip = formatUsageTooltip(lines, resetIso, nowMs);

  return {
    topPct: clampPct(windows[0].utilization),
    bottomPct: windows[1] ? clampPct(windows[1].utilization) : 0,
    tooltip,
    resetIso,
    // `windows` is sorted shortest-first above, which is exactly the order the
    // binding window has to be picked in.
    ...exhaustionOf(
      windows.map(({ window, utilization }) => ({
        usedPercent: utilization,
        resetAtMs: toResetMs(firstString(window, ["resets_at", "reset_at", "resetAt"])),
      })),
      nowMs,
    ),
  };
}

/**
 * KNOWN COVERAGE LIMIT — read before trusting a falsy `exhausted`.
 *
 * This function understands exactly eight providers: codex, openai-codex,
 * anthropic, claude-code, google, openai, xai and github-copilot. Everything else
 * returns null, so `exhausted` is not "we checked and there is capacity", it is
 * "we have no quota signal for this row at all". In today's picker that silence
 * covers every `openrouter/*` model — all 20 of them, every Kimi, Qwen, GLM and
 * DeepSeek — plus ollama, none of which can EVER report exhausted here.
 *
 * `openai/*` is a weaker signal than it looks: it meters SPEND against a
 * hardcoded $50 cap invented below, not a vendor window, and carries no reset at
 * all — so it reads as exhausted once local spend reaches that cap and stays
 * that way until the month figure itself drops.
 */
export function getModelUsage(
  provider: string,
  modelId: string,
  keyId: string | undefined,
  budgetUsageValue: unknown,
  modelConfigValue: unknown,
  nowMs = Date.now(),
): ModelUsageInfo | null {
  const budgetUsage = asRecord(budgetUsageValue);
  if (!budgetUsage || provider === "ollama") {
    return null;
  }
  const modelConfig = asRecord(modelConfigValue);
  const name = modelId.split("/").slice(1).join("/") || modelId;

  if (provider === "codex" || provider === "openai-codex") {
    return getChatGptUsage(budgetUsage.chatgpt, nowMs);
  }

  if (provider === "anthropic" || provider === "claude-code") {
    const authProfiles = asRecord(modelConfig?.authProfiles);
    const profile = keyId ? asRecord(authProfiles?.[keyId]) : null;
    if (profile?.disabled) {
      const reason = asString(profile.disabledReason) ?? "cooldown";
      const label = keyId?.split(":").slice(1).join(":") || keyId || "api";
      return { topPct: 100, bottomPct: 100, tooltip: `${label}: ${reason}`, disconnected: true };
    }

    const profileKey = keyId?.split(":").slice(1).join(":") || "";
    const profiles = asRecord(budgetUsage.claudeProfiles);
    const matched = profileKey ? asRecord(profiles?.[profileKey]) : null;
    const claude = matched ?? asRecord(budgetUsage.claude);
    const limits = asRecord(claude?.limits);
    if (!limits) {
      return profileKey
        ? {
            topPct: 0,
            bottomPct: 0,
            tooltip: `${profileKey}: disconnected`,
            disconnected: true,
          }
        : null;
    }

    const fiveHour = asRecord(limits.five_hour);
    const sevenDay = asRecord(limits.seven_day);
    const sevenDaySonnet = asRecord(limits.seven_day_sonnet);
    const fiveHourPct = asNumber(fiveHour?.utilization) ?? 0;
    const sonnetPct = asNumber(sevenDaySonnet?.utilization);
    const sevenDayPct = asNumber(sevenDay?.utilization) ?? 0;
    const useSonnet = name.includes("sonnet") && sonnetPct != null;
    const longWindow = useSonnet ? sevenDaySonnet : sevenDay;
    const longPct = useSonnet ? sonnetPct : sevenDayPct;
    // Same rule as the ChatGPT row: an exhausted 5h pool answers "when can I send
    // again", so its reset outranks the weekly one it normally defers to.
    const resetIso = pickResetIso([
      { pct: fiveHourPct, iso: asString(fiveHour?.resets_at) },
      { pct: longPct ?? 0, iso: asString(longWindow?.resets_at) },
    ]);
    // Only a NAMED profile earns the trailing context line; the shared default
    // would put the same noise on every row without disambiguating anything.
    const tooltip = formatUsageTooltip(
      [
        { label: "5h", pct: fiveHourPct },
        { label: useSonnet ? "7d sonnet" : "7d", pct: longPct ?? 0 },
      ],
      resetIso,
      nowMs,
      [matched ? profileKey : null],
    );
    return {
      topPct: fiveHourPct,
      bottomPct: longPct ?? 0,
      tooltip,
      resetIso,
      ...exhaustionOf(
        [
          { usedPercent: fiveHourPct, resetAtMs: toResetMs(asString(fiveHour?.resets_at)) },
          { usedPercent: longPct ?? 0, resetAtMs: toResetMs(asString(longWindow?.resets_at)) },
        ],
        nowMs,
      ),
    };
  }

  if (provider === "google") {
    const gemini = asRecord(budgetUsage.gemini);
    const rpmLimit = asNumber(gemini?.rpm_limit) ?? 0;
    const rpmUsed = asNumber(gemini?.rpm_used) ?? 0;
    const rpdLimit = asNumber(gemini?.rpd_limit) ?? 0;
    const rpdUsed = asNumber(gemini?.rpd_used) ?? 0;
    if (!gemini || !rpdLimit) {
      return null;
    }
    const rpmPct = rpmLimit > 0 ? clampPct((rpmUsed / rpmLimit) * 100) : 0;
    const rpdPct = clampPct((rpdUsed / rpdLimit) * 100);
    // Gemini meters requests, not tokens, and publishes no reset timestamp, so
    // this is the honest two-line subset of the shared shape. The raw counts ride
    // on the labels because "0%" of 1500 and "0%" of 15 are very different facts.
    return {
      topPct: rpmPct,
      bottomPct: rpdPct,
      tooltip: formatUsageTooltip(
        [
          { label: "rpm", pct: rpmPct, suffix: `${rpmUsed}/${rpmLimit}` },
          { label: "rpd", pct: rpdPct, suffix: `${rpdUsed}/${rpdLimit}` },
        ],
        null,
        nowMs,
      ),
      // Gemini publishes no rollover instant for either pool, so a full one reads
      // as exhausted until the number itself drops — including the per-MINUTE
      // pool, which a burst can fill and which the five-minute poll will then keep
      // crossed out longer than the window it describes actually lasts.
      ...exhaustionOf([{ usedPercent: rpmPct }, { usedPercent: rpdPct }], nowMs),
    };
  }

  if (provider === "openai") {
    const openaiCosts = asRecord(budgetUsage.openaiCosts);
    const monthSpend = asNumber(openaiCosts?.monthSpend);
    if (monthSpend == null) {
      return null;
    }
    const cap = 50;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const dailyBreakdown = Array.isArray(openaiCosts.dailyBreakdown)
      ? openaiCosts.dailyBreakdown
      : [];
    const todayEntry = dailyBreakdown
      .map(asRecord)
      .find((entry) => asString(entry?.date) === today);
    const todaySpend = asNumber(todayEntry?.amount) ?? 0;
    const todayPct = clampPct((todaySpend / cap) * 100);
    const monthPct = clampPct((monthSpend / cap) * 100);
    // Metered spend, not a subscription window: the percentages are of a local
    // $50 budget, so the dollar figures stay on the labels. No vendor-published
    // reset exists for this view, so no reset line is invented.
    return {
      topPct: todayPct,
      bottomPct: monthPct,
      tooltip: formatUsageTooltip(
        [
          { label: "today", pct: todayPct, suffix: `$${todaySpend.toFixed(2)}` },
          { label: "month", pct: monthPct, suffix: `$${monthSpend.toFixed(2)}/$${cap}` },
        ],
        null,
        nowMs,
      ),
      // Spend against the local cap above, not a vendor window: this says "the
      // budget we set is gone", and with no reset to publish it stays that way
      // until the figure drops.
      ...exhaustionOf([{ usedPercent: todayPct }, { usedPercent: monthPct }], nowMs),
    };
  }

  if (provider === "xai") {
    const xai = asRecord(budgetUsage.xai);
    const rawPct = asNumber(xai?.usage_pct);
    if (rawPct == null) {
      return null;
    }
    const usage = clampPct(rawPct);
    // Grok has NO short window (the architect 2026-07-31: "Grok does not have a 5h window,
    // but openai and anthropic do"), so the 5h row is genuinely ABSENT rather than
    // rendered as a zero — the reason this shape has to tolerate missing rows at
    // all. The account's period type names the one row it does have: a unified
    // billing account meters weekly, which canonicalises to `7d`.
    const periodType = asString(xai?.period_type);
    const label = periodType ? canonicalWindowLabel(periodType) : "used";
    // The per-product split is shown only where it disagrees with the headline;
    // today GrokBuild is the sole product and reports the same number, so it stays
    // hidden rather than repeating the line above it.
    const products = Array.isArray(xai?.products) ? xai.products : [];
    const productLines = products.map(asRecord).flatMap((entry) => {
      const productPct = asNumber(entry?.usage_pct);
      const productName = asString(entry?.product);
      return productPct != null &&
        productName &&
        Math.round(clampPct(productPct)) !== Math.round(usage)
        ? [{ label: productName, pct: productPct }]
        : [];
    });
    // One pool, so both bars carry it: the second bar keeps this row's visual
    // rhythm consistent with the two-window providers above it in the panel.
    // One window means nothing to pick between — but it still counts down, so the
    // instant rides along and the minute tick keeps it honest like every other row.
    const resetIso = asString(xai?.period_end);
    return {
      topPct: usage,
      bottomPct: usage,
      tooltip: formatUsageTooltip([{ label, pct: usage }, ...productLines], resetIso, nowMs),
      resetIso,
      // One pool, so nothing to order: the single window IS the binding one.
      ...exhaustionOf([{ usedPercent: usage, resetAtMs: toResetMs(resetIso) }], nowMs),
    };
  }

  if (provider === "github-copilot") {
    const copilot = asRecord(budgetUsage.copilot);
    if (!copilot) {
      return null;
    }
    const premium = clampPct(asNumber(copilot.premium_used_pct) ?? 0);
    const chat = clampPct(asNumber(copilot.chat_used_pct) ?? 0);
    // Copilot meters two POOLS rather than two time windows, and its quota rolls on
    // the account's billing date, which the payload does not carry — so no reset is
    // invented here. The trailing context line carries the plan instead, which is
    // what explains a premium pool sitting pinned at 100%.
    const plan = asString(copilot.plan);
    const price = asNumber(copilot.plan_price_usd);
    return {
      topPct: premium,
      bottomPct: chat,
      tooltip: formatUsageTooltip(
        [
          { label: "premium", pct: premium },
          { label: "chat", pct: chat },
        ],
        null,
        nowMs,
        [plan ? `plan: ${plan}${price != null ? ` · $${price}/mo` : ""}` : null],
      ),
      // Two POOLS, not two time windows, so "shortest first" has nothing to say —
      // they are ordered to match the bars. Copilot's quota rolls on a billing date
      // the payload never carries, so a full premium pool is exhausted with no
      // reset to offer, which is the deliberate no-rollover rule, not a gap.
      ...exhaustionOf([{ usedPercent: premium }, { usedPercent: chat }], nowMs),
    };
  }

  return null;
}
