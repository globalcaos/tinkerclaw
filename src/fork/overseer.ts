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
 * Bounded by construction: a DERIVED working budget (deriveOverseerLoopBudget — sized
 * to the live situation per design-principle #19: recipe fitness + whether the
 * gap-to-done is shrinking), clamped to OVERSEER_LOOP_HARD_CEILING, so the loop is
 * constitutionally incapable of running away (cf. recipe-loop HARD_LOOP_MAX) WITHOUT a
 * frozen quantity threshold. The old fixed MAX_OVERSEER_ITERATIONS=5 was the exact #19
 * anti-pattern; it is gone.
 *
 * The orchestration is dependency-injected (spawnOverseer / injectPrompt / emitBubble)
 * so the pure decision logic is unit-testable without a live gateway, and the real
 * wiring (attempt-hooks → subagent spawn → chat.send) lives at the call site.
 */

import { deriveOverseerLoopBudget } from "./overseer-budget.js";

/** Stable identity for the Overseer everywhere (UI bubble colour + label). */
export const OVERSEER_LABEL = "Overseer";
/** A fixed, distinct-from-the-subagent-palette colour (amber) so the Overseer reads
 *  as its own voice, not one of the rotating subagent colours. */
export const OVERSEER_COLOR = "#d97706";

/** Structural safety CEILING on overseer nudges per task — the DERIVED working budget
 *  (deriveOverseerLoopBudget) can never exceed this. Per design-principle #19 a frozen
 *  number is at most a ceiling, never the working value; matches the `overseer` recipe's
 *  `max 25` directive + recipe-runner HARD_LOOP_MAX. */
export const OVERSEER_LOOP_HARD_CEILING = 25;

/** Sentinel prepended to an injected nudge so Jarvis receives it as a prompt while the
 *  Tinker UI renders it as a left "Overseer" bubble. MUST match OVERSEER_MARKER in
 *  tinker-ui/src/app.ts. */
export const OVERSEER_PROMPT_PREFIX = "⟦OVERSEER⟧ ";

/** The Overseer's persona. Deliberately NOT Jarvis: a terse QA/supervisor whose only
 *  job is to verify completion and nudge — never to do the work itself. */
export const OVERSEER_PERSONA = `You are THE OVERSEER — a supervisory persona, distinct from Jarvis (the assistant you are watching). You are NOT Jarvis and you never do the work yourself.

You are given: (1) the FULL conversation so far between the user and Jarvis, and (2) THE TASK — the user's original request that Jarvis must fully complete.

Each time you are consulted, read the ENTIRE conversation and judge whether THE TASK has been COMPLETELY and correctly satisfied by Jarvis' work so far — not merely attempted, not "mostly", not "I'll do the rest next".

- If it is genuinely, fully done: output NOTHING AT ALL — an empty response. Your silence ends the loop.
- If it is NOT fully done: output a CONCRETE COMPLETION DIRECTIVE addressed to Jarvis that drives the task all the way to the finish. Specifically:
  • Enumerate EVERY remaining gap — each unfinished sub-part, each unverified claim, each "I'll do X" that wasn't actually done, each acceptance criterion from THE TASK not yet met.
  • For each gap, state the SPECIFIC next action(s) that close it — concrete and grounded in the conversation, so Jarvis can execute immediately without re-deriving the plan.
  • Where the task implies verification (tests, a build, a check), demand it explicitly.
  • Anchor briefly on what is already done only as needed to make the remaining work unambiguous. Do not restate the whole task, do not pad, do not do the work yourself.
  Write it as a direct instruction to Jarvis ("Finish by: …"). It is NOT a generic "keep going" — it is the exact remaining-work plan.

Be ruthless about "done": loose ends, unverified claims, skipped sub-parts, or "next I'll…" without doing it all mean NOT done. When genuinely complete, stay silent.`;

export interface OverseerSession {
  active: boolean;
  /** The original user prompt the Overseer is enforcing completion of. */
  task: string;
  /** How many nudges have been issued this task. */
  iteration: number;
  /** Recipe fitness success rate [0,1] threaded at activation; drives the derived
   *  budget (a shakier recipe earns more supervision passes). Omitted → derivation
   *  defaults to 0.5. */
  fitnessSuccessRate?: number;
  /** Length of the previous nudge — to detect a shrinking gap-to-done (a shorter
   *  nudge than last time = progress, which earns one more supervision pass). */
  lastNudgeLen?: number;
  /** Derived per cycle: the latest nudge was shorter than the prior one. Feeds the
   *  next cycle's working-budget derivation. */
  gapShrinking?: boolean;
}

const sessions = new Map<string, OverseerSession>();

/** The DERIVED working ceiling on nudges for this session RIGHT NOW — sized to the live
 *  situation (recipe fitness + whether the gap-to-done is shrinking), clamped to the
 *  structural ceiling. Never a frozen constant (design-principle #19). `priorIterations`
 *  is deliberately OMITTED: the caller compares `iteration < bound`, which already counts
 *  progress; passing it too would double-count the decay and over-tighten to one nudge. */
export function overseerWorkingBound(s: OverseerSession): number {
  return Math.min(
    OVERSEER_LOOP_HARD_CEILING,
    deriveOverseerLoopBudget({
      fitnessSuccessRate: s.fitnessSuccessRate,
      gapShrinking: s.gapShrinking ?? false,
    }),
  );
}

/** Activate the Overseer for a session against a task (called when the overseer
 *  recipe matches). Resets the iteration counter. `fitnessSuccessRate`, when the caller
 *  knows the overseer recipe's historical reliability, sizes the derived budget. */
export function activateOverseer(
  sessionKey: string,
  task: string,
  fitnessSuccessRate?: number,
): void {
  sessions.set(sessionKey, { active: true, task, iteration: 0, fitnessSuccessRate });
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

/** Whether the Overseer should run after the just-completed Jarvis turn. Pure. The
 *  bound is the DERIVED working budget for this session, not a frozen constant. */
export function shouldRunOverseer(sessionKey: string): boolean {
  const s = sessions.get(sessionKey);
  return !!s && s.active && s.iteration < overseerWorkingBound(s);
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

/** Assemble the Overseer's input: its task + the chat transcript. Pure. By default the
 *  FULL conversation is included ("all there is in the chat" — the Overseer judges
 *  completion against everything, not a recent slice); pass `windowTurns` to bound it to
 *  the last N messages only when a caller explicitly needs to cap a pathological length. */
export function buildOverseerContext(
  task: string,
  messages: Array<{ role: string; text: string }>,
  windowTurns?: number,
): string {
  const window = windowTurns != null ? messages.slice(-windowTurns) : messages;
  const transcript = window
    .map(
      (m) =>
        `${m.role === "user" ? "USER" : m.role === "overseer" ? "OVERSEER" : "JARVIS"}: ${m.text}`,
    )
    .join("\n\n");
  return `THE TASK (the user's original request Jarvis must fully complete):\n${task}\n\n--- FULL CONVERSATION SO FAR ---\n${transcript}\n--- END CONVERSATION ---\n\nIs THE TASK fully and correctly complete? If YES, output nothing (silence ends the loop). If NO, output a concrete completion directive for Jarvis: enumerate every remaining gap and the specific next actions that finish it — not a generic "keep going".`;
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
  const bound = overseerWorkingBound(s);
  if (s.iteration >= bound) {
    deactivateOverseer(sessionKey);
    deps.log?.(
      `[overseer] derived budget (${bound}) reached after ${s.iteration} nudge(s) — stopping`,
    );
    return {
      ran: false,
      done: false,
      nudged: false,
      iteration: s.iteration,
      reason: "budget-reached",
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

  // gap trend (a simple converging heuristic, mirroring the recipe-runner overseer
  // loop): a nudge SHORTER than the previous one means the remaining gap-to-done is
  // shrinking → the NEXT cycle's derived budget earns one more pass. Computed before
  // we overwrite lastNudgeLen; feeds overseerWorkingBound() on the following turn.
  const nudge = verdict.nudge as string;
  s.gapShrinking = s.lastNudgeLen != null && nudge.length < s.lastNudgeLen;
  s.lastNudgeLen = nudge.length;
  s.iteration += 1;
  await deps.injectPrompt(sessionKey, nudge);
  deps.log?.(`[overseer] nudge #${s.iteration} injected (budget ${bound})`);
  return { ran: true, done: false, nudged: true, iteration: s.iteration, reason: "nudged" };
}

/** Reset all state (tests). */
export function _resetOverseerState(): void {
  sessions.clear();
}
