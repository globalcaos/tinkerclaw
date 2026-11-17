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
import { esc, ruleLine } from "./amygdala-html.js";
import type { RuleRow } from "./amygdala-types.js";

export interface HookAction {
  id: string;
  ts: number;
  tool: string;
  target: string;
  decision: string;
  rule: string | null;
  toolUseId: string | null;
  enforced: boolean;
  /** A hard-rule deny's owner grant code (2026-10-29): the Allow button under the reply sends "allow <grant>". */
  grant?: string | null;
}

/** Decisions that earn a bubble. `allow` (a sampled benign call) and `observe` (a rule matched, nothing done) do not. */
export const HOOK_BUBBLE_DECISIONS: ReadonlySet<string> = new Set([
  "deny",
  "owner-intent",
  "owner-pasted-secret",
  "owner-allow",
]);

/**
 * What the amygdala tells the agent when it lets a step through (FORK 2026-11-03: its own voice in place of a verb
 * label). A deny says its rule's line (rules.ts `RULE_WORDS`, through the feed).
 */
const HOOK_SAYS: Record<string, string> = {
  "owner-intent": "That was asked for. Go ahead.",
  "owner-pasted-secret": "That secret was pasted in on purpose. Keep it safe.",
  "owner-allow": "Allowed once. Go ahead.",
};

/** Longest path or name a question puts in `{target}`. */
const TARGET_MAX = 60;

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
  const grant = str(r.grant);
  return {
    id: str(r.id) ?? fallbackId(ts, toolUseId, rule),
    ts,
    tool,
    target: typeof r.target === "string" ? r.target : "",
    decision,
    rule,
    toolUseId,
    enforced: Boolean(r.enforced),
    ...(grant ? { grant } : {}),
  };
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The shared shell: pink, brain-led, addressable by bubble id and by the tool call it judged. */
function shell(
  o: { id: string; toolUseId: string | null; focused: boolean },
  inner: string,
): string {
  return (
    `<div class="amy-inline${o.focused ? " amy-focus" : ""}" data-amy-bubble="${esc(o.id)}" data-tool-use="${esc(o.toolUseId ?? "")}">` +
    `<span class="amy-inline-icon">🧠</span><div class="amy-inline-body">${inner}</div></div>`
  );
}

/** The deleted path or the secret's name a command names, for a rule's `{target}`; null when it names neither. */
export function hookTarget(rule: string, command: string): string | null {
  const re = /SECRET|CREDENTIAL/.test(rule)
    ? /([\w.-]*\.secret|\.env(?:\.[\w-]+)?|credentials[\w.-]*|id_(?:rsa|dsa|ecdsa|ed25519))\b/
    : /\b(?:rm|rmdir|unlink|shred|trash)\s+(?:-\S+\s+)*([^\s;&|]+)/;
  const m = re.exec(command);
  return m ? clip(m[1], TARGET_MAX) : null;
}

/** A fixed rule's Allow question for one command (2026-11-03); "Allow this step?" when the feed sent no words. */
export function hookAsk(rule: RuleRow | undefined, command: string): string {
  if (!rule) return "Allow this step?";
  return rule.ask.replace("{target}", hookTarget(rule.id, command) ?? rule.noun ?? "it");
}

/**
 * One hook action as a pink bubble (FORK 2026-11-03): one line in the amygdala's voice and a caret; opened, the rule
 * that fired, which opens rules.ts. The command is the tool row right above, so the bubble does not repeat it.
 */
export function renderHookBubble(
  a: HookAction,
  o: { focused: boolean; open?: boolean; rule?: RuleRow },
): string {
  const line =
    a.decision === "deny"
      ? (o.rule?.says ?? "A fixed rule stopped that.")
      : (HOOK_SAYS[a.decision] ?? a.decision);
  const note = a.enforced ? "" : `<span class="amy-jverdict amy-jv-wait">not enforced</span>`;
  const head =
    `<div class="amy-jc-head amy-jc-toggle" data-amy-act="amy-detail" data-action="${esc(a.id)}">` +
    `<span class="amy-jline">${esc(line)}</span>${note}<span class="amy-jx-more">${o.open ? "▾" : "▸"}</span></div>`;
  const name = o.rule?.explanation ?? a.rule;
  const body = o.open && name ? ruleLine({ name, file: o.rule?.file }) : "";
  return shell(
    { id: a.id, toolUseId: a.toolUseId, focused: o.focused },
    `<div class="amy-jact${o.open ? " amy-jact-open" : ""}"><div class="amy-ja-main">${head}${body}</div></div>`,
  );
}

/**
 * One Jev action as a pink bubble. `actionRowHtml` is the `renderAction` row from amygdala-jev.ts, passed through
 * unchanged (its explanation and `extra` cards keep their `data-amy-act` wiring); amy-inline.css restyles it.
 */
export function renderJevBubble(
  actionRowHtml: string,
  o: { id: string; toolUseId: string | null; focused: boolean },
): string {
  return shell(o, actionRowHtml);
}
