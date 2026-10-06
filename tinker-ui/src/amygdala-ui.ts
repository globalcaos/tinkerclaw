import {
  renderAskCard,
  renderExceptionalCard,
  renderHoldCard,
  renderProofCard,
  renderRefusalStrip,
  renderRewoundMarker,
} from "./amygdala-cards.js";
/**
 * The amygdala UI's glue (design doc §9): one object that owns the client store and turns it into the three things app.ts
 * hooks in — HTML drawn after each reply in the chat (the two Jev windows, CHECKS and WOULD HAVE; the architect 2026-10-05), the
 * panel body and the composer dot — plus the click handling for every `data-amy-act` the builders emit.
 *
 * INERT UNLESS THE GATEWAY HAS THE METHODS: `onConnected` asks `amygdala2.status`; an unknown-method error (the plugin is
 * off, or this is a gateway from before it) leaves `available` false and every hook returns "" so today's v3.1 panel and
 * chat are untouched. Nothing here talks to a gateway except through the injected `req`.
 */
import { esc } from "./amygdala-html.js";
import {
  actionDecisionId,
  type JevAction,
  renderJevActions,
  renderJevChecks,
  renderJevNotConsulted,
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
  /** HTML to draw after the reply to `userMsg` (the run that ends at `nextUserMsg`, null for the last run). */
  afterRun(userMsg: unknown, nextUserMsg: unknown): string;
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
  // Interactive state that is not data: which windows/rows/expanders are open, which ask option is selected. A reply's
  // two windows are keyed by its first turn id (the run key).
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
  /** Steps the judge did not answer: turnId → why. A turn with answers draws its window; one without draws "not consulted". */
  const consult = new Map<
    string,
    { sessionKey: string; ts: number; state: "real-steps-stay-local" | "judge-down" }
  >();
  /** Thalamus's retry pick per refused turn; null = asked, nothing to offer. Filled by the event or by one question. */
  const retryByTurn = new Map<string, RetryPickView | null>();
  const retryAsked = new Set<string>();
  let canaryText = "";
  store.subscribe(() => {
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
  ): Promise<Record<string, unknown> | null> {
    const extra = undo ? { undo: true } : {};
    try {
      let r = await deps.req<Record<string, unknown>>("amygdala2.rewind", {
        sessionKey: deps.tabKey(),
        turnId,
        ...extra,
      });
      if (r && r.ok !== true && r.capability === "unsupported") {
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
    if (iv.kind !== "refusal") return "";
    if (t.rewound) return renderRewoundMarker(t.turnId, t.rewound);
    if (t.refusalKept) return "";
    // Rewind always removes the tab's LAST exchange, so only the newest un-rewound turn may offer it.
    const newest = t.turnId === newestLiveTurnId();
    if (newest && !retryByTurn.has(t.turnId)) askRetry(t.turnId);
    const pick = newest ? retryByTurn.get(t.turnId) : null;
    return renderRefusalStrip(
      t.turnId,
      iv,
      newest,
      newest ? undefined : "Rewind the newer exchange first: Rewind always removes the last one",
      pick
        ? {
            label: deps.modelLabel?.(pick.model) ?? pick.model,
            chipHtml: deps.modelChip?.(pick.model) ?? "",
            reason: pick.reason,
          }
        : null,
    );
  }

  /**
   * One reply's Jev: the CHECKS window (or its "not consulted" line) and the WOULD HAVE window, keyed by the reply's first
   * turn. `consults` are this reply's steps the judge was not asked about that have no answers of their own.
   */
  function runHtml(
    turns: TurnView[],
    consults: { turnId: string; state: "real-steps-stay-local" | "judge-down" }[],
  ): string {
    const key = turns[0]?.turnId ?? consults[0]?.turnId;
    if (!key) return "";
    const decisions = turns.flatMap((t) => t.decisions);
    const parts: string[] = [];
    if (decisions.length > 0) {
      parts.push(
        renderJevChecks(key, decisions, {
          open: openWindows.has(key),
          col: selectedCol.get(key),
          openRows,
          rulesOnly: consults.length,
        }),
      );
    } else if (consults.length > 0) {
      parts.push(renderJevNotConsulted(key, consults[consults.length - 1]!.state));
    }
    const byId = new Map(turns.map((t) => [t.turnId, t]));
    // A card that waits for an answer keeps the window open even if the owner folded it.
    const waiting = turns.some((t) => t.interventions.some((i) => i.state === "open"));
    const acts = renderJevActions(key, turns, {
      open: waiting || openActions.has(key),
      votes,
      shadow: store.state.status?.mode !== "enforce",
      extra: (a) => actionExtra(a, byId.get(a.turnId)),
      explain: (a) => {
        const id = actionDecisionId(a);
        return id ? store.explanation(id) : undefined;
      },
      openDetails,
    });
    if (acts) parts.push(acts);
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

  /** This tab's steps in this run the judge was not asked about, that have no turn of their own in the store. */
  function consultsForRun(
    userMsg: unknown,
    nextUserMsg: unknown,
  ): { turnId: string; state: "real-steps-stay-local" | "judge-down" }[] {
    const from = rowTime(userMsg);
    const to = rowTime(nextUserMsg);
    const out: { turnId: string; state: "real-steps-stay-local" | "judge-down" }[] = [];
    for (const [turnId, c] of consult) {
      if (c.sessionKey !== deps.tabKey() || store.turn(turnId)) continue;
      if (
        from === undefined
          ? nextUserMsg === null || nextUserMsg === undefined
          : inRun(c.ts, from, to)
      ) {
        out.push({ turnId, state: c.state });
      }
    }
    return out;
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
      if (name === "amygdala2.consult") {
        const p = payload as { turnId?: unknown; state?: unknown };
        const sk = (payload as { sessionKey?: unknown }).sessionKey;
        const ts = (payload as { ts?: unknown }).ts;
        if (
          typeof p.turnId === "string" &&
          typeof sk === "string" &&
          typeof ts === "number" &&
          (p.state === "real-steps-stay-local" || p.state === "judge-down")
        ) {
          consult.set(p.turnId, { sessionKey: sk, ts, state: p.state });
          if (consult.size > 200) consult.delete(consult.keys().next().value as string);
          deps.repaintChat();
        }
        return;
      }
      if (!name.startsWith("amygdala2.")) return;
      if (store.state.available === null && name === "amygdala2.status") store.setAvailable(true);
      store.applyEvent(name, payload);
    },

    onConnected: probe,

    afterRun(userMsg, nextUserMsg) {
      if (!available()) return "";
      return runHtml(turnsForRun(userMsg, nextUserMsg), consultsForRun(userMsg, nextUserMsg));
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
          const turnId = d("data-turn");
          const r = await rewindCall(turnId, false);
          if (r && r.ok === true) {
            const prompt = typeof r.restoredPrompt === "string" ? r.restoredPrompt : undefined;
            store.markRewound(turnId, {
              restoredPrompt: prompt,
              forkSessionId: typeof r.forkSessionId === "string" ? r.forkSessionId : undefined,
              ts: now(),
            });
            if (prompt) deps.setComposerText(prompt);
          } else if (r) {
            deps.notify?.(
              `Amygdala: rewind is not available here (${String(r.reason ?? r.capability ?? "unsupported")})`,
            );
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
