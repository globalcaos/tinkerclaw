/**
 * FORK 2026-05-31: THE OVERSEER — a supervisory critic persona that closes a
 * nudge-loop around Jarvis on complex tasks.
 *
 * Shape (per Oscar's spec):
 *   - Triggered by the `overseer` recipe on complex tasks (sets the session active).
 *   - After each Jarvis turn completes, the Overseer — a DISTINCT persona, not Jarvis —
 *     is given the chat window + its task and asked whether the ORIGINAL prompt is fully
 *     done. If NOT done, it emits one concise nudge; if done, it emits NOTHING.
 *   - A non-empty nudge is injected into Jarvis' session as a prompt (Jarvis sees it as
 *     input), and rendered as a LEFT bubble in the Overseer's own colour + "Overseer"
 *     label. Jarvis answers → the Overseer is consulted again → loop.
 *   - Silence (done) cuts the loop.
 *
 * Bounded by construction: at most MAX_OVERSEER_ITERATIONS nudges per task, so the
 * loop is constitutionally incapable of running away (cf. recipe-loop HARD_LOOP_MAX).
 *
 * The orchestration is dependency-injected (spawnOverseer / injectPrompt / emitBubble)
 * so the pure decision logic is unit-testable without a live gateway, and the real
 * wiring (attempt-hooks → subagent spawn → chat.send) lives at the call site.
 */

/** Stable identity for the Overseer everywhere (UI bubble colour + label). */
export const OVERSEER_LABEL = "Overseer";
/** A fixed, distinct-from-the-subagent-palette colour (amber) so the Overseer reads
 *  as its own voice, not one of the rotating subagent colours. */
export const OVERSEER_COLOR = "#d97706";

/** Hard ceiling on nudges per task — the loop can never exceed this. */
export const MAX_OVERSEER_ITERATIONS = 5;

/** Sentinel prepended to an injected nudge so Jarvis receives it as a prompt while the
 *  Tinker UI renders it as a left "Overseer" bubble. MUST match OVERSEER_MARKER in
 *  tinker-ui/src/app.ts. */
export const OVERSEER_PROMPT_PREFIX = "⟦OVERSEER⟧ ";

/** The Overseer's persona. Deliberately NOT Jarvis: a terse QA/supervisor whose only
 *  job is to verify completion and nudge — never to do the work itself. */
export const OVERSEER_PERSONA = `You are THE OVERSEER — a supervisory persona, distinct from Jarvis (the assistant you are watching). You are NOT Jarvis and you do not do the work.

You are given: (1) the conversation so far between the user and Jarvis, and (2) THE TASK — the user's original request that Jarvis must fully complete.

Your only job, each time you are consulted:
- Judge whether THE TASK has been COMPLETELY and correctly satisfied by Jarvis' work so far (not merely attempted, not "mostly").
- If it is fully done: output NOTHING AT ALL — an empty response. (Your silence ends the loop.)
- If it is NOT fully done: output ONE short, concrete nudge (1–3 sentences) telling Jarvis the specific remaining gap or the next step. Address Jarvis directly. Do not solve it yourself, do not restate what's done, do not pad.

Be ruthless about "done": loose ends, unverified claims, skipped sub-parts, or "I'll do X next" without doing it all mean NOT done. When genuinely complete, stay silent.`;

export interface OverseerSession {
  active: boolean;
  /** The original user prompt the Overseer is enforcing completion of. */
  task: string;
  /** How many nudges have been issued this task. */
  iteration: number;
}

const sessions = new Map<string, OverseerSession>();

/** Activate the Overseer for a session against a task (called when the overseer
 *  recipe matches). Resets the iteration counter. */
export function activateOverseer(sessionKey: string, task: string): void {
  sessions.set(sessionKey, { active: true, task, iteration: 0 });
}

export function deactivateOverseer(sessionKey: string): void {
  const s = sessions.get(sessionKey);
  if (s) {
    s.active = false;
  }
}

export function getOverseerSession(sessionKey: string): OverseerSession | undefined {
  return sessions.get(sessionKey);
}

/** Whether the Overseer should run after the just-completed Jarvis turn. Pure. */
export function shouldRunOverseer(sessionKey: string): boolean {
  const s = sessions.get(sessionKey);
  return !!s && s.active && s.iteration < MAX_OVERSEER_ITERATIONS;
}

export interface OverseerVerdict {
  /** True when the task is complete (Overseer was silent) → loop ends. */
  done: boolean;
  /** The nudge to inject into Jarvis, when not done. */
  nudge: string | null;
}

// A done-marker must be the WHOLE (trimmed) output: a done word/emoji followed by
// only punctuation/space. \b doesn't work after an emoji, so anchor on the markers
// directly and allow trailing punctuation to the end.
const DONE_MARKER_RE = /^(?:✅|✔️?|👍|done|completed?|task complete|all done|lgtm)[.!\s]*$/i;

/** Interpret the Overseer's raw output. Empty / whitespace / a bare done-marker means
 *  the task is complete (silence). Anything substantive is a nudge. Pure + testable. */
export function parseOverseerVerdict(output: string | null | undefined): OverseerVerdict {
  const trimmed = (output ?? "").trim();
  if (!trimmed || DONE_MARKER_RE.test(trimmed)) {
    return { done: true, nudge: null };
  }
  return { done: false, nudge: trimmed };
}

/** Assemble the Overseer's input: its task + the recent chat window. Pure. We keep the
 *  last `windowTurns` messages so the prompt stays bounded on long conversations. */
export function buildOverseerContext(
  task: string,
  messages: Array<{ role: string; text: string }>,
  windowTurns = 16,
): string {
  const window = messages.slice(-windowTurns);
  const transcript = window
    .map(
      (m) =>
        `${m.role === "user" ? "USER" : m.role === "overseer" ? "OVERSEER" : "JARVIS"}: ${m.text}`,
    )
    .join("\n\n");
  return `THE TASK (the user's original request Jarvis must fully complete):\n${task}\n\n--- CONVERSATION SO FAR ---\n${transcript}\n--- END CONVERSATION ---\n\nIs THE TASK fully complete? If yes, output nothing. If no, output one concise nudge for Jarvis.`;
}

export interface OverseerDeps {
  /** Spawn the Overseer persona with the given context; resolve its raw text output.
   *  Real impl: subagent spawn with childSystemPrompt = OVERSEER_PERSONA. */
  spawnOverseer: (context: string) => Promise<string>;
  /** Inject the nudge into Jarvis' session as a prompt (real impl: chat.send),
   *  tagged so the UI renders it as a left Overseer bubble. */
  injectPrompt: (sessionKey: string, nudge: string) => Promise<void>;
  /** Optional structured logger. */
  log?: (msg: string) => void;
}

export interface OverseerOutcome {
  ran: boolean;
  done: boolean;
  nudged: boolean;
  iteration: number;
  reason: string;
}

/**
 * Run one Overseer cycle after a Jarvis turn. Returns what happened (testable with
 * mock deps). Caller invokes this from onTurnComplete; the deps perform the live
 * spawn + injection.
 */
export async function maybeRunOverseer(
  sessionKey: string,
  task: string,
  messages: Array<{ role: string; text: string }>,
  deps: OverseerDeps,
): Promise<OverseerOutcome> {
  const s = sessions.get(sessionKey);
  if (!s || !s.active) {
    return {
      ran: false,
      done: false,
      nudged: false,
      iteration: s?.iteration ?? 0,
      reason: "inactive",
    };
  }
  if (s.iteration >= MAX_OVERSEER_ITERATIONS) {
    deactivateOverseer(sessionKey);
    deps.log?.(`[overseer] max iterations (${MAX_OVERSEER_ITERATIONS}) reached — stopping`);
    return {
      ran: false,
      done: false,
      nudged: false,
      iteration: s.iteration,
      reason: "max-iterations",
    };
  }

  const context = buildOverseerContext(task, messages);
  let output: string;
  try {
    output = await deps.spawnOverseer(context);
  } catch (err) {
    deps.log?.(`[overseer] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: true, done: false, nudged: false, iteration: s.iteration, reason: "spawn-error" };
  }

  const verdict = parseOverseerVerdict(output);
  if (verdict.done) {
    deactivateOverseer(sessionKey);
    deps.log?.(`[overseer] task judged complete after ${s.iteration} nudge(s) — loop ends`);
    return { ran: true, done: true, nudged: false, iteration: s.iteration, reason: "done" };
  }

  s.iteration += 1;
  await deps.injectPrompt(sessionKey, verdict.nudge as string);
  deps.log?.(`[overseer] nudge #${s.iteration} injected`);
  return { ran: true, done: false, nudged: true, iteration: s.iteration, reason: "nudged" };
}

/** Reset all state (tests). */
export function _resetOverseerState(): void {
  sessions.clear();
}
