// tinker-ui/src/panels/presence-graph.ts
// FORK 2026-06-04 — Grafana-lite multi-line charts for the Exec-mode Pulse
// "Graphs" section. One chart per metric family. Features:
//   • numeric Y axis (left) + optional secondary Y axis (right) for series whose
//     scale differs wildly (e.g. github views vs clones), so neither goes flat
//   • adaptive time X axis (day → week → month → year by zoomed span)
//   • per-series options: explicit color, dashed stroke, cumulative (running sum),
//     and left/right axis assignment
//   • one point per day = that day's LAST reading (gauges; averaging would lie)
//   • no legend — lines identified via the hover tooltip
//   • header = icon + permanent name; click to collapse; drag to reorder (persisted)
//   • horizontal (secondary) wheel or Ctrl/⌘+wheel zooms the time window (plain
//     vertical wheel scrolls the page); drag pans;
//     double-click resets

export type GPoint = { ts: number; value: number };
export type GSeries = {
  id: string;
  label: string;
  points: GPoint[];
  color?: string;
  dash?: boolean;
  cumulative?: boolean;
  axis?: "left" | "right";
};
export type GGroup = { key: string; title: string; series: GSeries[] };

const PALETTE = [
  "#8ECAE6",
  "#F4A261",
  "#F4F1DE",
  "#E76F51",
  "#64E572",
  "#4f8ff7",
  "#c084fc",
  "#fbbf24",
  "#f472b6",
  "#34d399",
];
const colorAt = (i: number) => PALETTE[i % PALETTE.length];

const ICONS: Record<string, string> = {
  github: "🐙",
  moltbook: "🦞",
  clawhub: "🧩",
  inbound: "🔗",
  website: "🌐",
  npm: "📦",
};
const icon = (key: string) => ICONS[key] ?? "📊";

const VIEW = new Map<string, { t0: number; t1: number }>();
const DATA = new Map<string, GGroup>();

const W = 360,
  H = 130,
  ML = 42,
  MR = 38,
  MT = 8,
  MB = 20;
const PW = W - ML - MR,
  PH = H - MT - MB;
const DAY = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const OKEY = "pulse.pg.order",
  CKEY = "pulse.pg.collapsed";
function loadOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(OKEY) || "[]");
  } catch {
    return [];
  }
}
function saveOrder(keys: string[]): void {
  try {
    localStorage.setItem(OKEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CKEY) || "{}");
  } catch {
    return {};
  }
}
function saveCollapsed(o: Record<string, boolean>): void {
  try {
    localStorage.setItem(CKEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

// One point per calendar day = that day's LAST reading (gauges/cumulative —
// averaging same-day polls would distort, e.g. inbound [0,0,31] → ~10).
function dailyLast(points: GPoint[]): GPoint[] {
  if (points.length <= 1) return points.slice();
  const b = new Map<number, GPoint>();
  for (const p of points) {
    const day = Math.floor(p.ts / DAY) * DAY + DAY / 2;
    const prev = b.get(day);
    if (!prev || p.ts >= prev.ts) b.set(day, { ts: day, value: p.value });
  }
  return [...b.values()].sort((a, c) => a.ts - c.ts);
}
function seriesPoints(s: GSeries): GPoint[] {
  let pts = dailyLast(s.points);
  if (s.cumulative) {
    let run = 0;
    pts = pts.map((p) => ({ ts: p.ts, value: (run += p.value) }));
  }
  return pts;
}

function fullRange(g: GGroup): { t0: number; t1: number } {
  let t0 = Infinity,
    t1 = -Infinity;
  for (const s of g.series)
    for (const p of dailyLast(s.points)) {
      if (p.ts < t0) t0 = p.ts;
      if (p.ts > t1) t1 = p.ts;
    }
  if (!isFinite(t0)) {
    const n = Date.now();
    return { t0: n - DAY, t1: n };
  }
  if (t0 === t1) {
    t0 -= DAY;
    t1 += DAY;
  }
  return { t0, t1 };
}
function niceNum(range: number, round: boolean): number {
  const r = range || 1,
    exp = Math.floor(Math.log10(r)),
    f = r / Math.pow(10, exp);
  const nf = round
    ? f < 1.5
      ? 1
      : f < 3
        ? 2
        : f < 7
          ? 5
          : 10
    : f <= 1
      ? 1
      : f <= 2
        ? 2
        : f <= 5
          ? 5
          : 10;
  return nf * Math.pow(10, exp);
}
function yTicks(min: number, max: number, n = 4): number[] {
  if (min === max) {
    min = Math.min(0, min);
    max = max + 1;
  }
  const step = niceNum(niceNum(max - min, false) / (n - 1), true);
  const lo = Math.floor(min / step) * step,
    hi = Math.ceil(max / step) * step,
    out: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
function fmtNum(v: number): string {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function xTicks(t0: number, t1: number): { ts: number; label: string }[] {
  const span = t1 - t0,
    out: { ts: number; label: string }[] = [],
    d = (ts: number) => new Date(ts);
  const dm = (ts: number) => `${d(ts).getDate()} ${MON[d(ts).getMonth()]}`;
  if (span <= 16 * DAY) {
    const step = span <= 8 * DAY ? DAY : 2 * DAY;
    for (let ts = Math.ceil(t0 / DAY) * DAY; ts <= t1; ts += step) out.push({ ts, label: dm(ts) });
  } else if (span <= 100 * DAY) {
    for (let ts = Math.ceil(t0 / (7 * DAY)) * 7 * DAY; ts <= t1; ts += 7 * DAY)
      out.push({ ts, label: dm(ts) });
  } else if (span <= 800 * DAY) {
    let ts = new Date(d(t0).getFullYear(), d(t0).getMonth() + 1, 1).getTime();
    while (ts <= t1) {
      const dd = d(ts);
      out.push({ ts, label: `${MON[dd.getMonth()]} ${String(dd.getFullYear()).slice(2)}` });
      ts = new Date(dd.getFullYear(), dd.getMonth() + 1, 1).getTime();
    }
  } else {
    let ts = new Date(d(t0).getFullYear() + 1, 0, 1).getTime();
    while (ts <= t1) {
      out.push({ ts, label: String(d(ts).getFullYear()) });
      ts = new Date(d(ts).getFullYear() + 1, 0, 1).getTime();
    }
  }
  if (out.length > 7) {
    const k: typeof out = [],
      st = Math.ceil(out.length / 6);
    for (let i = 0; i < out.length; i += st) k.push(out[i]);
    return k;
  }
  return out;
}
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

// FORK 2026-06-07 — bug task-mq3ghvqy (Zooming into graphs): a series whose only points sit
// OUTSIDE the zoomed window (e.g. clawhub with one reading far-left and one far-right) used to
// vanish, because the render/domain code only looked at in-window points. These helpers return the
// in-window points PLUS the nearest bracketing point on each side, so the connecting line still
// crosses the window and the Y-axis can be scaled to the segment that's actually visible.
function interpY(a: GPoint, b: GPoint, t: number): number {
  return b.ts === a.ts ? a.value : a.value + ((t - a.ts) / (b.ts - a.ts)) * (b.value - a.value);
}
function yAtTime(P: GPoint[], t: number): number | null {
  if (!P.length) return null;
  if (t <= P[0].ts) return P[0].value;
  if (t >= P[P.length - 1].ts) return P[P.length - 1].value;
  for (let i = 1; i < P.length; i++) if (t <= P[i].ts) return interpY(P[i - 1], P[i], t);
  return P[P.length - 1].value;
}
// in-window points + nearest point before t0 + nearest point after t1, sorted ascending by ts
function bracketed(points: GPoint[], t0: number, t1: number): GPoint[] {
  const inWin: GPoint[] = [];
  let before: GPoint | null = null,
    after: GPoint | null = null;
  for (const p of points) {
    if (p.ts < t0) {
      if (!before || p.ts > before.ts) before = p;
    } else if (p.ts > t1) {
      if (!after || p.ts < after.ts) after = p;
    } else inWin.push(p);
  }
  const out = inWin.slice();
  if (before) out.push(before);
  if (after) out.push(after);
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function domainOf(
  g: GGroup,
  side: "left" | "right",
  t0: number,
  t1: number,
): { lo: number; hi: number; ticks: number[] } | null {
  const ser = g.series.filter((s) => (s.axis === "right" ? "right" : "left") === side);
  if (!ser.length) return null;
  let min = Infinity,
    max = -Infinity;
  for (const s of ser) {
    const P = bracketed(seriesPoints(s), t0, t1);
    if (!P.length) continue;
    // in-window vertices
    for (const p of P)
      if (p.ts >= t0 && p.ts <= t1) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
    // window-edge crossings: when the line spans across an edge, the value it actually shows at
    // that edge is the interpolation — include it so a line passing THROUGH the window scales right.
    const lo = P[0].ts,
      hi = P[P.length - 1].ts;
    if (lo <= t0 && hi >= t0) {
      const y = yAtTime(P, t0)!;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (lo <= t1 && hi >= t1) {
      const y = yAtTime(P, t1)!;
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }
  if (!isFinite(min)) {
    min = 0;
    max = 1;
  }
  const ticks = yTicks(Math.min(min, max), Math.max(min, max));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
}

function renderSvg(g: GGroup): string {
  const view = VIEW.get(g.key) ?? fullRange(g);
  const { t0, t1 } = view;
  const L = domainOf(g, "left", t0, t1),
    R = domainOf(g, "right", t0, t1);
  const colorIdx = new Map<string, number>();
  g.series.forEach((s, i) => colorIdx.set(s.id, i));
  const rightColor =
    g.series.find((s) => s.axis === "right")?.color ??
    (R ? colorAt(colorIdx.get(g.series.find((s) => s.axis === "right")!.id)!) : "#8a8f98");
  const xPix = (ts: number) => ML + ((ts - t0) / Math.max(1, t1 - t0)) * PW;
  const yPixL = (v: number) =>
    MT + (1 - (v - (L?.lo ?? 0)) / Math.max(1e-9, (L?.hi ?? 1) - (L?.lo ?? 0))) * PH;
  const yPixR = (v: number) =>
    MT + (1 - (v - (R?.lo ?? 0)) / Math.max(1e-9, (R?.hi ?? 1) - (R?.lo ?? 0))) * PH;

  // Clip the data lines to the plot rect so bracketing segments (drawn from points that lie
  // outside the zoomed window — see bracketed()) never overflow onto the axes/labels.
  const clipId = `pgclip-${g.key.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  let svg = `<svg class="pg-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none"><defs><clipPath id="${clipId}"><rect x="${ML}" y="${MT}" width="${PW}" height="${PH}"/></clipPath></defs>`;
  if (L)
    for (const v of L.ticks) {
      const y = yPixL(v).toFixed(1);
      svg += `<line class="pg-grid" x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}"/><text class="pg-ylab" x="${ML - 5}" y="${y}" dy="3" text-anchor="end">${fmtNum(v)}</text>`;
    }
  if (R)
    for (const v of R.ticks) {
      const y = yPixR(v).toFixed(1);
      svg += `<text class="pg-ylab" x="${W - MR + 5}" y="${y}" dy="3" text-anchor="start" fill="${rightColor}">${fmtNum(v)}</text>`;
    }
  for (const t of xTicks(t0, t1)) {
    const x = xPix(t.ts).toFixed(1);
    svg += `<line class="pg-xtick" x1="${x}" y1="${MT}" x2="${x}" y2="${MT + PH}"/><text class="pg-xlab" x="${x}" y="${H - 5}" text-anchor="middle">${esc(t.label)}</text>`;
  }
  g.series.forEach((s, si) => {
    // bracketed() keeps the nearest point on each side of the window so the line still crosses a
    // zoomed-in window even when no data point falls inside it (bug task-mq3ghvqy).
    const pts = bracketed(seriesPoints(s), t0, t1);
    if (!pts.length) return;
    const yp = s.axis === "right" ? yPixR : yPixL;
    const col = s.color ?? colorAt(colorIdx.get(s.id)!);
    const dash = s.dash ? ' stroke-dasharray="5 3"' : "";
    // clip the line to the plot so off-window bracketing segments don't paint over the axes
    svg += `<path class="pg-line" data-sid="${si}" clip-path="url(#${clipId})" d="${pts.map((p, j) => `${j ? "L" : "M"}${xPix(p.ts).toFixed(1)},${yp(p.value).toFixed(1)}`).join(" ")}" fill="none" stroke="${col}"${dash}/>`;
    // draw vertex dots only for points actually inside the window (not the off-window brackets)
    for (const p of pts)
      if (p.ts >= t0 && p.ts <= t1)
        svg += `<circle data-sid="${si}" cx="${xPix(p.ts).toFixed(1)}" cy="${yp(p.value).toFixed(1)}" r="1.9" fill="${col}"/>`;
  });
  svg += `<line class="pg-cross" style="display:none" y1="${MT}" y2="${MT + PH}"/></svg>`;
  return svg;
}

function chartHtml(g: GGroup): string {
  const collapsed = loadCollapsed()[g.key] ? " collapsed" : "";
  return `
    <div class="pg-chart${collapsed}" data-group="${esc(g.key)}">
      <div class="pg-head" draggable="true" title="Drag to reorder · click to collapse">
        <span class="pg-grip">⠿</span><span class="pg-icon">${icon(g.key)}</span><span class="pg-name">${esc(g.title)}</span>
      </div>
      <div class="pg-body">${renderSvg(g)}<div class="pg-tip" style="display:none"></div></div>
    </div>`;
}

export function renderPresenceGraphsHtml(groups: GGroup[]): string {
  if (!groups.length) return `<div class="exec-kpi-empty">No graphs configured yet.</div>`;
  for (const g of groups) DATA.set(g.key, g);
  const ord = loadOrder();
  groups = [...groups].sort((a, b) => {
    const ia = ord.indexOf(a.key),
      ib = ord.indexOf(b.key);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return groups.map(chartHtml).join("");
}

export function attachPresenceGraphs(container: HTMLElement): void {
  if (container.dataset.pgDnd !== "1") {
    container.dataset.pgDnd = "1";
    let dragEl: HTMLElement | null = null;
    container.addEventListener("dragstart", (ev) => {
      const head = (ev.target as HTMLElement).closest(".pg-head");
      if (!head) return;
      dragEl = head.closest(".pg-chart");
      if (dragEl) dragEl.dataset.dragging = "1";
    });
    container.addEventListener("dragover", (ev) => {
      if (!dragEl) return;
      ev.preventDefault();
      const over = (ev.target as HTMLElement).closest<HTMLElement>(".pg-chart");
      if (!over || over === dragEl) return;
      const r = over.getBoundingClientRect();
      container.insertBefore(dragEl, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
    });
    const finish = () => {
      if (!dragEl) return;
      delete dragEl.dataset.dragging;
      dragEl = null;
      saveOrder(
        [...container.querySelectorAll<HTMLElement>(".pg-chart")].map((c) => c.dataset.group || ""),
      );
    };
    container.addEventListener("drop", (ev) => {
      ev.preventDefault();
      finish();
    });
    container.addEventListener("dragend", finish);
  }
  container.querySelectorAll<HTMLElement>(".pg-chart").forEach((chart) => {
    if (chart.dataset.wired === "1") return;
    chart.dataset.wired = "1";
    const key = chart.dataset.group || "";
    const head = chart.querySelector(".pg-head") as HTMLElement;
    const body = chart.querySelector(".pg-body") as HTMLElement;
    const tip = chart.querySelector(".pg-tip") as HTMLElement;
    const svgEl = () => body.querySelector("svg") as SVGSVGElement;
    const rerender = () => {
      const g = DATA.get(key);
      if (g) {
        const t = tip;
        body.innerHTML = renderSvg(g);
        body.appendChild(t);
      }
    };
    const full = () => fullRange(DATA.get(key)!);
    const win = () => VIEW.get(key) ?? full();
    const plotFrac = (cx: number) => {
      const r = svgEl().getBoundingClientRect();
      return (cx - r.left - (ML / W) * r.width) / ((PW / W) * r.width);
    };

    let dragged = false;
    head.addEventListener("dragstart", () => {
      dragged = true;
    });
    head.addEventListener("dragend", () => {
      setTimeout(() => (dragged = false), 0);
    });
    head.addEventListener("click", () => {
      if (dragged) return;
      chart.classList.toggle("collapsed");
      const c = loadCollapsed();
      c[key] = chart.classList.contains("collapsed");
      saveCollapsed(c);
    });

    // Plain vertical wheel scrolls the page. The horizontal (secondary) wheel —
    // or Ctrl/⌘+wheel — zooms the time X axis (right/down = out, left/up = in).
    body.addEventListener(
      "wheel",
      (ev) => {
        const horiz = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
        const delta = ev.ctrlKey || ev.metaKey ? ev.deltaY : horiz ? ev.deltaX : 0;
        if (delta === 0) return; // plain vertical wheel → let the page scroll
        ev.preventDefault();
        if (!DATA.get(key)) return;
        const frac = Math.max(0, Math.min(1, plotFrac(ev.clientX)));
        const v = win(),
          span = v.t1 - v.t0,
          f = full();
        const nspan = Math.max(DAY, Math.min(f.t1 - f.t0, span * (delta > 0 ? 1.25 : 0.8)));
        const center = v.t0 + frac * span;
        let nt0 = center - frac * nspan,
          nt1 = nt0 + nspan;
        if (nt0 < f.t0) {
          nt0 = f.t0;
          nt1 = nt0 + nspan;
        }
        if (nt1 > f.t1) {
          nt1 = f.t1;
          nt0 = nt1 - nspan;
        }
        VIEW.set(key, { t0: nt0, t1: nt1 });
        rerender();
      },
      { passive: false },
    );

    let dragX: number | null = null,
      dragWin: { t0: number; t1: number } | null = null;
    body.addEventListener("pointerdown", (ev) => {
      dragX = ev.clientX;
      dragWin = { ...win() };
      body.style.cursor = "grabbing";
    });
    window.addEventListener("pointermove", (ev) => {
      if (dragX == null || !dragWin) return;
      const r = svgEl().getBoundingClientRect(),
        span = dragWin.t1 - dragWin.t0;
      const dt = -((ev.clientX - dragX) / ((PW / W) * r.width)) * span,
        f = full();
      let nt0 = dragWin.t0 + dt,
        nt1 = dragWin.t1 + dt;
      if (nt0 < f.t0) {
        nt0 = f.t0;
        nt1 = nt0 + span;
      }
      if (nt1 > f.t1) {
        nt1 = f.t1;
        nt0 = nt1 - span;
      }
      VIEW.set(key, { t0: nt0, t1: nt1 });
      rerender();
    });
    window.addEventListener("pointerup", () => {
      dragX = null;
      dragWin = null;
      body.style.cursor = "";
    });
    body.addEventListener("dblclick", () => {
      VIEW.delete(key);
      rerender();
    });

    // Hover = ISOLATE the single nearest line: dim the others, thicken the
    // hovered one, and show only its name + value (not all series at once).
    const dimSeries = (svg: SVGSVGElement, hi: number | null) =>
      svg.querySelectorAll<SVGElement>("[data-sid]").forEach((e) => {
        const on = hi == null || Number(e.dataset.sid) === hi;
        e.style.opacity = on ? "1" : "0.1";
        if (e.tagName === "path") e.style.strokeWidth = hi != null && on ? "2.4" : "";
      });
    body.addEventListener("pointermove", (ev) => {
      if (dragX != null) return;
      const g = DATA.get(key);
      if (!g) return;
      const svg = svgEl();
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const frac = plotFrac(ev.clientX);
      const cross = svg.querySelector(".pg-cross") as SVGLineElement | null;
      const hide = () => {
        tip.style.display = "none";
        if (cross) cross.style.display = "none";
        dimSeries(svg, null);
      };
      if (frac < 0 || frac > 1) return hide();
      const v = win(),
        ts = v.t0 + frac * (v.t1 - v.t0);
      const L = domainOf(g, "left", v.t0, v.t1),
        R = domainOf(g, "right", v.t0, v.t1);
      const yOf = (val: number, axis?: "left" | "right") => {
        const D = axis === "right" ? R : L,
          lo = D?.lo ?? 0,
          hi2 = D?.hi ?? 1;
        return MT + (1 - (val - lo) / Math.max(1e-9, hi2 - lo)) * PH;
      };
      const cyView = ((ev.clientY - r.top) / r.height) * H;
      // nearest series = smallest vertical pixel gap at the cursor's x
      let hi: number | null = null,
        hp: GPoint | null = null,
        hdist = Infinity;
      g.series.forEach((s, si) => {
        const pts = seriesPoints(s);
        let bp: GPoint | null = null;
        for (const p of pts) if (!bp || Math.abs(p.ts - ts) < Math.abs(bp.ts - ts)) bp = p;
        if (!bp) return;
        const d = Math.abs(yOf(bp.value, s.axis) - cyView);
        if (d < hdist) {
          hdist = d;
          hi = si;
          hp = bp;
        }
      });
      if (hi == null || !hp) return hide();
      dimSeries(svg, hi);
      const s = g.series[hi],
        col = s.color ?? colorAt(hi);
      if (cross) {
        const x = ML + frac * PW;
        cross.style.display = "";
        cross.setAttribute("x1", String(x));
        cross.setAttribute("x2", String(x));
      }
      const dd = new Date(hp.ts),
        xpix = (ML / W) * r.width + frac * (PW / W) * r.width;
      tip.innerHTML = `<div class="pg-tipdate">${dd.getDate()} ${MON[dd.getMonth()]} ${dd.getFullYear()}</div><span class="pg-tiprow"><i style="background:${col}"></i>${esc(s.label)}: <b>${fmtNum(hp.value)}</b></span>`;
      tip.style.display = "";
      tip.style.left = Math.min(r.width - 118, Math.max(0, xpix + 8)) + "px";
    });
    body.addEventListener("pointerleave", () => {
      tip.style.display = "none";
      const svg = svgEl();
      if (svg) {
        const c = svg.querySelector(".pg-cross") as SVGLineElement | null;
        if (c) c.style.display = "none";
        dimSeries(svg, null);
      }
    });
  });
}
