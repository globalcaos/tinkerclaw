// Scored models we cannot route to, shown in the picker and the MODELS panel at their rank,
// in full colour under the red cross (2026-11-18; greyed before that) and unpickable. Hovering one
// opens a card saying why (nobody serves it yet, or which site to set it up on) with a link that
// stays clickable while the pointer moves onto it.
// The list itself is generated nightly: unroutable-models.generated.ts.
import { softHyphenate } from "./model-surface-catalog.js";
import {
  OPENROUTER_BALANCE_USD,
  OPENROUTER_CREDITS_URL,
  UNROUTABLE_MODELS,
  type UnroutableModel,
} from "./unroutable-models.generated.js";

export type { UnroutableModel };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LINK_LABEL: Record<UnroutableModel["reason"], string> = {
  "no-host": "Its Artificial Analysis page",
  openrouter: "Set it up on OpenRouter",
  deepinfra: "Set it up on DeepInfra",
  vendor: "Open the lab's console",
};

/** Smartest first. */
export function unroutableModels(): UnroutableModel[] {
  return [...UNROUTABLE_MODELS].sort((a, b) => b.score - a.score);
}

/** A configured OpenRouter model cannot route while the balance is zero or below. */
export function openRouterBlocked(modelId: string): boolean {
  return (
    modelId.startsWith("openrouter/") &&
    OPENROUTER_BALANCE_USD !== null &&
    OPENROUTER_BALANCE_USD <= 0
  );
}

export function openRouterBlockedNote(): string {
  return `Our OpenRouter balance is $${(OPENROUTER_BALANCE_USD ?? 0).toFixed(2)}: add credit to route it.`;
}

function cardAttrs(note: string, url: string, label: string, name: string): string {
  return (
    ` data-hover-name="${esc(name)}"` +
    ` data-unroutable-note="${esc(note)}" data-unroutable-url="${esc(url)}"` +
    ` data-unroutable-label="${esc(label)}" aria-disabled="true"`
  );
}

export function openRouterBlockedAttrs(name: string): string {
  return cardAttrs(
    openRouterBlockedNote(),
    OPENROUTER_CREDITS_URL,
    "Add credit on OpenRouter",
    name,
  );
}

/**
 * 2026-11-13 (the architect): every chip hovers with the same black card. It always names the model;
 * a note follows only when there is a direction to give (out of tokens, no route). A chip that
 * can be picked keeps its click: only [data-unroutable-note] swallows it.
 */
export function hoverNameAttrs(name: string, note = ""): string {
  return ` data-hover-name="${esc(name)}"` + (note ? ` data-hover-note="${esc(note)}"` : "");
}

/** Codename models ("Gemini 4 Argon", "Gemini 4 Hydrogen"): the version does not tell them apart. */
const NOT_A_CODENAME = /^(flash|pro|lite|preview|latest|mini|nano|max|turbo)$/i;
export function unroutableChipLabel(name: string): string {
  const m = /^Gemini [\d.]+ ([A-Za-z]+)$/.exec(name);
  return m && !NOT_A_CODENAME.test(m[1]) ? m[1] : name;
}

/** A model id the trace painter can colour: the supplier path when there is one. */
export function unroutableTraceId(m: UnroutableModel): string {
  const hosted = /(?:openrouter\.ai|deepinfra\.com)\/([^/?#]+\/[^/?#]+)/.exec(m.url);
  return hosted ? hosted[1] : `aa/${m.id.replace(/^aa:/, "")}`;
}

/**
 * Merge greyed entries into an already-sorted list by score. `scoreOf` gives each routed id's
 * score (undefined sorts it after every entry). Entries scoring below `floor` are left out.
 */
export function interleaveByScore<T>(
  ids: string[],
  scoreOf: (id: string) => number | undefined,
  entries: UnroutableModel[],
  floor: number,
): Array<{ id: string } | { entry: UnroutableModel }> {
  const pending = entries.filter((e) => e.score >= floor).sort((a, b) => b.score - a.score);
  const out: Array<{ id: string } | { entry: UnroutableModel }> = [];
  let p = 0;
  for (const id of ids) {
    const s = scoreOf(id);
    while (p < pending.length && s !== undefined && pending[p].score > s) {
      out.push({ entry: pending[p++] });
    }
    out.push({ id });
  }
  while (p < pending.length) {
    out.push({ entry: pending[p++] });
  }
  return out;
}

/** No route at all: the card says so and offers no link (2026-11-05). */
function entryAttrs(m: UnroutableModel): string {
  return m.reason === "no-host"
    ? cardAttrs(`No way to route it: ${m.note}`, "", "", m.name)
    : cardAttrs(m.note, m.url, LINK_LABEL[m.reason], m.name);
}

/** A MODELS-panel row: same columns as a routed row, greyed, with the hover card. */
export function renderUnroutableRow(m: UnroutableModel, trace = ""): string {
  return (
    `<div class="model-row model-row-unroutable"${entryAttrs(m)}>` +
    `<span class="model-name-col"><span class="model-name">${esc(m.name)}</span>` +
    `<span class="model-unroutable-tag">${m.reason === "no-host" ? "no host" : "not set up"}</span></span>` +
    `<span class="model-index-col" style="min-width:28px;text-align:right;font-size:9px;color:var(--muted);font-family:'SF Mono',monospace">${m.score.toFixed(1)}</span>` +
    trace +
    "</div>"
  );
}

/**
 * A picker chip: no data-model-idx, so the click handler can never pin it.
 * 2026-11-18 (the owner): in full colour with the red cross on top, the same mark as a spent token
 * window, never greyed; the hover card gives the exact version and how to make it usable.
 * `label` is the chip row's nickname for it (pickerChipLabels).
 */
export function renderUnroutableChip(m: UnroutableModel, trace = "", label?: string): string {
  return (
    `<button type="button" class="model-btn model-btn-unroutable model-btn-exhausted"${entryAttrs(m)}>` +
    trace +
    `<span class="model-btn-text">${esc(softHyphenate(label ?? unroutableChipLabel(m.name)))}</span></button>`
  );
}

let installed = false;

/** One card for the whole page; it stays open while the pointer is on the row or on the card. */
export function installUnroutableHoverCard(doc: Document = document): void {
  if (installed) return;
  installed = true;
  const card = doc.createElement("div");
  card.className = "unroutable-card";
  card.style.display = "none";
  doc.body.appendChild(card);
  let owner: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  };
  const hideSoon = () => {
    cancelHide();
    hideTimer = setTimeout(() => {
      card.style.display = "none";
      owner = null;
    }, 300);
  };
  const show = (el: HTMLElement) => {
    cancelHide();
    if (owner === el && card.style.display !== "none") return;
    owner = el;
    const name = el.dataset.hoverName ?? "";
    const note = el.dataset.unroutableNote ?? el.dataset.hoverNote ?? "";
    const url = el.dataset.unroutableUrl ?? "";
    const label = el.dataset.unroutableLabel ?? url;
    card.innerHTML =
      (name ? `<div class="unroutable-card-name">${esc(name)}</div>` : "") +
      (note ? `<div class="unroutable-card-note">${esc(note)}</div>` : "") +
      (url
        ? `<a class="unroutable-card-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
        : "");
    card.style.display = "block";
    const r = el.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const vw = doc.defaultView?.innerWidth ?? 1024;
    const vh = doc.defaultView?.innerHeight ?? 768;
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    let top = r.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };
  doc.addEventListener("mouseover", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (card.contains(t)) {
      cancelHide();
      return;
    }
    const el = t.closest<HTMLElement>("[data-hover-name], [data-unroutable-note]");
    if (el) show(el);
    else if (owner) hideSoon();
  });
  doc.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-unroutable-note]");
      if (el && !card.contains(e.target as Node)) {
        // Unpickable: the click only (re)opens the card, it never reaches the picker.
        e.preventDefault();
        e.stopPropagation();
        show(el);
      }
    },
    true,
  );
}
