/**
 * FRACTAL TURN — Fractal runs as its OWN turn, after the main one (2026-10-08).
 *
 * The requirement: Fractal is a complete turn that starts after the ordinary one. Until today the doctrine rode the end of
 * every prompt he typed, and the SAME reply wrote the 🌿 FRACTAL section as its last lines. That
 * reflection could read the trail (it was in context) but could not act on it: in Tinker a text
 * block followed by a tool call paints as a folded "Thinking" row, so any write had to happen
 * BEFORE the answer, and a friction it noticed (2026-10-08: ~20 tool calls to reach Factorial,
 * two bare MCP failures, five probe rounds) ended as a footnote instead of a fixed skill.
 *
 * Now the page sends a second prompt into the SAME session when the main run ends:
 *   - same session → every tool call and result of the turn is in the model's context;
 *   - a turn of its own → it has every tool, and whatever it writes is Fractal's, plainly;
 *   - a TRAIL DIGEST the model cannot see otherwise: tokens per turn, duration, tool errors.
 *
 * Its idempotencyKey is `fractal-<parent runId>`. chat.send uses that key AS the run id
 * (src/gateway/server-methods/chat.ts: `const clientRunId = p.idempotencyKey`), so the call
 * timeline tells a Fractal run from the run it reflects on with no extra channel, and the
 * gateway's durable dedupe (transcriptHasIdempotencyKey) makes two open tabs fire it once.
 *
 * 2026-10-09 — IN THE BACKGROUND. Requirement: the Fractal turn runs in the background without
 * holding up the next prompt, its prompt stays hidden, and it remains reviewable through the small
 * link shown on each prompt. Sent into the SAME session,
 * the reflection held that session busy and his next prompt queued behind it, and its 40 KB prompt
 * drew as a blue bubble. It now goes to a session of its own, `agent:<id>:fractal:<P>`, which runs
 * beside the chat. The bridge starts that session as a FORK of the chat's CLI conversation
 * (tinker-bridge fork-parent.ts: run `fractal-<P>` copies the session that served run P), so the
 * whole trail is still in context, and nothing the reflection does lands in the chat's own
 * conversation. The page draws its last text as a folded 🌿 card under the reply (fractal-card.ts);
 * the prompt itself shows nowhere, only the `🌿 fractal prompt ↗` link on the owner's bubble.
 *
 * 2026-10-09 — FRACTAL v2 (charter ~/Documents/AI_reports/Fractal-census/build-fractal-v2/charter.md).
 * The census found two thirds of 2,675 reflections changed nothing, and every call sent 49.5k chars
 * of doctrine. Now a gate decides first (`fractal.gate`: rules always, Jev when a token exists; the
 * page fires anyway when the gate is missing or fails), the prompt carries a short core plus only
 * the chapters for the triggers the gate found, under a neutral seam, and the turn runs on the model
 * the reflected run used so its first call reads the chat's cache.
 *
 * Pure: no DOM, no network. app.ts owns the wiring (armFractalTurn at send, fireFractalTurn on
 * the run's final).
 */

import { FRACTAL_DOCTRINE_SEAM_MARKER } from "./fractal-prompt-strip.js";
import { fractalRunIdFor, fractalParentOf, isFractalRunId } from "./fractal-run-id.js";
import type { CallTimelineStore } from "./panels/call-timeline.js";
import { fmtDuration, outputTotal } from "./panels/call-timeline.js";
import { fmtTokens } from "./panels/context-cache.js";
import type { TerminalScope } from "./queued-sends.js";

export { FRACTAL_RUN_PREFIX } from "./fractal-run-id.js";
export { FRACTAL_DOCTRINE_SEAM_MARKER };
export { fractalRunIdFor, fractalParentOf, isFractalRunId };

// ─── Arming: which prompts get a Fractal turn ───

/**
 * localStorage, not memory: a rebuild pushes a reload into the middle of long turns, and the
 * reloaded page still receives the run's final. Shared by the tabs of one origin, which is fine:
 * a second tab firing the same key draws the gateway's dedupe echo and starts nothing.
 */
export const FRACTAL_ARMED_KEY = "tinker.fractal.armed";
/** An arm older than this is dropped: no turn runs six hours. */
export const FRACTAL_ARM_TTL_MS = 6 * 60 * 60_000;
/** Late frames (effort final, the last `call` end) land after the chat final; wait for them. */
export const FRACTAL_FIRE_DELAY_MS = 1_500;

/**
 * FORK 2026-10-09 (Fractal v2, charter C1) — the gate reads what the owner asked ("why did you…",
 * "I don't see it"), and by the time the run ends the page may have reloaded. The arm keeps the
 * prompt text, cut to this length, beside the session key.
 */
export const FRACTAL_GATE_TEXT_MAX = 4_000;

type ArmedMap = Record<string, { sessionKey: string; at: number; prompt?: string }>;

function readArmed(storage: Storage): ArmedMap {
  try {
    const raw = storage.getItem(FRACTAL_ARMED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as ArmedMap) : {};
  } catch {
    return {};
  }
}

function writeArmed(storage: Storage, map: ArmedMap, now: number): void {
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v.at !== "number" || now - v.at > FRACTAL_ARM_TTL_MS) {
      delete map[k];
    }
  }
  try {
    storage.setItem(FRACTAL_ARMED_KEY, JSON.stringify(map));
  } catch {
    /* a full or blocked storage costs one reflection, never the send */
  }
}

/**
 * Record that the run `runId` (a prompt's idempotencyKey) wants a Fractal turn when it ends.
 * `prompt` is what the owner typed; the gate reads its first FRACTAL_GATE_TEXT_MAX characters.
 */
export function armFractalTurn(
  storage: Storage,
  runId: string,
  sessionKey: string,
  now: number,
  prompt?: string,
): void {
  if (!runId || !sessionKey || isFractalRunId(runId)) {
    return;
  }
  const map = readArmed(storage);
  const text = typeof prompt === "string" ? prompt.trim().slice(0, FRACTAL_GATE_TEXT_MAX) : "";
  map[runId] = { sessionKey, at: now, ...(text ? { prompt: text } : {}) };
  writeArmed(storage, map, now);
}

/**
 * Remove and return the arm for `runId`, or null when that run wants no Fractal turn. `armedAt` is
 * when the prompt was sent: a page loaded after it saw only part of the turn.
 */
export function takeFractalArm(
  storage: Storage,
  runId: string,
  now: number,
): { sessionKey: string; armedAt: number; prompt?: string } | null {
  const map = readArmed(storage);
  const hit = map[runId];
  if (!hit) {
    return null;
  }
  delete map[runId];
  writeArmed(storage, map, now);
  if (now - hit.at > FRACTAL_ARM_TTL_MS) {
    return null;
  }
  const prompt = typeof hit.prompt === "string" && hit.prompt ? hit.prompt : undefined;
  return { sessionKey: hit.sessionKey, armedAt: hit.at, ...(prompt ? { prompt } : {}) };
}

/**
 * The Fractal a chat terminal starts, with the arms it consumes; null when it starts none.
 *
 * 2026-10-09: a prompt the gateway folds into a running turn (`steered`) or queues behind it
 * (`backlogged`) gets an early final of its own, and that final ends no run. Firing on it started a
 * Fractal while the turn was still running, with no CLI session to fork: tinker:mue2cvin 14:41,
 * prompt d24d2933, a blind reflection beside the turn's own Fractal. A steered prompt is part of
 * the turn it joined, which has its own Fractal. A backlogged one runs as a linked follow-up run,
 * whose terminal fires here with the arms of the prompts it answers (`promptKeys`).
 */
export function takeFractalArmForTerminal(
  storage: Storage,
  runId: string,
  scope: TerminalScope | null,
  now: number,
): { sessionKey: string; promptKeys: string[]; armedAt: number; prompt?: string } | null {
  if (!runId || scope?.kind === "prompt") {
    return null;
  }
  const own = takeFractalArm(storage, runId, now);
  let sessionKey = own?.sessionKey;
  let armedAt = own?.armedAt;
  const promptKeys: string[] = [];
  // A follow-up run answers every prompt it took, so the gate reads them all, in order.
  const prompts: string[] = own?.prompt ? [own.prompt] : [];
  if (scope?.kind === "linked") {
    for (const key of scope.keys) {
      const arm = key === runId ? null : takeFractalArm(storage, key, now);
      if (arm) {
        promptKeys.push(key);
        sessionKey ??= arm.sessionKey;
        armedAt = Math.min(armedAt ?? arm.armedAt, arm.armedAt);
        if (arm.prompt) {
          prompts.push(arm.prompt);
        }
      }
    }
  }
  if (!sessionKey || armedAt === undefined) {
    return null;
  }
  const prompt = prompts.join("\n\n").slice(0, FRACTAL_GATE_TEXT_MAX);
  return { sessionKey, promptKeys, armedAt, ...(prompt ? { prompt } : {}) };
}

// ─── Its own session: beside the chat, never in it (2026-10-09) ───

/** `:fractal` keys already sit in the collapsed "Reflections" group of the session list. */
export const FRACTAL_SESSION_SEGMENT = ":fractal:";

/** The session the Fractal turn for prompt run `parentRunId` runs in. Same agent as the chat. */
export function fractalSessionKeyFor(parentSessionKey: string, parentRunId: string): string {
  const parts = parentSessionKey.split(":");
  const root = parts[0] === "agent" && parts[1] ? `agent:${parts[1]}` : "agent:main";
  return `${root}${FRACTAL_SESSION_SEGMENT}${parentRunId}`;
}

/** The prompt run a Fractal session reflects on, or null for any other session key. */
export function fractalParentRunOfSessionKey(key: unknown): string | null {
  if (typeof key !== "string") {
    return null;
  }
  const at = key.indexOf(FRACTAL_SESSION_SEGMENT);
  if (at < 0) {
    return null;
  }
  const run = key.slice(at + FRACTAL_SESSION_SEGMENT.length);
  return run && !run.includes(":") ? run : null;
}

// ─── The trail digest: what the page measured and the model cannot see ───

export interface FractalTrail {
  calls: number;
  /** Tokens the calls SENT (billed prompt, summed over calls). */
  tokensIn: number;
  /** Tokens the calls got back. */
  tokensOut: number;
  durationMs?: number;
  tools: Array<{ name: string; isError?: boolean; ms?: number }>;
}

/** The parent run's trail as the call timeline recorded it, or null when it recorded nothing. */
export function trailFromStore(store: CallTimelineStore, runId: string): FractalTrail | null {
  const calls = store.calls.filter((c) => c.runId === runId && !c.historic);
  const tools = store.tools.filter((t) => t.runId === runId);
  const turn = store.turns.find((t) => t.runId === runId);
  if (calls.length > 0 && tools.length === 0 && store.tools.length > 0) {
    // Bug fractal-digest-no-tools (2026-10-09): a cc-bridge turn with 14 Bash calls got "No tool calls".
    // Name the run ids on both sides so the next sighting says whether the tools carry another runId.
    console.warn("[fractal-turn] trail has calls but no tools", {
      runId,
      toolRunIds: [...new Set(store.tools.map((t) => t.runId))].slice(-5),
    });
  }
  if (calls.length === 0 && tools.length === 0) {
    return null;
  }
  let tokensIn = 0;
  let tokensOut = 0;
  for (const c of calls) {
    tokensIn += c.stack.total;
    tokensOut += outputTotal(c);
  }
  const end = turn?.end ?? Math.max(0, ...calls.map((c) => c.endAt ?? c.lastEventAt));
  const start = turn?.tickAt ?? Math.min(...calls.map((c) => c.sendAt));
  return {
    calls: calls.length,
    tokensIn,
    tokensOut,
    durationMs: Number.isFinite(start) && end > start ? end - start : undefined,
    tools: tools.map((t) => ({
      name: t.name,
      isError: t.isError,
      ms: t.end !== undefined ? t.end - t.start : undefined,
    })),
  };
}

/** A tool seen this many times in one turn is worth a look: a probe loop or a retry. */
export const REPEAT_FLAG = 4;

/** The digest lines, plain and short. Order: cost, tools, errors, repeats, the slowest tool. */
export function trailDigestLines(
  trail: FractalTrail | null,
  opts: { seenFrom?: number } = {},
): string[] {
  // 2026-10-09: a rebuild reloaded the page mid-turn twice, and the digest reported "3 model
  // calls, 15 s, No tool calls" for a nine-minute turn with dozens of calls. The Fractal took it
  // at its word. A page that loaded after the prompt was sent now says so first.
  const partial =
    opts.seenFrom !== undefined
      ? [
          `- This page loaded in the middle of the turn (${new Date(opts.seenFrom).toTimeString().slice(0, 8)}), ` +
            "so the numbers below cover only what it saw after that. The trail in your context is the full record.",
        ]
      : [];
  if (!trail) {
    return [
      ...partial,
      "- The page recorded no per-call data for that turn (history, or a reloaded page).",
    ];
  }
  const out: string[] = [...partial];
  const cost = [
    `${trail.calls} model call${trail.calls === 1 ? "" : "s"}`,
    `${fmtTokens(Math.round(trail.tokensIn))} tokens sent`,
    `${fmtTokens(Math.round(trail.tokensOut))} back`,
  ];
  if (trail.durationMs !== undefined) {
    cost.push(fmtDuration(trail.durationMs));
  }
  out.push(`- ${cost.join(", ")}`);
  const byName = new Map<string, { n: number; err: number }>();
  for (const t of trail.tools) {
    const row = byName.get(t.name) ?? { n: 0, err: 0 };
    row.n++;
    if (t.isError) {
      row.err++;
    }
    byName.set(t.name, row);
  }
  if (byName.size === 0) {
    out.push("- No tool calls.");
    return out;
  }
  const rows = [...byName.entries()].sort((a, b) => b[1].n - a[1].n);
  const errors = trail.tools.filter((t) => t.isError).length;
  out.push(
    `- ${trail.tools.length} tool call${trail.tools.length === 1 ? "" : "s"}: ` +
      rows.map(([name, r]) => `${name} ×${r.n}${r.err ? ` (${r.err} failed)` : ""}`).join(", "),
  );
  out.push(
    errors > 0
      ? `- ${errors} tool call${errors === 1 ? "" : "s"} failed. Each failure is friction the next run of this task will pay again.`
      : "- No tool call failed.",
  );
  const repeated = rows.filter(([, r]) => r.n >= REPEAT_FLAG);
  if (repeated.length > 0) {
    out.push(
      `- Repeated ${REPEAT_FLAG}+ times: ${repeated.map(([n, r]) => `${n} ×${r.n}`).join(", ")}. A probe loop or a retry? Then the skill is missing the direct path.`,
    );
  }
  const slowest = trail.tools
    .filter((t) => t.ms !== undefined)
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0];
  if (slowest?.ms !== undefined && slowest.ms >= 30_000) {
    out.push(`- Slowest tool call: ${slowest.name}, ${fmtDuration(slowest.ms)}.`);
  }
  return out;
}

// ─── The gate: does this turn deserve a reflection? (Fractal v2, charter C1) ───
//
// FORK 2026-10-09 — two thirds of 2,675 reflections changed nothing (Fractal census, 10-09). The
// gateway's `fractal.gate` decides from rules (always) and Jev (when a token exists); the page only
// hands it what it measured and what was said. A gate that is missing or fails never costs a
// reflection: the page fires as before (fail open).

export type FractalTrigger = "correction" | "friction" | "delivery" | "channel";
export const FRACTAL_TRIGGERS: readonly FractalTrigger[] = [
  "correction",
  "friction",
  "delivery",
  "channel",
];

export interface FractalGateTrail {
  calls: number;
  toolCalls: number;
  toolErrors: number;
  /** Tool names seen REPEAT_FLAG or more times. */
  repeated: string[];
  tools: Array<{ name: string; n: number; err: number }>;
  durationMs?: number;
}

export interface FractalGateParams {
  sessionKey: string;
  parentRunId: string;
  prompt: string;
  reply: string;
  trail: FractalGateTrail;
}

export interface FractalGateResult {
  fire: boolean;
  triggers: FractalTrigger[];
  source: "jev" | "rules";
  reasons: string[];
  probs?: Record<string, number>;
}

/** The C1 trail, from the digest's trail (null: the page recorded nothing, so all zero). */
export function gateTrailOf(trail: FractalTrail | null): FractalGateTrail {
  const byName = new Map<string, { n: number; err: number }>();
  for (const t of trail?.tools ?? []) {
    const row = byName.get(t.name) ?? { n: 0, err: 0 };
    row.n++;
    if (t.isError) {
      row.err++;
    }
    byName.set(t.name, row);
  }
  const tools = [...byName.entries()]
    .map(([name, r]) => ({ name, n: r.n, err: r.err }))
    .toSorted((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return {
    calls: trail?.calls ?? 0,
    toolCalls: trail?.tools.length ?? 0,
    toolErrors: tools.reduce((sum, t) => sum + t.err, 0),
    repeated: tools.filter((t) => t.n >= REPEAT_FLAG).map((t) => t.name),
    tools,
    ...(trail?.durationMs !== undefined ? { durationMs: trail.durationMs } : {}),
  };
}

/**
 * The `fractal.gate` params for one finished prompt run: the timeline's record of the run, the
 * owner's prompt (its HEAD) and the reply (its TAIL, where a turn says what it did), each cut to
 * FRACTAL_GATE_TEXT_MAX. Nothing else leaves the page (charter C1: no private data beyond these).
 */
export function fractalGateParams(opts: {
  store: CallTimelineStore;
  sessionKey: string;
  parentRunId: string;
  prompt?: string;
  reply?: string;
}): FractalGateParams {
  const reply = (opts.reply ?? "").trim();
  return {
    sessionKey: opts.sessionKey,
    parentRunId: opts.parentRunId,
    prompt: (opts.prompt ?? "").trim().slice(0, FRACTAL_GATE_TEXT_MAX),
    reply: reply.length > FRACTAL_GATE_TEXT_MAX ? reply.slice(-FRACTAL_GATE_TEXT_MAX) : reply,
    trail: gateTrailOf(trailFromStore(opts.store, opts.parentRunId)),
  };
}

/** The gate's answer, or null when it is not one (the caller then fires, as before). */
export function parseFractalGateResult(res: unknown): FractalGateResult | null {
  const r = res as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.fire !== "boolean") {
    return null;
  }
  // The gate's order (the chapters follow it), once each; an unknown name has no chapter, dropped.
  const triggers: FractalTrigger[] = [];
  for (const t of Array.isArray(r.triggers) ? r.triggers : []) {
    if ((FRACTAL_TRIGGERS as readonly unknown[]).includes(t) && !triggers.includes(t)) {
      triggers.push(t as FractalTrigger);
    }
  }
  const reasons = Array.isArray(r.reasons)
    ? r.reasons.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  return {
    fire: r.fire,
    triggers,
    source: r.source === "jev" ? "jev" : "rules",
    reasons,
    ...(r.probs && typeof r.probs === "object" ? { probs: r.probs as Record<string, number> } : {}),
  };
}

/** The text of a chat final's message: a string, or its text blocks joined. */
export function replyTextOf(message: unknown): string {
  const m = message as { content?: unknown; text?: unknown } | null;
  if (!m || typeof m !== "object") {
    return typeof message === "string" ? message : "";
  }
  const content = m.content ?? m.text;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t.trim() !== "")
    .join("\n\n");
}

/**
 * The model the Fractal turn is sent with (charter M2): the chat's explicit pin when it has one,
 * else the model the reflected run actually used, as `provider/model` so the route is the same one
 * (a bare id could resolve to another provider and lose the cache). Undefined: send none, as before.
 */
export function fractalModelFor(opts: {
  pin?: string;
  run?: { model: string; provider?: string };
}): string | undefined {
  if (opts.pin) {
    return opts.pin;
  }
  const model = opts.run?.model;
  if (!model) {
    return undefined;
  }
  const provider = opts.run?.provider;
  return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

// ─── The message ───

/**
 * The seam the 2026-10-08/09 pages wrote. Kept LITERAL on purpose: six consumers found the doctrine
 * by it (effort-allocator.ts, appended-prompt-blocks.ts, enhancement-text.ts, amygdala situation.ts,
 * tinker-bridge cli-command.ts, and this page's fractal-prompt-strip.ts), and old transcripts keep it,
 * so every consumer still recognises it beside the new one.
 */
export const FRACTAL_TURN_SEAM_LEGACY =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section**";

/**
 * FORK 2026-10-09 (Fractal v2, charter C4/P4) — the seam new prompts carry. Neutral: the Fractal is
 * a turn of its own, so "after your reply" no longer describes it.
 */
export const FRACTAL_TURN_SEAM = `\n\n---\n\n${FRACTAL_DOCTRINE_SEAM_MARKER}\n`;

/** `Triggers: friction, correction — <reasons>`, the line the bridge's ledger parses (charter C2). */
export function fractalTriggersLine(
  triggers: readonly FractalTrigger[],
  reasons: readonly string[],
): string {
  const why = reasons
    .map((r) => r.trim())
    .filter(Boolean)
    .join("; ");
  if (triggers.length === 0) {
    // No `Triggers:` prefix: the ledger reads none, and the model still learns why it runs.
    return why ? `Why this reflection runs: ${why}` : "";
  }
  return `Triggers: ${triggers.join(", ")}${why ? ` — ${why}` : ""}`;
}

export function buildFractalTurnMessage(opts: {
  ordinal: number;
  digest: readonly string[];
  /** The chat the reflected turn ran in; the owner keeps talking there meanwhile. */
  parentSessionKey: string;
  /** The short core doctrine (fractal-doctrine.generated.ts FRACTAL_DOCTRINE_CORE). */
  core: string;
  /** One chapter per trigger; a missing or empty chapter is skipped. */
  chapters?: Partial<Record<FractalTrigger, string>>;
  /** What the gate found, in its order. Empty when the gate said nothing (absent or failed). */
  triggers?: readonly FractalTrigger[];
  reasons?: readonly string[];
}): string {
  const which = opts.ordinal > 0 ? ` · prompt ${opts.ordinal}` : "";
  const triggers = opts.triggers ?? [];
  const triggersLine = fractalTriggersLine(triggers, opts.reasons ?? []);
  const chapters = triggers.map((t) => (opts.chapters?.[t] ?? "").trim()).filter((c) => c !== "");
  return (
    `⟦AGENT:🌿 Fractal${which}⟧ The turn above is finished. This is its Fractal reflection: ` +
    "a turn of its own, with every tool, running in the BACKGROUND on a copy of that conversation. " +
    `The owner is not waiting for it and keeps talking in ${opts.parentSessionKey}. He does not see ` +
    "this prompt: the page shows your last text block folded under the reply it reflects on. No " +
    "**Jarvis:** line and no voice call, this turn is not spoken. The whole trail of that turn is in " +
    "your context; if it is not (the copy failed), read it first with sessions_history on " +
    `${opts.parentSessionKey}. Your whole answer in this turn is the 🌿 FRACTAL section: act first ` +
    "with tools, then write it as your LAST text block, naming every path you changed and every " +
    "commit you made (the page checks each one).\n\n" +
    "What the page measured for the turn above:\n" +
    opts.digest.join("\n") +
    (triggersLine ? `\n\n${triggersLine}` : "") +
    FRACTAL_TURN_SEAM +
    opts.core.trim() +
    chapters.map((c) => `\n\n${c}`).join("")
  );
}
