import {
  renderAskCard,
  renderExceptionalCard,
  renderHoldCard,
  renderMarker,
  renderProofCard,
  renderRefusalStrip,
  renderRewoundMarker,
} from "./amygdala-cards.js";
/**
 * The amygdala UI's glue (design doc §9): one object that owns the client store and turns it into the things app.ts
 * hooks in — a pink Amygdala bubble next to each tool row the hook or Jev acted on (`inlineFor`, FORK 2026-10-15, the architect:
 * "all performed actions from Jev right where he does it, within its context"), what is left to draw after a reply
 * (`afterRun`: the actions no tool row can host, the markers), the timeline's brain marks (`marks`), the panel body and
 * the composer dot — plus the click handling for every `data-amy-act` the builders emit. The end-of-turn CHECKS and
 * WOULD HAVE windows (the architect 2026-10-05) are gone since 2026-10-15.
 *
 * INERT UNLESS THE GATEWAY HAS THE METHODS: `onConnected` asks `amygdala2.status`; an unknown-method error (the plugin is
 * off, or this is a gateway from before it) leaves `available` false and every hook returns "" so today's v3.1 panel and
 * chat are untouched. Nothing here talks to a gateway except through the injected `req`.
 */
import { esc } from "./amygdala-html.js";
import {
  type HookAction,
  hookActionFrom,
  renderHookBubble,
  renderJevBubble,
} from "./amygdala-inline.js";
import {
  actionActed,
  actionDecisionId,
  actionsOf,
  type JevAction,
  type JevActionsOptions,
  renderAction,
} from "./amygdala-jev.js";
import { AmygdalaStore } from "./amygdala-store.js";
import type { FeedView, InterventionView, TurnView } from "./amygdala-types.js";
import { renderAmygdalaPanelBody, renderDot } from "./panels/amygdala.js";

export interface AmygdalaUiDeps {
  req<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** The chat tab on screen. */
  tabKey(): string;
  repaintChat(): void;
  repaintPanel(): void;
  /** Put the removed prompt back in the composer (Rewind). */
  setComposerText(text: string): void;
  /** Bring the amygdala panel into view (a click on the composer dot). */
  openPanel?(): void;
  notify?(message: string): void;
  now?(): number;
  /**
   * Full deploy 2026-10-02: the retry button. `modelLabel` and `modelChip` draw the model's name and vendor logo;
   * `pinnedModel` is the model this tab is hand-picked on (a hand-picked tab has no gateway decision, so the page tells
   * Thalamus what refused); `sendOneTurn` puts a prompt on the wire with a model for that one turn only.
   */
  modelLabel?(modelId: string): string;
  modelChip?(modelId: string): string;
  pinnedModel?(): string | undefined;
  sendOneTurn?(text: string, model: string): Promise<void>;
  /**
   * FORK 2026-10-22 (the architect: a Rewind next to a refusal removes the last response from context AND chat). All optional, so a
   * page without them behaves as before. `exchangeKeyOf` names the exchange a run's prompt row opens (the strip carries it);
   * `newestExchange` is the exchange a Rewind would take, read from the page NOW (null while a reply runs or when the chat
   * holds no prompt); `hideExchange` / `showExchange` take it off the page and put it back.
   */
  exchangeKeyOf?(promptRow: unknown): string | null;
  newestExchange?(): { key: string; prompt: string; at?: number } | null;
  /**
   * 2026-10-22 (the architect: "Rewind should get attached to the turn, so I can remove from history more than one turn"): the
   * exchange with this key on the page now and how many exchanges follow it; null while a reply runs or when it is gone.
   */
  exchangeAt?(key: string): { key: string; prompt: string; at?: number; later: number } | null;
  composerDraft?(): string;
  /** Ask before a restored prompt replaces an unsent draft; false keeps the draft and does nothing. */
  confirmReplaceDraft?(): boolean;
  hideExchange?(ex: {
    sessionKey: string;
    key: string;
    prompt: string;
    at?: number;
    rewoundAt: number;
    restored?: string;
    /** Exchanges taken from this one on (absent = 1). */
    count?: number;
  }): void;
  showExchange?(sessionKey: string, key: string): void;
}

/** What `thalamus.refusal` and `thalamus.retryPick` say a retry would use (src/shared/thalamus-retry-pick.ts). */
export interface RetryPickView {
  model: string;
  effort: string;
  reason: string;
}

export interface AmygdalaUi {
  readonly store: AmygdalaStore;
  available(): boolean;
  onEvent(name: string, payload: unknown): void;
  onConnected(): Promise<void>;
  /**
   * HTML to draw after the reply to `userMsg` (the run that ends at `nextUserMsg`, null for the last run): the Jev
   * actions that name no tool call (so no tool row can host them) and the markers. No windows since 2026-10-15.
   */
  afterRun(userMsg: unknown, nextUserMsg: unknown, providerSafeguard?: boolean): string;
  /** An `amygdala.hook` live event or an `amygdala.feed` row: kept (by id, the newest 500) and the chat repainted. */
  onHookAction(raw: unknown): void;
  /** Every bubble for one tool call, the hook's first then Jev's; "" when neither acted on it. Hook bubbles need no amygdala2. */
  inlineFor(toolUseId: string): string;
  /** Every bubble known for the tab, in time order: the call timeline's brains. */
  marks(): { id: string; ts: number; toolUseId: string | null }[];
  /** The bubble drawn with `amy-focus` (a timeline brain was clicked); null clears it. Repaints the chat. */
  setFocus(id: string | null): void;
  focused(): string | null;
  /** HTML at the very end of the transcript: the exceptional approval card. */
  tailHtml(): string;
  /** The panel body, or "" when the v3.1 panel should stay. */
  panelBodyHtml(): string;
  dotHtml(): string;
  /** True when the click was ours. */
  handleClick(el: Element): Promise<boolean>;
}

const CLOCK_SKEW_MS = 5_000;
const DAY_MS = 86_400_000;
/** Hook actions kept per page (the oldest by time go first). */
const HOOK_KEEP = 500;
const FEED_WINDOW_MS = 36 * 3_600_000;

/** A chat row's time, in the same keys msg-order.ts reads. */
function rowTime(m: unknown): number | undefined {
  if (!m || typeof m !== "object") return undefined;
  const rec = m as Record<string, unknown>;
  for (const key of ["_promptStartedAt", "createdAtMs", "timestamp", "ts", "_arrivedAt"]) {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

export function createAmygdalaUi(deps: AmygdalaUiDeps): AmygdalaUi {
  const now = deps.now ?? Date.now;
  const store = new AmygdalaStore();
  // Interactive state that is not data: which rows/expanders are open, which ask option is selected. The window sets
  // (openWindows, openActions, selectedCol, openRows) stay so every `data-amy-act` click keeps working, though the
  // windows themselves are no longer drawn (2026-10-15).
  const openWindows = new Set<string>();
  /** WOULD HAVE windows the owner opened (collapsed by default since 2026-10-06; a card waiting for an answer forces it open). */
  const openActions = new Set<string>();
  /** The step column clicked in a reply's check timeline. */
  const selectedCol = new Map<string, number>();
  const openRows = new Set<string>();
  /** WOULD HAVE rows whose raw step and answers the owner opened under "details" (2026-10-05). */
  const openDetails = new Set<string>();
  /** Votes given in this page, by target id, so a row shows which one counted (2026-10-02). */
  const votes = new Map<string, number>();
  const openAcc = new Set<string>();
  const shownWhy = new Set<string>();
  const expandedChanges = new Set<string>();
  const selectedOption = new Map<string, string>();
  /** Thalamus's retry pick per refused turn; null = asked, nothing to offer. Filled by the event or by one question. */
  const retryByTurn = new Map<string, RetryPickView | null>();
  const retryAsked = new Set<string>();
  let canaryText = "";
  // FORK 2026-10-15 (the architect: "all performed actions ... right where he does it"): the hook's actions (AEGIS, v3.1) by id,
  // and the bubble a timeline brain focused. The hook needs no amygdala2, so these live outside `available()`.
  const hooks = new Map<string, HookAction>();
  let focusedId: string | null = null;
  /** Jev actions by tool use id for the tab on screen; rebuilt when the store or the tab changes. */
  let jevByTool: Map<string, JevAction[]> | null = null;
  let jevByToolTab = "";
  store.subscribe(() => {
    jevByTool = null;
    deps.repaintChat();
    deps.repaintPanel();
  });

  const available = (): boolean => store.state.available === true;

  function newestLiveTurnId(): string | undefined {
    return store
      .turnsFor(deps.tabKey())
      .filter((x) => !x.rewound)
      .at(-1)?.turnId;
  }

  /**
   * `amygdala2.rewind` for Claude Code tabs; tabs on the built-in runner (Grok, GPT…) answer "unsupported" there and
   * are rewound by the gateway itself (`sessions.rewind`, 2026-09-30). Not `call()`: it hides the capability.
   */
  async function rewindCall(
    turnId: string,
    undo: boolean,
    fromPrompt?: string,
  ): Promise<Record<string, unknown> | null> {
    const extra = undo ? { undo: true } : {};
    try {
      let r = await deps.req<Record<string, unknown>>("amygdala2.rewind", {
        sessionKey: deps.tabKey(),
        turnId,
        ...extra,
        ...(fromPrompt ? { fromPrompt } : {}),
      });
      // The built-in runner's `sessions.rewind` takes only the last exchange, so a rewind of several never falls back.
      if (r && r.ok !== true && r.capability === "unsupported" && !fromPrompt) {
        r = await deps.req<Record<string, unknown>>("sessions.rewind", {
          key: deps.tabKey(),
          ...extra,
        });
      }
      return r ?? null;
    } catch (err) {
      console.error("[amygdala-ui] rewind failed", err);
      deps.notify?.("Amygdala: rewind failed (devtools console has the full error)");
      return null;
    }
  }

  /** The exchange key of the run `afterRun` is drawing, so the strip inside it can name its exchange. */
  let runExchangeKey: string | null = null;
  /** The Jev turn each hidden exchange came from, so Undo can give its strip back. */
  const rewoundTurnByKey = new Map<string, string>();

  /**
   * FORK 2026-10-22 (the architect: a Rewind next to a refusal "would remove the last response from context and chat, and put the
   * prompt's message back in the input text box, so as to follow the instructions of the refusal, to try a different
   * way"). The gateway takes the tab's last exchange out of what the model sees; this puts the prompt back in the box
   * and takes the exchange off the page. Nothing is sent and no model is picked.
   *
   * Guards, each bought by a way this click could do harm:
   *  - STALE: the strip names its exchange; if the page's newest exchange is another one (or a reply is running), the
   *    click does nothing, because the gateway would remove whatever is last, not what the strip sits under.
   *  - DRAFT: an unsent draft in the box is the owner's. Asked BEFORE anything is rewound, so "no" changes nothing.
   *  - TAB: the answer arrives after an await; the box written to is the one on screen now, so a tab switch in between
   *    must not put this tab's prompt into another tab's box.
   */
  async function rewindNewest(o: { turnId: string; exchangeKey?: string }): Promise<void> {
    const tab = deps.tabKey();
    // Level 3: the strip's own exchange, wherever it sits; it and every later one go. Older: only the newest.
    const at =
      multiRewind() && o.exchangeKey !== undefined ? deps.exchangeAt!(o.exchangeKey) : undefined;
    const ex = at !== undefined ? at : (deps.newestExchange?.() ?? null);
    if (o.exchangeKey !== undefined && (!ex || ex.key !== o.exchangeKey)) {
      deps.notify?.(
        at !== undefined
          ? "Amygdala: that exchange is no longer on the page, or a reply is still running, so nothing was rewound"
          : "Amygdala: that is no longer the newest exchange, so nothing was rewound",
      );
      deps.repaintChat();
      return;
    }
    if (deps.composerDraft?.().trim() && deps.confirmReplaceDraft && !deps.confirmReplaceDraft()) {
      return;
    }
    const count = 1 + (at?.later ?? 0);
    const r = await rewindCall(o.turnId, false, count > 1 ? ex?.prompt : undefined);
    if (!r) return;
    if (r.ok !== true) {
      deps.notify?.(
        `Amygdala: rewind is not available here (${String(r.reason ?? r.capability ?? "unsupported")})`,
      );
      return;
    }
    // A gateway older than status.rewind 2 hands back the transcript's whole prompt (an 11 KB header and the contract
    // around the words): until it restarts, the box gets the words the page already shows for that exchange.
    const fromGateway = typeof r.restoredPrompt === "string" ? r.restoredPrompt : undefined;
    // An empty answer stays empty: a prompt an agent wrote has no owner words, and the page invents none.
    const prompt =
      (store.state.status?.rewind ?? 0) >= 2 || !fromGateway
        ? fromGateway
        : (ex?.prompt ?? fromGateway);
    const rewoundAt = now();
    store.markRewound(o.turnId, {
      restoredPrompt: prompt,
      forkSessionId: typeof r.forkSessionId === "string" ? r.forkSessionId : undefined,
      ts: rewoundAt,
    });
    if (ex) {
      rewoundTurnByKey.set(ex.key, o.turnId);
      deps.hideExchange?.({
        sessionKey: tab,
        key: ex.key,
        prompt: ex.prompt,
        at: ex.at,
        rewoundAt,
        restored: prompt,
        ...(count > 1 ? { count } : {}),
      });
    }
    if (deps.tabKey() !== tab) {
      deps.notify?.(
        "Rewound. You changed tab meanwhile, so the prompt was not put in this tab's box",
      );
      return;
    }
    if (prompt) deps.setComposerText(prompt);
  }

  const asRetry = (v: unknown): RetryPickView | null => {
    const r = v as { model?: unknown; effort?: unknown; reason?: unknown } | null | undefined;
    return r && typeof r.model === "string" && r.model
      ? {
          model: r.model,
          effort: typeof r.effort === "string" ? r.effort : "",
          reason: typeof r.reason === "string" ? r.reason : "",
        }
      : null;
  };

  /** The gateway rewinds to any exchange, not only the last one (status `rewind` ≥ 3) and the page can count them. */
  function multiRewind(): boolean {
    return (store.state.status?.rewind ?? 0) >= 3 && deps.exchangeAt !== undefined;
  }

  /** One question per refused turn, answered from the gateway's decision (or from the model this tab is hand-picked on). */
  function askRetry(turnId: string): void {
    if (retryAsked.has(turnId) || !deps.sendOneTurn) return;
    retryAsked.add(turnId);
    const model = deps.pinnedModel?.();
    void deps
      .req<{ ok?: boolean; pick?: unknown }>("thalamus.retryPick", {
        sessionKey: deps.tabKey(),
        ...(model ? { model } : {}),
      })
      .then((r) => retryByTurn.set(turnId, r?.ok === true ? asRetry(r.pick) : null))
      .catch((err) => {
        // An older gateway, or the plugin off: Rewind alone is the honest strip.
        console.error("[amygdala-ui] thalamus.retryPick failed", err);
        retryByTurn.set(turnId, null);
      })
      .finally(() => deps.repaintChat());
  }

  /** What rides on an action's row: a card waiting for an answer (enforce mode), the refusal offer, the Rewound line. */
  function actionExtra(a: JevAction, t: TurnView | undefined): string {
    const iv = a.iv;
    if (!iv || !t) return "";
    if (iv.state === "open") {
      if (iv.kind === "hold") return renderHoldCard(iv, { showWhy: shownWhy.has(iv.id) });
      if (iv.kind === "proof") return renderProofCard(iv);
      if (iv.kind === "ask") return renderAskCard(iv, selectedOption.get(iv.id) ?? null);
    }
    if (!refusalLike(a) || (stripKeys !== null && !stripKeys.has(a.key))) return "";
    if (t.rewound) return renderRewoundMarker(t.turnId, t.rewound);
    if (t.refusalKept) return "";
    // Level 3 (2026-10-22): every refused turn offers Rewind, which takes its exchange and every later one; the button
    // says how many. Older gateways remove only the LAST exchange, so only the newest un-rewound turn may offer it.
    const at = multiRewind() && runExchangeKey ? deps.exchangeAt!(runExchangeKey) : undefined;
    const count = at ? 1 + at.later : 1;
    const newest = at !== undefined ? at !== null : t.turnId === newestLiveTurnId();
    const last = newest && count === 1;
    if (last && !retryByTurn.has(t.turnId)) askRetry(t.turnId);
    const pick = last ? retryByTurn.get(t.turnId) : null;
    return renderRefusalStrip(
      t.turnId,
      iv,
      newest,
      newest
        ? undefined
        : at === null
          ? "Wait for the reply to finish"
          : "Rewind the newer exchange first: Rewind always removes the last one",
      pick
        ? {
            label: deps.modelLabel?.(pick.model) ?? pick.model,
            chipHtml: deps.modelChip?.(pick.model) ?? "",
            reason: pick.reason,
          }
        : null,
      runExchangeKey,
      count,
      !wholeRefusal(a),
    );
  }

  /** The row options `renderJevActions` used to get: votes, shadow wording, the extras, the explainer's words. */
  function jevOpts(): JevActionsOptions {
    return {
      open: true,
      votes,
      shadow: store.state.status?.mode !== "enforce",
      extra: (a) => actionExtra(a, store.turn(a.turnId)),
      explain: (a) => {
        const id = actionDecisionId(a);
        return id ? store.explanation(id) : undefined;
      },
      openDetails,
    };
  }

  /**
   * A refusal Jev saw, whole or partial (2026-10-22, the architect: "Add the rewind every time Jev detects a refusal, not only
   * complete but also partial"): its refusal mark, or a reply sent back because it dodged part of the work. A reply sent
   * back for another reason (an unsupported claim) is not one.
   */
  const wholeRefusal = (a: JevAction): boolean => a.did === "refusal" || a.iv?.kind === "refusal";
  const refusalLike = (a: JevAction): boolean =>
    wholeRefusal(a) ||
    (a.did === "sent-back" && a.reasons.some((r) => r.questionId === "dodged-work"));
  /** The actions that carry a turn's refusal strip, while `runHtml` draws (null outside it: no restriction). */
  let stripKeys: Set<string> | null = null;

  const jevId = (a: JevAction): string => `jev:${a.key}`;
  /** The tool call a Jev action judged, when its driving answer names one. */
  const jevTool = (a: JevAction): string | null => a.reasons[0]?.toolUseId ?? null;

  /** One Jev action as a pink Amygdala bubble: the row `renderAction` draws, wrapped. */
  function jevBubble(a: JevAction): string {
    const id = jevId(a);
    return renderJevBubble(renderAction(a, jevOpts()), {
      id,
      toolUseId: jevTool(a),
      focused: focusedId === id,
      would: !actionActed(a),
    });
  }

  /** Every Jev action of the tab on screen (loads the tab's own feed the first time). */
  function tabActions(): JevAction[] {
    ensureTabLoaded(deps.tabKey());
    return actionsOf(store.turnsFor(deps.tabKey()));
  }

  function jevActionsFor(toolUseId: string): JevAction[] {
    const tab = deps.tabKey();
    if (!jevByTool || jevByToolTab !== tab) {
      jevByToolTab = tab;
      jevByTool = new Map();
      for (const a of tabActions()) {
        const t = jevTool(a);
        if (!t) continue;
        const list = jevByTool.get(t);
        if (list) list.push(a);
        else jevByTool.set(t, [a]);
      }
    }
    return jevByTool.get(toolUseId) ?? [];
  }

  /**
   * What is left to draw after a reply (2026-10-15): the Jev actions that name no tool call, so no tool row can host
   * them (the prompt and stop seams, lone rules; the refusal strip and the Rewound line ride on theirs), each a pink
   * bubble, then the markers. Keyed by the reply's first turn.
   */
  function runHtml(turns: TurnView[], providerSafeguard = false): string {
    const key = turns[0]?.turnId;
    if (!key) return "";
    const shown = actionsOf(turns)
      // A provider safeguard block is a refusal the owner can rewind and retry on another model (2026-10-22, the
      // architect: "the button to rewind which should put in my input box the same prompt that caused it, and Thalamus
      // should be at work here proposing which model to choose next"). Shown in shadow too; nothing resends unclicked.
      // Every other refusal Jev detects offers the same strip, shadow included (2026-10-22 14:55: "When Jev detects a
      // refusal to respond, the ui should present a rewind button along its detection"), once the gateway's Rewind
      // really takes the exchange out of the model's context (status `rewind` ≥ 2). The strip is his choice, never an
      // enforcement: the 10-15 rule that hid shadow decisions had hidden it too.
      .filter(
        (a) =>
          !jevTool(a) &&
          (actionActed(a) ||
            (refusalLike(a) && (providerSafeguard || (store.state.status?.rewind ?? 0) >= 2))),
      );
    // One strip per refused turn: Jev can mark the same turn more than once (three times on one turn, 2026-10-21; a
    // refusal and a dodged-work send-back twice over on one turn, 2026-10-22), and every copy would offer the same
    // Rewind. A whole refusal carries it before a partial one, then the newest. An acted send-back still shows its row.
    const carrier = new Map<string, JevAction>();
    for (const a of shown) {
      if (!refusalLike(a)) continue;
      const c = carrier.get(a.turnId);
      if (!c || wholeRefusal(a) || !wholeRefusal(c)) carrier.set(a.turnId, a);
    }
    stripKeys = new Set([...carrier.values()].map((a) => a.key));
    let parts: string[];
    try {
      parts = shown
        .filter(
          (a) => !refusalLike(a) || stripKeys!.has(a.key) || (actionActed(a) && !wholeRefusal(a)),
        )
        .map((a) => jevBubble(a));
    } finally {
      stripKeys = null;
    }
    for (const t of turns) for (const m of t.markers) parts.push(renderMarker(m));
    return parts.length
      ? `<div class="amy-turn" data-amy-turn="${esc(key)}">${parts.join("")}</div>`
      : "";
  }

  /** Does a time fall within the reply to `userMsg` (the run that ends at `nextUserMsg`)? */
  function inRun(ts: number, from: number | undefined, to: number | undefined): boolean {
    return (
      from !== undefined &&
      ts >= from - CLOCK_SKEW_MS &&
      (to === undefined || ts < to - CLOCK_SKEW_MS)
    );
  }

  /** The turns of this tab whose first decision falls within the reply to `userMsg`. */
  function turnsForRun(userMsg: unknown, nextUserMsg: unknown): TurnView[] {
    // A placeholder stands where a rewound exchange was (rewound-exchanges.ts): its Jev turns left with the exchange.
    if ((userMsg as { _rewoundExchange?: unknown } | null)?._rewoundExchange) return [];
    ensureTabLoaded(deps.tabKey());
    const turns = store.turnsFor(deps.tabKey());
    if (turns.length === 0) return [];
    const from = rowTime(userMsg);
    if (from === undefined) {
      // No time on the prompt: the newest turn belongs to the last run and nothing else can be placed.
      return nextUserMsg === null || nextUserMsg === undefined ? [turns[turns.length - 1]!] : [];
    }
    const to = rowTime(nextUserMsg);
    return turns.filter((t) => inRun(t.ts, from, to));
  }

  function panelInput() {
    const s = store.state;
    const t = now();
    const dayStart = t - (t % DAY_MS);
    const ivs: InterventionView[] = store
      .turnsFor(deps.tabKey())
      .flatMap((x) => x.interventions)
      .filter((i) => i.ts >= dayStart && i.kind !== "note");
    return {
      available: available(),
      status: s.status,
      questions: s.questions,
      changes: s.changes,
      precedents: s.precedents,
      spend: s.spend,
      strip: store.hourStrip(t),
      interventionsToday: ivs,
      now: t,
    };
  }

  /**
   * One tab's own feed, the first time the tab is drawn. The connect-time feed is the newest events of the whole
   * gateway, so a quiet tab (the CTO tab, 2026-09-30) got none of its own and showed no strips.
   */
  const loadedTabs = new Set<string>();
  function ensureTabLoaded(tab: string): void {
    if (!available() || loadedTabs.has(tab)) return;
    loadedTabs.add(tab);
    void (async () => {
      try {
        const feed = await deps.req<Partial<FeedView>>("amygdala2.feed", {
          sessionKey: tab,
          limit: 400,
          sinceTs: now() - FEED_WINDOW_MS,
        });
        if (feed && typeof feed === "object") {
          store.applyFeed(feed);
          deps.repaintChat();
        }
      } catch (err) {
        loadedTabs.delete(tab);
        console.error("[amygdala-ui] tab feed failed", err);
      }
    })();
  }

  async function probe(): Promise<void> {
    loadedTabs.clear();
    try {
      const status = await deps.req<unknown>("amygdala2.status");
      if (!status || (status as { ok?: boolean }).ok === false) {
        store.setAvailable(false);
        return;
      }
      store.applyEvent("amygdala2.status", status);
      store.setAvailable(true);
      // 36 h, not "since midnight": a refusal at 23:30 must still show its strip the next morning (2026-09-30).
      const feed = await deps.req<Partial<FeedView>>("amygdala2.feed", {
        limit: 400,
        sinceTs: now() - FEED_WINDOW_MS,
      });
      if (feed && typeof feed === "object") store.applyFeed(feed);
    } catch (err) {
      // An unknown method is the normal answer while the plugin is off: stay inert and quiet.
      store.setAvailable(false);
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      if (!/unknown method|not found|no such method/i.test(msg))
        console.error("[amygdala-ui] probe failed", err);
    }
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const r = await deps.req<Record<string, unknown>>(method, params);
      if (r && r.ok === false) {
        deps.notify?.(`Amygdala: ${String(r.error ?? "that did not work")}`);
        return null;
      }
      return r ?? {};
    } catch (err) {
      console.error(`[amygdala-ui] ${method} failed`, err);
      deps.notify?.(`Amygdala: ${method} failed (devtools console has the full error)`);
      return null;
    }
  }

  const toggle = (set: Set<string>, id: string): void => {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  };

  return {
    store,
    available,

    onEvent(name, payload) {
      if (name === "thalamus.refusal") {
        const p = payload as { turnId?: unknown; sessionKey?: unknown; retry?: unknown };
        if (typeof p.turnId === "string" && p.sessionKey === deps.tabKey()) {
          retryByTurn.set(p.turnId, asRetry(p.retry));
          retryAsked.add(p.turnId);
          if (retryByTurn.size > 200) retryByTurn.delete(retryByTurn.keys().next().value as string);
          deps.repaintChat();
        }
        return;
      }
      // The "not consulted" line went with the CHECKS window (2026-10-15); the note has nothing to draw now.
      if (name === "amygdala2.consult") return;
      if (!name.startsWith("amygdala2.")) return;
      if (store.state.available === null && name === "amygdala2.status") store.setAvailable(true);
      store.applyEvent(name, payload);
    },

    onConnected: probe,

    afterRun(userMsg, nextUserMsg, providerSafeguard) {
      if (!available()) return "";
      runExchangeKey = deps.exchangeKeyOf?.(userMsg) ?? null;
      try {
        return runHtml(turnsForRun(userMsg, nextUserMsg), providerSafeguard);
      } finally {
        runExchangeKey = null;
      }
    },

    onHookAction(raw) {
      const a = hookActionFrom(raw);
      // The same row comes twice: the live event, then the connect-time feed. One bubble.
      if (!a || hooks.has(a.id)) return;
      hooks.set(a.id, a);
      if (hooks.size > HOOK_KEEP) {
        // By time, not by arrival: a live row that came in before the seed must outlive the seed's old rows.
        const drop = [...hooks.values()]
          .sort((x, y) => x.ts - y.ts)
          .slice(0, hooks.size - HOOK_KEEP);
        for (const old of drop) hooks.delete(old.id);
      }
      deps.repaintChat();
    },

    inlineFor(toolUseId) {
      if (!toolUseId) return "";
      const parts: string[] = [];
      for (const a of hooks.values())
        if (a.toolUseId === toolUseId)
          parts.push(renderHookBubble(a, { focused: focusedId === a.id }));
      if (available())
        for (const a of jevActionsFor(toolUseId)) if (actionActed(a)) parts.push(jevBubble(a));
      return parts.join("");
    },

    marks() {
      const out = [...hooks.values()].map((a) => ({
        id: a.id,
        ts: a.ts,
        toolUseId: a.toolUseId,
      }));
      if (available())
        for (const a of tabActions())
          if (actionActed(a)) out.push({ id: jevId(a), ts: a.ts, toolUseId: jevTool(a) });
      return out.sort((x, y) => x.ts - y.ts);
    },

    setFocus(id) {
      if (focusedId === id) return;
      focusedId = id;
      deps.repaintChat();
    },

    focused() {
      return focusedId;
    },

    tailHtml() {
      if (!available()) return "";
      const cards = store
        .pendingChanges()
        .map((c) => renderExceptionalCard(c, expandedChanges.has(c.id)));
      return cards.length ? `<div class="amy-tail">${cards.join("")}</div>` : "";
    },

    panelBodyHtml() {
      if (!available()) return "";
      const body = renderAmygdalaPanelBody(panelInput(), { open: openAcc });
      return canaryText ? `${body}<div class="amy-canary">${esc(canaryText)}</div>` : body;
    },

    dotHtml() {
      if (!available()) return "";
      return renderDot(store.dot(), store.state.status?.line ?? "Amygdala");
    },

    async handleClick(el) {
      const act = el.getAttribute("data-amy-act");
      if (!act) return false;
      const d = (name: string): string => el.getAttribute(name) ?? "";
      switch (act) {
        case "jev-toggle":
          toggle(openWindows, d("data-run"));
          break;
        case "jev-act-toggle":
          toggle(openActions, d("data-run"));
          break;
        case "jev-col": {
          // A second click on the same column folds its list again.
          const run = d("data-run");
          const col = Number(d("data-col"));
          if (selectedCol.get(run) === col || !Number.isInteger(col)) selectedCol.delete(run);
          else selectedCol.set(run, col);
          break;
        }
        case "jev-row":
          toggle(openRows, d("data-id"));
          break;
        case "jev-act-detail":
          toggle(openDetails, d("data-action"));
          break;
        case "why":
          toggle(shownWhy, d("data-iv"));
          break;
        case "ask-select":
          selectedOption.set(d("data-iv"), d("data-option"));
          break;
        case "see-cases":
          toggle(expandedChanges, d("data-change"));
          break;
        case "acc":
          toggle(openAcc, d("data-acc"));
          break;
        case "dot":
          deps.openPanel?.();
          return true;
        case "label": {
          const r = await call("amygdala2.label", {
            targetId: d("data-target-id"),
            targetKind: d("data-target-kind") === "verdict" ? "verdict" : "decision",
            kind: d("data-kind") || "useful",
            value: Number(d("data-value")),
          });
          if (r !== null && r !== undefined)
            votes.set(d("data-target-id"), Number(d("data-value")));
          deps.repaintChat();
          return true;
        }
        case "answer":
          await call("amygdala2.answer", {
            interventionId: d("data-iv"),
            answer: d("data-answer"),
          });
          return true;
        case "ask-confirm": {
          const iv = d("data-iv");
          const chosen =
            selectedOption.get(iv) ??
            store
              .turnsFor(deps.tabKey())
              .flatMap((t) => t.interventions)
              .find((i) => i.id === iv)?.options?.[0]?.id;
          if (chosen)
            await call("amygdala2.answer", { interventionId: iv, answer: `option:${chosen}` });
          return true;
        }
        case "refusal-keep":
          store.keepRefusal(d("data-turn"));
          return true;
        case "rewind": {
          await rewindNewest({
            turnId: d("data-turn"),
            exchangeKey: el.getAttribute("data-exchange") ?? undefined,
          });
          return true;
        }
        case "rewind-exchange-undo": {
          // The placeholder where a rewound exchange was. The gateway points the tab back at the session it had.
          const key = d("data-exchange");
          const tab = deps.tabKey();
          const r = await rewindCall("", true);
          if (r && r.ok === true) {
            deps.showExchange?.(tab, key);
            const turnId = rewoundTurnByKey.get(key);
            if (turnId) store.clearRewound(turnId);
            rewoundTurnByKey.delete(key);
          } else if (r) {
            deps.notify?.(`Amygdala: undo did not work (${String(r.reason ?? "unknown")})`);
          }
          return true;
        }
        case "rewind-retry": {
          const turnId = d("data-turn");
          const pick = retryByTurn.get(turnId);
          if (!pick || !deps.sendOneTurn) return true;
          const r = await rewindCall(turnId, false);
          if (r && r.ok === true) {
            const prompt = typeof r.restoredPrompt === "string" ? r.restoredPrompt : undefined;
            store.markRewound(turnId, {
              restoredPrompt: prompt,
              forkSessionId: typeof r.forkSessionId === "string" ? r.forkSessionId : undefined,
              ts: now(),
            });
            if (prompt) {
              try {
                await deps.sendOneTurn(prompt, pick.model);
              } catch (err) {
                console.error("[amygdala-ui] retry send failed", err);
                deps.setComposerText(prompt);
                deps.notify?.("Retry could not be sent; the prompt is back in the composer");
              }
            } else {
              deps.notify?.("Rewound, but the prompt was not returned, so nothing was retried");
            }
          } else if (r) {
            deps.notify?.(
              `Amygdala: rewind is not available here (${String(r.reason ?? r.capability ?? "unsupported")})`,
            );
          }
          return true;
        }
        case "rewind-undo": {
          const turnId = d("data-turn");
          const r = await rewindCall(turnId, true);
          if (r && r.ok === true) store.clearRewound(turnId);
          else if (r)
            deps.notify?.(`Amygdala: undo did not work (${String(r.reason ?? "unknown")})`);
          return true;
        }
        case "approve":
          await call("amygdala2.approve", {
            changeId: d("data-change"),
            approve: d("data-yes") === "1",
          });
          await probe();
          return true;
        case "undo":
          await call("amygdala2.undo", { changeId: d("data-change") });
          await probe();
          return true;
        case "canary": {
          const r = await call("amygdala2.canary", {});
          canaryText = r
            ? `Canary held by the hard rules in ${String(r.floorMs)} ms · judge ${r.judgeMs === null ? "did not answer" : `answered in ${String(r.judgeMs)} ms`}`
            : "Canary could not run";
          break;
        }
        default:
          return false;
      }
      deps.repaintChat();
      deps.repaintPanel();
      return true;
    },
  };
}
