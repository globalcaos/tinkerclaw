/**
 * FORK 2026-10-09: the Fractal trigger gate's rules and decision (Fractal v2 charter, contract C1, mechanism M1).
 *
 * WHY. The 2026-10-09 census counted 2,675 reflections; two in three changed nothing. A background Fractal now fires only
 * when the turn shows a reason to reflect: the owner corrected or questioned earlier work (`correction`), the turn fought
 * its tools (`friction`), a long piece of work was delivered (`delivery`), or the owner says he did not see or get
 * something (`channel`).
 *
 * This module is pure: no I/O, no clock, no Jev. The rules here are the ship path, what a fresh clone with no Jev token
 * runs, and they always count even when Jev answers. Jev's half (`gate-jev.ts`) adds `delivery` and catches what the
 * patterns miss; `decideFractalGate` merges the two.
 */

export type FractalTrigger = "correction" | "friction" | "delivery" | "channel";

/** Canonical order: the result lists triggers in this order, and the prompt's chapters follow it. */
export const FRACTAL_TRIGGERS: readonly FractalTrigger[] = [
  "correction",
  "friction",
  "delivery",
  "channel",
];

export type FractalTrail = {
  calls: number;
  toolCalls: number;
  toolErrors: number;
  /** Tool names seen 4 or more times in the turn. */
  repeated: string[];
  tools: Array<{ name: string; n: number; err: number }>;
  durationMs?: number;
};

export type FractalGateParams = {
  sessionKey: string;
  parentRunId: string;
  /** The owner's prompt, at most 4000 chars. */
  prompt: string;
  /** The tail of the final reply, at most 4000 chars. */
  reply: string;
  trail: FractalTrail;
};

export type FractalGateResult = {
  fire: boolean;
  triggers: FractalTrigger[];
  source: "jev" | "rules";
  /** Short and human: they end up on the Fractal prompt's `Triggers:` line. */
  reasons: string[];
  probs?: Record<string, number>;
};

/** Prompt and reply are cut to this before anything reads them (and before Jev sees them). */
export const FRACTAL_GATE_MAX_TEXT = 4000;
/**
 * A turn with this many tool calls is a long turn: the rules' `delivery`, counted whatever Jev says.
 * FORK 2026-10-26: Fractal should build skills and recipes that make the next turn faster whenever a turn
 * spent many tokens working something out: a costly turn is what the
 * doctrine's "Make the next run cheaper" step reads, so Jev may not skip it.
 */
export const LONG_TURN_TOOL_CALLS = 25;
/** A Jev `noul` at or above this is a trigger. */
// FORK 2026-10-10 (the architect: a LOW bar, more false alarms accepted so fewer reflections are missed): 0.4 / 0.25, worth from small.
export const JEV_TRIGGER_PROB = 0.4;
/** A trigger only weak words found ("again", one tool error) fires when Jev agrees this much. */
export const JEV_WEAK_CONFIRM_PROB = 0.25;
export const WORTH_LEVELS = ["nothing", "small", "clear", "high"] as const;
export type WorthLevel = (typeof WORTH_LEVELS)[number];
/** `worth` at one of these fires the reflection even with no trigger. */
const FIRING_WORTH: ReadonlySet<WorthLevel> = new Set(["small", "clear", "high"]);

// --- params ----------------------------------------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Read the RPC params without trusting them: a missing or malformed field reads as empty, never throws. Prompt keeps its
 * head, reply its tail (it is already "the tail of the final reply"), both cut to 4000 chars.
 */
export function normalizeFractalGateParams(raw: unknown): FractalGateParams {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const t = p.trail && typeof p.trail === "object" ? (p.trail as Record<string, unknown>) : {};
  const prompt = str(p.prompt).slice(0, FRACTAL_GATE_MAX_TEXT);
  const replyRaw = str(p.reply);
  const reply =
    replyRaw.length > FRACTAL_GATE_MAX_TEXT ? replyRaw.slice(-FRACTAL_GATE_MAX_TEXT) : replyRaw;
  const repeated = Array.isArray(t.repeated)
    ? t.repeated.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const tools = Array.isArray(t.tools)
    ? t.tools.flatMap((x) => {
        if (!x || typeof x !== "object") {
          return [];
        }
        const r = x as Record<string, unknown>;
        const name = str(r.name);
        return name ? [{ name, n: num(r.n), err: num(r.err) }] : [];
      })
    : [];
  const trail: FractalTrail = {
    calls: num(t.calls),
    toolCalls: num(t.toolCalls),
    toolErrors: num(t.toolErrors),
    repeated,
    tools,
  };
  if (num(t.durationMs) > 0) {
    trail.durationMs = num(t.durationMs);
  }
  return {
    sessionKey: str(p.sessionKey),
    parentRunId: str(p.parentRunId),
    prompt,
    reply,
    trail,
  };
}

// --- the owner's words -----------------------------------------------------------------------------------------------

/** The web chat's header in front of a relayed prompt: `Sender (untrusted metadata):` and a fenced JSON block. */
const SENDER_BLOCK = /^\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/;
/** `[Thu 2026-10-01 08:52 GMT+2]` and `[Day …]`. */
const DATE_STAMP = /^\s*\[(?:Day\b|[A-Z][a-z]{2}\b)[^\]\n]*\]\s*/;
/**
 * Blocks appended after the owner's words. Both Fractal seams count (C4): old transcripts carry the "After your reply"
 * literal, new prompts the neutral marker. The old doctrine says "again" many times; read as the owner's, it made every
 * armed prompt look like a correction (J7's joke gate, 619 of 619, 2026-10-09).
 */
const APPENDED_BLOCKS = [
  /\n\s*-{3,}\s*\n+\s*\*\*After your reply, append a 🌿 FRACTAL/,
  /\n\s*-{3,}\s*\n+\s*⟦FRACTAL-DOCTRINE⟧/,
  /⟦FRACTAL-DOCTRINE⟧/,
  /\n\s*<!-- TINKERCLAW chat-row contract -->/,
];

/** A prompt an agent or a job wrote into the chat (`⟦AGENT:…⟧`): not the owner speaking. */
export function isAgentPrompt(prompt: string): boolean {
  return /^\s*⟦AGENT:/.test(prompt.replace(SENDER_BLOCK, "").replace(DATE_STAMP, ""));
}

/**
 * The owner's own words: the stamp, the sender header and the appended blocks taken off, HTML comments dropped. The same
 * cuts as the amygdala's `stripWrapper` (an extension, so core cannot import it), plus the new seam marker.
 */
export function ownerWords(prompt: string): string {
  let s = prompt;
  for (const re of APPENDED_BLOCKS) {
    const m = re.exec(s);
    if (m) {
      s = s.slice(0, m.index);
    }
  }
  for (;;) {
    const next = s.replace(SENDER_BLOCK, "").replace(DATE_STAMP, "");
    if (next === s) {
      break;
    }
    s = next;
  }
  return s.replace(/<!--[\s\S]*?-->/g, " ").trim();
}

/** Lower case, accents off, curly apostrophes straight: "No és això" and "no es aixo" read the same. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase();
}

// Patterns run on folded text (lower case, no accents). `\b` is ASCII-only, which is fine once accents are gone.
const CORRECTION_PATTERNS: readonly RegExp[] = [
  // English
  /\byou should(?:n't| not)? have\b/,
  /\bwhy (?:did|didn't|did not|do|don't|are|would|have|haven't) you\b/,
  /\b(?:that|this|it)(?:'s| is| was) (?:wrong|not right|incorrect|not it|not what i)/,
  /\bnot what i (?:asked|wanted|meant|said)\b/,
  /\bi (?:was not|wasn't|am not|'m not|did not|didn't) (?:asking|ask)\b/,
  /\bdid you (?:finish|remember|forget|check|test|read|verify|actually)\b/,
  /\byou (?:forgot|missed|ignored|skipped|broke)\b/,
  /\b(?:doesn't|does not|didn't|did not|still not|isn't|is not) (?:work|working|fixed)\b/,
  // Spanish
  /\b(?:otra vez|de nuevo|una vez mas)\b/,
  /\bno (?:es|era) (?:eso|esto|lo que)\b/,
  /\bpor que (?:has|no has|hiciste|no hiciste|lo has|me has)\b/,
  /\bdeberias haber\b/,
  /\b(?:te (?:he )?dije|ya te dije|te he dicho)\b/,
  /\b(?:sigue sin|sigue igual)\b/,
  /\b(?:esta mal|no funciona|no ha funcionado)\b/,
  /\b(?:te has olvidado|te olvidaste|olvidaste|se te ha olvidado)\b/,
  /\bno te (?:he )?(?:pedi|pedido)\b/,
  /\bhas (?:terminado|acabado|comprobado|revisado)\b/,
  // Catalan
  /\b(?:un altre cop|una altra vegada)\b/,
  /\bno (?:es|era) (?:aixo|el que)\b/,
  /\bper que (?:has|no has|ho has|m'has)\b/,
  /\bhauries d'haver\b/,
  /\bt'he dit\b/,
  /\b(?:t'has oblidat|has oblidat|se t'ha oblidat)\b/,
  /\b(?:esta malament|no ha funcionat|segueix sense)\b/,
  /\bno t'he (?:demanat|preguntat)\b/,
  /\bhas (?:acabat|comprovat|revisat)\b/,
];

// FORK 2026-10-09 — WEAK words: "is it still running?", "try again", "encara no" are ordinary questions far more often
// than corrections. They fire on their own only when Jev cannot be asked (fail open); with Jev they need its agreement
// at JEV_WEAK_CONFIRM_PROB (decideFractalGate).
const WEAK_CORRECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:again|still)\b/,
  /\b(?:todavia|aun no)\b/,
  /\bencara\b/,
];

const CHANNEL_PATTERNS: readonly RegExp[] = [
  // English
  /\b(?:don't|do not|can't|cannot|can not|didn't|did not) see\b/,
  /\bi see nothing\b/,
  /\b(?:not|doesn't|does not|didn't|did not|won't|isn't|is not|wasn't|was not) (?:render|rendering|rendered)\b/,
  // Not a bare "not show": "do not show the diff" is an instruction, not a complaint.
  /\b(?:doesn't|does not|didn't|did not|won't|isn't|is not|wasn't|was not) (?:show|showing|shown|display|displaying|displayed|load|loading|loaded|appear|appearing|appeared)\b/,
  /\bnot (?:showing|displaying|loading|appearing)\b/,
  /\b(?:didn't|did not|haven't|have not|never) (?:get|got|receive|received|arrive|arrived)\b/,
  /\bnothing (?:shows|showed|appears|appeared|arrived|came)\b/,
  // Spanish
  /\bno (?:lo |la |los |las )?veo\b/,
  /\bno (?:me )?(?:ha llegado|han llegado|llega|llego)\b/,
  /\bno (?:lo |la |los |las )?(?:he |hemos )?recibido\b/,
  /\bno recibo\b/,
  /\bno se (?:ve|muestra|renderiza|carga)\b/,
  /\bno (?:aparece|sale)\b/,
  // Catalan
  /\bno (?:ho |la |el |les |els )?veig\b/,
  /\bno (?:m'ha arribat|m'arriba|ha arribat|han arribat|arriba)\b/,
  /\bno (?:he )?rebut\b/,
  /\bno es (?:veu|mostra|carrega)\b/,
  /\bno (?:apareix|surt)\b/,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      return m[0];
    }
  }
  return undefined;
}

/** The phrase that makes the prompt a correction of earlier work, if any (strong words first, then weak ones). */
export function matchCorrection(prompt: string): string | undefined {
  return matchCorrectionStrength(prompt)?.text;
}

/** The correction phrase and whether only a weak word ("again", "still", "encara") found it. */
export function matchCorrectionStrength(
  prompt: string,
): { text: string; weak: boolean } | undefined {
  const folded = fold(ownerWords(prompt));
  const strong = firstMatch(folded, CORRECTION_PATTERNS);
  if (strong) {
    return { text: strong, weak: false };
  }
  const weak = firstMatch(folded, WEAK_CORRECTION_PATTERNS);
  return weak ? { text: weak, weak: true } : undefined;
}

/** The phrase that says the owner did not see, receive or get something rendered, if any. */
export function matchChannel(prompt: string): string | undefined {
  return firstMatch(fold(ownerWords(prompt)), CHANNEL_PATTERNS);
}

// --- rules -------------------------------------------------------------------------------------------------------------

export type FractalRulesRead = {
  /** Always counted. */
  triggers: FractalTrigger[];
  /** Found only by weak evidence (a bare "again"/"still", one tool error): counted without Jev, or when Jev agrees. */
  weak: FractalTrigger[];
  /** `delivery` from the long-turn rule: always counted (2026-10-26, see LONG_TURN_TOOL_CALLS). */
  longTurn: boolean;
  reasons: string[];
  longTurnReason?: string;
};

export function fractalGateRules(p: FractalGateParams): FractalRulesRead {
  const triggers = new Set<FractalTrigger>();
  const weak = new Set<FractalTrigger>();
  const reasons: string[] = [];
  const agent = isAgentPrompt(p.prompt);
  if (!agent) {
    const corr = matchCorrectionStrength(p.prompt);
    if (corr) {
      (corr.weak ? weak : triggers).add("correction");
      reasons.push(
        `the prompt questions earlier work ("${corr.text}"${corr.weak ? ", weak" : ""})`,
      );
    }
  }
  const t = p.trail;
  if (t.toolErrors >= 1 || t.repeated.length > 0) {
    // One failed call in a long turn (a grep with no match) is weak; two, or a probe loop, is friction.
    // 2026-10-10: a tool used 4+ times is normal work (4 Bash calls in a 3-min turn fired friction), so a repeat alone is weak.
    (t.toolErrors >= 2 ? triggers : weak).add("friction");
    const bits: string[] = [];
    if (t.toolErrors >= 1) {
      bits.push(`${t.toolErrors} tool error${t.toolErrors === 1 ? "" : "s"}`);
    }
    if (t.repeated.length > 0) {
      bits.push(`repeated ${t.repeated.slice(0, 3).join(", ")}`);
    }
    reasons.push(bits.join(", "));
  }
  if (!agent) {
    const chan = matchChannel(p.prompt);
    if (chan) {
      triggers.add("channel");
      reasons.push(`the owner did not see or get something ("${chan}")`);
    }
  }
  const longTurn = t.toolCalls >= LONG_TURN_TOOL_CALLS;
  return {
    triggers: FRACTAL_TRIGGERS.filter((x) => triggers.has(x)),
    weak: FRACTAL_TRIGGERS.filter((x) => weak.has(x) && !triggers.has(x)),
    longTurn,
    reasons,
    ...(longTurn ? { longTurnReason: `long turn: ${t.toolCalls} tool calls` } : {}),
  };
}

// --- decision ----------------------------------------------------------------------------------------------------------

/** What Jev said about the turn, already read off its verdicts. `undefined` = Jev unavailable or failed. */
export type FractalJevRead = {
  /** Every answered question: the four `noul` probabilities and `worth` as its 0..1 score. */
  probs: Record<string, number>;
  worth?: WorthLevel;
};

function pct(p: number): string {
  return p.toFixed(2);
}

/**
 * C1's decision. Triggers = Jev's (noul ≥ 0.6) ∪ the rules' correction/friction/channel ∪ the long-turn `delivery`
 * (always, since 2026-10-26). With Jev: fire on any trigger, or on worth clear/high. Without Jev (no token, timeout,
 * error): ALWAYS fire (owner, 2026-10-10), the rules only name the triggers.
 */
export function decideFractalGate(
  rules: FractalRulesRead,
  jev: FractalJevRead | undefined,
): FractalGateResult {
  const set = new Set<FractalTrigger>(rules.triggers);
  const reasons = [...rules.reasons];
  if (!jev) {
    for (const trig of rules.weak ?? []) {
      set.add(trig);
    }
    if (rules.longTurn) {
      set.add("delivery");
      if (rules.longTurnReason) {
        reasons.push(rules.longTurnReason);
      }
    }
    const triggers = FRACTAL_TRIGGERS.filter((x) => set.has(x));
    // FORK 2026-10-10: Fractal fires every time when Jev does not respond, so Jev stays a layer
    // on top. Without Jev the Fractal always fires;
    // Jev only ever removes reflections, it is never what lets one run. The rules still name the triggers.
    if (triggers.length === 0) {
      reasons.push("Jev not answering: fires on every turn");
    }
    return { fire: true, triggers, source: "rules", reasons };
  }
  for (const trig of FRACTAL_TRIGGERS) {
    const p = jev.probs[trig];
    const bar = (rules.weak ?? []).includes(trig) ? JEV_WEAK_CONFIRM_PROB : JEV_TRIGGER_PROB;
    if (typeof p === "number" && p >= bar) {
      if (!set.has(trig)) {
        reasons.push(`Jev: ${trig} ${pct(p)}`);
      }
      set.add(trig);
    }
  }
  // A long turn is a costly turn: it always reflects, so its procedure can become a skill or recipe (2026-10-26).
  if (rules.longTurn && !set.has("delivery")) {
    set.add("delivery");
    if (rules.longTurnReason) {
      reasons.push(rules.longTurnReason);
    }
  }
  const triggers = FRACTAL_TRIGGERS.filter((x) => set.has(x));
  const worthFires = jev.worth !== undefined && FIRING_WORTH.has(jev.worth);
  if (jev.worth !== undefined && (worthFires || triggers.length === 0)) {
    reasons.push(`Jev: worth ${jev.worth}`);
  }
  const fire = triggers.length > 0 || worthFires;
  if (!fire && jev.worth === undefined) {
    reasons.push("no trigger");
  }
  return { fire, triggers, source: "jev", reasons, probs: { ...jev.probs } };
}

/** C1's fail-open answer: a missed reflection costs more than a spare one. */
export function fractalGateFailOpen(err: unknown): FractalGateResult {
  const why = err instanceof Error ? err.message : String(err);
  return {
    fire: true,
    triggers: [],
    source: "rules",
    reasons: [`gate error: ${why.slice(0, 200)}`],
  };
}
