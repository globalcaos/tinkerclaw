// FORK 2026-09-23 (the architect: "set conversation slave") — master/slave tab pairs for the
// conversation-loop skill, plus the rope physics the chain overlay draws.
//
// Pure module: no DOM. app.ts persists the list as the ui-state choice LOOP_CHAINS_CHOICE
// (mirrored to ~/.openclaw/data/tinker-ui-state.json, where the skill's loop-partner.mjs
// reads it). Pairs are keyed by TAB id, not session key: a /clear rotates a tab's session
// key, and the chain belongs to the tab the human pointed at.

export const LOOP_CHAINS_CHOICE = "loop:chains";
export const LOOP_CHAINS_DEFAULT = "[]";

/** `masterKey` / `slaveKey` are the ends' SESSION keys, snapshotted on link and on close. Tab
 *  ids are the live identity (a /clear rotates the key, not the tab), but a closed tab's id is
 *  gone for good: reopening a session from the sessions panel mints a new tab. The keys are how
 *  a closed pair finds itself again (FORK 2026-09-25, the architect: close, open and list them as one). */
export type TabChain = {
  master: string;
  slave: string;
  color: number;
  masterKey?: string;
  slaveKey?: string;
};

/** Metal tints, one per concurrent loop. Index is stored on the chain so a chain keeps its
 *  colour when another one is released. */
export const CHAIN_COLORS: readonly string[] = [
  "#b8c2cc", // steel
  "#d4a94a", // brass
  "#c8743c", // copper
  "#5fb3a0", // verdigris
  "#a07ad8", // anodised violet
  "#e0909a", // rose gold
  "#5a8fd6", // blue steel
];

export function chainColor(chain: Pick<TabChain, "color">): string {
  return CHAIN_COLORS[chain.color % CHAIN_COLORS.length];
}

/** Never throws: a corrupt entry degrades to "no chains". */
export function parseChains(raw: string | null | undefined): TabChain[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || LOOP_CHAINS_DEFAULT);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TabChain[] = [];
  for (const c of parsed) {
    if (!c || typeof c !== "object") continue;
    const { master, slave, color, masterKey, slaveKey } = c as Record<string, unknown>;
    if (typeof master !== "string" || typeof slave !== "string" || master === slave) continue;
    out.push({
      master,
      slave,
      color: typeof color === "number" && color >= 0 ? color : 0,
      ...(typeof masterKey === "string" && masterKey ? { masterKey } : {}),
      ...(typeof slaveKey === "string" && slaveKey ? { slaveKey } : {}),
    });
  }
  return out;
}

export function serializeChains(chains: TabChain[]): string {
  return chains.length ? JSON.stringify(chains) : LOOP_CHAINS_DEFAULT;
}

/** Drop every chain the tab takes part in (either end). */
export function unlinkTab(chains: TabChain[], tabId: string): TabChain[] {
  return chains.filter((c) => c.master !== tabId && c.slave !== tabId);
}

/** A tab holds at most one chain, so the skill never has to guess which partner is meant.
 *  Linking replaces any chain either tab was already in. New chain takes the lowest free
 *  colour. */
export function linkTabs(chains: TabChain[], master: string, slave: string): TabChain[] {
  if (!master || !slave || master === slave) return chains;
  const kept = unlinkTab(unlinkTab(chains, master), slave);
  const used = new Set(kept.map((c) => c.color % CHAIN_COLORS.length));
  let color = 0;
  while (used.has(color) && color < CHAIN_COLORS.length) color++;
  if (color >= CHAIN_COLORS.length) color = kept.length;
  return [...kept, { master, slave, color }];
}

export function chainOf(chains: TabChain[], tabId: string): TabChain | undefined {
  return chains.find((c) => c.master === tabId || c.slave === tabId);
}

/** Next colour a new chain would get — the dangling chain in pick mode wears it already. */
export function nextChainColor(chains: TabChain[], master: string): number {
  const probe = linkTabs(chains, master, "\u0000probe");
  return probe[probe.length - 1]?.color ?? 0;
}

// ─── A chained pair behaves as one object (FORK 2026-09-25, the architect) ───
// Close one tab → both close. Open one from the sessions panel → both open, side by side.
// In the tab bar and in the sessions panel the pair is always adjacent, master first. The
// chain survives a close; only "Release chain" (or deleting a session) breaks it.

type KeyMatch = (a: string, b: string) => boolean;

/** Refresh each end's stored session key from the tabs that are open now. Ends whose tab is
 *  not open keep the key they had. */
export function withChainKeys(
  chains: TabChain[],
  keyOfTab: (tabId: string) => string | null | undefined,
): TabChain[] {
  return chains.map((c) => {
    const mk = keyOfTab(c.master) || c.masterKey;
    const sk = keyOfTab(c.slave) || c.slaveKey;
    return { ...c, ...(mk ? { masterKey: mk } : {}), ...(sk ? { slaveKey: sk } : {}) };
  });
}

/** The chain one of whose ends is this session, and which end it is. */
export function chainOfSession(
  chains: TabChain[],
  key: string,
  match: KeyMatch,
): { chain: TabChain; role: "master" | "slave"; partnerKey?: string } | undefined {
  for (const chain of chains) {
    if (chain.masterKey && match(chain.masterKey, key))
      return { chain, role: "master", partnerKey: chain.slaveKey };
    if (chain.slaveKey && match(chain.slaveKey, key))
      return { chain, role: "slave", partnerKey: chain.masterKey };
  }
  return undefined;
}

/** Point an existing chain at new tab ids (a reopened session gets a fresh tab). Keeps colour
 *  and keys; drops any other chain either new tab was in, as linkTabs would. */
export function rebindChain(
  chains: TabChain[],
  chain: TabChain,
  masterTabId: string,
  slaveTabId: string,
): TabChain[] {
  if (!masterTabId || !slaveTabId || masterTabId === slaveTabId) return chains;
  const rest = chains.filter(
    (c) =>
      !(c.master === chain.master && c.slave === chain.slave) &&
      c.master !== masterTabId &&
      c.slave !== masterTabId &&
      c.master !== slaveTabId &&
      c.slave !== slaveTabId,
  );
  return [...rest, { ...chain, master: masterTabId, slave: slaveTabId }];
}

/** Drop every chain with this session at either end (the session is being deleted). */
export function unlinkSession(chains: TabChain[], key: string, match: KeyMatch): TabChain[] {
  return chains.filter(
    (c) => !(c.masterKey && match(c.masterKey, key)) && !(c.slaveKey && match(c.slaveKey, key)),
  );
}

/** Keep every open chained pair adjacent in the tab bar, master immediately before slave.
 *  `anchorId` is the tab that just moved or was opened: its partner comes to it. Without an
 *  anchor the slave stays put and the master jumps ahead of it. A `fixed` tab (Main) never
 *  moves; its partner comes to it instead. */
export function adjacentChainOrder<T extends { id: string }>(
  tabs: readonly T[],
  chains: TabChain[],
  anchorId?: string | null,
  fixed: (id: string) => boolean = () => false,
): T[] {
  const out = tabs.slice();
  for (const c of chains) {
    const mi = out.findIndex((t) => t.id === c.master);
    const si = out.findIndex((t) => t.id === c.slave);
    if (mi < 0 || si < 0 || mi + 1 === si) continue;
    const moveSlave = fixed(c.master) || (!fixed(c.slave) && anchorId === c.master);
    if (moveSlave) {
      const [slave] = out.splice(si, 1);
      const at = out.findIndex((t) => t.id === c.master);
      out.splice(at + 1, 0, slave);
    } else {
      const [master] = out.splice(mi, 1);
      const at = out.findIndex((t) => t.id === c.slave);
      out.splice(at, 0, master);
    }
  }
  return out;
}

/** Sessions-panel order: each chain's slave row directly below its master row. The master row
 *  keeps its place; rows of other sessions keep their relative order. */
export function pairChainedRows<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pairs: Array<{ masterKey?: string; slaveKey?: string }>,
  match: KeyMatch,
): T[] {
  const out = items.slice();
  for (const p of pairs) {
    if (!p.masterKey || !p.slaveKey) continue;
    const mi = out.findIndex((it) => match(keyOf(it), p.masterKey!));
    const si = out.findIndex((it) => match(keyOf(it), p.slaveKey!));
    if (mi < 0 || si < 0 || mi + 1 === si) continue;
    const [slave] = out.splice(si, 1);
    const at = out.findIndex((it) => match(keyOf(it), p.masterKey!));
    out.splice(at + 1, 0, slave);
  }
  return out;
}

// ─── Rope physics (Verlet, pinned ends) ───

export type Pt = { x: number; y: number };
export type RopeNode = { x: number; y: number; px: number; py: number };

export const ROPE_NODES = 36;

export function createRope(a: Pt, b: Pt, n = ROPE_NODES): RopeNode[] {
  const nodes: RopeNode[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    nodes.push({ x, y, px: x, py: y });
  }
  return nodes;
}

/** Chain length for two anchors: a little longer than the gap, plus a fixed drop, so it
 *  always arcs down over the top of the chat instead of stretching tight. */
export function ropeRestLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y) * 1.08 + 70;
}

export type StepOpts = { gravity?: number; damping?: number; iterations?: number };

/** One Verlet step with both ends pinned. Returns the largest node displacement, which is
 *  what the overlay uses to decide the chain has come to rest and can freeze. */
export function stepRope(rope: RopeNode[], a: Pt, b: Pt, opts: StepOpts = {}): number {
  const gravity = opts.gravity ?? 0.45;
  const damping = opts.damping ?? 0.975;
  const iterations = opts.iterations ?? 14;
  const n = rope.length;
  const seg = ropeRestLength(a, b) / (n - 1);
  let maxMove = 0;
  for (let i = 1; i < n - 1; i++) {
    const p = rope[i];
    const vx = (p.x - p.px) * damping;
    const vy = (p.y - p.py) * damping;
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy + gravity;
  }
  for (let k = 0; k < iterations; k++) {
    rope[0].x = a.x;
    rope[0].y = a.y;
    rope[n - 1].x = b.x;
    rope[n - 1].y = b.y;
    for (let i = 0; i < n - 1; i++) {
      const p = rope[i];
      const q = rope[i + 1];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      // Rope, not rod: only pull when stretched, so slack hangs instead of pushing out.
      if (d <= seg) continue;
      const diff = (d - seg) / d / 2;
      const pinP = i === 0;
      const pinQ = i + 1 === n - 1;
      if (!pinP && !pinQ) {
        p.x += dx * diff;
        p.y += dy * diff;
        q.x -= dx * diff;
        q.y -= dy * diff;
      } else if (!pinP) {
        p.x += dx * diff * 2;
        p.y += dy * diff * 2;
      } else if (!pinQ) {
        q.x -= dx * diff * 2;
        q.y -= dy * diff * 2;
      }
    }
  }
  rope[0].px = rope[0].x = a.x;
  rope[0].py = rope[0].y = a.y;
  rope[n - 1].px = rope[n - 1].x = b.x;
  rope[n - 1].py = rope[n - 1].y = b.y;
  for (let i = 1; i < n - 1; i++) {
    const p = rope[i];
    maxMove = Math.max(maxMove, Math.abs(p.x - p.px), Math.abs(p.y - p.py));
  }
  return maxMove;
}

/** Run the rope to rest off-screen. Used when the chain snaps onto the slave: the human asked
 *  for it to freeze on attach, not to keep swinging. */
export function settleRope(rope: RopeNode[], a: Pt, b: Pt, steps = 600): void {
  for (let i = 0; i < steps; i++) {
    if (stepRope(rope, a, b, { damping: 0.8 }) < 0.01 && i > 40) break;
  }
  for (const p of rope) {
    p.px = p.x;
    p.py = p.y;
  }
}

/** Points every `spacing` px along the rope polyline, with the local tangent angle — the
 *  chain links are drawn at these, so link size stays constant whatever the rope length. */
export function samplePath(rope: Pt[], spacing: number): Array<Pt & { angle: number }> {
  const out: Array<Pt & { angle: number }> = [];
  let carry = 0;
  for (let i = 0; i < rope.length - 1; i++) {
    const p = rope[i];
    const q = rope[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len === 0) continue;
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    let t = carry;
    while (t <= len) {
      out.push({ x: p.x + ((q.x - p.x) * t) / len, y: p.y + ((q.y - p.y) * t) / len, angle });
      t += spacing;
    }
    carry = t - len;
  }
  return out;
}
