/**
 * Keyed rendering of the chat window (plan task 9, bible §5.8W's window, rendered).
 *
 * `updateChat` used to assign the whole transcript's HTML with `innerHTML` on every repaint —
 * every streaming delta rebuilt, re-parsed and re-laid-out every row, restarted every animation,
 * dropped the text selection and reset every `<details>` nobody had keyed. `renderChatInto` keeps
 * one set of top-level nodes per unit key and, on each pass:
 *
 *   - REUSES a unit's nodes when its HTML string is identical to the one they were parsed from
 *     and they are still children of the container;
 *   - PARSES only units that are new or whose HTML changed (a delta changes the live bubble; an
 *     older page adds units above; a finished run swaps its rows for one Reasoning group);
 *   - REMOVES every top-level node no unit wants — rows that left, stale renders, and anything a
 *     different writer put at the top level (the innerHTML assignment removed those too);
 *   - ORDERS the result with the fewest moves.
 *
 * Reuse is decided by comparing the HTML, never by guessing what a change could touch: a row's
 * markup can depend on OTHER rows (a tool call shows its paired result; user bubbles carry their
 * position), so "only the live run changed" is not something the renderer may assume.
 *
 * The one post-render pass that moves a node from one unit into another — a reflection's timing
 * block grafted into its 🌿 section — goes through `graftChatNode`, which records the move so the
 * next pass can undo it before comparing. Without that, a reused unit would be missing a child its
 * HTML still names, and a re-rendered section would drop a block the pass had already moved.
 */

type Rendered = { html: string; nodes: ChildNode[] };
type Graft = { node: ChildNode; parent: Node; next: Node | null };

const renderedBy = new WeakMap<Element, Map<string, Rendered>>();
/** Top-level node → the key of the unit that owns it (chat-viewport.ts names rows by it). */
const keyOfNode = new WeakMap<Node, string>();
const graftsBy = new WeakMap<Element, Graft[]>();
/** Top-level nodes whose subtree no longer matches their HTML (an undo that could not be exact). */
const staleNodes = new WeakSet<Node>();

export type ChatRenderOptions<T> = {
  rowKey: (row: T, index: number) => string;
  rowHtml: (row: T, index: number) => string;
};

/**
 * Render `rows` into `el`, keyed. The container's `innerHTML` afterwards equals the joined HTML of
 * every row, exactly as `el.innerHTML = rows.map(rowHtml).join("")` would leave it, provided each
 * row's HTML is balanced (it is parsed on its own, in a scratch element of the container's type).
 *
 * Returns the top-level nodes this pass created — the only ones that need listeners bound.
 */
export function renderChatInto<T>(
  el: HTMLElement,
  rows: readonly T[],
  opts: ChatRenderOptions<T>,
): ChildNode[] {
  undoGrafts(el);
  const prev = renderedBy.get(el) ?? new Map<string, Rendered>();
  const next = new Map<string, Rendered>();
  const want: ChildNode[] = [];
  const created: ChildNode[] = [];
  const seen = new Map<string, number>();
  let scratch: Element | null = null;
  for (let i = 0; i < rows.length; i++) {
    // A key repeated in one pass (the same transcript row painted twice) still gets its own unit.
    const base = opts.rowKey(rows[i], i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    const html = opts.rowHtml(rows[i], i);
    const old = prev.get(key);
    let nodes: ChildNode[];
    if (
      old &&
      old.html === html &&
      old.nodes.every((node) => node.parentNode === el && !staleNodes.has(node))
    ) {
      nodes = old.nodes;
    } else {
      scratch ??= el.ownerDocument.createElement(el.localName);
      nodes = parseUnit(scratch, html);
      created.push(...nodes);
    }
    next.set(key, { html, nodes });
    for (const node of nodes) {
      keyOfNode.set(node, key);
    }
    want.push(...nodes);
  }
  const keep = new Set<Node>(want);
  for (const child of Array.from(el.childNodes)) {
    if (!keep.has(child)) {
      el.removeChild(child);
    }
  }
  let cursor: ChildNode | null = el.firstChild;
  for (const node of want) {
    if (node === cursor) {
      cursor = node.nextSibling;
    } else {
      el.insertBefore(node, cursor);
    }
  }
  renderedBy.set(el, next);
  return created;
}

/**
 * FORK 2026-10-02 (chat-viewport.ts) — the key of the unit that owns `node`, a top-level child of a
 * rendered container; null for a node no unit owns (an inline viewer inserted between rows). The
 * scroll anchor names the first row on screen by this, because a row the page watched being
 * written carries no transcript id. Keys like `u:<_uid>` are minted per page load: in-session only.
 */
export function unitKeyOf(node: Node): string | null {
  return keyOfNode.get(node) ?? null;
}

/** The first element of unit `key` as `el` shows it now, or null when no such unit is on it. */
export function unitElement(el: Element, key: string): Element | null {
  const nodes = renderedBy.get(el)?.get(key)?.nodes ?? [];
  for (const node of nodes) {
    if (node.nodeType === 1 && node.parentNode === el) {
      return node as Element;
    }
  }
  return null;
}

function parseUnit(scratch: Element, html: string): ChildNode[] {
  if (!html) {
    return [];
  }
  if (import.meta.env.DEV) {
    assertBalancedUnit(scratch, html);
  }
  scratch.innerHTML = html;
  const nodes = Array.from(scratch.childNodes);
  for (const node of nodes) {
    scratch.removeChild(node);
  }
  return nodes;
}

/**
 * FORK 2026-09-24 (task 9 review minor) — after a keyed pass: an inline file viewer
 * (`.file-viewer-inline`) is inserted at the TOP level after its row, so the pass removes it (no
 * unit names it) while it REUSES the row, whose `.sys-file-link` keeps `file-viewer-open` — styled
 * as open with nothing open. The full innerHTML rebuild dropped both. With no viewer on the page,
 * no link is open. Returns how many links were cleared.
 */
export function clearOrphanedViewerOpen(el: Element): number {
  if (el.querySelector(".file-viewer-inline") !== null) {
    return 0;
  }
  const open = el.querySelectorAll(".sys-file-link.file-viewer-open");
  open.forEach((link) => link.classList.remove("file-viewer-open"));
  return open.length;
}

/**
 * FORK 2026-09-24 (task 9 review minor) — dev and test builds only (`import.meta.env.DEV`; a
 * production vite build drops the call): the precondition parseUnit relies on. A unit parsed alone
 * equals its part of the whole-pane parse only if it closes everything it opens — otherwise the
 * pane's next unit would have been nested into it, or closed it. Probed with a sentinel element
 * after the unit: balanced exactly when the sentinel lands as the scratch's last child, empty.
 * Not `scratch.innerHTML === html`: the serializer rewrites balanced markup (`&quot;` in text,
 * `<details open>` -> `open=""`, `<br/>` -> `<br>`), so that comparison rejects valid units.
 */
function assertBalancedUnit(scratch: Element, html: string): void {
  scratch.innerHTML = `${html}<b data-oc-unit-end></b>`;
  const last = scratch.lastChild;
  const balanced =
    last instanceof Element &&
    last.hasAttribute("data-oc-unit-end") &&
    last.childNodes.length === 0 &&
    scratch.querySelectorAll("[data-oc-unit-end]").length === 1;
  scratch.innerHTML = "";
  if (!balanced) {
    throw new Error(`chat unit HTML is not balanced: ${html.slice(0, 160)}`);
  }
}

/** Elements matching `selector` among `nodes` (the ones a pass created) and their descendants. */
export function freshElements(nodes: readonly ChildNode[], selector: string): Element[] {
  const out: Element[] = [];
  for (const node of nodes) {
    if (node.nodeType !== 1) {
      continue;
    }
    const elem = node as Element;
    if (elem.matches(selector)) {
      out.push(elem);
    }
    out.push(...Array.from(elem.querySelectorAll(selector)));
  }
  return out;
}

/**
 * Move `node` to the end of `into`, recording where it was so the next `renderChatInto` over `el`
 * puts it back first. Every cross-unit move a post-render pass makes must go through here.
 */
export function graftChatNode(el: Element, node: ChildNode, into: Node): void {
  const parent = node.parentNode;
  if (parent) {
    let list = graftsBy.get(el);
    if (!list) {
      list = [];
      graftsBy.set(el, list);
    }
    list.push({ node, parent, next: node.nextSibling });
  }
  into.appendChild(node);
}

/** Newest first, so a node moved twice lands where it started and siblings keep their order. */
function undoGrafts(el: Element): void {
  const list = graftsBy.get(el);
  if (!list || list.length === 0) {
    return;
  }
  graftsBy.set(el, []);
  for (let k = list.length - 1; k >= 0; k--) {
    const { node, parent, next } = list[k];
    if (next === null || next.parentNode === parent) {
      parent.insertBefore(node, next);
      continue;
    }
    // The anchor moved away, so the origin cannot be restored exactly: re-render both units.
    markStale(el, parent);
    markStale(el, node);
  }
}

function markStale(el: Element, node: Node): void {
  let top: Node | null = node;
  while (top && top.parentNode !== el) {
    top = top.parentNode;
  }
  if (top) {
    staleNodes.add(top);
  }
}

/**
 * FORK 2026-08-24 (the architect: "The timings of the fractal pass should show only when expanding
 * Fractal") — move a reflection's timing block INTO its 🌿 section. Moved here from app.ts
 * `graftReflectionTimingBlocks` (plan task 9) so the move is recorded (graftChatNode) and undone
 * before the next keyed pass.
 *
 * Grafted rather than rendered in place for the reason the level-3 expander is: the section is the
 * run's BOUNDARY message, emitted after the run's own contents, so at string-build time there is
 * nothing to nest into yet.
 *
 * Runs after every chat render. Needs no latch: the next render first puts every moved block back
 * where its unit's HTML has it, so each pass grafts from the layout as rendered.
 */
export function graftTimingBlocks(container: HTMLElement): void {
  // Snapshotted BEFORE anything moves: each graft resolves against the layout as rendered, so an
  // earlier move cannot change which section a later block lands in.
  const grafts = Array.from(container.querySelectorAll<HTMLElement>("[data-phase-graft-into]"));
  const sections = Array.from(container.querySelectorAll<HTMLElement>("details.fractal-details"));
  grafts.forEach((graft) => {
    const uid = graft.dataset.phaseGraftInto ?? "";
    const escaped = uid.replace(/["\\]/g, "\\$&");
    const details = uid
      ? container.querySelector<HTMLElement>(
          `details.fractal-details[data-fractal-uid="${escaped}"]`,
        )
      : // No uid: the block was tagged by runId while its own 🌿 section had not been emitted
        // yet, so the section it belongs to is simply the next one in the transcript.
        (sections.find(
          (d) =>
            (graft.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
            !d.contains(graft),
        ) ?? null);
    if (!details) {
      // No section to nest into — the reflection rendered as a plain bubble, or a reloaded
      // history carries no fractal markup for it. LEAVE THE BLOCK WHERE IT IS, visible: hiding a
      // measurement because its preferred mount is missing turns a feature into a disappearance,
      // which is the failure this area has produced twice already.
      graft.classList.add("is-unnested");
      return;
    }
    graft.classList.remove("is-unnested");
    graftChatNode(
      container,
      graft,
      details.querySelector<HTMLElement>(".msg-fractal, .msg.assistant") ?? details,
    );
  });
}
