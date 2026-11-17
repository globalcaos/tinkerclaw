/**
 * "Suggest from my chat history": one agent run through the gateway's subagent helper, so it uses
 * the gateway's own default model and login. The agent reads recent chats and memory and answers
 * with an objective plus a strategy as JSON. Nothing is saved here; the tab shows the proposal as
 * a draft and only its Accept writes the settings.
 *
 * The run outlives one request, so `start` returns a run id and the tab polls `poll` with it.
 * Only ids this module handed out are polled, so a caller cannot read some other session.
 */

import {
  MAX_CUSTOM_NAME,
  MAX_STRATEGY,
  OBJECTIVES,
  isObjective,
  objectiveLabel,
  type ObjectiveId,
  type TokenBurnerSettings,
} from "./settings.js";

export type SuggestSubagent = {
  run: (params: {
    sessionKey: string;
    message: string;
    idempotencyKey?: string;
    lane?: string;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{
    status: string;
    error?: string;
  }>;
  getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{
    messages: unknown[];
  }>;
  deleteSession?: (params: { sessionKey: string }) => Promise<void>;
};

export type Proposal = {
  objective: ObjectiveId;
  customName: string;
  strategy: string;
  why: string;
};

export type PollResult =
  | { status: "running"; startedAt: number }
  | { status: "done"; proposal: Proposal }
  | { status: "failed"; reason: string };

/** Longest a suggestion may run before the tab is told it gave up. */
export const SUGGEST_MAX_MS = 10 * 60_000;

/** Why no agent can run on this gateway, or null when a default model is set. */
export function modelProblem(cfg: unknown): string | null {
  const model = (cfg as { agents?: { defaults?: { model?: unknown } } } | undefined)?.agents
    ?.defaults?.model;
  const primary =
    typeof model === "string" ? model : (model as { primary?: unknown } | undefined)?.primary;
  if (typeof primary === "string" && primary.trim()) return null;
  return "No model is set for agents on this gateway, so no agent can read your history. Pick a default model in Config, then try again.";
}

export function suggestPrompt(current: TokenBurnerSettings): string {
  const list = OBJECTIVES.map((o) =>
    o.id === "custom" ? `- custom: a short name you choose` : `- ${o.id}: ${o.label}`,
  ).join("\n");
  const now = current.strategy
    ? `Current choice: ${objectiveLabel(current.objective, current.customName)}. Current strategy:\n${current.strategy}`
    : "No objective has been chosen yet.";
  return `A flat AI subscription has spare tokens each week. A scheduler spends them on agent jobs before the weekly reset. Help the owner decide what those jobs should be for.

1. Read the owner's recent chat history: list the sessions of the last two weeks with sessions_list and read the busiest ones with sessions_history.
2. Read their memory notes (memory_search, or MEMORY.md in the workspace).
3. Work out what they spend their attention on and what they are trying to achieve.

Then pick ONE objective from this list:
${list}

and write a strategy: 4 to 8 short, plain lines on how spare tokens pursue it. Say which kinds of jobs to run, how each job's result is checked, and what is off limits.

${now}

Answer with one JSON object and nothing else:
{"objective": "<id from the list>", "customName": "<only for custom>", "strategy": "<the lines, separated by \\n>", "why": "<one sentence: what in the history points there>"}

Do not quote messages, names, contact details or other private facts in the answer.`;
}

function textOf(message: unknown): string {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (!m || m.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: unknown }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = textOf(messages[i]).trim();
    if (t) return t;
  }
  return "";
}

/** Read the agent's JSON answer. Throws with a short reason the tab can show. */
export function parseProposal(text: string): Proposal {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the agent did not answer with a proposal");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("the agent's proposal was not valid JSON");
  }
  if (!isObjective(raw.objective)) throw new Error("the agent picked an objective not on the list");
  const strategy = typeof raw.strategy === "string" ? raw.strategy.trim() : "";
  if (!strategy) throw new Error("the agent's proposal had no strategy");
  const customName =
    raw.objective === "custom" && typeof raw.customName === "string"
      ? raw.customName.trim().slice(0, MAX_CUSTOM_NAME)
      : "";
  if (raw.objective === "custom" && !customName) {
    throw new Error("the agent proposed a custom objective without a name");
  }
  return {
    objective: raw.objective,
    customName,
    strategy: strategy.slice(0, MAX_STRATEGY),
    why: typeof raw.why === "string" ? raw.why.trim().slice(0, 400) : "",
  };
}

type Pending = { sessionKey: string; startedAt: number };

export class SuggestRuns {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly subagent: () => SuggestSubagent | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  async start(
    cfg: unknown,
    current: TokenBurnerSettings,
  ): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    const problem = modelProblem(cfg);
    if (problem) return { ok: false, reason: problem };
    const subagent = this.subagent();
    if (!subagent) {
      return { ok: false, reason: "This gateway cannot start an agent run from a plugin." };
    }
    for (const p of this.pending.values()) {
      if (this.clock() - p.startedAt < SUGGEST_MAX_MS) {
        return { ok: false, reason: "A suggestion is already running. Wait for it to finish." };
      }
    }
    const now = this.clock();
    const sessionKey = `token-burner-suggest-${now}`;
    try {
      const { runId } = await subagent.run({
        sessionKey,
        idempotencyKey: sessionKey,
        message: suggestPrompt(current),
        lane: "token-burner-suggest",
        deliver: false,
      });
      this.pending.set(runId, { sessionKey, startedAt: now });
      return { ok: true, runId };
    } catch (err) {
      return { ok: false, reason: `The agent could not start: ${(err as Error).message}` };
    }
  }

  async poll(runId: unknown): Promise<PollResult> {
    const p = typeof runId === "string" ? this.pending.get(runId) : undefined;
    if (!p) return { status: "failed", reason: "That suggestion is unknown or already finished." };
    const subagent = this.subagent();
    if (!subagent) return this.fail(runId as string, "The agent runtime went away.");
    let wait: { status: string; error?: string };
    try {
      wait = await subagent.waitForRun({ runId: runId as string, timeoutMs: 1_000 });
    } catch (err) {
      return this.fail(
        runId as string,
        `The agent run could not be read: ${(err as Error).message}`,
      );
    }
    if (wait.status === "timeout") {
      if (this.clock() - p.startedAt > SUGGEST_MAX_MS) {
        return this.fail(runId as string, "The agent took more than ten minutes and was left.");
      }
      return { status: "running", startedAt: p.startedAt };
    }
    if (wait.status !== "ok") {
      return this.fail(runId as string, `The agent run failed: ${wait.error ?? wait.status}`);
    }
    try {
      const { messages } = await subagent.getSessionMessages({
        sessionKey: p.sessionKey,
        limit: 20,
      });
      const proposal = parseProposal(lastAssistantText(messages));
      await this.drop(runId as string);
      return { status: "done", proposal };
    } catch (err) {
      return this.fail(runId as string, `No proposal: ${(err as Error).message}.`);
    }
  }

  private async fail(runId: string, reason: string): Promise<PollResult> {
    await this.drop(runId);
    return { status: "failed", reason };
  }

  private async drop(runId: string): Promise<void> {
    const p = this.pending.get(runId);
    this.pending.delete(runId);
    if (!p) return;
    try {
      await this.subagent()?.deleteSession?.({ sessionKey: p.sessionKey });
    } catch {
      // The helper session is scratch; a failed cleanup leaves one idle session behind.
    }
  }
}
