// src/shared/thalamus-supply.ts
//
// SUPPLIES — the inventory THALAMUS actually routes over, and the price of drawing on one.
//
// Design: docs/superpowers/specs/2026-09-03-thalamus-v2-design.md §2 (M2, M3), jarvis-icu.
//
// WHY THIS MODULE EXISTS. `thalamus-frontier.ts` prices a rung by its PUBLISHED cost — the
// vendor's €/task. That is the right number when every model is always up and metered per
// token, which is Fugu's setting (arXiv 2606.21228) and is not ours. Ours is a portfolio of
// SUBSCRIPTIONS with disjoint renewal clocks, plus one metered balance:
//
//   Claude   5-hour + 7-day     · two clocks, both binding
//   ChatGPT  5-hour + weekly    · two clocks
//   Copilot  monthly premium    · one slow clock
//   xAI      weekly ONLY        · no short window at all — see fanOutSupply()
//   Google   rpm/rpd            · free tier
//   OpenRouter  nothing         · METERED: unspent credit is money, not a deadline
//
// Under a subscription, an unspent token at reset is DESTROYED — its true price was zero. Under
// a metered balance, an unspent credit is money in the bank — its true price is face value. A
// router that prices both at the sticker rate will burn the deadline-bearing supply first and
// hoard the one that never expires, which is exactly backwards, and exactly what was observed
// on 2026-09-03: Claude 71% / ChatGPT 92% / Copilot 100% spent while xAI sat at 28% with the
// friendliest clock on the board.
//
// SO FAIRNESS ENTERS AS A PRICE, NOT AS A RULE. `shadowPrice` says how far ahead of (or behind)
// an even pace a supply is, and `effectiveCost` bends the €/task axis by it. The Pareto frontier
// and the bias pick are UNCHANGED — they simply run on a truthful axis, and even consumption
// falls out of the existing selection instead of needing a second selector beside it.
//
// PURE. No I/O, no Date.now(), no config read. `nowMs` is always an argument, for the reason
// `quota-window.ts` gives: the browser re-evaluates on a 60s tick against data up to 5 minutes
// stale while the gateway reads a 10-minute snapshot, and a hidden clock would let the two
// disagree about the same window while both look authoritative.

/**
 * The shape one quota window arrives in, declared STRUCTURALLY rather than imported from
 * `src/infra/usage-snapshot-store.ts`. `src/shared` is the browser+server home and must not
 * reach up into `src/infra` even for a type: the chart imports this module directly, and a
 * type-only edge is one refactor away from becoming a value edge that breaks the bundle from a
 * file nobody debugging the chart would think to open. `UsageWindowEntry` is assignable to this.
 */
export type SupplyWindowInput = {
  /** Human window name as the PROVIDER names it: "5-hour", "7-day", "Weekly", "monthly". */
  label: string;
  /** 0-100. */
  usedPercent: number;
  /** epoch ms; omitted when the provider publishes no reset instant. */
  resetAtMs?: number;
};

/**
 * A SUPPLY is a billing pool, not a provider id. Several config providers can draw on one pool
 * (anthropic + claude-code share one OAuth quota; openai-codex spends the ChatGPT plan), and
 * pricing one of them independently would double-count the headroom of a bucket that is really
 * one bucket.
 */
export type SupplyId =
  | "anthropic"
  | "openai"
  | "copilot"
  | "xai"
  | "google"
  | "openrouter"
  | "unknown";

/** How a supply is paid for. Decides whether unspent balance expires — see `shadowPrice`. */
export type SupplyKind = "subscription" | "metered" | "free-tier";

/** Config provider id → the billing pool it draws on. */
const PROVIDER_SUPPLY: Readonly<Record<string, SupplyId>> = {
  anthropic: "anthropic",
  "claude-code": "anthropic",
  "openai-codex": "openai",
  openai: "openai",
  chatgpt: "openai",
  "github-copilot": "copilot",
  copilot: "copilot",
  xai: "xai",
  google: "google",
  gemini: "google",
  openrouter: "openrouter",
};

/** Snapshot `windows` keys → supply. The budget panel keys by fetcher name, not by config
 *  provider, so the two vocabularies are joined HERE rather than at every call site. */
const WINDOW_KEY_SUPPLY: Readonly<Record<string, SupplyId>> = {
  anthropic: "anthropic",
  "claude-code": "anthropic",
  chatgpt: "openai",
  "openai-codex": "openai",
  openai: "openai",
  "github-copilot": "copilot",
  copilot: "copilot",
  xai: "xai",
  google: "google",
  gemini: "google",
};

const SUPPLY_KIND: Readonly<Record<SupplyId, SupplyKind>> = {
  anthropic: "subscription",
  openai: "subscription",
  copilot: "subscription",
  xai: "subscription",
  google: "free-tier",
  // METERED. This one line is why "keep OpenRouter unfunded unless necessary" needs no
  // special case anywhere else: a metered supply can never be cheap-by-deadline, so it can
  // never win on the burn term, only on genuine merit.
  openrouter: "metered",
  unknown: "metered",
};

export function supplyOf(provider: string | undefined): SupplyId {
  if (!provider) return "unknown";
  return PROVIDER_SUPPLY[provider] ?? "unknown";
}

/** The supply a `provider/model` route key draws on. */
export function supplyOfKey(key: string): SupplyId {
  const slash = key.indexOf("/");
  return supplyOf(slash > 0 ? key.slice(0, slash) : undefined);
}

export function supplyKind(id: SupplyId): SupplyKind {
  return SUPPLY_KIND[id] ?? "metered";
}

/**
 * Window length in ms, inferred from the label the PROVIDER chose. Every vendor names its own
 * window and no vendor publishes its length, so the label is the only signal available — and it
 * has to be, because the elapsed fraction (and therefore the whole shadow price) is meaningless
 * without it. Unknown labels return undefined and the window is skipped rather than guessed: a
 * wrong W silently inverts the sign of the price.
 */
export function windowLengthMs(label: string): number | undefined {
  const l = label.trim().toLowerCase();
  if (/^5[\s-]?hour/.test(l) || l === "5h") return 5 * 60 * 60 * 1000;
  if (/^(7[\s-]?day|weekly|week)$/.test(l) || l === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (/^(daily|day|rpd|24[\s-]?hour)$/.test(l)) return 24 * 60 * 60 * 1000;
  if (/^month/.test(l)) return 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

/** One window with its pace arithmetic worked out. */
export type SupplyWindow = {
  label: string;
  /** 0..1 */
  used: number;
  resetAtMs?: number;
  /** Inferred window length, ms. Undefined ⇒ pace is unknown for this window. */
  lengthMs?: number;
  /** Fraction of the window elapsed, 0..1. Undefined when length or reset is unknown. */
  elapsed?: number;
  /** used − elapsed, clamped. Positive ⇒ ahead of pace (scarce). Undefined ⇒ unknown. */
  pace?: number;
};

export type SupplyState = {
  id: SupplyId;
  kind: SupplyKind;
  windows: SupplyWindow[];
  /** true when ANY window is at or above 100% — the supply cannot be drawn on right now. */
  spent: boolean;
  /** The window that is spent, or the one that binds the price. */
  binding?: SupplyWindow;
  /** −1..+1. Positive ⇒ dearer than sticker, negative ⇒ cheaper. 0 when unknown. */
  shadow: number;
  /** Armed when a subscription window will destroy real surplus at reset — see `ballistic`. */
  ballistic: boolean;
  /** Soonest known reset across windows, epoch ms. */
  resetAtMs?: number;
};

export const EXHAUSTED_PERCENT = 100;

/** How hard the shadow price bends the cost axis. 0.6 ⇒ a supply a full window ahead of pace
 *  prices at 1.6× sticker, and one a full window behind prices at 0.4×. Large enough to move a
 *  pick across a near tie, small enough that it never beats a real intelligence gap. */
export const SHADOW_LAMBDA = 0.6;

/** Ballistic arms only inside the last 15% of a window … */
export const BALLISTIC_NEAR_FRACTION = 0.15;
/** … and only when at least this much of the window is provably going to expire unspent. */
export const BALLISTIC_MIN_DEFICIT = 0.25;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Read one supply's state out of the snapshot's window array.
 *
 * ORDER IS NOT ASSUMED. `UsageSnapshot.windows` documents shortest-window-first, but the binding
 * window here is chosen by ARITHMETIC (most spent, then most ahead of pace), so a producer that
 * appends in fetch order degrades the explanation, never the decision.
 */
export function supplyStateFrom(
  id: SupplyId,
  entries: readonly SupplyWindowInput[] | undefined,
  nowMs: number,
): SupplyState {
  const kind = supplyKind(id);
  const windows: SupplyWindow[] = [];
  for (const e of entries ?? []) {
    const used = clamp((Number(e.usedPercent) || 0) / 100, 0, 1);
    const lengthMs = windowLengthMs(e.label);
    let elapsed: number | undefined;
    let pace: number | undefined;
    if (lengthMs && typeof e.resetAtMs === "number" && e.resetAtMs > nowMs) {
      elapsed = clamp(1 - (e.resetAtMs - nowMs) / lengthMs, 0, 1);
      pace = clamp(used - elapsed, -1, 1);
    }
    windows.push({ label: e.label, used, resetAtMs: e.resetAtMs, lengthMs, elapsed, pace });
  }

  const spentWindow = windows.find((w) => w.used * 100 >= EXHAUSTED_PERCENT);
  // The binding window is the one that hurts most: the spent one if any, else the one furthest
  // ahead of pace, else the most used. A supply is priced by its tightest constraint, the same
  // way `providerExhausted` reads the first exhausted window rather than an average.
  const paced = windows.filter((w) => w.pace !== undefined);
  const binding =
    spentWindow ??
    (paced.length > 0
      ? paced.reduce((hi, w) => ((w.pace as number) > (hi.pace as number) ? w : hi))
      : windows.length > 0
        ? windows.reduce((hi, w) => (w.used > hi.used ? w : hi))
        : undefined);

  let shadow = binding?.pace ?? 0;
  // A metered supply's surplus does not expire, so it can never be discounted for being
  // "behind pace" — there is no deadline to be behind. Scarcity still applies upward.
  if (kind === "metered") shadow = Math.max(0, shadow);
  // A free tier's balance is neither money nor a subscription; treat it as neutral-to-cheap but
  // never as an obligation to spend.
  if (kind === "free-tier") shadow = Math.min(0, shadow);

  const ballistic = kind === "subscription" && windows.some((w) => windowBallistic(w));

  const resets = windows.map((w) => w.resetAtMs).filter((n): n is number => typeof n === "number");

  return {
    id,
    kind,
    windows,
    spent: Boolean(spentWindow),
    binding,
    shadow: ballistic ? -1 : clamp(shadow, -1, 1),
    ballistic,
    resetAtMs: resets.length > 0 ? Math.min(...resets) : undefined,
  };
}

/**
 * Is this window about to destroy surplus?
 *
 * Both halves are required and each rules out a different mistake. NEAR alone would fire every
 * Sunday evening on a bucket we already emptied — nothing to save, nothing to spend. DEFICIT
 * alone would fire on Monday morning, when "behind pace" simply means the week has not happened
 * yet. Only NEAR ∧ DEFICIT is the state the architect described: a refresh is coming and the
 * remainder cannot physically be consumed before it lands.
 */
export function windowBallistic(w: SupplyWindow): boolean {
  if (w.elapsed === undefined || w.lengthMs === undefined) return false;
  const near = 1 - w.elapsed < BALLISTIC_NEAR_FRACTION;
  const deficit = w.elapsed - w.used;
  return near && deficit > BALLISTIC_MIN_DEFICIT;
}

/** Every supply the snapshot can see, keyed by id. Absent ⇒ UNKNOWN, never "has headroom". */
export function supplyStates(
  windows: Readonly<Record<string, readonly SupplyWindowInput[]>> | undefined,
  nowMs: number,
): Map<SupplyId, SupplyState> {
  const grouped = new Map<SupplyId, SupplyWindowInput[]>();
  for (const [key, entries] of Object.entries(windows ?? {})) {
    const id = WINDOW_KEY_SUPPLY[key];
    if (!id) continue;
    const bucket = grouped.get(id) ?? [];
    bucket.push(...entries);
    grouped.set(id, bucket);
  }
  const out = new Map<SupplyId, SupplyState>();
  for (const [id, entries] of grouped) out.set(id, supplyStateFrom(id, entries, nowMs));
  return out;
}

/**
 * The €/task a rung really costs US right now.
 *
 * A supply with no state is priced at sticker: unknown is never a discount, because a discount
 * on an unknown supply is how a router talks itself into an exhausted provider.
 */
export function effectiveCost(
  cost: number,
  supply: SupplyState | undefined,
  lambda = SHADOW_LAMBDA,
): number {
  if (!supply || !Number.isFinite(cost)) return cost;
  return cost * (1 + lambda * supply.shadow);
}

/**
 * Which supply should carry the LEAVES of a fan-out.
 *
 * A fan-out of N units costs O(N) tokens at the leaves and O(1) at the aggregator, so the leaf
 * supply should be the one with the most headroom AND the most forgiving clock, while the chair
 * can be the dearest model on the board — it is one call.
 *
 * "Forgiving clock" is doing real work here and it is why xAI wins this on our board for a
 * STRUCTURAL reason rather than a fitness one: Grok has NO 5-hour window, so a 20-way burst
 * cannot trip a short-window limiter, whereas the same burst on Claude eats the 5-hour bucket
 * that the rest of the day's interactive work depends on. Supplies with a short window are
 * therefore penalised here even when their long window looks roomy.
 */
export function fanOutSupply(states: ReadonlyMap<SupplyId, SupplyState>): SupplyState | undefined {
  let best: SupplyState | undefined;
  let bestScore = -Infinity;
  for (const s of states.values()) {
    if (s.spent || s.kind === "metered") continue;
    const headroom = 1 - (s.binding?.used ?? 1);
    const score =
      headroom - shortWindowPenalty(s) - burstUnknownPenalty(s) - Math.max(0, s.shadow) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/**
 * How much a supply's SHORTEST window disqualifies it from carrying a burst. Graded rather than
 * boolean: a daily window is genuinely more forgiving than a five-hour one and genuinely less
 * forgiving than a weekly one, and an earlier boolean form at a 6-hour threshold sent a 20-way
 * fan-out at a daily-metered supply because 24h fell on the safe side of one number.
 */
function shortWindowPenalty(s: SupplyState): number {
  const shortest = Math.min(...s.windows.map((w) => w.lengthMs ?? Infinity));
  if (!Number.isFinite(shortest)) return 0;
  if (shortest <= 6 * 60 * 60 * 1000) return 0.35;
  if (shortest <= 24 * 60 * 60 * 1000) return 0.2;
  return 0;
}

/**
 * A free tier's real constraint is REQUESTS PER MINUTE, and we do not model rpm anywhere — the
 * snapshot publishes a daily count and nothing about the rate underneath it. So its headroom
 * reads as enormous (0 of 1500 requests) while a twenty-way burst against it would serialise or
 * be refused. We decline to plan bursts against a limit we cannot see. This is a statement about
 * OUR instrumentation, not about the vendor: model rpm and this penalty should go.
 */
function burstUnknownPenalty(s: SupplyState): number {
  return s.kind === "free-tier" ? 0.3 : 0;
}
