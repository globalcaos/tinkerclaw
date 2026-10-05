/**
 * HTML-string builders for what the amygdala says inside the chat: hold / proof / ask cards, the sent-back chip, the
 * refusal strip and rewind marker, the exceptional-change card, the note chip on a tool row and the reply marker
 * (design doc §9.1, blocks 1-6). DOM-free: every builder returns a string, every dynamic value goes through `esc`, and
 * interactions are `data-amy-act` attributes that app.ts handles by delegation. A question's wording never appears,
 * only its name.
 */
import { DID_WORD, esc, fmtAnswer, fmtClock } from "./amygdala-html.js";
import type { ChangeView, InterventionView, JevDecision, MarkerView } from "./amygdala-types.js";

function chipsHtml(chips: string[], bad = false): string {
  if (!chips.length) return "";
  const cls = bad ? "amy-chip amy-bad" : "amy-chip";
  return `<div class="amy-chips">${chips.map((c) => `<span class="${cls}">${esc(c)}</span>`).join("")}</div>`;
}

function isOpen(iv: InterventionView): boolean {
  return iv.state === "open";
}

/** Block 2 left. Open: the full card. Closed: a one-line settled note. */
export function renderHoldCard(iv: InterventionView, o?: { showWhy?: boolean }): string {
  if (!isOpen(iv)) {
    return `<div class="amy-settled amy-settled-hold" data-iv="${esc(iv.id)}">✋ held · ${esc(iv.state)}</div>`;
  }
  const cmd = iv.cmd ? `<div class="amy-cmd">${esc(iv.cmd)}</div>` : "";
  const why = o?.showWhy
    ? `<div class="amy-why"><div class="amy-why-t">Why held</div><ul>${iv.chips.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`
    : "";
  const id = esc(iv.id);
  return (
    `<div class="amy-card amy-hold" data-iv="${id}">` +
    `<h3>✋ Held before it ran</h3>` +
    cmd +
    chipsHtml(iv.chips, true) +
    why +
    `<div class="amy-btns">` +
    `<button class="amy-btn amy-small amy-danger" data-amy-act="answer" data-iv="${id}" data-answer="allow-once">Allow once</button>` +
    `<button class="amy-btn amy-small amy-primary" data-amy-act="answer" data-iv="${id}" data-answer="keep-held">Keep held</button>` +
    `<button class="amy-btn amy-small" data-amy-act="why" data-iv="${id}">Why?</button>` +
    `</div>` +
    `<div class="amy-foot">The agent has been told why and is waiting.</div>` +
    `</div>`
  );
}

/** Block 2 right. Closed: one "released" line (or the settled state). */
export function renderProofCard(iv: InterventionView): string {
  const id = esc(iv.id);
  if (!isOpen(iv)) {
    const line = iv.state === "released" ? "✓ released" : `🔎 proof · ${esc(iv.state)}`;
    return `<div class="amy-settled amy-settled-proof" data-iv="${id}">${line}</div>`;
  }
  const cmd = iv.cmd ? `<div class="amy-cmd">${esc(iv.cmd)}</div>` : "";
  return (
    `<div class="amy-card amy-proof" data-iv="${id}">` +
    `<h3>🔎 Proof asked before it runs</h3>` +
    cmd +
    chipsHtml(iv.chips) +
    `<div class="amy-foot">The agent was asked to show evidence; this usually settles itself.</div>` +
    `</div>`
  );
}

/** Block 3. `selected` null means the first option (the likeliest reading). */
export function renderAskCard(iv: InterventionView, selected: string | null): string {
  const id = esc(iv.id);
  if (!isOpen(iv)) {
    return `<div class="amy-settled amy-settled-ask" data-iv="${id}">❓ ${esc(iv.title)} · ${esc(iv.state)}</div>`;
  }
  const options = iv.options ?? [];
  const title = `<h3>❓ ${esc(iv.title)}</h3>`;
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

/** Block 4. A plain <details>; "" when the turn has no sent-back decision. */
export function renderSentBackChip(
  decisions: JevDecision[],
  turnId: string,
  open: boolean,
): string {
  const sent = decisions.filter((d) => d.turnId === turnId && d.codeDid === "sent-back");
  if (!sent.length) return "";
  const times = Math.min(sent.length, 2) === 1 ? "once" : "twice";
  const last = sent[sent.length - 1]!;
  return (
    `<details class="amy-sentback" data-turn="${esc(turnId)}"${open ? " open" : ""}>` +
    `<summary>🔁 Sent back ${times} · ${esc(last.questionName)}</summary>` +
    `<div class="amy-sb-detail">Question that caught it: <i>${esc(last.questionName)}</i> · v${esc(last.version)}</div>` +
    `</details>`
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
): string {
  // "settled" is the same offer in shadow mode: the strip is the user's choice, not an enforcement (2026-09-30,
  // shadow mode never showed Rewind).
  if (!iv || (!isOpen(iv) && iv.state !== "settled")) return "";
  const t = esc(turnId);
  const rewind = canRewind
    ? `<button class="amy-btn amy-small" data-amy-act="rewind" data-turn="${t}">⟲ Rewind</button>`
    : rewindBlocked
      ? `<button class="amy-btn amy-small" disabled title="${esc(rewindBlocked)}">⟲ Rewind</button>`
      : "";
  const retryBtn =
    canRewind && retry
      ? `<button class="amy-btn amy-small amy-retry" data-amy-act="rewind-retry" data-turn="${t}"${retry.reason ? ` title="${esc(retry.reason)}"` : ""}>` +
        `⟲ Rewind and retry with ${retry.chipHtml}<span class="amy-retry-name">${esc(retry.label)}</span></button>`
      : "";
  return (
    `<div class="amy-refstrip" data-turn="${t}"><span>🧠</span><span class="amy-t">This looks like a refusal</span>` +
    rewind +
    retryBtn +
    `<button class="amy-btn amy-small" data-amy-act="refusal-keep" data-turn="${t}">Keep</button>` +
    `<span class="amy-m">logged for the router</span></div>`
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

function noteKind(questionId: string): { cls: string; icon: string } {
  if (questionId === "progress-made") return { cls: "amy-nc-f", icon: "🔄" };
  if (questionId === "novelty" || questionId === "worth-knowing")
    return { cls: "amy-nc-c", icon: "💡" };
  return { cls: "amy-nc-s", icon: "⚡" };
}

/** Block 5: rides on a tool row. The title says what code did; 👍/👎 live in the title only. */
export function renderNoteChip(d: JevDecision): string {
  const { cls, icon } = noteKind(d.questionId);
  const title = `code: ${DID_WORD[d.codeDid]} · 👍 / 👎 on the opened line in the Jev window`;
  return `<span class="amy-note-chip ${cls}" title="${esc(title)}" data-decision="${esc(d.id)}">${icon} ${esc(d.questionName)} ${esc(fmtAnswer(d))}</span>`;
}

/** One-line marker under a reply. */
export function renderMarker(m: MarkerView): string {
  const items = m.items.map((i) => esc(i)).join(", ");
  const text =
    m.kind === "unsupported-after-two"
      ? `still unsupported after two attempts: ${items}`
      : `refusal rewound${items ? `: ${items}` : ""}`;
  return `<div class="amy-marker" data-turn="${esc(m.turnId)}">${text}</div>`;
}
