/**
 * HTML-string builders for what the amygdala says inside the chat besides the two Jev windows: the hold / proof / ask
 * cards that wait for an answer (enforce mode), the refusal offer and the Rewound line (all three ride on their action's
 * row in the WOULD HAVE window, amygdala-jev.ts), the reply marker, and the exceptional-change card at the end of the
 * chat (design doc §9.1, blocks 1-6). DOM-free: every builder returns a string, every dynamic value goes through `esc`,
 * and interactions are `data-amy-act` attributes that app.ts handles by delegation. A question's wording never appears,
 * only its name.
 */
import { esc, fmtClock } from "./amygdala-html.js";
import type { ChangeView, InterventionView, MarkerView } from "./amygdala-types.js";

/** What a closed card says happened to its question. */
const SETTLED_WORD: Record<string, string> = {
  released: "allowed",
  denied: "kept held",
  expired: "no answer",
  settled: "settled",
};

/** The question an Allow answers: the gateway's, or the plainest one an older gateway leaves room for. */
export function askOf(iv: InterventionView): string {
  return iv.ask ?? "Allow this step?";
}

function isOpen(iv: InterventionView): boolean {
  return iv.state === "open";
}

/**
 * Block 2 (FORK 2026-11-03): one question and its two answers, the hand as the mark. The plain sentence rides on hover;
 * the rule and why it fired sit folded in the bubble above. Closed: the question and what became of it.
 */
export function renderHoldCard(iv: InterventionView): string {
  const id = esc(iv.id);
  const q = esc(askOf(iv));
  if (!isOpen(iv)) {
    return `<div class="amy-settled amy-settled-hold" data-iv="${id}">✋ ${q} · ${esc(SETTLED_WORD[iv.state] ?? iv.state)}</div>`;
  }
  const tip = iv.sentence ? ` title="${esc(iv.sentence)}"` : "";
  return (
    `<div class="amy-card amy-hold amy-q" data-iv="${id}"${tip}>` +
    `<span class="amy-q-icon">✋</span><span class="amy-q-text">${q}</span>` +
    `<button class="amy-btn amy-small amy-primary" data-amy-act="answer" data-iv="${id}" data-answer="allow-once">Allow</button>` +
    `<button class="amy-btn amy-small" data-amy-act="answer" data-iv="${id}" data-answer="keep-held">No</button>` +
    `</div>`
  );
}

/** A change other people can see, from the gateway's effect judge (amygdala2.effect, FORK 2026-11-08). */
export interface EffectView {
  id: string;
  sessionKey: string;
  turnId: string;
  ts: number;
  what: string;
  where: string;
  week: number;
  lifetime: number;
  revert: string | null;
  state: "live" | "reverting" | "reverted" | "revert-failed";
  output?: string;
}

const people = (n: number): string => `${n.toLocaleString("en")} ${n === 1 ? "person" : "people"}`;

/**
 * FORK 2026-11-08: one yellow card per change that reaches someone other than the owner: what changed and where, how
 * many people see it in the next week and over its lifetime, and Revert. The undo command rides on the button's hover.
 */
export function renderEffectCards(effects: readonly EffectView[]): string {
  if (!effects.length) return "";
  return effects
    .map((e) => {
      const id = esc(e.id);
      let btn: string;
      if (e.state === "reverted") btn = `<span class="amy-effect-done">Reverted ✓</span>`;
      else if (e.state === "reverting")
        btn = `<button class="amy-btn amy-small" disabled>Reverting…</button>`;
      else if (!e.revert)
        btn = `<span class="amy-effect-done" title="This change cannot be undone">Can't undo</span>`;
      else
        btn =
          `<button class="amy-btn amy-small amy-effect-revert" data-amy-act="effect-revert" data-effect="${id}" ` +
          `title="${esc(e.revert)}">${e.state === "revert-failed" ? "Retry revert" : "Revert"}</button>`;
      const failed =
        e.state === "revert-failed"
          ? `<div class="amy-effect-fail" title="${esc(e.output ?? "")}">The revert failed. Hover for its output.</div>`
          : "";
      return (
        `<div class="amy-effect${e.state === "reverted" ? " amy-effect-reverted" : ""}" data-effect-card="${id}">` +
        `<div class="amy-effect-main"><span class="amy-effect-icon">👥</span>` +
        `<span class="amy-effect-what">${esc(e.what)}</span>` +
        (e.where ? `<span class="amy-effect-where">${esc(e.where)}</span>` : "") +
        `</div><div class="amy-effect-reach">` +
        `<span title="People likely to see it in the next 7 days">${esc(people(e.week))} this week</span>` +
        `<span class="amy-effect-sep">·</span>` +
        `<span title="People likely to see it over its whole lifetime if it stays">${esc(people(e.lifetime))} lifetime</span>` +
        `${btn}</div>${failed}</div>`
      );
    })
    .join("");
}

/** One step waiting for the owner's OK, as the Allow bar under a reply lists it. */
export interface AllowItem {
  /** What "allow <code>" releases: an AEGIS grant or a proof hold's code. */
  code: string;
  /** The question the button answers, e.g. "Allow publishing to the web?". */
  ask: string;
  /** The held step in plain words, shown on hover: the tool row's sentence or the gateway's, never a command. */
  what: string;
}

const ALLOW_WHAT_MAX = 200;

/**
 * FORK 2026-10-29: confirming a held step by copying a code into the chat was slow; a button at the end of the
 * response replaces it, and sends "allow <code>" as his own prompt. FORK 2026-11-03: each step is one line, the hand, a
 * specific question and the button; the explanation lines went. "" when nothing waits.
 */
export function renderAllowBar(items: readonly AllowItem[], sent: ReadonlySet<string>): string {
  if (!items.length) return "";
  const rows = items
    .map((it) => {
      const done = sent.has(it.code);
      const what =
        it.what.length > ALLOW_WHAT_MAX ? `${it.what.slice(0, ALLOW_WHAT_MAX - 1)}…` : it.what;
      return (
        `<div class="amy-allow-row" title="${esc(what)}"><span class="amy-allow-icon">✋</span>` +
        `<span class="amy-allow-what">${esc(it.ask)}</span>` +
        `<button class="amy-btn amy-small ${done ? "" : "amy-primary"}" data-amy-act="allow-grant" data-code="${esc(it.code)}"${done ? " disabled" : ""}>${done ? "Allowed ✓" : "Allow"}</button></div>`
      );
    })
    .join("");
  return `<div class="amy-allow">${rows}</div>`;
}

/** Block 3. `selected` null means the first option (the likeliest reading). */
export function renderAskCard(iv: InterventionView, selected: string | null): string {
  const id = esc(iv.id);
  if (!isOpen(iv)) {
    return `<div class="amy-settled amy-settled-ask" data-iv="${id}">❓ ${esc(iv.title)} · ${esc(iv.state)}</div>`;
  }
  const options = iv.options ?? [];
  const plain = iv.sentence ? `<div class="amy-plain">${esc(iv.sentence)}</div>` : "";
  const title = `<h3>❓ ${esc(iv.title)}</h3>${plain}`;
  if (!options.length) {
    return `<div class="amy-card amy-ask" data-iv="${id}">${title}</div>`;
  }
  const sel =
    selected !== null && options.some((op) => op.id === selected) ? selected : options[0]!.id;
  const rows = options
    .map((op) => {
      const on = op.id === sel;
      const hint = op.hint ? `<small>${esc(op.hint)}</small>` : "";
      return (
        `<div class="amy-opt${on ? " amy-sel" : ""}" data-amy-act="ask-select" data-iv="${id}" data-option="${esc(op.id)}">` +
        `<input type="radio" name="amy-ask-${id}"${on ? " checked" : ""} tabindex="-1" aria-hidden="true">` +
        `<div>${esc(op.label)}${hint}</div></div>`
      );
    })
    .join("");
  return (
    `<div class="amy-card amy-ask" data-iv="${id}">` +
    title +
    rows +
    `<div class="amy-btns">` +
    `<button class="amy-btn amy-small amy-primary" data-amy-act="ask-confirm" data-iv="${id}">Send</button>` +
    `</div>` +
    `<div class="amy-foot">Asked because the readings lead to different actions.</div>` +
    `</div>`
  );
}

/** Block 1. "" when there is no open intervention to act on. */
export function renderRefusalStrip(
  turnId: string,
  iv: InterventionView | undefined,
  canRewind: boolean,
  /** Why Rewind is greyed out (an older exchange); omitted = no button at all. */
  rewindBlocked?: string,
  /**
   * Thalamus's pick for a retry (full deploy, 2026-10-02): the model from another vendor that would take the prompt. The
   * second button names it, with the model's vendor logo, the mark the models panel draws (`chipHtml` is that trusted markup).
   * Absent or null: only Rewind, because nothing may be offered that Thalamus has no pick for.
   */
  retry?: { label: string; chipHtml: string; reason?: string } | null,
  /**
   * FORK 2026-10-22: the exchange (the owner's prompt row and what answered it) this strip sits under. A click is refused
   * when that exchange is no longer the newest one on the page, so a strip that went stale cannot rewind a newer turn.
   */
  exchangeKey?: string | null,
  /** Exchanges a Rewind takes from this one on (2026-10-22); above 1 the button says so and no retry is offered. */
  rewindCount = 1,
  /**
   * FORK 2026-11-13: when that exchange's prompt row was sent (ms). The key is a hash of the words, so two prompts
   * with the same words share it; the time says which of them this strip sits under.
   */
  exchangeAt?: number,
): string {
  // "settled" is the same offer in shadow mode: the strip is the user's choice, not an enforcement (2026-09-30,
  // shadow mode never showed Rewind).
  if (!iv || (!isOpen(iv) && iv.state !== "settled")) return "";
  const t = esc(turnId);
  const ex =
    (exchangeKey ? ` data-exchange="${esc(exchangeKey)}"` : "") +
    (exchangeKey && exchangeAt !== undefined && Number.isFinite(exchangeAt)
      ? ` data-exchange-at="${String(Math.round(exchangeAt))}"`
      : "");
  const many = rewindCount > 1;
  const rewind = canRewind
    ? `<button class="amy-btn amy-small" data-amy-act="rewind" data-turn="${t}"${ex}` +
      (many
        ? ` title="This exchange and the ${rewindCount - 1} after it leave the chat and the model's memory">⟲ Rewind ${rewindCount} exchanges</button>`
        : `>⟲ Rewind</button>`)
    : rewindBlocked
      ? `<button class="amy-btn amy-small" disabled title="${esc(rewindBlocked)}">⟲ Rewind</button>`
      : "";
  const retryBtn =
    canRewind && retry && !many
      ? `<button class="amy-btn amy-small amy-retry" data-amy-act="rewind-retry" data-turn="${t}"${ex}${retry.reason ? ` title="${esc(retry.reason)}"` : ""}>` +
        `⟲ Rewind and retry with ${retry.chipHtml}<span class="amy-retry-name">${esc(retry.label)}</span></button>`
      : "";
  return (
    // FORK 2026-11-03: the strip rides in its bubble, whose line already says what Jev saw: buttons only.
    `<div class="amy-refstrip" data-turn="${t}">` +
    rewind +
    retryBtn +
    `<button class="amy-btn amy-small" data-amy-act="refusal-keep" data-turn="${t}">Keep</button></div>`
  );
}

/** The line that stands where a rewound exchange was. Undo only while it is still the newest thing on the page. */
export function renderExchangeRewound(
  key: string,
  info: { ts: number; restored?: string; count?: number },
  canUndo: boolean,
): string {
  const k = esc(key);
  const title = info.restored ? ` title="${esc(info.restored)}"` : "";
  const n = Math.max(1, info.count ?? 1);
  return (
    `<div class="amy-rewound" data-exchange="${k}"${title}>⟲ Rewound ${n === 1 ? "1 exchange" : `${n} exchanges`} · ${esc(fmtClock(info.ts))} · the model no longer sees it` +
    (canUndo
      ? ` · <a href="#" role="button" data-amy-act="rewind-exchange-undo" data-exchange="${k}">Undo</a>`
      : "") +
    `</div>`
  );
}

export function renderRewoundMarker(
  turnId: string,
  info: { ts: number; restoredPrompt?: string },
): string {
  const t = esc(turnId);
  const title = info.restoredPrompt ? ` title="${esc(info.restoredPrompt)}"` : "";
  return (
    `<div class="amy-rewound" data-turn="${t}"${title}>⟲ Rewound 1 exchange · ${esc(fmtClock(info.ts))} · the model no longer sees it · ` +
    `<a href="#" role="button" data-amy-act="rewind-undo" data-turn="${t}">Undo</a></div>`
  );
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Block 6. Buttons only while pending; a decided change is a card with a status line. */
export function renderExceptionalCard(c: ChangeView, expanded: boolean): string {
  const id = esc(c.id);
  const r = c.replaySummary;
  const chips =
    `<div class="amy-chips">` +
    `<span class="amy-chip">${esc(r.relaxed)} of ${esc(r.cases)} cases now proceed</span>` +
    `<span class="amy-chip${r.mustCatchLost > 0 ? " amy-bad" : ""}">${esc(r.mustCatchLost)} must-catch lost</span>` +
    `<span class="amy-chip${r.controlsNewlyHeld > 0 ? " amy-bad" : ""}">${esc(r.controlsNewlyHeld)} controls newly held</span>` +
    `</div>`;
  const cases = expanded
    ? `<div class="amy-cases">Replayed ${esc(r.cases)} cases: ${esc(r.relaxed)} relaxed, ${esc(r.tightened)} tightened, ${esc(r.mustCatchLost)} must-catch lost, ${esc(r.controlsNewlyHeld)} controls newly held.</div>`
    : "";
  let actions: string;
  if (c.status === "pending") {
    actions =
      `<div class="amy-btns">` +
      `<button class="amy-btn amy-small amy-primary" data-amy-act="approve" data-change="${id}" data-yes="1">Approve</button>` +
      `<button class="amy-btn amy-small" data-amy-act="approve" data-change="${id}" data-yes="0">Reject</button>` +
      `<button class="amy-btn amy-small" data-amy-act="see-cases" data-change="${id}">See the cases</button>` +
      `</div>`;
  } else {
    actions = `<div class="amy-foot amy-status">${esc(c.status)}</div>`;
  }
  return (
    `<div class="amy-card amy-appr" data-change="${id}">` +
    `<div class="amy-tag">Exceptional · needs you</div>` +
    `<h3>${esc(c.questionName)} · ${esc(c.kind)}</h3>` +
    `<div class="amy-fromto"><span>${esc(fmtValue(c.from))}</span> → <span>${esc(fmtValue(c.to))}</span></div>` +
    chips +
    cases +
    actions +
    `</div>`
  );
}

/** One-line marker under a reply. */
export function renderMarker(m: MarkerView): string {
  const items = m.items.map((i) => esc(i)).join(", ");
  const text =
    m.kind === "unsupported-after-two"
      ? `still unsupported after one send-back: ${items}`
      : m.kind === "defect-reported"
        ? `the agent says a check is wrong: ${items}`
        : `refusal rewound${items ? `: ${items}` : ""}`;
  return `<div class="amy-marker" data-turn="${esc(m.turnId)}">${text}</div>`;
}
