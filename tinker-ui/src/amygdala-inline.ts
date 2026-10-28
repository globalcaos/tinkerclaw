/**
 * Amygdala inline bubbles (FORK 2026-10-15): every action Jev performs (not the ones it skips) shows as a separate pink
 * comment in the chat, at the point where it happened.
 *
 * Two producers feed the same pink bubble: the AEGIS pre-tool-use hook (real enforcement, rows spooled to
 * hook-decisions.jsonl and broadcast as `amygdala.hook`) and Jev (amygdala2, `renderAction` rows from amygdala-jev.ts).
 * Both carry the Claude tool_use id, so app.ts can hang the bubble right under the tool row it judged.
 *
 * Pure HTML-string builders, no DOM, no inline handlers. Every dynamic string goes through `esc`.
 */
import { esc, fmtClock } from "./amygdala-html.js";

export interface HookAction {
  id: string;
  ts: number;
  tool: string;
  target: string;
  decision: string;
  rule: string | null;
  toolUseId: string | null;
  enforced: boolean;
}

/** Decisions that earn a bubble. `allow` (a sampled benign call) and `observe` (a rule matched, nothing done) do not. */
export const HOOK_BUBBLE_DECISIONS: ReadonlySet<string> = new Set([
  "deny",
  "owner-intent",
  "owner-pasted-secret",
  "owner-allow",
]);

/** Longest tool/target line a bubble shows; the full text is in the hook panel. */
const TARGET_MAX = 160;

/** The verb after AMYGDALA, per hook decision. The rule rides after "blocked" when there is one. */
const HOOK_VERBS: Record<string, string> = {
  deny: "blocked",
  "owner-intent": "let through on your words",
  "owner-pasted-secret": "stored the secret you pasted",
  "owner-allow": "let through on your allow code",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** ISO string or ms number → ms; null when neither parses. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

/**
 * Fallback id when a row arrives without one (an `amygdala.feed` row from a gateway that predates the live event):
 * FNV-1a over the same material the gateway hashes (ts + toolUseId + rule), so two reads of the same row dedupe.
 * The gateway's own `hook-<sha1>` id wins whenever present.
 */
function fallbackId(ts: number, toolUseId: string | null, rule: string | null): string {
  const s = `${ts}${toolUseId ?? ""}${rule ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hook-${h.toString(16).padStart(8, "0")}`;
}

/**
 * The feed (`amygdala.feed`) maps hook rows into the panel's decision shape: `deny` → `hard_block`, `observe` →
 * `soft_block`, anything else → `allow`, with the rule folded into `reason: "AEGIS [rule]"` and `mode: "hook"`.
 * Undo that here so a seeded feed row and a live `amygdala.hook` row produce the same bubble. A row that keeps the
 * raw hook decision (`hookDecision`, or `decision` itself) is taken as is.
 */
function rawDecision(r: Record<string, unknown>): string | null {
  const direct = str(r.hookDecision) ?? str(r.decision);
  if (!direct) return null;
  if (HOOK_BUBBLE_DECISIONS.has(direct)) return direct;
  const fromHook = r.mode === "hook" || r.signal === "aegis" || r.src === "cc-hook";
  if (fromHook && direct === "hard_block") return "deny";
  return direct;
}

function ruleOf(r: Record<string, unknown>): string | null {
  const rule = str(r.rule);
  if (rule) return rule;
  const m = /^AEGIS \[(.+)\]$/.exec(str(r.reason) ?? "");
  return m ? m[1] : null;
}

/**
 * Validate an `amygdala.hook` payload or an `amygdala.feed` row. Returns null when the row is not an object, has no
 * usable timestamp or tool, or its decision is not bubble-worthy ("the ones he skips").
 */
export function hookActionFrom(raw: unknown): HookAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const decision = rawDecision(r);
  if (!decision || !HOOK_BUBBLE_DECISIONS.has(decision)) return null;
  const ts = toMs(r.ts);
  const tool = str(r.tool);
  if (ts === null || !tool) return null;
  const toolUseId = str(r.toolUseId) ?? str(r.tool_use_id);
  const rule = ruleOf(r);
  return {
    id: str(r.id) ?? fallbackId(ts, toolUseId, rule),
    ts,
    tool,
    target: typeof r.target === "string" ? r.target : "",
    decision,
    rule,
    toolUseId,
    enforced: Boolean(r.enforced),
  };
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The shared shell: pink, brain-led, addressable by bubble id and by the tool call it judged. */
function shell(
  o: { id: string; toolUseId: string | null; focused: boolean },
  verb: string,
  inner: string,
): string {
  return (
    `<div class="amy-inline${o.focused ? " amy-focus" : ""}" data-amy-bubble="${esc(o.id)}" data-tool-use="${esc(o.toolUseId ?? "")}">` +
    `<span class="amy-inline-icon">🧠</span><div class="amy-inline-body">` +
    `<div class="amy-inline-head"><strong>AMYGDALA</strong> <em>${verb}</em></div>` +
    inner +
    `</div></div>`
  );
}

/** One hook action as a pink bubble: verb (+ rule when it blocked), then the tool and its target on one line. */
export function renderHookBubble(a: HookAction, o: { focused: boolean }): string {
  const base = HOOK_VERBS[a.decision] ?? esc(a.decision);
  const verb = a.decision === "deny" && a.rule ? `${base} · ${esc(a.rule)}` : base;
  const line = clip(a.target ? `${a.tool} ${a.target}` : a.tool, TARGET_MAX);
  const body =
    `<div class="amy-inline-line">${esc(line)}` +
    `<span class="amy-inline-time">${esc(fmtClock(a.ts))}${a.enforced ? "" : " · shadow"}</span></div>`;
  return shell({ id: a.id, toolUseId: a.toolUseId, focused: o.focused }, verb, body);
}

/**
 * One Jev action as a pink bubble. `actionRowHtml` is the `renderAction` row from amygdala-jev.ts, passed through
 * unchanged (its votes, explanation and `extra` cards keep their `data-amy-act` wiring); amy-inline.css restyles it.
 */
export function renderJevBubble(
  actionRowHtml: string,
  o: { id: string; toolUseId: string | null; focused: boolean; would: boolean },
): string {
  return shell(o, o.would ? "would have" : "acted", actionRowHtml);
}
