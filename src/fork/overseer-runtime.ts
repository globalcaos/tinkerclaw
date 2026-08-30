/**
 * FORK 2026-05-31: Overseer runtime — the LIVE wiring for src/fork/overseer.ts.
 *
 * Builds the real OverseerDeps (spawn the Overseer persona + read its verdict via the
 * engine's own fork.subagents.spawn → agent.wait → chat.history path, mirroring the
 * round-table callModel; inject the nudge via sessions.send, mirroring fractal-inject),
 * and exposes:
 *   - maybeRunOverseerFromHook(): called fire-and-forget from onTurnComplete. Guards on
 *     a real (non-automated) session + an ACTIVE overseer, then runs one bounded cycle.
 *   - forkOverseerHandlers: fork.overseer.activate / deactivate / status RPCs so the
 *     overseer recipe (or Jarvis, or a manual trigger) can engage it for a session.
 *
 * Safety: everything is try/caught and fire-and-forget — the Overseer can NEVER break a
 * Jarvis turn. The loop is bounded by a DERIVED working budget (overseerWorkingBound) in
 * overseer.ts — sized to the live situation, clamped to a structural ceiling. It only
 * runs in the main session (isAutomatedSession skips subagents/cron/heartbeats), so the
 * Overseer's own spawned run cannot recursively trigger another Overseer.
 */

import { isOperatorScopeDenial } from "../gateway/method-scopes.js";
import { ErrorCodes, errorShape } from "../gateway/protocol/index.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/shared-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  activateOverseer,
  deactivateOverseer,
  getOverseerSession,
  maybeRunOverseer,
  shouldRunOverseer,
  OVERSEER_PERSONA,
  OVERSEER_PROMPT_PREFIX,
  type OverseerDeps,
} from "./overseer.js";

const log = createSubsystemLogger("fork-overseer");

/** A session whose key marks it automated (subagent/cron/heartbeat/isolated). The
 *  Overseer must only watch the real main session, never its own spawned child. */
function isAutomatedSession(sessionKey: string): boolean {
  return /:subagent:|:cron:|:heartbeat|:isolated:|^cron:|^heartbeat/.test(sessionKey);
}

interface SnapshotMessage {
  role?: string;
  content?: unknown;
}

/** The subset of the fork.subagents.spawn response this runtime consumes. */
interface SubagentSpawnResult {
  ok?: boolean;
  childSessionKey?: string;
  runId?: string;
  note?: string;
}

/** Flatten a transcript message's content to plain text (string or content-block array). */
function messageText(m: SnapshotMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "",
      )
      .join("");
  }
  return "";
}

function toOverseerMessages(snapshot: unknown[]): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const raw of snapshot) {
    const m = raw as SnapshotMessage;
    const role = typeof m.role === "string" ? m.role : "assistant";
    const text = messageText(m).trim();
    if (text) out.push({ role, text });
  }
  return out;
}

const RUN_TIMEOUT_S = 90;

/** Build the live deps for a given (main) session. */
function buildOverseerDeps(jarvisSessionKey: string): OverseerDeps {
  return {
    log: (m) => log.info(m),

    // Spawn the Overseer persona as a subagent, wait for it, read its final text.
    // The persona is prepended to the task (the spawn RPC's content channel).
    spawnOverseer: async (context: string): Promise<string> => {
      const { callGateway } = await import("../gateway/call.js");
      const task = `${OVERSEER_PERSONA}\n\n${context}`;
      let spawn: SubagentSpawnResult;
      try {
        spawn = await callGateway<SubagentSpawnResult>({
          method: "fork.subagents.spawn",
          params: {
            task,
            label: "overseer",
            parentSessionKey: jarvisSessionKey,
            runTimeoutSeconds: RUN_TIMEOUT_S,
            // We read the verdict ourselves; the Overseer must NOT post to the parent
            // channel (that would bypass the left-bubble nudge rendering + the loop).
            expectsCompletionMessage: false,
          },
          timeoutMs: (RUN_TIMEOUT_S + 10) * 1000,
        });
      } catch (err) {
        // FORK 2026-08-04: a gateway SCOPE REFUSAL is a wiring bug, not a transient blip.
        // overseer.ts collapses every spawn throw into reason:"spawn-error", which at the
        // caller reads exactly like a healthy quiet cycle -- that indistinguishability is
        // why the unclassified-fork.* outage ran for months. Name it loudly HERE, where we
        // still know the cause, and carry it in the rethrown message.
        const msg = err instanceof Error ? err.message : String(err);
        if (isOperatorScopeDenial(err)) {
          log.error(
            `[overseer] REFUSED by gateway: fork.subagents.spawn denied (${msg}). ` +
              `The Overseer did NOT run -- this is a scope-classification bug, not "nothing to nudge".`,
          );
          throw new Error(`overseer spawn refused (scope): ${msg}`);
        }
        throw err;
      }
      if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
        throw new Error(`overseer spawn failed: ${spawn?.note ?? "no childSessionKey/runId"}`);
      }
      const { childSessionKey, runId } = spawn;

      const wait = await callGateway<{ status?: "ok" | "timeout" | "error"; error?: string }>({
        method: "agent.wait",
        params: { runId, timeoutMs: RUN_TIMEOUT_S * 1000 },
        timeoutMs: RUN_TIMEOUT_S * 1000 + 5_000,
      });
      if (wait?.status === "error") throw new Error(`overseer run errored: ${wait.error ?? "?"}`);
      if (wait?.status === "timeout") return ""; // treat a stalled check as "no nudge" (safe)

      // Read the final assistant text, with a short retry for sessionFile flush.
      const deadline = Date.now() + 12_000;
      do {
        const hist = await callGateway<{ messages?: SnapshotMessage[] }>({
          method: "chat.history",
          params: { sessionKey: childSessionKey, limit: 50 },
          timeoutMs: 10_000,
        });
        const messages = Array.isArray(hist?.messages) ? hist.messages : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role !== "assistant") continue;
          const text = messageText(messages[i]).trim();
          if (text) return text;
          break; // newest assistant msg seen but empty → that IS the (silent) verdict
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 150));
      } while (true);
      return ""; // no assistant text → silence → done
    },

    // Inject the nudge as a prompt into Jarvis' session (sessions.send, the same path
    // fractal-inject uses). The ⟦OVERSEER⟧ sentinel makes the UI render it as a
    // right-anchored electric-blue Overseer bubble while Jarvis receives it as input.
    injectPrompt: async (sessionKey: string, nudge: string): Promise<void> => {
      const { callGateway } = await import("../gateway/call.js");
      await callGateway<{ status?: string }>({
        method: "sessions.send",
        params: { key: sessionKey, message: `${OVERSEER_PROMPT_PREFIX}${nudge}` },
        timeoutMs: 120_000,
      });
    },
  };
}

/**
 * Called fire-and-forget from onTurnComplete. Runs one Overseer cycle if the session is
 * a real main session with an active Overseer. Never throws.
 */
export async function maybeRunOverseerFromHook(
  sessionKey: string | undefined,
  messagesSnapshot: unknown[],
): Promise<void> {
  try {
    if (!sessionKey || isAutomatedSession(sessionKey) || !shouldRunOverseer(sessionKey)) {
      return;
    }
    const session = getOverseerSession(sessionKey);
    if (!session) return;
    const messages = toOverseerMessages(messagesSnapshot);
    const outcome = await maybeRunOverseer(
      sessionKey,
      session.task,
      messages,
      buildOverseerDeps(sessionKey),
    );
    // FORK 2026-08-04: "spawn-error" means the Overseer could not run AT ALL. Logged at
    // info alongside the healthy terminal reasons it was indistinguishable from a quiet
    // pass, which is precisely how a months-long outage stayed invisible. Failures are
    // now ERROR and say so in words.
    if (outcome.reason === "spawn-error") {
      log.error(
        `[overseer] cycle FAILED on ${sessionKey}: ${outcome.reason} (nudge ${outcome.iteration}) ` +
          `-- the Overseer did NOT run; this is not a quiet pass`,
      );
    } else {
      log.info(`[overseer] cycle on ${sessionKey}: ${outcome.reason} (nudge ${outcome.iteration})`);
    }
  } catch (err) {
    // The Overseer must never break a turn -- but a scope refusal is a permanent wiring
    // bug that must not hide at warn level behind the word "non-fatal". It will never
    // self-heal, unlike a transport hiccup.
    const msg = err instanceof Error ? err.message : String(err);
    if (isOperatorScopeDenial(err)) {
      log.error(
        `[overseer] cycle REFUSED by gateway (scope) -- the Overseer is dead until the ` +
          `method classification is fixed, it is NOT idling: ${msg}`,
      );
    } else {
      log.warn(`[overseer] cycle failed (non-fatal): ${msg}`);
    }
  }
}

function readStr(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const forkOverseerHandlers: GatewayRequestHandlers = {
  // Engage the Overseer for a session against the user's original task. Typically called
  // when the `overseer` recipe matches a complex prompt.
  "fork.overseer.activate": async ({ params, respond }) => {
    const p = params ?? {};
    const sessionKey = readStr(p, "sessionKey") ?? readStr(p, "key");
    const task = readStr(p, "task");
    if (!sessionKey || !task) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "fork.overseer.activate requires 'sessionKey' and 'task'.",
        ),
      );
      return;
    }
    // Optional: the overseer recipe's historical reliability, used to size the derived
    // supervision budget (a shakier recipe earns more passes). Validated to [0,1];
    // anything else → undefined (the derivation falls back to its 0.5 default).
    const fitnessRaw = (p as Record<string, unknown>).fitnessSuccessRate;
    const fitnessSuccessRate =
      typeof fitnessRaw === "number" && fitnessRaw >= 0 && fitnessRaw <= 1 ? fitnessRaw : undefined;
    activateOverseer(sessionKey, task, fitnessSuccessRate);
    log.info(`[overseer] activated for ${sessionKey}`);
    respond(true, { ok: true, sessionKey }, undefined);
  },
  "fork.overseer.deactivate": async ({ params, respond }) => {
    const sessionKey = readStr(params ?? {}, "sessionKey") ?? readStr(params ?? {}, "key");
    if (!sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "fork.overseer.deactivate requires 'sessionKey'."),
      );
      return;
    }
    deactivateOverseer(sessionKey);
    respond(true, { ok: true, sessionKey }, undefined);
  },
  "fork.overseer.status": async ({ params, respond }) => {
    const sessionKey = readStr(params ?? {}, "sessionKey") ?? readStr(params ?? {}, "key");
    const s = sessionKey ? getOverseerSession(sessionKey) : undefined;
    respond(
      true,
      { active: !!s?.active, iteration: s?.iteration ?? 0, task: s?.task ?? null },
      undefined,
    );
  },
};
