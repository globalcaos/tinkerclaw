// FORK 2026-09-23 (the architect: "set conversation slave") — the chain you see between a master tab
// and its slave. A fixed, click-through canvas over the whole window. The animation loop runs
// only while something moves (pick mode, an anchor that shifted, a rope still swinging) and
// stops once every rope is at rest — a frozen chain costs nothing.

import {
  chainColor,
  createRope,
  type Pt,
  type RopeNode,
  samplePath,
  settleRope,
  stepRope,
  type TabChain,
} from "./tab-chains.js";

export type TabAnchor = { x: number; y: number; tab: DOMRect };

export type ChainOverlayHost = {
  chains(): TabChain[];
  /** Bottom-centre of the tab's title, clamped to the visible tab bar; null = not on screen. */
  anchor(tabId: string): TabAnchor | null;
};

type RopeState = { rope: RopeNode[]; a: Pt; b: Pt; still: number };

const REST_EPS = 0.04;
const REST_FRAMES = 24;
const MOVE_EPS = 0.5;
/** Master eyelet centre sits this far under the title, so the ring clears the text. */
const EYELET_DROP = 4;
/** The D-ring bottom hangs this far under the slave's title; the chain hooks in there. */
const COLLAR_DROP = 15;
/** Mouse within this many px of a chain makes the overlay see-through. */
const HOVER_PX = 12;

function segDist(x: number, y: number, p: Pt, q: Pt): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / len2)) : 0;
  return Math.hypot(x - (p.x + t * dx), y - (p.y + t * dy));
}

export function createChainOverlay(host: ChainOverlayHost) {
  const canvas = document.createElement("canvas");
  canvas.className = "tab-chain-overlay";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const ropes = new Map<string, RopeState>();
  let pick: { master: string; color: string; mouse: Pt; state: RopeState | null } | null = null;
  let raf = 0;
  let dirty = true;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
    wake();
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  const keyOf = (c: TabChain) => `${c.master}>${c.slave}`;
  const moved = (p: Pt, q: Pt) => Math.abs(p.x - q.x) > MOVE_EPS || Math.abs(p.y - q.y) > MOVE_EPS;

  function frame() {
    raf = 0;
    let active = false;
    const chains = host.chains();
    const live = new Set<string>();
    const draws: Array<() => void> = [];

    for (const chain of chains) {
      const ma = host.anchor(chain.master);
      const sa = host.anchor(chain.slave);
      if (!ma || !sa) continue;
      const key = keyOf(chain);
      live.add(key);
      const a = { x: ma.x, y: ma.y + EYELET_DROP };
      const b = { x: sa.x, y: sa.y + COLLAR_DROP };
      let st = ropes.get(key);
      if (!st) {
        // A chain that just appeared (attach, reload, hydration) lands already at rest:
        // clicking the slave FREEZES the chain, it does not start it swinging.
        const rope =
          pick?.master === chain.master && pick.state ? pick.state.rope : createRope(a, b);
        settleRope(rope, a, b);
        st = { rope, a, b, still: REST_FRAMES };
        ropes.set(key, st);
        dirty = true;
      }
      if (moved(st.a, a) || moved(st.b, b)) {
        st.a = a;
        st.b = b;
        st.still = 0;
      }
      if (st.still < REST_FRAMES) {
        const m = stepRope(st.rope, a, b);
        st.still = m < REST_EPS ? st.still + 1 : 0;
        active = true;
        dirty = true;
      }
      const color = chainColor(chain);
      const rope = st.rope;
      draws.push(() => {
        drawChain(ctx, rope, color);
        drawMasterMount(ctx, a, color);
        drawSlaveCollar(ctx, sa, color);
      });
    }
    for (const key of ropes.keys()) {
      if (!live.has(key)) {
        ropes.delete(key);
        dirty = true;
      }
    }

    if (pick) {
      const ma = host.anchor(pick.master);
      if (ma) {
        const a = { x: ma.x, y: ma.y + EYELET_DROP };
        const b = pick.mouse;
        if (!pick.state) pick.state = { rope: createRope(a, b), a, b, still: 0 };
        stepRope(pick.state.rope, a, b);
        const { rope } = pick.state;
        const color = pick.color;
        draws.push(() => {
          drawChain(ctx, rope, color);
          drawMasterMount(ctx, a, color);
          drawOpenCollar(ctx, b, color);
        });
      }
      active = true;
      dirty = true;
    }

    if (dirty) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const d of draws) d();
      dirty = false;
    }
    if (active) wake();
  }

  // the architect 2026-09-23: "nearly transparent on mouseover, in case I need to read what is
  // underneath". The canvas is click-through, so :hover never fires — hit-test the ropes.
  function nearChain(x: number, y: number): boolean {
    for (const { rope } of ropes.values()) {
      for (let i = 0; i < rope.length - 1; i++) {
        if (segDist(x, y, rope[i], rope[i + 1]) < HOVER_PX) return true;
      }
    }
    return false;
  }
  document.addEventListener(
    "pointermove",
    (e) => {
      canvas.classList.toggle("see-through", !pick && nearChain(e.clientX, e.clientY));
    },
    { passive: true },
  );
  document.documentElement.addEventListener("mouseleave", () =>
    canvas.classList.remove("see-through"),
  );

  window.addEventListener("resize", resize);
  // Layout can move a tab without any event we own (a panel opening, fonts loading, the
  // bar overflowing). A slow anchor poll catches those; it only draws when something moved.
  setInterval(() => {
    if (ropes.size || host.chains().length) wake();
  }, 500);
  resize();

  return {
    /** Something may have moved the tabs — re-read anchors and swing if they changed. */
    wake,
    beginPick(master: string, color: string, from: Pt) {
      pick = { master, color, mouse: from, state: null };
      wake();
    },
    pointer(x: number, y: number) {
      if (pick) pick.mouse = { x, y };
      wake();
    },
    endPick() {
      pick = null;
      dirty = true;
      wake();
    },
    isPicking: () => pick != null,
    pickMaster: () => pick?.master ?? null,
  };
}

export type ChainOverlay = ReturnType<typeof createChainOverlay>;

// ─── Drawing ───

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) =>
    Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))
      .toString(16)
      .padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

/** Interlocking links: face-on ovals alternate with edge-on bars, like a real chain. */
function drawChain(ctx: CanvasRenderingContext2D, rope: Pt[], color: string) {
  const pts = samplePath(rope, 6.5);
  const dark = shade(color, -0.6);
  const light = shade(color, 0.55);
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 2;
  pts.forEach((p, i) => {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.2, 3.4, 0, 0, Math.PI * 2);
      ctx.strokeStyle = dark;
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.9;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.2, 3.4, 0, Math.PI * 1.1, Math.PI * 1.6);
      ctx.strokeStyle = light;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-5.2, 0);
      ctx.lineTo(5.2, 0);
      ctx.strokeStyle = dark;
      ctx.lineWidth = 3.6;
      ctx.stroke();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, -0.6);
      ctx.lineTo(4, -0.6);
      ctx.strokeStyle = light;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
  });
  ctx.restore();
}

/** Master end: an ordinary eyelet, nothing to read into it. */
function drawMasterMount(ctx: CanvasRenderingContext2D, a: Pt, color: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(a.x, a.y, 4.2, 0, Math.PI * 2);
  ctx.strokeStyle = shade(color, -0.6);
  ctx.lineWidth = 3.4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(a.x, a.y - 4.2, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 0.5);
  ctx.fill();
  ctx.restore();
}

/** Slave end: a studded leather collar round the tab's foot, a buckle, and the D-ring the
 *  chain is hooked to. */
function drawSlaveCollar(ctx: CanvasRenderingContext2D, anchor: TabAnchor, color: string) {
  const w = Math.max(34, Math.min(anchor.tab.width - 14, 96));
  const cx = anchor.x;
  // Band sits just under the title text, never across it.
  const top = anchor.y + 1;
  const h = 7;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, "#7a4f2c");
  g.addColorStop(0.5, "#5a3820");
  g.addColorStop(1, "#3a2313");
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, top, w, h, 3);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#24160b";
  ctx.lineWidth = 1;
  ctx.stroke();
  // stitching
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = "rgba(230,200,150,0.45)";
  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + 3, top + 1.6);
  ctx.lineTo(cx + w / 2 - 3, top + 1.6);
  ctx.moveTo(cx - w / 2 + 3, top + h - 1.6);
  ctx.lineTo(cx + w / 2 - 3, top + h - 1.6);
  ctx.stroke();
  ctx.setLineDash([]);
  // studs
  ctx.fillStyle = shade(color, 0.35);
  for (let x = cx - w / 2 + 7; x < cx + w / 2 - 5; x += 10) {
    if (Math.abs(x - cx) < 9) continue;
    ctx.beginPath();
    ctx.arc(x, top + h / 2, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // buckle
  ctx.strokeStyle = shade(color, -0.55);
  ctx.lineWidth = 3.2;
  ctx.strokeRect(cx - 6, top - 1.5, 12, h + 3);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.strokeRect(cx - 6, top - 1.5, 12, h + 3);
  ctx.beginPath();
  ctx.moveTo(cx - 6, top + h / 2);
  ctx.lineTo(cx + 3, top + h / 2);
  ctx.strokeStyle = shade(color, 0.4);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // D-ring
  ctx.beginPath();
  ctx.moveTo(cx - 4.5, top + h + 2);
  ctx.lineTo(cx + 4.5, top + h + 2);
  ctx.arc(cx, top + h + 2, 4.5, 0, Math.PI);
  ctx.strokeStyle = shade(color, -0.6);
  ctx.lineWidth = 3.2;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.restore();
}

/** The free end while picking: an open collar looking for a neck. */
function drawOpenCollar(ctx: CanvasRenderingContext2D, p: Pt, color: string) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y + 9, 9, Math.PI * 0.18, Math.PI * 1.82);
  ctx.strokeStyle = "#3a2313";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#6a4426";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(p.x - 4, p.y + 14, 8, 6);
  ctx.restore();
}
