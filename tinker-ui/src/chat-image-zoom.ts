/**
 * Zoom controls for large images in the chat (the architect, 2026-10-13: "when you put images so big like
 * this, they should have a zoom in-out control at the bottom-left, so I can actually see them").
 *
 * Every chat image at least MIN_NATURAL_WIDTH px wide, drawn at least MIN_SHOWN_WIDTH px, gets a bar at
 * its bottom-left (smaller thumbnails open the full-screen viewer on click instead):
 *   −  / +   zoom the image in place, inside a frame of fixed size (drag to pan; the chat never moves);
 *   ⤢        open a full-screen viewer (wheel to zoom, drag to pan, Esc or click outside to close).
 * The bar floats over the image, so wrapping changes no height until the owner zooms; the viewer
 * loads the full-resolution file when the image is a link to one (the 1/3 chat copy convention).
 */

const MIN_NATURAL_WIDTH = 600;
/** Drawn narrower than this, an image is a thumbnail: click opens the viewer, no bar on top. */
const MIN_SHOWN_WIDTH = 320;
const STEP = 1.25;
const MAX_SCALE = 8;
const MIN_SCALE = 0.2;
const DONE = "zoomReady";

const CSS = `
.ciz-wrap{position:relative;display:inline-block;max-width:100%;vertical-align:top;overflow:hidden;line-height:0}
.ciz-wrap img{transform-origin:0 0;will-change:transform}
.ciz-wrap.ciz-zoomed{cursor:grab;outline:1px solid var(--border,#5c4733)}
.ciz-wrap.ciz-drag{cursor:grabbing}
.ciz-bar{position:absolute;left:8px;bottom:8px;display:flex;gap:4px;z-index:2;opacity:.9;line-height:1}
.ciz-bar span{font:600 12px system-ui;color:#e8c79a;background:#2b2017;border:1px solid #5c4733;border-radius:6px;padding:0 6px;display:flex;align-items:center}
.ciz-bar button,.ciz-view-bar button{font:600 15px system-ui;min-width:30px;padding:0 6px;height:30px;border-radius:6px;
 border:1px solid #5c4733;background:#2b2017;color:#f4ead9;cursor:pointer;line-height:1}
.ciz-bar button:hover,.ciz-view-bar button:hover{background:#4a3726}
.ciz-view{position:fixed;inset:0;z-index:100000;background:rgba(10,8,6,.92);overflow:hidden;cursor:grab}
.ciz-view.ciz-drag{cursor:grabbing}
.ciz-view img{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none!important;user-select:none;-webkit-user-drag:none}
.ciz-view-bar{position:fixed;left:16px;bottom:16px;display:flex;gap:6px;z-index:100001;align-items:center}
.ciz-view-bar span{font:12px system-ui;color:#e8c79a;min-width:44px;text-align:center}
`;

let styled = false;
function ensureStyle(doc: Document): void {
  if (styled) {
    return;
  }
  const s = doc.createElement("style");
  s.textContent = CSS;
  doc.head.appendChild(s);
  styled = true;
}

function button(
  doc: Document,
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  // Focus on click made the chat scroll the button into view (the architect 2026-10-14): never take it.
  b.tabIndex = -1;
  for (const type of ["pointerdown", "mousedown"]) {
    b.addEventListener(type, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
  }
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/** The full-resolution source: the link's href when the image is wrapped in a link to an image. */
export function fullSourceFor(img: HTMLImageElement): string {
  const a = img.closest("a");
  const href = a?.getAttribute("href") ?? "";
  return /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(href)
    ? (a as HTMLAnchorElement).href
    : img.currentSrc || img.src;
}

export function openImageViewer(doc: Document, src: string): void {
  ensureStyle(doc);
  const view = doc.createElement("div");
  view.className = "ciz-view";
  const img = doc.createElement("img");
  img.alt = "";
  view.appendChild(img);
  const bar = doc.createElement("div");
  bar.className = "ciz-view-bar";
  const pct = doc.createElement("span");
  let scale = 1;
  let x = 0;
  let y = 0;
  const paint = () => {
    img.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  const fit = () => {
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    scale = Math.min(view.clientWidth / w, view.clientHeight / h, 1);
    x = (view.clientWidth - w * scale) / 2;
    y = (view.clientHeight - h * scale) / 2;
    paint();
  };
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(MAX_SCALE, Math.max(0.05, scale * factor));
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    paint();
  };
  const centre = () => [view.clientWidth / 2, view.clientHeight / 2] as const;
  const close = () => {
    view.remove();
    bar.remove();
    doc.removeEventListener("keydown", onKey, true);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "+" || ev.key === "=") {
      zoomAt(STEP, ...centre());
    } else if (ev.key === "-") {
      zoomAt(1 / STEP, ...centre());
    }
  };
  bar.append(
    button(doc, "−", "Zoom out (−)", () => zoomAt(1 / STEP, ...centre())),
    pct,
    button(doc, "+", "Zoom in (+)", () => zoomAt(STEP, ...centre())),
    button(doc, "Fit", "Fit to screen", fit),
    button(doc, "1:1", "Actual size", () => zoomAt(1 / scale, ...centre())),
    button(doc, "✕", "Close (Esc)", close),
  );
  view.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      zoomAt(ev.deltaY < 0 ? STEP : 1 / STEP, ev.clientX, ev.clientY);
    },
    { passive: false },
  );
  let drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  view.addEventListener("pointerdown", (ev) => {
    drag = { sx: ev.clientX, sy: ev.clientY, ox: x, oy: y, moved: false };
    view.classList.add("ciz-drag");
    view.setPointerCapture?.(ev.pointerId);
  });
  view.addEventListener("pointermove", (ev) => {
    if (!drag) {
      return;
    }
    const dx = ev.clientX - drag.sx;
    const dy = ev.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
    }
    x = drag.ox + dx;
    y = drag.oy + dy;
    paint();
  });
  view.addEventListener("pointerup", (ev) => {
    const wasClick = drag && !drag.moved;
    drag = null;
    view.classList.remove("ciz-drag");
    // A plain click on the dark backdrop (not on the picture) closes, like most viewers.
    if (wasClick && ev.target === view) {
      close();
    }
  });
  doc.addEventListener("keydown", onKey, true);
  img.addEventListener("load", fit, { once: true });
  img.src = src;
  doc.body.append(view, bar);
  if (img.complete && img.naturalWidth) {
    fit();
  }
}

function attach(img: HTMLImageElement): void {
  const doc = img.ownerDocument;
  if (img.dataset[DONE] || img.closest(".ciz-wrap")) {
    return;
  }
  const anchor =
    img.parentElement?.tagName === "A" ? (img.parentElement as HTMLAnchorElement) : null;
  const shown = img.getBoundingClientRect().width;
  if (img.naturalWidth < MIN_NATURAL_WIDTH || shown < MIN_SHOWN_WIDTH) {
    // A thumbnail (e.g. a logo or photo in a comparison card) gets no bar, which would cover it
    // (the architect 2026-10-15); a click opens the full-size viewer when the file holds more than is shown.
    if (shown > 0 && img.naturalWidth > shown * 1.2) {
      img.dataset[DONE] = "1";
      ensureStyle(doc);
      img.style.cursor = "zoom-in";
      (anchor ?? img).addEventListener(
        "click",
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openImageViewer(doc, fullSourceFor(img));
        },
        true,
      );
    }
    return;
  }
  img.dataset[DONE] = "1";
  ensureStyle(doc);
  // Wrap the link when the image sits in one, so clicking the picture still opens the full file.
  const target: Element = anchor ?? img;
  const wrap = doc.createElement("span");
  wrap.className = "ciz-wrap";
  target.replaceWith(wrap);
  wrap.appendChild(target);
  // The zoom is a transform inside a frame that keeps the image's own size: the chat never reflows,
  // never scrolls, and the bar stays under the pointer (the architect 2026-10-14). Each step is exactly
  // x1.25 or /1.25; above 1x around the frame's centre, below 1x the frame shrinks (floor 20%).
  let scale = 1;
  let x = 0;
  let y = 0;
  const pct = doc.createElement("span");
  const bar = doc.createElement("span");
  bar.className = "ciz-bar";
  const clamp = () => {
    const w = img.clientWidth;
    const h = img.clientHeight;
    x = Math.min(0, Math.max(w - w * scale, x));
    y = Math.min(0, Math.max(h - h * scale, y));
  };
  const paint = () => {
    if (scale < 1) {
      // Below 1x the picture and its frame shrink together, so a tall image fits on screen.
      img.style.width = `${baseW * scale}px`;
      img.style.transform = "";
    } else {
      img.style.width = "";
      clamp();
      img.style.transform = scale === 1 ? "" : `translate(${x}px,${y}px) scale(${scale})`;
    }
    wrap.classList.toggle("ciz-zoomed", scale > 1);
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  let baseW = 0;
  const scroller = (): Element | null => {
    for (let el = wrap.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }
    return doc.scrollingElement;
  };
  const zoomBy = (factor: number) => {
    if (scale === 1) {
      baseW = img.clientWidth;
    }
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const snapped = Math.abs(next - 1) < 1e-6 ? 1 : next;
    if (snapped > 1) {
      const from = Math.max(1, scale);
      const cx = img.clientWidth / 2;
      const cy = img.clientHeight / 2;
      x = cx - ((cx - x) * snapped) / from;
      y = cy - ((cy - y) * snapped) / from;
    } else {
      x = 0;
      y = 0;
    }
    // When the frame changes height, scroll by the same amount so the bar stays under the pointer.
    const before = bar.getBoundingClientRect().top;
    scale = snapped;
    paint();
    const moved = bar.getBoundingClientRect().top - before;
    const sc = scroller();
    if (moved && sc) {
      sc.scrollTop += moved;
    }
  };
  // Drag to pan while zoomed; a drag never follows the link.
  let drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  let suppressClick = false;
  wrap.addEventListener("pointerdown", (ev) => {
    if (scale === 1 || (ev.target as Element).closest(".ciz-bar")) {
      return;
    }
    ev.preventDefault();
    drag = { sx: ev.clientX, sy: ev.clientY, ox: x, oy: y, moved: false };
    wrap.classList.add("ciz-drag");
    wrap.setPointerCapture?.(ev.pointerId);
  });
  wrap.addEventListener("pointermove", (ev) => {
    if (!drag) {
      return;
    }
    const dx = ev.clientX - drag.sx;
    const dy = ev.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
    }
    x = drag.ox + dx;
    y = drag.oy + dy;
    paint();
  });
  const endDrag = () => {
    if (drag?.moved) {
      suppressClick = true;
    }
    drag = null;
    wrap.classList.remove("ciz-drag");
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);
  // While zoomed, a click on the picture does not navigate away; at 1x it still opens the full file.
  wrap.addEventListener(
    "click",
    (ev) => {
      if ((ev.target as Element).closest(".ciz-bar")) {
        return;
      }
      if (suppressClick || scale > 1) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      suppressClick = false;
    },
    true,
  );
  bar.append(
    button(doc, "−", "Zoom out", () => zoomBy(1 / STEP)),
    pct,
    button(doc, "+", "Zoom in", () => zoomBy(STEP)),
    button(doc, "⤢", "Open full screen", () => openImageViewer(doc, fullSourceFor(img))),
  );
  wrap.appendChild(bar);
  paint();
}

/** Give each large chat image its zoom bar, now or once it has loaded. Safe to call repeatedly. */
export function enhanceChatImages(imgs: Iterable<Element>): void {
  for (const el of imgs) {
    if (!(el instanceof HTMLImageElement) || el.dataset[DONE]) {
      continue;
    }
    if (el.complete && el.naturalWidth) {
      attach(el);
    } else {
      el.addEventListener("load", () => attach(el), { once: true });
    }
  }
}
