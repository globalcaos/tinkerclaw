import {
  type AllowItem,
  type EffectView,
  renderAllowBar,
  renderEffectCards,
  renderAskCard,
  renderExceptionalCard,
  renderHoldCard,
  renderMarker,
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
import { esc, type RuleRef } from "./amygdala-html.js";
import {
  type HookAction,
  hookActionFrom,
  hookAsk,
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
import type {
  FeedView,
  InterventionView,
  QuestionRow,
  RuleRow,
  TurnView,
} from "./amygdala-types.js";
import { renderAmygdalaPanelBody, renderDot } from "./panels/amygdala.js";
import type { StopBubble } from "./stop-bubble-placement.js";

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
   * FORK 2026-10-29: send a prompt as the owner, the composer's own path (the Allow button under a held reply sends
   * "allow <code>", the words he used to copy and paste). Absent: the words go into the composer for him to send.
   */
  sendPrompt?(text: string): Promise<unknown> | unknown;
  /**
   * FORK 2026-10-22 (the architect: a Rewind next to a refusal removes the last response from context AND chat). All optional, so a
   * page without them behaves as before. `exchangeKeyOf` names the exchange a run's prompt row opens (the strip carries it);
   * `newestExchange` is the exchange a Rewind would take, read from the page NOW (null while a reply runs or when the chat
   * holds no prompt); `hideExchange` / `showExchange` take it off the page and put it back.
   */
  exchangeKeyOf?(promptRow: unknown): string | null;
  newestExchange?(): { key: string; prompt: string; at?: number } | null;
  /**
   * 2026-10-22 (Rewind attaches to the turn, so more than one turn can be removed from history): the
   * exchange with this key on the page now and how many exchanges follow it; null while a reply runs or when it is gone.
   */
  exchangeAt?(
    key: string,
    /** FORK 2026-11-13: the time of the prompt row meant; two prompts with the same words share a key. */
    at?: number,
  ): { key: string; prompt: string; at?: number; later: number } | null;
  /**
   * FORK 2026-11-13 (`/rewind n`): the n-th exchange from the end of the page (1 = the newest) with the n - 1 after it;
   * null when the page holds fewer, or while a reply runs.
   */
  nthNewestExchange?(n: number): { key: string; prompt: string; at?: number; later: number } | null;
  /**
   * FORK 2026-11-13: the exchange the page must hide from, given the one the owner pointed at and the time of the
   * prompt the gateway cut at. It starts earlier than the one pointed at when one turn of the model shows as two
   * prompt rows (rewound-exchanges.ts `exchangeFromCut`). Null: hide from the one pointed at.
   */
  exchangeFromCut?(
    ex: { key: string; at?: number },
    cutAt: number,
  ): { key: string; prompt: string; at?: number; later: number } | null;
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
  afterRun(
    userMsg: unknown,
    nextUserMsg: unknown,
    providerSafeguard?: boolean,
    placed?: ReadonlySet<string>,
  ): string;
  /** The run's stop-check bubbles, which belong between the answers rather than after them. */
  stopBubbles(userMsg: unknown, nextUserMsg: unknown): StopBubble[];
  /**
   * FORK 2026-11-13: when a stop check sent a reply of this tab back, one time per send-back the gateway enforced, kept
   * for the life of the page. The chat keeps the answer each one judged out of the Reasoning fold (chat-units.ts).
   */
  sendBackTimes(): number[];
  /** An `amygdala.hook` live event or an `amygdala.feed` row: kept (by id, the newest 500) and the chat repainted. */
  onHookAction(raw: unknown): void;
  /** Every bubble for one tool call, the hook's first then Jev's; "" when neither acted on it. Hook bubbles need no amygdala2. */
  inlineFor(toolUseId: string, plain?: string): string;
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
  /**
   * FORK 2026-11-13: `/rewind` typed in the box. "" takes the newest exchange out of the model's context and off the
   * page and puts its prompt back in the box; "3" takes the last three. Needs no refusal and no strip.
   */
  rewindCommand(arg: string): Promise<void>;
}

const CLOCK_SKEW_MS = 5_000;
const DAY_MS = 86_400_000;
/** Hook actions kept per page (the oldest by time go first). */
const HOOK_KEEP = 500;
const FEED_WINDOW_MS = 36 * 3_600_000;

/** A chat row's time, in the same keys msg-order.ts reads. */
export function rowTime(m: unknown): number | undefined {
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
  /** Bubbles the owner opened with their line's caret: Jev actions by key, hook actions by id. */
  const openDetails = new Set<string>();
  /** Votes given in this page, by target id, so a row shows which one counted (2026-10-02). */
  const votes = new Map<string, number>();
  const openAcc = new Set<string>();
  const expandedChanges = new Set<string>();
  const selectedOption = new Map<string, string>();
  /** Thalamus's retry pick per refused turn; null = asked, nothing to offer. Filled by the event or by one question. */
  const retryByTurn = new Map<string, RetryPickView | null>();
  const retryAsked = new Set<string>();
  let canaryText = "";
  // FORK 2026-10-15 (each of Jev's actions shows where it happened): the hook's actions (AEGIS, v3.1) by id,
  // and the bubble a timeline brain focused. The hook needs no amygdala2, so these live outside `available()`.
  const hooks = new Map<string, HookAction>();
  let focusedId: string | null = null;
  /** Jev actions by tool use id for the tab on screen; rebuilt when the store or the tab changes. */
  let jevByTool: Map<string, JevAction[]> | null = null;
  let jevByToolTab = "";
  /**
   * FORK 2026-11-13: the send-back times already handed to the chat, per tab. The store keeps only the newest turns of
   * every tab the page hears; the chat keeps its rows, and stamps a run again whenever a row joins it.
   */
  const sentBackSeen = new Map<string, Set<number>>();
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
    /** Level 4: the time of the page's row for that prompt, and whether the page holds it as its newest exchange. */
    named?: { at?: number; orLast?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const extra = undo ? { undo: true } : {};
    try {
      let r = await deps.req<Record<string, unknown>>("amygdala2.rewind", {
        sessionKey: deps.tabKey(),
        turnId,
        ...extra,
        ...(fromPrompt ? { fromPrompt } : {}),
        ...(fromPrompt && named?.at !== undefined ? { fromPromptAt: named.at } : {}),
        ...(fromPrompt && named?.orLast ? { orLast: true } : {}),
      });
      // The built-in runner's `sessions.rewind` takes only the last exchange, so a rewind of several never falls back.
      if (r && r.ok !== true && r.capability === "unsupported" && (!fromPrompt || named?.orLast)) {
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
  /** When that run's prompt row was sent: tells apart two exchanges whose prompts have the same words (2026-11-13). */
  let runExchangeAt: number | undefined;
  /** The Jev turn each hidden exchange came from, so Undo can give its strip back. */
  const rewoundTurnByKey = new Map<string, string>();

  /**
   * FORK 2026-10-22: a Rewind next to a refusal removes the last response from context and chat and puts the prompt
   * back in the input box, so the refusal's advice can be followed another way. The gateway takes the tab's last exchange out of what the model sees; this puts the prompt back in the box
   * and takes the exchange off the page. Nothing is sent and no model is picked.
   *
   * Guards, each bought by a way this click could do harm:
   *  - STALE: the strip names its exchange; if the page's newest exchange is another one (or a reply is running), the
   *    click does nothing, because the gateway would remove whatever is last, not what the strip sits under.
   *  - DRAFT: an unsent draft in the box is the owner's. Asked BEFORE anything is rewound, so "no" changes nothing.
   *  - TAB: the answer arrives after an await; the box written to is the one on screen now, so a tab switch in between
   *    must not put this tab's prompt into another tab's box.
   */
  async function rewindNewest(o: {
    turnId: string;
    exchangeKey?: string;
    /** The time of the strip's prompt row (2026-11-13): which of two exchanges with the same words. */
    exchangeAt?: number;
    /** `/rewind n`: no strip; the n-th exchange from the end of the page and every later one. */
    back?: number;
  }): Promise<void> {
    const tab = deps.tabKey();
    const command = o.back !== undefined;
    // Level 3: the strip's own exchange, wherever it sits; it and every later one go. Older: only the newest.
    const at = command
      ? o.back! > 1
        ? (deps.nthNewestExchange?.(o.back!) ?? null)
        : undefined
      : multiRewind() && o.exchangeKey !== undefined
        ? deps.exchangeAt!(o.exchangeKey, o.exchangeAt)
        : undefined;
    const ex = at !== undefined ? at : (deps.newestExchange?.() ?? null);
    if (command && !ex) {
      deps.notify?.(
        o.back! > 1
          ? `Rewind: this chat shows fewer than ${String(o.back)} exchanges, or a reply is still running, so nothing was rewound`
          : "Rewind: there is no exchange to rewind here, or a reply is still running",
      );
      return;
    }
    if (o.exchangeKey !== undefined && (!ex || ex.key !== o.exchangeKey)) {
      deps.notify?.(
        at !== undefined
          ? "Amygdala: that exchange is no longer on the page, or a reply is still running, so nothing was rewound"
          : "Amygdala: that is no longer the newest exchange, so nothing was rewound",
      );
      deps.repaintChat();
      return;
    }
    // The command sits in the box while it runs: that is not a draft to ask about.
    if (
      !command &&
      deps.composerDraft?.().trim() &&
      deps.confirmReplaceDraft &&
      !deps.confirmReplaceDraft()
    ) {
      return;
    }
    const count = 1 + (at?.later ?? 0);
    // Level 4 (2026-11-13): the gateway is told which exchange the page means, by its words and the time of its row,
    // also when it is the newest one (then `orLast`: a row the transcript words differently still rewinds the last
    // prompt). Older gateways are named only for a rewind of several, by words.
    const level4 = (store.state.status?.rewind ?? 0) >= 4;
    const r = await rewindCall(
      o.turnId,
      false,
      count > 1 || level4 ? ex?.prompt : undefined,
      level4 ? { at: ex?.at, orLast: count === 1 } : undefined,
    );
    if (!r) return;
    if (r.ok !== true) {
      deps.notify?.(
        command
          ? `Rewind did nothing: ${String(r.reason ?? r.capability ?? "unsupported")}`
          : `Amygdala: rewind is not available here (${String(r.reason ?? r.capability ?? "unsupported")})`,
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
    if (o.turnId) {
      store.markRewound(o.turnId, {
        restoredPrompt: prompt,
        forkSessionId: typeof r.forkSessionId === "string" ? r.forkSessionId : undefined,
        ts: rewoundAt,
      });
    }
    if (ex) {
      // The gateway says where it cut: when that is before the row pointed at (one turn of the model drawn as two
      // prompt rows), the page hides from there, so nothing stays on screen that the model no longer holds.
      const cutAt = typeof r.cutAt === "number" ? r.cutAt : undefined;
      const start =
        cutAt === undefined
          ? null
          : (deps.exchangeFromCut?.({ key: ex.key, at: ex.at }, cutAt) ?? null);
      const from = start ?? { key: ex.key, prompt: ex.prompt, at: ex.at, later: count - 1 };
      const hidden = 1 + from.later;
      if (o.turnId) rewoundTurnByKey.set(from.key, o.turnId);
      deps.hideExchange?.({
        sessionKey: tab,
        key: from.key,
        prompt: from.prompt,
        at: from.at,
        rewoundAt,
        restored: prompt,
        ...(hidden > 1 ? { count: hidden } : {}),
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

  /** `/rewind n` takes at most this many exchanges at once (the page keeps 20 rewound records per tab). */
  const MAX_REWIND_BACK = 20;

  /**
   * Level 4: the exchange a button sits under, named for the gateway as its newest (words, time of its row, and the
   * fall-back to the last prompt). Older gateways, or no exchange on the page: unnamed, as before.
   */
  function namedNewest(
    el: Element,
  ): [string | undefined, { at?: number; orLast?: boolean } | undefined] {
    if ((store.state.status?.rewind ?? 0) < 4) return [undefined, undefined];
    const key = el.getAttribute("data-exchange");
    const sentAt = Number(el.getAttribute("data-exchange-at") ?? Number.NaN);
    const ex =
      key && deps.exchangeAt
        ? deps.exchangeAt(key, Number.isFinite(sentAt) ? sentAt : undefined)
        : (deps.newestExchange?.() ?? null);
    return ex ? [ex.prompt, { at: ex.at, orLast: true }] : [undefined, undefined];
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

  /**
   * FORK 2026-10-29: open cards drawn by a run this render. A card that no run drew (a hold on a tool call while the
   * turn is still running, or one with no action row) waited five minutes unseen and expired, twice in one evening.
   * The tail, which is always on screen above the thinking indicator, draws the rest; it clears the set for the next render.
   */
  const drawnOpen = new Set<string>();
  /** Cards already logged as drawn at the tail, so the [amy-tail] line fires once per card, not on every repaint. */
  const tailLogged = new Set<string>();

  /**
   * FORK 2026-10-29: the steps waiting for the owner's OK that this render drew inside the current run (an AEGIS deny's
   * grant, a proof hold's code). The run's `afterRun` closes it with the Allow bar and empties it; `tailHtml` empties
   * what is left at the end of the render. `sentGrants`: codes whose button was clicked on this page.
   */
  const runGrants = new Map<string, AllowItem>();
  const sentGrants = new Set<string>();
  /** The agent's sentence for the tool row being drawn: the bar falls back to it, never to the command. */
  let rowPlain: string | undefined;
  function noteGrant(code: string | null | undefined, sentence?: string, ask?: string): void {
    if (!code || runGrants.has(code)) return;
    runGrants.set(code, {
      code,
      ask: ask ?? "Allow this step?",
      what: sentence ?? rowPlain ?? "A held step",
    });
  }

  /** The feed's question and rule rows by id, rebuilt when the store hands new arrays (FORK 2026-11-03). */
  let wordsOf: { q: QuestionRow[]; r: RuleRow[] } | null = null;
  let questionById = new Map<string, QuestionRow>();
  let ruleById = new Map<string, RuleRow>();
  function lookups(): void {
    const { questions, rules } = store.state;
    if (wordsOf && wordsOf.q === questions && wordsOf.r === rules) return;
    wordsOf = { q: questions, r: rules };
    questionById = new Map(questions.map((q) => [q.id, q]));
    ruleById = new Map(rules.map((r) => [r.id, r]));
  }

  /**
   * What a Jev action's bubble says and the rules it names: its driving questions in order, then a hold's rule. The
   * line is the first `says` found; a question the feed did not list still shows by the name its decision carried.
   */
  function actionWords(a: JevAction): { line?: string; rules: RuleRef[] } {
    lookups();
    const rules: RuleRef[] = [];
    const seen = new Set<string>();
    let line: string | undefined;
    const add = (id: string | undefined, name?: string): void => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const q = questionById.get(id);
      const r = q ? undefined : ruleById.get(id);
      const file = q?.file ?? r?.file;
      rules.push({ name: q?.name ?? r?.explanation ?? name ?? id, ...(file ? { file } : {}) });
      line ??= q?.says ?? r?.says;
    };
    for (const d of a.reasons) add(d.questionId, d.questionName);
    add(a.iv?.rule);
    return { line, rules };
  }
  /** The owner already used this AEGIS grant: a later hook row says the command ran on it. */
  function grantUsed(code: string): boolean {
    for (const h of hooks.values())
      if (h.decision === "owner-allow" && h.grant === code) return true;
    return false;
  }
  function takeRunGrants(): AllowItem[] {
    const out = [...runGrants.values()];
    runGrants.clear();
    return out;
  }

  /** What rides on an action's row: a card waiting for an answer (enforce mode), the refusal offer, the Rewound line. */
  function actionExtra(a: JevAction, t: TurnView | undefined): string {
    const iv = a.iv;
    if (!iv || !t) return "";
    if (iv.state === "open") {
      drawnOpen.add(iv.id);
      if (iv.kind === "hold") return renderHoldCard(iv);
      // FORK 2026-11-03: a proof draws no card of its own: the bubble's line says what it wants shown, its fold the
      // rule, and the reply's Allow bar asks the question.
      if (iv.kind === "proof") {
        noteGrant(iv.grant, iv.sentence, iv.ask);
        return "";
      }
      if (iv.kind === "ask") return renderAskCard(iv, selectedOption.get(iv.id) ?? null);
    }
    // FORK 2026-10-31: a hold or ask whose five-minute wait ran out keeps its button: the reply's Allow bar releases it.
    if (iv.state === "expired" && (iv.kind === "hold" || iv.kind === "ask"))
      noteGrant(iv.grant, iv.sentence, iv.ask);
    if (!refusalLike(a) || (stripKeys !== null && !stripKeys.has(a.key))) return "";
    if (t.rewound) return renderRewoundMarker(t.turnId, t.rewound);
    if (t.refusalKept) return "";
    // Level 3 (2026-10-22): every refused turn offers Rewind, which takes its exchange and every later one; the button
    // says how many. Older gateways remove only the LAST exchange, so only the newest un-rewound turn may offer it.
    const at =
      multiRewind() && runExchangeKey ? deps.exchangeAt!(runExchangeKey, runExchangeAt) : undefined;
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
      runExchangeAt,
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
      words: actionWords,
    };
  }

  /**
   * A refusal Jev saw, whole or partial (2026-10-22: every refusal Jev detects gets the rewind,
   * partial ones included): its refusal mark, or a reply sent back because it dodged part of the work. A reply sent
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
  function runHtml(
    turns: TurnView[],
    providerSafeguard = false,
    placed?: ReadonlySet<string>,
  ): string {
    const key = turns[0]?.turnId;
    if (!key) return "";
    const shown = actionsOf(turns)
      // A provider safeguard block is a refusal the owner can rewind and retry on another model (2026-10-22: the rewind
      // button puts the triggering prompt back in the input box, and Thalamus proposes which model to try next). Shown in shadow too; nothing resends unclicked.
      // Every other refusal Jev detects offers the same strip, shadow included (2026-10-22: every refusal
      // Jev detects shows a rewind button beside the detection), once the gateway's Rewind
      // really takes the exchange out of the model's context (status `rewind` ≥ 2). The strip is his choice, never an
      // enforcement: the 10-15 rule that hid shadow decisions had hidden it too.
      .filter(
        (a) =>
          !jevTool(a) &&
          !placed?.has(a.key) &&
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
  /** FORK 2026-11-08: effect cards by id, from `amygdala2.effects` per tab and the live `amygdala2.effect` event. */
  const effects = new Map<string, EffectView>();
  function ensureTabLoaded(tab: string): void {
    if (!available() || loadedTabs.has(tab)) return;
    loadedTabs.add(tab);
    void (async () => {
      try {
        const r = await deps.req<{ effects?: EffectView[] }>("amygdala2.effects", {
          sessionKey: tab,
          sinceTs: now() - FEED_WINDOW_MS,
        });
        for (const e of r?.effects ?? []) if (e?.id) effects.set(e.id, e);
        if (r?.effects?.length) deps.repaintChat();
      } catch (err) {
        // An older gateway has no such method: no cards, nothing else changes.
        console.error("[amygdala-ui] effects load failed", err);
      }
    })();
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
      if (name === "amygdala2.effect") {
        const e = payload as EffectView | null;
        if (e?.id) {
          effects.set(e.id, e);
          if (e.sessionKey === deps.tabKey()) deps.repaintChat();
        }
        return;
      }
      if (!name.startsWith("amygdala2.")) return;
      if (store.state.available === null && name === "amygdala2.status") store.setAvailable(true);
      store.applyEvent(name, payload);
    },

    onConnected: probe,

    stopBubbles(userMsg, nextUserMsg) {
      if (!available()) return [];
      const turns = turnsForRun(userMsg, nextUserMsg);
      // The run's first turn is the one its prompt started: that turn's prompt check judged it.
      const runTurn = turns[0]?.turnId;
      return actionsOf(turns).flatMap((a) => {
        const first = a.reasons[0];
        // FORK 2026-11-13 (F2): a send-back is a stop check whether or not a judge answer drove it. The one kind
        // left since 2026-11-10 (the reply admits it did not check something) has none, so it had no decision to
        // read the seam or the time from, and its card fell to the closing block, after the result it caused.
        const seam = first?.seam ?? (a.did === "sent-back" ? "stop" : undefined);
        // FORK 2026-11-13 (F3): a refusal mark is not placed here. It sends nothing back, so counted as a send-back
        // it was drawn above the reply it marks, and its strip, drawn outside afterRun, named no exchange. The
        // closing block draws it, under the reply and with its exchange.
        const inline =
          (seam === "stop" || seam === "prompt") &&
          !jevTool(a) &&
          actionActed(a) &&
          a.did !== "refusal";
        return inline
          ? [
              {
                key: a.key,
                ts: first?.ts ?? a.ts,
                html: jevBubble(a),
                opens: a.iv ? a.iv.kind !== "note" : a.did !== "note",
                seam: seam as "stop" | "prompt",
                turnId: a.turnId,
                opensRun: seam === "prompt" && a.turnId === runTurn,
              },
            ]
          : [];
      });
    },

    sendBackTimes() {
      if (!available()) return [];
      const tab = deps.tabKey();
      const seen = sentBackSeen.get(tab) ?? new Set<number>();
      sentBackSeen.set(tab, seen);
      // One with a judge answer behind it acted when its decision was enforced; one no judge drove (the unchecked
      // admission, the only kind since 2026-11-10) when its card is open. A shadow record is neither.
      for (const a of tabActions()) {
        if (a.did === "sent-back" && actionActed(a)) seen.add(a.ts);
      }
      return [...seen];
    },

    afterRun(userMsg, nextUserMsg, providerSafeguard, placed) {
      let html = "";
      if (available()) {
        runExchangeKey = deps.exchangeKeyOf?.(userMsg) ?? null;
        runExchangeAt = rowTime(userMsg);
        try {
          html = runHtml(turnsForRun(userMsg, nextUserMsg), providerSafeguard, placed);
        } finally {
          runExchangeKey = null;
          runExchangeAt = undefined;
        }
      }
      // The run's rows, and the bubbles drawn just above, noted what waits for the owner: the Allow bar closes the reply.
      // FORK 2026-11-08: the changes this reply made for other people, each with its Revert, sit above the Allow bar.
      const from = rowTime(userMsg);
      const to = rowTime(nextUserMsg);
      const tab = deps.tabKey();
      const mine = [...effects.values()]
        .filter(
          (e) =>
            e.sessionKey === tab &&
            // No time on the prompt: only the newest run can claim its cards, as turnsForRun does.
            (from === undefined
              ? nextUserMsg === null || nextUserMsg === undefined
              : inRun(e.ts, from, to)),
        )
        .toSorted((a, b) => a.ts - b.ts);
      return html + renderEffectCards(mine) + renderAllowBar(takeRunGrants(), sentGrants);
    },

    onHookAction(raw) {
      const a = hookActionFrom(raw);
      if (!a) return;
      // The same row comes twice, the live event and the feed, in either order. One bubble, but a
      // copy that brings the grant still counts: without it the deny has no Allow button.
      const known = hooks.get(a.id);
      if (known) {
        if (a.grant && !known.grant) {
          hooks.set(a.id, { ...known, grant: a.grant });
          deps.repaintChat();
        }
        return;
      }
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

    inlineFor(toolUseId, plain) {
      if (!toolUseId) return "";
      rowPlain = plain;
      const parts: string[] = [];
      lookups();
      for (const a of hooks.values())
        if (a.toolUseId === toolUseId) {
          const rule = a.rule ? ruleById.get(a.rule) : undefined;
          parts.push(
            renderHookBubble(a, { focused: focusedId === a.id, open: openDetails.has(a.id), rule }),
          );
          if (a.decision === "deny" && a.enforced && a.grant && !grantUsed(a.grant))
            noteGrant(a.grant, undefined, hookAsk(rule, a.target));
        }
      if (available())
        for (const a of jevActionsFor(toolUseId)) if (actionActed(a)) parts.push(jevBubble(a));
      rowPlain = undefined;
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
      // The end of a render: a run that drew grants but no afterRun must not hand them to the next render's first run.
      runGrants.clear();
      if (!available()) return "";
      // FORK 2026-10-29 (proof bubbles were drawn at the end of the chat): only cards that WAIT for a click
      // (hold, ask) belong above the thinking indicator. A proof is answered at once ("show evidence"), stays open until
      // evidence or the owner releases it, and sits folded in its own bubble; its button is in its reply's Allow bar.
      const waiting = store
        .openInterventions(deps.tabKey())
        .filter((iv) => !drawnOpen.has(iv.id))
        .map((iv) => {
          // A card at the tail missed its own turn's row; log once per card why, so a misplacement names its cause.
          if (!tailLogged.has(iv.id)) {
            tailLogged.add(iv.id);
            console.info("[amy-tail]", {
              id: iv.id,
              kind: iv.kind,
              state: iv.state,
              ts: new Date(iv.ts).toISOString(),
              turnId: iv.turnId,
              expiresTs: iv.expiresTs ? new Date(iv.expiresTs).toISOString() : null,
              expiredByClock: iv.expiresTs ? iv.expiresTs < Date.now() : null,
            });
          }
          return iv;
        })
        .map((iv) =>
          iv.kind === "hold"
            ? renderHoldCard(iv)
            : iv.kind === "ask"
              ? renderAskCard(iv, selectedOption.get(iv.id) ?? null)
              : "",
        )
        .filter(Boolean);
      drawnOpen.clear();
      const cards = [
        ...waiting,
        ...store.pendingChanges().map((c) => renderExceptionalCard(c, expandedChanges.has(c.id))),
      ];
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

    async rewindCommand(arg) {
      const a = arg.trim();
      const n = a === "" ? 1 : /^\d{1,2}$/.test(a) ? Number(a) : Number.NaN;
      if (!Number.isInteger(n) || n < 1 || n > MAX_REWIND_BACK) {
        deps.notify?.(
          `Rewind: type /rewind for the last exchange, or /rewind 3 for the last three (up to ${String(MAX_REWIND_BACK)})`,
        );
        return;
      }
      await rewindNewest({ turnId: "", back: n });
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
        case "amy-detail":
          toggle(openDetails, d("data-action"));
          break;
        case "effect-revert": {
          // FORK 2026-11-08: his click runs the stored undo on the gateway host; the answer and the live event repaint.
          const id = d("data-effect");
          const e = effects.get(id);
          if (!e || e.state === "reverting" || e.state === "reverted") return true;
          effects.set(id, { ...e, state: "reverting" });
          deps.repaintChat();
          const r = await call("amygdala2.effectRevert", { id });
          const after = (r as { effect?: EffectView } | null)?.effect;
          if (after?.id) effects.set(id, after);
          else {
            effects.set(id, { ...e, state: "revert-failed", output: "the gateway did not answer" });
            deps.notify?.("Amygdala: the revert did not run");
          }
          deps.repaintChat();
          return true;
        }
        case "allow-grant": {
          // FORK 2026-10-29: the owner's one-click OK for a held step: his own prompt "allow <code>", which the hard
          // rules (AEGIS grants) and the safety family (proof holds) both read as his release. One send per code.
          const code = d("data-code");
          if (!code || sentGrants.has(code)) return true;
          sentGrants.add(code);
          deps.repaintChat();
          const words = `allow ${code}`;
          if (!deps.sendPrompt) {
            deps.setComposerText(words);
            return true;
          }
          try {
            await deps.sendPrompt(words);
          } catch (err) {
            console.error("[amygdala-ui] allow send failed", err);
            sentGrants.delete(code);
            deps.setComposerText(words);
            deps.notify?.("Amygdala: the allow could not be sent; it is in the box, press send");
          }
          deps.repaintChat();
          return true;
        }
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
          const sentAt = Number(el.getAttribute("data-exchange-at") ?? Number.NaN);
          await rewindNewest({
            turnId: d("data-turn"),
            exchangeKey: el.getAttribute("data-exchange") ?? undefined,
            ...(Number.isFinite(sentAt) ? { exchangeAt: sentAt } : {}),
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
          const r = await rewindCall(turnId, false, ...namedNewest(el));
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
